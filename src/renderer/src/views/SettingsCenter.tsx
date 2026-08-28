import { useMemo, useState } from 'react'
import { PanelLeft, RefreshCw, RotateCcw, Search, SlidersHorizontal } from 'lucide-react'
import { AppUpdatePanel } from '../components/AppUpdatePanel'

type SettingsSection = 'general' | 'updates'

interface SettingsCenterProps {
  sidebarWidth: number
  defaultSidebarWidth: number
  minSidebarWidth: number
  maxSidebarWidth: number
  onSidebarWidthChange: (width: number) => void
}

const sections: Array<{
  id: SettingsSection
  label: string
  description: string
  icon: typeof SlidersHorizontal
}> = [
  { id: 'general', label: '常规', description: '窗口与界面', icon: SlidersHorizontal },
  { id: 'updates', label: '软件更新', description: '版本与安装包', icon: RefreshCw },
]

export function SettingsCenter({
  sidebarWidth,
  defaultSidebarWidth,
  minSidebarWidth,
  maxSidebarWidth,
  onSidebarWidthChange,
}: SettingsCenterProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>('general')
  const [query, setQuery] = useState('')
  const filteredSections = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase()
    if (!keyword) return sections
    return sections.filter((section) => `${section.label} ${section.description}`.toLocaleLowerCase().includes(keyword))
  }, [query])
  const activeMeta = sections.find((section) => section.id === activeSection) ?? sections[0]
  const ActiveIcon = activeMeta.icon

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
                onClick={() => setActiveSection(section.id)}
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
        ) : (
          <div className="settings-group settings-update-group">
            <div className="settings-group-heading">
              <RefreshCw size={16} />
              <div><h3>DJI Cloud Studio</h3><p>检查 GitHub Releases 并下载适用于当前平台的安装包。</p></div>
            </div>
            <AppUpdatePanel />
          </div>
        )}
      </section>
    </div>
  )
}
