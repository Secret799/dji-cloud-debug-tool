import { describe, expect, it } from 'vitest'
import { formatTelemetryValue, rawTelemetryValue, telemetryFormatterRecommendations } from './telemetry-format'

describe('telemetry value formatting', () => {
  it('formats second and millisecond timestamps as local dates', () => {
    const milliseconds = 1_700_000_000_000
    const expected = new Date(milliseconds).toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    })

    expect(formatTelemetryValue(milliseconds, 'datetime')).toBe(expected)
    expect(formatTelemetryValue(milliseconds / 1_000, 'datetime')).toBe(expected)
  })

  it('formats numbers, percentages, JSON and text', () => {
    expect(formatTelemetryValue(12345.678, 'number')).toBe('12,345.678')
    expect(formatTelemetryValue(12, 'fixed_2')).toBe('12.00')
    expect(formatTelemetryValue(0.2567, 'percent')).toBe('25.67%')
    expect(formatTelemetryValue('{"enabled":true}', 'json')).toBe('{\n  "enabled": true\n}')
    expect(formatTelemetryValue('Dock-1', 'uppercase')).toBe('DOCK-1')
  })

  it('converts seconds and meters into readable units', () => {
    expect(formatTelemetryValue(90, 'seconds_to_minutes')).toBe('1.5 分钟')
    expect(formatTelemetryValue(7_200, 'seconds_to_hours')).toBe('2 小时')
    expect(formatTelemetryValue(3_661.5, 'seconds_to_duration')).toBe('1 时 1 分 1.5 秒')
    expect(formatTelemetryValue(-65, 'seconds_to_duration')).toBe('负 0 时 1 分 5 秒')
    expect(formatTelemetryValue(1_234, 'meters_to_kilometers')).toBe('1.234 千米')
  })

  it('converts kilobytes and recommends formatters from exact units', () => {
    expect(formatTelemetryValue(2_048, 'kilobytes_to_megabytes')).toBe('2 MB')
    expect(formatTelemetryValue(2_097_152, 'kilobytes_to_gigabytes')).toBe('2 GB')
    expect(telemetryFormatterRecommendations('KB', 'storage.total', 'int')).toEqual([
      'kilobytes_to_megabytes', 'kilobytes_to_gigabytes',
    ])
    expect(telemetryFormatterRecommendations('KB/s', 'network_state.rate', 'float')).toEqual([])
    expect(telemetryFormatterRecommendations('s', 'activation_time', 'int')[0]).toBe('datetime')
    expect(telemetryFormatterRecommendations('s', 'acc_time', 'int')[0]).toBe('seconds_to_duration')
  })

  it('falls back to the raw value when input cannot be formatted', () => {
    expect(formatTelemetryValue('not-a-date', 'datetime')).toBe('not-a-date')
    expect(formatTelemetryValue('not-a-number', 'fixed_2')).toBe('not-a-number')
    expect(formatTelemetryValue('not-a-number', 'seconds_to_hours')).toBe('not-a-number')
    expect(rawTelemetryValue({ value: 1 })).toBe('{"value":1}')
  })
})
