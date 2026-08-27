import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, CircleAlert, LoaderCircle, Send, X } from 'lucide-react'
import type { MqttMessageRecord, MqttQos, OperationResult } from '../../../shared/contracts'
import type { DjiFieldMetadata } from '../lib/dji-field-metadata'
import {
  buildDjiPropertyPayload,
  djiNumericConstraint,
  djiPropertyDraftValue,
  djiPropertyReplyResult,
  parseDjiPropertyValue,
} from '../lib/dji-property-set'
import { formatServiceError } from '../lib/dji-error-codes'
import { Tooltip } from './Tooltip'

export interface PropertySetTarget {
  path: string
  label: string
  value: unknown
  metadata: DjiFieldMetadata
  sourceLabel: string
}

interface PropertySetModalProps {
  target: PropertySetTarget
  gatewaySn: string
  records: MqttMessageRecord[]
  onClose: () => void
  onPublish: (topic: string, payload: string, qos: MqttQos, retain: boolean) => Promise<OperationResult>
}

interface PendingPropertySet {
  tid: string
  bid: string
}

export function PropertySetModal({ target, gatewaySn, records, onClose, onPublish }: PropertySetModalProps) {
  const [draft, setDraft] = useState(() => djiPropertyDraftValue(target.value, target.metadata))
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [pending, setPending] = useState<PendingPropertySet>()
  const enumEntries = Object.entries(target.metadata.enumValues ?? {})
  const numericConstraint = djiNumericConstraint(target.metadata)

  useEffect(() => {
    setDraft(djiPropertyDraftValue(target.value, target.metadata))
    setError('')
    setSending(false)
    setPending(undefined)
  }, [target])

  useEffect(() => {
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !sending) onClose()
    }
    window.addEventListener('keydown', dismiss)
    return () => window.removeEventListener('keydown', dismiss)
  }, [onClose, sending])

  const replyResult = useMemo(() => {
    if (!pending) return undefined
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index]
      if (record.direction !== 'in' || !record.topic.endsWith('/property/set_reply')) continue
      try {
        const envelope = JSON.parse(record.payload) as { tid?: string; bid?: string }
        if (envelope.tid !== pending.tid || (envelope.bid && envelope.bid !== pending.bid)) continue
        return djiPropertyReplyResult(record.payload, target.path)
      } catch {
        // Ignore unrelated raw MQTT messages.
      }
    }
    return undefined
  }, [pending, records, target.path])

  const submit = async (): Promise<void> => {
    setError('')
    let value: unknown
    try {
      value = parseDjiPropertyValue(draft, target.metadata)
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : String(parseError))
      return
    }

    const tid = crypto.randomUUID()
    const bid = crypto.randomUUID()
    let payload: string
    try {
      payload = buildDjiPropertyPayload(target.path, value, tid, bid)
    } catch (payloadError) {
      setError(payloadError instanceof Error ? payloadError.message : String(payloadError))
      return
    }

    setSending(true)
    try {
      const result = await onPublish(`thing/product/${gatewaySn}/property/set`, payload, 1, false)
      if (!result.ok) {
        setError(result.error ?? '属性设置发送失败')
        return
      }
      setPending({ tid, bid })
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : String(publishError))
    } finally {
      setSending(false)
    }
  }

  const renderControl = () => {
    if (target.metadata.type === 'bool') {
      const enabled = draft === 'true'
      return (
        <label className="property-switch-control">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setDraft(String(event.target.checked))}
          />
          <span className="property-switch-track"><span /></span>
          <strong>{enabled ? target.metadata.enumValues?.true ?? '开启' : target.metadata.enumValues?.false ?? '关闭'}</strong>
        </label>
      )
    }

    if (enumEntries.length) {
      return (
        <select value={draft} onChange={(event) => setDraft(event.target.value)} autoFocus>
          {enumEntries.map(([value, label]) => <option key={value} value={value}>{label} ({value})</option>)}
        </select>
      )
    }

    if (['int', 'date', 'float', 'double'].includes(target.metadata.type)) {
      return (
        <input
          type="number"
          value={draft}
          min={numericConstraint.min}
          max={numericConstraint.max}
          step={numericConstraint.step ?? (['int', 'date'].includes(target.metadata.type) ? 1 : 'any')}
          onChange={(event) => setDraft(event.target.value)}
          autoFocus
        />
      )
    }

    if (target.metadata.type === 'struct' || target.metadata.type === 'array') {
      return <textarea value={draft} rows={7} onChange={(event) => setDraft(event.target.value)} autoFocus />
    }

    return <input value={draft} onChange={(event) => setDraft(event.target.value)} autoFocus />
  }

  const resultCopy = replyResult === 0
    ? '设备已确认设置成功'
    : replyResult !== undefined
      ? formatServiceError(replyResult)
      : pending
        ? '已发送，等待 property/set_reply'
        : undefined

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !sending && onClose()}>
      <section className="modal property-set-modal" role="dialog" aria-modal="true" aria-label={`设置${target.label}`}>
        <header className="modal-header">
          <div>
            <span className="eyebrow">PROPERTY SET</span>
            <h2>设置{target.label}</h2>
          </div>
          <Tooltip label="关闭">
            <button className="icon-button" onClick={onClose} disabled={sending}><X size={18} /></button>
          </Tooltip>
        </header>
        <div className="modal-body settings-form">
          <div className="property-set-meta">
            <span><small>原始字段</small><code>{target.path}</code></span>
            <span><small>下发网关</small><code>{gatewaySn}</code></span>
            <span><small>数据类型</small><code>{target.metadata.type}</code></span>
          </div>
          <label className="field property-set-field">
            <span>设置值{target.metadata.unit ? `（${target.metadata.unit}）` : ''}</span>
            {renderControl()}
          </label>
          {target.metadata.constraint && (
            <div className="property-set-constraint"><span>字段约束</span><code>{target.metadata.constraint}</code></div>
          )}
          <div className="property-set-topic">
            <span>Topic</span>
            <code>thing/product/{gatewaySn}/property/set</code>
          </div>
          {error && <div className="form-error"><CircleAlert size={15} />{error}</div>}
          {resultCopy && (
            <div className={`property-set-result ${replyResult === 0 ? 'success' : replyResult !== undefined ? 'error' : 'pending'}`}>
              {replyResult === 0 ? <CheckCircle2 size={15} /> : replyResult !== undefined ? <CircleAlert size={15} /> : <LoaderCircle size={15} />}
              {resultCopy}
            </div>
          )}
        </div>
        <footer className="modal-footer property-set-footer">
          <small>来源：{target.sourceLabel}</small>
          <div className="footer-actions">
            <button className="button secondary" onClick={onClose} disabled={sending}>关闭</button>
            <button className="button primary" onClick={() => void submit()} disabled={sending}>
              {sending ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}
              {sending ? '正在发送' : pending ? '再次设置' : '发送设置'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}
