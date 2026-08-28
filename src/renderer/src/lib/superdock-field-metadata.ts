import { getDjiFieldMetadata, type DjiFieldMetadata } from './dji-field-metadata'

const metadata = (
  path: string,
  label: string,
  type: string,
  options: Partial<DjiFieldMetadata> = {},
): DjiFieldMetadata => Object.freeze({
  path,
  field: path.split('.').at(-1) ?? path,
  label,
  type,
  ...options,
})

export const SUPERDOCK_FIELDS: readonly DjiFieldMetadata[] = Object.freeze([
  metadata('drone_rtcm_info', '无人机 RTK 标定源', 'struct', { accessMode: 'r', pushMode: '1' }),
  metadata('drone_rtcm_info.mount_point', '网络 RTK 挂载点信息', 'text', { accessMode: 'r', pushMode: '1' }),
  metadata('drone_rtcm_info.port', '网络端口信息', 'text', { accessMode: 'r', pushMode: '1' }),
  metadata('drone_rtcm_info.host', '网络 Host 信息', 'text', { accessMode: 'r', pushMode: '1' }),
  metadata('drone_rtcm_info.rtcm_device_type', '设备类型', 'enum_int', {
    accessMode: 'r',
    pushMode: '1',
    enumValues: Object.freeze({ '0': '无人机' }),
  }),
  metadata('drone_rtcm_info.source_type', '标定类型', 'enum_int', {
    accessMode: 'r',
    pushMode: '1',
    enumValues: Object.freeze({ '0': '机场本地 RTK 源', '1': 'DJI 无人机 RTK 源', '2': '网络 RTK 源' }),
  }),
  metadata('air_transfer_enable', '空中回传（无人机到机场）', 'bool', {
    accessMode: 'rw',
    pushMode: '1',
    enumValues: Object.freeze({ false: '关闭', true: '开启' }),
    description: '无人机飞行过程中将拍摄的照片快速回传到机场端。',
  }),
  metadata('cloud_transfer_enable', '空中回传（机场到云端）', 'enum_int', {
    accessMode: 'rw',
    pushMode: '1',
    enumValues: Object.freeze({
      '0': '禁用（飞行中不上传）',
      '1': '100 KB/s',
      '2': '200 KB/s',
      '3': '400 KB/s',
      '4': '800 KB/s',
      '5': '飞行中不限速',
    }),
    description: '配置机场在飞行期间向云端上传媒体的带宽上限。',
  }),
  metadata('soft_emergency_stop_state', '软急停状态', 'enum_int', {
    accessMode: 'r',
    pushMode: '0',
    enumValues: Object.freeze({ '0': '关闭', '1': '开启' }),
  }),
  metadata('dongle_infos.sim_phone_area_code', '区号', 'text', {
    accessMode: 'r',
    pushMode: '1',
  }),
  metadata('dongle_infos.sim_phone_number', '手机号码', 'text', {
    accessMode: 'r',
    pushMode: '1',
  }),
  metadata('dongle_infos.sim_remaining_time', '剩余校验时间', 'int', {
    constraint: '{"unit_name":"秒 / s"}',
    accessMode: 'r',
    pushMode: '1',
    unit: 's',
  }),
  metadata('dongle_infos.sim_last_authenticated_time', '上次校验时间', 'int', {
    constraint: '{"unit_name":"秒 / s"}',
    description: '最近一次 4G 控制校验成功的 Unix 时间戳。',
    accessMode: 'r',
    pushMode: '1',
    unit: 's',
  }),
  metadata('dongle_infos.sim_is_authentication_available', '是否校验成功', 'bool', {
    accessMode: 'r',
    pushMode: '1',
    enumValues: Object.freeze({ false: '否', true: '是' }),
  }),
  metadata('dongle_infos.sim_link_workmode', '增强图传模式', 'bool', {
    description: '机场是否开启增强图传模式。',
    accessMode: 'r',
    pushMode: '1',
    enumValues: Object.freeze({ false: '关闭', true: '开启' }),
  }),
])

const SUPERDOCK_OVERRIDES = new Map(SUPERDOCK_FIELDS.map((field) => [field.path, field]))

export const getSuperDockFieldOverride = (path: string): DjiFieldMetadata | undefined => {
  const normalizedPath = path
    .split('.')
    .filter((part) => !/^\d+$/.test(part))
    .join('.')
  return SUPERDOCK_OVERRIDES.get(normalizedPath)
}

export const getSuperDockFieldMetadata = (path: string): DjiFieldMetadata | undefined =>
  getSuperDockFieldOverride(path) ?? getDjiFieldMetadata(path)
