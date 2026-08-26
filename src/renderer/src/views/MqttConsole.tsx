import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownLeft,
  ArrowUpRight,
  Braces,
  Check,
  Clipboard,
  Download,
  Eraser,
  Pause,
  Play,
  Search,
  Send,
  WrapText,
} from 'lucide-react'
import type {
  ConnectionProfile,
  ConnectionStatus,
  MqttMessageRecord,
  MqttQos,
  OperationResult,
} from '../../../shared/contracts'
import { Tooltip } from '../components/Tooltip'
import { prettyPayload } from '../lib/dji'

interface MqttConsoleProps {
  profile: ConnectionProfile
  status: ConnectionStatus
  busy: boolean
  records: MqttMessageRecord[]
  selectedDeviceSn: string
  onPublish: (topic: string, payload: string, qos: MqttQos, retain: boolean) => Promise<OperationResult>
  onExport: (records: MqttMessageRecord[]) => Promise<void>
  onClear: () => void
}

type DirectionFilter = 'all' | 'in' | 'out'

export function MqttConsole({
  profile,
  status,
  busy,
  records,
  selectedDeviceSn,
  onPublish,
  onExport,
  onClear,
}: MqttConsoleProps) {
  const [search, setSearch] = useState('')
  const [direction, setDirection] = useState<DirectionFilter>('all')
  const [paused, setPaused] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const [topic, setTopic] = useState(selectedDeviceSn ? `thing/product/${selectedDeviceSn}/services` : '')
  const [payload, setPayload] = useState('{\n  "data": {}\n}')
  const [qos, setQos] = useState<MqttQos>(1)
  const [retain, setRetain] = useState(false)
  const [sendState, setSendState] = useState('')
  const [sending, setSending] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const resetSn = profile.devices.some((device) => device.sn === selectedDeviceSn)
      ? selectedDeviceSn
      : profile.devices[0]?.sn ?? ''
    setTopic(resetSn ? `thing/product/${resetSn}/services` : '')
    setPayload('{\n  "data": {}\n}')
    setQos(1)
    setRetain(false)
    setSendState('')
    setSelectedId('')
  }, [profile.id])

  useEffect(() => {
    if (selectedDeviceSn && (!topic || /^thing\/product\/[^/]+\/services$/.test(topic))) {
      setTopic(`thing/product/${selectedDeviceSn}/services`)
    }
  }, [selectedDeviceSn])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    return records.filter((record) => {
      if (direction !== 'all' && record.direction !== direction) return false
      if (!term) return true
      return record.topic.toLowerCase().includes(term) || record.payload.toLowerCase().includes(term)
    })
  }, [records, direction, search])

  const selected = filtered.find((record) => record.id === selectedId) ?? filtered.at(-1)

  useEffect(() => {
    if (!paused && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [filtered.length, paused])

  const formatJson = (): void => {
    try {
      setPayload(JSON.stringify(JSON.parse(payload), null, 2))
      setSendState('JSON 已格式化')
    } catch {
      setSendState('Payload 不是有效 JSON')
    }
  }

  const send = async (): Promise<void> => {
    setSending(true)
    try {
      const result = await onPublish(topic, payload, qos, retain)
      setSendState(result.ok ? '已发布' : result.error ?? '发布失败')
    } catch (error) {
      setSendState(error instanceof Error ? error.message : String(error))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="mqtt-console">
      <div className="console-toolbar">
        <label className="search-box">
          <Search size={15} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="筛选 Topic 或 Payload" />
        </label>
        <div className="segmented compact-segmented">
          {(
            [
              ['all', '全部'],
              ['in', '接收'],
              ['out', '发送'],
            ] as [DirectionFilter, string][]
          ).map(([value, label]) => (
            <button key={value} className={direction === value ? 'active' : ''} onClick={() => setDirection(value)}>{label}</button>
          ))}
        </div>
        <span className="toolbar-spacer" />
        <Tooltip label={paused ? '恢复自动滚动' : '暂停自动滚动'}>
          <button className="icon-button" onClick={() => setPaused((value) => !value)}>
            {paused ? <Play size={16} /> : <Pause size={16} />}
          </button>
        </Tooltip>
        <Tooltip label="导出当前结果">
          <button className="icon-button" onClick={() => void onExport(filtered)}><Download size={16} /></button>
        </Tooltip>
        <Tooltip label="清空消息">
          <button className="icon-button" onClick={onClear}><Eraser size={16} /></button>
        </Tooltip>
      </div>

      <div className="console-content">
        <section className="message-stream" ref={listRef}>
          {filtered.map((record) => (
            <button
              className={`message-row ${record.direction} ${selected?.id === record.id ? 'selected' : ''}`}
              key={record.id}
              onClick={() => setSelectedId(record.id)}
            >
              <span className="direction-icon">
                {record.direction === 'in' ? <ArrowDownLeft size={15} /> : <ArrowUpRight size={15} />}
              </span>
              <span className="message-copy">
                <strong>{record.topic}</strong>
                <small>{record.payload.replace(/\s+/g, ' ').slice(0, 90)}</small>
              </span>
              <span className="message-side">
                <time>{new Date(record.timestamp).toLocaleTimeString()}</time>
                <small>Q{record.qos} · {record.size} B</small>
              </span>
            </button>
          ))}
          {!filtered.length && <div className="console-empty"><WrapText size={24} /><span>等待 MQTT 消息</span></div>}
        </section>

        <section className="message-inspector">
          <header className="inspector-header">
            <div>
              <span className="eyebrow">MESSAGE INSPECTOR</span>
              <h3>{selected?.topic ?? '未选择消息'}</h3>
            </div>
            {selected && (
              <Tooltip label="复制 Payload">
                <button className="icon-button" onClick={() => void navigator.clipboard.writeText(selected.payload)}><Clipboard size={16} /></button>
              </Tooltip>
            )}
          </header>
          {selected ? (
            <>
              <div className="message-metadata">
                <span>{selected.direction === 'in' ? '接收' : '发送'}</span>
                <span>QoS {selected.qos}</span>
                <span>{selected.retain ? 'Retained' : 'Not retained'}</span>
                <span>{new Date(selected.timestamp).toLocaleString()}</span>
              </div>
              <pre className="json-viewer">{prettyPayload(selected.payload)}</pre>
            </>
          ) : (
            <div className="console-empty"><Braces size={24} /><span>选择一条消息查看详情</span></div>
          )}
        </section>
      </div>

      <section className="publish-composer">
        <div className="composer-topline">
          <label className="topic-input">
            <span>Topic</span>
            <input value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="thing/product/{sn}/services" />
          </label>
          <div className="segmented qos-control">
            {([0, 1, 2] as MqttQos[]).map((value) => (
              <button className={qos === value ? 'active' : ''} key={value} onClick={() => setQos(value)}>QoS {value}</button>
            ))}
          </div>
          <label className="check-field retain-field">
            <input type="checkbox" checked={retain} onChange={(event) => setRetain(event.target.checked)} />
            <span>Retain</span>
          </label>
        </div>
        <div className="composer-editor">
          <textarea value={payload} onChange={(event) => setPayload(event.target.value)} spellCheck={false} />
          <div className="editor-actions">
            <Tooltip label="格式化 JSON">
              <button className="icon-button" onClick={formatJson}><Braces size={16} /></button>
            </Tooltip>
            <span className={`send-state ${sendState === '已发布' ? 'success' : ''}`}>
              {sendState === '已发布' && <Check size={13} />}{sendState}
            </span>
            <button className="button primary compact" disabled={status !== 'connected' || busy || sending} onClick={() => void send()}>
              <Send size={15} />{sending ? '发布中' : busy ? '同步中' : '发布'}
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
