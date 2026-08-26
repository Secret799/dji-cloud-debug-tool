import { describe, expect, it } from 'vitest'
import { getDjiAircraftFieldMetadata } from './dji-aircraft-field-metadata'
import { getDjiDock3FieldMetadata } from './dji-dock3-field-metadata'
import {
  buildDjiPropertyData,
  buildDjiPropertyPayload,
  djiPropertyReplyResult,
  parseDjiPropertyValue,
} from './dji-property-set'

describe('DJI property setting', () => {
  it('parses booleans, enums and constrained numbers using field metadata', () => {
    const transfer = getDjiDock3FieldMetadata('air_transfer_enable')
    const lostAction = getDjiAircraftFieldMetadata('rc_lost_action')
    const heightLimit = getDjiAircraftFieldMetadata('height_limit')
    if (!transfer || !lostAction || !heightLimit) throw new Error('Missing property metadata')

    expect(parseDjiPropertyValue('true', transfer)).toBe(true)
    expect(parseDjiPropertyValue('2', lostAction)).toBe(2)
    expect(parseDjiPropertyValue('120', heightLimit)).toBe(120)
    expect(() => parseDjiPropertyValue('12', lostAction)).toThrow('文档支持的枚举值')
    expect(() => parseDjiPropertyValue('2000', heightLimit)).toThrow('不能大于 1500')
  })

  it('requires custom enum fields to define an option map', () => {
    const metadata = {
      path: 'custom_mode', field: 'custom_mode', label: '自定义模式', type: 'enum_int', accessMode: 'rw',
    }
    expect(() => parseDjiPropertyValue('1', metadata)).toThrow('未配置有效的枚举约束')
  })

  it('builds nested data and a complete property/set envelope', () => {
    expect(buildDjiPropertyData('distance_limit_status.state', 1)).toEqual({
      distance_limit_status: { state: 1 },
    })
    expect(JSON.parse(buildDjiPropertyPayload(
      'distance_limit_status.state',
      1,
      'tid-1',
      'bid-1',
      123,
    ))).toEqual({
      bid: 'bid-1',
      data: { distance_limit_status: { state: 1 } },
      tid: 'tid-1',
      timestamp: 123,
    })
  })

  it('reads the result for the exact property path', () => {
    const payload = JSON.stringify({
      data: { distance_limit_status: { state: { result: 0 } } },
    })
    expect(djiPropertyReplyResult(payload, 'distance_limit_status.state')).toBe(0)
    expect(djiPropertyReplyResult(payload, 'distance_limit_status.distance_limit')).toBeUndefined()
  })
})
