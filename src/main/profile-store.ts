import { app, safeStorage } from 'electron'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ConnectionProfile } from '../shared/contracts'

interface StoredProfile extends Omit<ConnectionProfile, 'password' | 'hasStoredPassword' | 'clearStoredPassword'> {
  encryptedPassword?: string
}

interface StoreDocument {
  version: 1
  profiles: StoredProfile[]
}

interface ConnectionCredentials {
  profile: ConnectionProfile
  password: string
}

const createId = (): string => crypto.randomUUID()

const createDefaultProfile = (): ConnectionProfile => {
  const now = Date.now()
  return {
    id: createId(),
    name: '本地调试',
    protocol: 'mqtt',
    host: 'broker.emqx.io',
    port: 1883,
    path: '/mqtt',
    clientId: `dji-cloud-studio-${Math.random().toString(16).slice(2, 10)}`,
    username: '',
    password: '',
    mqttVersion: '3.1.1',
    clean: true,
    keepalive: 60,
    connectTimeout: 10,
    reconnectPeriod: 3,
    rejectUnauthorized: true,
    caPath: '',
    certPath: '',
    keyPath: '',
    devices: [],
    subscriptions: [],
    createdAt: now,
    updatedAt: now,
  }
}

export class ProfileStore {
  private readonly filePath = join(app.getPath('userData'), 'connection-profiles.json')
  private operationQueue: Promise<void> = Promise.resolve()

  async list(): Promise<ConnectionProfile[]> {
    return this.runExclusive(async () => {
      const document = await this.readDocument()
      return document.profiles.map((profile) => this.toPublicProfile(profile))
    })
  }

  async get(profileId: string): Promise<ConnectionProfile | undefined> {
    return this.runExclusive(async () => {
      const document = await this.readDocument()
      const profile = document.profiles.find((item) => item.id === profileId)
      return profile ? this.toPublicProfile(profile) : undefined
    })
  }

  async getForConnection(profileId: string, sessionPassword?: string): Promise<ConnectionCredentials | undefined> {
    return this.runExclusive(async () => {
      const document = await this.readDocument()
      const profile = document.profiles.find((item) => item.id === profileId)
      if (!profile) return undefined
      const password = sessionPassword !== undefined ? sessionPassword : this.decryptPassword(profile)
      return { profile: this.toPublicProfile(profile), password }
    })
  }

  async save(profile: ConnectionProfile): Promise<ConnectionProfile> {
    return this.runExclusive(async () => {
      const document = await this.readDocument()
      const existingIndex = document.profiles.findIndex((item) => item.id === profile.id)
      const existing = existingIndex >= 0 ? document.profiles[existingIndex] : undefined
      const normalized = this.toStoredProfile(profile, existing)

      if (existingIndex >= 0) {
        document.profiles[existingIndex] = normalized
      } else {
        document.profiles.push(normalized)
      }

      await this.writeDocument(document)
      return this.toPublicProfile(normalized)
    })
  }

  async remove(profileId: string): Promise<boolean> {
    return this.runExclusive(async () => {
      const document = await this.readDocument()
      const nextProfiles = document.profiles.filter((profile) => profile.id !== profileId)
      if (nextProfiles.length === document.profiles.length) return false
      document.profiles = nextProfiles
      await this.writeDocument(document)
      return true
    })
  }

  private async readDocument(): Promise<StoreDocument> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw error
      return this.createDefaultDocument()
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      return this.recoverCorruptDocument(raw, error)
    }

    if (!this.isStoreDocument(parsed)) {
      return this.recoverCorruptDocument(raw, new Error('Unsupported profile store format or version'))
    }
    return parsed
  }

  private async writeDocument(document: StoreDocument): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const tempPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      await writeFile(tempPath, JSON.stringify(document, null, 2), { mode: 0o600, flag: 'wx' })
      await rename(tempPath, this.filePath)
    } catch (error) {
      try {
        await unlink(tempPath)
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn('Unable to remove temporary profile store:', cleanupError)
        }
      }
      throw error
    }
  }

  private toStoredProfile(profile: ConnectionProfile, existing?: StoredProfile): StoredProfile {
    const {
      password,
      hasStoredPassword: _hasStoredPassword,
      clearStoredPassword,
      ...plain
    } = profile
    let encryptedPassword = existing?.encryptedPassword
    if (clearStoredPassword) {
      encryptedPassword = undefined
    } else if (password) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('系统安全存储当前不可用，密码未被保存。请清空密码后保存，并在连接时临时输入。')
      }
      encryptedPassword = safeStorage.encryptString(password).toString('base64')
    }

    return {
      ...plain,
      name: profile.name.trim(),
      host: profile.host.trim(),
      clientId: profile.clientId.trim(),
      username: profile.username.trim(),
      path: profile.path.trim() || '/mqtt',
      updatedAt: Date.now(),
      encryptedPassword,
    }
  }

  private toPublicProfile(profile: StoredProfile): ConnectionProfile {
    const {
      encryptedPassword,
      clearStoredPassword: _clearStoredPassword,
      ...plain
    } = profile as StoredProfile & { clearStoredPassword?: boolean }
    return {
      ...plain,
      password: '',
      hasStoredPassword: Boolean(encryptedPassword),
    }
  }

  async resolvePassword(profileId: string): Promise<string> {
    return this.runExclusive(async () => {
      const document = await this.readDocument()
      const profile = document.profiles.find((item) => item.id === profileId)
      return profile ? this.decryptPassword(profile) : ''
    })
  }

  private async createDefaultDocument(): Promise<StoreDocument> {
    const document: StoreDocument = {
      version: 1,
      profiles: [this.toStoredProfile(createDefaultProfile())],
    }
    await this.writeDocument(document)
    return document
  }

  private async recoverCorruptDocument(raw: string, error: unknown): Promise<StoreDocument> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = `${this.filePath}.corrupt-${timestamp}-${crypto.randomUUID()}.bak`
    await writeFile(backupPath, raw, { mode: 0o600, flag: 'wx' })
    console.warn(`Invalid profile store backed up to ${backupPath}; restoring defaults:`, error)
    return this.createDefaultDocument()
  }

  private isStoreDocument(value: unknown): value is StoreDocument {
    if (!value || typeof value !== 'object') return false
    const candidate = value as Partial<StoreDocument>
    return candidate.version === 1 && Array.isArray(candidate.profiles)
  }

  private decryptPassword(profile: StoredProfile): string {
    if (!profile.encryptedPassword) return ''
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储当前不可用，无法读取已保存密码')
    return safeStorage.decryptString(Buffer.from(profile.encryptedPassword, 'base64'))
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation)
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
