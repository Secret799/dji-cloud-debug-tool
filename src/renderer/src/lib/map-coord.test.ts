import { describe, expect, it } from 'vitest'
import { gcj02ToBd09, isInsideChina, toCoordinateSystem, wgs84ToGcj02 } from './map-coord'

// 北京天安门一带的 WGS-84 坐标
const beijing = { latitude: 39.90869, longitude: 116.39740 }
// 东京塔一带的 WGS-84 坐标，位于国境判定范围之外
const tokyo = { latitude: 35.65861, longitude: 139.74556 }

describe('map coordinate conversion', () => {
  it('leaves coordinates outside China untouched', () => {
    expect(wgs84ToGcj02(tokyo)).toEqual(tokyo)
    expect(wgs84ToGcj02({ latitude: 51.5074, longitude: -0.1278 })).toEqual({ latitude: 51.5074, longitude: -0.1278 })
  })

  it('shifts Beijing coordinates by the known GCJ-02 offset', () => {
    const shifted = wgs84ToGcj02(beijing)
    // GCJ-02 相对 WGS-84 在北京的偏移量约为 +0.0014 纬度、+0.0062 经度
    expect(shifted.latitude - beijing.latitude).toBeGreaterThan(0.0010)
    expect(shifted.latitude - beijing.latitude).toBeLessThan(0.0018)
    expect(shifted.longitude - beijing.longitude).toBeGreaterThan(0.0055)
    expect(shifted.longitude - beijing.longitude).toBeLessThan(0.0070)
  })

  it('detects the China boundary used to gate the offset', () => {
    expect(isInsideChina(beijing.latitude, beijing.longitude)).toBe(true)
    expect(isInsideChina(tokyo.latitude, tokyo.longitude)).toBe(false)
    expect(isInsideChina(0.8293, 100)).toBe(true)
    expect(isInsideChina(0.8292, 100)).toBe(false)
    expect(isInsideChina(30, 72.004)).toBe(true)
    expect(isInsideChina(30, 72.003)).toBe(false)
  })

  it('shifts BD-09 by the known offset from GCJ-02', () => {
    const gcj = wgs84ToGcj02(beijing)
    const bd = gcj02ToBd09(gcj)
    // BD-09 相对 GCJ-02 再叠加约 +0.006 纬度、+0.0065 经度
    expect(bd.latitude - gcj.latitude).toBeGreaterThan(0.0055)
    expect(bd.latitude - gcj.latitude).toBeLessThan(0.0065)
    expect(bd.longitude - gcj.longitude).toBeGreaterThan(0.0060)
    expect(bd.longitude - gcj.longitude).toBeLessThan(0.0070)
  })

  it('returns the input unchanged for the wgs84 target system', () => {
    expect(toCoordinateSystem(beijing, 'wgs84')).toEqual(beijing)
  })

  it('routes gcj02 directly and bd09 through gcj02', () => {
    const gcj = toCoordinateSystem(beijing, 'gcj02')
    expect(gcj).toEqual(wgs84ToGcj02(beijing))
    expect(toCoordinateSystem(beijing, 'bd09')).toEqual(gcj02ToBd09(gcj))
  })

  it('is deterministic across repeated calls', () => {
    expect(wgs84ToGcj02(beijing)).toEqual(wgs84ToGcj02(beijing))
  })
})
