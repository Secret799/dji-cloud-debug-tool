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
  /**
   * 是否已经处理过「默认底图」：补齐预置源后置为 true。
   *
   * 旧版本首次打开地图会写下一份 `sources: []` 的空配置，缺少这段标记就无法与
   * 「用户主动删空所有来源」区分；写到盘上的文档一律带上该标记。
   */
  defaultSeeded?: boolean
}

/** 底图源内存快照：以来源标识为键，值为公开配置加解密后的 API Key */
type SourceSnapshot = Map<string, MapTileSource>

const apiKeyContext = (sourceId: string): CredentialContext => ({
  store: 'map',
  recordId: sourceId,
  field: 'api-key',
})

/** 首次启动预置的 OpenStreetMap 来源标识；固定值便于用户与文档核对 */
export const DEFAULT_OPENSTREETMAP_SOURCE_ID = 'openstreetmap'

/**
 * 首次启动（userData 下还没有底图源配置文件）时预置的底图源清单。
 *
 * 只预置一个零 Key 的 OpenStreetMap 影像源：全新安装打开地图就能看到带署名的底图，
 * 不必先配置才能出图。OSM 公共瓦片只适合低流量场景，因此必须保留
 * © OpenStreetMap contributors 署名；用户仍可另存高德、天地图等来源并设为默认。
 *
 * 每次返回新对象而不是共享常量：读盘路径会就地归一化 isDefault，
 * 共享同一份对象会被不同实例改脏。
 *
 * @returns 预置底图源（固定 OpenStreetMap，默认启用）
 */
export const createInitialMapTileSources = (): StoredMapTileSource[] => {
  const now = Date.now()
  return [
    {
      id: DEFAULT_OPENSTREETMAP_SOURCE_ID,
      name: 'OpenStreetMap',
      layer: 'imagery',
      kind: 'url-template',
      urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      path: '',
      headers: [],
      coordinateSystem: 'wgs84',
      minZoom: 0,
      maxZoom: 19,
      tileSize: 256,
      tileExtension: '',
      attribution: '© OpenStreetMap contributors',
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    },
  ]
}

/**
 * 判断一份底图源配置是否需要补齐预置的 OpenStreetMap 默认源。
 *
 * 只补一次：任何一次落盘都会把 `defaultSeeded` 置为 true，
 * 因此旧版本留下的空配置会被补齐，而用户主动删空的所有来源不会被重新预置。
 *
 * @param document 已读入的底图源文档
 * @returns 需要预置默认源时返回 true
 */
const needsDefaultSource = (
  document: Partial<Pick<StoreDocument, 'sources' | 'defaultSeeded'>>,
): boolean => (document.sources?.length ?? 0) === 0 && document.defaultSeeded !== true

/**
 * 底图源配置存储。
 *
 * 刻意不接入 WebDAV 备份：本地瓦片源存绝对路径，跨机器同步必然失效；
 * URL 模板含 API Key，同步出去即泄露。
 */
export class MapTileSourceStore {
  private readonly filePath = join(app.getPath('userData'), 'map-tile-sources.json')
  private operationQueue: Promise<void> = Promise.resolve()
  private snapshot: SourceSnapshot | null = null
  private snapshotPending: Promise<SourceSnapshot> | null = null
  private writeRevision = 0

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

  /**
   * 供主进程瓦片路径读取底图源，是瓦片热路径唯一允许使用的读入口。
   *
   * 与 {@link getWithApiKey} 的差别有两点，都是为了不把瓦片请求拖在 WebDAV 同步后面：
   * 一是不进入配置事务队列 —— WebDAV 同步把整次上传的网络往返包在同一个事务里，
   * 而底图源刻意不参与备份，读它没有任何需要与备份串行的理由；
   * 二是不每次读盘 —— 首次读盘建立内存快照，此后命中内存，省掉逐请求的
   * 文件读取、JSON 解析、迁移与解密。
   *
   * @param sourceId 底图源标识
   * @returns 带明文 API Key 的底图源；不存在时为 undefined
   */
  async getWithApiKeyForTile(sourceId: string): Promise<MapTileSource | undefined> {
    const snapshot = await this.ensureSnapshot()
    const source = snapshot.get(sourceId)
    // 返回副本，避免调用方就地改动把快照带脏
    return source ? { ...source } : undefined
  }

  /**
   * 取得内存快照，必要时先读盘建立。
   *
   * 并发的首次读只读一次盘：未完成时共用同一个 Promise。
   * 读盘失败不缓存，后续请求会重新尝试。
   *
   * @returns 底图源内存快照
   */
  private ensureSnapshot(): Promise<SourceSnapshot> {
    if (this.snapshot) return Promise.resolve(this.snapshot)
    if (!this.snapshotPending) {
      const revision = this.writeRevision
      this.snapshotPending = this.loadSnapshot(revision)
        .then((loaded) => this.commitSnapshot(loaded, revision))
        .finally(() => {
          this.snapshotPending = null
        })
    }
    return this.snapshotPending
  }

  /**
   * 读盘建立快照。
   *
   * 刻意不落盘：写盘必须保持串行，而这里可能被瓦片请求并发触发，
   * 迁移与默认值归一化仍由串行路径在 {@link readDocument} 里负责。
   * 读取本身不会看到写了一半的文件 —— 写盘是「临时文件 + rename」原子替换。
   *
   * @param revision 开始读盘时的写入版本号
   * @returns 读盘得到的快照；文件不存在时为空快照
   */
  private async loadSnapshot(revision: number): Promise<SourceSnapshot> {
    let parsed: Partial<StoreDocument>
    try {
      parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<StoreDocument>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // 首次启动预置的 OpenStreetMap 源也要能被瓦片热路径读到，
      // 否则 list() 尚未建立配置文件时默认底图的瓦片会全部 404
      parsed = { version: 1, sources: createInitialMapTileSources() }
    }
    // 读盘期间若有写入落盘，本次读到的内容可能已经过期，交给提交环节丢弃
    if (this.writeRevision !== revision) return this.snapshot ?? new Map()
    if (parsed.version !== 1 || !Array.isArray(parsed.sources)) throw new Error('底图源配置版本无效')
    // 旧版本留下的空配置也要在内存快照里补上预置源，
    // 否则 list() 建立配置文件之前，默认底图的瓦片会全部 404
    return this.buildSnapshot(needsDefaultSource(parsed) ? createInitialMapTileSources() : parsed.sources)
  }

  /**
   * 提交读盘结果，并丢弃读盘期间已被写入覆盖的旧内容。
   *
   * 同一次读盘内可能发生：读盘打开旧文件 → 某次保存写入新文件并刷新快照 → 读盘返回旧内容。
   * 写入侧用的是刚写完的文档，永远比这次读盘新，因此以它为准，快照不会回退到旧配置。
   *
   * @param loaded 读盘得到的快照
   * @param revision 开始读盘时的写入版本号
   * @returns 生效的快照
   */
  private commitSnapshot(loaded: SourceSnapshot, revision: number): SourceSnapshot {
    if (this.writeRevision === revision) this.snapshot = loaded
    return this.snapshot ?? loaded
  }

  /**
   * 用已落盘的数据建立快照，逐个来源解密 API Key。
   *
   * 解不开的来源直接跳过而不是让整次写盘失败：瓦片路径对这类来源的结果本就是 404，
   * 不该因为一条坏记录把保存与读取一起带崩。
   *
   * @param sources 已落盘的底图源
   * @returns 以来源标识为键的内存快照
   */
  private buildSnapshot(sources: StoredMapTileSource[]): SourceSnapshot {
    const snapshot: SourceSnapshot = new Map()
    for (const source of sources) {
      try {
        snapshot.set(source.id, { ...this.toPublicSource(source), apiKey: this.decryptApiKey(source) })
      } catch (error) {
        console.warn(`Unable to resolve map tile source api key (${source.id}):`, error)
      }
    }
    return snapshot
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
      // 旧版本首次打开地图会留下 sources: [] 的空配置，同样按「从未预置过」补齐；
      // 补齐后写盘会带上 defaultSeeded 标记，用户以后删空来源不会再复活
      if (needsDefaultSource(parsed)) {
        parsed.sources = createInitialMapTileSources()
        migrated = true
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
      // 只在配置文件尚不存在时预置：用户把来源全部删空后不应再自动长回来
      const document: StoreDocument = { version: 1, sources: createInitialMapTileSources() }
      await this.writeDocument(document)
      return document
    }
  }

  private toStoredSource(source: MapTileSource, existing?: StoredMapTileSource): StoredMapTileSource {
    const {
      hasApiKey: _hasApiKey,
      clearApiKey,
      apiKey: rawApiKey,
      // 存储字段一律由本方法生成：解构丢弃，防止调用方传入的 storedApiKey 明文经 ...plain 原样落盘
      storedApiKey: _storedApiKey,
      encryptedApiKey: _inputEncryptedApiKey,
      ...plain
    } = source as MapTileSource & {
      apiKey?: unknown
      storedApiKey?: string
      encryptedApiKey?: string
    }
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
    // 任何一次落盘都视为「默认源已处理过」：用户主动删空来源后 readDocument 不会再补回来
    document.defaultSeeded = true
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
    // rename 返回时文档已经是内存里这一份，就地刷新快照：快照只有慢一拍才会继续发旧来源的瓦片。
    // 版本号同时告诉进行中的读盘「你读到的内容已经过期」
    this.snapshot = this.buildSnapshot(document.sources)
    this.writeRevision += 1
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return runConfigurationTransaction(() => {
      const result = this.operationQueue.then(operation)
      this.operationQueue = result.then(() => undefined, () => undefined)
      return result
    })
  }
}
