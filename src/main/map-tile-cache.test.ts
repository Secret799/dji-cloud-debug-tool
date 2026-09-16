import { describe, expect, it } from 'vitest'
import { MapTileCache } from './map-tile-cache'

const tile = (label: string) => ({ body: Buffer.from(label), contentType: 'image/png' })

describe('MapTileCache', () => {
  it('stores and returns a tile', () => {
    const cache = new MapTileCache(4, 1_024)
    cache.set('a', tile('a'))
    expect(cache.get('a')?.body.toString()).toBe('a')
    expect(cache.size).toBe(1)
  })

  it('evicts the least recently used entry beyond the count limit', () => {
    const cache = new MapTileCache(2, 1_024)
    cache.set('a', tile('a'))
    cache.set('b', tile('b'))
    cache.get('a')
    cache.set('c', tile('c'))
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBeDefined()
    expect(cache.get('c')).toBeDefined()
  })

  it('evicts entries beyond the byte budget', () => {
    const cache = new MapTileCache(100, 8)
    cache.set('a', { body: Buffer.alloc(6), contentType: 'image/png' })
    cache.set('b', { body: Buffer.alloc(6), contentType: 'image/png' })
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBeDefined()
  })

  it('refuses a tile larger than the whole budget without evicting resident entries', () => {
    const cache = new MapTileCache(100, 4)
    cache.set('small', { body: Buffer.alloc(2), contentType: 'image/png' })
    cache.set('big', { body: Buffer.alloc(5), contentType: 'image/png' })
    // 拒写单张超预算瓦片的意义在于保住已有条目：若放行，紧随其后的淘汰会把整张缓存冲空
    expect(cache.get('small')).toBeDefined()
    expect(cache.get('big')).toBeUndefined()
    expect(cache.size).toBe(1)
  })

  it('clears every entry', () => {
    const cache = new MapTileCache(4, 1_024)
    cache.set('a', tile('a'))
    cache.clear()
    expect(cache.size).toBe(0)
  })

  it('resets the byte accounting when cleared', () => {
    const cache = new MapTileCache(100, 8)
    cache.set('a', { body: Buffer.alloc(6), contentType: 'image/png' })
    cache.clear()
    // 清空后字节计数若未归零，新写入会带着旧账被立刻淘汰，整个缓存永久失效
    cache.set('b', { body: Buffer.alloc(6), contentType: 'image/png' })
    expect(cache.get('b')).toBeDefined()
    expect(cache.size).toBe(1)
  })

  it('accounts for the replaced entry when overwriting a key', () => {
    const cache = new MapTileCache(100, 8)
    cache.set('a', { body: Buffer.alloc(6), contentType: 'image/png' })
    // 同键改小：旧字节数必须扣掉，否则预算只增不减
    cache.set('a', { body: Buffer.alloc(2), contentType: 'image/png' })
    cache.set('b', { body: Buffer.alloc(5), contentType: 'image/png' })
    expect(cache.get('a')?.body.byteLength).toBe(2)
    expect(cache.get('b')).toBeDefined()
    expect(cache.size).toBe(2)
  })

  it('reports a miss for an unknown key', () => {
    expect(new MapTileCache(4, 1_024).get('missing')).toBeUndefined()
  })
})
