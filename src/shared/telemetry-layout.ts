import type {
  DeviceType,
  TelemetryDeviceLayout,
  TelemetryLayoutConfig,
  TelemetryLayoutField,
  TelemetryLayoutSection,
  TelemetryLayoutTab,
  TelemetryPropertySetting,
  TelemetryPropertyValueType,
  TelemetrySectionKind,
  TelemetryTabKind,
} from './contracts'

const DEVICE_TYPES: DeviceType[] = ['dock', 'aircraft', 'pilot']
const TAB_KINDS = new Set<TelemetryTabKind>(['operation', 'device', 'maintenance', 'other', 'custom'])
const SECTION_KINDS = new Set<TelemetrySectionKind>([
  'system', 'power', 'environment', 'position', 'safety', 'network',
  'payload', 'equipment', 'maintenance', 'other', 'custom',
])
const PROPERTY_VALUE_TYPES = new Set<TelemetryPropertyValueType>([
  'bool', 'enum_int', 'int', 'float', 'double', 'text', 'enum_string', 'date', 'struct', 'array',
])
const MAX_TABS = 50
const MAX_SECTIONS_PER_TAB = 50
const MAX_FIELDS = 5_000
const MAX_NAME_LENGTH = 80
const MAX_KEY_LENGTH = 512
const MAX_DESCRIPTION_LENGTH = 4_000
const MAX_CONSTRAINT_LENGTH = 4_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error(`${label}格式无效`)
  return value
}

const array = (value: unknown, label: string, max: number): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`)
  if (value.length > max) throw new Error(`${label}数量不能超过 ${max}`)
  return value
}

const text = (value: unknown, label: string, max: number, allowEmpty = false): string => {
  if (typeof value !== 'string') throw new Error(`${label}必须是字符串`)
  const normalized = value.trim()
  if (!allowEmpty && !normalized) throw new Error(`${label}不能为空`)
  if (value.length > max) throw new Error(`${label}过长`)
  if (value.includes('\0')) throw new Error(`${label}不能包含空字符`)
  return allowEmpty ? value : normalized
}

const unique = (values: string[], label: string): void => {
  if (new Set(values).size !== values.length) throw new Error(`${label}不能重复`)
}

const parsePropertySetting = (value: unknown, label: string): TelemetryPropertySetting | undefined => {
  if (value === undefined) return undefined
  const setting = record(value, label)
  if (typeof setting.enabled !== 'boolean') throw new Error(`${label}启用状态无效`)
  if (!PROPERTY_VALUE_TYPES.has(setting.type as TelemetryPropertyValueType)) throw new Error(`${label}数据类型无效`)
  const path = text(setting.path, `${label}下发路径`, MAX_KEY_LENGTH)
  if (path.split('.').some((segment) => !segment || segment.trim() !== segment || /^\d+$/.test(segment))) {
    throw new Error(`${label}下发路径不能包含空层级或数组索引`)
  }
  return {
    enabled: setting.enabled,
    path,
    type: setting.type as TelemetryPropertyValueType,
    constraint: text(setting.constraint, `${label}约束`, MAX_CONSTRAINT_LENGTH, true),
  }
}

const parseField = (value: unknown, index: number): TelemetryLayoutField => {
  const field = record(value, `字段 ${index + 1}`)
  if (typeof field.visible !== 'boolean') throw new Error(`字段 ${index + 1} 的显示状态无效`)
  return {
    key: text(field.key, `字段 ${index + 1} 的原始字段名`, MAX_KEY_LENGTH),
    label: text(field.label, `字段 ${index + 1} 的显示名称`, MAX_NAME_LENGTH, true),
    description: text(field.description, `字段 ${index + 1} 的描述`, MAX_DESCRIPTION_LENGTH, true),
    visible: field.visible,
    propertySetting: parsePropertySetting(field.propertySetting, `字段 ${index + 1} 的属性设置`),
  }
}

const parseSection = (value: unknown, label: string): TelemetryLayoutSection => {
  const section = record(value, label)
  if (!SECTION_KINDS.has(section.kind as TelemetrySectionKind)) throw new Error(`${label}类型无效`)
  const fieldKeys = array(section.fieldKeys, `${label}字段`, MAX_FIELDS)
    .map((key, index) => text(key, `${label}字段 ${index + 1}`, MAX_KEY_LENGTH))
  unique(fieldKeys, `${label}字段`)
  return {
    id: text(section.id, `${label} ID`, MAX_NAME_LENGTH),
    name: text(section.name, `${label}名称`, MAX_NAME_LENGTH, true),
    kind: section.kind as TelemetrySectionKind,
    fieldKeys,
  }
}

const parseTab = (value: unknown, label: string): TelemetryLayoutTab => {
  const tab = record(value, label)
  if (!TAB_KINDS.has(tab.kind as TelemetryTabKind)) throw new Error(`${label}类型无效`)
  const sections = array(tab.sections, `${label}二级页签`, MAX_SECTIONS_PER_TAB)
    .map((section, index) => parseSection(section, `${label}二级页签 ${index + 1}`))
  if (!sections.length) throw new Error(`${label}至少需要一个二级页签`)
  unique(sections.map((section) => section.id), `${label}二级页签 ID`)
  return {
    id: text(tab.id, `${label} ID`, MAX_NAME_LENGTH),
    name: text(tab.name, `${label}名称`, MAX_NAME_LENGTH, true),
    kind: tab.kind as TelemetryTabKind,
    sections,
  }
}

const parseDeviceLayout = (value: unknown, label: string): TelemetryDeviceLayout => {
  const layout = record(value, label)
  const fields = array(layout.fields, `${label}字段`, MAX_FIELDS).map(parseField)
  const tabs = array(layout.tabs, `${label}一级页签`, MAX_TABS)
    .map((tab, index) => parseTab(tab, `${label}一级页签 ${index + 1}`))
  if (!tabs.length) throw new Error(`${label}至少需要一个一级页签`)
  unique(fields.map((field) => field.key), `${label}字段名`)
  unique(tabs.map((tab) => tab.id), `${label}一级页签 ID`)
  const fieldKeys = new Set(fields.map((field) => field.key))
  const assignedKeys: string[] = []
  tabs.forEach((tab) => tab.sections.forEach((section) => {
    section.fieldKeys.forEach((key) => {
      if (!fieldKeys.has(key)) throw new Error(`${label}引用了不存在的字段 ${key}`)
      assignedKeys.push(key)
    })
  }))
  unique(assignedKeys, `${label}字段归属`)
  return { tabs, fields }
}

export const parseTelemetryLayoutConfig = (value: unknown): TelemetryLayoutConfig => {
  const config = record(value, '监测项配置')
  if (config.version !== 1) throw new Error('监测项配置版本不受支持')
  if (typeof config.updatedAt !== 'number' || !Number.isFinite(config.updatedAt) || config.updatedAt < 0) {
    throw new Error('监测项配置更新时间无效')
  }
  const devices = record(config.devices, '设备遥测配置')
  return {
    version: 1,
    updatedAt: config.updatedAt,
    devices: Object.fromEntries(DEVICE_TYPES.map((type) => [
      type,
      parseDeviceLayout(devices[type], type === 'dock' ? '机场配置' : type === 'aircraft' ? '飞机配置' : '遥控器配置'),
    ])) as Record<DeviceType, TelemetryDeviceLayout>,
  }
}
