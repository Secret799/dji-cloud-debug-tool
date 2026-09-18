// 副作用导入必须排在 cesium 之前，用于设置 CESIUM_BASE_URL
import '../lib/cesium-base-url'
// Cesium 控件样式（源文件只有内联 data URI，无外部图片引用，可安全交给 vite 打包）
import 'cesium/Build/Cesium/Widgets/widgets.css'
import { useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from 'react'
import { Layers, Locate, MapPin } from 'lucide-react'
import {
  ArcGISTiledElevationTerrainProvider,
  buildModuleUrl,
  CallbackPositionProperty,
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  CesiumTerrainProvider,
  CesiumWidget,
  Color,
  EllipsoidTerrainProvider,
  Entity,
  EntityCollection,
  IonResource,
  LabelStyle,
  Resource,
  SceneMode,
  TileMapServiceImageryProvider,
  type TerrainProvider,
  UrlTemplateImageryProvider,
} from 'cesium'
import type { MapCoordinateSystem, MapTileSource, MapTileSourceHeader } from '../../../shared/contracts'
import type { DeviceTelemetry } from '../lib/dji'
import { devicePositions, type DevicePosition } from '../lib/map-device-position'
import { toCoordinateSystem } from '../lib/map-coord'
import { isTerrainKind } from '../lib/terrain-source'

/** 设备标记点的像素直径 */
const MARKER_SIZE = 18
/** 在线设备标记颜色 */
const MARKER_COLOR_ONLINE = '#2563eb'
/** 离线设备标记颜色 */
const MARKER_COLOR_OFFLINE = '#9ca3af'
/** 定位相机高度，单位米 */
const FOCUS_HEIGHT_METERS = 2_000
/** 名称标签相对标记点的垂直偏移，单位像素 */
const LABEL_OFFSET_Y = -22
/** Cesium ion 上 Cesium World Terrain 的资产编号 */
export const TERRAIN_ION_ASSET_ID = 1
/** ArcGIS 全球地形的固定服务地址，用户只需要提供 API Key */
export const TERRAIN_ARCGIS_URL =
  'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer'
/** 地形 provider 的构造超时，单位毫秒 */
export const TERRAIN_LOAD_TIMEOUT_MS = 3_000
/** 超时原因文案；秒数由超时常量算出，避免两处数字漂移 */
export const TERRAIN_TIMEOUT_REASON = `地形加载超时（${TERRAIN_LOAD_TIMEOUT_MS / 1_000} 秒）`

/** 非地形源被误传到地形分支时的兜底原因，正常路径不会出现 */
const NOT_TERRAIN_REASON = '不是地形来源'

/**
 * 把异常转成可展示的中文文案。
 *
 * @param error 捕获到的异常
 * @returns Error 取 message，其余类型按字符串转换
 */
const terrainErrorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const markerColor = (online: boolean): Color =>
  Color.fromCssColorString(online ? MARKER_COLOR_ONLINE : MARKER_COLOR_OFFLINE)

const formatDegrees = (value: number): string => value.toFixed(6)

/**
 * 生成渲染进程使用的影像地址模板。
 *
 * 真实底图地址与 API Key 都留在主进程，渲染进程只面对 map-tile 协议。
 *
 * @param source 底图源配置
 * @returns map-tile 协议下的 URL 模板
 */
export const imageryProviderUrl = (source: MapTileSource): string =>
  `map-tile://tiles/${source.id}/{z}/{x}/{y}`

/**
 * 选取当前生效的影像底图源。
 *
 * 配置里可能同时存在影像源与地形源：地形只提供地表高程，不提供影像，
 * 地形源由下面的 {@link activeTerrainSource} 单独消费，这里必须排除。
 *
 * @param sources 全部底图源
 * @returns 优先取默认影像源，其次取第一个影像源；没有影像源时返回 undefined
 */
export const activeImagerySource = (sources: MapTileSource[]): MapTileSource | undefined => {
  const imagery = sources.filter((source) => source.layer === 'imagery')
  return imagery.find((source) => source.isDefault) ?? imagery[0]
}

/**
 * 选取当前生效的地形源。
 *
 * 与 {@link activeImagerySource} 对称：地形源只影响地表几何，不参与影像图层。
 *
 * @param sources 全部底图源
 * @returns 优先取默认地形源，其次取第一个地形源；没有地形源时返回 undefined
 */
export const activeTerrainSource = (sources: MapTileSource[]): MapTileSource | undefined => {
  const terrain = sources.filter((source) => source.layer === 'terrain')
  return terrain.find((source) => source.isDefault) ?? terrain[0]
}

/** 构造地形 provider 所需的输入，三类来源各自取用其中一部分字段 */
export interface TerrainProviderOptions {
  /** 构造分支：ion 走两步构造，arcgis 用固定服务地址，url 用自建地址与请求头 */
  kind: 'ion' | 'arcgis' | 'url'
  /** ion 专用：Cesium World Terrain 的资产编号 */
  assetId?: number
  /** arcgis / url 专用：地形服务地址 */
  url?: string
  /** 访问令牌明文 */
  token?: string
  /** url 专用：随地形瓦片请求发出的请求头，已含 Authorization（若配了令牌） */
  headers?: Record<string, string>
}

/**
 * 组装自建地形服务的请求头。
 *
 * 自建 quantized-mesh 服务的令牌没有厂商语义，约定按 `Authorization: Bearer` 发送；
 * 用户自己配的 Authorization 会被它覆盖，因为令牌字段就是为该服务准备的。
 *
 * @param headers 用户在弹窗里配置的请求头
 * @param token 令牌明文，可为空
 * @returns 请求头键值对；名称为空的条目被忽略
 */
export const terrainRequestHeaders = (
  headers: MapTileSourceHeader[],
  token: string,
): Record<string, string> => {
  const result: Record<string, string> = {}
  for (const header of headers) {
    const name = header.name.trim()
    if (!name) continue
    result[name] = header.value
  }
  if (token) result.Authorization = `Bearer ${token}`
  return result
}

/**
 * 把地形源与令牌转成构造 provider 所需的输入。
 *
 * 三类来源都可能返回 undefined，此时调用方必须退回椭球并提示，绝不能拿着空令牌去构造：
 * Cesium ion 的工厂方法收不到令牌会回落到 Cesium 内置的默认令牌，用户会以为地形已经按自己的账号加载。
 *
 * @param source 生效的地形源
 * @param token 主进程回传的令牌明文，未保存令牌时为空串
 * @returns 构造输入；来源不是地形、令牌为空或自建地址为空时返回 undefined
 */
export const terrainProviderOptions = (source: MapTileSource, token: string): TerrainProviderOptions | undefined => {
  // 图层字段在草稿未定型时可能滞后，按 kind 判定
  if (!isTerrainKind(source.kind)) return undefined

  const trimmedToken = token.trim()
  if (source.kind === 'terrain-ion') {
    return trimmedToken ? { kind: 'ion', assetId: TERRAIN_ION_ASSET_ID, token: trimmedToken } : undefined
  }
  if (source.kind === 'terrain-arcgis') {
    return trimmedToken ? { kind: 'arcgis', url: TERRAIN_ARCGIS_URL, token: trimmedToken } : undefined
  }

  const url = source.urlTemplate.trim()
  if (!url) return undefined
  return { kind: 'url', url, headers: terrainRequestHeaders(source.headers, trimmedToken) }
}

/**
 * 给出地形源不可用的中文原因，用于顶部提示条。
 *
 * 只在 {@link terrainProviderOptions} 返回 undefined 时调用，因此不需要重复校验地址合法性，
 * 但仍按来源类型给出各自缺什么字段的提示。
 *
 * @param source 生效的地形源
 * @param token 主进程回传的令牌明文
 * @returns 面向用户的中文原因
 */
export const terrainUnavailableReason = (source: MapTileSource, token: string): string => {
  if (source.kind === 'terrain-url') return '地形服务地址为空'
  if (source.kind === 'terrain-arcgis') return '未填写 ArcGIS API Key'
  if (source.kind === 'terrain-ion') return '未填写 Cesium ion Access Token'
  return NOT_TERRAIN_REASON
}

/**
 * 生成地形加载失败的提示条文案。
 *
 * @param reason 失败原因，超时路径传 {@link TERRAIN_TIMEOUT_REASON} 以便与构造失败区分
 * @returns 提示条文案
 */
export const terrainFailureMessage = (reason: string): string => `地形加载失败：${reason}，已回退椭球`

/**
 * 按决策结果构造地形 provider。
 *
 * ion 必须两步构造：`CesiumTerrainProvider.fromIonAssetId` 内部调用 `IonResource.fromAssetId` 时
 * 不透传 options，直接传入的 accessToken 会被静默丢弃并回落到 Cesium 内置默认令牌，
 * 所以先取资源再 `fromUrl`；也不设置 `Cesium.Ion.defaultAccessToken`，避免污染全局默认值。
 *
 * @param options 由 {@link terrainProviderOptions} 得出的构造输入
 * @returns 构造完成的地形 provider；上游不可用时以 rejection 结束
 */
export const createTerrainProvider = async (options: TerrainProviderOptions): Promise<TerrainProvider> => {
  if (options.kind === 'ion') {
    const resource = await IonResource.fromAssetId(options.assetId ?? TERRAIN_ION_ASSET_ID, {
      accessToken: options.token,
    })
    return CesiumTerrainProvider.fromUrl(resource, { requestVertexNormals: true, requestWaterMask: true })
  }
  if (options.kind === 'arcgis') {
    // token 会作为查询参数附加到请求上，ArcGIS 的工厂方法确实会透传
    return ArcGISTiledElevationTerrainProvider.fromUrl(options.url ?? TERRAIN_ARCGIS_URL, {
      token: options.token,
    })
  }
  // fromUrl 会自动 GET 根地址下的 layer.json；请求头经 getDerivedResource 继承到每个瓦片请求
  // url 为 url 分支的必填字段，由 terrainProviderOptions 填好，这里的缺省值只用于类型收窄
  return CesiumTerrainProvider.fromUrl(
    new Resource({ url: options.url ?? '', headers: options.headers }),
    { requestVertexNormals: true, requestWaterMask: true },
  )
}

/**
 * 计算设备标记在地图中的三维坐标。
 *
 * 设备上报 WGS-84，但屏幕摆点必须使用底图坐标系：GCJ-02 / BD-09 底图若不转换会整体偏移数百米。
 *
 * @param position 设备定位，原始读数为 WGS-84
 * @param system 当前底图坐标系
 * @returns 底图坐标系下的三维坐标
 */
export const deviceCartesian = (position: DevicePosition, system: MapCoordinateSystem): Cartesian3 => {
  const converted = toCoordinateSystem(position.wgs84, system)
  return Cartesian3.fromDegrees(converted.longitude, converted.latitude, position.height ?? 0)
}

/**
 * 计算相机定位的目标点：所有已定位设备的中心。
 *
 * 中心点同样按底图坐标系计算，否则定位后设备仍会整体偏移。
 *
 * @param positions 已定位设备列表
 * @param system 当前底图坐标系
 * @returns 中心点三维坐标；设备列表为空时返回 undefined
 */
export const focusDestination = (
  positions: DevicePosition[],
  system: MapCoordinateSystem,
): Cartesian3 | undefined => {
  if (positions.length === 0) return undefined
  const converted = positions.map((position) => toCoordinateSystem(position.wgs84, system))
  const latitude = converted.reduce((sum, point) => sum + point.latitude, 0) / converted.length
  const longitude = converted.reduce((sum, point) => sum + point.longitude, 0) / converted.length
  return Cartesian3.fromDegrees(longitude, latitude, FOCUS_HEIGHT_METERS)
}

export interface DeviceDescription {
  /** 弹窗标题 */
  title: string
  /** 详情行 */
  lines: string[]
}

/**
 * 生成设备标记的详情文本。
 *
 * 同时展示原始 WGS-84 读数与底图坐标系下的坐标：即使底图存在偏移，
 * 也仍然能核对设备上报的数值是否正确。
 *
 * @param position 设备定位
 * @param system 当前底图的坐标系
 * @returns 标题与详情行
 */
export const describeMapDevice = (position: DevicePosition, system: MapCoordinateSystem): DeviceDescription => {
  const converted = toCoordinateSystem(position.wgs84, system)
  const lines = [
    `原始上报（WGS-84） 纬度 ${formatDegrees(position.wgs84.latitude)}  经度 ${formatDegrees(position.wgs84.longitude)}`,
  ]

  if (system === 'wgs84') {
    lines.push('未转换（底图为 WGS-84）')
  } else {
    const label = system === 'gcj02' ? 'GCJ-02' : 'BD-09'
    lines.push(`底图坐标（${label}） 纬度 ${formatDegrees(converted.latitude)}  经度 ${formatDegrees(converted.longitude)}`)
    lines.push(`已按 ${label} 转换`)
  }

  lines.push(position.online ? '状态：在线' : `状态：离线（最后上报 ${new Date(position.lastSeenAt).toLocaleString('zh-CN')}）`)
  if (position.height !== undefined) lines.push(`高度：${position.height.toFixed(1)} 米`)
  if (position.home) {
    lines.push(`Home 点：纬度 ${formatDegrees(position.home.latitude)}  经度 ${formatDegrees(position.home.longitude)}`)
  }
  return { title: position.name, lines }
}

/** 位置与坐标系的读取入口，CallbackProperty 每次重绘都从这两个 ref 取最新值 */
interface PositionAccess {
  /** 按 SN 索引的最新设备定位 */
  positions: MutableRefObject<Map<string, DevicePosition>>
  /** 当前底图坐标系，切换底图源时同步更新 */
  system: MutableRefObject<MapCoordinateSystem>
}

/**
 * 生成设备标记的实体描述。
 *
 * 位置、颜色与名称都经 CallbackProperty 从 ref 惰性读取：遥测每次合并都会换掉数组引用，
 * 若直接写进实体，Cesium 会跟着重建实体，相机与选中状态都会被重置。
 *
 * @param sn 设备序列号
 * @param access 位置与坐标系读取入口
 * @returns Cesium 实体初始化参数
 */
export const markerEntityOptions = (
  sn: string,
  access: PositionAccess,
): Entity.ConstructorOptions => {
  const cartesianAt = (): Cartesian3 | undefined => {
    const position = access.positions.current.get(sn)
    return position ? deviceCartesian(position, access.system.current) : undefined
  }
  return {
    id: sn,
    name: access.positions.current.get(sn)?.name ?? sn,
    position: new CallbackPositionProperty(cartesianAt, false),
    point: {
      pixelSize: MARKER_SIZE,
      color: new CallbackProperty(() => markerColor(access.positions.current.get(sn)?.online ?? false), false),
      outlineColor: Color.WHITE,
      outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text: new CallbackProperty(() => access.positions.current.get(sn)?.name ?? '', false),
      font: '13px sans-serif',
      style: LabelStyle.FILL_AND_OUTLINE,
      outlineWidth: 3,
      outlineColor: Color.WHITE,
      pixelOffset: new Cartesian2(0, LABEL_OFFSET_Y),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  }
}

export interface CesiumMapHandle {
  /** CesiumWidget 引用，未初始化或被销毁时为 null */
  widgetRef: MutableRefObject<CesiumWidget | null>
  /** 设备实体的集合，随 Widget 一起创建 */
  entitiesRef: MutableRefObject<EntityCollection | null>
  /** 是否已完成初始化 */
  ready: boolean
  /** 初始化失败的中文提示；成功时为 null */
  runtimeError: string | null
}

/**
 * 创建并维护 Cesium 地图控件的生命周期。
 *
 * 使用 CesiumWidget 而不是 Viewer：Viewer 会连带拉起 Cesium 自带的 knockout，其间接 eval 被
 * CSP 的 script-src 拦下后构造即抛错、整个视图白屏。CSP 的 'wasm-unsafe-eval' 只放行
 * WebAssembly 编译、不放行 JS 动态求值，所以这条限制依然成立（Viewer 依赖的 WebAssembly
 * 本身已不再被拦）。本视图只需要地球、影像层与设备点位，
 * CesiumWidget 已提供 scene / imageryLayers / entities / camera，无需 Viewer 的控件外壳。
 *
 * 没有可用 WebGL2 的环境会在构造时抛错，这里捕获后交给界面提示，避免整个视图崩溃。
 *
 * @param containerRef 承载三维地球的容器
 * @returns 控件引用、实体集合引用、就绪标记与初始化错误文案
 */
export const useCesiumMap = (containerRef: RefObject<HTMLDivElement>): CesiumMapHandle => {
  const widgetRef = useRef<CesiumWidget | null>(null)
  const entitiesRef = useRef<EntityCollection | null>(null)
  const [ready, setReady] = useState(false)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    let widget: CesiumWidget
    try {
      widget = new CesiumWidget(containerRef.current, {
        sceneMode: SceneMode.SCENE3D,
        terrainProvider: new EllipsoidTerrainProvider(),
        baseLayer: false,
        // 桌面工具会长时间挂着，按需渲染避免空闲时持续空转 GPU
        requestRenderMode: true,
      })
    } catch (error) {
      setRuntimeError(`三维地图初始化失败：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    widgetRef.current = widget
    entitiesRef.current = widget.entities
    setReady(true)
    return () => {
      widgetRef.current = null
      entitiesRef.current = null
      setReady(false)
      if (!widget.isDestroyed()) widget.destroy()
    }
  }, [containerRef])

  return { widgetRef, entitiesRef, ready, runtimeError }
}

/**
 * 把当前底图源挂到 Cesium 的影像图层上。
 *
 * 渲染进程只使用 map-tile 协议地址，真实模板与密钥都留在主进程。
 *
 * @param handle 地图控件句柄
 * @param source 当前生效的底图源；未配置时清空影像层并保留椭球
 */
export const useBasemapLayer = (handle: CesiumMapHandle, source: MapTileSource | undefined): void => {
  const { widgetRef, ready } = handle

  useEffect(() => {
    const widget = widgetRef.current
    if (!ready || !widget || widget.isDestroyed()) return
    const layers = widget.imageryLayers
    layers.removeAll()
    if (source) {
      layers.addImageryProvider(new UrlTemplateImageryProvider({
        url: imageryProviderUrl(source),
        minimumLevel: source.minZoom,
        maximumLevel: source.maxZoom,
        tileWidth: source.tileSize,
        tileHeight: source.tileSize,
        credit: source.attribution || undefined,
      }))
    } else {
      // Cesium 包自带的 Natural Earth II 离线影像：免费、无需 token、完全离线，
      // 作为未配置底图源时的兜底，避免用户面对一个裸椭球。
      // 1.145 的 TileMapServiceImageryProvider 构造函数不再接受 url，须走 fromUrl。
      void TileMapServiceImageryProvider.fromUrl(
        buildModuleUrl('Assets/Textures/NaturalEarthII'),
        { credit: 'Natural Earth II（Cesium 内置离线影像）' },
      ).then((provider) => {
        if (widgetRef.current && !widgetRef.current.isDestroyed() && !layers.isDestroyed()) {
          layers.addImageryProvider(provider)
          widgetRef.current.scene.requestRender()
        }
      }).catch(() => {
        // 兜底影像加载失败时保持椭球，不阻塞用户
      })
    }
    widget.scene.requestRender()
  }, [source, ready, widgetRef])
}

/** 地形层的当前状态 */
export type TerrainLayerState = 'none' | 'loading' | 'ready' | 'failed'

/** 地形层状态与失败原因，直接驱动顶部提示条 */
export interface TerrainLayerStatus {
  /** 地形层状态；none 表示没有配置地形源，failed 表示已回退椭球 */
  state: TerrainLayerState
  /** 失败时的中文提示文案 */
  detail?: string
}

/**
 * 把当前地形源挂到 Cesium 的 scene 上。
 *
 * 地形相比影像多两处麻烦，都在这里处理：
 * 一是令牌只在主进程加密保存，渲染进程必须经 `map:get-terrain-token` 现取一次明文才能构造 provider；
 * 二是 provider 构造要下载 layer.json，慢或不可达时不能一直吊着用户，因此与 {@link TERRAIN_LOAD_TIMEOUT_MS}
 * 赛跑：超时先退回椭球并提示，构造若在超时之后才落地仍然补正（成功则换成地形并清掉提示，
 * 失败则把超时文案换成真实错误）。所有赋值都受 cancelled 保护，控件销毁后不再触碰。
 *
 * @param handle 地图控件句柄
 * @param source 当前生效的地形源；未配置时挂回椭球并清空提示
 * @returns 当前地形层状态与失败原因
 */
export const useTerrainLayer = (
  handle: CesiumMapHandle,
  source: MapTileSource | undefined,
): TerrainLayerStatus => {
  const { widgetRef, ready } = handle
  const [status, setStatus] = useState<TerrainLayerStatus>({ state: 'none' })

  useEffect(() => {
    const widget = widgetRef.current
    if (!ready || !widget || widget.isDestroyed()) return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // 每次都重新取控件：超时后迟到的结果可能在控件已销毁之后才到
    const apply = (provider: TerrainProvider): void => {
      const current = widgetRef.current
      if (cancelled || !current || current.isDestroyed()) return
      current.scene.terrainProvider = provider
      current.scene.requestRender()
    }
    const fail = (reason: string): void => {
      apply(new EllipsoidTerrainProvider())
      if (!cancelled) setStatus({ state: 'failed', detail: terrainFailureMessage(reason) })
    }

    if (!source) {
      apply(new EllipsoidTerrainProvider())
      setStatus({ state: 'none' })
      return
    }
    setStatus({ state: 'loading' })

    const load = async (): Promise<void> => {
      let token = ''
      try {
        token = await window.djiApi.map.getTerrainToken(source.id)
      } catch (error) {
        fail(terrainErrorText(error))
        return
      }
      if (cancelled) return
      const options = terrainProviderOptions(source, token)
      if (!options) {
        fail(terrainUnavailableReason(source, token))
        return
      }
      timer = setTimeout(() => fail(TERRAIN_TIMEOUT_REASON), TERRAIN_LOAD_TIMEOUT_MS)
      try {
        const provider = await createTerrainProvider(options)
        clearTimeout(timer)
        apply(provider)
        if (!cancelled) setStatus({ state: 'ready' })
      } catch (error) {
        clearTimeout(timer)
        fail(terrainErrorText(error))
      }
    }
    void load()

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // updatedAt 一起作为依赖：用户改完地形源保存后必须重新构造 provider
  }, [source?.id, source?.updatedAt, ready, widgetRef])

  return status
}

/**
 * 按 SN 维护设备实体：新增、原地复用、移除。
 *
 * 实体只在设备出现与消失时增删；位置变化由 CallbackProperty 读取，不重建实体，
 * 因此 Cesium 的相机与选中状态不会被遥测刷新打断。
 *
 * @param handle 地图控件句柄
 * @param positions 已定位设备列表
 * @param system 当前底图坐标系
 */
export const useDeviceEntities = (
  handle: CesiumMapHandle,
  positions: DevicePosition[],
  system: MapCoordinateSystem,
): void => {
  const { widgetRef, entitiesRef, ready } = handle
  const trackedRef = useRef(new Map<string, Entity>())
  const positionsRef = useRef<Map<string, DevicePosition>>(new Map())
  const systemRef = useRef<MapCoordinateSystem>(system)
  positionsRef.current = new Map(positions.map((position) => [position.sn, position]))
  systemRef.current = system
  const access: PositionAccess = { positions: positionsRef, system: systemRef }
  // 只在设备集合变化时增删实体，位置刷新走上面的 ref
  const deviceKey = positions.map((position) => position.sn).join('|')

  useEffect(() => {
    const widget = widgetRef.current
    const entities = entitiesRef.current
    if (!ready || !widget || widget.isDestroyed() || !entities) return
    const tracked = trackedRef.current

    for (const sn of positionsRef.current.keys()) {
      const existing = tracked.get(sn)
      // contains 兜底：控件重建后旧实体已失效，必须重新创建
      if (existing && entities.contains(existing)) continue
      tracked.set(sn, entities.add(markerEntityOptions(sn, access)))
    }
    for (const [sn, entity] of tracked) {
      if (positionsRef.current.has(sn)) continue
      entities.remove(entity)
      tracked.delete(sn)
    }
    widget.scene.requestRender()
  }, [deviceKey, ready, widgetRef, entitiesRef])

  useEffect(() => {
    const widget = widgetRef.current
    if (!ready || !widget || widget.isDestroyed()) return
    // requestRenderMode 下必须显式请求重绘，否则新位置不会出现在画面上
    widget.scene.requestRender()
  }, [positions, ready, widgetRef])
}

interface MapToolbarProps {
  /** 当前底图源名称，未配置时为空 */
  sourceName?: string
  /** 已定位设备数量 */
  locatedCount: number
  /** 打开底图源配置弹窗 */
  onOpenSources: () => void
  /** 相机飞向全部设备 */
  onFocusDevices: () => void
}

/**
 * 地图工具栏：底图源入口、定位按钮与已定位计数。
 *
 * 两个按钮都带可见文字，因此不套 Tooltip —— Tooltip 会写入 aria-label 覆盖可见文案。
 *
 * @param props 工具栏属性
 * @returns 工具栏元素
 */
export const MapToolbar = ({ sourceName, locatedCount, onOpenSources, onFocusDevices }: MapToolbarProps) => (
  <div className="map-toolbar">
    <button className="button secondary" onClick={onOpenSources}>
      <Layers size={15} />{sourceName ?? '配置底图源'}
    </button>
    <button className="button secondary" disabled={locatedCount === 0} onClick={onFocusDevices}>
      <Locate size={15} />定位
    </button>
    <span className="map-toolbar-meta">
      <MapPin size={14} />{locatedCount} 台设备已定位
    </span>
  </div>
)

/**
 * 无定位设备清单：这些设备不会出现在地球上（例如刚上电、尚未上报经纬度）。
 *
 * @param props 清单属性
 * @returns 无定位设备面板；没有此类设备时返回 null
 */
export const MissingFixPanel = ({ devices }: { devices: DeviceTelemetry[] }) => {
  if (devices.length === 0) return null
  return (
    <div className="map-missing-fix">
      <span className="eyebrow">无定位</span>
      {devices.map((device) => (
        <span key={device.sn} className="map-missing-fix-item">{device.name}</span>
      ))}
    </div>
  )
}

/**
 * 设备详情面板：列出每台已定位设备的上报值与底图坐标。
 *
 * 这是在地图视图中核对上报值的入口，因此必须同时给出原始 WGS-84 读数，
 * 转换后的坐标只用于解释屏幕上的摆点位置。设备工作台的遥测表同样展示原始经纬度。
 *
 * @param props 面板属性
 * @returns 设备详情面板；没有已定位设备时返回 null
 */
export const DeviceDetailPanel = (
  { positions, system }: { positions: DevicePosition[]; system: MapCoordinateSystem },
) => {
  if (positions.length === 0) return null
  return (
    <div className="map-device-detail">
      <span className="eyebrow">已定位设备</span>
      {positions.map((position) => {
        const described = describeMapDevice(position, system)
        return (
          <div key={position.sn} className="map-device-detail-item">
            <span className="map-device-detail-title">{described.title}</span>
            {described.lines.map((line) => (
              <span key={line} className="map-device-detail-line">{line}</span>
            ))}
          </div>
        )
      })}
    </div>
  )
}

interface MapViewProps {
  /** 已保存的底图源 */
  sources: MapTileSource[]
  /** 设备遥测快照 */
  devices: DeviceTelemetry[]
  /** 打开底图源配置弹窗 */
  onOpenSources: () => void
}

/**
 * 三维地图视图：Cesium 地球 + 影像底图 + 设备点位。
 *
 * @param props 视图属性
 * @returns 地图视图元素
 */
export function MapView({ sources, devices, onOpenSources }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const map = useCesiumMap(containerRef)
  const activeSource = useMemo(() => activeImagerySource(sources), [sources])
  const terrainSource = useMemo(() => activeTerrainSource(sources), [sources])
  const positions = useMemo(() => devicePositions(devices), [devices])
  const missingFix = useMemo(
    () => devices.filter((device) => !positions.some((position) => position.sn === device.sn)),
    [devices, positions],
  )
  const system = activeSource?.coordinateSystem ?? 'wgs84'

  useBasemapLayer(map, activeSource)
  const terrain = useTerrainLayer(map, terrainSource)
  useDeviceEntities(map, positions, system)

  const focusOnDevices = (): void => {
    const widget = map.widgetRef.current
    if (!widget || widget.isDestroyed()) return
    const destination = focusDestination(positions, system)
    if (!destination) return
    widget.camera.flyTo({ destination, duration: 1 })
  }

  return (
    <div className="map-view">
      <MapToolbar
        sourceName={activeSource?.name}
        locatedCount={positions.length}
        onOpenSources={onOpenSources}
        onFocusDevices={focusOnDevices}
      />

      {!activeSource && (
        <div className="map-banner">
          请配置底图源后使用三维地图。
          <button className="button secondary" onClick={onOpenSources}>立即配置</button>
        </div>
      )}
      {map.runtimeError && <div className="map-banner error">{map.runtimeError}</div>}
      {terrain.state === 'failed' && terrain.detail && (
        <div className="map-banner error">{terrain.detail}</div>
      )}

      <div ref={containerRef} className="map-canvas" />

      <DeviceDetailPanel positions={positions} system={system} />
      <MissingFixPanel devices={missingFix} />
    </div>
  )
}
