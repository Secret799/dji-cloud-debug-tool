import { readFile } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { MapTileSource } from '../shared/contracts'

export interface TileRequest {
  z: number
  x: number
  y: number
}

export interface ResolvedTile {
  body: Buffer
  contentType: string
}

/** 瓦片不可用（缺失、越界、数据源损坏），对应 HTTP 404 */
export class TileRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TileRequestError'
  }
}

const MAX_ZOOM = 22
const SUBDOMAIN_LABELS = ['a', 'b', 'c', 'd']
const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
})
const DEFAULT_CONTENT_TYPE = 'image/png'
const CANDIDATE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'] as const

const contentTypeFor = (extension: string): string =>
  CONTENT_TYPES[extension.toLowerCase()] ?? DEFAULT_CONTENT_TYPE

const maxIndexForZoom = (z: number): number => 2 ** z - 1

/**
 * 解析 map-tile://tiles/<源ID>/<z>/<x>/<y> 的路径部分。
 *
 * @param pathname URL 的 pathname 部分
 * @returns 解析结果；格式非法或坐标越界时返回 undefined
 */
export const parseTilePath = (pathname: string): { sourceId: string; request: TileRequest } | undefined => {
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length !== 4) return undefined
  const [sourceId, rawZ, rawX, rawY] = segments
  if (!sourceId) return undefined
  if (!/^\d+$/.test(rawZ) || !/^\d+$/.test(rawX) || !/^\d+$/.test(rawY)) return undefined
  const z = Number(rawZ)
  const x = Number(rawX)
  const y = Number(rawY)
  if (z < 0 || z > MAX_ZOOM) return undefined
  const limit = maxIndexForZoom(z)
  if (x > limit || y > limit) return undefined
  return { sourceId, request: { z, x, y } }
}

const substitute = (
  template: string,
  request: TileRequest,
  apiKey: string,
  subdomainIndex: number,
): string =>
  template
    .replace(/\{z\}/gi, String(request.z))
    .replace(/\{x\}/gi, String(request.x))
    .replace(/\{y\}/gi, String(request.y))
    .replace(/\{s\}/gi, SUBDOMAIN_LABELS[subdomainIndex % SUBDOMAIN_LABELS.length])
    .replace(/\{key\}/gi, encodeURIComponent(apiKey))

/**
 * 生成真实瓦片请求地址。{key} 会被 URL 编码后注入，{s} 按请求序号轮换。
 *
 * @param source 底图源配置
 * @param request 瓦片坐标
 * @param apiKey 解密后的 API Key，无则传空串
 * @param subdomainIndex 请求序号，用于子域轮换
 * @returns 完整的瓦片 URL
 */
export const buildTileUrl = (
  source: MapTileSource,
  request: TileRequest,
  apiKey: string,
  subdomainIndex: number,
): string => substitute(source.urlTemplate.trim(), request, apiKey, subdomainIndex)

/**
 * 生成瓦片请求的自定义请求头。无 API Key 时，含 {key} 占位符的请求头会被丢弃。
 *
 * @param source 底图源配置
 * @param apiKey 解密后的 API Key，无则传空串
 * @returns 请求头映射；无可用请求头时返回空对象
 */
export const buildTileHeaders = (source: MapTileSource, apiKey: string): Record<string, string> => {
  const headers: Record<string, string> = {}
  for (const header of source.headers ?? []) {
    // 用函数形式替换：字符串形式的替换串会把密钥里的 $& / $1 当成替换模式，静默篡改密钥
    if (!apiKey && /\{key\}/i.test(header.value)) continue
    headers[header.name] = header.value.replace(/\{key\}/gi, () => apiKey)
  }
  return headers
}

const assertInsideRoot = (root: string, candidate: string): void => {
  const normalizedRoot = resolve(root)
  const normalizedCandidate = resolve(candidate)
  if (normalizedCandidate !== normalizedRoot && !normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)) {
    throw new TileRequestError('瓦片路径越界')
  }
}

/**
 * 从本地目录读取瓦片，目录结构为 <root>/<z>/<x>/<y>.<ext>。
 *
 * @param source 底图源配置
 * @param request 瓦片坐标
 * @returns 瓦片字节与内容类型
 * @throws TileRequestError 瓦片缺失或路径越界
 */
export const resolveDirectoryTile = async (
  source: MapTileSource,
  request: TileRequest,
): Promise<ResolvedTile> => {
  const root = resolve(source.path)
  const extensions = source.tileExtension.trim()
    ? [source.tileExtension.trim().replace(/^\./, '')]
    : [...CANDIDATE_EXTENSIONS]

  for (const extension of extensions) {
    const candidate = join(root, String(request.z), String(request.x), `${request.y}.${extension}`)
    assertInsideRoot(root, candidate)
    try {
      const body = await readFile(candidate)
      return { body, contentType: contentTypeFor(extension) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new TileRequestError(`读取本地瓦片失败：${(error as Error).message}`)
    }
  }
  throw new TileRequestError(`未找到瓦片 ${request.z}/${request.x}/${request.y}`)
}

/**
 * 从 MBTiles 读取瓦片。MBTiles 使用 TMS 行号，需要把 XYZ 的 y 翻转。
 *
 * @param source 底图源配置
 * @param request 瓦片坐标，y 为 XYZ 约定
 * @returns 瓦片字节与内容类型
 * @throws TileRequestError 瓦片缺失或数据库不可读
 */
export const resolveMbtilesTile = async (
  source: MapTileSource,
  request: TileRequest,
): Promise<ResolvedTile> => {
  const tileRow = maxIndexForZoom(request.z) - request.y
  let database: DatabaseSync
  try {
    database = new DatabaseSync(source.path, { readOnly: true })
  } catch (error) {
    throw new TileRequestError(`无法打开 MBTiles：${(error as Error).message}`)
  }
  try {
    const row = database
      .prepare('SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?')
      .get(request.z, request.x, tileRow) as { tile_data?: Uint8Array } | undefined
    if (!row?.tile_data) throw new TileRequestError(`未找到瓦片 ${request.z}/${request.x}/${request.y}`)
    const body = Buffer.from(row.tile_data)
    const extension = extname(source.tileExtension ? `x.${source.tileExtension}` : 'x.png').slice(1)
    return { body, contentType: contentTypeFor(extension) }
  } catch (error) {
    if (error instanceof TileRequestError) throw error
    throw new TileRequestError(`读取 MBTiles 失败：${(error as Error).message}`)
  } finally {
    database.close()
  }
}
