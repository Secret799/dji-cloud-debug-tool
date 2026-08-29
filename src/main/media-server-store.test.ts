import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  userDataPath: '',
  decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
}))

vi.mock('electron', () => ({
  app: { getPath: () => electronMocks.userDataPath },
  safeStorage: {
    isEncryptionAvailable: () => true,
    decryptString: electronMocks.decryptString,
  },
}))

import { LOCAL_ZLM_ID, MediaServerStore } from './media-server-store'

describe('MediaServerStore', () => {
  let userDataPath = ''

  beforeEach(async () => {
    userDataPath = await mkdtemp(join(tmpdir(), 'dji-media-server-store-'))
    electronMocks.userDataPath = userDataPath
  })

  afterEach(async () => {
    await rm(userDataPath, { recursive: true, force: true })
  })

  it('creates one local ZLMediaKit profile with an application-encrypted secret', async () => {
    const store = new MediaServerStore()
    const profiles = await store.list()
    expect(profiles).toHaveLength(1)
    expect(profiles[0]).toMatchObject({
      id: LOCAL_ZLM_ID,
      kind: 'local-zlm',
      isDefault: true,
      hasStoredSecret: true,
      secret: '',
      webrtcPort: 8000,
    })
    const stored = await readFile(join(userDataPath, 'media-servers.json'), 'utf8')
    expect(stored).toContain('encryptedSecret')
    expect(stored).toContain('dcdt:v1:k1:')
    expect((await store.getWithSecret(LOCAL_ZLM_ID))?.secret).not.toBe('')
  })

  it('persists a remote SRS profile without exposing its API secret', async () => {
    const store = new MediaServerStore()
    const now = Date.now()
    const saved = await store.save({
      id: 'remote-srs-1',
      name: 'SRS',
      kind: 'remote-srs',
      host: 'media.example.com',
      apiProtocol: 'https',
      apiPort: 1985,
      httpProtocol: 'https',
      httpPort: 443,
      rtmpPort: 1935,
      rtspPort: 0,
      webrtcPort: 8000,
      secret: 'server-secret',
      createdAt: now,
      updatedAt: now,
    })
    expect(saved).toMatchObject({ secret: '', hasStoredSecret: true })
    expect((await store.getWithSecret('remote-srs-1'))?.secret).toBe('server-secret')
    expect(await readFile(join(userDataPath, 'media-servers.json'), 'utf8')).not.toContain('server-secret')
  })

  it('clears a stored API secret only when explicitly requested', async () => {
    const store = new MediaServerStore()
    const now = Date.now()
    const saved = await store.save({
      id: 'remote-srs-clear', name: 'SRS', kind: 'remote-srs', host: 'media.example.com',
      apiProtocol: 'https', apiPort: 1985, httpProtocol: 'https', httpPort: 443,
      rtmpPort: 1935, rtspPort: 0, webrtcPort: 8000, secret: 'server-secret',
      createdAt: now, updatedAt: now,
    })

    const cleared = await store.save({ ...saved, clearStoredSecret: true })

    expect(cleared.hasStoredSecret).toBe(false)
    expect((await store.getWithSecret(saved.id))?.secret).toBe('')
    const document = JSON.parse(await readFile(join(userDataPath, 'media-servers.json'), 'utf8'))
    expect(document.servers.find((server: { id: string }) => server.id === saved.id)).not.toHaveProperty('encryptedSecret')
  })

  it('migrates a transitional plaintext API secret', async () => {
    const store = new MediaServerStore()
    await store.list()
    const filePath = join(userDataPath, 'media-servers.json')
    const document = JSON.parse(await readFile(filePath, 'utf8'))
    document.servers[0].storedSecret = 'plain-media-secret'
    delete document.servers[0].encryptedSecret
    await writeFile(filePath, JSON.stringify(document), 'utf8')

    expect((await new MediaServerStore().getWithSecret(LOCAL_ZLM_ID))?.secret).toBe('plain-media-secret')
    const migrated = await readFile(filePath, 'utf8')
    expect(migrated).not.toContain('storedSecret')
    expect(migrated).not.toContain('plain-media-secret')
    expect(migrated).toContain('dcdt:v1:k1:')
  })

  it('does not overwrite an unmigratable transitional API secret', async () => {
    const store = new MediaServerStore()
    await store.list()
    const filePath = join(userDataPath, 'media-servers.json')
    const document = JSON.parse(await readFile(filePath, 'utf8'))
    document.servers[0].storedSecret = 'x'.repeat(64 * 1024 + 1)
    delete document.servers[0].encryptedSecret
    const original = JSON.stringify(document)
    await writeFile(filePath, original, 'utf8')

    const [profile] = await new MediaServerStore().list()
    await expect(new MediaServerStore().save({ ...profile, name: 'Changed' })).rejects.toThrow('凭据长度不能超过 64 KiB')
    expect(await readFile(filePath, 'utf8')).toBe(original)

    const replacementStore = new MediaServerStore()
    await replacementStore.save({ ...profile, secret: 'replacement-secret' })
    expect((await replacementStore.getWithSecret(profile.id))?.secret).toBe('replacement-secret')
    expect(await readFile(filePath, 'utf8')).not.toContain('storedSecret')
  })

  it('adds a WebRTC port to profiles saved by an older app version', async () => {
    const now = Date.now()
    await writeFile(join(userDataPath, 'media-servers.json'), JSON.stringify({
      version: 1,
      servers: [{
        id: 'remote-zlm-1', name: 'ZLM', kind: 'remote-zlm', host: 'media.example.com',
        apiProtocol: 'http', apiPort: 80, httpProtocol: 'http', httpPort: 80,
        rtmpPort: 1935, rtspPort: 554, createdAt: now, updatedAt: now,
      }],
    }))

    const profiles = await new MediaServerStore().list()
    expect(profiles.find((profile) => profile.id === 'remote-zlm-1')?.webrtcPort).toBe(8000)
    expect(profiles.find((profile) => profile.id === LOCAL_ZLM_ID)?.webrtcPort).toBe(8000)
  })

  it('stores SecretEMS as a separate type without retaining an API secret', async () => {
    const now = Date.now()
    const saved = await new MediaServerStore().save({
      id: 'easymedia-1', name: 'SecretEMS', kind: 'remote-easymedia', host: 'webrtc.example.com',
      apiProtocol: 'https', apiPort: 443, httpProtocol: 'https', httpPort: 443,
      rtmpPort: 1935, rtspPort: 0, webrtcPort: 8000, secret: 'not-applicable',
      createdAt: now, updatedAt: now,
    })

    expect(saved).toMatchObject({ kind: 'remote-easymedia', hasStoredSecret: false })
    expect((await new MediaServerStore().getWithSecret('easymedia-1'))?.secret).toBe('')
  })

  it('does not remove the built-in local service', async () => {
    const store = new MediaServerStore()
    await store.list()
    await expect(store.remove(LOCAL_ZLM_ID)).rejects.toThrow('不能删除')
  })

  it('keeps one default server and falls back when it is removed', async () => {
    const store = new MediaServerStore()
    await store.list()
    const now = Date.now()
    await store.save({
      id: 'remote-default', name: 'Default SRS', kind: 'remote-srs', host: 'media.example.com',
      apiProtocol: 'http', apiPort: 1985, httpProtocol: 'http', httpPort: 8080,
      rtmpPort: 1935, rtspPort: 0, webrtcPort: 8000, secret: '', isDefault: true,
      createdAt: now, updatedAt: now,
    })

    let profiles = await store.list()
    expect(profiles.filter((profile) => profile.isDefault).map((profile) => profile.id)).toEqual(['remote-default'])

    await store.remove('remote-default')
    profiles = await store.list()
    expect(profiles.filter((profile) => profile.isDefault).map((profile) => profile.id)).toEqual([LOCAL_ZLM_ID])
  })
})
