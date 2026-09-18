import { renderToStaticMarkup } from 'react-dom/server'
import { CallbackPositionProperty, CallbackProperty, Cartesian3, Color, JulianDate } from 'cesium'
import { describe, expect, it, vi } from 'vitest'
import type { MapCoordinateSystem, MapTileSource } from '../../../shared/contracts'
import type { DevicePosition } from '../lib/map-device-position'
import { toCoordinateSystem } from '../lib/map-coord'
import {
  activeImagerySource,
  activeTerrainSource,
  describeMapDevice,
  deviceCartesian,
  focusDestination,
  imageryProviderUrl,
  MapView,
  markerEntityOptions,
  TERRAIN_ARCGIS_URL,
  TERRAIN_LOAD_TIMEOUT_MS,
  TERRAIN_TIMEOUT_REASON,
  terrainFailureMessage,
  terrainProviderOptions,
  terrainUnavailableReason,
} from './MapView'

const source = (patch: Partial<MapTileSource> = {}): MapTileSource => ({
  id: 'source-1',
  name: '高德影像',
  layer: 'imagery',
  kind: 'url-template',
  urlTemplate: 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
  path: '',
  headers: [],
  coordinateSystem: 'gcj02',
  minZoom: 0,
  maxZoom: 18,
  tileSize: 256,
  tileExtension: '',
  attribution: '© 高德地图',
  isDefault: true,
  createdAt: 1,
  updatedAt: 1,
  ...patch,
})

/** 地形源草稿：默认是「Cesium 世界地形」，其余字段由用例覆盖 */
const terrainSource = (patch: Partial<MapTileSource> = {}): MapTileSource => source({
  id: 'terrain-1',
  name: 'Cesium 世界地形',
  layer: 'terrain',
  kind: 'terrain-ion',
  urlTemplate: '',
  isDefault: true,
  ...patch,
})

const position = (patch: Partial<DevicePosition> = {}): DevicePosition => ({
  sn: 'DOCK-1',
  name: '一号机场',
  type: 'dock',
  provider: 'dji',
  online: true,
  lastSeenAt: 1_700_000_000_000,
  wgs84: { latitude: 39.90869, longitude: 116.39740 },
  height: 43.5,
  ...patch,
})

describe('imageryProviderUrl', () => {
  it('builds a template url routed through the map-tile protocol', () => {
    expect(imageryProviderUrl(source())).toBe('map-tile://tiles/source-1/{z}/{x}/{y}')
  })

  it('never leaks the upstream template into the renderer url', () => {
    expect(imageryProviderUrl(source())).not.toContain('autonavi')
    expect(imageryProviderUrl(source())).not.toContain('{s}')
  })
})

describe('activeImagerySource', () => {
  it('prefers the default imagery source', () => {
    const fallback = source({ id: 'source-2', name: '备用影像', isDefault: false })
    expect(activeImagerySource([fallback, source()])?.id).toBe('source-1')
  })

  it('falls back to the first imagery source and ignores terrain sources', () => {
    const terrain = source({ id: 'terrain-1', name: '地形', layer: 'terrain', isDefault: true })
    const imagery = source({ id: 'imagery-1', name: '影像', isDefault: undefined })
    expect(activeImagerySource([terrain, imagery])?.id).toBe('imagery-1')
  })
})

describe('activeTerrainSource', () => {
  it('prefers the default terrain source', () => {
    const fallback = terrainSource({ id: 'terrain-2', isDefault: false })
    expect(activeTerrainSource([fallback, terrainSource()])?.id).toBe('terrain-1')
  })

  it('falls back to the first terrain source and ignores imagery sources', () => {
    const imagery = source({ id: 'imagery-1', isDefault: true })
    const terrain = terrainSource({ id: 'terrain-3', isDefault: undefined })
    expect(activeTerrainSource([imagery, terrain])?.id).toBe('terrain-3')
  })

  it('has no terrain source when none is configured', () => {
    expect(activeTerrainSource([source()])).toBeUndefined()
  })
})

describe('terrainProviderOptions', () => {
  it('maps a terrain-ion source to the two-step ion construction', () => {
    expect(terrainProviderOptions(terrainSource(), 'ion-token')).toEqual({
      kind: 'ion',
      assetId: 1,
      token: 'ion-token',
    })
  })

  it('refuses an ion source without a token instead of falling back to the bundled Cesium token', () => {
    expect(terrainProviderOptions(terrainSource(), '')).toBeUndefined()
    expect(terrainProviderOptions(terrainSource(), '   ')).toBeUndefined()
  })

  it('maps a terrain-arcgis source to the WorldElevation3D image service', () => {
    expect(terrainProviderOptions(terrainSource({ kind: 'terrain-arcgis' }), 'arcgis-key')).toEqual({
      kind: 'arcgis',
      url: TERRAIN_ARCGIS_URL,
      token: 'arcgis-key',
    })
    expect(TERRAIN_ARCGIS_URL).toContain('WorldElevation3D/Terrain3D/ImageServer')
  })

  it('refuses an arcgis source without a token', () => {
    expect(terrainProviderOptions(terrainSource({ kind: 'terrain-arcgis' }), ' ')).toBeUndefined()
  })

  it('maps a terrain-url source to a resource url with its configured headers', () => {
    const selfHosted = terrainSource({
      kind: 'terrain-url',
      urlTemplate: 'https://terrain.example.com/terrain/',
      headers: [{ name: 'X-Tenant', value: 'dji' }],
    })
    expect(terrainProviderOptions(selfHosted, '')).toEqual({
      kind: 'url',
      url: 'https://terrain.example.com/terrain/',
      headers: { 'X-Tenant': 'dji' },
    })
  })

  it('sends the stored token as a bearer header for a self-hosted terrain service', () => {
    const selfHosted = terrainSource({
      kind: 'terrain-url',
      urlTemplate: 'https://terrain.example.com/terrain/',
      headers: [{ name: 'X-Tenant', value: 'dji' }],
    })
    expect(terrainProviderOptions(selfHosted, 'terrain-token')?.headers).toEqual({
      'X-Tenant': 'dji',
      Authorization: 'Bearer terrain-token',
    })
  })

  it('trims the address of a self-hosted terrain service', () => {
    const selfHosted = terrainSource({ kind: 'terrain-url', urlTemplate: '  https://terrain.example.com/  ' })
    expect(terrainProviderOptions(selfHosted, '')?.url).toBe('https://terrain.example.com/')
  })

  it('refuses a terrain-url source without an address', () => {
    expect(terrainProviderOptions(terrainSource({ kind: 'terrain-url', urlTemplate: '   ' }), 'token')).toBeUndefined()
  })

  it('ignores imagery sources', () => {
    expect(terrainProviderOptions(source(), 'ion-token')).toBeUndefined()
  })
})

describe('terrainUnavailableReason', () => {
  it('asks for the Cesium ion access token', () => {
    expect(terrainUnavailableReason(terrainSource(), '')).toBe('未填写 Cesium ion Access Token')
  })

  it('asks for the ArcGIS API key', () => {
    expect(terrainUnavailableReason(terrainSource({ kind: 'terrain-arcgis' }), '  ')).toBe('未填写 ArcGIS API Key')
  })

  it('asks for the address of a self-hosted terrain service', () => {
    expect(terrainUnavailableReason(terrainSource({ kind: 'terrain-url', urlTemplate: '' }), 'token')).toBe('地形服务地址为空')
  })
})

describe('terrainFailureMessage', () => {
  it('wraps the reason into the fallback banner copy', () => {
    expect(terrainFailureMessage('未填写 Cesium ion Access Token'))
      .toBe('地形加载失败：未填写 Cesium ion Access Token，已回退椭球')
  })

  it('keeps the timeout path distinguishable from a construction failure', () => {
    expect(terrainFailureMessage(TERRAIN_TIMEOUT_REASON)).toContain('地形加载超时（3 秒）')
    expect(TERRAIN_LOAD_TIMEOUT_MS).toBe(3_000)
  })
})

describe('deviceCartesian', () => {
  it('places the marker where the basemap expects it', () => {
    const converted = toCoordinateSystem(position().wgs84, 'gcj02')
    const expected = Cartesian3.fromDegrees(converted.longitude, converted.latitude, 43.5)
    expect(Cartesian3.equalsEpsilon(deviceCartesian(position(), 'gcj02'), expected, 1e-9)).toBe(true)
  })

  it('keeps the reported coordinate for a wgs84 basemap', () => {
    const expected = Cartesian3.fromDegrees(116.3974, 39.90869, 43.5)
    expect(Cartesian3.equalsEpsilon(deviceCartesian(position(), 'wgs84'), expected, 1e-9)).toBe(true)
  })
})

describe('focusDestination', () => {
  it('centers the camera between devices', () => {
    const destination = focusDestination(
      [position(), position({ sn: 'DOCK-2', wgs84: { latitude: 39.9, longitude: 116.5 } })],
      'wgs84',
    )
    expect(Cartesian3.equalsEpsilon(destination!, Cartesian3.fromDegrees(116.4487, 39.904345, 2_000), 1e-6)).toBe(true)
  })

  it('converts the camera destination for a gcj02 basemap', () => {
    const devices = [position(), position({ sn: 'DOCK-2', wgs84: { latitude: 39.9, longitude: 116.5 } })]
    const destination = focusDestination(devices, 'gcj02')
    expect(Cartesian3.equalsEpsilon(destination!, Cartesian3.fromDegrees(116.4487, 39.904345, 2_000), 1e-9)).toBe(false)
    const converted = devices.map((item) => toCoordinateSystem(item.wgs84, 'gcj02'))
    expect(Cartesian3.equalsEpsilon(destination!, Cartesian3.fromDegrees(
      converted.reduce((sum, point) => sum + point.longitude, 0) / converted.length,
      converted.reduce((sum, point) => sum + point.latitude, 0) / converted.length,
      2_000,
    ), 1e-9)).toBe(true)
  })

  it('has nothing to focus on without a located device', () => {
    expect(focusDestination([], 'wgs84')).toBeUndefined()
  })
})

describe('describeMapDevice', () => {
  it('shows both the reported and the basemap coordinate', () => {
    const described = describeMapDevice(position(), 'gcj02')
    expect(described.title).toBe('一号机场')
    expect(described.lines.some((line) => line.includes('39.908690'))).toBe(true)
    expect(described.lines.some((line) => line.includes('116.397400'))).toBe(true)
    expect(described.lines).toContain('已按 GCJ-02 转换')
  })

  it('marks the coordinate as untransformed for a wgs84 basemap', () => {
    expect(describeMapDevice(position(), 'wgs84').lines).toContain('未转换（底图为 WGS-84）')
  })

  it('labels the basemap coordinate as BD-09 for a bd09 basemap', () => {
    const converted = toCoordinateSystem(position().wgs84, 'bd09')
    const described = describeMapDevice(position(), 'bd09')
    expect(described.lines.some((line) => line.includes('BD-09'))).toBe(true)
    // 数值同样要断言：只要标签还在，把未转换的原始坐标填进这一行就能蒙混过关
    expect(described.lines).toContain(
      `底图坐标（BD-09） 纬度 ${converted.latitude.toFixed(6)}  经度 ${converted.longitude.toFixed(6)}`,
    )
  })

  it('reports an offline device with its last seen time', () => {
    const described = describeMapDevice(position({ online: false }), 'wgs84')
    expect(described.lines.some((line) => line.startsWith('状态：离线'))).toBe(true)
  })

  it('reports an online device', () => {
    expect(describeMapDevice(position(), 'wgs84').lines).toContain('状态：在线')
  })

  it('includes the height when reported', () => {
    expect(describeMapDevice(position(), 'wgs84').lines.some((line) => line.includes('43.5'))).toBe(true)
  })

  it('omits the height when it was not reported', () => {
    const described = describeMapDevice(position({ height: undefined }), 'wgs84')
    expect(described.lines.some((line) => line.startsWith('高度：'))).toBe(false)
  })

  it('includes the home point for an aircraft', () => {
    const described = describeMapDevice(
      position({ type: 'aircraft', home: { latitude: 39.9, longitude: 116.4 } }),
      'wgs84',
    )
    expect(described.lines.some((line) => line.startsWith('Home 点：'))).toBe(true)
  })
})

describe('markerEntityOptions', () => {
  const access = (positions: DevicePosition[], system: MapCoordinateSystem) => ({
    positions: { current: new Map(positions.map((item) => [item.sn, item] as const)) },
    system: { current: system },
  })

  it('colours an offline marker grey and an online marker blue', () => {
    const time = JulianDate.now()
    const offline = markerEntityOptions('DOCK-1', access([position({ online: false })], 'wgs84'))
    const online = markerEntityOptions('DOCK-1', access([position({ online: true })], 'wgs84'))
    const offlineColor = (offline.point!.color as CallbackProperty).getValue(time) as Color
    const onlineColor = (online.point!.color as CallbackProperty).getValue(time) as Color
    expect(Color.equals(offlineColor, Color.fromCssColorString('#9ca3af'))).toBe(true)
    expect(Color.equals(onlineColor, Color.fromCssColorString('#2563eb'))).toBe(true)
  })

  it('places the marker at the converted coordinate for a gcj02 basemap', () => {
    const time = JulianDate.now()
    const options = markerEntityOptions('DOCK-1', access([position()], 'gcj02'))
    const converted = toCoordinateSystem(position().wgs84, 'gcj02')
    const actual = (options.position as CallbackPositionProperty).getValue(time)
    const expected = Cartesian3.fromDegrees(converted.longitude, converted.latitude, 43.5)
    expect(Cartesian3.equalsEpsilon(actual, expected, 1e-9)).toBe(true)
    // 原始 WGS-84 坐标直接摆点会整体偏移数百米，必须能被这条断言拦住
    expect(Cartesian3.equalsEpsilon(actual, Cartesian3.fromDegrees(116.39740, 39.90869, 43.5), 1e-9)).toBe(false)
  })

  it('reads the latest position from the ref instead of a snapshot', () => {
    const time = JulianDate.now()
    const positions: Map<string, DevicePosition> = new Map([['DOCK-1', position()]])
    const system: MapCoordinateSystem = 'wgs84'
    const options = markerEntityOptions('DOCK-1', { positions: { current: positions }, system: { current: system } })
    positions.set('DOCK-1', position({ wgs84: { latitude: 30.1, longitude: 120.2 } }))
    const actual = (options.position as CallbackPositionProperty).getValue(time)
    expect(Cartesian3.equalsEpsilon(actual, Cartesian3.fromDegrees(120.2, 30.1, 43.5), 1e-9)).toBe(true)
  })
})

describe('MapView rendering', () => {
  it('prompts for a basemap source when none is configured', () => {
    const markup = renderToStaticMarkup(
      <MapView
        sources={[]}
        devices={[]}
        onOpenSources={vi.fn()}
      />,
    )
    expect(markup).toContain('请配置底图源')
  })

  it('lists devices without a fix separately', () => {
    const markup = renderToStaticMarkup(
      <MapView
        sources={[source()]}
        devices={[
          { sn: 'DOCK-1', name: '一号机场', type: 'dock', online: true, lastSeenAt: 1, osd: { latitude: 39.9, longitude: 116.4 }, state: {}, status: {}, profileId: 'p', lastTopic: 't', provider: 'dji' },
          { sn: 'DOCK-2', name: '二号机场', type: 'dock', online: true, lastSeenAt: 1, osd: {}, state: {}, status: {}, profileId: 'p', lastTopic: 't', provider: 'dji' },
        ]}
        onOpenSources={vi.fn()}
      />,
    )
    // 已定位设备的名称与「原始上报（WGS-84）」行由 DeviceDetailPanel 在渲染期输出，
    // 不依赖 useEffect，因此 renderToStaticMarkup 的静态标记里确实包含它们。
    expect(markup).toContain('一号机场')
    expect(markup).toContain('原始上报（WGS-84）')
    // 具体数值也要断言：只比标题文字的话，把转换后的坐标填进这一行同样能通过
    expect(markup).toContain('原始上报（WGS-84） 纬度 39.900000  经度 116.400000')
    expect(markup).toContain('二号机场')
    expect(markup).toContain('无定位')
  })

  it('still asks for an imagery source when only a terrain source is configured', () => {
    const markup = renderToStaticMarkup(
      <MapView
        sources={[terrainSource()]}
        devices={[]}
        onOpenSources={vi.fn()}
      />,
    )
    // 地形源不提供影像：只配地形时必须继续提示补影像底图，且工具栏不显示地形源名称
    expect(markup).toContain('请配置底图源')
    expect(markup).toContain('配置底图源')
    expect(markup).not.toContain('Cesium 世界地形')
  })
})
