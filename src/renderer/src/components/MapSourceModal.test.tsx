import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  MAP_TILE_PRESETS,
  MapSourceModal,
  applyMapTilePreset,
  applyPickedPath,
  buildMapTileSourcePayload,
  createMapTileSource,
  mapProbeNotice,
  mapTileSourceIssues,
  mapTileSourceNameFromPath,
  probeMapSource,
  reloadMapSourceDraft,
  removeMapSource,
  saveMapSource,
} from './MapSourceModal'
import type { MapSourceModalProps } from './MapSourceModal'
import type { MapTileSource } from '../../../shared/contracts'

const source = (patch: Partial<MapTileSource> = {}): MapTileSource => ({
  ...createMapTileSource(),
  ...patch,
})

/** 已经能通过校验的在线底图源，用于把断言集中在被测规则上 */
const validSource = (patch: Partial<MapTileSource> = {}): MapTileSource => source({
  name: '示例底图',
  urlTemplate: 'https://example.com/{z}/{x}/{y}.png',
  ...patch,
})

const renderModal = (overrides: Partial<MapSourceModalProps> = {}): string => renderToStaticMarkup(
  <MapSourceModal
    sources={[]}
    selectedId=""
    onSelect={vi.fn()}
    onSave={vi.fn(async (value: MapTileSource) => value)}
    onRemove={vi.fn(async () => ({ ok: true }))}
    onProbe={vi.fn(async () => ({ ok: true }))}
    onPickDirectory={vi.fn(async () => null)}
    onPickMbtiles={vi.fn(async () => null)}
    onClose={vi.fn()}
    onNotify={vi.fn()}
    {...overrides}
  />,
)

describe('map tile source defaults', () => {
  it('creates a disabled-by-default url template source with sane limits', () => {
    const created = createMapTileSource()
    expect(created.kind).toBe('url-template')
    expect(created.coordinateSystem).toBe('wgs84')
    expect(created.minZoom).toBe(0)
    expect(created.maxZoom).toBe(19)
    expect(created.tileSize).toBe(256)
    expect(created.headers).toEqual([])
    expect(created.isDefault).toBe(false)
  })

  it('starts with an empty id so the store assigns identity on save', () => {
    expect(createMapTileSource().id).toBe('')
  })
})

describe('map tile presets', () => {
  it('marks the domestic providers as GCJ-02 and the others as WGS-84', () => {
    const byName = new Map(MAP_TILE_PRESETS.map((preset) => [preset.name, preset]))
    expect(byName.get('高德矢量')?.coordinateSystem).toBe('gcj02')
    expect(byName.get('高德影像')?.coordinateSystem).toBe('gcj02')
    expect(byName.get('天地图影像')?.coordinateSystem).toBe('wgs84')
    expect(byName.get('OpenStreetMap')?.coordinateSystem).toBe('wgs84')
  })

  it('only ships imagery presets in the first phase', () => {
    expect(MAP_TILE_PRESETS.every((preset) => preset.layer === 'imagery')).toBe(true)
  })

  it('uses an https template for every preset', () => {
    expect(MAP_TILE_PRESETS.every((preset) => preset.urlTemplate.startsWith('https://'))).toBe(true)
  })

  it('flags the presets that need an api key', () => {
    const byName = new Map(MAP_TILE_PRESETS.map((preset) => [preset.name, preset]))
    expect(byName.get('高德矢量')?.requiresApiKey).toBe(true)
    expect(byName.get('OpenStreetMap')?.requiresApiKey).toBe(false)
  })

  it('applies a preset onto the draft, keeping a name the user already typed', () => {
    const preset = MAP_TILE_PRESETS[0]
    const named = applyMapTilePreset(validSource({ name: '我的底图' }), preset)
    expect(named.name).toBe('我的底图')
    expect(named.kind).toBe('url-template')
    expect(named.urlTemplate).toBe(preset.urlTemplate)
    expect(named.layer).toBe(preset.layer)
    expect(named.coordinateSystem).toBe(preset.coordinateSystem)
    expect(named.attribution).toBe(preset.attribution)
    expect(named.maxZoom).toBe(preset.maxZoom)
  })

  it('switches a local source back to a url template and names it after the preset', () => {
    const preset = MAP_TILE_PRESETS[4]
    const applied = applyMapTilePreset(source({ kind: 'mbtiles', path: '/data/a.mbtiles' }), preset)
    expect(applied.kind).toBe('url-template')
    expect(applied.name).toBe(preset.name)
  })
})

describe('map tile source issues', () => {
  it('accepts an empty id for a not-yet-saved source', () => {
    expect(mapTileSourceIssues(validSource({ id: '' }))).toEqual([])
  })

  it('requires a name', () => {
    expect(mapTileSourceIssues(source({ name: '   ' }))).toContain('请填写底图源名称')
  })

  it('requires the z, x and y placeholders', () => {
    expect(mapTileSourceIssues(source({ urlTemplate: 'https://a.com/{x}/{y}.png' })))
      .toContain('URL 模板必须包含 {z} 占位符')
    expect(mapTileSourceIssues(source({ urlTemplate: 'https://a.com/{z}/{y}.png' })))
      .toContain('URL 模板必须包含 {x} 占位符')
    expect(mapTileSourceIssues(source({ urlTemplate: 'https://a.com/{z}/{x}.png' })))
      .toContain('URL 模板必须包含 {y} 占位符')
  })

  it('rejects a malformed url template', () => {
    expect(mapTileSourceIssues(source({ urlTemplate: 'nope' })))
      .toContain('URL 模板格式无效')
  })

  it('rejects a local source without a path', () => {
    expect(mapTileSourceIssues(source({ kind: 'directory', path: '' })))
      .toContain('请选择瓦片目录')
    expect(mapTileSourceIssues(source({ kind: 'mbtiles', path: '' })))
      .toContain('请选择 MBTiles 文件')
  })

  it('rejects an mbtiles path without the expected extension', () => {
    expect(mapTileSourceIssues(source({ kind: 'mbtiles', path: '/data/tiles.db' })))
      .toContain('MBTiles 路径必须以 .mbtiles 结尾')
  })

  it('rejects an inverted zoom range', () => {
    expect(mapTileSourceIssues(source({ minZoom: 10, maxZoom: 5 })))
      .toContain('最大缩放级别不能小于最小缩放级别')
  })

  it('rejects a header name that is not a valid token', () => {
    expect(mapTileSourceIssues(source({ headers: [{ name: 'X Key', value: 'v' }] })))
      .toContain('第 1 个请求头名称无效')
  })

  it('rejects a header value containing a newline', () => {
    expect(mapTileSourceIssues(source({ headers: [{ name: 'X-Key', value: 'a\nb' }] })))
      .toContain('第 1 个请求头值不能包含换行')
  })

  it('rejects the header names the main process reserves', () => {
    expect(mapTileSourceIssues(source({ headers: [{ name: 'Host', value: 'evil.example.com' }] })))
      .toContain('第 1 个请求头使用了保留名称：Host')
    expect(mapTileSourceIssues(source({ headers: [{ name: 'content-length', value: '1' }] })))
      .toContain('第 1 个请求头使用了保留名称：content-length')
  })
})

describe('map tile source save payload', () => {
  it('sends a trimmed api key', () => {
    expect(buildMapTileSourcePayload(validSource(), '  secret-token  ').apiKey).toBe('secret-token')
  })

  it('omits the api key when the field is blank so the stored one survives', () => {
    const payload = buildMapTileSourcePayload(validSource(), '')
    expect('apiKey' in payload).toBe(false)
    expect('apiKey' in buildMapTileSourcePayload(validSource(), '   ')).toBe(false)
  })

  it('carries the rest of the draft unchanged', () => {
    const draft = validSource({ id: 'source-1', maxZoom: 17 })
    const payload = buildMapTileSourcePayload(draft, '')
    expect(payload).toEqual({ ...draft })
  })
})

describe('map tile source local path picking', () => {
  it('takes the last path segment as the name', () => {
    expect(mapTileSourceNameFromPath('/data/tiles/basemap')).toBe('basemap')
    expect(mapTileSourceNameFromPath('C:\\tiles\\basemap')).toBe('basemap')
    expect(mapTileSourceNameFromPath('/data/tiles/basemap/')).toBe('basemap')
  })

  it('fills the name from the picked path only when the name is still blank', () => {
    const filled = applyPickedPath(source({ kind: 'directory', name: '  ' }), '/data/tiles/basemap')
    expect(filled.path).toBe('/data/tiles/basemap')
    expect(filled.name).toBe('basemap')

    const kept = applyPickedPath(source({ kind: 'directory', name: '已有名称' }), '/data/tiles/basemap')
    expect(kept.name).toBe('已有名称')
  })
})

describe('map probe notices', () => {
  it('carries the probe reason verbatim', () => {
    expect(mapProbeNotice({ ok: false, error: '未找到瓦片 0/0/0' }))
      .toEqual({ text: '底图源不可用：未找到瓦片 0/0/0', tone: 'error' })
    expect(mapProbeNotice({ ok: false, error: '上游返回 HTTP 401' }))
      .toEqual({ text: '底图源不可用：上游返回 HTTP 401', tone: 'error' })
    expect(mapProbeNotice({ ok: false }))
      .toEqual({ text: '底图源不可用：未知原因', tone: 'error' })
  })

  it('reports the probed tile size on success', () => {
    expect(mapProbeNotice({ ok: true, bytes: 12 }))
      .toEqual({ text: '底图源可用，探测到 12 字节瓦片', tone: 'success' })
    expect(mapProbeNotice({ ok: true }))
      .toEqual({ text: '底图源可用，探测到 0 字节瓦片', tone: 'success' })
  })
})

describe('map source draft reloading', () => {
  it('keeps the draft while it still belongs to the seen id, even when the list is a new array', () => {
    const editing = validSource({ id: 'source-1', name: '正在输入的名称' })
    expect(reloadMapSourceDraft(editing, [{ ...editing, name: '服务端返回的名称' }], 'source-1')).toBeNull()
  })

  it('loads the newly selected source', () => {
    const other = validSource({ id: 'source-2', name: '另一个底图' })
    expect(reloadMapSourceDraft(validSource({ id: 'source-1' }), [other], 'source-2')?.name).toBe('另一个底图')
  })

  it('falls back to a blank draft for a new or vanished source', () => {
    // 逐字段断言：草稿的时间戳来自 Date.now()，整体相等会随毫秒跳动而不稳定
    const fresh = reloadMapSourceDraft(validSource({ id: 'source-1' }), [], '')
    expect(fresh?.id).toBe('')
    expect(fresh?.name).toBe('')
    expect(fresh?.urlTemplate).toBe('')
    expect(reloadMapSourceDraft(validSource({ id: 'source-1' }), [], 'source-9')?.id).toBe('')
  })
})

describe('map source commands', () => {
  it('carries the probe reason through the command path', async () => {
    const onNotify = vi.fn()
    await probeMapSource(validSource(), '', vi.fn(async () => ({ ok: false, error: '未找到瓦片 0/0/0' })), onNotify)
    expect(onNotify).toHaveBeenCalledWith('底图源不可用：未找到瓦片 0/0/0', 'error')
  })

  it('probes with the typed api key and leaves the stored one alone when the field is blank', async () => {
    const onProbe = vi.fn(async (_source: MapTileSource) => ({ ok: true, bytes: 1 }))
    await probeMapSource(validSource(), '  typed-key  ', onProbe, vi.fn())
    expect(onProbe.mock.calls[0][0].apiKey).toBe('typed-key')

    await probeMapSource(validSource(), '', onProbe, vi.fn())
    expect('apiKey' in onProbe.mock.calls[1][0]).toBe(false)
  })

  it('reports a save failure and returns nothing so the draft stays on screen', async () => {
    const onNotify = vi.fn()
    const rejected = vi.fn(async () => {
      throw new Error('底图源名称必须是字符串')
    })
    expect(await saveMapSource(validSource(), '', rejected, onNotify)).toBeNull()
    expect(onNotify).toHaveBeenCalledWith('保存底图源失败：底图源名称必须是字符串', 'error')
  })

  it('returns the saved source so the modal can adopt the store-assigned id', async () => {
    const saved = await saveMapSource(validSource(), '', vi.fn(async (value: MapTileSource) => ({ ...value, id: 'source-1' })), vi.fn())
    expect(saved?.id).toBe('source-1')
  })

  it('keeps the dialog on the source when removal is refused', async () => {
    const onNotify = vi.fn()
    const onRemove = vi.fn(async (_sourceId: string) => ({ ok: false, error: '底图源不存在' }))
    expect(await removeMapSource('source-1', onRemove, onNotify)).toBe(false)
    expect(onNotify).toHaveBeenCalledWith('底图源不存在', 'error')
  })

  it('reports a removal that never reached the main process', async () => {
    const onNotify = vi.fn()
    const onRemove = vi.fn(async (_sourceId: string): Promise<{ ok: boolean; error?: string }> => {
      throw new Error('IPC 通道已关闭')
    })
    expect(await removeMapSource('source-1', onRemove, onNotify)).toBe(false)
    expect(onNotify).toHaveBeenCalledWith('删除底图源失败：IPC 通道已关闭', 'error')
  })
})

describe('MapSourceModal rendering', () => {
  it('renders the empty state when no source is selected', () => {
    expect(renderModal()).toContain('尚未配置底图源')
  })

  it('renders the preset list for a new source', () => {
    const markup = renderModal()
    expect(markup).toContain('高德矢量')
    expect(markup).toContain('OpenStreetMap')
  })

  it('offers the presets only for a new source, and lists saved sources', () => {
    const saved = validSource({ id: 'source-1', name: '高德 imagery' })
    const markup = renderModal({ sources: [saved], selectedId: 'source-1' })
    expect(markup).toContain('高德 imagery')
    expect(markup).toContain('在线地址模板')
    expect(markup).not.toContain('从预设开始')
  })

  it('tells the user to leave the api key blank when one is already stored', () => {
    const saved = validSource({ id: 'source-1' })
    const markup = renderModal({ sources: [{ ...saved, hasApiKey: true }], selectedId: 'source-1' })
    expect(markup).toContain('已保存，留空则不修改')
  })

  it('asks for the api key placeholder when nothing is stored yet', () => {
    expect(renderModal({ sources: [validSource({ id: 'source-1' })], selectedId: 'source-1' }))
      .toContain('模板中的 {key} 占位符')
  })
})
