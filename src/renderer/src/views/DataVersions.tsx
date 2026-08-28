import { useCallback, useEffect, useState } from 'react'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Cloud,
  CloudOff,
  DatabaseBackup,
  History,
  RefreshCw,
  RotateCcw,
  Settings,
  Trash2,
} from 'lucide-react'
import type { WebDavActivity, WebDavOverview, WebDavVersion } from '../../../shared/contracts'
import { Tooltip } from '../components/Tooltip'
import { WebDavSettingsModal } from '../components/WebDavSettingsModal'
import { applyRendererStorageSnapshot, rendererStorageSnapshot } from '../lib/webdav-sync'

interface DataVersionsProps {
  onNotify: (text: string, tone?: 'info' | 'success' | 'error') => void
  onOverviewChange?: (overview: WebDavOverview) => void
}

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
  upload: { action: '已上传', icon: ArrowUpFromLine },
  restore: { action: '已恢复', icon: ArrowDownToLine },
  delete: { action: '已删除', icon: Trash2 },
}

export function DataVersions({ onNotify, onOverviewChange }: DataVersionsProps) {
  const [overview, setOverview] = useState<WebDavOverview>(emptyOverview)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'sync' | 'refresh' | `restore:${string}` | `delete:${string}` | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

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

  const syncNow = async (): Promise<void> => {
    if (!overview.configured) {
      setSettingsOpen(true)
      return
    }
    setBusy('sync')
    try {
      const next = await window.djiApi.webdav.sync({ rendererStorage: rendererStorageSnapshot() })
      applyOverview(next)
      onNotify(`WebDAV 数据版本 v${next.localVersion?.revision ?? ''} 已上传`, 'success')
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
    ? 'Token 认证'
    : overview.config?.username || '未配置账号'

  return (
    <div className="data-versions-page">
      <section className={`webdav-account-band ${overview.connected ? 'connected' : ''}`}>
        <span className="webdav-account-icon">{overview.connected ? <Cloud size={24} /> : <CloudOff size={24} />}</span>
        <div>
          <span className="webdav-state-label">{overview.configured ? overview.connected ? '云同步已启用' : 'WebDAV 暂不可用' : '尚未配置云同步'}</span>
          <strong>WebDAV <i /></strong>
          <small>{overview.configured ? `${identity} · ${overview.config?.endpoint}` : '添加 WebDAV 端点后开始创建加密数据版本'}</small>
        </div>
        <Tooltip label="WebDAV 设置">
          <button className="icon-button" onClick={() => setSettingsOpen(true)}><Settings size={18} /></button>
        </Tooltip>
      </section>

      {overview.error && <div className="webdav-overview-error">{overview.error}</div>}

      <section className="version-summary-grid">
        <div className="version-summary-item">
          <span>本地</span><strong>{versionLabel(overview.localVersion)}</strong><time>{formatDate(overview.localVersion?.createdAt)}</time>
        </div>
        <div className="version-summary-item">
          <span>云端</span><strong>{versionLabel(overview.cloudVersion)}</strong><time>{formatDate(overview.cloudVersion?.createdAt)}</time>
        </div>
      </section>

      <div className="data-version-actions">
        <div>
          <strong>数据版本</strong>
          <span>{overview.versions.length} 个云端历史版本</span>
        </div>
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
                  <button className="icon-button small danger-icon-button" disabled={Boolean(busy)} onClick={() => void removeVersion(version)}>
                    <Trash2 size={15} />
                  </button>
                </Tooltip>
              </article>
            ))}
            {!loading && !overview.versions.length && (
              <div className="version-empty"><History size={26} /><strong>暂无云端版本</strong><span>立即同步后会在这里保留历史版本</span></div>
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

      {settingsOpen && (
        <WebDavSettingsModal
          config={overview.config}
          onClose={() => setSettingsOpen(false)}
          onSave={async (config) => {
            const next = await window.djiApi.webdav.saveConfig(config)
            applyOverview(next)
            onNotify('WebDAV 配置已安全保存', 'success')
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
