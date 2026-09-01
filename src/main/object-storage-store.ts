import { app } from 'electron'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ObjectStorageProfile } from '../shared/contracts'
import { encryptCredential, type CredentialContext } from './credential-crypto'
import { hasStoredCredential, migrateStoredCredential, resolveStoredCredential } from './stored-credential'

interface StoredObjectStorageProfile extends Omit<
  ObjectStorageProfile,
  | 'accessKeySecret'
  | 'securityToken'
  | 'hasStoredAccessKeySecret'
  | 'hasStoredSecurityToken'
  | 'clearStoredAccessKeySecret'
  | 'clearStoredSecurityToken'
> {
  storedAccessKeySecret?: string
  storedSecurityToken?: string
  encryptedAccessKeySecret?: string
  encryptedSecurityToken?: string
}

interface StoreDocument {
  version: 1
  profiles: StoredObjectStorageProfile[]
}

const accessKeySecretContext = (profileId: string): CredentialContext => ({
  store: 'object-storage',
  recordId: profileId,
  field: 'access-key-secret',
})

const securityTokenContext = (profileId: string): CredentialContext => ({
  store: 'object-storage',
  recordId: profileId,
  field: 'security-token',
})

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
        accessKeySecret: this.decryptAccessKeySecret(profile),
        securityToken: this.decryptSecurityToken(profile),
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
        accessKeySecret: this.decryptAccessKeySecret(profile),
        securityToken: this.decryptSecurityToken(profile),
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
      const document = parsed as StoreDocument
      let migrated = false
      for (const profile of document.profiles) {
        const legacyProfile = profile as StoredObjectStorageProfile & { expire?: unknown }
        if ('expire' in legacyProfile) {
          delete legacyProfile.expire
          migrated = true
        }
        const accessKeySecretMigration = migrateStoredCredential({
          encrypted: profile.encryptedAccessKeySecret,
          plaintext: profile.storedAccessKeySecret,
        }, accessKeySecretContext(profile.id), 'Access Key Secret')
        if (accessKeySecretMigration.migrated) {
          profile.encryptedAccessKeySecret = accessKeySecretMigration.encrypted
          delete profile.storedAccessKeySecret
          migrated = true
        }
        const securityTokenMigration = migrateStoredCredential({
          encrypted: profile.encryptedSecurityToken,
          plaintext: profile.storedSecurityToken,
        }, securityTokenContext(profile.id), 'Security Token')
        if (securityTokenMigration.migrated) {
          profile.encryptedSecurityToken = securityTokenMigration.encrypted
          delete profile.storedSecurityToken
          migrated = true
        }
      }
      if (migrated) await this.writeDocument(document)
      return document
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
      expire: _expire,
      storedAccessKeySecret: _storedAccessKeySecret,
      storedSecurityToken: _storedSecurityToken,
      encryptedAccessKeySecret: _inputEncryptedAccessKeySecret,
      encryptedSecurityToken: _inputEncryptedSecurityToken,
      ...plain
    } = profile as ObjectStorageProfile & {
      storedAccessKeySecret?: unknown
      storedSecurityToken?: unknown
      encryptedAccessKeySecret?: unknown
      encryptedSecurityToken?: unknown
      expire?: unknown
    }
    let encryptedAccessKeySecret = existing?.encryptedAccessKeySecret
    let encryptedSecurityToken = existing?.encryptedSecurityToken
    if (clearStoredAccessKeySecret) {
      encryptedAccessKeySecret = undefined
    } else if (accessKeySecret) {
      encryptedAccessKeySecret = encryptCredential(accessKeySecret, accessKeySecretContext(profile.id))
    } else if (!encryptedAccessKeySecret && existing?.storedAccessKeySecret) {
      encryptedAccessKeySecret = encryptCredential(existing.storedAccessKeySecret, accessKeySecretContext(profile.id))
    }
    if (clearStoredSecurityToken) {
      encryptedSecurityToken = undefined
    } else if (securityToken) {
      encryptedSecurityToken = encryptCredential(securityToken, securityTokenContext(profile.id))
    } else if (!encryptedSecurityToken && existing?.storedSecurityToken) {
      encryptedSecurityToken = encryptCredential(existing.storedSecurityToken, securityTokenContext(profile.id))
    }
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
    const {
      storedAccessKeySecret,
      storedSecurityToken,
      encryptedAccessKeySecret,
      encryptedSecurityToken,
      clearStoredAccessKeySecret: _clearStoredAccessKeySecret,
      clearStoredSecurityToken: _clearStoredSecurityToken,
      expire: _expire,
      ...plain
    } = profile as StoredObjectStorageProfile & {
      clearStoredAccessKeySecret?: boolean
      clearStoredSecurityToken?: boolean
      expire?: unknown
    }
    return {
      ...plain,
      accessKeySecret: '',
      securityToken: '',
      hasStoredAccessKeySecret: hasStoredCredential({ encrypted: encryptedAccessKeySecret, plaintext: storedAccessKeySecret }),
      hasStoredSecurityToken: hasStoredCredential({ encrypted: encryptedSecurityToken, plaintext: storedSecurityToken }),
    }
  }

  private decryptAccessKeySecret(profile: StoredObjectStorageProfile): string {
    return resolveStoredCredential({
      encrypted: profile.encryptedAccessKeySecret,
      plaintext: profile.storedAccessKeySecret,
    }, accessKeySecretContext(profile.id), 'Access Key Secret')
  }

  private decryptSecurityToken(profile: StoredObjectStorageProfile): string {
    return resolveStoredCredential({
      encrypted: profile.encryptedSecurityToken,
      plaintext: profile.storedSecurityToken,
    }, securityTokenContext(profile.id), 'Security Token')
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
