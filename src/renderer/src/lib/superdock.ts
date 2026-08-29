import type {
  DeviceProvider,
  DjiDeviceIdentity,
  DockModel,
} from '../../../shared/contracts'
import {
  isSuperDockModel,
  resolveDeviceProvider,
} from '../../../shared/device-provider'
import type { CommandTemplate } from './dji'

export interface SuperDockModelOption {
  key: DockModel
  label: string
  productType: number
}

export const SUPERDOCK_DOC_URL = 'https://docs.sb.im/api-integration/api-reference/topic-definition'
export const SUPERDOCK_PROPERTY_DOC_URL = 'https://docs.sb.im/api-integration/api-reference/superdock-hangar/properties'
export const SUPERDOCK_COMMAND_DOC_URL = 'https://docs.sb.im/api-integration/api-reference/superdock-hangar/cmd'
export const SUPERDOCK_COMPATIBILITY_DOC_URL = 'https://docs.sb.im/api-integration/developers/compatibility-comparison'
export const SUPERDOCK_PROPERTY_DOC_DATE = '2026-08-28'

export const SUPERDOCK_MODELS: readonly SuperDockModelOption[] = Object.freeze([
  { key: 's22m300', label: 'SuperDock S22M300', productType: 88097 },
  { key: 's2201', label: 'SuperDock S2201', productType: 88098 },
  { key: 's2301', label: 'SuperDock S2301', productType: 88099 },
  { key: 's24m350', label: 'SuperDock S24M350', productType: 88100 },
  { key: 's24m350s', label: 'SuperDock S24M350S', productType: 88101 },
  { key: 's24m3', label: 'SuperDock S24M3', productType: 88102 },
  { key: 's24m4', label: 'SuperDock S24M4', productType: 88103 },
  { key: 's25m4', label: 'SuperDock S25M4', productType: 88104 },
  { key: 's25m400', label: 'SuperDock S25M400', productType: 88105 },
  { key: 's25m400s', label: 'SuperDock S25M400S', productType: 88106 },
])

const SUPERDOCK_MODEL_BY_KEY = new Map(SUPERDOCK_MODELS.map((model) => [model.key, model]))
const SUPERDOCK_MODEL_BY_PRODUCT_TYPE = new Map(SUPERDOCK_MODELS.map((model) => [model.productType, model]))

export { isSuperDockModel }

export const defaultDockModel = (provider: DeviceProvider): DockModel =>
  provider === 'superdock' ? 's24m4' : 'dock2'

export const deviceProvider = resolveDeviceProvider

export const providerFromIdentity = (identity: DjiDeviceIdentity | undefined): DeviceProvider =>
  identity?.domain === '3' && SUPERDOCK_MODEL_BY_PRODUCT_TYPE.has(identity.productType) ? 'superdock' : 'dji'

export const superDockProductName = (identity: DjiDeviceIdentity | undefined): string | undefined =>
  identity?.domain === '3' ? SUPERDOCK_MODEL_BY_PRODUCT_TYPE.get(identity.productType)?.label : undefined

export const dockModelName = (model: DockModel | undefined, provider: DeviceProvider = 'dji'): string => {
  if (!model) return provider === 'superdock' ? 'SuperDock 机场' : 'DJI Dock 2'
  if (model === 'dock2') return 'DJI Dock 2'
  if (model === 'dock3') return 'DJI Dock 3'
  if (model && SUPERDOCK_MODEL_BY_KEY.has(model)) return SUPERDOCK_MODEL_BY_KEY.get(model)?.label ?? model
  return provider === 'superdock' ? 'SuperDock 机场' : '其他机场型号'
}

export const SUPERDOCK_COMMANDS: readonly CommandTemplate[] = Object.freeze([
  {
    id: 'putter-open',
    category: 'debug',
    label: '展开推杆',
    method: 'putter_open',
    description: '展开 SuperDock 推杆',
    danger: true,
    requiresDebug: true,
    data: {},
  },
  {
    id: 'putter-close',
    category: 'debug',
    label: '闭合推杆',
    method: 'putter_close',
    description: '闭合 SuperDock 推杆',
    danger: true,
    requiresDebug: true,
    data: {},
  },
  {
    id: 'lte-verification',
    category: 'debug',
    label: '发送 4G 校验码',
    method: 'lte_verification',
    description: '向指定手机号发送 SuperDock 4G 控制校验码',
    data: { phone_area_code: '86', phone_number: '' },
  },
  {
    id: 'lte-auth',
    category: 'debug',
    label: '验证 4G 校验码',
    method: 'lte_auth',
    description: '提交校验码并启用 SuperDock 4G 控制方式',
    data: { phone_area_code: '86', phone_number: '', verification_code: '' },
  },
])

export const SUPERDOCK_ONLY_COMMAND_METHODS = new Set(
  SUPERDOCK_COMMANDS.map((command) => command.method),
)

export const SUPERDOCK_UNSUPPORTED_COMMAND_METHODS = new Set([
  'cover_force_close',
  'supplement_light_open',
  'supplement_light_close',
  'battery_maintenance_switch',
  'battery_store_mode_switch',
  'air_conditioner_mode_switch',
  'alarm_state_switch',
  'esim_activate',
  'sim_slot_switch',
  'esim_operator_switch',
  'drone_format',
  'device_format',
  'fly_to_point_update',
  'poi_mode_enter',
  'poi_mode_exit',
  'poi_circle_speed_set',
  'camera_screen_split',
  'photo_storage_set',
  'video_storage_set',
  'camera_exposure_mode_set',
  'camera_exposure_set',
  'camera_focus_mode_set',
  'camera_focus_value_set',
  'joystick_invalid_notify',
  'poi_status_notify',
  'camera_photo_take_progress',
  'hsi_info_push',
  'delay_info_push',
  'ota_create',
  'fileupload_list',
  'fileupload_start',
  'fileupload_update',
])

// The compatibility matrix is intentionally more conservative than the command reference.
export const SUPERDOCK_REMOTE_DEBUG_METHODS = new Set([
  'debug_mode_open',
  'debug_mode_close',
  'device_reboot',
  'drone_open',
  'drone_close',
  'cover_open',
  'cover_close',
  'charge_open',
  'charge_close',
  'sdr_workmode_switch',
  'rtk_calibration',
  'putter_open',
  'putter_close',
  'lte_verification',
  'lte_auth',
])

export const SUPERDOCK_SUPPORTED_COMMAND_METHODS = new Set([
  ...SUPERDOCK_REMOTE_DEBUG_METHODS,
  'flight_authority_grab',
  'drc_mode_exit',
  'takeoff_to_point',
  'return_home',
  'return_home_cancel',
  'drone_emergency_stop',
  'payload_authority_grab',
  'camera_photo_take',
  'camera_recording_start',
  'camera_recording_stop',
  'gimbal_reset',
  'custom_data_transmission_to_psdk',
  'speaker_tts_play_start',
  'speaker_play_volume_set',
  'speaker_play_stop',
  'live_start_push',
  'live_stop_push',
  'live_set_quality',
  'live_camera_change',
])

export const superDockSupportsCommand = (command: Pick<CommandTemplate, 'category' | 'method'>): boolean =>
  SUPERDOCK_SUPPORTED_COMMAND_METHODS.has(command.method)

export const isValidSuperDockLtePhone = (areaCode: string, phoneNumber: string): boolean => {
  const normalizedAreaCode = areaCode.trim()
  const normalizedPhoneNumber = phoneNumber.trim()
  return /^[1-9]\d{0,2}$/.test(normalizedAreaCode)
    && /^\d{4,14}$/.test(normalizedPhoneNumber)
    && normalizedAreaCode.length + normalizedPhoneNumber.length <= 15
}

export const isValidSuperDockLteVerificationCode = (value: string): boolean =>
  /^\d{4,8}$/.test(value.trim())
