import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  CheckCircle2,
  ChevronDown,
  Cloud,
  CloudOff,
  DatabaseBackup,
  GitMerge,
  History,
  KeyRound,
  LockKeyhole,
  RefreshCw,
  RotateCcw,
  Server,
  Settings,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import type { WebDavActivity, WebDavConfig, WebDavOverview, WebDavSyncStrategy, WebDavVersion } from '../../../shared/contracts'
import { Tooltip } from '../components/Tooltip'
import { WebDavSettingsModal } from '../components/WebDavSettingsModal'
import { applyRendererStorageSnapshot, rendererStorageSnapshot } from '../lib/webdav-sync'

interface DataVersionsProps {
  onNotify: (text: string, tone?: 'info' | 'success' | 'error') => void
  onOverviewChange?: (overview: WebDavOverview) => void
}

type SyncPageTab = 'service' | 'status'

const emptyOverview: WebDavOverview = {
  configured: false,
  connected: false,
  versions: [],
  activities: [],
}

const formatDate = (timestamp?: number): string => timestamp
  ? new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).format(timestamp).replaceAll('/', '-')
  : '尚无版本'

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

const versionLabel = (version?: WebDavVersion): string => version ? `v${version.revision}` : '--'

const activityCopy: Record<WebDavActivity['type'], { action: string; icon: typeof ArrowUpFromLine }> = {
  upload: { action: '上传', icon: ArrowUpFromLine },
  restore: { action: '恢复', icon: ArrowDownToLine },
  delete: { action: '删除', icon: Trash2 },
}

const syncStrategyOptions: Array<{
  value: WebDavSyncStrategy
  label: string
  description: string
  icon: typeof GitMerge
}> = [
  {
    value: 'smart-merge',
    label: '智能合并（推荐）',
    description: '尽量保留两边的变化；同一记录冲突时使用最新更新。',
    icon: GitMerge,
  },
  {
    value: 'cloud-first',
    label: '云端优先',
    description: '两边都有变化时，下载云端版本并替换本地变化。',
    icon: ArrowDownToLine,
  },
  {
    value: 'local-first',
    label: '本地优先',
    description: '两边都有变化时，上传本地版本并替换云端变化。',
    icon: ArrowUpFromLine,
  },
]

export function DataVersions({ onNotify, onOverviewChange }: DataVersionsProps) {
  const [overview, setOverview] = useState<WebDavOverview>(emptyOverview)
  const [activeTab, setActiveTab] = useState<SyncPageTab>('status')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'sync' | 'refresh' | 'config' | 'test' | `restore:${string}` | `delete:${string}` | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsConfig, setSettingsConfig] = useState<WebDavConfig | undefined>()
  const settingsLoadGeneration = useRef(0)
  const [strategyOpen, setStrategyOpen] = useState(false)
  const strategyControlRef = useRef<HTMLDivElement>(null)

  const applyOverview = useCallback((next: WebDavOverview): void => {
    setOverview(next)
    onOverviewChange?.(next)
  }, [onOverviewChange])

  const refresh = useCallback(async (showError = true): Promise<void> => {
    setBusy((current) => current ?? 'refresh')
    try {
      applyOverview(await window.djiApi.webdav.getOverview())
    } catch (error) {
      if (showError) onNotify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setLoading(false)
      setBusy((current) => current === 'refresh' ? null : current)
    }
  }, [applyOverview, onNotify])

  useEffect(() => { void refresh(false) }, [refresh])

  useEffect(() => window.djiApi.webdav.onSyncCompleted((event) => {
    applyOverview(event.overview)
    setLoading(false)
  }), [applyOverview])

  useEffect(() => () => { settingsLoadGeneration.current += 1 }, [])

  useEffect(() => {
    if (!strategyOpen) return
    const closeOnOutsideClick = (event: MouseEvent): void => {
      if (!strategyControlRef.current?.contains(event.target as Node)) setStrategyOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setStrategyOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [strategyOpen])

  const openSettings = async (): Promise<void> => {
    if (busy) return
    const generation = settingsLoadGeneration.current + 1
    settingsLoadGeneration.current = generation
    setBusy('config')
    try {
      const resolved = overview.configured ? await window.djiApi.webdav.resolveConfig() : undefined
      if (settingsLoadGeneration.current !== generation) return
      setSettingsConfig(resolved ?? overview.config)
      setSettingsOpen(true)
    } catch (error) {
      if (settingsLoadGeneration.current !== generation) return
      setSettingsConfig(overview.config)
      setSettingsOpen(true)
      onNotify(`解密 WebDAV 密钥失败：${error instanceof Error ? error.message : String(error)}，可重新输入后保存`, 'error')
    } finally {
      if (settingsLoadGeneration.current === generation) {
        setBusy((current) => current === 'config' ? null : current)
      }
    }
  }

  const closeSettings = (): void => {
    settingsLoadGeneration.current += 1
    setSettingsOpen(false)
    setSettingsConfig(undefined)
  }

  const syncNow = async (): Promise<void> => {
    if (!overview.configured) {
      await openSettings()
      return
    }
    setBusy('sync')
    try {
      const next = await window.djiApi.webdav.sync({ rendererStorage: rendererStorageSnapshot() })
      applyOverview(next)
      onNotify(`WebDAV 同步完成，当前版本 ${versionLabel(next.localVersion)}`, 'success')
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  const testConnection = async (): Promise<void> => {
    setBusy('test')
    try {
      const result = await window.djiApi.webdav.test()
      if (!result.ok) throw new Error(result.error ?? '连接测试失败')
      await refresh(false)
      onNotify('WebDAV 连接正常', 'success')
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  const toggleAutoSync = async (): Promise<void> => {
    if (!overview.config) return
    setBusy('config')
    try {
      const next = await window.djiApi.webdav.saveConfig({
        ...overview.config,
        autoSync: !overview.config.autoSync,
        updatedAt: Date.now(),
      })
      applyOverview(next)
      onNotify(next.config?.autoSync ? '已开启自动同步' : '已关闭自动同步', 'success')
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  const updateSyncStrategy = async (syncStrategy: WebDavSyncStrategy): Promise<void> => {
    if (!overview.config || overview.config.syncStrategy === syncStrategy) {
      setStrategyOpen(false)
      return
    }
    setBusy('config')
    setStrategyOpen(false)
    try {
      const next = await window.djiApi.webdav.saveConfig({
        ...overview.config,
        syncStrategy,
        updatedAt: Date.now(),
      })
      applyOverview(next)
      const selected = syncStrategyOptions.find((option) => option.value === syncStrategy)
      onNotify(`同步策略已更改为${selected?.label ?? syncStrategy}`, 'success')
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  const restoreVersion = async (version: WebDavVersion): Promise<void> => {
    if (!window.confirm(`确认恢复 WebDAV 数据版本 v${version.revision}？当前配置会被替换，应用将重新加载。`)) return
    setBusy(`restore:${version.id}`)
    try {
      const result = await window.djiApi.webdav.restore(version.id)
      if (!result.ok || !result.rendererStorage) throw new Error(result.error ?? '恢复失败')
      applyRendererStorageSnapshot(result.rendererStorage)
      window.location.reload()
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error), 'error')
      setBusy(null)
    }
  }

  const removeVersion = async (version: WebDavVersion): Promise<void> => {
    if (!window.confirm(`确认永久删除云端数据版本 v${version.revision}？此操作无法撤销。`)) return
    setBusy(`delete:${version.id}`)
    try {
      applyOverview(await window.djiApi.webdav.removeVersion(version.id))
      onNotify(`云端数据版本 v${version.revision} 已删除`, 'success')
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  const identity = overview.config?.authType === 'token'
    ? 'Bearer Token'
    : overview.config?.username || '未配置账号'
  const statusTitle = overview.configured
    ? overview.connected ? 'WebDAV 已就绪' : 'WebDAV 连接异常'
    : '尚未配置云同步'
  const statusDetail = overview.configured
    ? overview.connected ? '已连接 1 个云服务' : '配置已保存，等待服务恢复'
    : '添加 WebDAV 端点后开始加密同步'
  const currentStrategy = syncStrategyOptions.find(
    (option) => option.value === (overview.config?.syncStrategy ?? 'smart-merge'),
  ) ?? syncStrategyOptions[0]
  const CurrentStrategyIcon = currentStrategy.icon

  return (
    <div className="data-versions-page">
      <section className={`webdav-account-band ${overview.connected ? 'connected' : overview.configured ? 'unavailable' : ''}`}>
        <span className="webdav-account-icon">
          {overview.connected ? <ShieldCheck size={25} /> : overview.configured ? <CloudOff size={24} /> : <Cloud size={24} />}
        </span>
        <div className="webdav-account-copy">
          <strong>{statusTitle}<i /></strong>
          <small>{statusDetail}</small>
        </div>
        <button className="button secondary compact" disabled={Boolean(busy)} onClick={() => void openSettings()}>
          <Settings size={15} />{overview.configured ? '更改配置' : '配置 WebDAV'}
        </button>
      </section>

      <div className="segmented webdav-page-tabs" role="tablist" aria-label="WebDAV 页面">
        <button role="tab" aria-selected={activeTab === 'service'} className={activeTab === 'service' ? 'active' : ''} onClick={() => setActiveTab('service')}>
          云服务
        </button>
        <button role="tab" aria-selected={activeTab === 'status'} className={activeTab === 'status' ? 'active' : ''} onClick={() => setActiveTab('status')}>
          同步状态
        </button>
      </div>

      {overview.error && <div className="webdav-overview-error">{overview.error}</div>}

      {activeTab === 'service' ? (
        <div className="webdav-service-view">
          {overview.configured ? (
            <section className="webdav-provider-section">
              <header>
                <div><Server size={17} /><span>已连接的云服务</span></div>
                <span className={`webdav-provider-state ${overview.connected ? 'connected' : ''}`}>
                  {overview.connected ? '连接正常' : '暂不可用'}
                </span>
              </header>
              <div className="webdav-provider-main">
                <span className="webdav-provider-logo"><Cloud size={24} /></span>
                <div><strong>WebDAV</strong><small>{overview.config?.endpoint}</small></div>
                <div className="webdav-provider-actions">
                  <button className="button secondary compact" disabled={Boolean(busy)} onClick={() => void testConnection()}>
                    <RefreshCw size={14} className={busy === 'test' ? 'spin' : ''} />测试连接
                  </button>
                  <button className="button secondary compact" disabled={Boolean(busy)} onClick={() => void openSettings()}><Settings size={14} />编辑</button>
                </div>
              </div>
              <div className="webdav-provider-facts">
                <div><KeyRound size={15} /><span>认证方式</span><strong>{identity}</strong></div>
                <div><LockKeyhole size={15} /><span>数据加密</span><strong>AES-256-GCM</strong></div>
                <div><DatabaseBackup size={15} /><span>云端版本</span><strong>{overview.versions.length} 个</strong></div>
              </div>
            </section>
          ) : (
            <section className="webdav-service-empty">
              <Cloud size={30} />
              <strong>还没有云服务</strong>
              <span>配置 WebDAV 后，MQTT 连接与设备配置、流媒体和 OSS 配置将加密同步。</span>
              <button className="button primary" disabled={Boolean(busy)} onClick={() => void openSettings()}><Settings size={15} />配置 WebDAV</button>
            </section>
          )}
        </div>
      ) : (
        <div className="webdav-status-view">
          <section className="sync-capability-row">
            <span className="sync-capability-icon"><GitMerge size={19} /></span>
            <div>
              <strong>多设备安全同步 <em>已启用</em></strong>
              <small>条件锁串行提交，按记录三方合并，修改与删除冲突时优先保留数据。</small>
            </div>
            <CheckCircle2 className="sync-capability-check" size={20} />
          </section>

          <section className="sync-setting-row">
            <div><strong>自动同步</strong><small>本地变更后自动上传，并定期检查其他客户端的更新。</small></div>
            <button
              className={`webdav-switch ${overview.config?.autoSync ? 'enabled' : ''}`}
              role="switch"
              aria-checked={Boolean(overview.config?.autoSync)}
              aria-label="自动同步"
              disabled={!overview.configured || busy === 'config'}
              onClick={() => void toggleAutoSync()}
            >
              <span />
            </button>
          </section>

          <section className="sync-strategy-section">
            <div><strong>同步策略</strong><small>当本地和云端都发生变化时的处理方式。</small></div>
            <div className={`sync-strategy-control ${strategyOpen ? 'open' : ''}`} ref={strategyControlRef}>
              <button
                className="sync-strategy-trigger"
                type="button"
                aria-haspopup="listbox"
                aria-expanded={strategyOpen}
                disabled={!overview.configured || busy === 'config'}
                onClick={() => setStrategyOpen((current) => !current)}
              >
                <CurrentStrategyIcon size={16} />
                <span><strong>{currentStrategy.label}</strong><small>{currentStrategy.description}</small></span>
                <ChevronDown size={16} />
              </button>
              {strategyOpen && (
                <div className="sync-strategy-menu" role="listbox" aria-label="同步策略">
                  {syncStrategyOptions.map((option) => {
                    const selected = option.value === currentStrategy.value
                    const StrategyIcon = option.icon
                    return (
                      <button
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={selected ? 'selected' : ''}
                        key={option.value}
                        onClick={() => void updateSyncStrategy(option.value)}
                      >
                        <span className="sync-strategy-check">{selected && <Check size={15} />}</span>
                        <StrategyIcon className="sync-strategy-option-icon" size={16} />
                        <span><strong>{option.label}</strong><small>{option.description}</small></span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </section>

          <section className="version-summary-grid">
            <div className="version-summary-item">
              <span>本地版本</span><strong>{versionLabel(overview.localVersion)}</strong><time>{formatDate(overview.localVersion?.createdAt)}</time>
            </div>
            <div className="version-summary-item">
              <span>云端版本</span><strong>{versionLabel(overview.cloudVersion)}</strong><time>{formatDate(overview.cloudVersion?.createdAt)}</time>
            </div>
          </section>

          <div className="data-version-actions">
            <div><strong>同步历史</strong><span>{overview.versions.length} 个云端数据版本</span></div>
            <Tooltip label="刷新云端版本">
              <button className="icon-button" disabled={Boolean(busy) || !overview.configured} onClick={() => void refresh()}>
                <RefreshCw size={16} className={busy === 'refresh' ? 'spin' : ''} />
              </button>
            </Tooltip>
            <button className="button primary" disabled={Boolean(busy) || loading} onClick={() => void syncNow()}>
              <RefreshCw size={15} className={busy === 'sync' ? 'spin' : ''} />
              {busy === 'sync' ? '正在同步' : overview.configured ? '立即同步' : '配置 WebDAV'}
            </button>
          </div>

          <div className="data-version-layout">
            <section className="version-history-section">
              <header><DatabaseBackup size={16} /><span>云端版本</span></header>
              <div className="version-history-list">
                {overview.versions.map((version) => (
                  <article className="version-history-row" key={version.id}>
                    <span className="version-upload-icon"><ArrowUpFromLine size={15} /></span>
                    <div><strong>v{version.revision}</strong><small>{formatDate(version.createdAt)}</small></div>
                    <span className="version-size">{formatBytes(version.size)}</span>
                    <Tooltip label={`恢复 v${version.revision}`}>
                      <button className="icon-button small" disabled={Boolean(busy)} onClick={() => void restoreVersion(version)}>
                        <RotateCcw size={15} className={busy === `restore:${version.id}` ? 'spin' : ''} />
                      </button>
                    </Tooltip>
                    <Tooltip label={`删除 v${version.revision}`}>
                      <button className="icon-button small danger-icon-button" disabled={Boolean(busy)} onClick={() => void removeVersion(version)}><Trash2 size={15} /></button>
                    </Tooltip>
                  </article>
                ))}
                {!loading && !overview.versions.length && (
                  <div className="version-empty"><History size={26} /><strong>暂无云端版本</strong><span>同步后会在这里保留历史版本</span></div>
                )}
                {loading && <div className="version-empty"><RefreshCw className="spin" size={24} /><span>正在读取 WebDAV 版本</span></div>}
              </div>
            </section>

            <aside className="version-activity-section">
              <header><History size={16} /><span>最近活动</span></header>
              <div className="version-activity-list">
                {overview.activities.slice(0, 12).map((activity) => {
                  const meta = activityCopy[activity.type]
                  const ActivityIcon = meta.icon
                  return (
                    <div className={`version-activity-row ${activity.type}`} key={activity.id}>
                      <span><ActivityIcon size={14} /></span>
                      <div><strong>{meta.action} v{activity.revision}</strong><time>{formatDate(activity.at)}</time></div>
                    </div>
                  )
                })}
                {!overview.activities.length && <div className="activity-empty">尚无同步活动</div>}
              </div>
            </aside>
          </div>
        </div>
      )}

      {settingsOpen && (
        <WebDavSettingsModal
          key={settingsConfig?.updatedAt ?? 'new'}
          config={settingsConfig}
          onClose={closeSettings}
          onSave={async (config) => {
            const next = await window.djiApi.webdav.saveConfig(config)
            applyOverview(next)
            onNotify('WebDAV 配置已加密保存', 'success')
            return next
          }}
          onRemove={async () => {
            const result = await window.djiApi.webdav.removeConfig()
            if (result.ok) {
              applyOverview(emptyOverview)
              onNotify('WebDAV 配置已删除', 'success')
            }
            return result
          }}
          onTest={(config) => window.djiApi.webdav.test(config)}
        />
      )}
    </div>
  )
}
