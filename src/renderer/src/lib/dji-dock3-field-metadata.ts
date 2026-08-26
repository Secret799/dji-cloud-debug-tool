import {
  buildDjiFieldMetadata,
  type DjiFieldMetadata,
  type DjiFieldRow,
} from './dji-field-metadata'

export const DJI_DOCK3_PROPERTY_DOC_URL =
  'https://developer.dji.com/doc/cloud-api-tutorial/cn/api-reference/dock-to-cloud/mqtt/dock/dock3/properties.html'

export const DJI_DOCK3_PROPERTY_DOC_DATE = '2026-01-28'

// Dock 3 fields that the official property table currently marks as read/write.
const DJI_DOCK3_WRITABLE_FIELD_ROWS = [
  ['air_transfer_enable', '空中回传', 'bool', '{"false":"关闭","true":"开启"}', '用户在指令飞行过程中拍照的照片快速回传至云端（Dock 3 最新固件也支持快速回传航线任务照片）。', 'rw', '1'],
  ['silent_mode', '机场静音模式', 'enum_int', '{"0":"非静音模式","1":"静音模式"}', '开启后将降低风扇转速和制冷性能，并关闭蜂鸣器及待机状态白色指示灯。', 'rw', '1'],
  ['user_experience_improvement', '用户体验改善计划', 'enum_int', '{"0":"初始状态","1":"拒绝加入用户体验改善计划","2":"同意加入用户体验改善计划"}', '设置是否加入用户体验改善计划。', 'rw', '1'],
] satisfies readonly DjiFieldRow[]

export const DJI_DOCK3_WRITABLE_FIELDS = Object.freeze(
  buildDjiFieldMetadata(DJI_DOCK3_WRITABLE_FIELD_ROWS),
)

const DOCK3_WRITABLE_FIELD_BY_PATH = new Map(
  DJI_DOCK3_WRITABLE_FIELDS.map((metadata) => [metadata.path, metadata]),
)

export const getDjiDock3FieldMetadata = (path: string): DjiFieldMetadata | undefined => {
  const normalizedPath = path
    .split('.')
    .filter((part) => !/^\d+$/.test(part))
    .join('.')
  return DOCK3_WRITABLE_FIELD_BY_PATH.get(normalizedPath)
}
