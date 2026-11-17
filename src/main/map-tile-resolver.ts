import { access, readFile, readdir } from 'node:fs/promises'
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
 * 目录源可用的文件扩展名：配置了 tileExtension 时只认它，否则按候选表依次探测。
 *
 * @param source 底图源配置
 * @returns 去掉前导点的扩展名列表
 */
const tileExtensionsFor = (source: MapTileSource): string[] => {
  const configured = source.tileExtension.trim().replace(/^\./, '')
  return configured ? [configured] : [...CANDIDATE_EXTENSIONS]
}

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
  const extensions = tileExtensionsFor(source)

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

/** 探测目录源时最多检查的缩放级别数，避免在超大瓦片树上无界遍历 */
const MAX_PROBE_ZOOM_LEVELS = 4
/** 探测目录源时每个缩放级别最多检查的列目录数 */
const MAX_PROBE_COLUMNS = 4
/** 路径不存在或指向文件时的 errno，与「瓦片集为空」合并成同一条提示 */
const MISSING_PATH_CODES = new Set(['ENOENT', 'ENOTDIR'])

const isMissingPathError = (error: unknown): boolean =>
  error instanceof Error && MISSING_PATH_CODES.has((error as NodeJS.ErrnoException).code ?? '')

/**
 * 判断目录名能不能被读路径原样拼出来。
 *
 * 读路径按 `String(Number(name))` 拼目录，`010` 会被拼成 `10`，两者不是同一个目录。
 * 零填充的缩放级别与列目录因此必须排除，否则探测会报出服务端根本取不到的坐标。
 *
 * @param name 目录名
 * @returns 目录名与读路径拼出的名字一致时为 true
 */
const isCanonicalIndexName = (name: string): boolean => String(Number(name)) === name

/**
 * 列出目录下可作瓦片坐标的数字子目录，按数值升序。
 *
 * 只收「名字与读路径拼出的名字一致」的目录：零填充的名字进不到读路径里，
 * 一旦向下走进 `010`，读路径要去的 `10` 并不存在，整个探测会被 ENOENT 拉成「瓦片集为空」。
 *
 * @param directory 待读取的目录
 * @param limit 允许的最大数值，缩放级别用 {@link MAX_ZOOM}，列号用该级别的最大索引
 * @returns 目录名可解析为 0..limit 且能被读路径原样拼出的数值列表
 */
const numericSubdirectories = async (directory: string, limit: number): Promise<number[]> => {
  const entries = await readdir(directory, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name) && isCanonicalIndexName(entry.name))
    .map((entry) => Number(entry.name))
    .filter((value) => value <= limit)
    .sort((a, b) => a - b)
}

/**
 * 判断路径是否存在，用于比对读路径会拼出的瓦片名。
 *
 * @param path 待检查的路径
 * @returns 路径存在时为 true
 */
const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * 判断读路径能否真的取到该行号的瓦片。
 *
 * 依据必须是「按 `<y>.<ext>` 拼出来的名字存在」，而不是磁盘上叫什么：
 * `0400.png` 会被读路径拼成 `400.png`，两者不是同一个文件，按磁盘名报绿等于给取不到的瓦片放行；
 * 反过来，大小写不敏感的文件系统上磁盘名是 `400.PNG`、读路径要的 `400.png` 照样能打开，这里也会放行。
 *
 * @param directory `<z>/<x>` 对应的目录
 * @param row 候选行号
 * @param extensions 允许的扩展名，顺序与读路径的候选顺序一致
 * @returns 读路径能取到该行号的瓦片时为 true
 */
const hasServableTileFile = async (directory: string, row: number, extensions: string[]): Promise<boolean> => {
  for (const extension of extensions) {
    if (await pathExists(join(directory, `${row}.${extension}`))) return true
  }
  return false
}

/**
 * 在 `<z>/<x>` 目录里找一个可用的行号：文件名必须匹配 `<y>.<ext>`，且读路径按该行号拼出的瓦片确实存在。
 *
 * 逐个候选行号做一次存在性检查，命中即返回，因此常见情况下只多一次 stat；
 * 检查次数由这次 `readdir` 已经读到的目录项数封顶，不会随瓦片树规模增长。
 *
 * @param directory `<z>/<x>` 对应的目录
 * @param extensions 允许的扩展名
 * @returns 升序排列后第一个可用且读路径确实能取到的 y；没有合法文件时返回 undefined
 */
const findRowInDirectory = async (directory: string, extensions: string[]): Promise<number | undefined> => {
  const names = await readdir(directory)
  const rows = new Set(names
    .map((name) => /^(\d+)\.([A-Za-z0-9]+)$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null && extensions.includes(match[2].toLowerCase()))
    .map((match) => Number(match[1]))
    .filter((row) => Number.isSafeInteger(row)))
  for (const row of [...rows].sort((a, b) => a - b)) {
    if (await hasServableTileFile(directory, row, extensions)) return row
  }
  return undefined
}

/**
 * 按 <root>/<z>/<x>/<y>.<ext> 的目录结构读出一张真实存在的瓦片坐标。
 *
 * 只从目录里读坐标，不猜坐标再去试：z 级下世界是 2^z × 2^z 张瓦片，
 * 猜出来的坐标大概率落在瓦片集覆盖范围之外。缩放级别与列目录各只取升序前若干个，
 * 保证读取次数有界。目录不存在或为空都返回 undefined，由调用方给出统一提示。
 *
 * 只认读路径能原样拼出来的名字：`010/842/0400.png` 这类零填充的名字服务端一张都取不到，
 * 报绿等于给一个渲染不出来的源放行，因此目录名与文件名都必须与 `String(数值)` 拼出的结果一致。
 *
 * @param source 已校验的目录源配置
 * @returns 真实存在的瓦片坐标；目录缺失或没有可解析的瓦片时返回 undefined
 * @throws TileRequestError 目录存在但不可读（权限等）
 */
const findDirectoryTile = async (source: MapTileSource): Promise<TileRequest | undefined> => {
  const root = resolve(source.path)
  const extensions = tileExtensionsFor(source)
  try {
    const zoomLevels = await numericSubdirectories(root, MAX_ZOOM)
    for (const z of zoomLevels.slice(0, MAX_PROBE_ZOOM_LEVELS)) {
      const columns = await numericSubdirectories(join(root, String(z)), maxIndexForZoom(z))
      for (const x of columns.slice(0, MAX_PROBE_COLUMNS)) {
        const tileDirectory = join(root, String(z), String(x))
        assertInsideRoot(root, tileDirectory)
        const y = await findRowInDirectory(tileDirectory, extensions)
        if (y !== undefined && y <= maxIndexForZoom(z)) return { z, x, y }
      }
    }
    return undefined
  } catch (error) {
    if (error instanceof TileRequestError) throw error
    if (isMissingPathError(error)) return undefined
    throw new TileRequestError(`读取本地瓦片目录失败：${(error as Error).message}`)
  }
}

/** 挑选探测瓦片的 SQL：滤掉无法还原成合法 XYZ 坐标的行，最小缩放级优先 */
const FIND_MBTILES_TILE_SQL = `SELECT zoom_level, tile_column, tile_row FROM tiles
  WHERE zoom_level BETWEEN 0 AND ?
    AND tile_column BETWEEN 0 AND (1 << zoom_level) - 1
    AND tile_row BETWEEN 0 AND (1 << zoom_level) - 1
  ORDER BY zoom_level, tile_column, tile_row
  LIMIT 1`

interface MbtilesTileRow {
  zoom_level: number
  tile_column: number
  tile_row: number
}

/**
 * 从 MBTiles 里读出一张真实存在的瓦片坐标。
 *
 * MBTiles 存的是 TMS 行号，这里镜像 {@link resolveMbtilesTile} 的反向翻转，
 * 得到的才是 XYZ 约定下的坐标。
 *
 * @param source 已校验的 MBTiles 源配置
 * @returns 真实存在的瓦片坐标；tiles 表里没有合法瓦片时返回 undefined
 * @throws TileRequestError 数据库打不开或读取失败
 */
const findMbtilesTile = async (source: MapTileSource): Promise<TileRequest | undefined> => {
  let database: DatabaseSync
  try {
    database = new DatabaseSync(source.path, { readOnly: true })
  } catch (error) {
    throw new TileRequestError(`无法打开 MBTiles：${(error as Error).message}`)
  }
  try {
    const row = database.prepare(FIND_MBTILES_TILE_SQL).get(MAX_ZOOM) as MbtilesTileRow | undefined
    if (!row) return undefined
    return { z: row.zoom_level, x: row.tile_column, y: maxIndexForZoom(row.zoom_level) - row.tile_row }
  } catch (error) {
    throw new TileRequestError(`读取 MBTiles 失败：${(error as Error).message}`)
  } finally {
    database.close()
  }
}

/**
 * 为本地瓦片源挑一张真实存在、可被读取的瓦片坐标，供可用性探测使用。
 *
 * 探测不能固定请求原点瓦片：城市级瓦片集在 z=10 只覆盖 x≈840、y≈400 一带，
 * (minZoom, 0, 0) 不在其中，会把完全可用的本地源误判成不可用。
 *
 * @param source 已校验的本地底图源配置（directory 或 mbtiles）
 * @returns 数据源内真实存在的瓦片坐标；一张瓦片都没有时返回 undefined
 * @throws TileRequestError 数据源不可读（目录无权限、MBTiles 打不开或表损坏）
 */
export const findLocalTileRequest = async (source: MapTileSource): Promise<TileRequest | undefined> =>
  source.kind === 'mbtiles' ? await findMbtilesTile(source) : await findDirectoryTile(source)
