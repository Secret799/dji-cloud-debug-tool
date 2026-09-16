import type { DeviceProvider, DeviceType } from '../../../shared/contracts'
import { telemetryValue, type DeviceTelemetry } from './dji'
import type { GeoPoint } from './map-coord'

export interface DevicePosition {
  /** 设备序列号 */
  sn: string
  /** 设备显示名称 */
  name: string
  /** 设备类型 */
  type: DeviceType
  /** 设备厂商 */
  provider: DeviceProvider
  /** 当前是否在线 */
  online: boolean
  /** 最后一次上报时间戳 */
  lastSeenAt: number
  /** 原始上报坐标，WGS-84 */
  wgs84: GeoPoint
  /** 原始上报高度，单位米；缺失时为空 */
  height?: number
  /** 飞行器 Home 点，WGS-84；机场或缺失时为空 */
  home?: GeoPoint
}

// 设备无定位时会上报 (0, 0)，该点位于几内亚湾，必须视为无定位
const isPlaceholderCoordinate = (latitude: number, longitude: number): boolean =>
  latitude === 0 && longitude === 0

const parseCoordinate = (
  source: Record<string, unknown>,
  latitudePath: string,
  longitudePath: string,
): GeoPoint | undefined => {
  const rawLatitude = telemetryValue(source, latitudePath)
  const rawLongitude = telemetryValue(source, longitudePath)
  if (typeof rawLatitude !== 'number' || typeof rawLongitude !== 'number') return undefined
  if (!Number.isFinite(rawLatitude) || !Number.isFinite(rawLongitude)) return undefined
  if (isPlaceholderCoordinate(rawLatitude, rawLongitude)) return undefined
  if (rawLatitude < -90 || rawLatitude > 90 || rawLongitude < -180 || rawLongitude > 180) return undefined
  return { latitude: rawLatitude, longitude: rawLongitude }
}

const parseHeight = (source: Record<string, unknown>): number | undefined => {
  const value = telemetryValue(source, 'height')
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 从设备遥测中提取地图所需的定位信息。
 *
 * 位置按 osd 优先、state 兜底的方式读取：不同机型与消息类型会把经纬度放在不同记录中。
 *
 * @param telemetry 设备遥测快照
 * @returns 定位信息；无有效定位时返回 undefined
 */
export const devicePosition = (telemetry: DeviceTelemetry): DevicePosition | undefined => {
  const osd = telemetry.osd ?? {}
  const state = telemetry.state ?? {}
  const wgs84 = parseCoordinate(osd, 'latitude', 'longitude')
    ?? parseCoordinate(state, 'latitude', 'longitude')
  if (!wgs84) return undefined

  const height = parseHeight(osd) ?? parseHeight(state)
  const home = telemetry.type === 'aircraft'
    ? parseCoordinate(osd, 'home_latitude', 'home_longitude')
      ?? parseCoordinate(state, 'home_latitude', 'home_longitude')
    : undefined

  return {
    sn: telemetry.sn,
    name: telemetry.name,
    type: telemetry.type,
    provider: telemetry.provider ?? 'dji',
    online: telemetry.online,
    lastSeenAt: telemetry.lastSeenAt,
    wgs84,
    ...(height === undefined ? {} : { height }),
    ...(home === undefined ? {} : { home }),
  }
}

/**
 * 批量提取设备定位，丢弃无有效定位的设备。
 *
 * 离线设备保留在结果中，以便地图继续显示其最后已知位置。
 *
 * @param telemetry 设备遥测快照列表
 * @returns 有效的设备定位列表
 */
export const devicePositions = (telemetry: DeviceTelemetry[]): DevicePosition[] =>
  telemetry.flatMap((device) => {
    const position = devicePosition(device)
    return position ? [position] : []
  })
