import { useEffect, useState } from 'react'
import { Check, Trash2, X } from 'lucide-react'
import type { DeviceProvider, DeviceType, DjiDevice, DockModel } from '../../../shared/contracts'
import { SUPERDOCK_MODELS, defaultDockModel, deviceProvider } from '../lib/superdock'
import { Tooltip } from './Tooltip'

interface DeviceModalProps {
  device: DjiDevice | null
  isNew: boolean
  gatewayDevices: DjiDevice[]
  onClose: () => void
  onSave: (device: DjiDevice) => Promise<void>
  onRemove: (deviceId: string) => Promise<void>
}

export function DeviceModal({ device, isNew, gatewayDevices, onClose, onSave, onRemove }: DeviceModalProps) {
  const [draft, setDraft] = useState(device)
  const [error, setError] = useState('')

  useEffect(() => {
    setDraft(device)
    setError('')
  }, [device])

  if (!draft) return null

  const update = <K extends keyof DjiDevice>(key: K, value: DjiDevice[K]): void => {
    setDraft((current) => (current ? { ...current, [key]: value } : current))
  }

  const setType = (type: DeviceType): void => {
    setDraft((current) => (current ? {
      ...current,
      type,
      provider: type === 'dock' ? deviceProvider(current) : 'dji',
      dockModel: type === 'dock' ? current.dockModel ?? defaultDockModel(deviceProvider(current)) : undefined,
      parentSn: type === 'aircraft' ? current.parentSn : undefined,
    } : current))
  }

  const setProvider = (provider: DeviceProvider): void => {
    setDraft((current) => current ? {
      ...current,
      provider,
      dockModel: defaultDockModel(provider),
    } : current)
  }

  const submit = async (): Promise<void> => {
    if (!draft.name.trim() || !draft.sn.trim()) {
      setError('设备名称和序列号不能为空')
      return
    }
    setError('')
    await onSave({
      ...draft,
      name: draft.name.trim(),
      sn: draft.sn.trim(),
      provider: draft.type === 'dock' ? deviceProvider(draft) : 'dji',
      dockModel: draft.type === 'dock' ? draft.dockModel ?? defaultDockModel(deviceProvider(draft)) : undefined,
    })
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal device-modal" role="dialog" aria-modal="true" aria-label="设备设置">
        <header className="modal-header">
          <div>
            <span className="eyebrow">CLOUD API DEVICE</span>
            <h2>{isNew ? '添加设备' : '设备设置'}</h2>
          </div>
          <Tooltip label="关闭">
            <button className="icon-button" onClick={onClose}><X size={18} /></button>
          </Tooltip>
        </header>
        <div className="modal-body settings-form">
          <label className="field">
            <span>设备类型</span>
            <div className="segmented">
              {(
                [
                  ['dock', '机场'],
                  ['aircraft', '飞机'],
                  ['pilot', 'Pilot'],
                ] as [DeviceType, string][]
              ).map(([type, label]) => (
                <button
                  type="button"
                  key={type}
                  className={draft.type === type ? 'active' : ''}
                  onClick={() => setType(type)}
                >
                  {label}
                </button>
              ))}
            </div>
          </label>
          {draft.type === 'dock' && (
            <>
              <label className="field">
                <span>机场厂商</span>
                <div className="segmented">
                  {([
                    ['dji', 'DJI'],
                    ['superdock', '草莓机场'],
                  ] as [DeviceProvider, string][]).map(([provider, label]) => (
                    <button
                      type="button"
                      key={provider}
                      className={deviceProvider(draft) === provider ? 'active' : ''}
                      onClick={() => setProvider(provider)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </label>
              <label className="field">
                <span>机场型号</span>
                <select
                  value={draft.dockModel ?? defaultDockModel(deviceProvider(draft))}
                  onChange={(event) => update('dockModel', event.target.value as DockModel)}
                >
                  {deviceProvider(draft) === 'superdock' ? (
                    <>
                      {SUPERDOCK_MODELS.map((model) => (
                        <option key={model.key} value={model.key}>{model.label}</option>
                      ))}
                      <option value="other">SuperDock 其他型号</option>
                    </>
                  ) : (
                    <>
                      <option value="dock2">DJI Dock 2</option>
                      <option value="dock3">DJI Dock 3</option>
                      <option value="other">DJI 其他机场型号</option>
                    </>
                  )}
                </select>
              </label>
            </>
          )}
          <label className="field">
            <span>设备名称</span>
            <input value={draft.name} onChange={(event) => update('name', event.target.value)} autoFocus />
          </label>
          <label className="field">
            <span>设备 SN</span>
            <input value={draft.sn} onChange={(event) => update('sn', event.target.value)} placeholder="例如 7CTXM..." />
          </label>
          <label className="check-field device-enabled-field">
            <input
              type="checkbox"
              checked={draft.enabled !== false}
              onChange={(event) => update('enabled', event.target.checked)}
            />
            <span>启用设备</span>
          </label>
          {draft.type === 'aircraft' && (
            <label className="field">
              <span>所属网关</span>
              <select value={draft.parentSn ?? ''} onChange={(event) => update('parentSn', event.target.value || undefined)}>
                <option value="">不指定</option>
                {gatewayDevices.map((gateway) => (
                  <option key={gateway.id} value={gateway.sn}>{gateway.name} · {gateway.sn}</option>
                ))}
              </select>
            </label>
          )}
          {error && <div className="form-error">{error}</div>}
        </div>
        <footer className="modal-footer">
          {!isNew ? (
            <button className="button danger-ghost" onClick={() => void onRemove(draft.id)}>
              <Trash2 size={16} />删除
            </button>
          ) : <span />}
          <div className="footer-actions">
            <button className="button secondary" onClick={onClose}>取消</button>
            <button className="button primary" onClick={() => void submit()}><Check size={16} />保存设备</button>
          </div>
        </footer>
      </section>
    </div>
  )
}
