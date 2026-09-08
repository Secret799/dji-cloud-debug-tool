import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebDavConfig } from '../shared/contracts'

const electron = vi.hoisted(() => ({ directory: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => electron.directory, getVersion: () => 'test' },
  safeStorage: { isEncryptionAvailable: () => false },
}))

import { ProfileStore } from './profile-store'
import { MediaServerStore } from './media-server-store'
import { ObjectStorageStore } from './object-storage-store'
import { WebDavConfigStore, type SyncStateDocument } from './webdav-config-store'
import { WebDavBackupManager } from './webdav-backup-manager'
import { WebDavClient } from './webdav-client'
import { encryptWebDavBackup } from './webdav-backup-crypto'
import { fingerprintWebDavData, type WebDavSyncData } from './webdav-sync-merge'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
const config: WebDavConfig = {
  endpoint: 'http://unused.invalid/', authType: 'basic', username: 'test', secret: 'secret',
  autoSync: false, syncStrategy: 'smart-merge', rejectUnauthorized: true, updatedAt: 1,
}

describe('WebDAV backup transactions', () => {
  let profiles: ProfileStore
  let media: MediaServerStore
  let objects: ObjectStorageStore
  let manager: WebDavBackupManager
  let base: WebDavSyncData
  let configStore: WebDavConfigStore
  const servers: ReturnType<typeof createServer>[] = []
  let beforeRestore: ReturnType<typeof vi.fn<(ids: string[]) => Promise<void>>>

  beforeEach(async () => {
    electron.directory = await mkdtemp(join(tmpdir(), 'dji-webdav-transaction-'))
    profiles = new ProfileStore()
    media = new MediaServerStore()
    objects = new ObjectStorageStore()
    const [profile] = await profiles.list()
    await profiles.replaceAll([
      { ...profile, id: 'a', name: 'Base A', updatedAt: 1 },
      { ...profile, id: 'b', name: 'Base B', updatedAt: 1 },
    ])
    base = {
      profiles: await profiles.exportAll(), mediaServers: await media.exportAll(),
      objectStorageProfiles: [], deviceArchives: [], rendererStorage: {},
    }
    let state: SyncStateDocument = {
      version: 2, clientId: 'test', activities: [], baseVersionId: 'base',
      baseFingerprint: fingerprintWebDavData(base),
    }
    configStore = {
      resolve: async () => config, get: async () => config, getSyncState: async () => state,
      updateSyncState: async (update: (value: SyncStateDocument) => SyncStateDocument) => { state = update(state); return state },
    } as unknown as WebDavConfigStore
    beforeRestore = vi.fn(async () => undefined)
    manager = new WebDavBackupManager(configStore, profiles, media, objects, beforeRestore)
    vi.spyOn(WebDavClient.prototype, 'tryAcquireSyncLock').mockResolvedValue(true)
    vi.spyOn(WebDavClient.prototype, 'releaseSyncLock').mockResolvedValue(undefined)
    vi.spyOn(WebDavClient.prototype, 'upload').mockResolvedValue(undefined)
    vi.spyOn(WebDavClient.prototype, 'listVersions').mockResolvedValue([{ id: 'remote', revision: 2, createdAt: 2, size: 1 }])
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close((error) => error ? reject(error) : resolve())
    })))
    await rm(electron.directory, { recursive: true, force: true })
  })

  const encrypted = (data: WebDavSyncData) => encryptWebDavBackup({
    format: 'dji-cloud-studio-backup', version: 2, revision: 2, createdAt: 2, appVersion: 'test', data,
  }, config.secret, 1)

  it('preserves a save acknowledged while a remote snapshot is downloading', async () => {
    const started = deferred()
    const finish = deferred()
    const remote = { ...base, profiles: base.profiles.map((p) => p.id === 'b' ? { ...p, name: 'Remote B', updatedAt: 2 } : p) }
    vi.spyOn(WebDavClient.prototype, 'download').mockImplementation(async () => {
      started.resolve()
      await finish.promise
      return encrypted(remote)
    })
    const syncing = manager.sync({ rendererStorage: {} })
    await started.promise
    await profiles.save({ ...base.profiles[0], name: 'Saved during GET' })
    finish.resolve()
    await syncing
    expect((await profiles.get('a'))?.name).toBe('Saved during GET')
    expect((await profiles.get('b'))?.name).toBe('Remote B')
  })

  it('leaves local data intact if listing versions fails during restore', async () => {
    vi.spyOn(WebDavClient.prototype, 'download').mockResolvedValue(encrypted(base))
    vi.mocked(WebDavClient.prototype.listVersions).mockRejectedValue(new Error('directory unavailable'))
    await profiles.save({ ...base.profiles[0], name: 'Before restore' })
    expect(await manager.restore('remote')).toMatchObject({ ok: false, error: 'directory unavailable' })
    expect((await profiles.get('a'))?.name).toBe('Before restore')
    expect(beforeRestore).not.toHaveBeenCalled()
  })

  it('serializes saves in every participating store until snapshot application finishes', async () => {
    const started = deferred()
    const finish = deferred()
    beforeRestore.mockImplementation(async () => { started.resolve(); await finish.promise })
    const remote = { ...base, profiles: base.profiles.map((p) => p.id === 'b' ? { ...p, host: 'remote.example', updatedAt: 2 } : p) }
    vi.spyOn(WebDavClient.prototype, 'download').mockResolvedValue(encrypted(remote))
    const syncing = manager.sync({ rendererStorage: {} })
    await started.promise
    const completed: string[] = []
    const saves = Promise.all([
      profiles.save({ ...base.profiles[0], name: 'New MQTT' }).then(() => completed.push('mqtt')),
      media.save({ ...base.mediaServers[0], name: 'New media' }).then(() => completed.push('media')),
      objects.save({ id: 'new-object', name: 'New object', provider: 'ali', bucket: 'bucket', region: 'cn-hangzhou',
        endpoint: 'https://oss.example', accessKeyId: 'key', accessKeySecret: 'secret', securityToken: '', createdAt: 1, updatedAt: 1,
      }).then(() => completed.push('object')),
    ])
    await new Promise((resolve) => setTimeout(resolve, 30))
    const completedWhileApplying = [...completed]
    finish.resolve()
    await Promise.all([syncing, saves])
    expect(completedWhileApplying).toEqual([])
    expect((await profiles.get('a'))?.name).toBe('New MQTT')
    expect((await media.list())[0].name).toBe('New media')
    expect((await objects.list())[0].name).toBe('New object')
  })

  it('leaves local data intact if downloading the latest base fails during restore', async () => {
    vi.spyOn(WebDavClient.prototype, 'download').mockResolvedValueOnce(encrypted(base)).mockRejectedValue(new Error('latest unavailable'))
    vi.mocked(WebDavClient.prototype.listVersions).mockResolvedValue([{ id: 'latest', revision: 3, createdAt: 3, size: 1 }])
    await profiles.save({ ...base.profiles[0], name: 'Before restore' })
    expect(await manager.restore('remote')).toMatchObject({ ok: false, error: 'latest unavailable' })
    expect((await profiles.get('a'))?.name).toBe('Before restore')
  })

  it('rolls back restored stores if saving synchronization metadata fails', async () => {
    vi.spyOn(WebDavClient.prototype, 'download').mockResolvedValue(encrypted(base))
    await profiles.save({ ...base.profiles[0], name: 'Before restore' })
    vi.spyOn(configStore, 'updateSyncState').mockRejectedValue(new Error('metadata write failed'))
    expect(await manager.restore('remote')).toMatchObject({ ok: false, error: 'metadata write failed' })
    expect((await profiles.get('a'))?.name).toBe('Before restore')
  })

  it('keeps local snapshots unchanged when uploading a merged version fails', async () => {
    const remote = { ...base, profiles: base.profiles.map((p) => p.id === 'b' ? { ...p, host: 'remote.example', updatedAt: 2 } : p) }
    vi.spyOn(WebDavClient.prototype, 'download').mockResolvedValue(encrypted(remote))
    await profiles.save({ ...base.profiles[0], name: 'Local A' })
    const before = await profiles.exportAll()
    vi.mocked(WebDavClient.prototype.upload).mockRejectedValue(new Error('upload failed'))
    await expect(manager.sync({ rendererStorage: {} })).rejects.toThrow('upload failed')
    expect(await profiles.exportAll()).toEqual(before)
    expect(beforeRestore).not.toHaveBeenCalled()
  })

  it('rolls back a merged snapshot if synchronization metadata cannot be saved', async () => {
    const remote = { ...base, profiles: base.profiles.map((p) => p.id === 'b' ? { ...p, host: 'remote.example', updatedAt: 2 } : p) }
    vi.spyOn(WebDavClient.prototype, 'download').mockResolvedValue(encrypted(remote))
    await profiles.save({ ...base.profiles[0], name: 'Local A' })
    const before = await profiles.exportAll()
    vi.spyOn(configStore, 'updateSyncState').mockRejectedValueOnce(new Error('metadata write failed'))
    await expect(manager.sync({ rendererStorage: {} })).rejects.toThrow('metadata write failed')
    expect(await profiles.exportAll()).toEqual(before)
    expect((await configStore.getSyncState()).baseVersionId).toBe('base')

    const [uploadedId, uploadedPayload] = vi.mocked(WebDavClient.prototype.upload).mock.calls[0]
    vi.mocked(WebDavClient.prototype.listVersions).mockResolvedValue([{ id: uploadedId, revision: 3, createdAt: 3, size: uploadedPayload.byteLength }])
    vi.mocked(WebDavClient.prototype.download).mockResolvedValue(uploadedPayload)
    vi.mocked(WebDavClient.prototype.upload).mockClear()
    const retried = await manager.sync({ rendererStorage: {} })
    expect(retried.localVersion?.id).toBe(uploadedId)
    expect((await configStore.getSyncState()).baseVersionId).toBe(uploadedId)
    expect((await profiles.get('a'))?.name).toBe('Local A')
    expect((await profiles.get('b'))?.host).toBe('remote.example')
    expect(WebDavClient.prototype.upload).not.toHaveBeenCalled()
  })

  it('does not apply remote data if preparing the synchronization overview fails', async () => {
    const remote = { ...base, profiles: base.profiles.map((p) => p.id === 'b' ? { ...p, host: 'remote.example', updatedAt: 2 } : p) }
    vi.spyOn(WebDavClient.prototype, 'download').mockResolvedValue(encrypted(remote))
    vi.spyOn(configStore, 'get').mockRejectedValue(new Error('config read failed'))
    await expect(manager.sync({ rendererStorage: {} })).rejects.toThrow('config read failed')
    expect(await profiles.exportAll()).toEqual(base.profiles)
    expect(beforeRestore).not.toHaveBeenCalled()
  })

  it('releases queued store saves when an HTTP upload response is truncated', async () => {
    const started = deferred()
    const server = createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        response.writeHead(201, { 'Content-Length': '1000' })
        response.write('partial')
        started.resolve()
        setTimeout(() => response.destroy(), 10)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    vi.spyOn(configStore, 'resolve').mockResolvedValue({ ...config, endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` })
    const remote = { ...base, profiles: base.profiles.map((p) => p.id === 'b' ? { ...p, host: 'remote.example', updatedAt: 2 } : p) }
    vi.spyOn(WebDavClient.prototype, 'download').mockResolvedValue(encrypted(remote))
    vi.mocked(WebDavClient.prototype.upload).mockRestore()
    await profiles.save({ ...base.profiles[0], name: 'Local A' })
    const syncing = manager.sync({ rendererStorage: {} }).then(() => 'resolved', (error: Error) => error.message)
    await started.promise
    const saving = profiles.save({ ...base.profiles[0], name: 'Saved after interruption' })
    expect(await syncing).toMatch(/中断|关闭/)
    expect((await saving).name).toBe('Saved after interruption')
    expect((await profiles.get('b'))?.host).toBe(base.profiles[1].host)
    expect(beforeRestore).not.toHaveBeenCalled()
  })
})
