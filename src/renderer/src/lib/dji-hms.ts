import { normalizeHmsErrorCode } from './dji-error-codes'

export const HMS_LIST_LIMIT = 20

export const HMS_LEVEL_LABELS: Record<number, string> = {
  0: '通知',
  1: '提醒',
  2: '警告',
}

export const HMS_MODULE_LABELS: Record<number, string> = {
  0: '飞行任务',
  1: '设备管理',
  2: '媒体',
  3: 'HMS',
}

export interface HmsAlarmArgs {
  componentIndex?: number
  sensorIndex?: number
}

export interface HmsAlarm {
  code: string
  normalizedCode?: string
  level?: number
  module?: number
  inTheSky?: number
  deviceType?: string
  imminent?: number
  args?: HmsAlarmArgs
}

export interface HmsPayload {
  tid?: string
  bid?: string
  timestamp?: number
  alarms: HmsAlarm[]
  exceedsListLimit: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

const optionalInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined

const parseAlarm = (value: unknown): HmsAlarm | undefined => {
  if (!isRecord(value)) return undefined

  const rawCode = typeof value.code === 'number'
    ? String(value.code)
    : optionalString(value.code)
  if (!rawCode) return undefined

  const rawArgs = isRecord(value.args) ? value.args : undefined
  const componentIndex = optionalInteger(rawArgs?.component_index)
  const sensorIndex = optionalInteger(rawArgs?.sensor_index)
  const args = componentIndex === undefined && sensorIndex === undefined
    ? undefined
    : { componentIndex, sensorIndex }

  return {
    code: rawCode,
    normalizedCode: normalizeHmsErrorCode(rawCode),
    level: optionalInteger(value.level),
    module: optionalInteger(value.module),
    inTheSky: optionalInteger(value.in_the_sky),
    deviceType: optionalString(value.device_type),
    imminent: optionalInteger(value.imminent),
    args,
  }
}

export const parseHmsPayload = (payload: string): HmsPayload | undefined => {
  try {
    const envelope = JSON.parse(payload) as unknown
    if (!isRecord(envelope) || envelope.method !== 'hms') return undefined

    const data = isRecord(envelope.data) ? envelope.data : undefined
    const list = Array.isArray(data?.list) ? data.list : []
    return {
      tid: optionalString(envelope.tid),
      bid: optionalString(envelope.bid),
      timestamp: optionalInteger(envelope.timestamp),
      alarms: list.flatMap((entry) => {
        const alarm = parseAlarm(entry)
        return alarm ? [alarm] : []
      }),
      exceedsListLimit: list.length > HMS_LIST_LIMIT,
    }
  } catch {
    return undefined
  }
}

export const hmsLevelLabel = (level?: number): string =>
  level === undefined ? '未上报' : HMS_LEVEL_LABELS[level] ?? `未知 (${level})`

export const hmsModuleLabel = (module?: number): string =>
  module === undefined ? '未上报' : HMS_MODULE_LABELS[module] ?? `未知 (${module})`

export const hmsFlightStateLabel = (inTheSky?: number): string => {
  if (inTheSky === 0) return '在地上'
  if (inTheSky === 1) return '在天上'
  return inTheSky === undefined ? '未上报' : `未知 (${inTheSky})`
}

export const hmsImminentLabel = (imminent?: number): string => {
  if (imminent === 0) return '非实时性'
  if (imminent === 1) return '实时性'
  return imminent === undefined ? '未上报' : `未知 (${imminent})`
}
