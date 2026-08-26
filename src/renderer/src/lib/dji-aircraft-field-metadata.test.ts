import { describe, expect, it } from 'vitest'
import { formatDjiFieldValue } from './dji-field-metadata'
import {
  DJI_AIRCRAFT_FIELDS,
  getDjiAircraftFieldMetadata,
} from './dji-aircraft-field-metadata'

describe('DJI aircraft field metadata', () => {
  it('provides descriptions for the common aircraft telemetry table', () => {
    expect(DJI_AIRCRAFT_FIELDS.length).toBeGreaterThan(100)
    expect(DJI_AIRCRAFT_FIELDS.every((metadata) => Boolean(metadata.description))).toBe(true)
    expect(new Set(DJI_AIRCRAFT_FIELDS.map((metadata) => metadata.path)).size).toBe(DJI_AIRCRAFT_FIELDS.length)
  })

  it('resolves position fields with labels, units and descriptions', () => {
    const latitude = getDjiAircraftFieldMetadata('latitude')
    const speed = getDjiAircraftFieldMetadata('horizontal_speed')

    expect(latitude).toMatchObject({
      label: '当前位置纬度',
      unit: '°',
      description: '飞行器当前位置的纬度坐标。',
    })
    expect(speed?.description).toContain('水平方向')
    expect(formatDjiFieldValue(6.5, speed)).toBe('6.5 m/s')
  })

  it('normalizes array indexes for battery and camera fields', () => {
    expect(getDjiAircraftFieldMetadata('battery.batteries.0.temperature')).toMatchObject({
      label: '电池温度',
      unit: '°C',
    })
    expect(getDjiAircraftFieldMetadata('cameras.2.recording_state')?.label).toBe('录像状态')
  })

  it('formats documented flight state and safety enums', () => {
    expect(formatDjiFieldValue(9, getDjiAircraftFieldMetadata('mode_code'))).toBe('自动返航 (9)')
    expect(formatDjiFieldValue(1, getDjiAircraftFieldMetadata('is_near_area_limit'))).toBe('接近限飞区 (1)')
  })
})
