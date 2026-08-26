import { useEffect, useState } from 'react'
import { Check, ChevronDown, FileKey2, ShieldCheck, Trash2, X } from 'lucide-react'
import type { ConnectionProfile, MqttProtocol } from '../../../shared/contracts'
import { Tooltip } from './Tooltip'

interface ConnectionModalProps {
  profile: ConnectionProfile | null
  isNew: boolean
  onClose: () => void
  onSave: (profile: ConnectionProfile) => Promise<void>
  onRemove: (profileId: string) => Promise<void>
}

const defaultPorts: Record<MqttProtocol, number> = {
  mqtt: 1883,
  mqtts: 8883,
  ws: 8083,
  wss: 8084,
}

export function ConnectionModal({ profile, isNew, onClose, onSave, onRemove }: ConnectionModalProps) {
  const [draft, setDraft] = useState<ConnectionProfile | null>(profile)
  const [advanced, setAdvanced] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setDraft(profile)
    setError('')
  }, [profile])

  if (!draft) return null

  const update = <K extends keyof ConnectionProfile>(key: K, value: ConnectionProfile[K]): void => {
    setDraft((current) => (current ? { ...current, [key]: value } : current))
  }

  const setProtocol = (protocol: MqttProtocol): void => {
    setDraft((current) =>
      current
        ? {
            ...current,
            protocol,
            port: current.port === defaultPorts[current.protocol] ? defaultPorts[protocol] : current.port,
          }
        : current,
    )
  }

  const pickFile = async (key: 'caPath' | 'certPath' | 'keyPath'): Promise<void> => {
    const path = await window.djiApi.dialogs.pickCertificate()
    if (path) update(key, path)
  }

  const submit = async (): Promise<void> => {
    if (!draft.name.trim() || !draft.host.trim() || !draft.clientId.trim()) {
      setError('连接名称、Broker 地址和 Client ID 不能为空')
      return
    }
    if (draft.port < 1 || draft.port > 65535) {
      setError('端口必须在 1 到 65535 之间')
      return
    }

    setSaving(true)
    setError('')
    try {
      await onSave(draft)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal connection-modal" role="dialog" aria-modal="true" aria-label="连接设置">
        <header className="modal-header">
          <div>
            <span className="eyebrow">MQTT CONNECTION</span>
            <h2>{isNew ? '新建连接' : '连接设置'}</h2>
          </div>
          <Tooltip label="关闭">
            <button className="icon-button" onClick={onClose}><X size={18} /></button>
          </Tooltip>
        </header>

        <div className="modal-body settings-form">
          <div className="field-grid two-columns">
            <label className="field">
              <span>连接名称</span>
              <input value={draft.name} onChange={(event) => update('name', event.target.value)} autoFocus />
            </label>
            <label className="field">
              <span>Client ID</span>
              <input value={draft.clientId} onChange={(event) => update('clientId', event.target.value)} />
            </label>
          </div>

          <div className="field">
            <span>传输协议</span>
            <div className="segmented protocol-segmented">
              {(['mqtt', 'mqtts', 'ws', 'wss'] as MqttProtocol[]).map((protocol) => (
                <button
                  key={protocol}
                  type="button"
                  className={draft.protocol === protocol ? 'active' : ''}
                  onClick={() => setProtocol(protocol)}
                >
                  {protocol.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div className="field-grid broker-grid">
            <label className="field host-field">
              <span>Broker 地址</span>
              <input
                value={draft.host}
                onChange={(event) => update('host', event.target.value)}
                placeholder="broker.example.com"
              />
            </label>
            <label className="field">
              <span>端口</span>
              <input
                type="number"
                min={1}
                max={65535}
                value={draft.port}
                onChange={(event) => update('port', Number(event.target.value))}
              />
            </label>
            {(draft.protocol === 'ws' || draft.protocol === 'wss') && (
              <label className="field path-field">
                <span>Path</span>
                <input value={draft.path} onChange={(event) => update('path', event.target.value)} placeholder="/mqtt" />
              </label>
            )}
          </div>

          <div className="field-grid two-columns">
            <label className="field">
              <span>用户名</span>
              <input value={draft.username} onChange={(event) => update('username', event.target.value)} autoComplete="off" />
            </label>
            <label className="field">
              <span>密码</span>
              <input
                type="password"
                value={draft.password}
                onChange={(event) => {
                  const password = event.target.value
                  setDraft((current) => current ? { ...current, password, clearStoredPassword: password ? false : current.clearStoredPassword } : current)
                }}
                placeholder={draft.clearStoredPassword ? '已选择清除，输入新密码可替换' : draft.hasStoredPassword ? '已安全保存，留空则保留' : '可选'}
                autoComplete="new-password"
              />
            </label>
          </div>

          {draft.hasStoredPassword && (
            <label className="check-field clear-password-field">
              <input
                type="checkbox"
                checked={Boolean(draft.clearStoredPassword)}
                onChange={(event) => {
                  const clearStoredPassword = event.target.checked
                  setDraft((current) => current ? { ...current, clearStoredPassword, password: clearStoredPassword ? '' : current.password } : current)
                }}
              />
              <span>清除已保存密码</span>
            </label>
          )}

          <button type="button" className="advanced-toggle" onClick={() => setAdvanced((value) => !value)}>
            <ChevronDown size={16} className={advanced ? 'rotated' : ''} />
            高级设置
          </button>

          {advanced && (
            <div className="advanced-panel">
              <div className="field-grid three-columns">
                <label className="field">
                  <span>MQTT 版本</span>
                  <select
                    value={draft.mqttVersion}
                    onChange={(event) => update('mqttVersion', event.target.value as ConnectionProfile['mqttVersion'])}
                  >
                    <option value="3.1.1">3.1.1</option>
                    <option value="5.0">5.0</option>
                  </select>
                </label>
                <label className="field">
                  <span>Keep Alive (秒)</span>
                  <input
                    type="number"
                    min={0}
                    value={draft.keepalive}
                    onChange={(event) => update('keepalive', Number(event.target.value))}
                  />
                </label>
                <label className="field">
                  <span>连接超时 (秒)</span>
                  <input
                    type="number"
                    min={1}
                    value={draft.connectTimeout}
                    onChange={(event) => update('connectTimeout', Number(event.target.value))}
                  />
                </label>
              </div>
              <div className="field-grid two-columns option-row">
                <label className="check-field">
                  <input type="checkbox" checked={draft.clean} onChange={(event) => update('clean', event.target.checked)} />
                  <span>Clean Session</span>
                </label>
                <label className="check-field">
                  <input
                    type="checkbox"
                    checked={draft.rejectUnauthorized}
                    onChange={(event) => update('rejectUnauthorized', event.target.checked)}
                  />
                  <ShieldCheck size={15} />
                  <span>校验服务器证书</span>
                </label>
              </div>
              <label className="field reconnect-field">
                <span>重连间隔 (秒)</span>
                <input
                  type="number"
                  min={0}
                  max={60}
                  value={draft.reconnectPeriod}
                  onChange={(event) => update('reconnectPeriod', Number(event.target.value))}
                />
              </label>

              {(draft.protocol === 'mqtts' || draft.protocol === 'wss') && (
                <div className="certificate-list">
                  {(
                    [
                      ['caPath', 'CA 证书'],
                      ['certPath', '客户端证书'],
                      ['keyPath', '客户端私钥'],
                    ] as const
                  ).map(([key, label]) => (
                    <label className="field certificate-field" key={key}>
                      <span>{label}</span>
                      <div className={`input-action ${draft[key] ? 'has-clear' : ''}`}>
                        <input value={draft[key]} readOnly placeholder="未选择" />
                        <Tooltip label={`选择${label}`}>
                          <button type="button" className="icon-button" onClick={() => void pickFile(key)}><FileKey2 size={17} /></button>
                        </Tooltip>
                        {draft[key] && (
                          <Tooltip label={`清除${label}`}>
                            <button type="button" className="icon-button" onClick={() => update(key, '')}><X size={16} /></button>
                          </Tooltip>
                        )}
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {error && <div className="form-error">{error}</div>}
        </div>

        <footer className="modal-footer">
          {!isNew ? (
            <button className="button danger-ghost" onClick={() => void onRemove(draft.id)}>
              <Trash2 size={16} />
              删除
            </button>
          ) : (
            <span />
          )}
          <div className="footer-actions">
            <button className="button secondary" onClick={onClose}>取消</button>
            <button className="button primary" disabled={saving} onClick={() => void submit()}>
              <Check size={16} />
              {saving ? '保存中' : '保存连接'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}
