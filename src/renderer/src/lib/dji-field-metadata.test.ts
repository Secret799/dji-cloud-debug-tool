import { describe, expect, it } from 'vitest'
import {
  DJI_DOCK2_FIELDS,
  djiAccessModeLabel,
  djiPushModeLabel,
  formatDjiFieldValue,
  getDjiFieldMetadata,
} from './dji-field-metadata'

describe('DJI Dock 2 field metadata', () => {
  it('contains the complete official property table', () => {
    expect(DJI_DOCK2_FIELDS).toHaveLength(144)
    expect(new Set(DJI_DOCK2_FIELDS.map((metadata) => metadata.path)).size).toBe(144)
  })

  it('resolves full nested paths and inherits parent modes', () => {
    const rate = getDjiFieldMetadata('network_state.rate')

    expect(rate).toMatchObject({
      label: '网络速率',
      type: 'float',
      unit: 'KB/s',
      accessMode: 'r',
      pushMode: '0',
    })
    expect(djiAccessModeLabel(rate?.accessMode)).toBe('只读')
    expect(djiPushModeLabel(rate?.pushMode)).toBe('OSD 定频上报（0.5 Hz）')
    expect(formatDjiFieldValue(12.5, rate)).toBe('12.5 KB/s')
  })

  it('keeps same-name nested fields scoped to their documented path', () => {
    expect(getDjiFieldMetadata('backup_battery.temperature')?.label).toBe('备用电池温度')
    expect(getDjiFieldMetadata('drone_battery_maintenance_info.batteries.temperature')?.label).toBe('温度')
    expect(getDjiFieldMetadata('drone_battery_maintenance_info.batteries.0.temperature')?.label).toBe('温度')
    expect(getDjiFieldMetadata('custom.cover_state')).toBeUndefined()
    expect(getDjiFieldMetadata('unknown.temperature')).toBeUndefined()
  })

  it('formats enum and boolean values with official meanings', () => {
    const cover = getDjiFieldMetadata('cover_state')
    const transfer = getDjiFieldMetadata('air_transfer_enable')

    expect(formatDjiFieldValue(1, cover)).toBe('打开 (1)')
    expect(formatDjiFieldValue(false, transfer)).toBe('关闭 (false)')
    expect(formatDjiFieldValue(99, cover)).toBe('未知枚举值 (99)')
  })

  it('marks documented unavailable sentinels as invalid values', () => {
    const capacity = getDjiFieldMetadata('drone_battery_maintenance_info.batteries.0.capacity_percent')

    expect(capacity?.unit).toBe('%')
    expect(capacity?.invalidValues).toContain('32767')
    expect(formatDjiFieldValue(32767, capacity)).toBe('无效值 (32767)')
  })

  it('tolerates malformed constraint JSON in the source document', () => {
    const airConditioner = getDjiFieldMetadata('air_conditioner.air_conditioner_state')

    expect(Object.keys(airConditioner?.enumValues ?? {})).toHaveLength(16)
    expect(airConditioner?.enumValues?.['9']).toBe('除湿准备模式')
    expect(airConditioner?.enumValues?.['10']).toBe('风冷准备中')
    expect(airConditioner?.enumValues?.['12']).toBe('风冷退出中')
    expect(airConditioner?.enumValues?.['14']).toBe('除雾中')
    expect(airConditioner?.enumValues?.['15']).toBe('除雾退出中')
  })
})
