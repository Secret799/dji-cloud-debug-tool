import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  MAP_TILE_PRESETS,
  MapSourceModal,
  applyMapTilePreset,
  applyPickedPath,
  applyTerrainPreset,
  buildMapTileSourcePayload,
  createMapTileSource,
  mapProbeNotice,
  mapSourcePresetOptions,
  mapSourceReloadKey,
  mapSourcesWithDefault,
  mapTileSourceDraftForLayer,
  mapTileSourceIssues,
  mapTileSourceKindsForLayer,
  mapTileSourceNameFromPath,
  probeMapSource,
  reloadMapSourceDraft,
  terrainTokenLabel,
  removeMapSource,
  saveMapSource,
  setDefaultMapSource,
} from './MapSourceModal'
import type { MapSourceModalProps } from './MapSourceModal'
import { TERRAIN_PRESETS, createTerrainSource } from '../lib/terrain-source'
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

/** 已经能通过校验的 Cesium ion 地形源 */
const validTerrain = (patch: Partial<MapTileSource> = {}): MapTileSource => ({
  ...createTerrainSource('terrain-ion'),
  name: '示例地形',
  ...patch,
})

const renderModal = (overrides: Partial<MapSourceModalProps> = {}): string => renderToStaticMarkup(
  <MapSourceModal
    sources={[]}
    selectedId=""
    onSelect={vi.fn()}
    onSave={vi.fn(async (value: MapTileSource) => value)}
    onSourcesChange={vi.fn()}
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

describe('map tile source layers', () => {
  it('splits the kind options by layer', () => {
    expect(mapTileSourceKindsForLayer('imagery')).toEqual(['url-template', 'directory', 'mbtiles'])
    expect(mapTileSourceKindsForLayer('terrain')).toEqual(['terrain-ion', 'terrain-arcgis', 'terrain-url'])
  })

  it('rebuilds the draft for the target layer instead of patching the layer field', () => {
    const imagery = validSource({
      id: 'source-1',
      name: '我的底图',
      kind: 'directory',
      path: '/data/tiles',
      coordinateSystem: 'gcj02',
      minZoom: 3,
      maxZoom: 12,
      tileSize: 512,
    })
    const terrain = mapTileSourceDraftForLayer(imagery, 'terrain')
    expect(terrain.layer).toBe('terrain')
    expect(terrain.kind).toBe('terrain-ion')
    // 影像专属字段必须清掉：留在草稿里会被当成地形源的字段写进存储
    expect(terrain.path).toBe('')
    expect(terrain.coordinateSystem).toBe('wgs84')
    expect(terrain.minZoom).toBe(0)
    expect(terrain.maxZoom).toBe(19)
    expect(terrain.tileSize).toBe(256)
    // 标识与名称与图层无关，切换后仍在编辑同一条源
    expect(terrain.id).toBe('source-1')
    expect(terrain.name).toBe('我的底图')
  })

  it('rebuilds the draft back into an imagery url template source', () => {
    const terrain = validTerrain({
      id: 'source-2',
      name: '全球地形',
      kind: 'terrain-url',
      urlTemplate: 'https://terrain.example.com/',
    })
    const imagery = mapTileSourceDraftForLayer(terrain, 'imagery')
    expect(imagery.layer).toBe('imagery')
    expect(imagery.kind).toBe('url-template')
    expect(imagery.urlTemplate).toBe('')
    expect(imagery.coordinateSystem).toBe('wgs84')
    expect(imagery.maxZoom).toBe(19)
    expect(imagery.id).toBe('source-2')
    expect(imagery.name).toBe('全球地形')
  })

  it('keeps the very same draft object when the layer does not change', () => {
    const draft = validSource()
    expect(mapTileSourceDraftForLayer(draft, 'imagery')).toBe(draft)
  })

  it('drops the stored key of the other provider when a saved source changes layer', () => {
    // 已保存的影像源存着天地图的 tk，切到地形后草稿仍带着同一个 id：
    // 若不在保存时清掉，ion 请求会拿着天地图的凭据去访问 cesium.com
    const imagery = validSource({ id: 'source-9', name: '我的底图', hasApiKey: true })
    const terrain = mapTileSourceDraftForLayer(imagery, 'terrain', 'imagery')
    expect(terrain.layer).toBe('terrain')
    expect(terrain.id).toBe('source-9')
    expect(terrain.name).toBe('我的底图')
    expect(terrain.hasApiKey).toBeFalsy()
    expect(terrain.clearApiKey).toBe(true)
  })

  it('keeps the credential of the saved source when the user switches back to its layer', () => {
    // 切回原图层时凭据仍然对得上，不能误清；hasApiKey 跟着草稿走
    const imagery = validSource({ id: 'source-10', name: '全球地形', hasApiKey: true })
    const back = mapTileSourceDraftForLayer(imagery, 'terrain', 'terrain')
    expect(back.hasApiKey).toBe(true)
    expect(back.clearApiKey).toBe(false)
  })

  it('does not schedule a clear for a draft that was never saved', () => {
    const unsaved = validSource({ kind: 'directory', path: '/data/tiles' })
    const terrain = mapTileSourceDraftForLayer(unsaved, 'terrain')
    expect(terrain.clearApiKey).toBeFalsy()
    expect(terrain.id).toBe('')
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

describe('terrain presets', () => {
  it('turns every terrain preset into a button that needs a key', () => {
    const options = mapSourcePresetOptions('terrain')
    expect(options.map((option) => option.name)).toEqual(TERRAIN_PRESETS.map((preset) => preset.name))
    expect(options.every((option) => option.requiresKey)).toBe(true)
  })

  it('keeps the imagery presets on the imagery layer', () => {
    expect(mapSourcePresetOptions('imagery').map((option) => option.name))
      .toEqual(MAP_TILE_PRESETS.map((preset) => preset.name))
  })

  it('applies a terrain preset without dragging imagery fields along', () => {
    const option = mapSourcePresetOptions('terrain')[1]
    const applied = option.apply(validSource({
      id: 'source-1',
      name: '',
      path: '/data/tiles',
      coordinateSystem: 'gcj02',
      minZoom: 3,
      maxZoom: 12,
      tileSize: 512,
    }))
    expect(applied.layer).toBe('terrain')
    expect(applied.kind).toBe('terrain-arcgis')
    expect(applied.path).toBe('')
    expect(applied.coordinateSystem).toBe('wgs84')
    expect(applied.maxZoom).toBe(19)
    expect(applied.name).toBe(TERRAIN_PRESETS[1].name)
    expect(applied.id).toBe('source-1')
  })

  it('keeps a name the user already typed when applying a terrain preset', () => {
    const applied = applyTerrainPreset(validTerrain({ name: '我的地形' }), TERRAIN_PRESETS[0])
    expect(applied.name).toBe('我的地形')
    expect(applied.layer).toBe('terrain')
    expect(applied.kind).toBe('terrain-ion')
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

describe('terrain source issues', () => {
  it('delegates to the terrain rules for the vendor hosted kinds', () => {
    expect(mapTileSourceIssues(validTerrain())).toEqual([])
    expect(mapTileSourceIssues(validTerrain({ kind: 'terrain-arcgis' }))).toEqual([])
  })

  it('only asks for an address on a custom terrain url', () => {
    expect(mapTileSourceIssues(validTerrain({ kind: 'terrain-url' }))).toContain('请填写地形服务地址')
    expect(mapTileSourceIssues(validTerrain({ kind: 'terrain-url', urlTemplate: 'ftp://terrain.example.com/' })))
      .toContain('地形服务地址仅支持 HTTP 或 HTTPS')
    expect(mapTileSourceIssues(validTerrain({ kind: 'terrain-url', urlTemplate: 'https://terrain.example.com/' })))
      .toEqual([])
  })

  it('does not ask for the imagery url placeholders on a terrain url', () => {
    const issues = mapTileSourceIssues(validTerrain({ kind: 'terrain-url', urlTemplate: 'https://terrain.example.com/' }))
    expect(issues).not.toContain('URL 模板必须包含 {z} 占位符')
  })

  it('still requires a name', () => {
    expect(mapTileSourceIssues(validTerrain({ name: '  ' }))).toContain('请填写底图源名称')
  })

  it('skips the imagery zoom and header rules', () => {
    const issues = mapTileSourceIssues(validTerrain({
      minZoom: 10,
      maxZoom: 5,
      headers: [{ name: 'Host', value: 'evil.example.com' }],
    }))
    expect(issues).toEqual([])
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

  it('lets a newly typed key win over the pending clear of the stored one', () => {
    // 跨图层切换会在草稿上留下 clearApiKey：主进程先看 clearApiKey 再看 apiKey，
    // 新填的密钥若不撤销该标记，就会被静默丢掉
    const payload = buildMapTileSourcePayload(source({ clearApiKey: true }), 'ion-token')
    expect(payload.apiKey).toBe('ion-token')
    expect(payload.clearApiKey).toBe(false)
  })

  it('keeps the pending clear when no key is typed', () => {
    const payload = buildMapTileSourcePayload(validSource({ clearApiKey: true }), '')
    expect(payload.clearApiKey).toBe(true)
    expect('apiKey' in payload).toBe(false)
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
  // 本组用例覆盖的是 `mapSourceReloadKey` 这个派生值本身的跃迁（空列表 → 列表到位 → 取值翻转；
  // 选中项不变时列表刷新 → 取值不变），以及同一时刻 `reloadMapSourceDraft` 的产出。
  //
  // 未覆盖：React 对 effect 依赖数组的比较本身。仓库测试环境是 node，没有 jsdom、没有 hook 渲染器，
  // 拿不到 `useEffect` 的依赖数组，因此「依赖键变化会让重装 effect 重跑」这一步只由代码阅读
  // 与 task-12-report.md 记录的手工探针验证，不由本文件验证。改动依赖数组时必须人工复核。
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

  it('flips the reload key from blank to the id once an asynchronously loaded list arrives', () => {
    const stored = validSource({ id: 'source-1', name: '已保存的底图' })
    // 第一帧：列表还没回来，选中项无从查得，依赖键是空串，此时重装只会得到一份空草稿
    expect(mapSourceReloadKey([], 'source-1')).toBe('')
    expect(reloadMapSourceDraft(createMapTileSource(), [], 'source-1')?.id).toBe('')
    // 列表到位：依赖键由空串变成 'source-1'，同一时刻能装出已保存的那一份；
    // 这保证后续保存送出的 id 非空，主进程走更新而不是新建出第二份底图源
    expect(mapSourceReloadKey([stored], 'source-1')).toBe('source-1')
    expect(reloadMapSourceDraft(createMapTileSource(), [stored], 'source-1'))
      .toMatchObject({ id: 'source-1', name: '已保存的底图' })
  })

  it('keeps the reload key stable while the list refreshes for the same selection', () => {
    const stored = validSource({ id: 'source-1' })
    const refreshed = [{ ...stored, name: '服务端返回的名称' }, validSource({ id: 'source-2' })]
    // 列表换了新对象但选中项没变，依赖键仍是同一个 id，重装 effect 不会因列表刷新而被触发
    expect(mapSourceReloadKey([stored], 'source-1')).toBe('source-1')
    expect(mapSourceReloadKey(refreshed, 'source-1')).toBe('source-1')
  })

  it('keeps a freshly saved draft when its new id turns into the selection', () => {
    const saved = validSource({ id: 'source-9', name: '刚保存的底图' })
    expect(mapSourceReloadKey([saved], 'source-9')).toBe('source-9')
    expect(reloadMapSourceDraft(saved, [saved], 'source-9')).toBeNull()
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

describe('map tile source default selection', () => {
  it('marks the chosen source as the only default', () => {
    const first = validSource({ id: 'source-1', isDefault: true })
    const second = validSource({ id: 'source-2' })
    const next = mapSourcesWithDefault([first, second], { ...second, isDefault: true })
    expect(next.map((entry) => [entry.id, entry.isDefault])).toEqual([['source-1', false], ['source-2', true]])
  })

  it('forces the chosen source to default even if the caller did not flag it', () => {
    // 主进程返回的默认标记是权威的，但列表收敛不能依赖它，否则一个漏标的返回值就会让默认不动
    const sources = [validSource({ id: 'source-1', isDefault: true }), validSource({ id: 'source-2' })]
    expect(mapSourcesWithDefault(sources, sources[1] as MapTileSource)[1]?.isDefault).toBe(true)
  })

  it('saves the chosen source with isDefault and converges the list to a single default', async () => {
    const onSave = vi.fn(async (value: MapTileSource) => ({ ...value, hasApiKey: true }))
    const onSourcesChange = vi.fn()
    const onNotify = vi.fn()
    const sources = [validSource({ id: 'source-1', isDefault: true, name: '旧默认' }), validSource({ id: 'source-2', name: '新默认' })]
    await setDefaultMapSource(sources[1] as MapTileSource, onSave, onSourcesChange, onNotify)
    expect(onSave.mock.calls[0][0]).toMatchObject({ id: 'source-2', isDefault: true })
    const updater = onSourcesChange.mock.calls[0][0] as (current: MapTileSource[]) => MapTileSource[]
    expect(updater(sources).map((entry) => entry.isDefault)).toEqual([false, true])
    expect(onNotify).toHaveBeenCalledWith('已将新默认设为默认底图源', 'success')
  })

  it('applies the switch to the list as it is when the save returns, not to the list captured at call time', async () => {
    const onSave = vi.fn(async (value: MapTileSource) => ({ ...value, hasApiKey: true }))
    const onSourcesChange = vi.fn()
    const onNotify = vi.fn()
    const sources = [validSource({ id: 'source-1', isDefault: true }), validSource({ id: 'source-2' })]
    await setDefaultMapSource(sources[1] as MapTileSource, onSave, onSourcesChange, onNotify)
    const updater = onSourcesChange.mock.calls[0][0] as (current: MapTileSource[]) => MapTileSource[]
    // 保存被 WebDAV 同步顶住的这段时间里，用户删掉了 source-1、又新建了 source-3：
    // 函数式更新必须按这份新列表收敛，整表覆盖会把删除过的行复活、把新建的行丢掉。
    const current = [validSource({ id: 'source-2' }), validSource({ id: 'source-3' })]
    expect(updater(current).map((entry) => [entry.id, entry.isDefault]))
      .toEqual([['source-2', true], ['source-3', false]])
  })

  it('does nothing when the source is already the default', async () => {
    const onSave = vi.fn()
    const onSourcesChange = vi.fn()
    await setDefaultMapSource(validSource({ id: 'source-1', isDefault: true }), onSave, onSourcesChange, vi.fn())
    expect(onSave).not.toHaveBeenCalled()
    expect(onSourcesChange).not.toHaveBeenCalled()
  })

  it('reports a refused switch and leaves the list untouched', async () => {
    const onSourcesChange = vi.fn()
    const onNotify = vi.fn()
    const rejected = vi.fn(async () => {
      throw new Error('底图源不存在')
    })
    await setDefaultMapSource(validSource({ id: 'source-2' }), rejected, onSourcesChange, onNotify)
    expect(onSourcesChange).not.toHaveBeenCalled()
    expect(onNotify).toHaveBeenCalledWith('设为默认底图源失败：底图源不存在', 'error')
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

  it('offers a default control on every row and disables it on the current default', () => {
    const markup = renderModal({
      sources: [
        validSource({ id: 'source-1', name: '当前默认', isDefault: true }),
        validSource({ id: 'source-2', name: '备选底图' }),
      ],
      selectedId: 'source-1',
    })
    const defaultButton = /<button[^>]*aria-pressed="true"[^>]*>/.exec(markup)?.[0] ?? ''
    const otherButton = /<button[^>]*aria-pressed="false"[^>]*>/.exec(markup)?.[0] ?? ''
    // 默认那条已经是默认，按钮不再可点；非默认那条才是切换入口
    expect(defaultButton).toContain('map-source-default active')
    expect(defaultButton).toContain('disabled')
    expect(otherButton).toContain('map-source-default')
    expect(otherButton).not.toContain('disabled')
    // 徽标与按钮并存：徽标说明现状，按钮负责切换
    expect(markup).toContain('<em>默认</em>')
    expect(markup).toContain('设为默认')
  })
})

describe('terrainTokenLabel', () => {
  it('names the token the way each provider does', () => {
    expect(terrainTokenLabel(validTerrain())).toBe('Cesium ion Access Token')
    expect(terrainTokenLabel(validTerrain({ kind: 'terrain-arcgis' }))).toBe('ArcGIS API Key')
    expect(terrainTokenLabel(validTerrain({ kind: 'terrain-url' }))).toBe('访问令牌（可选）')
  })
})

describe('MapSourceModal terrain rendering', () => {
  /** 取当前被按下的图层按钮文案，用于断言表单处在哪一层 */
  const pressedLayer = (markup: string): string =>
    /<button[^>]*aria-pressed="true"[^>]*>(影像|地形)<\/button>/.exec(markup)?.[1] ?? ''

  it('starts a new source on the imagery layer', () => {
    expect(pressedLayer(renderModal())).toBe('影像')
  })

  it('marks the layer of the selected source as pressed', () => {
    const markup = renderModal({ sources: [validTerrain({ id: 'terrain-1' })], selectedId: 'terrain-1' })
    expect(pressedLayer(markup)).toBe('地形')
  })

  it('asks for the cesium ion token and points at the free registration page', () => {
    const markup = renderModal({ sources: [validTerrain({ id: 'terrain-1' })], selectedId: 'terrain-1' })
    expect(markup).toContain('Cesium ion Access Token')
    expect(markup).toContain('cesium.com/ion')
    expect(markup).not.toContain('高德矢量')
  })

  it('asks for the arcgis key instead when the arcgis kind is selected', () => {
    const markup = renderModal({
      sources: [validTerrain({ id: 'terrain-2', kind: 'terrain-arcgis' })],
      selectedId: 'terrain-2',
    })
    expect(markup).toContain('ArcGIS API Key')
    expect(markup).toContain('developers.arcgis.com')
  })

  it('hides the imagery only fields on the terrain layer', () => {
    const markup = renderModal({ sources: [validTerrain({ id: 'terrain-1' })], selectedId: 'terrain-1' })
    expect(markup).not.toContain('坐标系')
    expect(markup).not.toContain('最小级别')
    expect(markup).not.toContain('URL 模板')
    expect(markup).not.toContain('本地瓦片目录')
    // 版权署名只作用于影像 provider，地形层上没有可写入的位置
    expect(markup).not.toContain('版权署名')
  })

  it('keeps the attribution field and its hint on the imagery layer', () => {
    const markup = renderModal({ sources: [validSource({ id: 'source-1' })], selectedId: 'source-1' })
    expect(markup).toContain('版权署名')
    expect(markup).toContain('署名显示在地图底部')
  })

  it('asks for the quantized mesh root address on a custom terrain url', () => {
    const markup = renderModal({
      sources: [validTerrain({ id: 'terrain-3', kind: 'terrain-url' })],
      selectedId: 'terrain-3',
    })
    expect(markup).toContain('地形服务地址')
    expect(markup).toContain('layer.json')
    expect(markup).not.toContain('{z}/{x}/{y}.png')
  })

  it('keeps the coordinate system and the zoom range on the imagery layer', () => {
    const markup = renderModal({ sources: [validSource({ id: 'source-1' })], selectedId: 'source-1' })
    expect(markup).toContain('坐标系')
    expect(markup).toContain('最小级别')
    expect(markup).not.toContain('Cesium World Terrain')
  })

  it('keeps the stored key hint on a terrain source', () => {
    const markup = renderModal({
      sources: [validTerrain({ id: 'terrain-1', hasApiKey: true })],
      selectedId: 'terrain-1',
    })
    expect(markup).toContain('已保存，留空则不修改')
  })
})
