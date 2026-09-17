import { describe, expect, it } from 'vitest'
import type { MapTileSource } from '../../../shared/contracts'
import { createTerrainSource, isTerrainKind, TERRAIN_PRESETS, terrainSourceIssues } from './terrain-source'

const terrainFixture = (patch: Partial<MapTileSource> = {}): MapTileSource => ({
  ...createTerrainSource('terrain-ion'),
  ...patch,
})

describe('isTerrainKind', () => {
  it.each(['terrain-ion', 'terrain-arcgis', 'terrain-url'] as const)('accepts %s', (kind) => {
    expect(isTerrainKind(kind)).toBe(true)
  })

  it.each(['url-template', 'directory', 'mbtiles'] as const)('rejects %s', (kind) => {
    expect(isTerrainKind(kind)).toBe(false)
  })
})

describe('createTerrainSource', () => {
  it('creates a terrain-ion source on the terrain layer with no url', () => {
    const source = createTerrainSource('terrain-ion')
    expect(source.layer).toBe('terrain')
    expect(source.kind).toBe('terrain-ion')
    expect(source.urlTemplate).toBe('')
    expect(source.id).toBe('')
  })

  it('keeps the terrain layer for terrain-url', () => {
    expect(createTerrainSource('terrain-url').kind).toBe('terrain-url')
  })

  it('mirrors the imagery draft defaults for the fields terrain shares', () => {
    const source = createTerrainSource('terrain-arcgis')
    expect(source.path).toBe('')
    expect(source.headers).toEqual([])
    expect(source.coordinateSystem).toBe('wgs84')
    expect(source.minZoom).toBe(0)
    expect(source.maxZoom).toBe(19)
    expect(source.tileSize).toBe(256)
    expect(source.attribution).toBe('')
    expect(source.createdAt).toBeGreaterThan(0)
    expect(source.updatedAt).toBeGreaterThan(0)
  })
})

describe('terrainSourceIssues', () => {
  it('reports no issues for an ion source without a url', () => {
    expect(terrainSourceIssues(terrainFixture())).toEqual([])
  })

  it('reports no issues for an arcgis source without a url', () => {
    expect(terrainSourceIssues(terrainFixture({ kind: 'terrain-arcgis' }))).toEqual([])
  })

  it('requires terrain-url to carry a url', () => {
    expect(terrainSourceIssues(terrainFixture({ kind: 'terrain-url' }))).toContain('请填写地形服务地址')
  })

  it('rejects a non-http terrain url', () => {
    expect(terrainSourceIssues(terrainFixture({ kind: 'terrain-url', urlTemplate: 'ftp://x/' })))
      .toContain('地形服务地址仅支持 HTTP 或 HTTPS')
  })

  it('accepts an https terrain url', () => {
    expect(terrainSourceIssues(terrainFixture({ kind: 'terrain-url', urlTemplate: 'https://x/terrain' }))).toEqual([])
  })
})

describe('TERRAIN_PRESETS', () => {
  it('offers ion and arcgis presets that both need a token', () => {
    expect(TERRAIN_PRESETS).toHaveLength(2)
    expect(TERRAIN_PRESETS.every((preset) => preset.requiresToken)).toBe(true)
    expect(TERRAIN_PRESETS.some((preset) => preset.help.includes('cesium.com/ion'))).toBe(true)
    expect(TERRAIN_PRESETS.some((preset) => preset.help.includes('developers.arcgis.com'))).toBe(true)
  })

  it('keeps every preset on the terrain layer', () => {
    expect(TERRAIN_PRESETS.every((preset) => isTerrainKind(preset.kind))).toBe(true)
  })
})
