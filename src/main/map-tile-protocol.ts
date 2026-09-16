import { net, protocol } from 'electron'
import type { MapTileSource } from '../shared/contracts'
import { MapTileCache } from './map-tile-cache'
import {
  buildTileHeaders,
  buildTileUrl,
  parseTilePath,
  resolveDirectoryTile,
  resolveMbtilesTile,
  TileRequestError,
  type ResolvedTile,
  type TileRequest,
} from './map-tile-resolver'
import type { MapTileSourceStore } from './map-tile-source-store'

export const MAP_TILE_SCHEME = 'map-tile'
export const MAP_TILE_HOST = 'tiles'

/**
 * 注册为主权协议所需的权限。
 *
 * supportFetchAPI 是必需的：Cesium 的 Resource.fetchImage 走 fetch + createImageBitmap，
 * 缺少该项会直接失败。secure 使其被视作安全上下文，避免混合内容拦截。
 */
export const mapTileProtocolPrivileges = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  corsEnabled: true,
  stream: true,
} as const

const TILE_CACHE_ENTRIES = 256
const TILE_CACHE_BYTES = 32 * 1024 * 1024
const UPSTREAM_TIMEOUT_MS = 15_000

const notFound = (): Response => new Response(null, { status: 404 })

/**
 * 统一处理 map-tile 协议的瓦片请求。
 *
 * 三种来源（在线模板、本地目录、MBTiles）在这里收敛为同一条路径，
 * 渲染进程只面对一个协议，无需为任意用户自填域名放宽 CSP。
 */
export class MapTileProtocolHandler {
  private readonly cache = new MapTileCache(TILE_CACHE_ENTRIES, TILE_CACHE_BYTES)
  private subdomainCounter = 0

  /**
   * @param store 底图源配置存储，是主进程中唯一能取到 API Key 明文的入口
   */
  constructor(readonly store: MapTileSourceStore) {}

  /**
   * 处理一次瓦片请求。
   *
   * 任何失败（路径非法、来源不存在、配置读取异常、上游异常、本地文件缺失）
   * 一律返回不带响应体的 404：底层错误信息可能包含磁盘上的绝对路径，不能透给渲染进程。
   *
   * @param request map-tile 协议请求，路径形如 /源ID/z/x/y
   * @returns 瓦片响应；不可用时为 404
   */
  async handle(request: Request): Promise<Response> {
    try {
      const parsed = parseTilePath(new URL(request.url).pathname)
      if (!parsed) return notFound()

      const source = await this.store.getWithApiKey(parsed.sourceId)
      if (!source) return notFound()

      const cacheKey = `${parsed.sourceId}/${parsed.request.z}/${parsed.request.x}/${parsed.request.y}`
      const cached = this.cache.get(cacheKey)
      if (cached) return tileResponse(cached)

      const tile = source.kind === 'url-template'
        ? await this.fetchRemoteTile(source, parsed.request, source.apiKey ?? '')
        : source.kind === 'directory'
          ? await resolveDirectoryTile(source, parsed.request)
          : await resolveMbtilesTile(source, parsed.request)
      this.cache.set(cacheKey, tile)
      return tileResponse(tile)
    } catch {
      return notFound()
    }
  }

  /**
   * 读取在线瓦片，注入 API Key 与自定义请求头。
   *
   * @param source 底图源配置
   * @param request 瓦片坐标
   * @param apiKey 解密后的 API Key，无则传空串
   * @returns 瓦片字节与内容类型
   * @throws TileRequestError 上游返回非成功状态
   */
  private async fetchRemoteTile(
    source: MapTileSource,
    request: TileRequest,
    apiKey: string,
  ): Promise<ResolvedTile> {
    const url = buildTileUrl(source, request, apiKey, this.subdomainCounter++)
    const response = await net.fetch(url, {
      headers: buildTileHeaders(source, apiKey),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    if (!response.ok) throw new TileRequestError(`上游返回 ${response.status}`)
    const body = Buffer.from(await response.arrayBuffer())
    return { body, contentType: response.headers.get('content-type') ?? 'image/png' }
  }

  /**
   * 清空瓦片缓存。底图源配置变更后需要调用，避免继续返回旧来源的瓦片。
   */
  clearCache(): void {
    this.cache.clear()
  }
}

const tileResponse = (tile: ResolvedTile): Response =>
  new Response(new Uint8Array(tile.body), {
    status: 200,
    headers: {
      'content-type': tile.contentType,
      'cache-control': 'no-store',
    },
  })

/**
 * 注册 map-tile 协议的处理函数。必须在 app ready 之后调用。
 *
 * @param handler 协议处理器
 */
export const registerMapTileProtocol = (handler: MapTileProtocolHandler): void => {
  protocol.handle(MAP_TILE_SCHEME, (request) => handler.handle(request))
}

/**
 * 供测试直接调用的响应构造函数。
 *
 * @param handler 协议处理器
 * @param url 完整的 map-tile URL
 * @returns 瓦片响应；不可用时为 404
 */
export const buildMapTileResponse = (handler: MapTileProtocolHandler, url: string): Promise<Response> =>
  handler.handle(new Request(url))
