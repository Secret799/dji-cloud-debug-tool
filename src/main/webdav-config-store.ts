import { app, safeStorage } from 'electron'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { WebDavActivity, WebDavConfig, WebDavVersion } from '../shared/contracts'
import type { WebDavSyncFingerprint } from './webdav-sync-merge'

interface StoredWebDavConfig extends Omit<
  WebDavConfig,
  'secret' | 'hasStoredSecret' | 'clearStoredSecret'
> {
  encryptedSecret?: string
}

interface ConfigDocument {
  version: 1
  config?: StoredWebDavConfig
}

export interface SyncStateDocument {
  version: 2
  clientId: string
  localVersion?: WebDavVersion
  baseVersionId?: string
  baseFingerprint?: WebDavSyncFingerprint
  activities: WebDavActivity[]
}

export class WebDavConfigStore {
  private readonly configPath = join(app.getPath('userData'), 'webdav-config.json')
  private readonly statePath = join(app.getPath('userData'), 'webdav-sync-state.json')
  private operationQueue: Promise<void> = Promise.resolve()

  get(): Promise<WebDavConfig | undefined> {
    return this.runExclusive(async () => {
      const document = await this.readConfigDocument()
      return document.config ? this.toPublicConfig(document.config) : undefined
    })
  }

  resolve(): Promise<WebDavConfig | undefined> {
    return this.runExclusive(async () => {
      const document = await this.readConfigDocument()
      if (!document.config) return undefined
      return {
        ...this.toPublicConfig(document.config),
        secret: this.decryptSecret(document.config.encryptedSecret),
      }
    })
  }

  save(config: WebDavConfig): Promise<WebDavConfig> {
    return this.runExclusive(async () => {
      const document = await this.readConfigDocument()
      const stored = this.toStoredConfig(config, document.config)
      if (!stored.encryptedSecret) throw new Error(config.authType === 'token' ? 'Token 不能为空' : '密码不能为空')
      await this.writeJson(this.configPath, { version: 1, config: stored })
      if (document.config && (
        document.config.endpoint !== stored.endpoint
        || document.config.authType !== stored.authType
        || document.config.username !== stored.username
      )) {
        const state = await this.readSyncState()
        await this.writeJson(this.statePath, {
          ...state,
          localVersion: undefined,
          baseVersionId: undefined,
          baseFingerprint: undefined,
        })
      }
      return this.toPublicConfig(stored)
    })
  }

  remove(): Promise<void> {
    return this.runExclusive(async () => {
      await this.writeJson(this.configPath, { version: 1 })
      const state = await this.readSyncState()
      await this.writeJson(this.statePath, {
        ...state,
        localVersion: undefined,
        baseVersionId: undefined,
        baseFingerprint: undefined,
      })
    })
  }

  getSyncState(): Promise<SyncStateDocument> {
    return this.runExclusive(() => this.readSyncState())
  }

  updateSyncState(
    updater: (state: SyncStateDocument) => SyncStateDocument,
  ): Promise<SyncStateDocument> {
    return this.runExclusive(async () => {
      const next = updater(await this.readSyncState())
      const normalized: SyncStateDocument = {
        version: 2,
        clientId: next.clientId,
        localVersion: next.localVersion,
        baseVersionId: next.baseVersionId,
        baseFingerprint: next.baseFingerprint,
        activities: next.activities.slice(0, 100),
      }
      await this.writeJson(this.statePath, normalized)
      return normalized
    })
  }

  private async readConfigDocument(): Promise<ConfigDocument> {
    try {
      const parsed = JSON.parse(await readFile(this.configPath, 'utf8')) as Partial<ConfigDocument>
      if (parsed.version !== 1 || (parsed.config !== undefined && typeof parsed.config !== 'object')) {
        throw new Error('WebDAV 配置版本无效')
      }
      return parsed as ConfigDocument
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { version: 1 }
    }
  }

  private async readSyncState(): Promise<SyncStateDocument> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, 'utf8')) as {
        version?: number
        clientId?: unknown
        localVersion?: WebDavVersion
        baseVersionId?: string
        baseFingerprint?: WebDavSyncFingerprint
        activities?: WebDavActivity[]
      }
      if ((parsed.version !== 1 && parsed.version !== 2) || !Array.isArray(parsed.activities)) {
        throw new Error('WebDAV 同步状态版本无效')
      }
      return {
        version: 2,
        clientId: typeof parsed.clientId === 'string' && parsed.clientId ? parsed.clientId : crypto.randomUUID(),
        localVersion: parsed.localVersion,
        baseVersionId: parsed.version === 2 ? parsed.baseVersionId : parsed.localVersion?.id,
        baseFingerprint: parsed.version === 2 ? parsed.baseFingerprint : undefined,
        activities: parsed.activities,
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { version: 2, clientId: crypto.randomUUID(), activities: [] }
    }
  }

  private toStoredConfig(
    config: WebDavConfig,
    existing?: StoredWebDavConfig,
  ): StoredWebDavConfig {
    const {
      secret,
      hasStoredSecret: _hasStoredSecret,
      clearStoredSecret,
      ...plain
    } = config
    let encryptedSecret = clearStoredSecret ? undefined : existing?.encryptedSecret
    if (secret) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储当前不可用，WebDAV 密钥无法保存')
      encryptedSecret = safeStorage.encryptString(secret).toString('base64')
    }
    return {
      ...plain,
      endpoint: config.endpoint.trim(),
      username: config.username.trim(),
      updatedAt: Date.now(),
      encryptedSecret,
    }
  }

  private toPublicConfig(config: StoredWebDavConfig): WebDavConfig {
    const { encryptedSecret, ...plain } = config
    return {
      ...plain,
      autoSync: config.autoSync !== false,
      syncStrategy: config.syncStrategy ?? 'smart-merge',
      secret: '',
      hasStoredSecret: Boolean(encryptedSecret),
    }
  }

  private decryptSecret(value: string | undefined): string {
    if (!value) return ''
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储当前不可用，无法读取 WebDAV 密钥')
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      await writeFile(temporaryPath, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' })
      await rename(temporaryPath, path)
    } catch (error) {
      try {
        await unlink(temporaryPath)
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn('Unable to remove WebDAV temporary file:', cleanupError)
        }
      }
      throw error
    }
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation)
    this.operationQueue = result.then(() => undefined, () => undefined)
    return result
  }
}
