import type { MapCoordinateSystem } from '../../../shared/contracts'

export interface GeoPoint {
  latitude: number
  longitude: number
}

const PI = Math.PI
// 克拉索夫斯基椭球参数
const SEMI_MAJOR_AXIS = 6378245.0
const ECCENTRICITY_SQUARED = 0.00669342162296594323
const X_PI = PI * 3000.0 / 180.0

/**
 * 判断坐标是否落在国境判定范围内。
 *
 * GCJ-02 只在中国境内偏移，境外必须原样返回，否则会凭空引入数百米误差。
 *
 * @param latitude 纬度，单位度
 * @param longitude 经度，单位度
 * @returns 位于判定范围内返回 true
 */
export const isInsideChina = (latitude: number, longitude: number): boolean =>
  longitude >= 72.004 && longitude <= 137.8347 && latitude >= 0.8293 && latitude <= 55.8271

const transformLatitude = (x: number, y: number): number => {
  let result = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  result += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0
  result += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0
  result += (160.0 * Math.sin(y / 12.0 * PI) + 320 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0
  return result
}

const transformLongitude = (x: number, y: number): number => {
  let result = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  result += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0
  result += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0
  result += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0
  return result
}

/**
 * WGS-84 转 GCJ-02。
 *
 * 设备上报的是 WGS-84，高德等国内底图使用 GCJ-02。公开算法本身有 1~2 米量级误差，
 * 相对需要修正的数百米偏移可忽略，但界面必须同时展示原始 WGS-84 读数。
 *
 * @param point WGS-84 坐标
 * @returns GCJ-02 坐标；境外原样返回
 */
export const wgs84ToGcj02 = ({ latitude, longitude }: GeoPoint): GeoPoint => {
  if (!isInsideChina(latitude, longitude)) return { latitude, longitude }
  let deltaLatitude = transformLatitude(longitude - 105.0, latitude - 35.0)
  let deltaLongitude = transformLongitude(longitude - 105.0, latitude - 35.0)
  const radianLatitude = latitude / 180.0 * PI
  let magic = Math.sin(radianLatitude)
  magic = 1 - ECCENTRICITY_SQUARED * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  deltaLatitude = (deltaLatitude * 180.0) / ((SEMI_MAJOR_AXIS * (1 - ECCENTRICITY_SQUARED)) / (magic * sqrtMagic) * PI)
  deltaLongitude = (deltaLongitude * 180.0) / (SEMI_MAJOR_AXIS / sqrtMagic * Math.cos(radianLatitude) * PI)
  return { latitude: latitude + deltaLatitude, longitude: longitude + deltaLongitude }
}

/**
 * GCJ-02 转 BD-09。百度底图使用 BD-09，必须经 GCJ-02 中转而非直接从 WGS-84 计算。
 *
 * @param point GCJ-02 坐标
 * @returns BD-09 坐标
 */
export const gcj02ToBd09 = ({ latitude, longitude }: GeoPoint): GeoPoint => {
  const radius = Math.sqrt(longitude * longitude + latitude * latitude) + 0.00002 * Math.sin(latitude * X_PI)
  const theta = Math.atan2(latitude, longitude) + 0.000003 * Math.cos(longitude * X_PI)
  return { latitude: radius * Math.sin(theta) + 0.006, longitude: radius * Math.cos(theta) + 0.0065 }
}

/**
 * 按目标底图坐标系转换坐标。只做单向转换，反算需要迭代逼近，本期用不到。
 *
 * @param point 原始 WGS-84 坐标
 * @param system 目标底图坐标系
 * @returns 目标坐标系下的坐标
 */
export const toCoordinateSystem = (point: GeoPoint, system: MapCoordinateSystem): GeoPoint => {
  if (system === 'wgs84') return point
  const gcj02 = wgs84ToGcj02(point)
  return system === 'gcj02' ? gcj02 : gcj02ToBd09(gcj02)
}
