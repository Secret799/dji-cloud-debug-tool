import { app, safeStorage } from 'electron'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ObjectStorageProfile } from '../shared/contracts'

interface StoredObjectStorageProfile extends Omit<
  ObjectStorageProfile,
  | 'accessKeySecret'
  | 'securityToken'
  | 'hasStoredAccessKeySecret'
  | 'hasStoredSecurityToken'
  | 'clearStoredAccessKeySecret'
  | 'clearStoredSecurityToken'
> {
  encryptedAccessKeySecret?: string
  encryptedSecurityToken?: string
}

interface StoreDocument {
  version: 1
  profiles: StoredObjectStorageProfile[]
}

export class ObjectStorageStore {
  private readonly filePath = join(app.getPath('userData'), 'object-storage-profiles.json')
  private operationQueue: Promise<void> = Promise.resolve()

  list(): Promise<ObjectStorageProfile[]> {
    return this.runExclusive(async () => {
      const document = await this.readDocument()
      return document.profiles.map((profile) => this.toPublicProfile(profile))
    })
  }

  exportAll(): Promise<ObjectStorageProfile[]> {
    return this.runExclusive(async () => {
      const document = await this.readDocument()
      return document.profiles.map((profile) => ({
        ...this.toPublicProfile(profile),
        accessKeySecret: this.decrypt(profile.encryptedAccessKeySecret, 'Access Key Secret'),
        securityToken: this.decrypt(profile.encryptedSecurityToken, 'Security Token'),
      }))
    })
  }

  replaceAll(profiles: ObjectStorageProfile[]): Promise<void> {
    return this.runExclusive(async () => {
      const stored = profiles.map((profile) => ({
        ...this.toStoredProfile(profile),
        updatedAt: profile.updatedAt,
      }))
      if (stored.some((profile) => !profile.encryptedAccessKeySecret)) {
        throw new Error('备份中的对象存储配置缺少 Access Key Secret')
      }
      await this.writeDocument({ version: 1, profiles: stored })
    })
  }

  resolve(profileId: string): Promise<ObjectStorageProfile | undefined> {
    return this.runExclusive(async () => {
      const document = await this.readDocument()
      const profile = document.profiles.find((item) => item.id === profileId)
      if (!profile) return undefined
      return {
        ...this.toPublicProfile(profile),
        accessKeySecret: this.decrypt(profile.encryptedAccessKeySecret, 'Access Key Secret'),
        securityToken: this.decrypt(profile.encryptedSecurityToken, 'Security Token'),
      }
    })
  }

  save(profile: ObjectStorageProfile): Promise<ObjectStorageProfile> {
    return this.runExclusive(async () => {
      const document = await this.readDocument()
      const existingIndex = document.profiles.findIndex((item) => item.id === profile.id)
      const existing = existingIndex >= 0 ? document.profiles[existingIndex] : undefined
      const normalized = this.toStoredProfile(profile, existing)
      if (!normalized.encryptedAccessKeySecret) throw new Error('Access Key Secret 不能为空')
      if (existingIndex >= 0) document.profiles[existingIndex] = normalized
      else document.profiles.push(normalized)
      await this.writeDocument(document)
      return this.toPublicProfile(normalized)
    })
  }

  remove(profileId: string): Promise<boolean> {
    return this.runExclusive(async () => {
      const document = await this.readDocument()
      const next = document.profiles.filter((profile) => profile.id !== profileId)
      if (next.length === document.profiles.length) return false
      document.profiles = next
      await this.writeDocument(document)
      return true
    })
  }

  private async readDocument(): Promise<StoreDocument> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<StoreDocument>
      if (parsed.version !== 1 || !Array.isArray(parsed.profiles)) throw new Error('对象存储配置版本无效')
      return parsed as StoreDocument
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const document: StoreDocument = { version: 1, profiles: [] }
      await this.writeDocument(document)
      return document
    }
  }

  private toStoredProfile(
    profile: ObjectStorageProfile,
    existing?: StoredObjectStorageProfile,
  ): StoredObjectStorageProfile {
    const {
      accessKeySecret,
      securityToken,
      hasStoredAccessKeySecret: _hasStoredAccessKeySecret,
      hasStoredSecurityToken: _hasStoredSecurityToken,
      clearStoredAccessKeySecret,
      clearStoredSecurityToken,
      ...plain
    } = profile
    let encryptedAccessKeySecret = clearStoredAccessKeySecret ? undefined : existing?.encryptedAccessKeySecret
    let encryptedSecurityToken = clearStoredSecurityToken ? undefined : existing?.encryptedSecurityToken
    if (accessKeySecret) encryptedAccessKeySecret = this.encrypt(accessKeySecret, 'Access Key Secret')
    if (securityToken) encryptedSecurityToken = this.encrypt(securityToken, 'Security Token')
    return {
      ...plain,
      name: profile.name.trim(),
      bucket: profile.bucket.trim(),
      region: profile.region.trim(),
      endpoint: profile.endpoint.trim(),
      accessKeyId: profile.accessKeyId.trim(),
      updatedAt: Date.now(),
      encryptedAccessKeySecret,
      encryptedSecurityToken,
    }
  }

  private toPublicProfile(profile: StoredObjectStorageProfile): ObjectStorageProfile {
    const { encryptedAccessKeySecret, encryptedSecurityToken, ...plain } = profile
    return {
      ...plain,
      accessKeySecret: '',
      securityToken: '',
      hasStoredAccessKeySecret: Boolean(encryptedAccessKeySecret),
      hasStoredSecurityToken: Boolean(encryptedSecurityToken),
    }
  }

  private encrypt(value: string, label: string): string {
    if (!safeStorage.isEncryptionAvailable()) throw new Error(`系统安全存储当前不可用，${label} 无法保存`)
    return safeStorage.encryptString(value).toString('base64')
  }

  private decrypt(value: string | undefined, label: string): string {
    if (!value) return ''
    if (!safeStorage.isEncryptionAvailable()) throw new Error(`系统安全存储当前不可用，无法读取 ${label}`)
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  }

  private async writeDocument(document: StoreDocument): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      await writeFile(temporaryPath, JSON.stringify(document, null, 2), { mode: 0o600, flag: 'wx' })
      await rename(temporaryPath, this.filePath)
    } catch (error) {
      try {
        await unlink(temporaryPath)
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Unable to remove object storage temp file:', cleanupError)
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
