import { useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, Download, ExternalLink, LoaderCircle, PackageOpen, RefreshCw } from 'lucide-react'
import packageMetadata from '../../../../package.json'
import type { AppUpdateState } from '../../../shared/contracts'

export function AppUpdatePanel() {
  const [updateState, setUpdateState] = useState<AppUpdateState>({
    status: 'idle',
    currentVersion: packageMetadata.version,
  })
  const [actionError, setActionError] = useState<string>()

  useEffect(() => {
    const unsubscribe = window.djiApi.updates.onStateChange(setUpdateState)
    void window.djiApi.updates.getState().then(setUpdateState)
    return unsubscribe
  }, [])

  const checkForUpdates = async (): Promise<void> => {
    setActionError(undefined)
    setUpdateState(await window.djiApi.updates.check())
  }

  const downloadUpdate = async (): Promise<void> => {
    setActionError(undefined)
    const result = await window.djiApi.updates.download()
    if (!result.ok) setActionError(result.error ?? '更新下载失败')
  }

  const openInstaller = async (): Promise<void> => {
    setActionError(undefined)
    const result = await window.djiApi.updates.openInstaller()
    if (!result.ok) setActionError(result.error ?? '无法打开安装包')
  }

  const statusCopy = updateState.status === 'checking'
    ? '正在检查 GitHub Releases…'
    : updateState.status === 'available'
      ? `发现新版本 v${updateState.availableVersion}`
      : updateState.status === 'not-available'
        ? '当前已是最新版本'
        : updateState.status === 'downloading'
          ? `正在下载并校验安装包${updateState.progress === undefined ? '' : ` · ${updateState.progress}%`}`
          : updateState.status === 'downloaded'
            ? '安装包已下载并通过 SHA-256 校验'
            : updateState.status === 'unsupported'
              ? updateState.error ?? '当前平台暂不支持在线更新'
              : updateState.status === 'error'
                ? updateState.error ?? '检查更新失败'
                : '可从 GitHub Releases 检查正式版本'

  const busy = updateState.status === 'checking' || updateState.status === 'downloading'

  return (
    <section className={`about-update ${updateState.status}`} aria-live="polite">
      <div className="about-update-heading">
        <span className="about-update-icon">
          {busy
            ? <LoaderCircle size={16} className="spin" />
            : updateState.status === 'downloaded' || updateState.status === 'not-available'
              ? <CheckCircle2 size={16} />
              : updateState.status === 'error' || updateState.status === 'unsupported'
                ? <AlertCircle size={16} />
                : <Download size={16} />}
        </span>
        <div>
          <strong>在线版本更新</strong>
          <span>{statusCopy}</span>
        </div>
      </div>

      {updateState.status === 'downloading' && (
        <div className="about-update-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={updateState.progress}>
          <span style={{ width: `${updateState.progress ?? 0}%` }} />
        </div>
      )}

      {updateState.status === 'available' && updateState.releaseNotes && (
        <p className="about-update-notes">{updateState.releaseNotes}</p>
      )}

      {(actionError || (updateState.status === 'error' && updateState.error)) && (
        <p className="about-update-error">{actionError ?? updateState.error}</p>
      )}

      <div className="about-update-actions">
        {updateState.releaseUrl && (
          <a href={updateState.releaseUrl} target="_blank" rel="noreferrer">
            查看发布说明<ExternalLink size={12} />
          </a>
        )}
        <span />
        {updateState.status === 'available' ? (
          <button className="button primary compact" onClick={() => void downloadUpdate()}>
            <Download size={14} />下载更新
          </button>
        ) : updateState.status === 'downloaded' ? (
          <button className="button primary compact" onClick={() => void openInstaller()}>
            <PackageOpen size={14} />打开安装包
          </button>
        ) : updateState.status !== 'unsupported' ? (
          <button className="button secondary compact" disabled={busy} onClick={() => void checkForUpdates()}>
            {updateState.status === 'checking' ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
            {updateState.status === 'error' ? '重新检查' : '检查更新'}
          </button>
        ) : null}
      </div>
    </section>
  )
}
