import { describe, expect, it } from 'vitest'
import { parseTelemetryLayoutConfig } from '../../../shared/telemetry-layout'
import type { DeviceTelemetry } from './dji'
import {
  createDefaultTelemetryLayout,
  normalizeTelemetryFieldKey,
  reconcileTelemetryLayout,
  resolveTelemetryFieldMetadata,
  telemetryFieldSupportsProvider,
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

  it('includes every SuperDock field in the dock catalog exactly once', () => {
    const fields = createDefaultTelemetryLayout().devices.dock.fields
    const paths = [
      'air_transfer_enable',
      'cloud_transfer_enable',
      'soft_emergency_stop_state',
      'drone_rtcm_info',
      'drone_rtcm_info.mount_point',
      'drone_rtcm_info.port',
      'drone_rtcm_info.host',
      'drone_rtcm_info.rtcm_device_type',
      'drone_rtcm_info.source_type',
      'dongle_infos.sim_phone_area_code',
      'dongle_infos.sim_phone_number',
      'dongle_infos.sim_remaining_time',
      'dongle_infos.sim_last_authenticated_time',
      'dongle_infos.sim_is_authentication_available',
      'dongle_infos.sim_link_workmode',
    ]

    paths.forEach((path) => {
      expect(fields.filter((field) => field.key === path), path).toHaveLength(1)
    })
    expect(fields.find((field) => field.key === 'air_transfer_enable')?.label).toBe('空中回传')
    expect(fields.find((field) => field.key === 'cloud_transfer_enable')?.label).toBe('空中回传（机场到云端）')
  })

  it('identifies SuperDock, DJI, custom and default metadata sources', () => {
    expect(resolveTelemetryFieldMetadata('dock', 'cloud_transfer_enable').source).toBe('superdock')
    expect(resolveTelemetryFieldMetadata('dock', 'air_transfer_enable')).toMatchObject({
      source: 'dji-superdock',
      metadata: { label: '空中回传' },
    })
    expect(resolveTelemetryFieldMetadata('dock', 'cover_state').source).toBe('dji-dock2')
    expect(resolveTelemetryFieldMetadata('dock', 'silent_mode').source).toBe('dji-dock2-dock3')
    expect(resolveTelemetryFieldMetadata('aircraft', 'rth_altitude').source).toBe('dji-aircraft')
    expect(resolveTelemetryFieldMetadata('pilot', 'unknown_field').source).toBe('default')
    expect(resolveTelemetryFieldMetadata('pilot', 'custom_level', {
      key: 'custom_level',
      label: '自定义等级',
      description: '',
      visible: true,
      propertySetting: {
        enabled: true,
        path: 'custom_control.level',
        type: 'int',
        constraint: '{"min":0,"max":10}',
      },
    })).toMatchObject({ source: 'custom', metadata: { path: 'custom_control.level', accessMode: 'rw' } })
  })

  it('resolves dock metadata for the selected brand', () => {
    expect(resolveTelemetryFieldMetadata('dock', 'air_transfer_enable', undefined, 'dji')).toMatchObject({
      source: 'dji-dock2-dock3',
      metadata: { label: '空中回传' },
    })
    expect(resolveTelemetryFieldMetadata('dock', 'air_transfer_enable', undefined, 'superdock')).toMatchObject({
      source: 'superdock',
      metadata: { label: '空中回传（无人机到机场）' },
    })
    expect(telemetryFieldSupportsProvider('dock', 'cloud_transfer_enable', 'dji')).toBe(false)
    expect(telemetryFieldSupportsProvider('dock', 'cloud_transfer_enable', 'superdock')).toBe(true)
    expect(telemetryFieldSupportsProvider('aircraft', 'rth_altitude', 'superdock')).toBe(false)
  })

  it('upgrades a legacy layout without replacing user configuration', () => {
    const legacy = createDefaultTelemetryLayout()
    const superDockOnlyKeys = new Set([
      'cloud_transfer_enable',
      'soft_emergency_stop_state',
      'drone_rtcm_info',
      'drone_rtcm_info.mount_point',
      'drone_rtcm_info.port',
      'drone_rtcm_info.host',
      'drone_rtcm_info.rtcm_device_type',
      'drone_rtcm_info.source_type',
      'dongle_infos.sim_phone_area_code',
      'dongle_infos.sim_phone_number',
      'dongle_infos.sim_remaining_time',
      'dongle_infos.sim_last_authenticated_time',
      'dongle_infos.sim_is_authentication_available',
      'dongle_infos.sim_link_workmode',
    ])
    legacy.devices.dock.fields = legacy.devices.dock.fields.filter((field) => !superDockOnlyKeys.has(field.key))
    legacy.devices.dock.tabs.forEach((tab) => tab.sections.forEach((section) => {
      section.fieldKeys = section.fieldKeys.filter((key) => !superDockOnlyKeys.has(key))
    }))
    const customField = {
      key: 'legacy_custom',
      label: '旧版自定义名称',
      description: '保留用户描述',
      visible: false,
      propertySetting: {
        enabled: true,
        path: 'custom_control.legacy',
        type: 'int' as const,
        constraint: '{"min":0}',
      },
    }
    legacy.devices.dock.fields.push(customField)
    legacy.devices.dock.tabs[0].name = '用户页签'
    legacy.devices.dock.tabs[0].sections[0].fieldKeys.push(customField.key)

    const reconciled = reconcileTelemetryLayout(legacy, [])

    expect(reconciled.devices.dock.fields.find((field) => field.key === customField.key)).toEqual(customField)
    expect(reconciled.devices.dock.tabs[0].name).toBe('用户页签')
    expect(reconciled.devices.dock.tabs[0].sections[0].fieldKeys).toContain(customField.key)
    superDockOnlyKeys.forEach((key) => {
      expect(reconciled.devices.dock.fields.filter((field) => field.key === key), key).toHaveLength(1)
    })
    expect(reconcileTelemetryLayout(reconciled, [])).toBe(reconciled)
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

  it('preserves a supported formatter and rejects unknown formatter names', () => {
    const config = createDefaultTelemetryLayout()
    config.devices.pilot.fields[0].formatter = 'datetime'

    expect(parseTelemetryLayoutConfig(config).devices.pilot.fields[0].formatter).toBe('datetime')

    const invalid = structuredClone(config) as unknown as {
      devices: { pilot: { fields: Array<{ formatter?: string }> } }
    }
    invalid.devices.pilot.fields[0].formatter = 'javascript'
    expect(() => parseTelemetryLayoutConfig(invalid)).toThrow('数据格式化函数无效')
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
