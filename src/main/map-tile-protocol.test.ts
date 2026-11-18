import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MapTileSource } from '../shared/contracts'

const electronMocks = vi.hoisted(() => ({
  userDataPath: '',
  requests: [] as { url: string; headers: Record<string, string> }[],
  response: { body: Buffer.from('remote-bytes'), contentType: 'image/png', status: 200 },
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => electronMocks.userDataPath,
    getVersion: () => '1.5.0',
  },
  net: {
    fetch: vi.fn(async (url: string, options?: { headers?: Record<string, string> }) => {
      electronMocks.requests.push({ url, headers: options?.headers ?? {} })
      return new Response(electronMocks.response.status === 200 ? electronMocks.response.body : null, {
        status: electronMocks.response.status,
        headers: { 'content-type': electronMocks.response.contentType },
      })
    }),
  },
}))

import { MapTileSourceStore } from './map-tile-source-store'
import { buildMapTileResponse, MapTileProtocolHandler } from './map-tile-protocol'

const remoteSource = (patch: Partial<MapTileSource> = {}): MapTileSource => ({
  id: 'remote-1',
  name: '远程瓦片',
  layer: 'imagery',
  kind: 'url-template',
  urlTemplate: 'https://tiles.example.com/{z}/{x}/{y}.png',
  path: '',
  headers: [],
  coordinateSystem: 'gcj02',
  minZoom: 0,
  maxZoom: 19,
  tileSize: 256,
  tileExtension: '',
  attribution: '',
  createdAt: 1,
  updatedAt: 1,
  ...patch,
})

describe('buildMapTileResponse', () => {
  let userDataPath = ''
  let handler: MapTileProtocolHandler

  beforeEach(async () => {
    userDataPath = await mkdtemp(join(tmpdir(), 'dji-map-protocol-'))
    electronMocks.userDataPath = userDataPath
    electronMocks.requests = []
    electronMocks.response = { body: Buffer.from('remote-bytes'), contentType: 'image/png', status: 200 }
    handler = new MapTileProtocolHandler(new MapTileSourceStore())
  })

  afterEach(async () => {
    await rm(userDataPath, { recursive: true, force: true })
  })

  it('returns the tile bytes for a configured remote source', async () => {
    await handler.store.save(remoteSource())
    const response = await buildMapTileResponse(handler, 'map-tile://tiles/remote-1/3/4/5')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('remote-bytes')
  })

  it('returns 404 for an unknown source', async () => {
    const response = await buildMapTileResponse(handler, 'map-tile://tiles/missing/3/4/5')
    expect(response.status).toBe(404)
    // 来源不存在必须在触网前短路，且失败响应不带任何响应体（错误细节不外泄）
    expect(await response.text()).toBe('')
    expect(electronMocks.requests).toHaveLength(0)
  })

  it('returns 404 for a malformed path', async () => {
    const missingSegment = await buildMapTileResponse(handler, 'map-tile://tiles/remote-1/3/4')
    const nonNumeric = await buildMapTileResponse(handler, 'map-tile://tiles/remote-1/a/4/5')
    expect(missingSegment.status).toBe(404)
    expect(nonNumeric.status).toBe(404)
    // 路径解析失败同样在触网前短路，404 来自分支判断而非异常被吞
    expect(await missingSegment.text()).toBe('')
    expect(await nonNumeric.text()).toBe('')
    expect(electronMocks.requests).toHaveLength(0)
  })

  it('returns 404 when the upstream request fails', async () => {
    await handler.store.save(remoteSource())
    electronMocks.response.status = 503
    const response = await buildMapTileResponse(handler, 'map-tile://tiles/remote-1/3/4/5')
    expect(response.status).toBe(404)
    // 确实向上游发起了请求，说明 404 来自上游状态码而非其他分支；失败结果也不能进缓存
    expect(electronMocks.requests).toHaveLength(1)
    expect(await response.text()).toBe('')
    await buildMapTileResponse(handler, 'map-tile://tiles/remote-1/3/4/5')
    expect(electronMocks.requests).toHaveLength(2)
  })

  it('serves a repeated request from the cache without refetching', async () => {
    await handler.store.save(remoteSource())
    await buildMapTileResponse(handler, 'map-tile://tiles/remote-1/3/4/5')
    await buildMapTileResponse(handler, 'map-tile://tiles/remote-1/3/4/5')
    expect(electronMocks.requests).toHaveLength(1)
  })

  it('stops serving a tile once its source is removed', async () => {
    await handler.store.save(remoteSource())
    expect((await buildMapTileResponse(handler, 'map-tile://tiles/remote-1/3/4/5')).status).toBe(200)
    await handler.store.remove('remote-1')
    // 与 IPC handler 的写法一致：来源变动后清掉瓦片缓存，避免继续拿旧来源的图
    handler.clearCache()
    const removed = await buildMapTileResponse(handler, 'map-tile://tiles/remote-1/3/4/5')
    expect(removed.status).toBe(404)
    expect(await removed.text()).toBe('')
    // 来源已不存在，必须在上游之前短路
    expect(electronMocks.requests).toHaveLength(1)
  })

  it('does not serve one source from another source cache entry', async () => {
    await handler.store.save(remoteSource())
    await handler.store.save(remoteSource({ id: 'remote-2', urlTemplate: 'https://other.example.com/{z}/{x}/{y}.png' }))
    electronMocks.response = { body: Buffer.from('first-bytes'), contentType: 'image/png', status: 200 }
    const first = await buildMapTileResponse(handler, 'map-tile://tiles/remote-1/3/4/5')
    electronMocks.response = { body: Buffer.from('second-bytes'), contentType: 'image/png', status: 200 }
    const second = await buildMapTileResponse(handler, 'map-tile://tiles/remote-2/3/4/5')
    expect(Buffer.from(await first.arrayBuffer()).toString()).toBe('first-bytes')
    expect(Buffer.from(await second.arrayBuffer()).toString()).toBe('second-bytes')
    expect(electronMocks.requests).toHaveLength(2)
  })

  it('rotates the subdomain per handler instance', async () => {
    const template = 'https://{s}.example.com/{z}/{x}/{y}.png'
    await handler.store.save(remoteSource({ urlTemplate: template }))
    await buildMapTileResponse(handler, 'map-tile://tiles/remote-1/3/4/5')
    await buildMapTileResponse(handler, 'map-tile://tiles/remote-1/3/4/6')
    // 计数器是处理器实例状态：新实例必须从第一个子域重新开始，不能是模块级全局
    const fresh = new MapTileProtocolHandler(handler.store)
    await buildMapTileResponse(fresh, 'map-tile://tiles/remote-1/3/4/5')
    expect(electronMocks.requests.map((entry) => new URL(entry.url).host)).toEqual([
      'a.example.com',
      'b.example.com',
      'a.example.com',
    ])
  })

  it('injects the stored api key and custom headers into the upstream request', async () => {
    // save 是整条记录覆盖写：第二次 save 必须带上同样的模板与请求头，否则会把 {key} 占位符一并抹掉
    const keyedSource = remoteSource({
      urlTemplate: 'https://tiles.example.com/{z}/{x}/{y}.png?key={key}',
      headers: [{ name: 'Authorization', value: 'Bearer {key}' }],
    })
    await handler.store.save(keyedSource)
    await handler.store.save({ ...keyedSource, apiKey: 'secret-token' })
    const response = await buildMapTileResponse(handler, 'map-tile://tiles/remote-1/3/4/5')
    expect(electronMocks.requests[0]?.url).toContain('key=secret-token')
    expect(electronMocks.requests[0]?.headers.Authorization).toBe('Bearer secret-token')
    // 公共瓦片服务按 UA 识别请求方：默认必须带上应用身份，否则 OSM 会返回拦截占位图
    expect(electronMocks.requests[0]?.headers['User-Agent']).toBe('HangarLabStudio/1.5.0 (map tile debugging)')
    // 密钥只用于上游请求，不能随响应回给渲染进程
    expect([...response.headers.keys()].sort()).toEqual(['cache-control', 'content-type'])
    expect(response.headers.get('content-type')).not.toContain('secret-token')
  })

  it('serves a local directory tile', async () => {
    const root = join(userDataPath, 'tiles')
    await mkdir(join(root, '3', '4'), { recursive: true })
    await writeFile(join(root, '3', '4', '5.png'), Buffer.from('local-bytes'))
    await handler.store.save(remoteSource({ kind: 'directory', path: root, tileExtension: 'png' }))
    const response = await buildMapTileResponse(handler, 'map-tile://tiles/remote-1/3/4/5')
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('local-bytes')
  })

  it('returns 404 when a local tile is missing', async () => {
    const root = join(userDataPath, 'tiles')
    await mkdir(root, { recursive: true })
    await handler.store.save(remoteSource({ kind: 'directory', path: root, tileExtension: 'png' }))
    const response = await buildMapTileResponse(handler, 'map-tile://tiles/remote-1/3/4/5')
    expect(response.status).toBe(404)
    // TileRequestError 的消息里带的是磁盘绝对路径，必须整体丢弃，不能回给渲染进程
    expect(await response.text()).toBe('')
    // 本地目录来源走磁盘读取，不得回落到上游网络
    expect(electronMocks.requests).toHaveLength(0)
  })
})
