import type { MapTileSource, MapTileSourceKind } from '../../../shared/contracts'
import { TERRAIN_SOURCE_KINDS } from '../../../shared/contracts'

/**
 * 地形层专用的三类来源类型。
 *
 * 直接由契约里的 {@link TERRAIN_SOURCE_KINDS} 构造，主进程的令牌分流用的是同一份清单，
 * 两处判断不可能各写各的而逐渐漂移。
 */
const TERRAIN_KINDS: ReadonlySet<MapTileSourceKind> = new Set<MapTileSourceKind>(TERRAIN_SOURCE_KINDS)

/** 地形源配置预设 */
export interface TerrainSourcePreset {
  /** 预设名称 */
  name: string
  /** 对应的来源类型，只能是 terrain-* 三类之一 */
  kind: MapTileSourceKind
  /** 是否需要用户自备访问令牌（access token / API Key） */
  requiresToken: boolean
  /** 面向用户的说明文案，含注册地址与收费说明 */
  help: string
}

/**
 * 地形源预设清单。
 *
 * 两项都由厂商托管地形服务承载，用户需要自行注册账号换取访问令牌，因此 `requiresToken` 均为 true；
 * 说明文案必须写明注册地址与「注册免费、额度与条款以厂商为准」，否则用户会以为要付费才能用，
 * 或误以为厂商服务可以无限量使用。
 */
export const TERRAIN_PRESETS: readonly TerrainSourcePreset[] = Object.freeze([
  {
    name: 'Cesium World Terrain',
    kind: 'terrain-ion',
    requiresToken: true,
    help: '在 cesium.com/ion 免费注册 Cesium ion 账号即可领取 access token；免费额度与服务条款以 Cesium 官方说明为准。'
      + '把 Access Token 填到下方即可加载 Cesium World Terrain 全球地形。',
  },
  {
    name: 'ArcGIS WorldElevation3D',
    kind: 'terrain-arcgis',
    requiresToken: true,
    help: '在 developers.arcgis.com 免费注册 ArcGIS 开发者账号并创建 API Key；免费额度与服务条款以 Esri 官方说明为准。'
      + '把 API Key 填到下方即可加载 ArcGIS WorldElevation3D 全球地形。',
  },
])

/**
 * 判断来源类型是否属于地形层专用的 terrain-* 三类。
 *
 * 地形源与影像源共用 `MapTileSource` 结构，按 kind 分流是最省事的判据；
 * 图层字段（layer）在草稿尚未定型时可能滞后，因此不参与判定。
 *
 * @param kind 底图源类型
 * @returns 属于 terrain-ion / terrain-arcgis / terrain-url 时返回 true
 */
export const isTerrainKind = (kind: MapTileSourceKind): boolean => TERRAIN_KINDS.has(kind)

/**
 * 创建一份待配置的地形源草稿。
 *
 * 与弹窗里影像用的 `createMapTileSource()` 平行：字段默认值逐一对齐，
 * 只有 layer 固定为 terrain、kind 由调用方给定，便于两处一起演进。
 * terrain-ion / terrain-arcgis 不需要地址，terrain-url 的地址由用户后续填写，故 urlTemplate 留空。
 *
 * @param kind 地形源类型，调用方需传入 terrain-* 三类之一
 * @returns 空的地形源草稿
 */
export const createTerrainSource = (kind: MapTileSourceKind): MapTileSource => ({
  id: '',
  name: '',
  layer: 'terrain',
  kind,
  urlTemplate: '',
  path: '',
  headers: [],
  coordinateSystem: 'wgs84',
  minZoom: 0,
  maxZoom: 19,
  tileSize: 256,
  tileExtension: '',
  attribution: '',
  isDefault: false,
  createdAt: Date.now(),
  updatedAt: Date.now(),
})

/**
 * 校验地形源草稿，返回可直接展示给用户的中文问题列表。
 *
 * 与主进程 `validateMapTileSourceKind` 中 terrain-* 分支保持同样的规则：
 * terrain-ion / terrain-arcgis 由厂商服务承载，不要求任何地址字段；
 * terrain-url 复用 urlTemplate 存放地形服务根地址，必须是非空的 HTTP/HTTPS 地址。
 *
 * @param source 地形源草稿
 * @returns 问题列表；无问题时为空数组
 */
export const terrainSourceIssues = (source: MapTileSource): string[] => {
  if (source.kind !== 'terrain-url') return []

  const address = source.urlTemplate.trim()
  if (!address) return ['请填写地形服务地址']

  let parsed: URL | undefined
  try {
    parsed = new URL(address)
  } catch {
    // 解析失败同样按地址不合法提示，主进程对两种情况给出的是同一句文案
    return ['地形服务地址仅支持 HTTP 或 HTTPS']
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return ['地形服务地址仅支持 HTTP 或 HTTPS']
  }
  return []
}
