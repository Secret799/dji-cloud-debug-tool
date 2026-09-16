import { app } from 'electron'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { MapTileSource } from '../shared/contracts'
import { encryptCredential, type CredentialContext } from './credential-crypto'
import { hasStoredCredential, migrateStoredCredential, resolveStoredCredential } from './stored-credential'
import { runConfigurationTransaction } from './configuration-transaction'

interface StoredMapTileSource extends Omit<MapTileSource, 'apiKey' | 'hasApiKey' | 'clearApiKey'> {
  storedApiKey?: string
  encryptedApiKey?: string
}

interface StoreDocument {
  version: 1
  sources: StoredMapTileSource[]
}

const apiKeyContext = (sourceId: string): CredentialContext => ({
  store: 'map',
  recordId: sourceId,
  field: 'api-key',
})

/**
 * 底图源配置存储。
 *
 * 刻意不接入 WebDAV 备份：本地瓦片源存绝对路径，跨机器同步必然失效；
 * URL 模板含 API Key，同步出去即泄露。
 */
export class MapTileSourceStore {
  private readonly filePath = join(app.getPath('userData'), 'map-tile-sources.json')
  private operationQueue: Promise<void> = Promise.resolve()

  list(): Promise<MapTileSource[]> {
    return this.runExclusive(async () => {
      const document = await this.readDocument()
      return document.sources.map((source) => this.toPublicSource(source))
    })
  }

  save(source: MapTileSource): Promise<MapTileSource> {
    return this.runExclusive(async () => {
      const document = await this.readDocument()
      // 新建的底图源由 Store 分配标识；id 会作为 map-tile URL 的路径段，必须安全
      const normalizedInput: MapTileSource = source.id ? source : { ...source, id: crypto.randomUUID() }
      const existingIndex = document.sources.findIndex((entry) => entry.id === normalizedInput.id)
      const existing = existingIndex >= 0 ? document.sources[existingIndex] : undefined
      const normalized = this.toStoredSource(normalizedInput, existing)

      if (normalized.isDefault) {
        document.sources = document.sources.map((entry) => ({ ...entry, isDefault: false }))
      }
      if (existingIndex >= 0) document.sources[existingIndex] = normalized
      else document.sources.push(normalized)
      if (!document.sources.some((entry) => entry.isDefault) && document.sources[0]) {
        document.sources[0].isDefault = true
      }

      await this.writeDocument(document)
      return this.toPublicSource(normalized)
    })
  }

  remove(sourceId: string): Promise<boolean> {
    return this.runExclusive(async () => {
      const document = await this.readDocument()
      const next = document.sources.filter((entry) => entry.id !== sourceId)
      if (next.length === document.sources.length) return false
      if (!next.some((entry) => entry.isDefault) && next[0]) next[0].isDefault = true
      document.sources = next
      await this.writeDocument(document)
      return true
    })
  }

  getWithApiKey(sourceId: string): Promise<MapTileSource | undefined> {
    return this.runExclusive(async () => {
      const document = await this.readDocument()
      const source = document.sources.find((entry) => entry.id === sourceId)
      if (!source) return undefined
      return { ...this.toPublicSource(source), apiKey: this.decryptApiKey(source) }
    })
  }

  private async readDocument(): Promise<StoreDocument> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<StoreDocument>
      if (parsed.version !== 1 || !Array.isArray(parsed.sources)) throw new Error('底图源配置版本无效')
      let migrated = false
      for (const source of parsed.sources) {
        const migration = migrateStoredCredential({
          encrypted: source.encryptedApiKey,
          plaintext: source.storedApiKey,
        }, apiKeyContext(source.id), '底图源 API Key')
        if (migration.migrated) {
          source.encryptedApiKey = migration.encrypted
          delete source.storedApiKey
          migrated = true
        }
      }
      const defaultIndex = parsed.sources.findIndex((source) => source.isDefault)
      if (defaultIndex < 0 && parsed.sources[0]) {
        parsed.sources[0].isDefault = true
        migrated = true
      } else {
        parsed.sources.forEach((source, index) => {
          if (index !== defaultIndex && source.isDefault) {
            source.isDefault = false
            migrated = true
          }
        })
      }
      if (migrated) await this.writeDocument(parsed as StoreDocument)
      return parsed as StoreDocument
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // 首次启动不预置任何底图源：两种网络场景都可能遇到，默认挂在线底图会持续加载失败
      const document: StoreDocument = { version: 1, sources: [] }
      await this.writeDocument(document)
      return document
    }
  }

  private toStoredSource(source: MapTileSource, existing?: StoredMapTileSource): StoredMapTileSource {
    const {
      hasApiKey: _hasApiKey,
      clearApiKey,
      apiKey: rawApiKey,
      ...plain
    } = source as MapTileSource & { apiKey?: unknown }
    const apiKey = typeof rawApiKey === 'string' ? rawApiKey : undefined

    let encryptedApiKey = existing?.encryptedApiKey
    if (clearApiKey) encryptedApiKey = undefined
    else if (apiKey) encryptedApiKey = encryptCredential(apiKey, apiKeyContext(source.id))
    else if (!encryptedApiKey && existing?.storedApiKey) {
      encryptedApiKey = encryptCredential(existing.storedApiKey, apiKeyContext(source.id))
    }

    return {
      ...plain,
      name: source.name.trim(),
      urlTemplate: source.urlTemplate.trim(),
      path: source.path.trim(),
      headers: source.headers.map((header) => ({ name: header.name.trim(), value: header.value })),
      tileExtension: source.tileExtension.trim(),
      updatedAt: Date.now(),
      encryptedApiKey,
    }
  }

  private toPublicSource(source: StoredMapTileSource): MapTileSource {
    const {
      storedApiKey,
      encryptedApiKey,
      clearApiKey: _clearApiKey,
      ...plain
    } = source as StoredMapTileSource & { clearApiKey?: boolean }
    return {
      ...plain,
      hasApiKey: hasStoredCredential({ encrypted: encryptedApiKey, plaintext: storedApiKey }),
    }
  }

  private decryptApiKey(source: StoredMapTileSource): string {
    return resolveStoredCredential({
      encrypted: source.encryptedApiKey,
      plaintext: source.storedApiKey,
    }, apiKeyContext(source.id), '底图源 API Key')
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
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn('Unable to remove map tile source temp file:', cleanupError)
        }
      }
      throw error
    }
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return runConfigurationTransaction(() => {
      const result = this.operationQueue.then(operation)
      this.operationQueue = result.then(() => undefined, () => undefined)
      return result
    })
  }
}
