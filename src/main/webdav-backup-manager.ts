import { app } from 'electron'
import type {
  OperationResult,
  WebDavActivity,
  WebDavConfig,
  WebDavOverview,
  WebDavRestoreResult,
  WebDavSyncEvent,
  WebDavSyncRequest,
  WebDavVersion,
} from '../shared/contracts'
import {
  validateConnectionProfile,
  validateMediaServerProfile,
  validateObjectStorageProfile,
} from './ipc-validation'
import { MediaServerStore } from './media-server-store'
import { ObjectStorageStore } from './object-storage-store'
import { ProfileStore } from './profile-store'
import { decryptWebDavBackup, encryptWebDavBackup } from './webdav-backup-crypto'
import { WebDavClient } from './webdav-client'
import { WebDavConfigStore } from './webdav-config-store'
import {
  changedMqttRuntimeProfileIds,
  fingerprintWebDavData,
  reconcileWebDavData,
  webDavDataEqual,
  type WebDavSyncData,
} from './webdav-sync-merge'

interface PortableBackupDocument {
  format: 'dji-cloud-studio-backup'
  version: 1 | 2
  revision: number
  createdAt: number
  appVersion: string
  clientId?: string
  parentVersionId?: string
  data: WebDavSyncData
}

interface SyncLockDocument {
  owner: string
  clientId: string
  createdAt: number
  expiresAt: number
}

const AUTO_SYNC_DELAY_MS = 1_500
const REMOTE_POLL_INTERVAL_MS = 30_000
const LOCK_TTL_MS = 120_000
const LOCK_RETRY_MS = 250
const LOCK_ATTEMPTS = 40

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const operationError = (error: unknown): string => error instanceof Error ? error.message : String(error)
const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds))

const versionFromDocument = (id: string, size: number, document: PortableBackupDocument): WebDavVersion => ({
  id,
  revision: document.revision,
  createdAt: document.createdAt,
  size,
  appVersion: document.appVersion,
})

export class WebDavBackupManager {
  private operationQueue: Promise<void> = Promise.resolve()
  private automaticSyncTimer?: ReturnType<typeof setTimeout>
  private remotePollTimer?: ReturnType<typeof setTimeout>
  private stopping = false
  private rendererStorage: Record<string, string> = {}

  constructor(
    private readonly configStore: WebDavConfigStore,
    private readonly profileStore: ProfileStore,
    private readonly mediaServerStore: MediaServerStore,
    private readonly objectStorageStore: ObjectStorageStore,
    private readonly beforeRestore: (profileIds: string[]) => Promise<void>,
    private readonly onSyncCompleted: (event: WebDavSyncEvent) => void = () => undefined,
  ) {}

  getOverview(): Promise<WebDavOverview> {
    return this.runExclusive(() => this.loadOverview())
  }

  saveConfig(config: WebDavConfig): Promise<WebDavOverview> {
    return this.runExclusive(async () => {
      this.stopping = false
      await this.configStore.save(config)
      const overview = await this.loadOverview()
      this.scheduleSync()
      return overview
    })
  }

  removeConfig(): Promise<OperationResult> {
    return this.runExclusive(async () => {
      this.stopping = true
      if (this.automaticSyncTimer) clearTimeout(this.automaticSyncTimer)
      if (this.remotePollTimer) clearTimeout(this.remotePollTimer)
      this.automaticSyncTimer = undefined
      this.remotePollTimer = undefined
      await this.configStore.remove()
      return { ok: true }
    })
  }

  test(config?: WebDavConfig): Promise<OperationResult> {
    return this.runExclusive(async () => {
      try {
        const resolved = await this.resolveCandidateConfig(config)
        await new WebDavClient(resolved).test()
        return { ok: true }
      } catch (error) {
        return { ok: false, error: operationError(error) }
      }
    })
  }

  notifyLocalChange(request?: WebDavSyncRequest): void {
    if (this.stopping) return
    if (request) this.rendererStorage = { ...request.rendererStorage }
    this.scheduleSync()
  }

  flushPending(): Promise<void> {
    this.stopping = true
    if (this.remotePollTimer) clearTimeout(this.remotePollTimer)
    this.remotePollTimer = undefined
    const shouldSync = Boolean(this.automaticSyncTimer)
    if (this.automaticSyncTimer) clearTimeout(this.automaticSyncTimer)
    this.automaticSyncTimer = undefined
    return this.runExclusive(async () => {
      if (shouldSync) await this.performAutomaticSync()
    })
  }

  sync(request: WebDavSyncRequest): Promise<WebDavOverview> {
    this.rendererStorage = { ...request.rendererStorage }
    if (this.automaticSyncTimer) clearTimeout(this.automaticSyncTimer)
    this.automaticSyncTimer = undefined
    return this.runExclusive(() => this.performSync())
  }

  restore(versionId: string): Promise<WebDavRestoreResult> {
    return this.runExclusive(async () => {
      try {
        const config = await this.requireConfig()
        const client = new WebDavClient(config)
        const encrypted = await client.download(versionId)
        const document = this.parseBackupDocument(decryptWebDavBackup(encrypted, config.secret))
        const previous = await this.captureSnapshot()
        const affectedProfileIds = changedMqttRuntimeProfileIds(previous.profiles, document.data.profiles)
        if (affectedProfileIds.length) await this.beforeRestore(affectedProfileIds)
        try {
          await this.applySnapshot(document.data)
        } catch (restoreError) {
          try {
            await this.applySnapshot(previous)
          } catch (rollbackError) {
            throw new Error(`恢复失败且无法回滚：${operationError(restoreError)}；${operationError(rollbackError)}`)
          }
          throw restoreError
        }
        this.rendererStorage = { ...document.data.rendererStorage }
        const restored = versionFromDocument(versionId, encrypted.byteLength, document)
        const versions = await client.listVersions()
        const latest = versions[0]
        let baseFingerprint = fingerprintWebDavData(document.data)
        if (latest && latest.id !== versionId) {
          const latestDocument = this.parseBackupDocument(decryptWebDavBackup(await client.download(latest.id), config.secret))
          baseFingerprint = fingerprintWebDavData(latestDocument.data)
        }
        await this.configStore.updateSyncState((state) => ({
          ...state,
          localVersion: restored,
          baseVersionId: latest?.id ?? versionId,
          baseFingerprint,
          activities: [this.activity('restore', restored), ...state.activities],
        }))
        return {
          ok: true,
          rendererStorage: document.data.rendererStorage,
          overview: await this.buildOverview(versions, true),
        }
      } catch (error) {
        return { ok: false, error: operationError(error) }
      }
    })
  }

  removeVersion(versionId: string): Promise<WebDavOverview> {
    return this.runExclusive(async () => {
      const config = await this.requireConfig()
      const client = new WebDavClient(config)
      const versions = await client.listVersions()
      const target = versions.find((version) => version.id === versionId)
      if (!target) throw new Error('要删除的 WebDAV 数据版本不存在')
      await client.remove(versionId)
      await this.configStore.updateSyncState((state) => ({
        ...state,
        localVersion: state.localVersion?.id === versionId ? undefined : state.localVersion,
        baseVersionId: state.baseVersionId === versionId ? undefined : state.baseVersionId,
        baseFingerprint: state.baseVersionId === versionId ? undefined : state.baseFingerprint,
        activities: [this.activity('delete', target), ...state.activities],
      }))
      return this.buildOverview(versions.filter((version) => version.id !== versionId), true)
    })
  }

  private scheduleSync(): void {
    if (this.automaticSyncTimer) clearTimeout(this.automaticSyncTimer)
    this.automaticSyncTimer = setTimeout(() => {
      this.automaticSyncTimer = undefined
      void this.runExclusive(() => this.performAutomaticSync()).catch((error) => {
        console.warn('Automatic WebDAV synchronization failed:', error)
      }).finally(() => this.scheduleRemotePoll())
    }, AUTO_SYNC_DELAY_MS)
  }

  private scheduleRemotePoll(): void {
    if (this.stopping || this.remotePollTimer) return
    this.remotePollTimer = setTimeout(() => {
      this.remotePollTimer = undefined
      void this.runExclusive(() => this.performAutomaticSync()).catch((error) => {
        console.warn('Periodic WebDAV synchronization failed:', error)
      }).finally(() => this.scheduleRemotePoll())
    }, REMOTE_POLL_INTERVAL_MS)
  }

  private async performAutomaticSync(): Promise<void> {
    const config = await this.configStore.get()
    if (!config?.autoSync) return
    await this.performSync()
  }

  private async performSync(): Promise<WebDavOverview> {
    const config = await this.requireConfig()
    const client = new WebDavClient(config)
    const state = await this.configStore.getSyncState()
    const lock = await this.acquireLock(client, state.clientId)
    try {
      const versions = await client.listVersions()
      const latest = versions[0]
      const local = await this.captureSnapshot()
      let merged = local
      let remoteDocument: PortableBackupDocument | undefined
      if (latest) {
        const encrypted = await client.download(latest.id)
        remoteDocument = this.parseBackupDocument(decryptWebDavBackup(encrypted, config.secret))
        merged = reconcileWebDavData(
          local,
          remoteDocument.data,
          Boolean(state.baseVersionId),
          state.baseFingerprint,
          config.syncStrategy,
        )
      }

      const remoteApplied = !webDavDataEqual(local, merged)
      if (remoteApplied) {
        const affectedProfileIds = changedMqttRuntimeProfileIds(local.profiles, merged.profiles)
        if (affectedProfileIds.length) await this.beforeRestore(affectedProfileIds)
        try {
          await this.applySnapshot(merged)
        } catch (mergeError) {
          try {
            await this.applySnapshot(local)
          } catch (rollbackError) {
            throw new Error(`同步合并失败且无法回滚：${operationError(mergeError)}；${operationError(rollbackError)}`)
          }
          throw mergeError
        }
        this.rendererStorage = { ...merged.rendererStorage }
      }

      if (latest && remoteDocument && webDavDataEqual(merged, remoteDocument.data)) {
        await this.recordSyncBase(latest, merged, remoteApplied ? 'restore' : undefined)
        return this.completeSync(await this.buildOverview(versions, true), remoteApplied)
      }

      const revision = Math.max(0, ...versions.map((version) => version.revision)) + 1
      const createdAt = Date.now()
      const id = `v${String(revision).padStart(6, '0')}-${createdAt}-${crypto.randomUUID()}.djibak`
      const document: PortableBackupDocument = {
        format: 'dji-cloud-studio-backup',
        version: 2,
        revision,
        createdAt,
        appVersion: app.getVersion(),
        clientId: state.clientId,
        parentVersionId: latest?.id,
        data: merged,
      }
      const encrypted = encryptWebDavBackup(document, config.secret)
      await client.upload(id, encrypted)
      const uploaded = versionFromDocument(id, encrypted.byteLength, document)
      await this.recordSyncBase(uploaded, merged, 'upload')
      return this.completeSync(await this.buildOverview([uploaded, ...versions], true), remoteApplied)
    } finally {
      await client.releaseSyncLock(lock.owner).catch((error) => {
        console.warn('Unable to release WebDAV synchronization lock:', error)
      })
    }
  }

  private async acquireLock(client: WebDavClient, clientId: string): Promise<SyncLockDocument> {
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      const createdAt = Date.now()
      const lock: SyncLockDocument = {
        owner: crypto.randomUUID(),
        clientId,
        createdAt,
        expiresAt: createdAt + LOCK_TTL_MS,
      }
      if (await client.tryAcquireSyncLock(Buffer.from(JSON.stringify(lock), 'utf8'))) return lock
      await client.removeExpiredSyncLock(createdAt)
      await delay(LOCK_RETRY_MS)
    }
    throw new Error('WebDAV 同步正在被另一个客户端处理，请稍后重试')
  }

  private async loadOverview(): Promise<WebDavOverview> {
    const config = await this.configStore.get()
    if (!config) {
      const state = await this.configStore.getSyncState()
      return { configured: false, connected: false, versions: [], activities: state.activities }
    }
    try {
      const resolved = await this.requireConfig()
      const versions = await new WebDavClient(resolved).listVersions()
      return this.buildOverview(versions, true, config)
    } catch (error) {
      const overview = await this.buildOverview([], false, config)
      return { ...overview, error: operationError(error) }
    }
  }

  private async buildOverview(
    versions: WebDavVersion[],
    connected: boolean,
    publicConfig?: WebDavConfig,
  ): Promise<WebDavOverview> {
    const [config, state] = await Promise.all([
      publicConfig ? Promise.resolve(publicConfig) : this.configStore.get(),
      this.configStore.getSyncState(),
    ])
    return {
      configured: Boolean(config),
      connected,
      config,
      localVersion: state.localVersion,
      cloudVersion: versions[0],
      versions,
      activities: state.activities,
    }
  }

  private async resolveCandidateConfig(candidate?: WebDavConfig): Promise<WebDavConfig> {
    if (!candidate) return this.requireConfig()
    if (candidate.secret) return candidate
    const existing = await this.configStore.resolve()
    if (!existing?.secret || !candidate.hasStoredSecret) {
      throw new Error(candidate.authType === 'token' ? 'Token 不能为空' : '密码不能为空')
    }
    return { ...candidate, secret: existing.secret }
  }

  private async requireConfig(): Promise<WebDavConfig> {
    const config = await this.configStore.resolve()
    if (!config) throw new Error('请先配置 WebDAV')
    if (!config.secret) throw new Error(config.authType === 'token' ? 'WebDAV Token 为空' : 'WebDAV 密码为空')
    return config
  }

  private async captureSnapshot(): Promise<WebDavSyncData> {
    const [profiles, mediaServers, objectStorageProfiles] = await Promise.all([
      this.profileStore.exportAll(),
      this.mediaServerStore.exportAll(),
      this.objectStorageStore.exportAll(),
    ])
    return {
      profiles,
      deviceArchives: [],
      mediaServers,
      objectStorageProfiles,
      rendererStorage: {},
    }
  }

  private parseBackupDocument(value: unknown): PortableBackupDocument {
    if (!isRecord(value) || value.format !== 'dji-cloud-studio-backup' || (value.version !== 1 && value.version !== 2)) {
      throw new Error('WebDAV 数据版本格式无效')
    }
    if (!Number.isInteger(value.revision) || (value.revision as number) < 1) throw new Error('WebDAV 数据版本号无效')
    if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) throw new Error('WebDAV 数据版本时间无效')
    if (typeof value.appVersion !== 'string' || !value.appVersion) throw new Error('WebDAV 数据版本缺少应用版本')
    if (!isRecord(value.data)) throw new Error('WebDAV 数据版本内容无效')
    const raw = value.data
    if (!Array.isArray(raw.profiles) || !Array.isArray(raw.deviceArchives) || !Array.isArray(raw.mediaServers) || !Array.isArray(raw.objectStorageProfiles)) {
      throw new Error('WebDAV 数据版本内容不完整')
    }
    const profiles = raw.profiles.map(validateConnectionProfile)
    const data: WebDavSyncData = {
      profiles,
      deviceArchives: [],
      mediaServers: raw.mediaServers.map(validateMediaServerProfile),
      objectStorageProfiles: raw.objectStorageProfiles.map(validateObjectStorageProfile),
      rendererStorage: {},
    }
    return {
      format: 'dji-cloud-studio-backup',
      version: value.version,
      revision: value.revision as number,
      createdAt: value.createdAt,
      appVersion: value.appVersion,
      clientId: typeof value.clientId === 'string' ? value.clientId : undefined,
      parentVersionId: typeof value.parentVersionId === 'string' ? value.parentVersionId : undefined,
      data,
    }
  }

  private async applySnapshot(data: WebDavSyncData): Promise<void> {
    await this.profileStore.replaceAll(data.profiles)
    await this.mediaServerStore.replaceAll(data.mediaServers)
    await this.objectStorageStore.replaceAll(data.objectStorageProfiles)
  }

  private activity(type: WebDavActivity['type'], version: WebDavVersion): WebDavActivity {
    return { id: crypto.randomUUID(), type, revision: version.revision, at: Date.now() }
  }

  private completeSync(overview: WebDavOverview, remoteApplied: boolean): WebDavOverview {
    try {
      this.onSyncCompleted({ overview, remoteApplied })
    } catch (error) {
      console.warn('Unable to publish WebDAV synchronization event:', error)
    }
    return overview
  }

  private async recordSyncBase(
    version: WebDavVersion,
    data: WebDavSyncData,
    activityType?: WebDavActivity['type'],
  ): Promise<void> {
    await this.configStore.updateSyncState((state) => ({
      ...state,
      localVersion: version,
      baseVersionId: version.id,
      baseFingerprint: fingerprintWebDavData(data),
      activities: activityType ? [this.activity(activityType, version), ...state.activities] : state.activities,
    }))
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation)
    this.operationQueue = result.then(() => undefined, () => undefined)
    return result
  }
}
