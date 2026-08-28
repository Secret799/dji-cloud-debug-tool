import { useState } from 'react'
import { Cloud, Eye, EyeOff, FlaskConical, Save, Trash2, X } from 'lucide-react'
import type { OperationResult, WebDavAuthType, WebDavConfig, WebDavOverview } from '../../../shared/contracts'
import { Tooltip } from './Tooltip'

interface WebDavSettingsModalProps {
  config?: WebDavConfig
  onClose: () => void
  onSave: (config: WebDavConfig) => Promise<WebDavOverview>
  onRemove: () => Promise<OperationResult>
  onTest: (config: WebDavConfig) => Promise<OperationResult>
}

const createConfig = (): WebDavConfig => ({
  endpoint: '',
  authType: 'basic',
  username: '',
  secret: '',
  rejectUnauthorized: true,
  updatedAt: Date.now(),
})

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

export function WebDavSettingsModal({ config, onClose, onSave, onRemove, onTest }: WebDavSettingsModalProps) {
  const [draft, setDraft] = useState<WebDavConfig>(() => config ? { ...config } : createConfig())
  const [showSecret, setShowSecret] = useState(false)
  const [busy, setBusy] = useState<'save' | 'test' | 'remove' | null>(null)
  const [error, setError] = useState('')
  const [testPassed, setTestPassed] = useState(false)

  const update = <K extends keyof WebDavConfig>(key: K, value: WebDavConfig[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }))
    setError('')
    setTestPassed(false)
  }

  const issues = (): string[] => {
    const next: string[] = []
    try {
      const endpoint = new URL(draft.endpoint)
      if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') next.push('端点地址仅支持 HTTP 或 HTTPS')
    } catch {
      next.push('端点地址无效')
    }
    if (draft.authType !== 'token' && !draft.username.trim()) next.push('请输入用户名')
    if (!draft.secret && (!draft.hasStoredSecret || draft.clearStoredSecret)) {
      next.push(draft.authType === 'token' ? '请输入 Token' : '请输入密码')
    }
    return next
  }

  const handleTest = async (): Promise<void> => {
    const validation = issues()
    if (validation.length) {
      setError(validation[0])
      return
    }
    setBusy('test')
    setError('')
    try {
      const result = await onTest(draft)
      if (!result.ok) throw new Error(result.error ?? '连接测试失败')
      setTestPassed(true)
    } catch (testError) {
      setError(errorMessage(testError))
    } finally {
      setBusy(null)
    }
  }

  const handleSave = async (): Promise<void> => {
    const validation = issues()
    if (validation.length) {
      setError(validation[0])
      return
    }
    setBusy('save')
    setError('')
    try {
      await onSave({ ...draft, updatedAt: Date.now() })
      onClose()
    } catch (saveError) {
      setError(errorMessage(saveError))
    } finally {
      setBusy(null)
    }
  }

  const handleRemove = async (): Promise<void> => {
    if (!config || !window.confirm('确认关闭 WebDAV 云同步并删除本机保存的端点配置？云端历史版本不会被删除。')) return
    setBusy('remove')
    setError('')
    try {
      const result = await onRemove()
      if (!result.ok) throw new Error(result.error ?? '删除配置失败')
      onClose()
    } catch (removeError) {
      setError(errorMessage(removeError))
    } finally {
      setBusy(null)
    }
  }

  const secretLabel = draft.authType === 'token' ? 'Token' : '密码'

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <section className="modal webdav-settings-modal" role="dialog" aria-modal="true" aria-labelledby="webdav-settings-title">
        <header className="modal-header">
          <div>
            <h2 id="webdav-settings-title">WebDAV 设置</h2>
            <p>配置 WebDAV 端点用于加密数据版本同步。</p>
          </div>
          <Tooltip label="关闭">
            <button className="icon-button" type="button" disabled={Boolean(busy)} onClick={onClose}><X size={18} /></button>
          </Tooltip>
        </header>

        <div className="modal-body">
          <form className="settings-form" autoComplete="off" onSubmit={(event) => { event.preventDefault(); void handleSave() }}>
            <label className="field">
              <span>端点地址</span>
              <input
                value={draft.endpoint}
                onChange={(event) => update('endpoint', event.target.value)}
                placeholder="https://webdav.example.com/dav/"
                autoFocus
              />
            </label>
            <label className="field">
              <span>认证方式</span>
              <select value={draft.authType} onChange={(event) => update('authType', event.target.value as WebDavAuthType)}>
                <option value="basic">Basic</option>
                <option value="digest">Digest</option>
                <option value="token">Token</option>
              </select>
            </label>
            {draft.authType !== 'token' && (
              <label className="field">
                <span>用户名</span>
                <input value={draft.username} onChange={(event) => update('username', event.target.value)} autoComplete="off" />
              </label>
            )}
            <div className="field">
              <span id="webdav-secret-label">{secretLabel}</span>
              <div className="webdav-secret-input">
                <input
                  aria-labelledby="webdav-secret-label"
                  type={showSecret ? 'text' : 'password'}
                  value={draft.secret}
                  onChange={(event) => update('secret', event.target.value)}
                  placeholder={draft.hasStoredSecret ? `已安全保存，留空则保留原${secretLabel}` : `请输入${secretLabel}`}
                  autoComplete="new-password"
                />
                <Tooltip label={showSecret ? `隐藏${secretLabel}` : `显示${secretLabel}`}>
                  <button type="button" className="icon-button" onClick={() => setShowSecret((current) => !current)}>
                    {showSecret ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </Tooltip>
              </div>
            </div>
            {draft.hasStoredSecret && (
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={Boolean(draft.clearStoredSecret)}
                  onChange={(event) => update('clearStoredSecret', event.target.checked)}
                />
                <span>清除已保存的{secretLabel}</span>
              </label>
            )}
            <label className="check-field webdav-insecure-field">
              <input
                type="checkbox"
                checked={!draft.rejectUnauthorized}
                onChange={(event) => update('rejectUnauthorized', !event.target.checked)}
              />
              <span>允许不安全的连接（忽略证书错误）</span>
            </label>
            {testPassed && <div className="webdav-test-result">连接成功，备份目录可以使用</div>}
            {error && <div className="form-error" role="alert">{error}</div>}
          </form>
        </div>

        <footer className="modal-footer webdav-settings-footer">
          <div>
            {config && (
              <button className="button danger-ghost" type="button" disabled={Boolean(busy)} onClick={() => void handleRemove()}>
                <Trash2 size={14} />{busy === 'remove' ? '删除中' : '删除配置'}
              </button>
            )}
          </div>
          <div className="footer-actions">
            <button className="button secondary" type="button" disabled={Boolean(busy)} onClick={() => void handleTest()}>
              <FlaskConical size={14} />{busy === 'test' ? '测试中' : '测试连接'}
            </button>
            <button className="button" type="button" disabled={Boolean(busy)} onClick={onClose}>取消</button>
            <button className="button primary" type="button" disabled={Boolean(busy)} onClick={() => void handleSave()}>
              {busy === 'save' ? <Cloud size={15} /> : <Save size={15} />}{busy === 'save' ? '保存中' : '保存'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}
