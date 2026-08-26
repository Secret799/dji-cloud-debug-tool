import { describe, expect, it } from 'vitest'
import { parseTelemetryLayoutConfig } from '../../../shared/telemetry-layout'
import type { DeviceTelemetry } from './dji'
import {
  createDefaultTelemetryLayout,
  normalizeTelemetryFieldKey,
  reconcileTelemetryLayout,
} from './telemetry-layout'

describe('telemetry layout configuration', () => {
  it('creates a valid default layout with unique field assignments', () => {
    const config = parseTelemetryLayoutConfig(createDefaultTelemetryLayout())

    for (const layout of Object.values(config.devices)) {
      const assignments = layout.tabs.flatMap((tab) => tab.sections.flatMap((section) => section.fieldKeys))
      expect(new Set(assignments).size).toBe(assignments.length)
      expect(layout.tabs.length).toBeGreaterThan(0)
      expect(layout.fields.length).toBeGreaterThan(0)
    }
  })

  it('normalizes array indexes and adds new runtime fields only once', () => {
    const initial = createDefaultTelemetryLayout()
    const telemetry = [{
      profileId: 'profile', sn: 'AIR-1', type: 'aircraft', name: 'Aircraft', online: true,
      lastSeenAt: 1, lastTopic: 'thing/product/AIR-1/osd', status: {}, state: {},
      osd: { custom_metrics: [{ signal_value: 1 }, { signal_value: 2 }] },
    }] satisfies DeviceTelemetry[]

    const reconciled = reconcileTelemetryLayout(initial, telemetry)
    const key = normalizeTelemetryFieldKey('custom_metrics.0.signal_value')
    expect(key).toBe('custom_metrics.signal_value')
    expect(reconciled.devices.aircraft.fields.filter((field) => field.key === key)).toHaveLength(1)
    expect(reconcileTelemetryLayout(reconciled, telemetry)).toBe(reconciled)
  })

  it('rejects duplicate field assignments during import', () => {
    const config = createDefaultTelemetryLayout()
    const section = config.devices.dock.tabs[0].sections[0]
    section.fieldKeys.push(section.fieldKeys[0])
    expect(() => parseTelemetryLayoutConfig(config)).toThrow('不能重复')
  })

  it('preserves optional custom property setting metadata during import', () => {
    const config = createDefaultTelemetryLayout()
    const field = config.devices.pilot.fields[0]
    field.propertySetting = {
      enabled: true,
      path: 'custom_control.level',
      type: 'enum_int',
      constraint: '{"0":"关闭","1":"开启"}',
    }

    const parsed = parseTelemetryLayoutConfig(config)
    expect(parsed.devices.pilot.fields[0].propertySetting).toEqual(field.propertySetting)
  })

  it('rejects unsafe array indexes in custom property paths', () => {
    const config = createDefaultTelemetryLayout()
    config.devices.pilot.fields[0].propertySetting = {
      enabled: true,
      path: 'custom_control.0.level',
      type: 'int',
      constraint: '',
    }

    expect(() => parseTelemetryLayoutConfig(config)).toThrow('不能包含空层级或数组索引')
  })
})
