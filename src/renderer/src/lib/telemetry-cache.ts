import type { DeviceProvider, DeviceType, DjiDeviceIdentity } from '../../../shared/contracts'
import type { DeviceTelemetry } from './dji'

const STORAGE_KEY = 'dji-cloud-studio.telemetry-cache.v1'
const MAX_CACHE_DEVICES = 1_000
const MAX_CACHE_BYTES = 8 * 1024 * 1024
const DEVICE_TYPES = new Set<DeviceType>(['dock', 'aircraft', 'pilot'])
const DEVICE_PROVIDERS = new Set<DeviceProvider>(['dji', 'superdock'])

interface TelemetryCacheDocument {
  version: 1
  devices: DeviceTelemetry[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const withoutRuntimeOnlyState = (value: Record<string, unknown>): Record<string, unknown> => {
  const next = { ...value }
  delete next.live_status
  return next
}

const parseIdentity = (value: unknown): DjiDeviceIdentity | undefined => {
  if (!isRecord(value)) return undefined
  if (
    typeof value.domain !== 'string'
    || !Number.isInteger(value.productType)
    || !Number.isInteger(value.productSubType)
  ) return undefined
  if (value.channelIndex !== undefined && typeof value.channelIndex !== 'string') return undefined
  if (value.thingVersion !== undefined && typeof value.thingVersion !== 'string') return undefined
  return value as unknown as DjiDeviceIdentity
}

const parseDevice = (value: unknown): DeviceTelemetry | undefined => {
  if (!isRecord(value)) return undefined
  if (
    typeof value.profileId !== 'string'
    || !value.profileId
    || typeof value.sn !== 'string'
    || !value.sn
    || typeof value.type !== 'string'
    || !DEVICE_TYPES.has(value.type as DeviceType)
    || typeof value.name !== 'string'
    || typeof value.lastSeenAt !== 'number'
    || !Number.isFinite(value.lastSeenAt)
    || typeof value.lastTopic !== 'string'
    || !isRecord(value.osd)
    || !isRecord(value.state)
    || !isRecord(value.status)
  ) return undefined
  if (value.gatewaySn !== undefined && typeof value.gatewaySn !== 'string') return undefined
  if (value.provider !== undefined && (typeof value.provider !== 'string' || !DEVICE_PROVIDERS.has(value.provider as DeviceProvider))) {
    return undefined
  }

  const identity = value.identity === undefined ? undefined : parseIdentity(value.identity)
  if (value.identity !== undefined && !identity) return undefined
  return {
    profileId: value.profileId,
    sn: value.sn,
    gatewaySn: value.gatewaySn,
    type: value.type as DeviceType,
    provider: value.provider as DeviceProvider | undefined,
    name: value.name,
    online: false,
    lastSeenAt: value.lastSeenAt,
    lastTopic: value.lastTopic,
    identity,
    osd: withoutRuntimeOnlyState(value.osd),
    state: withoutRuntimeOnlyState(value.state),
    status: withoutRuntimeOnlyState(value.status),
  }
}

export const parseTelemetryCache = (value: unknown): Record<string, DeviceTelemetry> => {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.devices)) return {}
  const devices: Record<string, DeviceTelemetry> = {}
  value.devices.slice(0, MAX_CACHE_DEVICES).forEach((candidate) => {
    const device = parseDevice(candidate)
    if (!device) return
    const key = `${device.profileId}:${device.sn}`
    if (!devices[key] || devices[key].lastSeenAt < device.lastSeenAt) devices[key] = device
  })
  return devices
}

export const serializeTelemetryCache = (
  telemetry: Record<string, DeviceTelemetry>,
  maxBytes = MAX_CACHE_BYTES,
): string => {
  const encoder = new TextEncoder()
  const prefix = '{"version":1,"devices":['
  const suffix = ']}'
  let usedBytes = encoder.encode(prefix + suffix).byteLength
  const serializedDevices: string[] = []

  Object.values(telemetry)
    .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
    .slice(0, MAX_CACHE_DEVICES)
    .forEach((device) => {
      const serialized = JSON.stringify({
        ...device,
        online: false,
        osd: withoutRuntimeOnlyState(device.osd),
        state: withoutRuntimeOnlyState(device.state),
        status: withoutRuntimeOnlyState(device.status),
      })
      const size = encoder.encode(`${serializedDevices.length ? ',' : ''}${serialized}`).byteLength
      if (usedBytes + size > maxBytes) return
      serializedDevices.push(serialized)
      usedBytes += size
    })

  return `${prefix}${serializedDevices.join(',')}${suffix}`
}

export const loadTelemetryCache = (): Record<string, DeviceTelemetry> => {
  if (typeof window === 'undefined') return {}
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return stored ? parseTelemetryCache(JSON.parse(stored) as unknown) : {}
  } catch {
    return {}
  }
}

export const saveTelemetryCache = (telemetry: Record<string, DeviceTelemetry>): boolean => {
  if (typeof window === 'undefined') return false
  try {
    window.localStorage.setItem(STORAGE_KEY, serializeTelemetryCache(telemetry))
    return true
  } catch {
    return false
  }
}
