import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownLeft,
  ArrowUpRight,
  Braces,
  Check,
  Clipboard,
  Download,
  Eraser,
  Filter,
  MessageSquareText,
  Pause,
  Play,
  Search,
  Send,
  SquareArrowOutUpRight,
  WrapText,
} from 'lucide-react'
import type {
  ConnectionProfile,
  ConnectionStatus,
  MqttMessageRecord,
  MqttQos,
  OperationResult,
} from '../../../shared/contracts'
import type { CommandTransaction } from '../lib/dji'
import { prettyPayload } from '../lib/dji'
import { lookupServiceError } from '../lib/dji-error-codes'
import { Tooltip } from '../components/Tooltip'

export type TraceFocus = { view: 'tx'; tid?: string; bid?: string }
export type TraceTopicCategory = 'osd' | 'state' | 'services' | 'events' | 'property' | 'other'
type TraceView = 'stream' | 'transactions'
type TraceScope = 'device' | 'all'

const traceCategories: Array<{ id: Exclude<TraceTopicCategory, 'other'>; label: string }> = [
  { id: 'osd', label: 'osd' },
  { id: 'state', label: 'state' },
  { id: 'services', label: 'services' },
  { id: 'events', label: 'events' },
  { id: 'property', label: 'property' },
]

const allTraceCategories = new Set<TraceTopicCategory>(traceCategories.map((category) => category.id))

export const traceRecordCategory = (record: MqttMessageRecord): TraceTopicCategory => {
  if (record.topic.endsWith('/osd')) return 'osd'
  if (record.topic.endsWith('/state')) return 'state'
  if (record.topic.includes('/services')) return 'services'
  if (record.topic.endsWith('/events') || record.topic.endsWith('/events_reply')) return 'events'
  if (record.topic.includes('/property/')) return 'property'
  return 'other'
}

const traceRecordEnvelope = (record: MqttMessageRecord): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(record.payload)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

const traceResult = (record: MqttMessageRecord): number | undefined => {
  const data = traceRecordEnvelope(record).data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
  const result = (data as Record<string, unknown>).result
  return typeof result === 'number' && Number.isFinite(result) ? result : undefined
}

const traceSearchText = (record: MqttMessageRecord): string => {
  const envelope = traceRecordEnvelope(record)
  return [
    record.topic,
    record.payload,
    envelope.method,
    envelope.tid,
    envelope.bid,
  ].filter((value): value is string | number => typeof value === 'string' || typeof value === 'number').join(' ').toLocaleLowerCase()
}

export const traceTransactionKey = (transaction: CommandTransaction): string =>
  `${transaction.gatewaySn}:${transaction.tid}`

export const traceTransactionMatchesFocus = (transaction: CommandTransaction, focus?: TraceFocus): boolean => {
  if (!focus || focus.view !== 'tx') return false
  return (focus.tid !== undefined && transaction.tid === focus.tid)
    || (focus.bid !== undefined && transaction.bid === focus.bid)
}

export const buildTraceRepublishPayload = (
  payload: string,
  createTid: () => string = () => crypto.randomUUID(),
): string => {
  try {
    const parsed: unknown = JSON.parse(payload)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return payload
    return JSON.stringify({ ...(parsed as Record<string, unknown>), tid: createTid() }, null, 2)
  } catch {
    return payload
  }
}

const recordBelongsToDevice = (record: MqttMessageRecord, sn: string): boolean =>
  !sn || record.topic.includes(`/${sn}/`)

const transactionDuration = (transaction: CommandTransaction): string => transaction.finishedAt === undefined
  ? '等待返回'
  : `${transaction.finishedAt - transaction.startedAt} ms`

const transactionLabel: Record<CommandTransaction['status'], string> = {
  pending: '等待中',
  success: '成功',
  failed: '失败',
  timeout: '超时',
}

interface DeviceTraceProps {
  profile: ConnectionProfile
  status: ConnectionStatus
  busy: boolean
  records: MqttMessageRecord[]
  transactions: CommandTransaction[]
  selectedDeviceSn: string
  onPublish: (topic: string, payload: string, qos: MqttQos, retain: boolean) => Promise<OperationResult>
  onExport: (records: MqttMessageRecord[]) => Promise<void>
  onClear: () => void
  onNotify?: (text: string, tone?: 'info' | 'success' | 'error') => void
  focus?: TraceFocus
}

export function DeviceTrace({
  profile,
  status,
  busy,
  records,
  transactions,
  selectedDeviceSn,
  onPublish,
  onExport,
  onClear,
  onNotify,
  focus,
}: DeviceTraceProps) {
  const [view, setView] = useState<TraceView>('stream')
  const [scope, setScope] = useState<TraceScope>('device')
  const [search, setSearch] = useState('')
  const [categories, setCategories] = useState<Set<TraceTopicCategory>>(() => new Set(allTraceCategories))
  const [failedOnly, setFailedOnly] = useState(false)
  const [expandedOsd, setExpandedOsd] = useState(false)
  const [paused, setPaused] = useState(false)
  const [selectedRecordId, setSelectedRecordId] = useState('')
  const [selectedTransactionKey, setSelectedTransactionKey] = useState('')
  const [publisherTopic, setPublisherTopic] = useState('')
  const [publisherPayload, setPublisherPayload] = useState('{\n  "data": {}\n}')
  const [publisherQos, setPublisherQos] = useState<MqttQos>(1)
  const [publisherRetain, setPublisherRetain] = useState(false)
  const [publisherState, setPublisherState] = useState('')
  const [sending, setSending] = useState(false)
  const streamRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const defaultSn = profile.devices.find((device) => device.sn === selectedDeviceSn)?.sn ?? profile.devices[0]?.sn ?? selectedDeviceSn
    setPublisherTopic(defaultSn ? `thing/product/${defaultSn}/services` : '')
    setPublisherPayload('{\n  "data": {}\n}')
    setSelectedRecordId('')
    setSelectedTransactionKey('')
  }, [profile.id])

  useEffect(() => {
    if (!focus) return
    const target = transactions.find((transaction) => traceTransactionMatchesFocus(transaction, focus))
    if (!target) return
    setView('transactions')
    setSelectedTransactionKey(traceTransactionKey(target))
  }, [focus, transactions])

  const filteredRecords = useMemo(() => {
    const term = search.trim().toLocaleLowerCase()
    return records.filter((record) => {
      if (scope === 'device' && !recordBelongsToDevice(record, selectedDeviceSn)) return false
      if (!categories.has(traceRecordCategory(record))) return false
      if (failedOnly && !(traceRecordCategory(record) === 'services' && (traceResult(record) ?? 0) !== 0)) return false
      return !term || traceSearchText(record).includes(term)
    })
  }, [categories, failedOnly, records, scope, search, selectedDeviceSn])

  const filteredTransactions = useMemo(() => {
    const term = search.trim().toLocaleLowerCase()
    return transactions.filter((transaction) => {
      if (scope === 'device' && selectedDeviceSn && transaction.gatewaySn !== selectedDeviceSn) return false
      if (failedOnly && transaction.status !== 'failed' && transaction.status !== 'timeout') return false
      if (!term) return true
      return `${transaction.method} ${transaction.tid} ${transaction.bid ?? ''} ${transaction.gatewaySn}`.toLocaleLowerCase().includes(term)
    })
  }, [failedOnly, search, scope, selectedDeviceSn, transactions])

  const osdRecords = filteredRecords.filter((record) => traceRecordCategory(record) === 'osd')
  const visibleRecords = expandedOsd ? filteredRecords : filteredRecords.filter((record) => traceRecordCategory(record) !== 'osd')
  const selectedRecord = filteredRecords.find((record) => record.id === selectedRecordId) ?? filteredRecords.at(-1)
  const selectedTransaction = filteredTransactions.find((transaction) => traceTransactionKey(transaction) === selectedTransactionKey)
    ?? filteredTransactions.find((transaction) => traceTransactionMatchesFocus(transaction, focus))

  useEffect(() => {
    if (!paused && streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight
  }, [filteredRecords.length, paused])

  const toggleCategory = (category: TraceTopicCategory): void => {
    if (category === 'other') return
    setCategories((current) => {
      const next = new Set(current)
      if (next.has(category)) next.delete(category)
      else next.add(category)
      return next
    })
  }

  const fillPublisher = (record: MqttMessageRecord): void => {
    setPublisherTopic(record.topic)
    setPublisherPayload(buildTraceRepublishPayload(record.payload))
    setPublisherQos(record.qos)
    setPublisherRetain(record.retain)
    setPublisherState('已填入发布器，发送时会生成新的 tid')
  }

  const send = async (): Promise<void> => {
    let payload: string
    try {
      payload = buildTraceRepublishPayload(JSON.stringify(JSON.parse(publisherPayload), null, 2))
    } catch {
      setPublisherState('Payload 不是有效 JSON')
      return
    }
    setSending(true)
    try {
      const result = await onPublish(publisherTopic, payload, publisherQos, publisherRetain)
      setPublisherState(result.ok ? '已发布' : result.error ?? '发布失败')
      if (result.ok) onNotify?.('已发布新的报文', 'success')
    } catch (error) {
      setPublisherState(error instanceof Error ? error.message : String(error))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="device-trace">
      <header className="trace-toolbar">
        <div className="segmented trace-view-segmented" role="group" aria-label="报文视图">
          <button type="button" className={view === 'stream' ? 'active' : ''} onClick={() => setView('stream')}>报文流</button>
          <button type="button" className={view === 'transactions' ? 'active' : ''} onClick={() => setView('transactions')}>事务</button>
        </div>
        <div className="segmented trace-scope-segmented" role="group" aria-label="报文范围">
          <button type="button" className={scope === 'device' ? 'active' : ''} onClick={() => setScope('device')}>本设备</button>
          <button type="button" className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>全部</button>
        </div>
        <div className="trace-category-filters" aria-label="Topic 类别">
          {traceCategories.map((category) => (
            <button
              type="button"
              className={categories.has(category.id) ? 'active' : ''}
              key={category.id}
              aria-pressed={categories.has(category.id)}
              onClick={() => toggleCategory(category.id)}
            >
              {category.label}
            </button>
          ))}
        </div>
        <button type="button" className={`trace-failed-toggle ${failedOnly ? 'active' : ''}`} aria-pressed={failedOnly} onClick={() => setFailedOnly((current) => !current)}>
          <Filter size={13} />只看失败
        </button>
        <label className="trace-search"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索 method、tid、bid、Topic 或 Payload" /></label>
        <Tooltip label={paused ? '恢复自动滚动' : '暂停自动滚动'}>
          <button type="button" className="icon-button" onClick={() => setPaused((current) => !current)}>{paused ? <Play size={15} /> : <Pause size={15} />}</button>
        </Tooltip>
        <Tooltip label="导出当前结果"><button type="button" className="icon-button" onClick={() => void onExport(filteredRecords)}><Download size={15} /></button></Tooltip>
        <Tooltip label="清空报文"><button type="button" className="icon-button" onClick={onClear}><Eraser size={15} /></button></Tooltip>
      </header>

      <div className="trace-content">
        <section className="trace-list" ref={streamRef} aria-label={view === 'stream' ? '报文流列表' : '事务列表'}>
          {view === 'stream' ? (
            <>
              {osdRecords.length > 0 && !expandedOsd && (
                <button type="button" className="trace-osd-summary" onClick={() => setExpandedOsd(true)}>
                  <MessageSquareText size={14} /><strong>osd × {osdRecords.length}，展开</strong><span>高频遥测已折叠</span>
                </button>
              )}
              {visibleRecords.map((record) => {
                const category = traceRecordCategory(record)
                const envelope = traceRecordEnvelope(record)
                return (
                  <button type="button" className={`trace-record-row ${record.direction} ${selectedRecord?.id === record.id ? 'selected' : ''}`} key={record.id} onClick={() => setSelectedRecordId(record.id)}>
                    <span className="trace-record-direction">{record.direction === 'in' ? <ArrowDownLeft size={14} /> : <ArrowUpRight size={14} />}</span>
                    <span className="trace-record-copy"><strong>{typeof envelope.method === 'string' ? envelope.method : record.topic}</strong><small>{category} · {record.topic} · {record.payload.replace(/\s+/g, ' ').slice(0, 120)}</small></span>
                    <span className="trace-record-meta"><time>{new Date(record.timestamp).toLocaleTimeString()}</time><small>Q{record.qos} · {record.size} B</small></span>
                  </button>
                )
              })}
              {!visibleRecords.length && !osdRecords.length && <div className="trace-empty"><WrapText size={24} /><span>暂无匹配报文</span></div>}
            </>
          ) : (
            filteredTransactions.map((transaction) => {
              const transactionKey = traceTransactionKey(transaction)
              const error = transaction.result !== undefined && transaction.result !== 0 ? lookupServiceError(transaction.result) : undefined
              const open = selectedTransaction?.tid === transaction.tid
              return (
                <details className={`trace-transaction-item ${transaction.status}`} key={transactionKey} open={open}>
                  <summary className="trace-transaction-summary" onClick={(event) => { event.preventDefault(); setSelectedTransactionKey(transactionKey) }}>
                    <span className={`trace-transaction-mark ${transaction.status}`} />
                    <span className="trace-transaction-main"><strong>{transaction.method}</strong><small title={transaction.tid}>TID {transaction.tid.length > 16 ? `${transaction.tid.slice(0, 16)}…` : transaction.tid}</small></span>
                    <span className="trace-transaction-result"><strong>{transactionLabel[transaction.status]}</strong><small>{transactionDuration(transaction)}</small></span>
                    <span className="trace-transaction-count">{transaction.response ? 2 : 1} 条报文</span>
                    <time>{new Date(transaction.startedAt).toLocaleTimeString()}</time>
                  </summary>
                  <div className="trace-transaction-details">
                    <div className="trace-transaction-meta"><span>网关 SN <code>{transaction.gatewaySn}</code></span><span>TID <code>{transaction.tid}</code></span><span>BID <code>{transaction.bid ?? '--'}</code></span><span>相对耗时 <strong>{transactionDuration(transaction)}</strong></span></div>
                    <div className="trace-direction-line" />
                    <section className="trace-message-card request"><header><span><ArrowUpRight size={14} />请求</span><time>{new Date(transaction.request.timestamp).toLocaleTimeString()}</time></header><code>{transaction.request.topic}</code><pre>{prettyPayload(transaction.request.payload)}</pre><button type="button" className="trace-fill-button" onClick={() => fillPublisher(transaction.request)}><Send size={12} />填入发布器</button></section>
                    {transaction.response ? <section className="trace-message-card response"><header><span><ArrowDownLeft size={14} />回执</span><time>{new Date(transaction.response.timestamp).toLocaleTimeString()}</time></header><code>{transaction.response.topic}</code><pre>{prettyPayload(transaction.response.payload)}</pre><button type="button" className="trace-fill-button" onClick={() => fillPublisher(transaction.response!)}><Send size={12} />填入发布器</button></section> : <div className="trace-response-empty">{transaction.status === 'timeout' ? '20 秒内未收到回执' : '等待设备回执'}</div>}
                    {error && <section className="trace-error-card"><header><SquareArrowOutUpRight size={14} /><strong>错误码 {transaction.result}</strong></header><p>{error.message ?? '错误码库暂未收录该错误的详细说明。'}</p>{error.cause && <small>可能原因：{error.cause}</small>}{error.solution && <small>处理措施：{error.solution}</small>}</section>}
                  </div>
                </details>
              )
            })
          )}
          {view === 'transactions' && !filteredTransactions.length && <div className="trace-empty"><Braces size={24} /><span>暂无匹配事务</span></div>}
        </section>

        <aside className="trace-inspector">
          <header><div><span className="eyebrow">TRACE INSPECTOR</span><h3>{selectedRecord?.topic ?? selectedTransaction?.method ?? '未选择报文'}</h3></div>{selectedRecord && <Tooltip label="复制 Payload"><button type="button" className="icon-button" onClick={() => void navigator.clipboard.writeText(selectedRecord.payload)}><Clipboard size={15} /></button></Tooltip>}</header>
          {selectedRecord ? <><div className="trace-inspector-meta"><span>{selectedRecord.direction === 'in' ? '接收' : '发送'}</span><span>QoS {selectedRecord.qos}</span><span>{selectedRecord.retain ? 'Retained' : 'Not retained'}</span><time>{new Date(selectedRecord.timestamp).toLocaleString()}</time></div><pre>{prettyPayload(selectedRecord.payload)}</pre><button type="button" className="button secondary compact" onClick={() => fillPublisher(selectedRecord)}><Send size={13} />填入发布器</button></> : <div className="trace-empty"><Braces size={22} /><span>选择报文查看详情</span></div>}
        </aside>
      </div>

      <section className="trace-publisher">
        <div className="trace-publisher-heading"><div><Send size={15} /><strong>发布器</strong><small>重发时自动生成新的 tid</small></div><span>{publisherState}</span></div>
        <div className="trace-publisher-row"><label><span>Topic</span><input value={publisherTopic} onChange={(event) => setPublisherTopic(event.target.value)} placeholder="thing/product/{sn}/services" /></label><div className="segmented"><button type="button" className={publisherQos === 0 ? 'active' : ''} onClick={() => setPublisherQos(0)}>Q0</button><button type="button" className={publisherQos === 1 ? 'active' : ''} onClick={() => setPublisherQos(1)}>Q1</button><button type="button" className={publisherQos === 2 ? 'active' : ''} onClick={() => setPublisherQos(2)}>Q2</button></div><label className="check-field"><input type="checkbox" checked={publisherRetain} onChange={(event) => setPublisherRetain(event.target.checked)} /><span>Retain</span></label><button type="button" className="button primary compact" disabled={status !== 'connected' || busy || sending} onClick={() => void send()}>{sending ? '发布中' : '发送'}</button></div>
        <div className="trace-publisher-editor"><textarea value={publisherPayload} onChange={(event) => setPublisherPayload(event.target.value)} spellCheck={false} /><span>{publisherState === '已发布' && <Check size={13} />}{publisherState}</span></div>
      </section>
    </div>
  )
}
