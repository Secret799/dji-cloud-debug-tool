import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  userDataPath: '',
}))

vi.mock('electron', () => ({
  app: { getPath: () => electronMocks.userDataPath },
  safeStorage: {
    isEncryptionAvailable: () => true,
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}))

import { MapTileSourceStore } from './map-tile-source-store'
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

  it('starts empty so the first launch shows an unconfigured globe', async () => {
    expect(await new MapTileSourceStore().list()).toEqual([])
  })

  it('saves and lists a source', async () => {
    const store = new MapTileSourceStore()
    const saved = await store.save(source({ apiKey: 'secret-token' } as Partial<MapTileSource>))
    expect(saved.id).toBe('source-1')
    expect(saved.hasApiKey).toBe(true)
    expect(saved.apiKey).toBeUndefined()
    expect((await store.list())[0]?.hasApiKey).toBe(true)
  })

  it('never returns the plaintext api key from list', async () => {
    const store = new MapTileSourceStore()
    await store.save(source({ apiKey: 'secret-token' } as Partial<MapTileSource>))
    const listed = (await store.list())[0] as unknown as Record<string, unknown>
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

  it('promotes another source to default when the default is removed', async () => {
    const store = new MapTileSourceStore()
    await store.save(source({ id: 'source-1', isDefault: true }))
    await store.save(source({ id: 'source-2' }))
    expect(await store.remove('source-1')).toBe(true)
    const sources = await store.list()
    expect(sources.map((entry) => entry.id)).toEqual(['source-2'])
    expect(sources[0]?.isDefault).toBe(true)
  })

  it('reports a missing source on removal', async () => {
    expect(await new MapTileSourceStore().remove('missing')).toBe(false)
  })

  it('assigns an id when a new source is saved without one', async () => {
    const store = new MapTileSourceStore()
    const saved = await store.save(source({ id: '' }))
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/)
    expect((await store.list())[0]?.id).toBe(saved.id)
  })
})
