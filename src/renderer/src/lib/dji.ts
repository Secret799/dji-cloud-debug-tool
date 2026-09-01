import type {
  ConnectionProfile,
  DeviceProvider,
  DjiDeviceIdentity,
  DeviceType,
  DjiDevice,
  MqttMessageRecord,
  MqttQos,
  TopicSubscription,
} from '../../../shared/contracts'
import {
  SUPERDOCK_COMMANDS,
  SUPERDOCK_ONLY_COMMAND_METHODS,
  SUPERDOCK_MODELS,
  SUPERDOCK_UNSUPPORTED_COMMAND_METHODS,
  defaultDockModel,
  deviceProvider,
  providerFromIdentity,
  superDockSupportsCommand,
  superDockProductName,
} from './superdock'
import { SPEAKER_SERVICE_METHODS } from './speaker'

export interface TopicTemplate {
  id: string
  label: string
  topic: string
  qos: MqttQos
  deviceTypes: DeviceType[]
}

export interface CommandTemplate {
  id: string
  category: 'debug' | 'flight' | 'payload' | 'psdk' | 'speaker' | 'live'
  label: string
  method: string
  description: string
  danger?: boolean
  requiresDebug?: boolean
  requiresFlightAuthority?: boolean
  data: Record<string, unknown>
}

export interface DeviceTelemetry {
  profileId: string
  sn: string
  gatewaySn?: string
  type: DeviceType
  provider?: DeviceProvider
  name: string
  online: boolean
  lastSeenAt: number
  lastTopic: string
  identity?: DjiDeviceIdentity
  osd: Record<string, unknown>
  state: Record<string, unknown>
  status: Record<string, unknown>
}

export const DJI_PRODUCT_NAMES: Readonly<Record<string, string>> = {
  '0-60-0': 'DJI Matrice 300 RTK',
  '0-67-0': 'DJI Matrice 30',
  '0-67-1': 'DJI Matrice 30T',
  '0-77-0': 'DJI Mavic 3 Enterprise',
  '0-77-1': 'DJI Mavic 3 Thermal',
  '0-77-3': 'DJI Mavic 3TA',
  '0-89-0': 'DJI Matrice 350 RTK',
  '0-91-0': 'DJI Matrice 3D',
  '0-91-1': 'DJI Matrice 3TD',
  '0-99-0': 'DJI Matrice 4E',
  '0-99-1': 'DJI Matrice 4T',
  '0-100-0': 'DJI Matrice 4D',
  '0-100-1': 'DJI Matrice 4TD',
  '0-103-0': 'DJI Matrice 400',
  '2-56-0': 'DJI Smart Controller Enterprise',
  '2-119-0': 'DJI RC Plus',
  '2-144-0': 'DJI RC Pro Enterprise',
  '2-174-0': 'DJI RC Plus 2',
  '3-1-0': 'DJI Dock',
  '3-2-0': 'DJI Dock 2',
  '3-3-0': 'DJI Dock 3',
}

export const SUPERDOCK_PRODUCT_NAMES: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(
  SUPERDOCK_MODELS.map((model) => [`3-${model.productType}-0`, model.label]),
))

export const PRODUCT_NAMES: Readonly<Record<string, string>> = Object.freeze({
  ...DJI_PRODUCT_NAMES,
  ...SUPERDOCK_PRODUCT_NAMES,
})

export const djiProductKey = (identity: DjiDeviceIdentity): string =>
  `${identity.domain}-${identity.productType}-${identity.productSubType}`

export const djiProductName = (identity: DjiDeviceIdentity | undefined): string | undefined =>
  identity ? DJI_PRODUCT_NAMES[djiProductKey(identity)] : undefined

export const productName = (identity: DjiDeviceIdentity | undefined): string | undefined =>
  superDockProductName(identity) ?? djiProductName(identity)

export const knownProviderFromIdentity = (identity: DjiDeviceIdentity | undefined): DeviceProvider | undefined => {
  if (!identity) return undefined
  const productKey = djiProductKey(identity)
  if (DJI_PRODUCT_NAMES[productKey]) return 'dji'
  if (SUPERDOCK_PRODUCT_NAMES[productKey]) return 'superdock'
  return undefined
}

export const resolveGatewayProvider = (
  configured: Pick<DjiDevice, 'type' | 'provider' | 'dockModel'> | undefined,
  runtime: Pick<DeviceTelemetry, 'provider' | 'identity'> | undefined,
): DeviceProvider | undefined => {
  if (runtime?.identity) return knownProviderFromIdentity(runtime.identity)
  if (configured) return deviceProvider(configured)
  return runtime?.provider
}

export interface GatewayCapabilities {
  deviceControl: boolean
  payload: boolean
  remoteLogs: boolean
  firmwareUpgrade: boolean
}

const GATEWAY_CAPABILITIES: Readonly<Record<DeviceProvider, GatewayCapabilities>> = Object.freeze({
  dji: Object.freeze({ deviceControl: true, payload: true, remoteLogs: true, firmwareUpgrade: true }),
  superdock: Object.freeze({ deviceControl: true, payload: true, remoteLogs: false, firmwareUpgrade: false }),
})

const UNKNOWN_GATEWAY_CAPABILITIES: GatewayCapabilities = Object.freeze({
  deviceControl: false,
  payload: false,
  remoteLogs: false,
  firmwareUpgrade: false,
})

export const gatewayCapabilitiesForProvider = (provider: DeviceProvider | undefined): GatewayCapabilities =>
  provider ? GATEWAY_CAPABILITIES[provider] : UNKNOWN_GATEWAY_CAPABILITIES

export interface CommandTransaction {
  tid: string
  bid?: string
  method: string
  gatewaySn: string
  startedAt: number
  finishedAt?: number
  status: 'pending' | 'success' | 'failed' | 'timeout'
  result?: number
  request: MqttMessageRecord
  response?: MqttMessageRecord
}

export interface ServiceCallResult {
  ok: boolean
  tid: string
  bid?: string
  result?: number
  output?: unknown
  error?: string
}

export type ServiceCaller = (
  gatewaySn: string,
  method: string,
  data: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<ServiceCallResult>

export interface ParsedServiceReply {
  gatewaySn: string
  tid: string
  bid?: string
  method?: string
  result?: number
  output?: unknown
}

export type DeviceActivityKind = 'event' | 'request'

export interface DeviceActivity {
  record: MqttMessageRecord
  method: string
  kind: DeviceActivityKind
  label: string
  knownMethod: boolean
  psdkIndex?: number
}

export const PSDK_DATA_METHODS = [
  'psdk_floating_window_text',
  'psdk_ui_resource_upload_result',
  'custom_data_transmission_from_psdk',
] as const

export type PsdkDataMethod = typeof PSDK_DATA_METHODS[number]
export type PsdkDataActivity = DeviceActivity & { method: PsdkDataMethod; psdkIndex: number }

const psdkDataMethodSet = new Set<string>(PSDK_DATA_METHODS)

export const isPayloadActivity = (
  activity: DeviceActivity,
): activity is PsdkDataActivity =>
  activity.psdkIndex !== undefined && psdkDataMethodSet.has(activity.method)

export interface DeviceActivityGroup {
  id: string
  method: string
  kind: DeviceActivityKind
  label: string
  activities: DeviceActivity[]
  latestAt: number
}

export const groupDeviceActivities = (activities: DeviceActivity[]): DeviceActivityGroup[] => {
  const groups = new Map<string, DeviceActivityGroup>()

  activities.forEach((activity) => {
    const id = `${activity.kind}:${activity.method}`
    const group = groups.get(id) ?? {
      id,
      method: activity.method,
      kind: activity.kind,
      label: activity.label,
      activities: [],
      latestAt: activity.record.timestamp,
    }
    group.activities.push(activity)
    group.latestAt = Math.max(group.latestAt, activity.record.timestamp)
    groups.set(id, group)
  })

  return [...groups.values()]
    .map((group) => ({
      ...group,
      activities: group.activities.slice().sort((left, right) => right.record.timestamp - left.record.timestamp),
    }))
    .sort((left, right) => right.latestAt - left.latestAt || left.label.localeCompare(right.label))
}

interface DeviceActivityMethod {
  kind: DeviceActivityKind
  label: string
}

const DEVICE_ACTIVITY_METHODS: Record<string, DeviceActivityMethod> = {
  flighttask_progress: { kind: 'event', label: '航线任务进度' },
  device_exit_homing_notify: { kind: 'event', label: '退出返航通知' },
  file_upload_callback: { kind: 'event', label: '航线任务媒体上传进度' },
  hms: { kind: 'event', label: '设备告警' },
  device_reboot: { kind: 'event', label: '机场重启进度' },
  drone_open: { kind: 'event', label: '飞行器开机进度' },
  drone_close: { kind: 'event', label: '飞行器关机进度' },
  drone_format: { kind: 'event', label: '飞行器数据格式化进度' },
  device_format: { kind: 'event', label: '机场数据格式化进度' },
  cover_open: { kind: 'event', label: '打开舱盖进度' },
  cover_close: { kind: 'event', label: '关闭舱盖进度' },
  putter_open: { kind: 'event', label: '推杆展开进度' },
  putter_close: { kind: 'event', label: '推杆闭合进度' },
  charge_open: { kind: 'event', label: '开启充电进度' },
  charge_close: { kind: 'event', label: '停止充电进度' },
  esim_activate: { kind: 'event', label: 'eSIM 激活进度' },
  esim_operator_switch: { kind: 'event', label: 'eSIM 运营商切换进度' },
  cover_force_close: { kind: 'event', label: '强制关闭舱盖进度' },
  rtk_calibration: { kind: 'event', label: '一键标定结果' },
  ota_progress: { kind: 'event', label: '固件升级进度' },
  fileupload_progress: { kind: 'event', label: '日志文件上传进度' },
  highest_priority_upload_flighttask_media: { kind: 'event', label: '航线任务媒体优先上传' },
  flighttask_ready: { kind: 'event', label: '航线任务就绪' },
  fly_to_point_progress: { kind: 'event', label: '指点飞行进度' },
  takeoff_to_point_progress: { kind: 'event', label: '一键起飞进度' },
  drc_status_notify: { kind: 'event', label: 'DRC 状态通知' },
  joystick_invalid_notify: { kind: 'event', label: '摇杆失效通知' },
  return_home_info: { kind: 'event', label: '返航信息' },
  custom_data_transmission_from_esdk: { kind: 'event', label: 'ESDK 自定义数据' },
  custom_data_transmission_from_psdk: { kind: 'event', label: 'PSDK 自定义数据' },
  psdk_floating_window_text: { kind: 'event', label: 'PSDK 浮窗文本' },
  psdk_ui_resource_upload_result: { kind: 'event', label: 'PSDK UI 资源上传结果' },
  airsense_warning: { kind: 'event', label: 'AirSense 告警' },
  flight_areas_sync_progress: { kind: 'event', label: '限飞区同步进度' },
  flight_areas_drone_location: { kind: 'event', label: '限飞区飞行器位置' },
  offline_map_sync_progress: { kind: 'event', label: '离线地图同步进度' },
  poi_status_notify: { kind: 'event', label: 'POI 状态通知' },
  camera_photo_take_progress: { kind: 'event', label: '拍照进度' },
  storage_config_get: { kind: 'request', label: '获取对象存储配置' },
  airport_bind_status: { kind: 'request', label: '查询机场绑定状态' },
  airport_organization_bind: { kind: 'request', label: '机场绑定组织' },
  airport_organization_get: { kind: 'request', label: '获取机场组织信息' },
  flighttask_resource_get: { kind: 'request', label: '获取航线任务资源' },
  config: { kind: 'request', label: '获取设备配置' },
  flight_areas_get: { kind: 'request', label: '获取限飞区数据' },
  offline_map_get: { kind: 'request', label: '获取离线地图' },
}

export const DJI_TOPIC_TEMPLATES: TopicTemplate[] = [
  {
    id: 'dock-gateway-status',
    label: '机场网关状态',
    topic: 'sys/product/{sn}/status',
    qos: 1,
    deviceTypes: ['dock'],
  },
  {
    id: 'pilot-gateway-status',
    label: 'Pilot 网关状态',
    topic: 'thing/product/{sn}/status',
    qos: 1,
    deviceTypes: ['pilot'],
  },
  {
    id: 'osd',
    label: 'OSD 遥测',
    topic: 'thing/product/{sn}/osd',
    qos: 0,
    deviceTypes: ['dock', 'aircraft', 'pilot'],
  },
  {
    id: 'state',
    label: '设备状态',
    topic: 'thing/product/{sn}/state',
    qos: 1,
    deviceTypes: ['dock', 'aircraft', 'pilot'],
  },
  {
    id: 'services-reply',
    label: '服务响应',
    topic: 'thing/product/{sn}/services_reply',
    qos: 1,
    deviceTypes: ['dock', 'pilot'],
  },
  {
    id: 'events',
    label: '设备事件',
    topic: 'thing/product/{sn}/events',
    qos: 1,
    deviceTypes: ['dock', 'pilot'],
  },
  {
    id: 'requests',
    label: '设备请求',
    topic: 'thing/product/{sn}/requests',
    qos: 1,
    deviceTypes: ['dock', 'pilot'],
  },
  {
    id: 'property-set-reply',
    label: '属性设置响应',
    topic: 'thing/product/{sn}/property/set_reply',
    qos: 1,
    deviceTypes: ['dock', 'pilot'],
  },
  {
    id: 'drc-up',
    label: 'DRC 上行',
    topic: 'thing/product/{sn}/drc/up',
    qos: 0,
    deviceTypes: ['dock'],
  },
]

export const DJI_COMMANDS: CommandTemplate[] = [
  {
    id: 'debug-open',
    category: 'debug',
    label: '进入远程调试',
    method: 'debug_mode_open',
    description: '启用机场远程调试模式',
    data: {},
  },
  {
    id: 'debug-close',
    category: 'debug',
    label: '退出远程调试',
    method: 'debug_mode_close',
    description: '关闭机场远程调试模式',
    data: {},
  },
  {
    id: 'cover-open',
    category: 'debug',
    label: '打开舱盖',
    method: 'cover_open',
    description: '打开机场舱盖',
    requiresDebug: true,
    data: {},
  },
  {
    id: 'cover-close',
    category: 'debug',
    label: '关闭舱盖',
    method: 'cover_close',
    description: '关闭机场舱盖',
    requiresDebug: true,
    data: {},
  },
  {
    id: 'cover-force-close',
    category: 'debug',
    label: '强制关舱',
    method: 'cover_force_close',
    description: '忽略常规检查并强制关闭舱盖',
    danger: true,
    requiresDebug: true,
    data: {},
  },
  {
    id: 'drone-open',
    category: 'debug',
    label: '飞机开机',
    method: 'drone_open',
    description: '为库内飞机上电',
    requiresDebug: true,
    data: {},
  },
  {
    id: 'drone-close',
    category: 'debug',
    label: '飞机关机',
    method: 'drone_close',
    description: '关闭库内飞机电源',
    requiresDebug: true,
    data: {},
  },
  {
    id: 'charge-open',
    category: 'debug',
    label: '开启充电',
    method: 'charge_open',
    description: '开始为飞机充电',
    requiresDebug: true,
    data: {},
  },
  {
    id: 'charge-close',
    category: 'debug',
    label: '停止充电',
    method: 'charge_close',
    description: '停止飞机充电',
    requiresDebug: true,
    data: {},
  },
  {
    id: 'device-reboot',
    category: 'debug',
    label: '重启机场',
    method: 'device_reboot',
    description: '重启机场设备',
    danger: true,
    requiresDebug: true,
    data: {},
  },
  {
    id: 'esim-operator-switch',
    category: 'debug',
    label: 'eSIM 运营商切换',
    method: 'esim_operator_switch',
    description: '切换机场或飞行器 Dongle 使用的 eSIM 运营商',
    requiresDebug: true,
    data: { imei: '', device_type: 'dock', esim_operator: 1 },
  },
  {
    id: 'sim-slot-switch',
    category: 'debug',
    label: 'SIM / eSIM 切换',
    method: 'sim_slot_switch',
    description: '切换机场或飞行器 Dongle 使用的实体 SIM 卡或 eSIM',
    requiresDebug: true,
    data: { imei: '', device_type: 'dock', sim_slot: 1 },
  },
  {
    id: 'esim-activate',
    category: 'debug',
    label: 'eSIM 激活',
    method: 'esim_activate',
    description: '激活机场或飞行器 Dongle 的 eSIM',
    requiresDebug: true,
    data: { imei: '', device_type: 'dock' },
  },
  {
    id: 'sdr-workmode-switch',
    category: 'debug',
    label: '增强图传开关',
    method: 'sdr_workmode_switch',
    description: '切换仅 SDR 或 4G 增强图传模式',
    requiresDebug: true,
    data: { link_workmode: 1 },
  },
  {
    id: 'drone-format',
    category: 'debug',
    label: '飞行器数据格式化',
    method: 'drone_format',
    description: '格式化飞行器存储数据',
    danger: true,
    requiresDebug: true,
    data: {},
  },
  {
    id: 'device-format',
    category: 'debug',
    label: '机场数据格式化',
    method: 'device_format',
    description: '格式化机场存储数据',
    danger: true,
    requiresDebug: true,
    data: {},
  },
  {
    id: 'battery-store-mode-switch',
    category: 'debug',
    label: '电池运行模式切换',
    method: 'battery_store_mode_switch',
    description: '切换电池计划模式或待命模式',
    requiresDebug: true,
    data: { action: 1 },
  },
  {
    id: 'alarm-state-switch',
    category: 'debug',
    label: '机场声光报警开关',
    method: 'alarm_state_switch',
    description: '开启或关闭机场声光报警',
    requiresDebug: true,
    data: { action: 1 },
  },
  {
    id: 'air-conditioner-mode-switch',
    category: 'debug',
    label: '机场空调模式切换',
    method: 'air_conditioner_mode_switch',
    description: '切换机场空调的空闲、制冷、制热或除湿模式',
    requiresDebug: true,
    data: { action: 0 },
  },
  {
    id: 'battery-maintenance-switch',
    category: 'debug',
    label: '电池保养状态切换',
    method: 'battery_maintenance_switch',
    description: '开启或关闭电池保养状态',
    requiresDebug: true,
    data: { action: 1 },
  },
  {
    id: 'supplement-light-close',
    category: 'debug',
    label: '关闭补光灯',
    method: 'supplement_light_close',
    description: '关闭机场补光灯',
    requiresDebug: true,
    data: {},
  },
  {
    id: 'supplement-light-open',
    category: 'debug',
    label: '打开补光灯',
    method: 'supplement_light_open',
    description: '打开机场补光灯',
    requiresDebug: true,
    data: {},
  },
  {
    id: 'rtk-calibration',
    category: 'debug',
    label: '一键标定',
    method: 'rtk_calibration',
    description: '按设备 SN、模块和坐标数据执行 RTK 一键标定',
    requiresDebug: true,
    data: {
      devices: [{
        sn: '',
        type: 1,
        module: '3',
        data: { longitude: 0, latitude: 0, height: 0 },
      }],
    },
  },
  {
    id: 'flight-authority-grab',
    category: 'flight',
    label: '获取飞行控制权',
    method: 'flight_authority_grab',
    description: '请求 DRC 飞行控制权限',
    data: {},
  },
  {
    id: 'flight-authority-release',
    category: 'flight',
    label: '释放飞行控制权',
    method: 'drc_mode_exit',
    description: '退出 DRC 控制模式',
    data: {},
  },
  {
    id: 'takeoff',
    category: 'flight',
    label: '一键起飞',
    method: 'takeoff_to_point',
    description: '起飞到指定坐标，发送前请核对参数',
    danger: true,
    requiresFlightAuthority: true,
    data: {
      target_latitude: 0,
      target_longitude: 0,
      target_height: 30,
      security_takeoff_height: 20,
      rth_mode: 1,
      rth_altitude: 60,
      rc_lost_action: 2,
      commander_mode_lost_action: 1,
      commander_flight_mode: 0,
      commander_flight_height: 100,
      max_speed: 12,
      flight_safety_advance_check: 1,
      flight_id: '',
    },
  },
  {
    id: 'return-home',
    category: 'flight',
    label: '一键返航',
    method: 'return_home',
    description: '命令飞机返航',
    danger: true,
    requiresFlightAuthority: true,
    data: {},
  },
  {
    id: 'return-home-cancel',
    category: 'flight',
    label: '取消返航',
    method: 'return_home_cancel',
    description: '取消当前返航任务',
    danger: true,
    requiresFlightAuthority: true,
    data: {},
  },
  {
    id: 'emergency-stop',
    category: 'flight',
    label: '紧急悬停',
    method: 'drone_emergency_stop',
    description: '触发飞行器紧急停止',
    danger: true,
    requiresFlightAuthority: true,
    data: {},
  },
  {
    id: 'payload-authority-grab',
    category: 'payload',
    label: '获取负载控制权',
    method: 'payload_authority_grab',
    description: '获取相机与云台控制权限',
    data: {},
  },
  {
    id: 'camera-photo',
    category: 'payload',
    label: '拍照',
    method: 'camera_photo_take',
    description: '触发负载相机拍照',
    data: { payload_index: '0-0-0' },
  },
  {
    id: 'camera-record-start',
    category: 'payload',
    label: '开始录像',
    method: 'camera_recording_start',
    description: '开始负载相机录像',
    data: { payload_index: '0-0-0' },
  },
  {
    id: 'camera-record-stop',
    category: 'payload',
    label: '结束录像',
    method: 'camera_recording_stop',
    description: '停止负载相机录像',
    data: { payload_index: '0-0-0' },
  },
  {
    id: 'gimbal-reset',
    category: 'payload',
    label: '云台回中',
    method: 'gimbal_reset',
    description: '将云台恢复到默认姿态',
    data: { payload_index: '0-0-0', reset_mode: 0 },
  },
  {
    id: 'psdk-custom-data',
    category: 'psdk',
    label: '发送自定义数据',
    method: 'custom_data_transmission_to_psdk',
    description: '通过 PSDK 通道向负载发送自定义数据，value 最长 256 字符',
    data: { psdk_index: 0, value: '' },
  },
  {
    id: 'speaker-tts',
    category: 'speaker',
    label: 'TTS 喊话',
    method: SPEAKER_SERVICE_METHODS.tts,
    description: '通过 PSDK 喊话器播放文字',
    data: { psdk_index: 0, tts: { name: 'debug-message', text: '测试播报', md5: '' } },
  },
  {
    id: 'speaker-audio',
    category: 'speaker',
    label: '音频喊话',
    method: SPEAKER_SERVICE_METHODS.audio,
    description: '通过 PSDK 喊话器播放设备可下载的音频文件',
    data: { psdk_index: 0, audio: { name: '', url: '', md5: '' } },
  },
  {
    id: 'speaker-volume',
    category: 'speaker',
    label: '设置音量',
    method: SPEAKER_SERVICE_METHODS.volume,
    description: '设置 PSDK 喊话器音量',
    data: { psdk_index: 0, play_volume: 70 },
  },
  {
    id: 'speaker-stop',
    category: 'speaker',
    label: '停止播放',
    method: SPEAKER_SERVICE_METHODS.stop,
    description: '停止当前喊话任务',
    data: { psdk_index: 0 },
  },
  {
    id: 'live-start',
    category: 'live',
    label: '开始推流',
    method: 'live_start_push',
    description: '将指定视频源推送到媒体服务',
    data: { url_type: 1, url: '', video_id: '', video_quality: 2 },
  },
  {
    id: 'live-stop',
    category: 'live',
    label: '停止推流',
    method: 'live_stop_push',
    description: '停止指定视频源推流',
    data: { video_id: '' },
  },
  {
    id: 'live-quality',
    category: 'live',
    label: '切换清晰度',
    method: 'live_set_quality',
    description: '调整正在推流的视频质量',
    data: { video_id: '', video_quality: 2 },
  },
  {
    id: 'live-camera-change',
    category: 'live',
    label: '切换机场相机',
    method: 'live_camera_change',
    description: '切换机场直播的舱内或舱外相机',
    data: { video_id: '', camera_position: 0 },
  },
]

export const ALL_COMMANDS: readonly CommandTemplate[] = Object.freeze([
  ...DJI_COMMANDS,
  ...SUPERDOCK_COMMANDS,
])

export const commandTemplatesForProvider = (provider: DeviceProvider): readonly CommandTemplate[] =>
  provider === 'superdock'
    ? ALL_COMMANDS.filter(superDockSupportsCommand)
    : DJI_COMMANDS

export const isCommandUnsupportedForProvider = (provider: DeviceProvider, method: string): boolean =>
  (provider === 'superdock'
    ? SUPERDOCK_UNSUPPORTED_COMMAND_METHODS.has(method)
    : SUPERDOCK_ONLY_COMMAND_METHODS.has(method))
  || (
    ALL_COMMANDS.some((command) => command.method === method)
    && !commandTemplatesForProvider(provider).some((command) => command.method === method)
  )

export const FIELD_LABELS: Record<string, { label: string; unit?: string }> = {
  latitude: { label: '纬度', unit: '°' },
  longitude: { label: '经度', unit: '°' },
  altitude: { label: '海拔高度', unit: 'm' },
  height: { label: '相对高度', unit: 'm' },
  horizontal_speed: { label: '水平速度', unit: 'm/s' },
  vertical_speed: { label: '垂直速度', unit: 'm/s' },
  wind_speed: { label: '风速', unit: 'm/s' },
  environment_temperature: { label: '环境温度', unit: '°C' },
  temperature: { label: '舱内温度', unit: '°C' },
  humidity: { label: '舱内湿度', unit: '%' },
  rain_mmd: { label: '降雨量', unit: 'mm/d' },
  mode_code: { label: '工作模式' },
  cover_state: { label: '舱盖状态' },
  drone_in_dock: { label: '飞机在舱' },
  network_state: { label: '网络状态' },
  battery: { label: '电池信息' },
  capacity_percent: { label: '电量', unit: '%' },
  flight_time: { label: '飞行时长', unit: 's' },
  gps_signal_level: { label: 'GPS 信号' },
  home_distance: { label: '返航点距离', unit: 'm' },
  attitude_head: { label: '航向角', unit: '°' },
  firmware_version: { label: '固件版本' },
  job_number: { label: '累计任务数' },
  charge_state: { label: '充电状态' },
  live_status: { label: '直播状态' },
}

export const createProfile = (): ConnectionProfile => {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    name: '新连接',
    protocol: 'mqtt',
    host: '127.0.0.1',
    port: 1883,
    path: '/mqtt',
    clientId: `dji-cloud-studio-${Math.random().toString(16).slice(2, 10)}`,
    username: '',
    password: '',
    mqttVersion: '3.1.1',
    clean: true,
    keepalive: 60,
    connectTimeout: 10,
    reconnectPeriod: 3,
    rejectUnauthorized: true,
    caPath: '',
    certPath: '',
    keyPath: '',
    devices: [],
    subscriptions: [],
    createdAt: now,
    updatedAt: now,
  }
}

export const defaultDeviceName = (type: DeviceType): string =>
  type === 'dock' ? '新机场' : type === 'aircraft' ? '新飞机' : '新遥控器'

export const createDevice = (type: DeviceType = 'dock', provider: DeviceProvider = 'dji'): DjiDevice => ({
  id: crypto.randomUUID(),
  name: defaultDeviceName(type),
  sn: '',
  type,
  provider: type === 'dock' ? provider : 'dji',
  enabled: true,
  dockModel: type === 'dock' ? defaultDockModel(provider) : undefined,
})

export const subscriptionsForDevice = (device: DjiDevice): TopicSubscription[] =>
  DJI_TOPIC_TEMPLATES.filter((template) => template.deviceTypes.includes(device.type)).map((template) => ({
    id: crypto.randomUUID(),
    topic: template.topic.replace('{sn}', device.sn.trim()),
    qos: template.qos,
    enabled: true,
    source: deviceProvider(device),
  }))

export interface ServicePayloadOptions {
  tid?: string
  bid?: string
  timestamp?: number
}

export const buildServicePayload = (
  method: string,
  data: Record<string, unknown>,
  options: ServicePayloadOptions = {},
): string =>
  JSON.stringify(
    {
      tid: options.tid ?? crypto.randomUUID(),
      bid: options.bid ?? crypto.randomUUID(),
      timestamp: options.timestamp ?? Date.now(),
      method,
      data,
    },
    null,
    2,
  )

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const finiteInteger = (value: unknown): number | undefined => {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isInteger(number) && Number.isFinite(number) ? number : undefined
}

const deviceIdentityFromData = (data: Record<string, unknown>): DjiDeviceIdentity | undefined => {
  const domain = typeof data.domain === 'string' || typeof data.domain === 'number'
    ? String(data.domain).trim()
    : ''
  const productType = finiteInteger(data.type)
  const productSubType = finiteInteger(data.sub_type)
  if (!domain || productType === undefined || productSubType === undefined) return undefined

  const channelIndex = typeof data.index === 'string' && data.index.trim() ? data.index.trim() : undefined
  const rawThingVersion = data.thing_version ?? data.version
  const thingVersion = typeof rawThingVersion === 'string' && rawThingVersion.trim()
    ? rawThingVersion.trim()
    : typeof rawThingVersion === 'number' && Number.isFinite(rawThingVersion)
      ? String(rawThingVersion)
      : undefined
  return { domain, productType, productSubType, channelIndex, thingVersion }
}

const deviceTypeFromIdentity = (identity: DjiDeviceIdentity | undefined): DeviceType | undefined => {
  if (identity?.domain === '0') return 'aircraft'
  if (identity?.domain === '2') return 'pilot'
  if (identity?.domain === '3') return 'dock'
  return undefined
}

const withoutSensitiveDeviceCredentials = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutSensitiveDeviceCredentials)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'device_secret' && key !== 'nonce')
      .map(([key, child]) => [key, withoutSensitiveDeviceCredentials(child)]),
  )
}

const publicStatusData = (
  data: Record<string, unknown>,
  isTopologyUpdate: boolean,
): Record<string, unknown> => {
  const sanitized = withoutSensitiveDeviceCredentials(data) as Record<string, unknown>
  if (!isTopologyUpdate) return sanitized
  return Object.fromEntries(Object.entries(sanitized).filter(([key]) => key !== 'sub_devices'))
}

export const parseServicePayload = (payload: string): Record<string, unknown> | undefined => {
  try {
    const parsed = JSON.parse(payload) as unknown
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export const serviceMethodFromPayload = (payload: string): string | undefined => {
  const parsed = parseServicePayload(payload)
  return typeof parsed?.method === 'string' ? parsed.method : undefined
}

export const parseDeviceActivity = (record: MqttMessageRecord): DeviceActivity | undefined => {
  if (record.direction !== 'in') return undefined
  const topicKind = record.topic.endsWith('/events')
    ? 'event'
    : record.topic.endsWith('/requests')
      ? 'request'
      : undefined
  if (!topicKind) return undefined

  const envelope = parseServicePayload(record.payload)
  const method = typeof envelope?.method === 'string' ? envelope.method.trim() : ''
  if (!method) return undefined

  const data = envelope && isRecord(envelope.data) ? envelope.data : undefined
  const rawPsdkIndex = data?.psdk_index
  const psdkIndex = typeof rawPsdkIndex === 'number'
    && Number.isInteger(rawPsdkIndex)
    && rawPsdkIndex >= 0
    ? rawPsdkIndex
    : undefined

  const known = DEVICE_ACTIVITY_METHODS[method]
  if (known) {
    return { record, method, ...known, knownMethod: true, psdkIndex }
  }

  return {
    record,
    method,
    kind: topicKind,
    label: topicKind === 'event' ? '未识别设备事件' : '未识别设备请求',
    knownMethod: false,
    psdkIndex,
  }
}

export const refreshServicePayload = (payload: string): string => {
  const parsed = parseServicePayload(payload)
  if (!parsed) throw new Error('请求体不是有效 JSON 对象')
  return JSON.stringify(
    {
      ...parsed,
      tid: crypto.randomUUID(),
      bid: crypto.randomUUID(),
      timestamp: Date.now(),
    },
    null,
    2,
  )
}

export function mergeNestedRecords(...sources: Record<string, unknown>[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      const current = result[key]
      result[key] = isRecord(current) && isRecord(value)
        ? mergeNestedRecords(current, value)
        : isRecord(value)
          ? mergeNestedRecords(value)
          : value
    }
  }
  return result
}

const mergeTelemetrySections = (
  existing: DeviceTelemetry | undefined,
  data: Record<string, unknown>,
  topic: string,
): Pick<DeviceTelemetry, 'osd' | 'state' | 'status'> => ({
  osd: topic.endsWith('/osd') ? mergeNestedRecords(existing?.osd ?? {}, data) : existing?.osd ?? {},
  state: topic.endsWith('/state') ? mergeNestedRecords(existing?.state ?? {}, data) : existing?.state ?? {},
  status: topic.endsWith('/status') ? mergeNestedRecords(existing?.status ?? {}, data) : existing?.status ?? {},
})

const dockRelayedAircraftKeys = new Set([
  'sub_device',
  'drone_charge_state',
  'drone_battery_maintenance_info',
])

const withoutDockRelayedAircraftData = (data: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(data).filter(([key]) => !dockRelayedAircraftKeys.has(key)))

const dockRelayedAircraftData = (data: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'sub_device' && dockRelayedAircraftKeys.has(key)))

export const prettyPayload = (payload: string): string => {
  try {
    return JSON.stringify(JSON.parse(payload), null, 2)
  } catch {
    return payload
  }
}

export const retainRecentMessages = (
  records: MqttMessageRecord[],
  maxCount = 2_000,
  maxBytes = 32 * 1024 * 1024,
): MqttMessageRecord[] => {
  let start = records.length
  let count = 0
  let totalBytes = 0
  for (let index = records.length - 1; index >= 0 && count < maxCount; index -= 1) {
    const size = Math.max(0, records[index].size || 0)
    if (count > 0 && totalBytes + size > maxBytes) break
    start = index
    count += 1
    totalBytes += size
  }
  return records.slice(start)
}

export const extractTopicSn = (topic: string): string | undefined => {
  const match = topic.match(/^(?:thing|sys)\/product\/([^/]+)\//)
  return match?.[1]
}

export const parseServiceReply = (record: MqttMessageRecord): ParsedServiceReply | undefined => {
  if (record.direction !== 'in' || !record.topic.endsWith('/services_reply')) return undefined
  try {
    const payload = JSON.parse(record.payload) as {
      tid?: unknown
      bid?: unknown
      method?: unknown
      data?: { result?: unknown; output?: unknown }
    }
    const gatewaySn = extractTopicSn(record.topic)
    const tid = typeof payload.tid === 'string' ? payload.tid.trim() : ''
    if (!gatewaySn || !tid) return undefined
    const result = finiteInteger(payload.data?.result)
    return {
      gatewaySn,
      tid,
      bid: typeof payload.bid === 'string' && payload.bid.trim() ? payload.bid.trim() : undefined,
      method: typeof payload.method === 'string' && payload.method.trim() ? payload.method.trim() : undefined,
      result,
      output: payload.data?.output,
    }
  } catch {
    return undefined
  }
}

export const buildDrcStatusEventReply = (
  record: MqttMessageRecord,
  timestamp = Date.now(),
): { topic: string; payload: string } | undefined => {
  if (record.direction !== 'in' || !record.topic.endsWith('/events')) return undefined
  try {
    const envelope = JSON.parse(record.payload) as unknown
    if (!isRecord(envelope) || envelope.method !== 'drc_status_notify' || finiteInteger(envelope.need_reply) !== 1) {
      return undefined
    }
    const gatewaySn = extractTopicSn(record.topic)
    const tid = typeof envelope.tid === 'string' ? envelope.tid.trim() : ''
    const bid = typeof envelope.bid === 'string' ? envelope.bid.trim() : ''
    if (!gatewaySn || !tid) return undefined
    return {
      topic: `thing/product/${gatewaySn}/events_reply`,
      payload: JSON.stringify({
        tid,
        ...(bid ? { bid } : {}),
        timestamp,
        method: 'drc_status_notify',
        data: { result: 0 },
      }),
    }
  } catch {
    return undefined
  }
}

export const isDeviceEffectivelyEnabled = (devices: DjiDevice[], sn: string): boolean => {
  const devicesBySn = new Map(devices.map((device) => [device.sn, device]))
  const visited = new Set<string>()
  let current = devicesBySn.get(sn)

  while (current) {
    if (current.enabled === false) return false
    if (!current.parentSn || visited.has(current.sn)) return true
    visited.add(current.sn)
    current = devicesBySn.get(current.parentSn)
  }
  return true
}

export const isSubscriptionActive = (
  profile: Pick<ConnectionProfile, 'devices'>,
  subscription: TopicSubscription,
): boolean => {
  if (!subscription.enabled) return false
  const sn = extractTopicSn(subscription.topic)
  return !sn || isDeviceEffectivelyEnabled(profile.devices, sn)
}

export const withLiveAircraftRelationships = (
  devices: DjiDevice[],
  telemetry: DeviceTelemetry[],
  createId: () => string = () => crypto.randomUUID(),
): DjiDevice[] => {
  const devicesBySn = new Map(devices.map((device) => [device.sn, device]))
  telemetry.forEach((item) => {
    if (item.type !== 'aircraft' || !item.gatewaySn || !devicesBySn.has(item.gatewaySn)) return
    const existing = devicesBySn.get(item.sn)
    devicesBySn.set(item.sn, existing ? {
      ...existing,
      parentSn: item.gatewaySn,
    } : {
      id: createId(),
      name: item.name || '已发现飞机',
      sn: item.sn,
      type: 'aircraft',
      provider: 'dji',
      enabled: true,
      parentSn: item.gatewaySn,
    })
  })
  return [...devicesBySn.values()]
}

export const discoveredAircraftForProfile = (
  telemetry: Iterable<DeviceTelemetry>,
  profileId: string,
): Array<DeviceTelemetry & { type: 'aircraft'; gatewaySn: string }> => [...telemetry].filter(
  (item): item is DeviceTelemetry & { type: 'aircraft'; gatewaySn: string } =>
    item.profileId === profileId && item.type === 'aircraft' && Boolean(item.gatewaySn),
)

export const mergeTelemetry = (
  current: Record<string, DeviceTelemetry>,
  profile: ConnectionProfile,
  message: MqttMessageRecord,
): Record<string, DeviceTelemetry> => {
  if (message.direction !== 'in') return current
  const sn = extractTopicSn(message.topic)
  if (!sn) return current

  let parsed: unknown
  try {
    parsed = JSON.parse(message.payload) as unknown
  } catch {
    return current
  }
  if (!isRecord(parsed)) return current

  const rawData = parsed.data
  const data = rawData && typeof rawData === 'object' && !Array.isArray(rawData) ? (rawData as Record<string, unknown>) : {}
  const isTopologyUpdate = message.topic.endsWith('/status') && parsed.method === 'update_topo'
  const isDrcStatusEvent = message.topic.endsWith('/events') && parsed.method === 'drc_status_notify'
  const gatewayIdentity = isTopologyUpdate ? deviceIdentityFromData(data) : undefined
  const payloadGatewaySn = typeof parsed.gateway === 'string' ? parsed.gateway : undefined
  const configured = profile.devices.find((device) => device.sn === sn)
  const key = `${profile.id}:${sn}`
  const existing = current[key]
  const type: DeviceType = configured?.type
    ?? deviceTypeFromIdentity(gatewayIdentity)
    ?? (message.topic.startsWith('sys/') ? 'dock' : existing?.type ?? 'aircraft')
  const provider = configured
    ? deviceProvider(configured)
    : gatewayIdentity
      ? providerFromIdentity(gatewayIdentity)
      : existing?.provider ?? providerFromIdentity(existing?.identity)
  const sanitizedData = message.topic.endsWith('/status') ? publicStatusData(data, isTopologyUpdate) : data
  const deviceData = type === 'dock' ? withoutDockRelayedAircraftData(sanitizedData) : sanitizedData
  const baseOsd = type === 'dock' ? withoutDockRelayedAircraftData(existing?.osd ?? {}) : existing?.osd ?? {}
  const baseState = type === 'dock' ? withoutDockRelayedAircraftData(existing?.state ?? {}) : existing?.state ?? {}
  const baseStatus = type === 'dock' ? withoutDockRelayedAircraftData(existing?.status ?? {}) : existing?.status ?? {}
  const next: DeviceTelemetry = {
    profileId: profile.id,
    sn,
    type,
    provider,
    name: configured?.name ?? existing?.name ?? (type === 'dock' ? '已发现机场' : '已发现设备'),
    gatewaySn: type === 'aircraft' && payloadGatewaySn && payloadGatewaySn !== sn
      ? payloadGatewaySn
      : existing?.gatewaySn,
    online: true,
    lastSeenAt: message.timestamp,
    lastTopic: message.topic,
    identity: gatewayIdentity ?? existing?.identity,
    osd: baseOsd,
    state: baseState,
    status: baseStatus,
  }

  if (message.topic.endsWith('/osd')) next.osd = mergeNestedRecords(next.osd, deviceData)
  if (message.topic.endsWith('/state')) next.state = mergeNestedRecords(next.state, deviceData)
  if (message.topic.endsWith('/status')) next.status = mergeNestedRecords(next.status, deviceData)
  if (isDrcStatusEvent) {
    const drcState = finiteInteger(data.drc_state)
    if (drcState === 0 || drcState === 1 || drcState === 2) {
      next.state = mergeNestedRecords(next.state, { drc_state: drcState })
    }
  }

  const subDevices = isTopologyUpdate ? data.sub_devices : undefined
  const discovered: Record<string, DeviceTelemetry> = {}
  if (Array.isArray(subDevices)) {
    const onlineChildSns = new Set<string>()
    for (const item of subDevices) {
      if (!isRecord(item)) continue
      const childSn = String(item.sn ?? '').trim()
      if (!childSn) continue
      onlineChildSns.add(childSn)
      const childKey = `${profile.id}:${childSn}`
      const childExisting = current[childKey]
      const childConfig = profile.devices.find((device) => device.sn === childSn)
      const childData = publicStatusData(item, true)
      const childIdentity = deviceIdentityFromData(item)
      const discoveredName = productName(childIdentity)
      discovered[childKey] = {
        profileId: profile.id,
        sn: childSn,
        gatewaySn: sn,
        type: childConfig?.type ?? deviceTypeFromIdentity(childIdentity) ?? 'aircraft',
        provider: childConfig ? deviceProvider(childConfig) : providerFromIdentity(childIdentity),
        name: childConfig?.name
          ?? (childExisting?.name && childExisting.name !== '已发现飞机' ? childExisting.name : discoveredName)
          ?? childExisting?.name
          ?? '已发现飞机',
        online: true,
        lastSeenAt: message.timestamp,
        lastTopic: message.topic,
        identity: childIdentity ?? childExisting?.identity,
        ...mergeTelemetrySections(childExisting, childData, message.topic),
      }
    }

    Object.entries(current).forEach(([childKey, child]) => {
      if (child.profileId !== profile.id || child.gatewaySn !== sn || child.type !== 'aircraft') return
      if (onlineChildSns.has(child.sn) || discovered[childKey]) return
      discovered[childKey] = { ...child, online: false, lastTopic: message.topic }
    })
  }

  const dockSubDevice = data.sub_device
  let dockChildSn = ''
  if (dockSubDevice && typeof dockSubDevice === 'object' && !Array.isArray(dockSubDevice)) {
    const childData = dockSubDevice as Record<string, unknown>
    const childSn = String(childData.device_sn ?? '')
    if (childSn) {
      dockChildSn = childSn
      const childKey = `${profile.id}:${childSn}`
      const childExisting = current[childKey]
      const childConfig = profile.devices.find((device) => device.sn === childSn)
      discovered[childKey] = {
        profileId: profile.id,
        sn: childSn,
        gatewaySn: sn,
        type: 'aircraft',
        provider: childConfig ? deviceProvider(childConfig) : childExisting?.provider ?? 'dji',
        name: childConfig?.name ?? childExisting?.name ?? '已发现飞机',
        online: true,
        lastSeenAt: message.timestamp,
        lastTopic: message.topic,
        identity: childExisting?.identity,
        ...mergeTelemetrySections(childExisting, childData, message.topic),
      }
    }
  }

  if (type === 'dock') {
    const relayedData = dockRelayedAircraftData(data)
    if (Object.keys(relayedData).length) {
      const relatedAircraftSn = dockChildSn
        || profile.devices.find((device) => device.type === 'aircraft' && device.parentSn === sn)?.sn
        || Object.values(current).find((device) => device.type === 'aircraft' && device.gatewaySn === sn)?.sn
      if (relatedAircraftSn) {
        const childKey = `${profile.id}:${relatedAircraftSn}`
        const childExisting = discovered[childKey] ?? current[childKey]
        const childConfig = profile.devices.find((device) => device.sn === relatedAircraftSn)
        discovered[childKey] = {
          profileId: profile.id,
          sn: relatedAircraftSn,
          gatewaySn: sn,
          type: 'aircraft',
          provider: childConfig ? deviceProvider(childConfig) : childExisting?.provider ?? 'dji',
          name: childConfig?.name ?? childExisting?.name ?? '已发现飞机',
          online: true,
          lastSeenAt: message.timestamp,
          lastTopic: message.topic,
          identity: childExisting?.identity,
          ...mergeTelemetrySections(childExisting, relayedData, message.topic),
        }
      }
    }
  }

  return { ...current, [key]: next, ...discovered }
}

export const commandTransactions = (records: MqttMessageRecord[], now = Date.now()): CommandTransaction[] => {
  const transactions = new Map<string, CommandTransaction>()
  for (const record of records) {
    if (!record.topic.endsWith('/services') && !record.topic.endsWith('/services_reply')) continue
    try {
      const payload = JSON.parse(record.payload) as {
        tid?: string
        bid?: string
        method?: string
        data?: { result?: unknown }
      }
      if (!payload.tid) continue
      const gatewaySn = extractTopicSn(record.topic) ?? ''
      const transactionKey = `${gatewaySn}:${payload.tid}`
      if (record.direction === 'out' && record.topic.endsWith('/services')) {
        transactions.set(transactionKey, {
          tid: payload.tid,
          bid: payload.bid,
          method: payload.method ?? 'unknown',
          gatewaySn,
          startedAt: record.timestamp,
          status: 'pending',
          request: record,
        })
      } else if (record.direction === 'in' && record.topic.endsWith('/services_reply')) {
        const pending = transactions.get(transactionKey)
        if (!pending) continue
        if (pending.bid && payload.bid && pending.bid !== payload.bid) continue
        const result = finiteInteger(payload.data?.result)
        transactions.set(transactionKey, {
          ...pending,
          finishedAt: record.timestamp,
          result,
          status: result === undefined || result === 0 ? 'success' : 'failed',
          response: record,
        })
      }
    } catch {
      // Raw non-JSON messages remain available in the MQTT console.
    }
  }

  return [...transactions.values()]
    .map((transaction) =>
      transaction.status === 'pending' && now - transaction.startedAt > 10_000
        ? { ...transaction, status: 'timeout' as const }
        : transaction,
    )
    .sort((a, b) => b.startedAt - a.startedAt)
}

export const telemetryValue = (source: Record<string, unknown>, path: string): unknown => {
  const parts = path.split('.')
  let value: unknown = source
  for (const part of parts) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

export const formatValue = (value: unknown): string => {
  if (value === undefined || value === null || value === '') return '--'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
