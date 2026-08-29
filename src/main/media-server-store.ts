import { app } from 'electron'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import type { MediaServerProfile } from '../shared/contracts'
import { encryptCredential, type CredentialContext } from './credential-crypto'
import { hasStoredCredential, migrateStoredCredential, resolveStoredCredential } from './stored-credential'

interface StoredMediaServerProfile extends Omit<MediaServerProfile, 'secret' | 'hasStoredSecret' | 'clearStoredSecret' | 'webrtcPort'> {
  webrtcPort?: number
  storedSecret?: string
  encryptedSecret?: string
}

interface StoreDocument {
  version: 1
  servers: StoredMediaServerProfile[]
}

export const LOCAL_ZLM_ID = 'local-zlmediakit'
const secretContext = (profileId: string): CredentialContext => ({
  store: 'media',
  recordId: profileId,
  field: 'api-secret',
})

const localLanAddress = (): string => {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address
    }
  }
  return '127.0.0.1'
}

const createLocalProfile = (): MediaServerProfile => {
  const now = Date.now()
  return {
    id: LOCAL_ZLM_ID,
    name: '本地 ZLMediaKit',
    kind: 'local-zlm',
    host: localLanAddress(),
    apiProtocol: 'http',
    apiPort: 9090,
    httpProtocol: 'http',
    httpPort: 9090,
    rtmpPort: 1935,
    rtspPort: 8554,
    webrtcPort: 8000,
    secret: crypto.randomUUID(),
    isDefault: true,
    createdAt: now,
    updatedAt: now,
  }
}

export class MediaServerStore {
  private readonly filePath = join(app.getPath('userData'), 'media-servers.json')
  private operationQueue: Promise<void> = Promise.resolve()

  list(): Promise<MediaServerProfile[]> {
    return this.runExclusive(async () => {
      const document = await this.readDocument()
      return document.servers.map((server) => this.toPublicProfile(server))
    })
  }

  exportAll(): Promise<MediaServerProfile[]> {
    return this.runExclusive(async () => {
      const document = await this.readDocument()
      return document.servers.map((server) => ({
        ...this.toPublicProfile(server),
        secret: this.decryptSecret(server),
      }))
    })
  }

  replaceAll(profiles: MediaServerProfile[]): Promise<void> {
    return this.runExclusive(async () => {
      const source = profiles.some((profile) => profile.id === LOCAL_ZLM_ID)
        ? profiles
        : [createLocalProfile(), ...profiles]
      const stored = source.map((profile) => ({
        ...this.toStoredProfile(profile),
        updatedAt: profile.updatedAt,
      }))
      const defaultIndex = stored.findIndex((server) => server.isDefault)
      stored.forEach((server, index) => {
        server.isDefault = index === (defaultIndex >= 0 ? defaultIndex : 0)
      })
      await this.writeDocument({ version: 1, servers: stored })
    })
  }

  getWithSecret(profileId: string): Promise<MediaServerProfile | undefined> {
    return this.runExclusive(async () => {
      const document = await this.readDocument()
      const profile = document.servers.find((server) => server.id === profileId)
      return profile ? { ...this.toPublicProfile(profile), secret: this.decryptSecret(profile) } : undefined
    })
  }

  save(profile: MediaServerProfile): Promise<MediaServerProfile> {
    return this.runExclusive(async () => {
      const document = await this.readDocument()
      const existingIndex = document.servers.findIndex((server) => server.id === profile.id)
      const existing = existingIndex >= 0 ? document.servers[existingIndex] : undefined
      if (profile.kind === 'local-zlm' && profile.id !== LOCAL_ZLM_ID) throw new Error('只能配置一个本地 ZLMediaKit')
      if (existing?.kind === 'local-zlm' && profile.kind !== 'local-zlm') throw new Error('不能修改本地服务类型')

      const normalized = this.toStoredProfile(profile, existing)
      if (normalized.isDefault) {
        document.servers = document.servers.map((server) => ({ ...server, isDefault: false }))
      }
      if (existingIndex >= 0) document.servers[existingIndex] = normalized
      else document.servers.push(normalized)
      if (!document.servers.some((server) => server.isDefault) && document.servers[0]) {
        document.servers[0].isDefault = true
      }
      await this.writeDocument(document)
      return this.toPublicProfile(normalized)
    })
  }

  remove(profileId: string): Promise<boolean> {
    return this.runExclusive(async () => {
      if (profileId === LOCAL_ZLM_ID) throw new Error('本地 ZLMediaKit 不能删除')
      const document = await this.readDocument()
      const next = document.servers.filter((server) => server.id !== profileId)
      if (next.length === document.servers.length) return false
      if (!next.some((server) => server.isDefault) && next[0]) next[0].isDefault = true
      document.servers = next
      await this.writeDocument(document)
      return true
    })
  }

  private async readDocument(): Promise<StoreDocument> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<StoreDocument>
      if (parsed.version !== 1 || !Array.isArray(parsed.servers)) throw new Error('媒体服务配置版本无效')
      let migrated = false
      if (!parsed.servers.some((server) => server.id === LOCAL_ZLM_ID)) {
        parsed.servers.unshift(this.toStoredProfile(createLocalProfile()))
        migrated = true
      }
      for (const server of parsed.servers) {
        const secretMigration = migrateStoredCredential({
          encrypted: server.encryptedSecret,
          plaintext: server.storedSecret,
        }, secretContext(server.id), '媒体服务 API Secret')
        if (secretMigration.migrated) {
          server.encryptedSecret = secretMigration.encrypted
          delete server.storedSecret
          migrated = true
        }
        if (server.webrtcPort === undefined || (server.kind === 'local-zlm' && server.webrtcPort === 0)) {
          server.webrtcPort = 8000
          migrated = true
        }
      }
      const defaultIndex = parsed.servers.findIndex((server) => server.isDefault)
      if (defaultIndex < 0 && parsed.servers[0]) {
        parsed.servers[0].isDefault = true
        migrated = true
      } else {
        parsed.servers.forEach((server, index) => {
          if (index !== defaultIndex && server.isDefault) {
            server.isDefault = false
            migrated = true
          }
        })
      }
      if (migrated) await this.writeDocument(parsed as StoreDocument)
      return parsed as StoreDocument
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const document: StoreDocument = { version: 1, servers: [this.toStoredProfile(createLocalProfile())] }
      await this.writeDocument(document)
      return document
    }
  }

  private toStoredProfile(profile: MediaServerProfile, existing?: StoredMediaServerProfile): StoredMediaServerProfile {
    const {
      secret,
      hasStoredSecret: _hasStoredSecret,
      clearStoredSecret,
      storedSecret: _storedSecret,
      encryptedSecret: _inputEncryptedSecret,
      ...plain
    } = profile as MediaServerProfile & {
      storedSecret?: unknown
      encryptedSecret?: unknown
    }
    let encryptedSecret = existing?.encryptedSecret
    if (profile.kind === 'remote-easymedia' || clearStoredSecret) encryptedSecret = undefined
    else if (secret) encryptedSecret = encryptCredential(secret, secretContext(profile.id))
    else if (!encryptedSecret && existing?.storedSecret) {
      encryptedSecret = encryptCredential(existing.storedSecret, secretContext(profile.id))
    }
    return {
      ...plain,
      name: profile.name.trim(),
      host: profile.host.trim(),
      updatedAt: Date.now(),
      encryptedSecret,
    }
  }

  private toPublicProfile(profile: StoredMediaServerProfile): MediaServerProfile {
    const {
      storedSecret,
      encryptedSecret,
      clearStoredSecret: _clearStoredSecret,
      ...plain
    } = profile as StoredMediaServerProfile & { clearStoredSecret?: boolean }
    return {
      ...plain,
      webrtcPort: profile.webrtcPort ?? 8000,
      secret: '',
      hasStoredSecret: hasStoredCredential({ encrypted: encryptedSecret, plaintext: storedSecret }),
    }
  }

  private decryptSecret(profile: StoredMediaServerProfile): string {
    return resolveStoredCredential({
      encrypted: profile.encryptedSecret,
      plaintext: profile.storedSecret,
    }, secretContext(profile.id), '媒体服务 API Secret')
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
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Unable to remove media server temp file:', cleanupError)
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
