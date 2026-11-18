import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, FolderOpen, Plus, Save, Star, Trash2, X } from 'lucide-react'
import type {
  MapCoordinateSystem,
  MapLayerKind,
  MapTileProbeResult,
  MapTileSource,
  MapTileSourceKind,
  OperationResult,
} from '../../../shared/contracts'
import { SecretInput } from './SecretInput'
import { Tooltip } from './Tooltip'
import {
  TERRAIN_PRESETS,
  createTerrainSource,
  isTerrainKind,
  terrainSourceIssues,
} from '../lib/terrain-source'
import type { TerrainSourcePreset } from '../lib/terrain-source'

/** 底图源配置预设 */
export interface MapTileSourcePreset {
  /** 预设名称 */
  name: string
  /** 图层类型 */
  layer: MapLayerKind
  /** 完整 URL 模板 */
  urlTemplate: string
  /** 坐标系 */
  coordinateSystem: MapCoordinateSystem
  /** 版权署名 */
  attribution: string
  /** 最大缩放级别 */
  maxZoom: number
  /** 是否必须填写 API Key */
  requiresApiKey: boolean
}

export const MAP_TILE_PRESETS: readonly MapTileSourcePreset[] = Object.freeze([
  {
    name: '高德矢量',
    layer: 'imagery',
    urlTemplate: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}&key={key}',
    coordinateSystem: 'gcj02',
    attribution: '© 高德地图',
    maxZoom: 18,
    requiresApiKey: true,
  },
  {
    name: '高德影像',
    layer: 'imagery',
    urlTemplate: 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}&key={key}',
    coordinateSystem: 'gcj02',
    attribution: '© 高德地图',
    maxZoom: 18,
    requiresApiKey: true,
  },
  {
    name: '天地图矢量',
    layer: 'imagery',
    urlTemplate: 'https://t{s}.tianditu.gov.cn/vec_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=vec&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk={key}',
    coordinateSystem: 'wgs84',
    attribution: '© 天地图',
    maxZoom: 18,
    requiresApiKey: true,
  },
  {
    name: '天地图影像',
    layer: 'imagery',
    urlTemplate: 'https://t{s}.tianditu.gov.cn/img_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=img&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk={key}',
    coordinateSystem: 'wgs84',
    attribution: '© 天地图',
    maxZoom: 18,
    requiresApiKey: true,
  },
  {
    name: 'OpenStreetMap',
    layer: 'imagery',
    urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    coordinateSystem: 'wgs84',
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
    requiresApiKey: false,
  },
])

const COORDINATE_SYSTEM_LABELS: Record<MapCoordinateSystem, string> = {
  wgs84: 'WGS-84（设备原始坐标，无需转换）',
  gcj02: 'GCJ-02（高德等国内底图）',
  bd09: 'BD-09（百度底图）',
}

const KIND_LABELS: Record<MapTileSourceKind, string> = {
  'url-template': '在线地址模板',
  directory: '本地瓦片目录',
  mbtiles: '本地 MBTiles 文件',
  // 三类地形来源由地形增量引入，弹窗仅在下拉中按需展示，标签保持中文
  'terrain-ion': 'Cesium ion 地形',
  'terrain-arcgis': 'ArcGIS 高程服务',
  'terrain-url': '自定义地形地址',
}

const LAYER_LABELS: Record<MapLayerKind, string> = {
  imagery: '影像',
  terrain: '地形',
}

/** 切到地形图层时的默认来源类型，取覆盖范围最广的 Cesium 全球地形 */
const DEFAULT_TERRAIN_KIND: MapTileSourceKind = 'terrain-ion'

/**
 * 列出某个图层可选的来源类型。
 *
 * 取值顺序沿用 `KIND_LABELS` 的声明顺序，与下拉框此前的顺序一致；地形三类由 `isTerrainKind` 判定，
 * 避免弹窗里再抄一份地形类型清单而与纯函数库脱节。
 *
 * @param layer 图层类型
 * @returns 该图层可选的来源类型
 */
export const mapTileSourceKindsForLayer = (layer: MapLayerKind): MapTileSourceKind[] =>
  (Object.keys(KIND_LABELS) as MapTileSourceKind[])
    .filter((kind) => (layer === 'terrain') === isTerrainKind(kind))

/**
 * 主进程拒绝的自定义请求头名称，与 `src/main/ipc-validation.ts` 的 `RESERVED_MAP_HEADER_NAMES` 保持一致。
 *
 * 此处只为提交前的即时反馈，真正的判定仍在主进程；修改本表时必须同步主进程，否则弹窗会放行、保存时才被拒。
 */
export const RESERVED_TILE_HEADER_NAMES: ReadonlySet<string> = new Set([
  'host',
  'connection',
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'upgrade',
])

/** 弹窗展示提示信息的回调 */
export type MapSourceNotify = (text: string, tone?: 'info' | 'success' | 'error') => void

/** 正在进行的命令，null 表示空闲 */
export type MapSourcePending = 'save' | 'probe' | null

/** 探测结果转成的提示文案 */
export interface MapSourceNotice {
  /** 提示正文 */
  text: string
  /** 提示语气 */
  tone: 'success' | 'error'
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * 创建一份待配置的底图源草稿。
 *
 * id 留空，由保存时在主进程补全，避免渲染进程自行生成标识。
 *
 * @returns 空的底图源草稿
 */
export const createMapTileSource = (): MapTileSource => ({
  id: '',
  name: '',
  layer: 'imagery',
  kind: 'url-template',
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
 * 计算切换图层后的草稿。
 *
 * 不能只把现有草稿的 layer 字段改掉：影像专属的本地路径、坐标系与缩放级别会留在草稿里，
 * 保存时被当成地形源的字段写进存储。这里按目标图层重建草稿，只保留与图层无关的标识与名称，
 * 使右侧表单「始终在编辑左侧选中的那一条」的语义在切换图层后依然成立。
 *
 * 重建时必须一并决定已存密钥的去留：API Key 按源 id 加密存储，切换图层不会丢掉 id，
 * 于是新服务会自动继承上一家服务的凭据——存着天地图 tk 的影像源切到地形后，
 * ion 请求会拿着别家的密钥去访问 cesium.com，而界面还提示「已保存，留空则不修改」。
 * 因此跨图层改 kind 时用 clearApiKey 标记待清空；切回源记录原本所属的图层时凭据仍然对得上，
 * 不能误清（clearApiKey 置 false），hasApiKey 则沿用草稿上已有的取值。
 *
 * @param draft 当前草稿
 * @param layer 目标图层
 * @param savedLayer 左侧选中的已保存源所属图层；表单在编辑尚未保存的草稿时为 undefined
 * @returns 切换后的草稿；目标图层与当前一致时原样返回
 */
export const mapTileSourceDraftForLayer = (
  draft: MapTileSource,
  layer: MapLayerKind,
  savedLayer?: MapLayerKind,
): MapTileSource => {
  if (draft.layer === layer) return draft
  const rebuilt = layer === 'terrain' ? createTerrainSource(DEFAULT_TERRAIN_KIND) : createMapTileSource()
  const keepsStoredKey = savedLayer === layer
  return {
    ...rebuilt,
    id: draft.id,
    name: draft.name,
    hasApiKey: keepsStoredKey ? Boolean(draft.hasApiKey) : false,
    // 草稿没对应任何已保存的源时没有凭据可清，savedLayer 为 undefined 必须落到 false
    clearApiKey: keepsStoredKey ? false : Boolean(savedLayer),
  }
}

/**
 * 把预设写到草稿上。
 *
 * 名称只在用户还没填写时才采用预设名，避免覆盖用户已经输入的内容；来源类型一律切回在线模板。
 *
 * @param draft 当前草稿
 * @param preset 要应用的预设
 * @returns 应用预设后的新草稿
 */
export const applyMapTilePreset = (draft: MapTileSource, preset: MapTileSourcePreset): MapTileSource => ({
  ...draft,
  name: draft.name.trim() || preset.name,
  layer: preset.layer,
  kind: 'url-template',
  urlTemplate: preset.urlTemplate,
  coordinateSystem: preset.coordinateSystem,
  attribution: preset.attribution,
  maxZoom: preset.maxZoom,
})

/**
 * 把地形预设写到草稿上。
 *
 * 与影像预设同构：名称只在用户还没填写时才采用预设名，标识沿用草稿；其余字段一律回到地形源的默认值，
 * 避免影像的本地路径、坐标系与缩放级别被带进地形源。
 *
 * @param draft 当前草稿
 * @param preset 要应用的地形预设
 * @returns 应用预设后的新草稿
 */
export const applyTerrainPreset = (draft: MapTileSource, preset: TerrainSourcePreset): MapTileSource => ({
  ...createTerrainSource(preset.kind),
  id: draft.id,
  name: draft.name.trim() || preset.name,
})

/**
 * 取与来源类型匹配的地形预设说明文案。
 *
 * 文案里含注册地址与「注册免费」的说明，是用户自备访问令牌的唯一线索，因此就地展示在令牌输入框下方。
 *
 * @param kind 底图源类型
 * @returns 说明文案；没有匹配预设的来源类型（例如自定义地形地址）返回空串
 */
export const terrainPresetHelp = (kind: MapTileSourceKind): string =>
  TERRAIN_PRESETS.find((preset) => preset.kind === kind)?.help ?? ''

/**
 * 计算地形源令牌输入框的占位提示。
 *
 * 三种地形来源的令牌出处不同，占位文案必须点名是哪一个（ion 的 Access Token、ArcGIS 的 API Key），
 * 否则用户不知道该往这里填什么；已经存过令牌时优先提示留空不改动，避免误清掉已保存的密钥。
 *
 * @param source 地形源草稿
 * @returns 占位提示文案
 */
export const terrainTokenPlaceholder = (source: MapTileSource): string => {
  if (source.hasApiKey) return '已保存，留空则不修改'
  if (source.kind === 'terrain-arcgis') return 'ArcGIS API Key，免费注册获取'
  if (source.kind === 'terrain-ion') return 'Cesium ion Access Token，免费注册获取'
  return '地形服务访问令牌，不需要则留空'
}

/**
 * 计算地形源令牌输入框的字段名。
 *
 * Cesium ion 的产品文案是 Access Token、ArcGIS 是 API Key，统一叫「API Key」会让拿着 ion token
 * 的用户不知道往哪个框填；自建地形服务没有厂商语义，用「访问令牌」并标注可选。
 *
 * @param source 地形源草稿
 * @returns 字段名
 */
export const terrainTokenLabel = (source: MapTileSource): string => {
  if (source.kind === 'terrain-arcgis') return 'ArcGIS API Key'
  if (source.kind === 'terrain-ion') return 'Cesium ion Access Token'
  return '访问令牌（可选）'
}

/** 预设按钮的展示与写入数据 */
export interface MapSourcePresetOption {
  /** 预设名称，同时用作按钮文案与列表 key */
  name: string
  /** 是否必须自备密钥，为真时按钮上标注「需 Key」 */
  requiresKey: boolean
  /** 把该预设写到草稿上的变换 */
  apply: (draft: MapTileSource) => MapTileSource
}

/**
 * 列出某个图层可用的预设选项。
 *
 * 影像与地形是两套结构不同的预设（影像带地址模板与坐标系，地形只有来源类型与访问令牌），
 * 这里统一收敛成同一种按钮数据，弹窗只渲染一套按钮，不必为地形另写一遍。
 *
 * @param layer 当前图层
 * @returns 该图层的预设选项，顺序与预设清单一致
 */
export const mapSourcePresetOptions = (layer: MapLayerKind): MapSourcePresetOption[] => layer === 'terrain'
  ? TERRAIN_PRESETS.map((preset) => ({
    name: preset.name,
    requiresKey: preset.requiresToken,
    apply: (draft: MapTileSource) => applyTerrainPreset(draft, preset),
  }))
  : MAP_TILE_PRESETS.map((preset) => ({
    name: preset.name,
    requiresKey: preset.requiresApiKey,
    apply: (draft: MapTileSource) => applyMapTilePreset(draft, preset),
  }))

/**
 * 取路径的最后一段作为底图源名称。
 *
 * 同时兼容 `/` 与 `\` 分隔符，并忽略结尾分隔符。
 *
 * @param path 本地绝对路径
 * @returns 最后一段路径；无法解析时返回空字符串
 */
export const mapTileSourceNameFromPath = (path: string): string =>
  path.split(/[\\/]/).filter(Boolean).at(-1) ?? ''

/**
 * 把用户选中的本地路径写到草稿上，并在名称为空时用路径末段补名。
 *
 * @param draft 当前草稿
 * @param path 用户选中的绝对路径
 * @returns 写入路径后的新草稿
 */
export const applyPickedPath = (draft: MapTileSource, path: string): MapTileSource => ({
  ...draft,
  path,
  name: draft.name.trim() || mapTileSourceNameFromPath(path),
})

/**
 * 决定是否需要按选中的底图源重新装载草稿。
 *
 * 只在「选中的标识与草稿所属标识不一致」时重装：保存成功后主进程会换回一份新的底图源列表，
 * 若跟着列表对象变化就重装，会清掉用户正在输入的内容。
 *
 * @param draft 当前草稿
 * @param sources 已保存的底图源列表
 * @param selectedId 当前选中的底图源标识
 * @returns 需要装载的草稿；返回 null 表示保持当前草稿不变
 */
export const reloadMapSourceDraft = (
  draft: MapTileSource,
  sources: MapTileSource[],
  selectedId: string,
): MapTileSource | null => {
  if (draft.id === selectedId) return null
  const selected = sources.find((source) => source.id === selectedId)
  return selected ? { ...selected } : createMapTileSource()
}

/**
 * 计算底图源草稿重装 effect 的依赖键。
 *
 * 选中项尚未出现在列表中时返回空串，出现后返回其 id。返回空串是因为
 * `listSources` 是异步的：若在列表到位前就用 selectedId 作为依赖，
 * 草稿会停在空态且不会重算，保存时会新建第二条源而不是更新选中的那条。
 * 列表因刷新而换了新对象、但选中项未变时，返回值不变，因此不会清掉正在输入的内容。
 *
 * @param sources 当前已加载的底图源列表
 * @param selectedId 当前选中的底图源 id
 * @returns 依赖键：选中项已加载时为该 id，否则为空串
 */
export const mapSourceReloadKey = (sources: MapTileSource[], selectedId: string): string =>
  sources.some((source) => source.id === selectedId) ? selectedId : ''

/**
 * 校验底图源草稿，返回可直接展示给用户的中文问题列表。
 *
 * 与主进程 `validateMapTileSource` 保持同样的规则，用于在提交前给出即时反馈；真正的判定仍在主进程。
 *
 * @param source 底图源草稿
 * @returns 问题列表；无问题时为空数组
 */
export const mapTileSourceIssues = (source: MapTileSource): string[] => {
  const issues: string[] = []
  if (!source.name.trim()) issues.push('请填写底图源名称')

  // 地形源只有「地址是否合法」一条规则（ion 与 ArcGIS 由厂商服务承载，不要求任何地址），
  // 表单在 terrain 图层也不渲染缩放级别与请求头，因此影像那几条规则一律不参与
  if (isTerrainKind(source.kind)) return [...issues, ...terrainSourceIssues(source)]

  if (source.kind === 'url-template') {
    const template = source.urlTemplate.trim()
    if (!template) {
      issues.push('请填写 URL 模板')
    } else {
      let parsed: URL | undefined
      try {
        parsed = new URL(template.replace(/\{[a-z]+\}/gi, '0'))
      } catch {
        issues.push('URL 模板格式无效')
      }
      if (parsed && parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        issues.push('URL 模板仅支持 HTTP 或 HTTPS')
      }
      for (const placeholder of ['{z}', '{x}', '{y}']) {
        if (!template.includes(placeholder)) issues.push(`URL 模板必须包含 ${placeholder} 占位符`)
      }
    }
  } else if (!source.path.trim()) {
    issues.push(source.kind === 'directory' ? '请选择瓦片目录' : '请选择 MBTiles 文件')
  } else if (source.kind === 'mbtiles' && !source.path.trim().toLowerCase().endsWith('.mbtiles')) {
    issues.push('MBTiles 路径必须以 .mbtiles 结尾')
  }

  if (!Number.isInteger(source.minZoom) || source.minZoom < 0 || source.minZoom > 22) {
    issues.push('最小缩放级别必须是 0 到 22 之间的整数')
  }
  if (!Number.isInteger(source.maxZoom) || source.maxZoom < 0 || source.maxZoom > 22) {
    issues.push('最大缩放级别必须是 0 到 22 之间的整数')
  } else if (source.maxZoom < source.minZoom) {
    issues.push('最大缩放级别不能小于最小缩放级别')
  }

  source.headers.forEach((header, index) => {
    const name = header.name.trim()
    if (!/^[A-Za-z0-9-]+$/.test(name)) {
      issues.push(`第 ${index + 1} 个请求头名称无效`)
    } else if (RESERVED_TILE_HEADER_NAMES.has(name.toLowerCase())) {
      issues.push(`第 ${index + 1} 个请求头使用了保留名称：${name}`)
    }
    if (/[\r\n]/.test(header.value)) {
      issues.push(`第 ${index + 1} 个请求头值不能包含换行`)
    }
  })

  return issues
}

/**
 * 组装提交给主进程的底图源载荷。
 *
 * API Key 只在用户真的填了内容时才带上：主进程把「不带 apiKey」当作「保留已存密钥」，
 * 因此留空必须是「键不存在」而不是空字符串，否则会静默清掉已保存的密钥。
 *
 * 用户真的填了密钥时还必须撤销草稿上待清空的 clearApiKey：主进程先看 clearApiKey 再看 apiKey，
 * 跨图层切换留下的清空标记若不同步撤销，新填的密钥会在保存时被静默丢掉。
 * 即「显式新密钥优先于待清空标记，留空仍表示保留已存密钥」。
 *
 * @param draft 当前草稿
 * @param apiKey 用户输入的 API Key 明文，两端空白会被去掉
 * @returns 提交用的底图源；API Key 为空时不含 `apiKey` 字段，且保留草稿原有的 `clearApiKey`
 */
export const buildMapTileSourcePayload = (draft: MapTileSource, apiKey: string): MapTileSource => {
  const trimmedApiKey = apiKey.trim()
  return trimmedApiKey ? { ...draft, apiKey: trimmedApiKey, clearApiKey: false } : { ...draft }
}

/**
 * 把探测结果转成提示文案，失败原因原样带出，便于用户判断是地址、密钥还是瓦片范围的问题。
 *
 * @param result 主进程返回的探测结果
 * @returns 提示正文与语气
 */
export const mapProbeNotice = (result: MapTileProbeResult): MapSourceNotice => result.ok
  ? { text: `底图源可用，探测到 ${result.bytes ?? 0} 字节瓦片`, tone: 'success' }
  : { text: `底图源不可用：${result.error ?? '未知原因'}`, tone: 'error' }

/**
 * 保存底图源草稿，并把结果转成提示文案。
 *
 * @param draft 当前草稿
 * @param apiKey 用户输入的 API Key 明文
 * @param onSave 保存底图源
 * @param onNotify 展示提示信息
 * @returns 保存后的底图源；失败时为 null
 */
export const saveMapSource = async (
  draft: MapTileSource,
  apiKey: string,
  onSave: (source: MapTileSource) => Promise<MapTileSource>,
  onNotify: MapSourceNotify,
): Promise<MapTileSource | null> => {
  try {
    const saved = await onSave(buildMapTileSourcePayload(draft, apiKey))
    onNotify('底图源已保存', 'success')
    return saved
  } catch (error) {
    onNotify(`保存底图源失败：${errorMessage(error)}`, 'error')
    return null
  }
}

/**
 * 探测底图源可用性，并把结果转成提示文案。
 *
 * @param draft 当前草稿
 * @param apiKey 用户输入的 API Key 明文
 * @param onProbe 探测底图源可用性
 * @param onNotify 展示提示信息
 * @returns 无返回值，结果通过 onNotify 呈现
 */
export const probeMapSource = async (
  draft: MapTileSource,
  apiKey: string,
  onProbe: (source: MapTileSource) => Promise<MapTileProbeResult>,
  onNotify: MapSourceNotify,
): Promise<void> => {
  try {
    const notice = mapProbeNotice(await onProbe(buildMapTileSourcePayload(draft, apiKey)))
    onNotify(notice.text, notice.tone)
  } catch (error) {
    onNotify(`探测底图源失败：${errorMessage(error)}`, 'error')
  }
}

/**
 * 删除底图源，并把结果转成提示文案。
 *
 * @param sourceId 底图源标识
 * @param onRemove 删除底图源
 * @param onNotify 展示提示信息
 * @returns 是否删除成功
 */
export const removeMapSource = async (
  sourceId: string,
  onRemove: (sourceId: string) => Promise<OperationResult>,
  onNotify: MapSourceNotify,
): Promise<boolean> => {
  try {
    const result = await onRemove(sourceId)
    if (!result.ok) {
      onNotify(result.error ?? '删除底图源失败', 'error')
      return false
    }
    onNotify('底图源已删除', 'success')
    return true
  } catch (error) {
    onNotify(`删除底图源失败：${errorMessage(error)}`, 'error')
    return false
  }
}

/**
 * 把选中的底图源设为默认，其余来源一律取消默认。
 *
 * 主进程保证同一时刻只有一条默认源，渲染进程的列表必须同步收敛：
 * 若只把选中项标成默认，地图仍会按 `isDefault` 取到列表中更靠前的那一条，表现为「点了没反应」。
 *
 * @param sources 当前底图源列表
 * @param saved 主进程返回的、已保存为默认的底图源
 * @returns 新的底图源列表
 */
export const mapSourcesWithDefault = (sources: MapTileSource[], saved: MapTileSource): MapTileSource[] =>
  sources.map((item) => (item.id === saved.id ? { ...saved, isDefault: true } : { ...item, isDefault: false }))

/**
 * 按当前列表计算新列表的更新入口，对应 `setState` 的函数式更新。
 *
 * 必须是函数式而不是整表覆盖：设为默认要等主进程保存返回，而保存会排在配置事务队列里，
 * WebDAV 上传期间这个等待可能很长，期间用户还能删除或新建底图源；用渲染时的快照整表覆盖，
 * 会把这期间的变化丢掉（复活已删除的行、丢掉刚新建的行），且列表只在挂载时加载一次，错了要到重启才恢复。
 *
 * @param updater 接收当前列表、返回新列表的更新函数
 * @returns 无返回值
 */
export type MapSourcesUpdater = (updater: (current: MapTileSource[]) => MapTileSource[]) => void

/**
 * 把指定的底图源设为默认，并把结果转成提示文案。
 *
 * @param source 要设为默认的底图源
 * @param onSave 保存底图源
 * @param onSourcesChange 按当前列表更新渲染进程的底图源列表
 * @param onNotify 展示提示信息
 * @returns 无返回值，结果通过 onSourcesChange 与 onNotify 呈现
 */
export const setDefaultMapSource = async (
  source: MapTileSource,
  onSave: (source: MapTileSource) => Promise<MapTileSource>,
  onSourcesChange: MapSourcesUpdater,
  onNotify: MapSourceNotify,
): Promise<void> => {
  if (source.isDefault) return
  try {
    const saved = await onSave({ ...source, isDefault: true })
    onSourcesChange((current) => mapSourcesWithDefault(current, saved))
    onNotify(`已将${source.name}设为默认底图源`, 'success')
  } catch (error) {
    onNotify(`设为默认底图源失败：${errorMessage(error)}`, 'error')
  }
}

/** 弹窗草稿状态 */
export interface MapSourceDraftState {
  /** 当前草稿 */
  draft: MapTileSource
  /** 用户输入的 API Key 明文 */
  apiKey: string
  /** 草稿的校验问题 */
  issues: string[]
  /** 用保存后的底图源覆盖草稿 */
  reset: (source: MapTileSource) => void
  /** 合并草稿字段 */
  update: (patch: Partial<MapTileSource>) => void
  /** 更新 API Key 明文 */
  replaceApiKey: (apiKey: string) => void
  /** 应用预设选项 */
  applyPreset: (option: MapSourcePresetOption) => void
  /** 切换图层，草稿按目标图层重建 */
  switchLayer: (layer: MapLayerKind) => void
  /** 应用选中的本地路径 */
  applyPath: (path: string) => void
}

/**
 * 维护底图源草稿的生命周期：装载、编辑与校验。
 *
 * @param sources 已保存的底图源列表
 * @param selectedId 当前选中的底图源标识
 * @returns 草稿状态与编辑入口
 */
export const useMapSourceDraft = (sources: MapTileSource[], selectedId: string): MapSourceDraftState => {
  const selected = sources.find((source) => source.id === selectedId)
  const [draft, setDraft] = useState<MapTileSource>(() => (selected ? { ...selected } : createMapTileSource()))
  const [apiKey, setApiKey] = useState('')
  // 仅作为 effect 的读取入口，避免把 sources 放进依赖后每次列表刷新都重装草稿
  const draftRef = useRef(draft)
  draftRef.current = draft
  const sourcesRef = useRef(sources)
  sourcesRef.current = sources

  useEffect(() => {
    const reloaded = reloadMapSourceDraft(draftRef.current, sourcesRef.current, selectedId)
    if (!reloaded) return
    setDraft(reloaded)
    setApiKey('')
  }, [mapSourceReloadKey(sources, selectedId)])

  const issues = useMemo(() => mapTileSourceIssues(draft), [draft])

  return {
    draft,
    apiKey,
    issues,
    reset: (source: MapTileSource) => setDraft({ ...source }),
    update: (patch: Partial<MapTileSource>) => setDraft((current) => ({ ...current, ...patch })),
    replaceApiKey: setApiKey,
    applyPreset: (option: MapSourcePresetOption) => setDraft((current) => option.apply(current)),
    switchLayer: (layer: MapLayerKind) => {
      // 明文密钥只在图层真的变化时清空：为上一层输入的密钥绝不能跟着提交给新图层的来源
      if (draft.layer !== layer) setApiKey('')
      setDraft((current) => mapTileSourceDraftForLayer(current, layer, selected?.layer))
    },
    applyPath: (path: string) => setDraft((current) => applyPickedPath(current, path)),
  }
}

/** 底图源配置弹窗的属性 */
export interface MapSourceModalProps {
  /** 已保存的底图源列表 */
  sources: MapTileSource[]
  /** 当前选中的底图源标识 */
  selectedId: string
  /** 切换选中的底图源 */
  onSelect: (sourceId: string) => void
  /** 保存底图源 */
  onSave: (source: MapTileSource) => Promise<MapTileSource>
  /** 按当前列表更新渲染进程的底图源列表 */
  onSourcesChange: MapSourcesUpdater
  /** 删除底图源 */
  onRemove: (sourceId: string) => Promise<OperationResult>
  /** 探测底图源可用性 */
  onProbe: (source: MapTileSource) => Promise<MapTileProbeResult>
  /** 选择本地瓦片目录 */
  onPickDirectory: () => Promise<string | null>
  /** 选择 MBTiles 文件 */
  onPickMbtiles: () => Promise<string | null>
  /** 关闭弹窗 */
  onClose: () => void
  /** 展示提示信息 */
  onNotify: MapSourceNotify
}

/** 弹窗命令的依赖与写入入口 */
export interface MapSourceCommandOptions {
  /** 当前草稿 */
  draft: MapTileSource
  /** 用户输入的 API Key 明文 */
  apiKey: string
  /** 草稿的校验问题 */
  issues: string[]
  /** 保存底图源 */
  onSave: (source: MapTileSource) => Promise<MapTileSource>
  /** 探测底图源可用性 */
  onProbe: (source: MapTileSource) => Promise<MapTileProbeResult>
  /** 删除底图源 */
  onRemove: (sourceId: string) => Promise<OperationResult>
  /** 切换选中的底图源 */
  onSelect: (sourceId: string) => void
  /** 展示提示信息 */
  onNotify: MapSourceNotify
  /** 用保存后的底图源覆盖草稿 */
  reset: (source: MapTileSource) => void
  /** 清空 API Key 输入框 */
  replaceApiKey: (apiKey: string) => void
}

/** 弹窗命令状态 */
export interface MapSourceCommandState {
  /** 正在进行的命令 */
  pending: MapSourcePending
  /** 保存当前草稿 */
  save: () => Promise<void>
  /** 探测当前草稿的可用性 */
  probe: () => Promise<void>
  /** 删除底图源并切回新建状态 */
  remove: (sourceId: string) => Promise<void>
}

/**
 * 把底图源的保存、探测与删除包装成带忙碌状态的处理器。
 *
 * 草稿存在校验问题时只提示第一条问题，不发起命令；命令结束后无论成败都会清空忙碌状态。
 *
 * @param options 草稿、回调与草稿写入入口
 * @returns 忙碌状态与三个命令
 */
export const useMapSourceCommands = (options: MapSourceCommandOptions): MapSourceCommandState => {
  const { draft, apiKey, issues, onSave, onProbe, onRemove, onSelect, onNotify, reset, replaceApiKey } = options
  const [pending, setPending] = useState<MapSourcePending>(null)

  const blockedByIssues = (): boolean => {
    if (!issues.length) return false
    onNotify(issues[0], 'error')
    return true
  }

  const run = async (command: MapSourcePending, task: () => Promise<void>): Promise<void> => {
    if (blockedByIssues()) return
    setPending(command)
    try {
      await task()
    } finally {
      setPending(null)
    }
  }

  const save = (): Promise<void> => run('save', async () => {
    const saved = await saveMapSource(draft, apiKey, onSave, onNotify)
    if (!saved) return
    // 主进程会剥离明文密钥并回填 hasApiKey，草稿必须跟着换成保存后的版本
    reset(saved)
    replaceApiKey('')
    onSelect(saved.id)
  })

  const probe = (): Promise<void> => run('probe', () => probeMapSource(draft, apiKey, onProbe, onNotify))

  const remove = async (sourceId: string): Promise<void> => {
    if (await removeMapSource(sourceId, onRemove, onNotify)) onSelect('')
  }

  return { pending, save, probe, remove }
}

/** 弹窗上「设为默认」的状态与入口 */
export interface MapSourceDefaultState {
  /** 正在被设为默认的底图源标识，空串表示空闲 */
  pendingDefaultId: string
  /** 把某条底图源设为默认 */
  setDefault: (source: MapTileSource) => Promise<void>
}

/**
 * 把「设为默认」包装成带忙碌标记的处理器。
 *
 * 与草稿的保存/探测分开：设为默认不读草稿，因此也不该被草稿的校验问题挡住。
 *
 * @param onSave 保存底图源
 * @param onSourcesChange 按当前列表更新渲染进程的底图源列表
 * @param onNotify 展示提示信息
 * @returns 忙碌标识与切换入口
 */
export const useMapSourceDefault = (
  onSave: (source: MapTileSource) => Promise<MapTileSource>,
  onSourcesChange: MapSourcesUpdater,
  onNotify: MapSourceNotify,
): MapSourceDefaultState => {
  const [pendingDefaultId, setPendingDefaultId] = useState('')

  const setDefault = async (source: MapTileSource): Promise<void> => {
    setPendingDefaultId(source.id)
    try {
      await setDefaultMapSource(source, onSave, onSourcesChange, onNotify)
    } finally {
      setPendingDefaultId('')
    }
  }

  return { pendingDefaultId, setDefault }
}

/** 弹窗左侧列表的属性 */
export interface MapSourceListProps {
  /** 已保存的底图源列表 */
  sources: MapTileSource[]
  /** 当前选中的底图源标识 */
  selectedId: string
  /** 正在被设为默认的底图源标识，空串表示空闲 */
  pendingDefaultId: string
  /** 切换选中的底图源，传空字符串表示新建 */
  onSelect: (sourceId: string) => void
  /** 把某条底图源设为默认 */
  onSetDefault: (source: MapTileSource) => Promise<void>
}

/**
 * 弹窗左侧的底图源列表。
 *
 * 每行由「选中」与「设为默认」两个独立按钮组成，默认标记就地展示，
 * 用户不必删掉当前底图源来等存储层顺势提升下一条。
 *
 * @param props 见 {@link MapSourceListProps}
 * @returns 列表区域
 */
export function MapSourceList({
  sources,
  selectedId,
  pendingDefaultId,
  onSelect,
  onSetDefault,
}: MapSourceListProps) {
  return (
    <aside className="map-source-list">
      <div className="map-source-list-header">
        <span>底图源</span>
        <Tooltip label="新建底图源">
          <button className="icon-button" aria-label="新建底图源" onClick={() => onSelect('')}>
            <Plus size={15} />
          </button>
        </Tooltip>
      </div>
      {sources.length === 0 && <p className="map-source-empty">尚未配置底图源</p>}
      {sources.map((source) => (
        <div key={source.id} className={`map-source-row ${source.id === selectedId ? 'active' : ''}`}>
          <button className="map-source-item" onClick={() => onSelect(source.id)}>
            <span className="map-source-item-name">{source.name}</span>
            <span className="map-source-item-meta">
              {KIND_LABELS[source.kind]}
              {source.isDefault && <em>默认</em>}
            </span>
          </button>
          <Tooltip label={source.isDefault ? '默认底图源' : '设为默认'}>
            <button
              className={`map-source-default ${source.isDefault ? 'active' : ''}`}
              aria-pressed={Boolean(source.isDefault)}
              disabled={source.isDefault || source.id === pendingDefaultId}
              onClick={() => void onSetDefault(source)}
            >
              <Star size={14} fill={source.isDefault ? 'currentColor' : 'none'} />
            </button>
          </Tooltip>
        </div>
      ))}
    </aside>
  )
}

/** 预设列表的属性 */
export interface MapSourcePresetPickerProps {
  /** 当前图层可用的预设选项 */
  options: MapSourcePresetOption[]
  /** 把选项写到当前草稿上 */
  onApply: (option: MapSourcePresetOption) => void
}

/**
 * 新建底图源时展示的预设入口。
 *
 * 影像与地形共用这套按钮：两边都收在 `MapSourcePresetOption` 里，缺省「需 Key」标注的规则也就只有一处。
 *
 * @param props 见 {@link MapSourcePresetPickerProps}
 * @returns 预设按钮组
 */
export function MapSourcePresetPicker({ options, onApply }: MapSourcePresetPickerProps) {
  return (
    <div className="map-source-presets">
      <span className="eyebrow">从预设开始</span>
      {options.map((option) => (
        <button key={option.name} className="button secondary compact" onClick={() => onApply(option)}>
          {option.name}
          {option.requiresKey && <em>需 Key</em>}
        </button>
      ))}
    </div>
  )
}

/** 图层单选控件的属性 */
export interface MapSourceLayerFieldProps {
  /** 当前草稿所属的图层 */
  layer: MapLayerKind
  /** 切换图层 */
  onLayerChange: (layer: MapLayerKind) => void
}

/**
 * 渲染影像 / 地形图层单选控件。
 *
 * 用按钮组而不是下拉：图层决定来源类型、坐标系与缩放级别是否出现，切换的后果比普通下拉的一个取值更重，
 * 两个按钮并排能让用户一眼看清当前处在哪一层。
 *
 * @param props 见 {@link MapSourceLayerFieldProps}
 * @returns 图层单选按钮组
 */
export function MapSourceLayerField({ layer, onLayerChange }: MapSourceLayerFieldProps) {
  return (
    <div className="field">
      <span>图层</span>
      <div className="segmented map-source-layer" role="group" aria-label="图层">
        {(Object.keys(LAYER_LABELS) as MapLayerKind[]).map((item) => (
          <button
            key={item}
            type="button"
            className={item === layer ? 'active' : ''}
            aria-pressed={item === layer}
            onClick={() => onLayerChange(item)}
          >
            {LAYER_LABELS[item]}
          </button>
        ))}
      </div>
    </div>
  )
}

/** 随来源类型切换的字段属性 */
export interface MapSourceKindFieldsProps {
  /** 当前草稿 */
  draft: MapTileSource
  /** 用户输入的 API Key 明文 */
  apiKey: string
  /** 合并草稿字段 */
  onDraftChange: (patch: Partial<MapTileSource>) => void
  /** 更新 API Key 明文 */
  onApiKeyChange: (apiKey: string) => void
  /** 选择本地路径 */
  onPickPath: () => Promise<void>
}

/**
 * 按来源类型渲染地址模板或本地路径字段。
 *
 * @param props 见 {@link MapSourceKindFieldsProps}
 * @returns 对应的字段组
 */
export function MapSourceKindFields({
  draft,
  apiKey,
  onDraftChange,
  onApiKeyChange,
  onPickPath,
}: MapSourceKindFieldsProps) {
  if (isTerrainKind(draft.kind)) {
    const help = terrainPresetHelp(draft.kind)
    return (
      <>
        {draft.kind === 'terrain-url' && (
          <label className="field">
            <span>地形服务地址</span>
            <input
              value={draft.urlTemplate}
              placeholder="https://example.com/terrain（quantized-mesh 服务根地址，即提供 layer.json 的地址）"
              onChange={(event) => onDraftChange({ urlTemplate: event.target.value })}
            />
          </label>
        )}
        <SecretInput
          label={terrainTokenLabel(draft)}
          value={apiKey}
          placeholder={terrainTokenPlaceholder(draft)}
          onChange={onApiKeyChange}
        />
        {help && <p className="map-source-hint">{help}</p>}
      </>
    )
  }

  if (draft.kind !== 'url-template') {
    return (
      <label className="field">
        <span>{draft.kind === 'directory' ? '瓦片目录' : 'MBTiles 文件'}</span>
        <div className="field-with-action">
          <input value={draft.path} readOnly onChange={() => undefined} />
          <button className="button secondary compact" onClick={() => void onPickPath()}>
            <FolderOpen size={15} />选择
          </button>
        </div>
      </label>
    )
  }

  return (
    <>
      <label className="field">
        <span>URL 模板</span>
        <input
          value={draft.urlTemplate}
          placeholder="https://example.com/{z}/{x}/{y}.png"
          onChange={(event) => onDraftChange({ urlTemplate: event.target.value })}
        />
      </label>
      <SecretInput
        label="API Key"
        value={apiKey}
        placeholder={draft.hasApiKey ? '已保存，留空则不修改' : '模板中的 {key} 占位符'}
        onChange={onApiKeyChange}
      />
    </>
  )
}

/** 坐标系字段的属性 */
export interface MapSourceCoordinateFieldProps {
  /** 当前草稿 */
  draft: MapTileSource
  /** 合并草稿字段 */
  onDraftChange: (patch: Partial<MapTileSource>) => void
}

/**
 * 渲染底图坐标系字段。
 *
 * 只有影像源需要它：地形源不参与设备点位的坐标系转换，因此 terrain 图层不渲染本字段。
 *
 * @param props 见 {@link MapSourceCoordinateFieldProps}
 * @returns 坐标系下拉字段
 */
export function MapSourceCoordinateField({ draft, onDraftChange }: MapSourceCoordinateFieldProps) {
  return (
    <label className="field">
      <span>坐标系</span>
      <select
        value={draft.coordinateSystem}
        onChange={(event) => onDraftChange({ coordinateSystem: event.target.value as MapCoordinateSystem })}
      >
        {(Object.keys(COORDINATE_SYSTEM_LABELS) as MapCoordinateSystem[]).map((system) => (
          <option key={system} value={system}>{COORDINATE_SYSTEM_LABELS[system]}</option>
        ))}
      </select>
    </label>
  )
}

/** 缩放级别与瓦片边长的属性 */
export interface MapSourceRangeFieldsProps {
  /** 当前草稿 */
  draft: MapTileSource
  /** 合并草稿字段 */
  onDraftChange: (patch: Partial<MapTileSource>) => void
}

/**
 * 渲染缩放级别与瓦片边长字段。
 *
 * @param props 见 {@link MapSourceRangeFieldsProps}
 * @returns 三列字段组
 */
export function MapSourceRangeFields({ draft, onDraftChange }: MapSourceRangeFieldsProps) {
  return (
    <div className="field-grid three-columns">
      <label className="field">
        <span>最小级别</span>
        <input
          type="number"
          min={0}
          max={22}
          value={draft.minZoom}
          onChange={(event) => onDraftChange({ minZoom: Number(event.target.value) })}
        />
      </label>
      <label className="field">
        <span>最大级别</span>
        <input
          type="number"
          min={0}
          max={22}
          value={draft.maxZoom}
          onChange={(event) => onDraftChange({ maxZoom: Number(event.target.value) })}
        />
      </label>
      <label className="field">
        <span>瓦片边长</span>
        <select
          value={draft.tileSize}
          onChange={(event) => onDraftChange({ tileSize: Number(event.target.value) === 512 ? 512 : 256 })}
        >
          <option value={256}>256</option>
          <option value={512}>512</option>
        </select>
      </label>
    </div>
  )
}

/** 校验问题列表的属性 */
export interface MapSourceIssueListProps {
  /** 草稿的校验问题 */
  issues: string[]
}

/**
 * 展示草稿的校验问题。
 *
 * @param props 见 {@link MapSourceIssueListProps}
 * @returns 问题列表；无问题时渲染为空
 */
export function MapSourceIssueList({ issues }: MapSourceIssueListProps) {
  if (!issues.length) return null
  return (
    <ul className="map-source-issues">
      {issues.map((issue) => <li key={issue}>{issue}</li>)}
    </ul>
  )
}

/** 底部操作按钮的属性 */
export interface MapSourceActionsProps {
  /** 正在进行的命令 */
  pending: MapSourcePending
  /** 校验问题数量，大于零时不允许保存 */
  issueCount: number
  /** 是否已选中已保存的底图源 */
  hasSource: boolean
  /** 保存当前草稿 */
  onSave: () => Promise<void>
  /** 探测当前草稿的可用性 */
  onProbe: () => Promise<void>
  /** 删除当前底图源 */
  onRemove: () => Promise<void>
}

/**
 * 渲染保存、探测与删除按钮。
 *
 * @param props 见 {@link MapSourceActionsProps}
 * @returns 操作按钮组
 */
export function MapSourceActions({
  pending,
  issueCount,
  hasSource,
  onSave,
  onProbe,
  onRemove,
}: MapSourceActionsProps) {
  return (
    <div className="map-source-actions">
      <button
        className="button primary"
        disabled={pending === 'save' || issueCount > 0}
        onClick={() => void onSave()}
      >
        <Save size={15} />{pending === 'save' ? '保存中' : '保存'}
      </button>
      <button className="button secondary" disabled={pending === 'probe'} onClick={() => void onProbe()}>
        <Check size={15} />{pending === 'probe' ? '探测中' : '测试可用性'}
      </button>
      {hasSource && (
        <button className="button danger-ghost" disabled={pending !== null} onClick={() => void onRemove()}>
          <Trash2 size={15} />删除
        </button>
      )}
    </div>
  )
}

/** 右侧表单的属性 */
export interface MapSourceFormProps {
  /** 当前草稿 */
  draft: MapTileSource
  /** 用户输入的 API Key 明文 */
  apiKey: string
  /** 草稿的校验问题 */
  issues: string[]
  /** 正在进行的命令 */
  pending: MapSourcePending
  /** 是否展示预设入口，仅新建时展示 */
  showPresets: boolean
  /** 是否已选中已保存的底图源 */
  hasSource: boolean
  /** 合并草稿字段 */
  onDraftChange: (patch: Partial<MapTileSource>) => void
  /** 更新 API Key 明文 */
  onApiKeyChange: (apiKey: string) => void
  /** 切换图层 */
  onLayerChange: (layer: MapLayerKind) => void
  /** 应用预设 */
  onApplyPreset: (option: MapSourcePresetOption) => void
  /** 选择本地路径 */
  onPickPath: () => Promise<void>
  /** 保存当前草稿 */
  onSave: () => Promise<void>
  /** 探测当前草稿的可用性 */
  onProbe: () => Promise<void>
  /** 删除当前底图源 */
  onRemove: () => Promise<void>
}

/**
 * 弹窗右侧的底图源表单。
 *
 * @param props 见 {@link MapSourceFormProps}
 * @returns 表单区域
 */
export function MapSourceForm({
  draft,
  apiKey,
  issues,
  pending,
  showPresets,
  hasSource,
  onDraftChange,
  onApiKeyChange,
  onLayerChange,
  onApplyPreset,
  onPickPath,
  onSave,
  onProbe,
  onRemove,
}: MapSourceFormProps) {
  return (
    <section className="map-source-form">
      {showPresets && (
        <MapSourcePresetPicker options={mapSourcePresetOptions(draft.layer)} onApply={onApplyPreset} />
      )}

      <MapSourceLayerField layer={draft.layer} onLayerChange={onLayerChange} />

      <label className="field">
        <span>名称</span>
        <input value={draft.name} onChange={(event) => onDraftChange({ name: event.target.value })} />
      </label>

      <label className="field">
        <span>来源类型</span>
        <select
          value={draft.kind}
          onChange={(event) => onDraftChange({ kind: event.target.value as MapTileSourceKind })}
        >
          {mapTileSourceKindsForLayer(draft.layer).map((kind) => (
            <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>
          ))}
        </select>
      </label>

      <MapSourceKindFields
        draft={draft}
        apiKey={apiKey}
        onDraftChange={onDraftChange}
        onApiKeyChange={onApiKeyChange}
        onPickPath={onPickPath}
      />

      {draft.layer === 'imagery' && (
        <>
          <MapSourceCoordinateField draft={draft} onDraftChange={onDraftChange} />
          <MapSourceRangeFields draft={draft} onDraftChange={onDraftChange} />
          <label className="field">
            <span>版权署名</span>
            <input value={draft.attribution} onChange={(event) => onDraftChange({ attribution: event.target.value })} />
          </label>
          <p className="map-source-hint">署名显示在地图底部；使用公开底图时请保留来源要求的署名。</p>
        </>
      )}

      <MapSourceIssueList issues={issues} />
      <MapSourceActions
        pending={pending}
        issueCount={issues.length}
        hasSource={hasSource}
        onSave={onSave}
        onProbe={onProbe}
        onRemove={onRemove}
      />
    </section>
  )
}

/**
 * 底图源配置弹窗：左侧管理已保存的底图源，右侧编辑当前草稿。
 *
 * @param props 见 {@link MapSourceModalProps}
 * @returns 弹窗
 */
export function MapSourceModal({
  sources,
  selectedId,
  onSelect,
  onSave,
  onSourcesChange,
  onRemove,
  onProbe,
  onPickDirectory,
  onPickMbtiles,
  onClose,
  onNotify,
}: MapSourceModalProps) {
  const selected = sources.find((source) => source.id === selectedId)
  const draftState = useMapSourceDraft(sources, selectedId)
  const { draft, apiKey, issues, update, replaceApiKey, applyPreset, switchLayer, applyPath } = draftState
  const { pending, save, probe, remove } = useMapSourceCommands({ ...draftState, onSave, onProbe, onRemove, onSelect, onNotify })
  const { pendingDefaultId, setDefault } = useMapSourceDefault(onSave, onSourcesChange, onNotify)

  const pickPath = async (): Promise<void> => {
    const picked = draft.kind === 'directory' ? await onPickDirectory() : await onPickMbtiles()
    if (picked) applyPath(picked)
  }

  const handleRemove = (): Promise<void> => selected ? remove(selected.id) : Promise.resolve()

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section className="modal map-source-modal" role="dialog" aria-modal="true" aria-label="底图源配置">
        <header className="modal-header">
          <div>
            <span className="eyebrow">地图</span>
            <h2>底图源配置</h2>
          </div>
          <Tooltip label="关闭">
            <button className="icon-button" aria-label="关闭" onClick={onClose}><X size={16} /></button>
          </Tooltip>
        </header>
        <div className="modal-body map-source-body">
          <MapSourceList
            sources={sources}
            selectedId={selectedId}
            pendingDefaultId={pendingDefaultId}
            onSelect={onSelect}
            onSetDefault={setDefault}
          />
          <MapSourceForm
            draft={draft}
            apiKey={apiKey}
            issues={issues}
            pending={pending}
            showPresets={!selected}
            hasSource={Boolean(selected)}
            onDraftChange={update}
            onApiKeyChange={replaceApiKey}
            onLayerChange={switchLayer}
            onApplyPreset={applyPreset}
            onPickPath={pickPath}
            onSave={save}
            onProbe={probe}
            onRemove={handleRemove}
          />
        </div>
      </section>
    </div>
  )
}
