import type { ResolvedTile } from './map-tile-resolver'

/**
 * 瓦片内存缓存，按最近最少使用淘汰。
 *
 * 瓦片是只读静态资源，容量上限按条数与总字节双约束，避免大尺寸瓦片源撑爆内存。
 */
export class MapTileCache {
  private readonly entries = new Map<string, ResolvedTile>()
  private totalBytes = 0

  /**
   * @param maxEntries 最多缓存的瓦片条数
   * @param maxBytes 最多缓存的总字节数
   */
  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
  ) {}

  /**
   * 当前缓存的瓦片条数。
   *
   * @returns 瓦片条数
   */
  get size(): number {
    return this.entries.size
  }

  /**
   * 读取瓦片，命中时刷新其最近使用顺序。
   *
   * @param key 缓存键，由来源标识与 z/x/y 组成
   * @returns 命中的瓦片；未命中时为 undefined
   */
  get(key: string): ResolvedTile | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    // 重新插入以反映最近使用顺序
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry
  }

  /**
   * 写入瓦片，超出条数或字节上限时淘汰最久未使用的条目。
   *
   * @param key 缓存键，由来源标识与 z/x/y 组成
   * @param tile 瓦片字节与内容类型
   */
  set(key: string, tile: ResolvedTile): void {
    // 单张瓦片比整个预算还大时直接放弃缓存，否则会被立刻淘汰又反复写入
    if (tile.body.byteLength > this.maxBytes) return
    const existing = this.entries.get(key)
    if (existing) {
      this.totalBytes -= existing.body.byteLength
      this.entries.delete(key)
    }
    this.entries.set(key, tile)
    this.totalBytes += tile.body.byteLength
    this.evict()
  }

  /**
   * 清空全部缓存。
   */
  clear(): void {
    this.entries.clear()
    this.totalBytes = 0
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value
      if (oldestKey === undefined) return
      const oldest = this.entries.get(oldestKey)
      if (oldest) this.totalBytes -= oldest.body.byteLength
      this.entries.delete(oldestKey)
    }
  }
}
