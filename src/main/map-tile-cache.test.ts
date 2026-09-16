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

  it('refuses a tile larger than the whole budget', () => {
    const cache = new MapTileCache(100, 4)
    cache.set('big', { body: Buffer.alloc(5), contentType: 'image/png' })
    expect(cache.size).toBe(0)
  })

  it('clears every entry', () => {
    const cache = new MapTileCache(4, 1_024)
    cache.set('a', tile('a'))
    cache.clear()
    expect(cache.size).toBe(0)
  })

  it('reports a miss for an unknown key', () => {
    expect(new MapTileCache(4, 1_024).get('missing')).toBeUndefined()
  })
})
