import { useMemo, useState } from 'react'
import { Cloud, Database, DatabaseBackup, ListTree, PanelLeft, RefreshCw, RotateCcw, Search, SlidersHorizontal } from 'lucide-react'
import type { ObjectStorageProfile, OperationResult, TelemetryLayoutConfig, WebDavOverview } from '../../../shared/contracts'
import packageMetadata from '../../../../package.json'
import { AppUpdatePanel } from '../components/AppUpdatePanel'
import { DataVersions } from './DataVersions'
import { DjiConfigCenter } from './DjiConfigCenter'
import { OssManager } from './OssManager'
import { createDefaultTelemetryLayout } from '../lib/telemetry-layout'

export type SettingsSection = 'general' | 'oss' | 'sync' | 'telemetry' | 'updates'

interface SettingsCenterProps {
  sidebarWidth: number
  defaultSidebarWidth: number
  minSidebarWidth: number
  maxSidebarWidth: number
  onSidebarWidthChange: (width: number) => void
  section?: SettingsSection
  onSectionChange?: (section: SettingsSection) => void
  objectStorageProfiles?: ObjectStorageProfile[]
  activeObjectStorageId?: string
  onSelectObjectStorage?: (profileId: string) => void
  onSaveObjectStorage?: (profile: ObjectStorageProfile) => Promise<ObjectStorageProfile>
  onRemoveObjectStorage?: (profileId: string) => Promise<OperationResult>
  onNotify?: (text: string, tone?: 'info' | 'success' | 'error') => void
  onOverviewChange?: (overview: WebDavOverview) => void
  telemetryConfig?: TelemetryLayoutConfig
  onTelemetryChange?: (config: TelemetryLayoutConfig) => void
}

const sections: Array<{
  id: SettingsSection
  label: string
  description: string
  icon: typeof SlidersHorizontal
}> = [
  { id: 'general', label: '常规', description: '窗口与界面', icon: SlidersHorizontal },
  { id: 'oss', label: '对象存储', description: '日志与固件资源', icon: Database },
  { id: 'sync', label: '云同步', description: 'WebDAV 加密同步', icon: Cloud },
  { id: 'telemetry', label: '监测布局', description: '页签与字段设置', icon: ListTree },
  { id: 'updates', label: '软件更新', description: '版本与安装包', icon: RefreshCw },
]

export function SettingsCenter({
  sidebarWidth,
  defaultSidebarWidth,
  minSidebarWidth,
  maxSidebarWidth,
  onSidebarWidthChange,
  section,
  onSectionChange,
  objectStorageProfiles = [],
  activeObjectStorageId = '',
  onSelectObjectStorage = () => undefined,
  onSaveObjectStorage = async (profile) => profile,
  onRemoveObjectStorage = async () => ({ ok: true }),
  onNotify = () => undefined,
  onOverviewChange,
  telemetryConfig,
  onTelemetryChange = () => undefined,
}: SettingsCenterProps) {
  const [localSection, setLocalSection] = useState<SettingsSection>('general')
  const activeSection = section ?? localSection
  const [query, setQuery] = useState('')
  const filteredSections = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase()
    if (!keyword) return sections
    return sections.filter((section) => `${section.label} ${section.description}`.toLocaleLowerCase().includes(keyword))
  }, [query])
  const activeMeta = sections.find((section) => section.id === activeSection) ?? sections[0]
  const ActiveIcon = activeMeta.icon
  const selectSection = (next: SettingsSection): void => {
    setLocalSection(next)
    onSectionChange?.(next)
  }

  return (
    <div className="settings-center">
      <aside className="settings-navigation">
        <label className="settings-search">
          <Search size={15} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索设置" />
        </label>
        <nav aria-label="设置分类">
          {filteredSections.map((section) => {
            const SectionIcon = section.icon
            return (
              <button
                key={section.id}
                className={activeSection === section.id ? 'active' : ''}
                onClick={() => selectSection(section.id)}
              >
                <SectionIcon size={17} />
                <span><strong>{section.label}</strong><small>{section.description}</small></span>
              </button>
            )
          })}
          {!filteredSections.length && <span className="settings-search-empty">没有匹配的设置</span>}
        </nav>
      </aside>

      <section className="settings-detail" aria-labelledby="settings-section-title">
        <header className="settings-detail-header">
          <span><ActiveIcon size={20} /></span>
          <div>
            <h2 id="settings-section-title">{activeMeta.label}</h2>
            <p>{activeMeta.description}</p>
          </div>
        </header>

        {activeSection === 'general' ? (
          <>
            <div className="settings-group">
              <div className="settings-group-heading">
                <PanelLeft size={16} />
                <div><h3>设备侧栏</h3><p>调整设备工作台左侧连接与设备区域的宽度。</p></div>
              </div>
              <div className="settings-control-row">
                <div><strong>侧栏宽度</strong><span>{sidebarWidth}px</span></div>
                <div className="settings-range-control">
                  <input
                    type="range"
                    min={minSidebarWidth}
                    max={maxSidebarWidth}
                    step={10}
                    value={sidebarWidth}
                    aria-label="设备侧栏宽度"
                    onChange={(event) => onSidebarWidthChange(Number(event.target.value))}
                  />
                  <button
                    className="button secondary compact"
                    disabled={sidebarWidth === defaultSidebarWidth}
                    onClick={() => onSidebarWidthChange(defaultSidebarWidth)}
                  >
                    <RotateCcw size={14} />恢复默认
                  </button>
                </div>
              </div>
            </div>

            <div className="settings-group">
              <div className="settings-group-heading">
                <DatabaseBackup size={16} />
                <div><h3>本地数据</h3><p>界面状态只落本机，跨设备同步由云同步负责。</p></div>
              </div>
              <div className="settings-control-row">
                <div><strong>渲染进程存储</strong><span>localStorage 键沿用历史前缀（改名后不迁移键名），并纳入 WebDAV 快照白名单。</span></div>
                <span className="settings-status">自动保存</span>
              </div>
              <div className="settings-control-row">
                <div><strong>云同步</strong><span>连接配置、设备档案、对象存储、媒体服务与界面设置聚合为可移植版本。</span></div>
                <span className="settings-status neutral">在“云同步”页面管理</span>
              </div>
            </div>

            <div className="settings-group">
              <div className="settings-group-heading">
                <RefreshCw size={16} />
                <div><h3>软件更新</h3><p>检查 GitHub Releases，下载与当前平台匹配的安装包并校验 SHA-256。</p></div>
              </div>
              <div className="settings-control-row">
                <div><strong>HangarLab Studio v{packageMetadata.version}</strong><span>启动 5 秒后静默检查一次；下载完成前使用 SHA256SUMS.txt 校验。</span></div>
                <div className="footer-actions"><button className="button secondary compact" onClick={() => selectSection('updates')}>查看更新</button></div>
              </div>
            </div>
          </>
        ) : activeSection === 'oss' ? (
          <div className="settings-embedded-page">
            <OssManager
              profiles={objectStorageProfiles}
              selectedId={activeObjectStorageId}
              onSelect={onSelectObjectStorage}
              onSave={onSaveObjectStorage}
              onRemove={onRemoveObjectStorage}
              onNotify={onNotify}
            />
          </div>
        ) : activeSection === 'sync' ? (
          <div className="settings-embedded-page">
            <DataVersions onNotify={onNotify} onOverviewChange={onOverviewChange} />
          </div>
        ) : activeSection === 'telemetry' ? (
          <div className="settings-embedded-page settings-telemetry-page">
            <DjiConfigCenter
              config={telemetryConfig ?? createDefaultTelemetryLayout()}
              onChange={onTelemetryChange}
              onNotify={onNotify}
            />
          </div>
        ) : (
          <div className="settings-group settings-update-group">
            <div className="settings-group-heading">
              <RefreshCw size={16} />
              <div><h3>航坞联调台</h3><p>检查 GitHub Releases 并下载适用于当前平台的安装包。</p></div>
            </div>
            <AppUpdatePanel />
          </div>
        )}
      </section>
    </div>
  )
}
