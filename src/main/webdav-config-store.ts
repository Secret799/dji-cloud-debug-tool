import { app } from 'electron'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { WebDavActivity, WebDavConfig, WebDavVersion } from '../shared/contracts'
import { encryptCredential, type CredentialContext } from './credential-crypto'
import { hasStoredCredential, migrateStoredCredential, resolveStoredCredential } from './stored-credential'
import type { WebDavSyncFingerprint } from './webdav-sync-merge'

interface StoredWebDavConfig extends Omit<
  WebDavConfig,
  'secret' | 'hasStoredSecret' | 'clearStoredSecret'
> {
  storedSecret?: string
  encryptedSecret?: string
}

interface ConfigDocument {
  version: 1
  config?: StoredWebDavConfig
}

const secretContext: CredentialContext = {
  store: 'webdav',
  recordId: 'singleton',
  field: 'secret',
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
        secret: this.decryptSecret(document.config),
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
      const document = parsed as ConfigDocument
      if (document.config) {
        const migration = migrateStoredCredential({
          encrypted: document.config.encryptedSecret,
          plaintext: document.config.storedSecret,
        }, secretContext, 'WebDAV 密钥')
        if (migration.migrated) {
          document.config.encryptedSecret = migration.encrypted
          delete document.config.storedSecret
          await this.writeJson(this.configPath, document)
        }
      }
      return document
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
      storedSecret: _storedSecret,
      encryptedSecret: _inputEncryptedSecret,
      ...plain
    } = config as WebDavConfig & {
      storedSecret?: unknown
      encryptedSecret?: unknown
    }
    let encryptedSecret = existing?.encryptedSecret
    if (clearStoredSecret) encryptedSecret = undefined
    else if (secret) encryptedSecret = encryptCredential(secret, secretContext)
    else if (!encryptedSecret && existing?.storedSecret) {
      encryptedSecret = encryptCredential(existing.storedSecret, secretContext)
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
    const {
      storedSecret,
      encryptedSecret,
      clearStoredSecret: _clearStoredSecret,
      ...plain
    } = config as StoredWebDavConfig & { clearStoredSecret?: boolean }
    return {
      ...plain,
      autoSync: config.autoSync !== false,
      syncStrategy: config.syncStrategy ?? 'smart-merge',
      secret: '',
      hasStoredSecret: hasStoredCredential({ encrypted: encryptedSecret, plaintext: storedSecret }),
    }
  }

  private decryptSecret(config: StoredWebDavConfig): string {
    return resolveStoredCredential({
      encrypted: config.encryptedSecret,
      plaintext: config.storedSecret,
    }, secretContext, 'WebDAV 密钥')
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
