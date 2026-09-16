import { renderToStaticMarkup } from 'react-dom/server'
import { Cartesian3 } from 'cesium'
import { describe, expect, it, vi } from 'vitest'
import type { MapTileSource } from '../../../shared/contracts'
import type { DevicePosition } from '../lib/map-device-position'
import { toCoordinateSystem } from '../lib/map-coord'
import { activeImagerySource, describeMapDevice, deviceCartesian, focusDestination, imageryProviderUrl, MapView } from './MapView'

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
    // 简报原文断言的是「一号机场」。该断言无法成立：已定位设备的名称只作为 Cesium 标签渲染，
    // 而 renderToStaticMarkup 不执行 useEffect、也不构造 WebGL 上下文，静态标记里永远不会出现它。
    // 这条用例真正要验证的是「无定位的设备被单独列出」，故改断言未定位设备的名字。
    expect(markup).toContain('二号机场')
    expect(markup).toContain('无定位')
  })
})
