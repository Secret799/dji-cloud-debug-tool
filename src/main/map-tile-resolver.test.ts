import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MapTileSource } from '../shared/contracts'
import {
  buildTileHeaders,
  buildTileUrl,
  findLocalTileRequest,
  parseTilePath,
  resolveDirectoryTile,
  resolveMbtilesTile,
  TileRequestError,
  type TileRequest,
} from './map-tile-resolver'

const source = (patch: Partial<MapTileSource> = {}): MapTileSource => ({
  id: 'source-1',
  name: '测试源',
  layer: 'imagery',
  kind: 'url-template',
  urlTemplate: 'https://tiles.example.com/{z}/{x}/{y}.png',
  path: '',
  headers: [],
  coordinateSystem: 'wgs84',
  minZoom: 0,
  maxZoom: 19,
  tileSize: 256,
  tileExtension: '',
  attribution: '',
  createdAt: 1,
  updatedAt: 1,
  ...patch,
})

describe('parseTilePath', () => {
  it('parses a well-formed tile path', () => {
    expect(parseTilePath('/source-1/12/3391/1717')).toEqual({
      sourceId: 'source-1',
      request: { z: 12, x: 3391, y: 1717 },
    })
  })

  it('rejects malformed and out-of-range paths', () => {
    expect(parseTilePath('/source-1/12/3391')).toBeUndefined()
    expect(parseTilePath('/source-1/a/1/1')).toBeUndefined()
    expect(parseTilePath('/source-1/12/-1/1')).toBeUndefined()
    expect(parseTilePath('/source-1/12/1/1/extra')).toBeUndefined()
    expect(parseTilePath('/source-1/30/1/1')).toBeUndefined()
  })

  it('rejects coordinates beyond the zoom level extent', () => {
    // z=1 时 x 与 y 的合法取值只有 0 和 1
    expect(parseTilePath('/source-1/1/2/0')).toBeUndefined()
    expect(parseTilePath('/source-1/1/0/1')).toEqual({ sourceId: 'source-1', request: { z: 1, x: 0, y: 1 } })
  })
})

describe('buildTileUrl', () => {
  it('substitutes the zoom, column and row placeholders', () => {
    expect(buildTileUrl(source(), { z: 3, x: 4, y: 5 }, '', 0))
      .toBe('https://tiles.example.com/3/4/5.png')
  })

  it('injects the api key into the key placeholder', () => {
    const keyed = source({ urlTemplate: 'https://tiles.example.com/{z}/{x}/{y}.png?key={key}' })
    expect(buildTileUrl(keyed, { z: 1, x: 1, y: 1 }, 'a b&c', 0))
      .toBe('https://tiles.example.com/1/1/1.png?key=a%20b%26c')
  })

  it('rotates the subdomain placeholder by index', () => {
    const subdomained = source({ urlTemplate: 'https://{s}.tiles.example.com/{z}/{x}/{y}.png' })
    expect(buildTileUrl(subdomained, { z: 1, x: 1, y: 1 }, '', 0)).toContain('https://a.tiles')
    expect(buildTileUrl(subdomained, { z: 1, x: 1, y: 1 }, '', 1)).toContain('https://b.tiles')
    expect(buildTileUrl(subdomained, { z: 1, x: 1, y: 1 }, '', 3)).toContain('https://d.tiles')
    expect(buildTileUrl(subdomained, { z: 1, x: 1, y: 1 }, '', 4)).toContain('https://a.tiles')
  })
})

describe('buildTileHeaders', () => {
  it('substitutes the api key into header values', () => {
    const withHeader = source({ headers: [{ name: 'Authorization', value: 'Bearer {key}' }] })
    expect(buildTileHeaders(withHeader, 'token-1')).toEqual({ Authorization: 'Bearer token-1' })
  })

  it('omits headers when no api key is configured', () => {
    expect(buildTileHeaders(source({ headers: [{ name: 'X-Key', value: '{key}' }] }), '')).toEqual({})
    expect(buildTileHeaders(source(), 'token-1')).toEqual({})
  })

  it('keeps a key containing dollar signs intact', () => {
    const withHeader = source({ headers: [{ name: 'Authorization', value: 'Bearer {key}' }] })
    expect(buildTileHeaders(withHeader, 'a$&b')).toEqual({ Authorization: 'Bearer a$&b' })
  })
})

describe('resolveDirectoryTile', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dji-map-tiles-'))
    await mkdir(join(root, '3', '4'), { recursive: true })
    await writeFile(join(root, '3', '4', '5.png'), Buffer.from('png-bytes'))
    await writeFile(join(root, '3', '4', '5.jpg'), Buffer.from('jpg-bytes'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('reads a tile using the configured extension', async () => {
    const resolved = await resolveDirectoryTile(source({ kind: 'directory', path: root, tileExtension: 'png' }), { z: 3, x: 4, y: 5 })
    expect(resolved.body.toString()).toBe('png-bytes')
    expect(resolved.contentType).toBe('image/png')
  })

  it('auto-detects the extension when none is configured', async () => {
    const resolved = await resolveDirectoryTile(source({ kind: 'directory', path: root }), { z: 3, x: 4, y: 5 })
    expect(resolved.body.toString()).toBe('png-bytes')
  })

  it('reports a missing tile as a 404-equivalent error', async () => {
    await expect(resolveDirectoryTile(source({ kind: 'directory', path: root }), { z: 3, x: 4, y: 6 }))
      .rejects.toThrow(TileRequestError)
  })

  it('refuses to escape the configured root', async () => {
    // 穿越必须经 tileExtension 驱动：抬高 root 的写法不会触发越界检查，
    // 且缺失瓦片与越界抛的是同一个异常类，只断言类型无法分辨二者。
    const traversing = source({ kind: 'directory', path: root, tileExtension: 'x/../../../../etc/passwd' })
    await expect(resolveDirectoryTile(traversing, { z: 3, x: 4, y: 5 })).rejects.toThrow('路径越界')
  })
})

describe('resolveMbtilesTile', () => {
  let root = ''
  let filePath = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dji-map-mbtiles-'))
    filePath = join(root, 'tiles.mbtiles')
    const database = new DatabaseSync(filePath)
    database.exec('CREATE TABLE metadata (name TEXT, value TEXT)')
    database.exec('CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)')
    database.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)').run('name', '测试瓦片集')
    // MBTiles 使用 TMS 行号：y_tms = 2^z - 1 - y_xyz
    database.prepare('INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)')
      .run(3, 4, 2, new Uint8Array(Buffer.from('mbtiles-bytes')))
    database.close()
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('reads a tile using the TMS row convention', async () => {
    const resolved = await resolveMbtilesTile(source({ kind: 'mbtiles', path: filePath }), { z: 3, x: 4, y: 5 })
    expect(resolved.body.toString()).toBe('mbtiles-bytes')
    expect(resolved.contentType).toBe('image/png')
  })

  it('reports a missing tile as a 404-equivalent error', async () => {
    await expect(resolveMbtilesTile(source({ kind: 'mbtiles', path: filePath }), { z: 3, x: 4, y: 6 }))
      .rejects.toThrow(TileRequestError)
  })

  it('reports an unreadable database as a 404-equivalent error', async () => {
    const missing = source({ kind: 'mbtiles', path: join(root, 'missing.mbtiles') })
    await expect(resolveMbtilesTile(missing, { z: 3, x: 4, y: 5 })).rejects.toThrow(TileRequestError)
  })
})

describe('findLocalTileRequest', () => {
  // 城市级瓦片集：z=10 的覆盖范围在 x≈842、y≈400 一带，原点瓦片 (10, 0, 0) 不在其中。
  // 这正是「固定请求原点瓦片」会误报不可用的场景。
  const CITY_ZOOM = 10
  const CITY_X = 842
  const CITY_Y = 400
  const CITY_TILE = 'city-tile'
  const NEIGHBOUR_TILE = 'neighbour-tile'

  let root = ''
  let directoryRoot = ''
  let mbtilesPath = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dji-map-find-'))
    directoryRoot = join(root, 'city-tiles')
    await mkdir(join(directoryRoot, String(CITY_ZOOM), String(CITY_X)), { recursive: true })
    await writeFile(join(directoryRoot, String(CITY_ZOOM), String(CITY_X), `${CITY_Y}.png`), Buffer.from(CITY_TILE))

    mbtilesPath = join(root, 'city.mbtiles')
    const database = new DatabaseSync(mbtilesPath)
    database.exec('CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)')
    const cityRow = 2 ** CITY_ZOOM - 1 - CITY_Y
    // 同一列上相邻的两行：翻转若写错方向，就会落到邻居而不是 CITY_Y 上
    database.prepare('INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)')
      .run(CITY_ZOOM, CITY_X, cityRow, new Uint8Array(Buffer.from(CITY_TILE)))
    database.prepare('INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)')
      .run(CITY_ZOOM, CITY_X, cityRow + 1, new Uint8Array(Buffer.from(NEIGHBOUR_TILE)))
    database.close()
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('picks the tile a local directory actually contains instead of the origin tile', async () => {
    const found = await findLocalTileRequest(source({ kind: 'directory', path: directoryRoot, minZoom: CITY_ZOOM }))
    expect(found).toEqual({ z: CITY_ZOOM, x: CITY_X, y: CITY_Y })
    const resolved = await resolveDirectoryTile(source({ kind: 'directory', path: directoryRoot }), found as TileRequest)
    expect(resolved.body.toString()).toBe(CITY_TILE)
  })

  it('picks the tile an mbtiles source actually contains and round-trips the TMS flip', async () => {
    const mbtiles = source({ kind: 'mbtiles', path: mbtilesPath, minZoom: CITY_ZOOM })
    const found = await findLocalTileRequest(mbtiles)
    expect(found).toEqual({ z: CITY_ZOOM, x: CITY_X, y: CITY_Y })
    // 用现有读路径回读：翻转方向写错时这里读到的会是邻居瓦片
    expect((await resolveMbtilesTile(mbtiles, found as TileRequest)).body.toString()).toBe(CITY_TILE)
    expect((await resolveMbtilesTile(mbtiles, { ...(found as TileRequest), y: CITY_Y - 1 })).body.toString())
      .toBe(NEIGHBOUR_TILE)
  })

  it('skips zoom levels that hold no tile', async () => {
    await mkdir(join(directoryRoot, String(CITY_ZOOM + 1), String(CITY_X)), { recursive: true })
    await writeFile(join(directoryRoot, String(CITY_ZOOM + 1), String(CITY_X), '801.png'), Buffer.from('deep-tile'))
    // 去掉 z=10 那张，只留更深的级别
    await rm(join(directoryRoot, String(CITY_ZOOM)), { recursive: true, force: true })
    const found = await findLocalTileRequest(source({ kind: 'directory', path: directoryRoot }))
    expect(found).toEqual({ z: CITY_ZOOM + 1, x: CITY_X, y: 801 })
  })

  it('ignores tile files whose extension the source does not accept', async () => {
    const pngOnly = source({ kind: 'directory', path: directoryRoot, tileExtension: 'jpg' })
    await writeFile(join(directoryRoot, String(CITY_ZOOM), String(CITY_X), '1.jpg'), Buffer.from('jpg-tile'))
    expect(await findLocalTileRequest(pngOnly)).toEqual({ z: CITY_ZOOM, x: CITY_X, y: 1 })
  })

  it('returns undefined when a local source holds no tiles at all', async () => {
    const emptyDirectory = join(root, 'empty-tiles')
    await mkdir(emptyDirectory, { recursive: true })
    expect(await findLocalTileRequest(source({ kind: 'directory', path: emptyDirectory }))).toBeUndefined()
    expect(await findLocalTileRequest(source({ kind: 'directory', path: join(root, 'missing-tiles') }))).toBeUndefined()
    expect(await findLocalTileRequest(source({ kind: 'directory', path: join(root, 'city-tiles', '10', '842', '400.png') })))
      .toBeUndefined()

    const emptyMbtiles = join(root, 'empty.mbtiles')
    const database = new DatabaseSync(emptyMbtiles)
    database.exec('CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)')
    database.close()
    expect(await findLocalTileRequest(source({ kind: 'mbtiles', path: emptyMbtiles }))).toBeUndefined()
  })

  it('reports an unreadable mbtiles as an error rather than an empty tileset', async () => {
    const missing = source({ kind: 'mbtiles', path: join(root, 'missing.mbtiles') })
    await expect(findLocalTileRequest(missing)).rejects.toThrow('无法打开 MBTiles')
  })
})
