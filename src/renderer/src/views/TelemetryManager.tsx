import { useEffect, useMemo, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Download,
  Eye,
  EyeOff,
  ListTree,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  Trash2,
  Upload,
} from 'lucide-react'
import type {
  DeviceType,
  TelemetryDeviceLayout,
  TelemetryLayoutConfig,
  TelemetryLayoutField,
  TelemetryLayoutSection,
  TelemetryLayoutTab,
} from '../../../shared/contracts'
import { parseTelemetryLayoutConfig } from '../../../shared/telemetry-layout'
import { Tooltip } from '../components/Tooltip'
import {
  DJI_DOCK2_PROPERTY_DOC_DATE,
  djiAccessModeLabel,
  djiPushModeLabel,
} from '../lib/dji-field-metadata'
import { DJI_AIRCRAFT_PROPERTY_DOC_DATE } from '../lib/dji-aircraft-field-metadata'
import {
  DJI_DOCK3_PROPERTY_DOC_DATE,
  getDjiDock3FieldMetadata,
} from '../lib/dji-dock3-field-metadata'
import {
  createDefaultTelemetryLayout,
  telemetryCustomPropertyMetadata,
  telemetryOfficialFieldMetadata,
  updateTelemetryLayoutTimestamp,
} from '../lib/telemetry-layout'

interface TelemetryManagerProps {
  config: TelemetryLayoutConfig
  onChange: (config: TelemetryLayoutConfig) => void
  onNotify: (message: string, tone?: 'info' | 'success' | 'error') => void
}

const deviceLabels: Record<DeviceType, string> = {
  dock: '机场',
  aircraft: '飞机',
  pilot: '遥控器',
}

const cloneLayout = (layout: TelemetryDeviceLayout): TelemetryDeviceLayout => ({
  fields: layout.fields.map((field) => ({
    ...field,
    propertySetting: field.propertySetting ? { ...field.propertySetting } : undefined,
  })),
  tabs: layout.tabs.map((tab) => ({
    ...tab,
    sections: tab.sections.map((section) => ({ ...section, fieldKeys: [...section.fieldKeys] })),
  })),
})

const move = <T,>(items: T[], index: number, direction: -1 | 1): T[] => {
  const target = index + direction
  if (target < 0 || target >= items.length) return items
  const next = [...items]
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}

const createId = (prefix: string): string => `${prefix}-${crypto.randomUUID()}`

export function TelemetryManager({ config, onChange, onNotify }: TelemetryManagerProps) {
  const [deviceType, setDeviceType] = useState<DeviceType>('aircraft')
  const [selectedTabId, setSelectedTabId] = useState('')
  const [selectedSectionId, setSelectedSectionId] = useState('')
  const [selectedFieldKey, setSelectedFieldKey] = useState('')
  const [search, setSearch] = useState('')
  const layout = config.devices[deviceType]
  const selectedTab = layout.tabs.find((tab) => tab.id === selectedTabId) ?? layout.tabs[0]
  const selectedSection = selectedTab?.sections.find((section) => section.id === selectedSectionId)
    ?? selectedTab?.sections[0]
  const fieldsByKey = useMemo(
    () => new Map(layout.fields.map((field) => [field.key, field])),
    [layout.fields],
  )
  const sectionFields = (selectedSection?.fieldKeys ?? []).flatMap((key) => {
    const field = fieldsByKey.get(key)
    return field ? [field] : []
  })
  const query = search.trim().toLocaleLowerCase()
  const filteredFields = sectionFields.filter((field) => {
    if (!query) return true
    const metadata = telemetryOfficialFieldMetadata(deviceType, field.key)
      ?? telemetryCustomPropertyMetadata(field)
    return `${field.label} ${field.key} ${field.description} ${djiAccessModeLabel(metadata?.accessMode) ?? ''} ${metadata?.type ?? ''}`
      .toLocaleLowerCase()
      .includes(query)
  })
  const selectedField = fieldsByKey.get(selectedFieldKey) ?? sectionFields[0]
  const selectedOfficialMetadata = selectedField
    ? telemetryOfficialFieldMetadata(deviceType, selectedField.key)
    : undefined
  const selectedCustomMetadata = selectedOfficialMetadata
    ? undefined
    : telemetryCustomPropertyMetadata(selectedField)
  const selectedMetadata = selectedOfficialMetadata ?? selectedCustomMetadata
  const selectedPropertySetting = selectedField?.propertySetting ?? {
    enabled: false,
    path: selectedField?.key ?? '',
    type: 'text' as const,
    constraint: '',
  }
  const metadataSource = selectedOfficialMetadata
    ? deviceType === 'dock'
      ? getDjiDock3FieldMetadata(selectedField?.key ?? '')
        ? `DJI Dock 2 / Dock 3 设备属性 · ${DJI_DOCK2_PROPERTY_DOC_DATE} / ${DJI_DOCK3_PROPERTY_DOC_DATE}`
        : `DJI Dock 2 设备属性 · ${DJI_DOCK2_PROPERTY_DOC_DATE}`
      : `DJI 飞行器设备属性（通用字段） · ${DJI_AIRCRAFT_PROPERTY_DOC_DATE}`
    : selectedCustomMetadata
      ? '遥测项管理 · 自定义属性设置'
      : '未关联官方物模型元数据'

  useEffect(() => {
    setSelectedTabId(layout.tabs[0]?.id ?? '')
    setSelectedSectionId(layout.tabs[0]?.sections[0]?.id ?? '')
    setSelectedFieldKey(layout.tabs[0]?.sections[0]?.fieldKeys[0] ?? '')
    setSearch('')
  }, [deviceType])

  useEffect(() => {
    if (!selectedTab) return
    if (!selectedTab.sections.some((section) => section.id === selectedSectionId)) {
      setSelectedSectionId(selectedTab.sections[0]?.id ?? '')
    }
  }, [selectedTab, selectedSectionId])

  useEffect(() => {
    if (!selectedSection) return
    if (!selectedSection.fieldKeys.includes(selectedFieldKey)) {
      setSelectedFieldKey(selectedSection.fieldKeys[0] ?? '')
    }
  }, [selectedSection, selectedFieldKey])

  const commit = (nextLayout: TelemetryDeviceLayout): void => {
    onChange(updateTelemetryLayoutTimestamp({
      ...config,
      devices: { ...config.devices, [deviceType]: nextLayout },
    }))
  }

  const updateTab = (tabId: string, updater: (tab: TelemetryLayoutTab) => TelemetryLayoutTab): void => {
    const next = cloneLayout(layout)
    next.tabs = next.tabs.map((tab) => tab.id === tabId ? updater(tab) : tab)
    commit(next)
  }

  const updateSection = (
    tabId: string,
    sectionId: string,
    updater: (section: TelemetryLayoutSection) => TelemetryLayoutSection,
  ): void => updateTab(tabId, (tab) => ({
    ...tab,
    sections: tab.sections.map((section) => section.id === sectionId ? updater(section) : section),
  }))

  const updateField = (key: string, updater: (field: TelemetryLayoutField) => TelemetryLayoutField): void => {
    const next = cloneLayout(layout)
    next.fields = next.fields.map((field) => field.key === key ? updater(field) : field)
    commit(next)
  }

  const updatePropertySetting = (
    updater: (setting: NonNullable<TelemetryLayoutField['propertySetting']>) => NonNullable<TelemetryLayoutField['propertySetting']>,
  ): void => {
    if (!selectedField || selectedOfficialMetadata) return
    updateField(selectedField.key, (field) => ({
      ...field,
      propertySetting: updater(field.propertySetting ?? {
        enabled: false,
        path: field.key,
        type: 'text',
        constraint: '',
      }),
    }))
  }

  const addTab = (): void => {
    const tabId = createId('tab')
    const sectionId = createId('section')
    const next = cloneLayout(layout)
    next.tabs.push({
      id: tabId,
      name: '新一级页签',
      kind: 'custom',
      sections: [{ id: sectionId, name: '新二级页签', kind: 'custom', fieldKeys: [] }],
    })
    commit(next)
    setSelectedTabId(tabId)
    setSelectedSectionId(sectionId)
    setSelectedFieldKey('')
  }

  const removeTab = (tabId: string): void => {
    if (layout.tabs.length <= 1) {
      onNotify('至少保留一个一级页签', 'error')
      return
    }
    const next = cloneLayout(layout)
    const removed = next.tabs.find((tab) => tab.id === tabId)
    next.tabs = next.tabs.filter((tab) => tab.id !== tabId)
    const target = next.tabs[0]?.sections[0]
    if (target && removed) target.fieldKeys.push(...removed.sections.flatMap((section) => section.fieldKeys))
    commit(next)
    setSelectedTabId(next.tabs[0]?.id ?? '')
  }

  const addSection = (): void => {
    if (!selectedTab) return
    const sectionId = createId('section')
    updateTab(selectedTab.id, (tab) => ({
      ...tab,
      sections: [...tab.sections, { id: sectionId, name: '新二级页签', kind: 'custom', fieldKeys: [] }],
    }))
    setSelectedSectionId(sectionId)
    setSelectedFieldKey('')
  }

  const removeSection = (sectionId: string): void => {
    if (!selectedTab || selectedTab.sections.length <= 1) {
      onNotify('每个一级页签至少保留一个二级页签', 'error')
      return
    }
    const removed = selectedTab.sections.find((section) => section.id === sectionId)
    const target = selectedTab.sections.find((section) => section.id !== sectionId)
    updateTab(selectedTab.id, (tab) => ({
      ...tab,
      sections: tab.sections
        .filter((section) => section.id !== sectionId)
        .map((section) => section.id === target?.id && removed
          ? { ...section, fieldKeys: [...section.fieldKeys, ...removed.fieldKeys] }
          : section),
    }))
    setSelectedSectionId(target?.id ?? '')
  }

  const moveFieldTo = (key: string, targetTabId: string, targetSectionId: string): void => {
    const next = cloneLayout(layout)
    next.tabs.forEach((tab) => tab.sections.forEach((section) => {
      section.fieldKeys = section.fieldKeys.filter((fieldKey) => fieldKey !== key)
    }))
    const target = next.tabs.find((tab) => tab.id === targetTabId)
      ?.sections.find((section) => section.id === targetSectionId)
    target?.fieldKeys.push(key)
    commit(next)
    setSelectedTabId(targetTabId)
    setSelectedSectionId(targetSectionId)
    setSelectedFieldKey(key)
  }

  const handleImport = async (): Promise<void> => {
    const result = await window.djiApi.dialogs.importTelemetryLayout()
    if (result.canceled) return
    if (result.error) {
      onNotify(result.error, 'error')
      return
    }
    try {
      const imported = parseTelemetryLayoutConfig(result.data)
      onChange({ ...imported, updatedAt: Date.now() })
      onNotify('遥测项配置已导入', 'success')
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  const handleExport = async (): Promise<void> => {
    const result = await window.djiApi.dialogs.exportTelemetryLayout(config)
    onNotify(result.ok ? '遥测项配置已导出' : result.error ?? '导出失败', result.ok ? 'success' : 'error')
  }

  const reset = (): void => {
    if (!window.confirm('恢复默认遥测项配置？当前编辑内容将被替换。')) return
    onChange(createDefaultTelemetryLayout())
    onNotify('已恢复默认遥测项配置', 'success')
  }

  return (
    <div className="telemetry-manager">
      <header className="telemetry-manager-toolbar">
        <div className="segmented telemetry-device-segmented">
          {(Object.keys(deviceLabels) as DeviceType[]).map((type) => (
            <button key={type} className={deviceType === type ? 'active' : ''} onClick={() => setDeviceType(type)}>
              {deviceLabels[type]}
            </button>
          ))}
        </div>
        <span className="telemetry-manager-summary">
          {layout.tabs.length} 个一级页签 · {layout.tabs.reduce((count, tab) => count + tab.sections.length, 0)} 个二级页签 · {layout.fields.length} 个字段
        </span>
        <span className="toolbar-spacer" />
        <Tooltip label="导入配置">
          <button className="icon-button" onClick={() => void handleImport()}><Upload size={16} /></button>
        </Tooltip>
        <Tooltip label="导出配置">
          <button className="icon-button" onClick={() => void handleExport()}><Download size={16} /></button>
        </Tooltip>
        <Tooltip label="恢复默认">
          <button className="icon-button" onClick={reset}><RotateCcw size={16} /></button>
        </Tooltip>
      </header>

      <div className="telemetry-manager-layout">
        <aside className="telemetry-manager-hierarchy">
          <section>
            <header><span><ListTree size={15} />一级页签</span><button onClick={addTab}><Plus size={15} /></button></header>
            <div className="telemetry-block-list">
              {layout.tabs.map((tab, index) => (
                <div className={`telemetry-config-block ${selectedTab?.id === tab.id ? 'selected' : ''}`} key={tab.id}>
                  <button className="telemetry-config-select" onClick={() => setSelectedTabId(tab.id)}>
                    <strong>{tab.name || '未命名页签'}</strong><small>{tab.sections.reduce((count, item) => count + item.fieldKeys.length, 0)}</small>
                  </button>
                  <span className="telemetry-config-actions">
                    <button disabled={index === 0} onClick={() => commit({ ...cloneLayout(layout), tabs: move(layout.tabs, index, -1) })}><ArrowUp size={13} /></button>
                    <button disabled={index === layout.tabs.length - 1} onClick={() => commit({ ...cloneLayout(layout), tabs: move(layout.tabs, index, 1) })}><ArrowDown size={13} /></button>
                    <button disabled={layout.tabs.length <= 1} onClick={() => removeTab(tab.id)}><Trash2 size={13} /></button>
                  </span>
                </div>
              ))}
            </div>
            {selectedTab && (
              <label className="telemetry-config-name"><span>一级页签名称</span><input value={selectedTab.name} onChange={(event) => updateTab(selectedTab.id, (tab) => ({ ...tab, name: event.target.value }))} /></label>
            )}
          </section>

          <section>
            <header><span>二级页签</span><button onClick={addSection}><Plus size={15} /></button></header>
            <div className="telemetry-block-list">
              {selectedTab?.sections.map((section, index) => (
                <div className={`telemetry-config-block ${selectedSection?.id === section.id ? 'selected' : ''}`} key={section.id}>
                  <button className="telemetry-config-select" onClick={() => setSelectedSectionId(section.id)}>
                    <strong>{section.name || '未命名页签'}</strong><small>{section.fieldKeys.length}</small>
                  </button>
                  <span className="telemetry-config-actions">
                    <button disabled={index === 0} onClick={() => updateTab(selectedTab.id, (tab) => ({ ...tab, sections: move(tab.sections, index, -1) }))}><ArrowUp size={13} /></button>
                    <button disabled={index === selectedTab.sections.length - 1} onClick={() => updateTab(selectedTab.id, (tab) => ({ ...tab, sections: move(tab.sections, index, 1) }))}><ArrowDown size={13} /></button>
                    <button disabled={selectedTab.sections.length <= 1} onClick={() => removeSection(section.id)}><Trash2 size={13} /></button>
                  </span>
                </div>
              ))}
            </div>
            {selectedTab && selectedSection && (
              <label className="telemetry-config-name"><span>二级页签名称</span><input value={selectedSection.name} onChange={(event) => updateSection(selectedTab.id, selectedSection.id, (section) => ({ ...section, name: event.target.value }))} /></label>
            )}
          </section>
        </aside>

        <section className="telemetry-manager-fields">
          <header>
            <div className="telemetry-manager-search"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索名称、字段名或描述" /></div>
          </header>
          <div className="telemetry-field-config-list">
            {filteredFields.map((field) => {
              const index = selectedSection?.fieldKeys.indexOf(field.key) ?? -1
              const metadata = telemetryOfficialFieldMetadata(deviceType, field.key)
                ?? telemetryCustomPropertyMetadata(field)
              return (
                <div className={`telemetry-field-config-row ${selectedField?.key === field.key ? 'selected' : ''}`} key={field.key}>
                  <button className="telemetry-field-config-main" onClick={() => setSelectedFieldKey(field.key)}>
                    {field.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                    <span>
                      <span className="telemetry-field-config-title">
                        <strong>{field.label || field.key}</strong>
                        {metadata?.accessMode && (
                          <small className={`telemetry-property-badge ${metadata.accessMode}`}>
                            {djiAccessModeLabel(metadata.accessMode)}
                          </small>
                        )}
                      </span>
                      <code>{field.key}</code>
                    </span>
                  </button>
                  <span className="telemetry-config-actions">
                    <button disabled={index <= 0} onClick={() => selectedTab && selectedSection && updateSection(selectedTab.id, selectedSection.id, (section) => ({ ...section, fieldKeys: move(section.fieldKeys, index, -1) }))}><ArrowUp size={13} /></button>
                    <button disabled={index < 0 || index === (selectedSection?.fieldKeys.length ?? 0) - 1} onClick={() => selectedTab && selectedSection && updateSection(selectedTab.id, selectedSection.id, (section) => ({ ...section, fieldKeys: move(section.fieldKeys, index, 1) }))}><ArrowDown size={13} /></button>
                  </span>
                </div>
              )
            })}
            {!filteredFields.length && <div className="panel-empty small"><Search size={20} /><span>当前二级页签没有匹配字段</span></div>}
          </div>
        </section>

        <section className="telemetry-field-editor">
          {selectedField ? (
            <>
              <header>
                <div><span>指标项</span><strong>{selectedField.label || selectedField.key}</strong></div>
                <button className={`visibility-toggle ${selectedField.visible ? 'active' : ''}`} onClick={() => updateField(selectedField.key, (field) => ({ ...field, visible: !field.visible }))}>{selectedField.visible ? <Eye size={15} /> : <EyeOff size={15} />}{selectedField.visible ? '显示' : '隐藏'}</button>
              </header>
              <div className="telemetry-field-editor-form">
                <label><span>原始字段名</span><code>{selectedField.key}</code></label>
                <label><span>显示名称</span><input value={selectedField.label} onChange={(event) => updateField(selectedField.key, (field) => ({ ...field, label: event.target.value }))} /></label>
                <label><span>字段描述</span><textarea rows={8} value={selectedField.description} onChange={(event) => updateField(selectedField.key, (field) => ({ ...field, description: event.target.value }))} placeholder="输入悬浮提示中展示的字段说明" /></label>
                <label><span>所属页签</span><select value={JSON.stringify([selectedTab?.id ?? '', selectedSection?.id ?? ''])} onChange={(event) => {
                  const [tabId, sectionId] = JSON.parse(event.target.value) as [string, string]
                  moveFieldTo(selectedField.key, tabId, sectionId)
                }}>{layout.tabs.flatMap((tab) => tab.sections.map((section) => <option value={JSON.stringify([tab.id, section.id])} key={`${tab.id}:${section.id}`}>{tab.name || '未命名页签'} / {section.name || '未命名页签'}</option>))}</select></label>

                <section className="telemetry-property-editor">
                  <header>
                    <span><Settings2 size={15} />属性设置</span>
                    {selectedMetadata?.accessMode && (
                      <small className={`telemetry-property-badge ${selectedMetadata.accessMode}`}>
                        {djiAccessModeLabel(selectedMetadata.accessMode)}
                      </small>
                    )}
                  </header>
                  {selectedOfficialMetadata ? (
                    <>
                      <div className="telemetry-property-meta-grid">
                        <span><small>权限</small><strong>{djiAccessModeLabel(selectedOfficialMetadata.accessMode) ?? '未声明'}</strong></span>
                        <span><small>类型</small><code>{selectedOfficialMetadata.type}</code></span>
                        <span><small>上报</small><strong>{djiPushModeLabel(selectedOfficialMetadata.pushMode) ?? '未声明'}</strong></span>
                        <span><small>单位</small><strong>{selectedOfficialMetadata.unit ?? '无'}</strong></span>
                      </div>
                      {selectedOfficialMetadata.constraint && (
                        <div className="telemetry-property-constraint"><span>字段约束</span><code>{selectedOfficialMetadata.constraint}</code></div>
                      )}
                      <div className="telemetry-property-source"><span>元数据来源</span><strong>{metadataSource}</strong></div>
                    </>
                  ) : (
                    <>
                      <label className="check-field telemetry-property-enable">
                        <input
                          type="checkbox"
                          checked={selectedPropertySetting.enabled}
                          onChange={(event) => updatePropertySetting((setting) => ({ ...setting, enabled: event.target.checked }))}
                        />
                        <span>允许通过 property/set 设置</span>
                      </label>
                      {selectedPropertySetting.enabled && (
                        <div className="telemetry-custom-property-fields">
                          <label>
                            <span>下发字段路径</span>
                            <input
                              value={selectedPropertySetting.path}
                              onChange={(event) => updatePropertySetting((setting) => ({ ...setting, path: event.target.value }))}
                            />
                          </label>
                          <label>
                            <span>数据类型</span>
                            <select
                              value={selectedPropertySetting.type}
                              onChange={(event) => updatePropertySetting((setting) => ({
                                ...setting,
                                type: event.target.value as NonNullable<TelemetryLayoutField['propertySetting']>['type'],
                              }))}
                            >
                              <option value="bool">布尔值</option>
                              <option value="enum_int">整数枚举</option>
                              <option value="int">整数</option>
                              <option value="float">浮点数</option>
                              <option value="double">双精度数值</option>
                              <option value="text">文本</option>
                              <option value="enum_string">文本枚举</option>
                              <option value="date">时间</option>
                              <option value="struct">JSON 对象</option>
                              <option value="array">JSON 数组</option>
                            </select>
                          </label>
                          <label>
                            <span>约束 / 枚举 JSON</span>
                            <textarea
                              rows={5}
                              value={selectedPropertySetting.constraint}
                              onChange={(event) => updatePropertySetting((setting) => ({ ...setting, constraint: event.target.value }))}
                              placeholder={'{"min":0,"max":100,"step":1}'}
                            />
                          </label>
                          <div className="telemetry-property-source"><span>元数据来源</span><strong>{metadataSource}</strong></div>
                        </div>
                      )}
                    </>
                  )}
                </section>
              </div>
            </>
          ) : <div className="panel-empty"><ListTree size={24} /><span>选择一个指标项进行编辑</span></div>}
        </section>
      </div>
    </div>
  )
}
