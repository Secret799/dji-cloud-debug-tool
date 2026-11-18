import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  userDataPath: '',
}))

/**
 * 读盘闸门：用来复现「读盘比写入更晚落地」的时序。
 *
 * `loaded` 在内容已经读进手里之后触发，`wait` 让它停在那里不返回：
 * 两者配合才能确定性地做出「读的是旧文件、交回结果却在写入之后」这一种交错。
 */
const readGate = vi.hoisted(() => ({
  loaded: null as null | (() => void),
  wait: null as null | (() => Promise<void>),
}))

vi.mock('electron', () => ({
  app: { getPath: () => electronMocks.userDataPath },
  safeStorage: {
    isEncryptionAvailable: () => true,
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: async (...args: unknown[]) => {
      const loaded = readGate.loaded
      const wait = readGate.wait
      readGate.loaded = null
      readGate.wait = null
      // 内容在这一刻就定下来了（此时文件可能还是写入前的版本）；失败也要留到放行之后再抛出，
      // 否则 ENOENT 会在闸门放行前就结束这次读盘，测不到过期结果被提交的时序
      let contents: unknown
      let failure: unknown
      try {
        contents = await (actual.readFile as (...readArgs: unknown[]) => Promise<unknown>)(...args)
      } catch (error) {
        failure = error
      }
      if (loaded) loaded()
      if (wait) await wait()
      if (failure) throw failure
      return contents
    },
  }
})

import { MapTileSourceStore } from './map-tile-source-store'
import { buildTileUrl } from './map-tile-resolver'
import { runConfigurationTransaction } from './configuration-transaction'
import type { MapTileSource } from '../shared/contracts'

const source = (patch: Partial<MapTileSource> = {}): MapTileSource => ({
  id: 'source-1',
  name: '自建瓦片',
  layer: 'imagery',
  kind: 'url-template',
  urlTemplate: 'https://tiles.example.com/{z}/{x}/{y}.png?key={key}',
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

describe('MapTileSourceStore', () => {
  let userDataPath = ''

  beforeEach(async () => {
    userDataPath = await mkdtemp(join(tmpdir(), 'dji-map-source-store-'))
    electronMocks.userDataPath = userDataPath
  })

  afterEach(async () => {
    await rm(userDataPath, { recursive: true, force: true })
  })

  it('seeds a key-free OpenStreetMap basemap on first launch', async () => {
    const sources = await new MapTileSourceStore().list()
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({
      id: 'openstreetmap',
      name: 'OpenStreetMap',
      layer: 'imagery',
      kind: 'url-template',
      urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      coordinateSystem: 'wgs84',
      attribution: '© OpenStreetMap contributors',
      isDefault: true,
      hasApiKey: false,
    })
    // 预置源必须零 Key：模板里没有 {key} 占位，也不能悄悄带一份凭据
    expect(sources[0]?.urlTemplate).not.toContain('{key}')
    expect(sources[0]?.apiKey).toBeUndefined()
    // 主进程按同一模板拼出的上游地址必须就是可直连的 OSM 瓦片（无需 key 参数）
    expect(buildTileUrl(sources[0]!, { z: 0, x: 0, y: 0 }, '', 0))
      .toBe('https://tile.openstreetmap.org/0/0/0.png')
  })

  it('serves the seeded basemap on the tile path before the first list', async () => {
    const store = new MapTileSourceStore()
    expect(await store.getWithApiKeyForTile('openstreetmap')).toMatchObject({
      urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      apiKey: '',
    })
  })

  it('does not revive the default after the user removes every source', async () => {
    const store = new MapTileSourceStore()
    expect(await store.remove('openstreetmap')).toBe(true)
    expect(await store.list()).toEqual([])
    // 配置已落盘为空，新实例也读这份空配置，不能再自动预置一次
    expect(await new MapTileSourceStore().list()).toEqual([])
  })

  it('fills the default basemap into an empty config written by an older version', async () => {
    // 旧版本只要打开过地图就会写下这样一份空配置，且没有 defaultSeeded 标记
    await writeFile(join(userDataPath, 'map-tile-sources.json'), JSON.stringify({ version: 1, sources: [] }))
    const sources = await new MapTileSourceStore().list()
    expect(sources.map((entry) => entry.id)).toEqual(['openstreetmap'])
    const stored = JSON.parse(await readFile(join(userDataPath, 'map-tile-sources.json'), 'utf8')) as {
      defaultSeeded?: boolean
    }
    // 补齐后必须落标记，避免下次启动重复预置
    expect(stored.defaultSeeded).toBe(true)
  })

  it('saves and lists a source', async () => {
    const store = new MapTileSourceStore()
    const saved = await store.save(source({ apiKey: 'secret-token' } as Partial<MapTileSource>))
    expect(saved.id).toBe('source-1')
    expect(saved.hasApiKey).toBe(true)
    expect(saved.apiKey).toBeUndefined()
    expect((await store.list()).find((entry) => entry.id === 'source-1')?.hasApiKey).toBe(true)
  })

  it('never returns the plaintext api key from list', async () => {
    const store = new MapTileSourceStore()
    await store.save(source({ apiKey: 'secret-token' } as Partial<MapTileSource>))
    const listed = (await store.list())
      .find((entry) => entry.id === 'source-1') as unknown as Record<string, unknown>
    expect(JSON.stringify(listed)).not.toContain('secret-token')
  })

  it('persists the api key only as an encrypted envelope', async () => {
    const store = new MapTileSourceStore()
    await store.save(source({ apiKey: 'secret-token' } as Partial<MapTileSource>))
    const stored = await readFile(join(userDataPath, 'map-tile-sources.json'), 'utf8')
    expect(stored).not.toContain('secret-token')
    expect(stored).toContain('encryptedApiKey')
    expect(stored).toContain('dcdt:v1:k1:')
    expect(stored).not.toContain('storedApiKey')
  })

  it('resolves the stored api key for the main process only', async () => {
    const store = new MapTileSourceStore()
    await store.save(source({ apiKey: 'secret-token' } as Partial<MapTileSource>))
    expect((await store.getWithApiKey('source-1'))?.apiKey).toBe('secret-token')
  })

  it('keeps the stored key when the incoming source has none', async () => {
    const store = new MapTileSourceStore()
    await store.save(source({ apiKey: 'secret-token' } as Partial<MapTileSource>))
    const updated = await store.save(source({ name: '改名后' }))
    expect(updated.hasApiKey).toBe(true)
    expect((await store.getWithApiKey('source-1'))?.apiKey).toBe('secret-token')
  })

  it('clears the stored key when clearApiKey is set', async () => {
    const store = new MapTileSourceStore()
    await store.save(source({ apiKey: 'secret-token' } as Partial<MapTileSource>))
    const cleared = await store.save(source({ clearApiKey: true }))
    expect(cleared.hasApiKey).toBe(false)
    expect((await store.getWithApiKey('source-1'))?.apiKey).toBe('')
  })

  it('keeps only one default source', async () => {
    const store = new MapTileSourceStore()
    await store.save(source({ id: 'source-1', isDefault: true }))
    await store.save(source({ id: 'source-2', isDefault: true }))
    const sources = await store.list()
    expect(sources.filter((entry) => entry.isDefault).map((entry) => entry.id)).toEqual(['source-2'])
  })

  it('promotes the first remaining source when the default is removed', async () => {
    const store = new MapTileSourceStore()
    await store.save(source({ id: 'source-1', isDefault: true }))
    await store.save(source({ id: 'source-2' }))
    expect(await store.remove('source-1')).toBe(true)
    const sources = await store.list()
    // 预置的 OpenStreetMap 先于用户来源入列，删掉默认源后由它接任默认
    expect(sources.map((entry) => entry.id)).toEqual(['openstreetmap', 'source-2'])
    expect(sources.find((entry) => entry.isDefault)?.id).toBe('openstreetmap')
  })

  it('reports a missing source on removal', async () => {
    expect(await new MapTileSourceStore().remove('missing')).toBe(false)
  })

  it('assigns an id when a new source is saved without one', async () => {
    const store = new MapTileSourceStore()
    const saved = await store.save(source({ id: '' }))
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/)
    // 预置的 OpenStreetMap 仍在列表里，新来源必须能按自己的 id 找到
    expect((await store.list()).some((entry) => entry.id === saved.id)).toBe(true)
  })
})

/** 事务未放行时观察读入口的结果：先返回、事务先返回，或两边都没在窗口内返回 */
type RaceOutcome<T> = { kind: 'read'; value: T } | { kind: 'transaction' } | { kind: 'blocked' }

/** 观察窗口。顺序只有在 500ms 内一动不动时才判定为阻塞：真实 fs 写入远快于此 */
const RACE_WINDOW_MS = 500

/**
 * 起一个不会自己结束的配置事务（模拟正在上传的 WebDAV 同步），并给出「已占住队列」与「放行」两个入口。
 *
 * 事务体要等排队轮到自己才执行，因此放行必须走一层间接：直接返回一个捕获值的函数会在
 * 事务尚未开始时就返回空操作，测试会挂在 `await transaction` 上。
 *
 * @returns 事务 Promise、事务已开始的信号与放行函数
 */
const holdConfigurationTransaction = (): {
  transaction: Promise<void>
  started: Promise<void>
  release: () => void
} => {
  let releaseOperation: () => void = () => undefined
  let markStarted: () => void = () => undefined
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const transaction = runConfigurationTransaction(async () => {
    markStarted()
    await new Promise<void>((resolve) => {
      releaseOperation = resolve
    })
  })
  return { transaction, started, release: () => releaseOperation() }
}

/**
 * 在事务仍未放行时观察读入口：谁先返回就是谁的结果，都没返回则是阻塞。
 *
 * 窗口是必要的：若读入口被排在事务后面，两个 Promise 都不会返回，不设上限就会挂到超时，
 * 失败原因也就从「读入口等事务」变成一句没有信息量的超时。
 *
 * @param target 被测的读入口
 * @param transaction 正在占用配置事务队列的事务
 * @returns 读入口先返回时的取值、事务先返回、或窗口内都没返回
 */
const observeWhileTransactionRuns = async <T>(
  target: Promise<T>,
  transaction: Promise<void>,
): Promise<RaceOutcome<T>> => Promise.race<RaceOutcome<T>>([
  target.then((value): RaceOutcome<T> => ({ kind: 'read', value })),
  transaction.then((): RaceOutcome<T> => ({ kind: 'transaction' })),
  new Promise<RaceOutcome<T>>((resolve) => {
    setTimeout(() => resolve({ kind: 'blocked' }), RACE_WINDOW_MS)
  }),
])

describe('map tile source tile-path reads', () => {
  let userDataPath = ''

  beforeEach(async () => {
    userDataPath = await mkdtemp(join(tmpdir(), 'dji-map-source-tile-read-'))
    electronMocks.userDataPath = userDataPath
    // 闸门是用例自己的脚手架，漏放行不能污染后面的用例
    readGate.loaded = null
    readGate.wait = null
  })

  afterEach(async () => {
    await rm(userDataPath, { recursive: true, force: true })
  })

  it('serves the tile path while a configuration transaction is running', async () => {
    const store = new MapTileSourceStore()
    await store.save(source({ id: 'source-1', apiKey: 'secret-token' }))
    const { transaction, started, release } = holdConfigurationTransaction()
    try {
      // 等事务真的占住队列，否则下面的读可能抢在它前面，测不到阻塞
      await started
      // 事务仍在进行中，瓦片读已经拿到来源；把读入口挪回事务队列会让这里变成 blocked
      expect(await observeWhileTransactionRuns(store.getWithApiKeyForTile('source-1'), transaction))
        .toEqual({ kind: 'read', value: expect.objectContaining({ id: 'source-1', apiKey: 'secret-token' }) })
      // 对照组：同一时刻普通读入口（list 走 runExclusive）确实还堵在队列里，
      // 说明上面读到的不是「事务其实早就结束了」
      expect((await observeWhileTransactionRuns(store.list(), transaction)).kind).toBe('blocked')
    } finally {
      release()
      await transaction
    }
  })

  it('reads the first tile request from disk without joining the queue', async () => {
    await new MapTileSourceStore().save(source({ id: 'source-1', apiKey: 'secret-token' }))
    // 新实例没有内存快照，首次读必须读盘建快照；读盘同样不得等事务
    const cold = new MapTileSourceStore()
    const { transaction, started, release } = holdConfigurationTransaction()
    try {
      await started
      expect(await observeWhileTransactionRuns(cold.getWithApiKeyForTile('source-1'), transaction))
        .toEqual({ kind: 'read', value: expect.objectContaining({ id: 'source-1', apiKey: 'secret-token' }) })
    } finally {
      release()
      await transaction
    }
  })

  it('keeps the fresher write when a cold disk read lands after it', async () => {
    const store = new MapTileSourceStore()
    let releaseRead: () => void = () => undefined
    let markReadLoaded: () => void = () => undefined
    const readLoaded = new Promise<void>((resolve) => {
      markReadLoaded = resolve
    })
    readGate.loaded = markReadLoaded
    readGate.wait = () => new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    const coldRead = store.getWithApiKeyForTile('source-1')
    // 等这次读盘确实把「文件不存在」读进手里，再让写入发生，交错顺序就是确定的
    await readLoaded
    await store.save(source({ id: 'source-1', apiKey: 'first-key' }))
    releaseRead()
    // 这次读盘的内容早于写入，不能拿它回话：读入口交出的必须是写入侧那份
    expect(await coldRead).toMatchObject({ id: 'source-1', apiKey: 'first-key' })
    // 过期的读盘结果也不得把写入侧的快照覆盖成空快照，
    // 否则被删除或替换的来源会一直从快照里被发出去
    expect((await store.getWithApiKeyForTile('source-1'))?.apiKey).toBe('first-key')
    expect(await store.remove('source-1')).toBe(true)
    expect(await store.getWithApiKeyForTile('source-1')).toBeUndefined()
  })

  it('reflects a saved source on the tile path right after the write', async () => {
    const store = new MapTileSourceStore()
    expect(await store.getWithApiKeyForTile('source-1')).toBeUndefined()
    await store.save(source({ id: 'source-1', apiKey: 'first-key' }))
    expect((await store.getWithApiKeyForTile('source-1'))?.apiKey).toBe('first-key')
    // 整条记录覆盖写：改名与换密钥都必须立刻体现在瓦片路径上
    await store.save(source({ id: 'source-1', name: '改名后', apiKey: 'second-key' }))
    expect(await store.getWithApiKeyForTile('source-1')).toMatchObject({ name: '改名后', apiKey: 'second-key' })
    // 冷快照（新实例）读到的必须与热快照一致，说明快照随写盘刷新而不是只活在内存里
    expect((await new MapTileSourceStore().getWithApiKeyForTile('source-1'))?.apiKey).toBe('second-key')
    expect(await store.remove('source-1')).toBe(true)
    expect(await store.getWithApiKeyForTile('source-1')).toBeUndefined()
  })
})
