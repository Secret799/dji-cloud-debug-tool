import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// src/main/index.ts 是 Electron 入口：只有把 electron 换成桩、并让 app.whenReady 永不 resolve，
// 才能在单元测试里导入它而不真的启动应用。探测链路目前没有其它可注入的接缝。
vi.mock('electron', () => ({
  app: {
    setName: vi.fn(),
    isPackaged: false,
    getPath: () => '/tmp/dji-cloud-studio-unit-test',
    whenReady: () => new Promise(() => undefined),
    on: vi.fn(),
    quit: vi.fn(),
  },
  BrowserWindow: class {},
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  net: { fetch: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  shell: { openExternal: vi.fn() },
}))

import type { MapTileSource } from '../shared/contracts'
import { mapProbeErrorMessage, probeMapTileSource } from './index'

const probeSource = (patch: Partial<MapTileSource>): MapTileSource => ({
  id: 'source-1',
  name: '测试源',
  layer: 'imagery',
  kind: 'directory',
  urlTemplate: '',
  path: '',
  headers: [],
  coordinateSystem: 'wgs84',
  minZoom: 10,
  maxZoom: 19,
  tileSize: 256,
  tileExtension: '',
  attribution: '',
  createdAt: 1,
  updatedAt: 1,
  ...patch,
})

describe('map probe error messages', () => {
  it('translates the timeout the runtime actually reports', () => {
    // 实测（黑洞上游 + AbortSignal.timeout）：net.fetch 超时抛的就是这个 DOMException
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    expect(mapProbeErrorMessage(timeout)).toBe('探测超时，请检查地址与网络')
  })

  it('translates any error carrying the timeout name', () => {
    expect(mapProbeErrorMessage(Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' })))
      .toBe('探测超时，请检查地址与网络')
  })

  it('keeps upstream failures untouched so the diagnosis still reaches the user', () => {
    expect(mapProbeErrorMessage(new Error('上游返回 HTTP 401'))).toBe('上游返回 HTTP 401')
    expect(mapProbeErrorMessage(new Error('getaddrinfo ENOTFOUND tiles.example.com')))
      .toBe('getaddrinfo ENOTFOUND tiles.example.com')
    expect(mapProbeErrorMessage(new Error('未找到瓦片 0/0/0'))).toBe('未找到瓦片 0/0/0')
    expect(mapProbeErrorMessage('探测失败')).toBe('探测失败')
  })

  it('does not translate an abort that is not a timeout', () => {
    expect(mapProbeErrorMessage(new DOMException('The operation was aborted', 'AbortError')))
      .toBe('The operation was aborted')
  })
})

describe('probeMapTileSource', () => {
  // 城市级瓦片集：z=10 的覆盖范围在 x≈842、y≈400 一带，原点瓦片 (10, 0, 0) 不在其中。
  // 这正是「固定请求原点瓦片」会把可用本地源判成不可用的场景。
  const CITY_ZOOM = 10
  const CITY_X = 842
  const CITY_Y = 400
  const CITY_TILE = 'city-tile'

  let root = ''
  let directoryRoot = ''
  let mbtilesPath = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dji-probe-'))
    directoryRoot = join(root, 'city-tiles')
    await mkdir(join(directoryRoot, String(CITY_ZOOM), String(CITY_X)), { recursive: true })
    await writeFile(join(directoryRoot, String(CITY_ZOOM), String(CITY_X), `${CITY_Y}.png`), Buffer.from(CITY_TILE))

    mbtilesPath = join(root, 'city.mbtiles')
    const database = new DatabaseSync(mbtilesPath)
    database.exec('CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)')
    // MBTiles 用 TMS 行号：y_tms = 2^z - 1 - y_xyz
    database.prepare('INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)')
      .run(CITY_ZOOM, CITY_X, 2 ** CITY_ZOOM - 1 - CITY_Y, new Uint8Array(Buffer.from(CITY_TILE)))
    database.close()
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('accepts a local directory whose tiles do not include the origin tile', async () => {
    const result = await probeMapTileSource(probeSource({ kind: 'directory', path: directoryRoot }))
    expect(result).toEqual({ ok: true, bytes: CITY_TILE.length })
  })

  it('accepts an mbtiles file whose tiles do not include the origin tile', async () => {
    const result = await probeMapTileSource(probeSource({ kind: 'mbtiles', path: mbtilesPath }))
    expect(result).toEqual({ ok: true, bytes: CITY_TILE.length })
  })

  it('reports an empty local tile set honestly instead of blaming the origin tile', async () => {
    const emptyDirectory = join(root, 'empty-tiles')
    await mkdir(emptyDirectory, { recursive: true })
    const emptyMbtiles = join(root, 'empty.mbtiles')
    const database = new DatabaseSync(emptyMbtiles)
    database.exec('CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)')
    database.close()

    const expected = { ok: false, error: '瓦片集为空或路径错误' }
    expect(await probeMapTileSource(probeSource({ kind: 'directory', path: emptyDirectory }))).toEqual(expected)
    expect(await probeMapTileSource(probeSource({ kind: 'directory', path: join(root, 'missing-tiles') }))).toEqual(expected)
    expect(await probeMapTileSource(probeSource({ kind: 'mbtiles', path: emptyMbtiles }))).toEqual(expected)
  })

  it('does not pass a padded tile tree the serving path would rewrite', async () => {
    // 010/842/0400.png：读路径会去取 10/842/400.png，一张都取不到，探测不能给这个源报绿
    const paddedRoot = join(root, 'padded-tiles')
    await mkdir(join(paddedRoot, `0${CITY_ZOOM}`, String(CITY_X)), { recursive: true })
    await writeFile(join(paddedRoot, `0${CITY_ZOOM}`, String(CITY_X), `0${CITY_Y}.png`), Buffer.from(CITY_TILE))
    expect(await probeMapTileSource(probeSource({ kind: 'directory', path: paddedRoot })))
      .toEqual({ ok: false, error: '瓦片集为空或路径错误' })
  })

  it('keeps the underlying reason when a local source is unreadable', async () => {
    const result = await probeMapTileSource(probeSource({ kind: 'mbtiles', path: join(root, 'missing.mbtiles') }))
    expect(result.ok).toBe(false)
    expect(result.error).toContain('无法打开 MBTiles')
  })
})
