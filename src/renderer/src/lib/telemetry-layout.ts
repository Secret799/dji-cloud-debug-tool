import type {
  DeviceProvider,
  DeviceType,
  TelemetryDeviceLayout,
  TelemetryLayoutConfig,
  TelemetryLayoutField,
  TelemetryLayoutSection,
  TelemetryLayoutTab,
  TelemetrySectionKind,
} from '../../../shared/contracts'
import { parseTelemetryLayoutConfig } from '../../../shared/telemetry-layout'
import { DJI_AIRCRAFT_FIELDS, getDjiAircraftFieldMetadata } from './dji-aircraft-field-metadata'
import {
  buildDjiFieldMetadata,
  DJI_DOCK2_FIELDS,
  getDjiFieldMetadata,
  type DjiFieldMetadata,
  type DjiFieldRow,
} from './dji-field-metadata'
import { getDjiDock3FieldMetadata } from './dji-dock3-field-metadata'
import { FIELD_LABELS, type DeviceTelemetry } from './dji'
import { SUPERDOCK_FIELDS, getSuperDockFieldMetadata, getSuperDockFieldOverride } from './superdock-field-metadata'

const STORAGE_KEY = 'dji-cloud-studio.telemetry-layout.v1'

const hiddenTopLevelFields: Partial<Record<DeviceType, ReadonlySet<string>>> = {
  dock: new Set(['sub_device', 'drone_charge_state', 'drone_battery_maintenance_info', 'horizontal_speed', 'vertical_speed']),
  aircraft: new Set([
    'air_conditioner', 'alarm_state', 'backup_battery', 'cover_state', 'emergency_stop_state',
    'environment_temperature', 'humidity', 'putter_state', 'rainfall', 'supplement_light_state', 'temperature',
  ]),
}

const aircraftIdentityLabels: Record<string, string> = {
  device_sn: '设备 SN',
  device_model_key: '设备型号枚举',
  device_online_status: '开机状态',
  device_paired: '对频状态',
}

const defaultSectionNames = (deviceType: DeviceType): Record<Exclude<TelemetrySectionKind, 'custom'>, string> => {
  const aircraft = deviceType === 'aircraft'
  return {
    system: aircraft ? '飞行与运行状态' : '运行与任务状态',
    position: aircraft ? '位置、姿态与速度' : '位置与定位',
    safety: aircraft ? '飞行安全与限制' : '地理位置与备降',
    power: aircraft ? '电池与充电' : '供电与备用电池',
    environment: '环境数据',
    network: '网络与通信',
    equipment: aircraft ? '机载设备与存储' : '机场设备',
    maintenance: '保养信息',
    payload: '负载与云台',
    other: '其他字段',
  }
}

export const normalizeTelemetryFieldKey = (path: string): string => path
  .split('.')
  .filter((part) => !/^\d+$/.test(part))
  .join('.')

export const telemetrySectionKindForPath = (path: string, deviceType?: DeviceType): Exclude<TelemetrySectionKind, 'custom'> => {
  const value = path.toLowerCase()
  if (/(^|\.)alternate_land_point(\.|$)/.test(value)) return 'safety'
  if (deviceType === 'aircraft' && /(flysafe|area_limit|height_limit|distance_limit|rth_|rc_lost|obstacle_avoidance)/.test(value)) return 'safety'
  if (/(^|\.)maintain_status(\.|$)/.test(value)) return 'maintenance'
  if (/(camera|gimbal|payload|thermal|zoom|lens|photo|video|record)/.test(value)) return 'payload'
  if (/(^|\.)(flighttask_|drc_state|job_number|acc_time|activation_time|first_power_on|media_file_detail|mode_code|silent_mode|user_experience_improvement|gear|rid_state|rc_lost_action|track_id)/.test(value)) return 'system'
  if (/(network|signal|link|rssi|transmission|4g|sdr|lte|wifi)/.test(value)) return 'network'
  if (deviceType === 'aircraft' && /(^|\.)(wind_speed|wind_direction)$/.test(value)) return 'position'
  if (/(battery|charge|capacity|voltage|current|electric|power)/.test(value)) return 'power'
  if (/(temperature|humidity|wind|rain|environment|weather)/.test(value)) return 'environment'
  if (/(latitude|longitude|altitude|height|position|gps|satellite|velocity|speed|attitude|heading|home_|flight|distance_limit|area_limit|rth_)/.test(value)) return 'position'
  if (/(cover|air_conditioner|fan|drone_in_dock|dock|storage|emergency_stop|putter|supplement_light|obstacle_avoidance|alarm_state|night_lights)/.test(value)) return 'equipment'
  if (/(device|firmware|mode|online|activation|compatible|maintain|work_state|status)/.test(value)) return 'system'
  return 'other'
}

const defaultVisible = (key: string, deviceType: DeviceType): boolean =>
  !hiddenTopLevelFields[deviceType]?.has(key.split('.')[0])

const relayedAircraftMetadata = (key: string): DjiFieldMetadata | undefined => {
  if (aircraftIdentityLabels[key]) return getDjiFieldMetadata(`sub_device.${key}`)
  if (/^(drone_charge_state|drone_battery_maintenance_info)(\.|$)/.test(key)) return getDjiFieldMetadata(key)
  return undefined
}

export type TelemetryMetadataSource =
  | 'superdock'
  | 'dji-superdock'
  | 'dji-dock2'
  | 'dji-dock2-dock3'
  | 'dji-aircraft'
  | 'custom'
  | 'default'

export interface TelemetryFieldMetadataResolution {
  metadata?: DjiFieldMetadata
  source: TelemetryMetadataSource
}

const telemetryOfficialFieldMetadataResolution = (
  deviceType: DeviceType,
  path: string,
  provider?: DeviceProvider,
): TelemetryFieldMetadataResolution => {
  const key = normalizeTelemetryFieldKey(path)
  if (deviceType === 'dock') {
    const superDockMetadata = getSuperDockFieldOverride(key)
    const djiMetadata = getDjiFieldMetadata(key)
    if (provider === 'dji') {
      if (!djiMetadata) return { source: 'default' }
      return {
        metadata: djiMetadata,
        source: getDjiDock3FieldMetadata(key) ? 'dji-dock2-dock3' : 'dji-dock2',
      }
    }
    if (provider === 'superdock') {
      if (superDockMetadata) return { metadata: superDockMetadata, source: 'superdock' }
      const compatibleMetadata = getSuperDockFieldMetadata(key)
      return compatibleMetadata
        ? { metadata: compatibleMetadata, source: 'dji-superdock' }
        : { source: 'default' }
    }
    if (djiMetadata) {
      return {
        metadata: djiMetadata,
        source: superDockMetadata
          ? 'dji-superdock'
          : getDjiDock3FieldMetadata(key) ? 'dji-dock2-dock3' : 'dji-dock2',
      }
    }
    if (superDockMetadata) return { metadata: superDockMetadata, source: 'superdock' }
  }
  if (deviceType === 'aircraft') {
    const metadata = relayedAircraftMetadata(key) ?? getDjiAircraftFieldMetadata(key)
    if (metadata) return { metadata, source: 'dji-aircraft' }
  }
  return { source: 'default' }
}

export const telemetryOfficialFieldMetadata = (
  deviceType: DeviceType,
  path: string,
): DjiFieldMetadata | undefined => telemetryOfficialFieldMetadataResolution(deviceType, path).metadata

export const telemetryCustomPropertyMetadata = (
  field: TelemetryLayoutField | undefined,
): DjiFieldMetadata | undefined => {
  const setting = field?.propertySetting
  if (!field || !setting?.enabled) return undefined
  const row = [
    setting.path,
    field.label || field.key,
    setting.type,
    setting.constraint,
    field.description,
    'rw',
    '',
  ] satisfies DjiFieldRow
  return buildDjiFieldMetadata([row])[0]
}

export const resolveTelemetryFieldMetadata = (
  deviceType: DeviceType,
  path: string,
  field?: TelemetryLayoutField,
  provider?: DeviceProvider,
): TelemetryFieldMetadataResolution => {
  const official = telemetryOfficialFieldMetadataResolution(deviceType, path, provider)
  if (official.metadata) return official

  const custom = telemetryCustomPropertyMetadata(field)
  return custom ? { metadata: custom, source: 'custom' } : { source: 'default' }
}

export const telemetryFieldSupportsProvider = (
  deviceType: DeviceType,
  path: string,
  provider: DeviceProvider,
): boolean => {
  if (provider === 'superdock' && deviceType !== 'dock') return false
  if (provider === 'superdock' || deviceType !== 'dock') return true
  const key = normalizeTelemetryFieldKey(path)
  return Boolean(getDjiFieldMetadata(key)) || !getSuperDockFieldOverride(key)
}

export const telemetryBaseField = (
  deviceType: DeviceType,
  path: string,
): TelemetryLayoutField => {
  const key = normalizeTelemetryFieldKey(path)
  const leaf = key.split('.').at(-1) ?? key
  const metadata = telemetryOfficialFieldMetadata(deviceType, key)
  return {
    key,
    label: aircraftIdentityLabels[key] ?? metadata?.label ?? FIELD_LABELS[key]?.label ?? FIELD_LABELS[leaf]?.label ?? leaf,
    description: metadata?.description ?? '',
    visible: defaultVisible(key, deviceType),
  }
}

const section = (deviceType: DeviceType, kind: Exclude<TelemetrySectionKind, 'custom'>): TelemetryLayoutSection => ({
  id: kind,
  name: defaultSectionNames(deviceType)[kind],
  kind,
  fieldKeys: [],
})

const defaultTabs = (deviceType: DeviceType): TelemetryLayoutTab[] => [
  {
    id: 'operation',
    name: deviceType === 'aircraft' ? '飞行信息' : '运行信息',
    kind: 'operation',
    sections: [section(deviceType, 'system'), section(deviceType, 'position'), section(deviceType, 'safety')],
  },
  {
    id: 'device',
    name: '设备信息',
    kind: 'device',
    sections: [
      section(deviceType, 'power'),
      ...(deviceType === 'aircraft' ? [] : [section(deviceType, 'environment')]),
      section(deviceType, 'network'),
      section(deviceType, 'equipment'),
      section(deviceType, 'payload'),
    ],
  },
  { id: 'maintenance', name: '运维信息', kind: 'maintenance', sections: [section(deviceType, 'maintenance')] },
  { id: 'other', name: '其他信息', kind: 'other', sections: [section(deviceType, 'other')] },
]

const catalogPaths = (deviceType: DeviceType): string[] => {
  if (deviceType === 'dock') {
    return [...new Set([
      ...DJI_DOCK2_FIELDS.map((field) => field.path),
      ...SUPERDOCK_FIELDS.map((field) => field.path),
    ])]
  }
  if (deviceType === 'aircraft') {
    return [
      ...DJI_AIRCRAFT_FIELDS.map((field) => field.path),
      ...Object.keys(aircraftIdentityLabels),
      ...DJI_DOCK2_FIELDS
        .filter((field) => /^(drone_charge_state|drone_battery_maintenance_info)(\.|$)/.test(field.path))
        .map((field) => field.path),
    ]
  }
  return Object.keys(FIELD_LABELS)
}

const createDefaultDeviceLayout = (deviceType: DeviceType): TelemetryDeviceLayout => {
  const tabs = defaultTabs(deviceType)
  const fields: TelemetryLayoutField[] = []
  const seen = new Set<string>()
  catalogPaths(deviceType).forEach((path) => {
    const field = telemetryBaseField(deviceType, path)
    if (!field.key || seen.has(field.key)) return
    seen.add(field.key)
    fields.push(field)
    const kind = telemetrySectionKindForPath(field.key, deviceType)
    const target = tabs.flatMap((tab) => tab.sections).find((item) => item.kind === kind)
      ?? tabs.at(-1)?.sections[0]
    target?.fieldKeys.push(field.key)
  })
  return { tabs, fields }
}

export const createDefaultTelemetryLayout = (): TelemetryLayoutConfig => ({
  version: 1,
  updatedAt: Date.now(),
  devices: {
    dock: createDefaultDeviceLayout('dock'),
    aircraft: createDefaultDeviceLayout('aircraft'),
    pilot: createDefaultDeviceLayout('pilot'),
  },
})

const collectTelemetryKeys = (source: Record<string, unknown>, limit = 5_000): string[] => {
  const keys: string[] = []
  const seen = new Set<string>()
  const visit = (value: unknown, path: string): void => {
    if (keys.length >= limit) return
    if (Array.isArray(value)) {
      if (!value.length) {
        const key = normalizeTelemetryFieldKey(path)
        if (key && !seen.has(key)) { seen.add(key); keys.push(key) }
      } else value.forEach((item, index) => visit(item, `${path}.${index}`))
      return
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>)
      if (!entries.length) {
        const key = normalizeTelemetryFieldKey(path)
        if (key && !seen.has(key)) { seen.add(key); keys.push(key) }
      } else entries.forEach(([name, child]) => visit(child, path ? `${path}.${name}` : name))
      return
    }
    const key = normalizeTelemetryFieldKey(path)
    if (key && !seen.has(key)) { seen.add(key); keys.push(key) }
  }
  Object.entries(source).forEach(([key, value]) => visit(value, key))
  return keys
}

const cloneDeviceLayout = (layout: TelemetryDeviceLayout): TelemetryDeviceLayout => ({
  fields: layout.fields.map((field) => ({
    ...field,
    propertySetting: field.propertySetting ? { ...field.propertySetting } : undefined,
  })),
  tabs: layout.tabs.map((tab) => ({
    ...tab,
    sections: tab.sections.map((item) => ({ ...item, fieldKeys: [...item.fieldKeys] })),
  })),
})

export const reconcileTelemetryLayout = (
  config: TelemetryLayoutConfig,
  telemetry: DeviceTelemetry[],
): TelemetryLayoutConfig => {
  const missing = new Map<DeviceType, string[]>()
  const knownByType = new Map<DeviceType, Set<string>>([
    ['dock', new Set(config.devices.dock.fields.map((field) => field.key))],
    ['aircraft', new Set(config.devices.aircraft.fields.map((field) => field.key))],
    ['pilot', new Set(config.devices.pilot.fields.map((field) => field.key))],
  ])
  ;(['dock', 'aircraft', 'pilot'] as const).forEach((deviceType) => {
    const known = knownByType.get(deviceType) as Set<string>
    catalogPaths(deviceType).forEach((path) => {
      const key = normalizeTelemetryFieldKey(path)
      if (!key || known.has(key)) return
      known.add(key)
      const values = missing.get(deviceType) ?? []
      values.push(key)
      missing.set(deviceType, values)
    })
  })
  telemetry.forEach((device) => {
    const known = knownByType.get(device.type) as Set<string>
    const keys = collectTelemetryKeys({ ...device.osd, ...device.state })
    keys.forEach((key) => {
      if (known.has(key)) return
      known.add(key)
      const values = missing.get(device.type) ?? []
      values.push(key)
      missing.set(device.type, values)
    })
  })
  if (!missing.size) return config

  const devices = {
    dock: cloneDeviceLayout(config.devices.dock),
    aircraft: cloneDeviceLayout(config.devices.aircraft),
    pilot: cloneDeviceLayout(config.devices.pilot),
  }
  missing.forEach((keys, deviceType) => {
    const layout = devices[deviceType]
    keys.forEach((key) => {
      const field = telemetryBaseField(deviceType, key)
      layout.fields.push(field)
      const kind = telemetrySectionKindForPath(key, deviceType)
      const target = layout.tabs.flatMap((tab) => tab.sections).find((item) => item.kind === kind)
        ?? layout.tabs.at(-1)?.sections[0]
      target?.fieldKeys.push(field.key)
    })
  })
  return { ...config, updatedAt: Date.now(), devices }
}

export const loadTelemetryLayout = (): TelemetryLayoutConfig => {
  if (typeof window === 'undefined') return createDefaultTelemetryLayout()
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return stored ? parseTelemetryLayoutConfig(JSON.parse(stored) as unknown) : createDefaultTelemetryLayout()
  } catch {
    return createDefaultTelemetryLayout()
  }
}

export const saveTelemetryLayout = (config: TelemetryLayoutConfig): void => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
}

export const updateTelemetryLayoutTimestamp = (config: TelemetryLayoutConfig): TelemetryLayoutConfig => ({
  ...config,
  updatedAt: Date.now(),
})

export const findTelemetryField = (
  layout: TelemetryDeviceLayout,
  path: string,
): TelemetryLayoutField | undefined => {
  const key = normalizeTelemetryFieldKey(path)
  return layout.fields.find((field) => field.key === key)
}
