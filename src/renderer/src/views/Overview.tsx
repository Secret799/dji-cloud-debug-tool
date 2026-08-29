import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import {
  Activity,
  ArrowDownLeft,
  ArrowLeft,
  ArrowUpRight,
  Battery,
  Bell,
  Box,
  Braces,
  Camera,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Cloud,
  Command,
  Copy,
  Cpu,
  FileArchive,
  Gamepad2,
  MapPin,
  MessagesSquare,
  Package,
  Plane,
  Pencil,
  Radio,
  RadioTower,
  Search,
  SearchCheck,
  ShieldCheck,
  Wifi,
  Wrench,
  X,
} from 'lucide-react'
import type {
  ConnectionProfile,
  ConnectionStatus,
  DeviceType,
  MqttMessageRecord,
  MqttQos,
  MediaServerProfile,
  ObjectStorageProfile,
  OperationResult,
  TelemetryLayoutConfig,
  TelemetryLayoutField,
  TelemetrySectionKind,
  TelemetryTabKind,
} from '../../../shared/contracts'
import {
  DJI_DOCK2_PROPERTY_DOC_DATE,
  djiAccessModeLabel,
  djiPushModeLabel,
  formatDjiFieldValue,
  getDjiFieldMetadata,
  type DjiFieldMetadata,
} from '../lib/dji-field-metadata'
import {
  DJI_AIRCRAFT_PROPERTY_DOC_DATE,
  getDjiAircraftFieldMetadata,
} from '../lib/dji-aircraft-field-metadata'
import {
  DJI_DOCK3_PROPERTY_DOC_DATE,
  getDjiDock3FieldMetadata,
} from '../lib/dji-dock3-field-metadata'
import {
  FIELD_LABELS,
  DJI_PRODUCT_NAMES,
  PRODUCT_NAMES,
  SUPERDOCK_PRODUCT_NAMES,
  type CommandTransaction,
  type DeviceActivity,
  type DeviceTelemetry,
  type ServiceCaller,
  djiProductKey,
  gatewayCapabilitiesForProvider,
  resolveGatewayProvider,
  formatValue,
  isPayloadActivity,
  mergeNestedRecords,
  parseDeviceActivity,
  parseServicePayload,
  prettyPayload,
  telemetryValue,
} from '../lib/dji'
import { getSuperDockFieldMetadata } from '../lib/superdock-field-metadata'
import {
  SUPERDOCK_PROPERTY_DOC_DATE,
  deviceProvider,
  dockModelName,
} from '../lib/superdock'
import { findHmsErrorCode, lookupServiceError } from '../lib/dji-error-codes'
import {
  HMS_LIST_LIMIT,
  hmsFlightStateLabel,
  hmsImminentLabel,
  hmsLevelLabel,
  hmsModuleLabel,
  parseHmsPayload,
} from '../lib/dji-hms'
import { CommandCenter } from './CommandCenter'
import { MqttConsole } from './MqttConsole'
import { RemoteLogCenter } from './RemoteLogCenter'
import { FirmwareUpgradeCenter } from './FirmwareUpgradeCenter'
import { PropertySetModal, type PropertySetTarget } from '../components/PropertySetModal'
import { Tooltip } from '../components/Tooltip'
import {
  createDefaultTelemetryLayout,
  normalizeTelemetryFieldKey,
  telemetryCustomPropertyMetadata,
  telemetrySectionKindForPath,
} from '../lib/telemetry-layout'

interface OverviewProps {
  profile: ConnectionProfile
  telemetry: DeviceTelemetry[]
  selectedDeviceSn: string
  records: MqttMessageRecord[]
  transactions: CommandTransaction[]
  status?: ConnectionStatus
  busy?: boolean
  onPublish?: (topic: string, payload: string, qos: MqttQos, retain: boolean) => Promise<OperationResult>
  onService?: ServiceCaller
  onExport?: (records: MqttMessageRecord[]) => Promise<void>
  onClear?: () => void
  onNotify?: (text: string, tone?: 'info' | 'success' | 'error') => void
  onOpenOssManager?: () => void
  objectStorageProfiles?: ObjectStorageProfile[]
  activeObjectStorageId?: string
  onSelectObjectStorage?: (profileId: string) => void
  telemetryLayout?: TelemetryLayoutConfig
  mediaServers?: MediaServerProfile[]
}

const MAX_TELEMETRY_FIELDS = 500

const EVENT_TYPE_OPTIONS = [
  { method: 'hms', label: '设备告警', description: 'HMS' },
] as const

export const formatElapsedTime = (elapsedMs: number): string => {
  const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
  if (elapsedSeconds < 60) return `${elapsedSeconds} 秒前`

  const elapsedMinutes = Math.floor(elapsedSeconds / 60)
  if (elapsedMinutes < 60) return `${elapsedMinutes} 分钟前`

  return `${Math.floor(elapsedMinutes / 60)} 小时前`
}

interface FlattenedTelemetry {
  fields: [string, unknown][]
  truncated: boolean
}

const flattenTelemetry = (
  source: Record<string, unknown>,
  maxFields = MAX_TELEMETRY_FIELDS,
): FlattenedTelemetry => {
  const fields: [string, unknown][] = []
  let truncated = false

  const append = (path: string, value: unknown): void => {
    if (fields.length >= maxFields) {
      truncated = true
      return
    }
    fields.push([path, value])
  }

  const visit = (value: unknown, path: string): void => {
    if (truncated) return
    if (Array.isArray(value)) {
      if (!value.length) {
        append(path, value)
        return
      }
      value.forEach((item, index) => visit(item, `${path}.${index}`))
      return
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>)
      if (!entries.length) {
        append(path, value)
        return
      }
      for (const [key, child] of entries) {
        visit(child, path ? `${path}.${key}` : key)
        if (truncated) return
      }
      return
    }
    append(path, value)
  }

  for (const [key, value] of Object.entries(source)) visit(value, key)
  return { fields, truncated }
}

interface TelemetryArrayContext {
  arrayPath: string
  groupKey: string
  itemIndex?: number
  primitiveItem: boolean
}

const telemetryArrayContext = (path: string): TelemetryArrayContext | undefined => {
  const segments = path.split('.')
  let numericIndex = -1
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (/^\d+$/.test(segments[index])) {
      numericIndex = index
      break
    }
  }
  if (numericIndex < 1) return undefined

  const arrayPath = segments.slice(0, numericIndex).join('.')
  const primitiveItem = numericIndex === segments.length - 1
  return {
    arrayPath,
    groupKey: primitiveItem ? arrayPath : segments.slice(0, numericIndex + 1).join('.'),
    itemIndex: primitiveItem ? undefined : Number(segments[numericIndex]),
    primitiveItem,
  }
}

const transactionText: Record<CommandTransaction['status'], string> = {
  pending: '等待响应',
  success: '执行成功',
  failed: '执行失败',
  timeout: '响应超时',
}

const commandTransactionKey = (transaction: CommandTransaction): string =>
  `${transaction.gatewaySn}:${transaction.tid}`

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

const parseJsonValue = (payload: string): JsonValue | undefined => {
  try {
    return JSON.parse(payload) as JsonValue
  } catch {
    return undefined
  }
}

const isJsonContainer = (value: JsonValue): value is JsonValue[] | { [key: string]: JsonValue } =>
  typeof value === 'object' && value !== null

const jsonValueType = (value: JsonValue): string => {
  if (value === null) return 'null'
  return typeof value
}

function JsonTreeNode({
  value,
  name,
  depth,
  trailingComma = false,
}: {
  value: JsonValue
  name?: string | number
  depth: number
  trailingComma?: boolean
}) {
  const container = isJsonContainer(value)
  const childCount = container ? Object.keys(value).length : 0
  const [expanded, setExpanded] = useState(depth < 3 && childCount <= 100)
  const lineStyle = { '--json-depth': depth } as CSSProperties
  const propertyName = name === undefined
    ? null
    : typeof name === 'number'
      ? <><span className="json-tree-index">[{name}]</span><span className="json-tree-punctuation"> </span></>
      : <><span className="json-tree-key">{JSON.stringify(name)}</span><span className="json-tree-punctuation">: </span></>

  if (!container) {
    return (
      <div className="json-tree-line" style={lineStyle} role="treeitem">
        <span className="json-tree-toggle-placeholder" />
        {propertyName}
        <span className={`json-tree-value ${jsonValueType(value)}`}>{JSON.stringify(value)}</span>
        {trailingComma && <span className="json-tree-punctuation">,</span>}
      </div>
    )
  }

  const array = Array.isArray(value)
  const opening = array ? '[' : '{'
  const closing = array ? ']' : '}'
  const entries = Object.entries(value)
  const nodeLabel = name === undefined
    ? 'JSON 根节点'
    : typeof name === 'number'
      ? `数组项 ${name}`
      : `节点 ${name}`

  return (
    <div className="json-tree-node" role="treeitem" aria-expanded={expanded}>
      <div className="json-tree-line" style={lineStyle}>
        <button
          type="button"
          className={`json-tree-toggle${expanded ? ' expanded' : ''}`}
          aria-label={`${expanded ? '收起' : '展开'} ${nodeLabel}`}
          onClick={() => setExpanded((current) => !current)}
        >
          <ChevronRight size={11} />
        </button>
        {propertyName}
        <span className="json-tree-punctuation">{opening}</span>
        {!expanded && (
          <>
            {childCount > 0 && <span className="json-tree-summary">{childCount} 项</span>}
            <span className="json-tree-punctuation">{closing}{trailingComma ? ',' : ''}</span>
          </>
        )}
      </div>
      {expanded && (
        <div role="group">
          {entries.map(([key, child], index) => (
            <JsonTreeNode
              key={key}
              value={child}
              name={array ? index : key}
              depth={depth + 1}
              trailingComma={index < entries.length - 1}
            />
          ))}
          <div className="json-tree-line" style={lineStyle}>
            <span className="json-tree-toggle-placeholder" />
            <span className="json-tree-punctuation">{closing}{trailingComma ? ',' : ''}</span>
          </div>
        </div>
      )}
    </div>
  )
}

export function JsonPayloadView({ payload }: { payload: string }) {
  const parsed = useMemo(() => parseJsonValue(payload), [payload])

  if (parsed === undefined) {
    return <pre className="command-message-payload command-payload-raw">{payload}</pre>
  }

  return (
    <div className="command-message-payload json-tree" role="tree" aria-label="JSON Payload">
      <JsonTreeNode value={parsed} depth={0} />
    </div>
  )
}

export function CommandResultCheckPage({
  transaction,
  onBack,
}: {
  transaction: CommandTransaction
  onBack: () => void
}) {
  const errorGuidance = transaction.result !== undefined && transaction.result !== 0
    ? lookupServiceError(transaction.result)
    : undefined
  if (!errorGuidance) return null

  const duration = transaction.finishedAt === undefined
    ? '等待返回'
    : `${transaction.finishedAt - transaction.startedAt} ms`

  return (
    <div className="work-panel command-result-check-page">
      <header className="command-result-check-header">
        <button type="button" className="button secondary compact" onClick={onBack}>
          <ArrowLeft size={14} />返回最近指令
        </button>
        <div>
          <span className="eyebrow">结果码核查</span>
          <h3>{transaction.method}</h3>
        </div>
        <code>{transaction.result}</code>
      </header>
      <div className="command-result-check-content">
        <dl className="command-result-check-context">
          <div><dt>结果码</dt><dd>{transaction.result}</dd></div>
          <div><dt>网关 SN</dt><dd>{transaction.gatewaySn}</dd></div>
          <div><dt>TID</dt><dd>{transaction.tid}</dd></div>
          <div><dt>耗时</dt><dd>{duration}</dd></div>
          <div><dt>发送时间</dt><dd>{new Date(transaction.startedAt).toLocaleString()}</dd></div>
        </dl>
        <section className="command-error-guidance">
          <header><Wrench size={15} /><strong>结果码 {transaction.result} 核查结果</strong>{errorGuidance.hmsCode && <code>{errorGuidance.hmsCode}</code>}</header>
          <div>
            <span><small>错误说明</small><p>{errorGuidance.message ?? '错误码库暂未收录该错误的详细说明。'}</p></span>
            {errorGuidance.cause && <span><small>可能原因</small><p>{errorGuidance.cause}</p></span>}
            <span className="resolution"><small>处理措施</small><p>{errorGuidance.solution ?? '暂无明确处理措施，请结合返回报文并收集设备日志进一步定位。'}</p></span>
            {errorGuidance.logs && <span><small>建议日志</small><p>{errorGuidance.logs}</p></span>}
          </div>
        </section>
      </div>
    </div>
  )
}

export function CommandHistory({
  transactions,
  onNotify,
}: {
  transactions: CommandTransaction[]
  onNotify?: (text: string, tone?: 'info' | 'success' | 'error') => void
}) {
  const [resultCheckKey, setResultCheckKey] = useState('')
  const visibleTransactions = transactions.slice(0, 50)
  const resultCheckTransaction = visibleTransactions.find(
    (transaction) => commandTransactionKey(transaction) === resultCheckKey,
  )

  const copyMessageValue = async (value: string, label: 'Topic' | 'Payload'): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      onNotify?.(`${label} 已复制`, 'success')
    } catch (error) {
      onNotify?.(error instanceof Error ? error.message : `${label} 复制失败`, 'error')
    }
  }

  const copyActions = (message: MqttMessageRecord) => (
    <span className="command-message-copy-actions">
      <Tooltip label="复制 Topic">
        <button
          type="button"
          className="command-message-copy-button"
          onClick={() => void copyMessageValue(message.topic, 'Topic')}
        >
          <Copy size={11} /><span>Topic</span>
        </button>
      </Tooltip>
      <Tooltip label="复制 Payload">
        <button
          type="button"
          className="command-message-copy-button"
          onClick={() => void copyMessageValue(message.payload, 'Payload')}
        >
          <Copy size={11} /><span>Payload</span>
        </button>
      </Tooltip>
    </span>
  )

  return (
    <section className="history-workspace">
      <div className="work-panel command-history-panel" hidden={Boolean(resultCheckTransaction)}>
        <header className="panel-header"><div><Clock3 size={16} /><h3>最近指令</h3></div><span>{transactions.length} 条</span></header>
        <div className="command-history-list">
          {visibleTransactions.map((transaction) => {
            const duration = transaction.finishedAt === undefined
              ? '等待返回'
              : `${transaction.finishedAt - transaction.startedAt} ms`
            const shortTid = transaction.tid.length > 16 ? `${transaction.tid.slice(0, 16)}...` : transaction.tid
            const errorGuidance = transaction.result !== undefined && transaction.result !== 0
              ? lookupServiceError(transaction.result)
              : undefined
            return (
              <details className="command-history-item" key={`${transaction.gatewaySn}:${transaction.tid}`}>
                <summary className="command-history-summary">
                  <span className={`transaction-mark ${transaction.status}`} />
                  <span className="command-summary-main">
                    <strong>{transaction.method}</strong>
                    <small title={transaction.tid}>TID {shortTid}</small>
                  </span>
                  <span className="command-summary-field command-summary-gateway"><small>网关 SN</small><code>{transaction.gatewaySn}</code></span>
                  <span className="command-summary-field command-summary-result"><small>耗时 / 结果</small><strong>{duration}{transaction.result !== undefined ? ` / ${transaction.result}` : ''}</strong></span>
                  <time className="command-summary-time">{new Date(transaction.startedAt).toLocaleTimeString()}</time>
                  <span className={`transaction-label ${transaction.status}`}>{transactionText[transaction.status]}</span>
                  <span className="command-detail-action"><span className="detail-open-copy">查看详情</span><span className="detail-close-copy">收起详情</span><ChevronDown size={14} /></span>
                </summary>
                <div className="command-history-details">
                  <dl className="command-history-meta">
                    <div><dt>网关 SN</dt><dd>{transaction.gatewaySn}</dd></div>
                    <div><dt>TID</dt><dd title={transaction.tid}>{transaction.tid}</dd></div>
                    <div><dt>BID</dt><dd title={transaction.bid}>{transaction.bid ?? '--'}</dd></div>
                    <div><dt>耗时</dt><dd>{duration}</dd></div>
                    <div>
                      <dt>结果码</dt>
                      <dd className="command-result-value">
                        <span>{transaction.result ?? '--'}</span>
                        {errorGuidance && (
                          <button
                            type="button"
                            className="command-result-check"
                            onClick={() => setResultCheckKey(commandTransactionKey(transaction))}
                          >
                            <SearchCheck size={12} />核查
                          </button>
                        )}
                      </dd>
                    </div>
                    <div><dt>发送时间</dt><dd>{new Date(transaction.startedAt).toLocaleString()}</dd></div>
                  </dl>
                  <div className="command-message-pair">
                    <section className="command-message request">
                      <header>
                        <span><ArrowUpRight size={14} />发送信息</span>
                        <span className="command-message-header-actions">
                          {copyActions(transaction.request)}
                          <time>{new Date(transaction.request.timestamp).toLocaleTimeString()}</time>
                        </span>
                      </header>
                      <div className="command-message-topic"><span>Topic</span><code>{transaction.request.topic}</code></div>
                      <JsonPayloadView payload={transaction.request.payload} />
                    </section>
                    <section className={`command-message response ${transaction.response ? '' : 'empty'}`}>
                      <header>
                        <span><ArrowDownLeft size={14} />返回信息</span>
                        {transaction.response && (
                          <span className="command-message-header-actions">
                            {copyActions(transaction.response)}
                            <time>{new Date(transaction.response.timestamp).toLocaleTimeString()}</time>
                          </span>
                        )}
                      </header>
                      {transaction.response ? (
                        <>
                          <div className="command-message-topic"><span>Topic</span><code>{transaction.response.topic}</code></div>
                          <JsonPayloadView payload={transaction.response.payload} />
                        </>
                      ) : (
                        <div className="command-response-empty">{transaction.status === 'timeout' ? '在 10 秒内未收到返回信息' : '等待设备返回信息'}</div>
                      )}
                    </section>
                  </div>
                </div>
              </details>
            )
          })}
          {!transactions.length && <div className="panel-empty"><Clock3 size={22} /><span>暂无服务调用</span></div>}
        </div>
      </div>
      {resultCheckTransaction && (
        <CommandResultCheckPage
          transaction={resultCheckTransaction}
          onBack={() => setResultCheckKey('')}
        />
      )}
    </section>
  )
}

type WorkbenchTab = 'remote' | 'payload' | 'events' | 'logs' | 'firmware' | 'history' | 'commands' | 'messages'
type ControlCenterTab = 'controls' | 'logs' | 'firmware'

const deviceTypeCopy = {
  dock: { label: '机场', model: 'DJI Dock', icon: RadioTower },
  aircraft: { label: '飞机', model: '飞行器', icon: Plane },
  pilot: { label: '遥控器', model: 'DJI Pilot', icon: Gamepad2 },
} as const

type TelemetrySectionId = string
type TelemetryTabId = string

const DEFAULT_TELEMETRY_LAYOUT = createDefaultTelemetryLayout()

const telemetrySections: { id: TelemetrySectionId; icon: typeof Activity }[] = [
  { id: 'system', icon: Activity },
  { id: 'position', icon: MapPin },
  { id: 'safety', icon: ShieldCheck },
  { id: 'power', icon: Battery },
  { id: 'environment', icon: Cloud },
  { id: 'network', icon: Wifi },
  { id: 'equipment', icon: Cpu },
  { id: 'maintenance', icon: Wrench },
  { id: 'payload', icon: Camera },
  { id: 'other', icon: Box },
]

const telemetryTabIcons: Record<TelemetryTabKind, typeof Activity> = {
  operation: Activity,
  device: Cpu,
  maintenance: Wrench,
  other: Box,
  custom: Box,
}

const telemetrySectionIcons: Record<TelemetrySectionKind, typeof Activity> = {
  system: Activity,
  power: Battery,
  environment: Cloud,
  position: MapPin,
  safety: ShieldCheck,
  network: Wifi,
  payload: Camera,
  equipment: Cpu,
  maintenance: Wrench,
  other: Box,
  custom: Box,
}

const telemetrySectionLabel = (id: TelemetrySectionId, deviceType?: DeviceType): string => {
  const aircraft = deviceType === 'aircraft'
  const labels: Record<TelemetrySectionId, string> = {
    system: aircraft ? '飞行与运行状态' : '运行与任务状态',
    position: aircraft ? '位置、姿态与速度' : '位置与定位',
    safety: aircraft ? '飞行安全与限制' : '地理位置与备降',
    power: aircraft ? '电池与充电' : '供电与备用电池',
    environment: '环境数据',
    network: '网络与通信',
    equipment: aircraft ? '机载设备与存储' : '机场设备',
    maintenance: '保养信息',
    payload: '负载与云台',
    other: '其他字段',
  }
  return labels[id]
}

const telemetrySectionForPath = (path: string, deviceType?: DeviceType): TelemetrySectionId => {
  const value = path.toLowerCase()
  if (/(^|\.)alternate_land_point(\.|$)/.test(value)) return 'safety'
  if (deviceType === 'aircraft' && /(flysafe|area_limit|height_limit|distance_limit|rth_|rc_lost|obstacle_avoidance)/.test(value)) return 'safety'
  if (/(^|\.)maintain_status(\.|$)/.test(value)) return 'maintenance'
  if (/(camera|gimbal|payload|thermal|zoom|lens|photo|video|record)/.test(value)) return 'payload'
  if (/(^|\.)(flighttask_|drc_state|job_number|acc_time|activation_time|first_power_on|media_file_detail|mode_code|silent_mode|user_experience_improvement|gear|rid_state|rc_lost_action|track_id)/.test(value)) return 'system'
  if (/(network|signal|link|rssi|transmission|4g|sdr|lte|wifi)/.test(value)) return 'network'
  if (deviceType === 'aircraft' && /(^|\.)(wind_speed|wind_direction)$/.test(value)) return 'position'
  if (/(battery|charge|capacity|voltage|current|electric|power)/.test(value)) return 'power'
  if (/(temperature|humidity|wind|rain|environment|weather)/.test(value)) return 'environment'
  if (/(latitude|longitude|altitude|height|position|gps|satellite|velocity|speed|attitude|heading|home_|flight|distance_limit|area_limit|rth_)/.test(value)) return 'position'
  if (/(cover|air_conditioner|fan|drone_in_dock|dock|storage|emergency_stop|putter|supplement_light|obstacle_avoidance|alarm_state|night_lights)/.test(value)) return 'equipment'
  if (/(device|firmware|mode|online|activation|compatible|maintain|work_state|status)/.test(value)) return 'system'
  return 'other'
}

const hiddenTelemetryTopLevelFields: Partial<Record<DeviceType, ReadonlySet<string>>> = {
  dock: new Set(['sub_device', 'drone_charge_state', 'drone_battery_maintenance_info', 'horizontal_speed', 'vertical_speed']),
  aircraft: new Set([
    'air_conditioner',
    'alarm_state',
    'backup_battery',
    'cover_state',
    'emergency_stop_state',
    'environment_temperature',
    'humidity',
    'putter_state',
    'rainfall',
    'supplement_light_state',
    'temperature',
  ]),
}

const aircraftIdentityLabels: Record<string, string> = {
  device_sn: '设备 SN',
  device_model_key: '设备型号枚举',
  device_online_status: '开机状态',
  device_paired: '对频状态',
}

const aircraftMaintenanceLabels: Record<string, string> = {
  state: '保养状态',
  last_maintain_type: '上一次保养类型',
  last_maintain_time: '上一次保养时间',
  last_maintain_flight_sorties: '上一次保养时飞行架次',
  last_maintain_flight_time: '上一次保养时飞行时长',
}

const isTelemetryFieldVisible = (path: string, deviceType?: DeviceType): boolean => {
  if (!deviceType) return true
  const topLevel = path.split('.')[0]
  return !hiddenTelemetryTopLevelFields[deviceType]?.has(topLevel)
}

interface TelemetryFieldPresentation {
  label: string
  description?: string
  unit?: string
  officialMetadata?: DjiFieldMetadata
  metadataSourceLabel: string
  propertyPath: string
}

interface TelemetryLayoutOverrides {
  label?: string
  description?: string
}

const telemetryLayoutOverrides = (
  path: string,
  layoutField: TelemetryLayoutField | undefined,
  baselineMetadata: DjiFieldMetadata | undefined,
  contextualLabel?: string,
): TelemetryLayoutOverrides => {
  if (!layoutField) return {}

  const normalizedPath = normalizeTelemetryFieldKey(path)
  const leaf = normalizedPath.split('.').at(-1) ?? normalizedPath
  const defaultLabels = new Set([
    normalizedPath,
    leaf,
    layoutField.key,
    contextualLabel,
    baselineMetadata?.label,
    FIELD_LABELS[normalizedPath]?.label,
    FIELD_LABELS[leaf]?.label,
  ].map((value) => value?.trim()).filter((value): value is string => Boolean(value)))
  const label = layoutField.label.trim()
  const description = layoutField.description.trim()
  const baselineDescription = baselineMetadata?.description?.trim() ?? ''

  return {
    label: label && !defaultLabels.has(label) ? layoutField.label : undefined,
    description: description && description !== baselineDescription ? layoutField.description : undefined,
  }
}

const telemetryFieldPresentation = (
  path: string,
  deviceType?: DeviceType,
  usesDock2Metadata = false,
  context = telemetryArrayContext(path),
  layoutField?: TelemetryLayoutField,
  usesDock3Metadata = false,
  usesSuperDockMetadata = false,
): TelemetryFieldPresentation => {
  const leaf = path.split('.').at(-1) ?? path
  const relayedAircraftField = deviceType === 'aircraft'
    && /^(drone_charge_state|drone_battery_maintenance_info)(\.|$)/.test(path)
  const relayedAircraftIdentityField = deviceType === 'aircraft'
    && /^(device_sn|device_model_key|device_online_status|device_paired)$/.test(path)
  const metadataPath = relayedAircraftIdentityField ? `sub_device.${path}` : path
  const dockMetadata = relayedAircraftField || relayedAircraftIdentityField
    ? getDjiFieldMetadata(metadataPath)
    : usesSuperDockMetadata
      ? getSuperDockFieldMetadata(metadataPath)
      : usesDock3Metadata
        ? getDjiDock3FieldMetadata(metadataPath)
        : usesDock2Metadata
          ? getDjiFieldMetadata(metadataPath)
          : undefined
  const aircraftMetadata = deviceType === 'aircraft' && !relayedAircraftField && !relayedAircraftIdentityField
    ? getDjiAircraftFieldMetadata(path)
    : undefined
  const configuredMetadata = dockMetadata || aircraftMetadata
    ? undefined
    : telemetryCustomPropertyMetadata(layoutField)
  const officialMetadata = dockMetadata ?? aircraftMetadata ?? configuredMetadata
  const metadataSourceLabel = configuredMetadata
    ? '遥测项管理 · 自定义属性设置'
    : usesSuperDockMetadata && dockMetadata
      ? `SuperDock 机场设备属性 · ${SUPERDOCK_PROPERTY_DOC_DATE}`
      : usesDock3Metadata && dockMetadata
        ? `DJI Dock 3 设备属性 · ${DJI_DOCK3_PROPERTY_DOC_DATE}`
        : dockMetadata || usesDock2Metadata
          ? `DJI Dock 2 设备属性 · ${DJI_DOCK2_PROPERTY_DOC_DATE}`
          : `DJI 飞行器设备属性（通用字段） · ${DJI_AIRCRAFT_PROPERTY_DOC_DATE}`
  const fallbackMetadata = FIELD_LABELS[path] ?? FIELD_LABELS[leaf]
  const contextualLabel = relayedAircraftIdentityField
    ? aircraftIdentityLabels[path]
    : deviceType === 'aircraft' && path.startsWith('maintain_status.')
      ? aircraftMaintenanceLabels[leaf]
      : undefined
  const baselineMetadata = relayedAircraftField || relayedAircraftIdentityField || deviceType === 'dock'
    ? getDjiFieldMetadata(metadataPath)
    : deviceType === 'aircraft'
      ? getDjiAircraftFieldMetadata(path)
      : undefined
  const layoutOverrides = telemetryLayoutOverrides(
    path,
    layoutField,
    baselineMetadata,
    contextualLabel,
  )
  const arrayItemIndex = context?.primitiveItem ? Number(leaf) : undefined
  return {
    label: arrayItemIndex !== undefined
      ? `[${arrayItemIndex}]`
      : layoutOverrides.label || contextualLabel || officialMetadata?.label || fallbackMetadata?.label || leaf,
    description: layoutOverrides.description || officialMetadata?.description,
    unit: officialMetadata?.unit ?? fallbackMetadata?.unit,
    officialMetadata,
    metadataSourceLabel,
    propertyPath: configuredMetadata?.path ?? path,
  }
}

export const telemetryFieldMatchesSearch = (
  path: string,
  search: string,
  deviceType?: DeviceType,
  usesDock2Metadata = false,
  layoutField?: TelemetryLayoutField,
  usesDock3Metadata = false,
  usesSuperDockMetadata = false,
): boolean => {
  const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const segments = path.split('.')
  const labels = segments
    .map((_, index) => segments.slice(0, index + 1).join('.'))
    .filter((candidate) => !/\.\d+$/.test(candidate))
    .map((candidate) => telemetryFieldPresentation(
      candidate,
      deviceType,
      usesDock2Metadata,
      telemetryArrayContext(candidate),
      candidate === path ? layoutField : undefined,
      usesDock3Metadata,
      usesSuperDockMetadata,
    ).label)
  const searchableText = `${labels.join(' ')} ${layoutField?.description ?? ''} ${path}`.toLocaleLowerCase()
  return terms.every((term) => searchableText.includes(term))
}

interface FieldHelpProps {
  path: string
  metadata?: DjiFieldMetadata
  sourceLabel: string
  displayLabel?: string
  description?: string
}

interface TooltipPosition {
  top: number
  left: number
}

function FieldHelp({ path, metadata, sourceLabel, displayLabel, description }: FieldHelpProps) {
  const tooltipId = useId()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const tooltipRef = useRef<HTMLSpanElement>(null)
  const closeTimerRef = useRef<number>()
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [position, setPosition] = useState<TooltipPosition>()
  const open = (hovered || focused) && !dismissed
  const accessMode = djiAccessModeLabel(metadata?.accessMode)
  const pushMode = djiPushModeLabel(metadata?.pushMode)

  const clearScheduledClose = (): void => {
    if (closeTimerRef.current === undefined) return
    window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = undefined
  }

  const beginHover = (resetDismissed = false): void => {
    clearScheduledClose()
    if (resetDismissed) setDismissed(false)
    setHovered(true)
  }

  const endHoverSoon = (): void => {
    clearScheduledClose()
    closeTimerRef.current = window.setTimeout(() => {
      setHovered(false)
      closeTimerRef.current = undefined
    }, 120)
  }

  useEffect(() => () => clearScheduledClose(), [])

  useEffect(() => {
    if (!open) return undefined
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setDismissed(true)
    }
    window.addEventListener('keydown', dismiss)
    return () => window.removeEventListener('keydown', dismiss)
  }, [open])

  useEffect(() => {
    if (!open) return undefined

    const updatePosition = (): void => {
      const button = buttonRef.current
      const tooltip = tooltipRef.current
      if (!button || !tooltip) return

      const buttonBox = button.getBoundingClientRect()
      const tooltipBox = tooltip.getBoundingClientRect()
      const margin = 10
      const gap = 8
      const anchorVisible = buttonBox.bottom > 0
        && buttonBox.top < window.innerHeight
        && buttonBox.right > 0
        && buttonBox.left < window.innerWidth
      if (!anchorVisible) {
        setPosition(undefined)
        return
      }
      const centeredLeft = buttonBox.left + buttonBox.width / 2 - tooltipBox.width / 2
      const left = Math.min(
        Math.max(margin, centeredLeft),
        Math.max(margin, window.innerWidth - tooltipBox.width - margin),
      )
      const below = buttonBox.bottom + gap
      const above = buttonBox.top - tooltipBox.height - gap
      const preferredTop = below + tooltipBox.height <= window.innerHeight - margin
        ? below
        : above
      const top = Math.min(
        Math.max(margin, preferredTop),
        Math.max(margin, window.innerHeight - tooltipBox.height - margin),
      )

      setPosition({ top, left })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open])

  return (
    <span
      className="field-help"
      onMouseEnter={() => {
        setPosition(undefined)
        beginHover(true)
      }}
      onMouseLeave={endHoverSoon}
    >
      <button
        ref={buttonRef}
        type="button"
        className="field-help-button"
        aria-label={`${displayLabel || metadata?.label || path}字段详情`}
        aria-describedby={open ? tooltipId : undefined}
        onFocus={() => {
          setPosition(undefined)
          setDismissed(false)
          setFocused(true)
        }}
        onBlur={() => setFocused(false)}
      >
        <CircleHelp size={13} />
      </button>
      {open && createPortal(
        <span
          ref={tooltipRef}
          className={`field-tooltip ${position ? 'visible' : ''}`}
          id={tooltipId}
          role="tooltip"
          style={{ top: position?.top ?? 0, left: position?.left ?? 0 }}
          onMouseEnter={() => beginHover()}
          onMouseLeave={endHoverSoon}
        >
          <span className="field-tooltip-heading">
            <strong>{displayLabel || metadata?.label || '未收录字段'}</strong>
            <code>{path}</code>
          </span>
          <span className="field-tooltip-description">
            {description
              ?? metadata?.description
              ?? (metadata
                ? '官方文档未提供补充描述，请结合字段名称、类型和约束判断含义。'
                : `当前引用的“${sourceLabel}”中未收录该字段，界面保留原始字段名和值用于调试。`)}
          </span>
          {metadata && (
            <span className="field-tooltip-grid">
              <span><small>类型</small><code>{metadata.type}</code></span>
              {accessMode && <span><small>权限</small><strong>{accessMode}</strong></span>}
              {pushMode && <span><small>上报</small><strong>{pushMode}</strong></span>}
              {metadata.unit && <span><small>单位</small><strong>{metadata.unit}</strong></span>}
            </span>
          )}
          {metadata?.constraint && (
            <span className="field-tooltip-constraint">
              <small>约束 / 枚举</small>
              <code>{metadata.constraint}</code>
            </span>
          )}
          {metadata && <span className="field-tooltip-source">{sourceLabel}</span>}
        </span>,
        document.body,
      )}
    </span>
  )
}

export function HmsPayloadDetails({ payload }: { payload: string }) {
  const parsed = useMemo(() => parseHmsPayload(payload), [payload])

  if (!parsed) {
    return (
      <div className="hms-parse-fallback">
        <span>报文不符合 Dock 3 HMS 数据结构，已保留原始内容。</span>
        <JsonPayloadView payload={payload} />
      </div>
    )
  }

  const warningCount = parsed.alarms.filter((alarm) => alarm.level === 2).length
  const imminentCount = parsed.alarms.filter((alarm) => alarm.imminent === 1).length
  const envelopeTime = parsed.timestamp === undefined ? undefined : new Date(parsed.timestamp)
  const validEnvelopeTime = envelopeTime && !Number.isNaN(envelopeTime.getTime()) ? envelopeTime : undefined

  return (
    <div className="hms-parsed-payload">
      <div className="hms-summary-strip" aria-label="HMS 通用字段">
        <span><small>告警项</small><strong>{parsed.alarms.length}</strong></span>
        <span><small>警告等级</small><strong className={warningCount ? 'danger' : ''}>{warningCount}</strong></span>
        <span><small>实时性告警</small><strong>{imminentCount}</strong></span>
      </div>

      {(parsed.tid || parsed.bid || validEnvelopeTime) && (
        <dl className="hms-envelope-meta">
          {parsed.tid && <div><dt>TID</dt><dd title={parsed.tid}>{parsed.tid}</dd></div>}
          {parsed.bid && <div><dt>BID</dt><dd title={parsed.bid}>{parsed.bid}</dd></div>}
          {validEnvelopeTime && (
            <div><dt>设备上报时间</dt><dd>{validEnvelopeTime.toLocaleString()}</dd></div>
          )}
        </dl>
      )}

      {parsed.exceedsListLimit && (
        <div className="hms-limit-warning">告警列表超过文档限制的 {HMS_LIST_LIMIT} 项，请检查设备报文。</div>
      )}

      {parsed.alarms.length ? (
        <div className="hms-alarm-list" role="list" aria-label="HMS 告警列表">
          {parsed.alarms.map((alarm, index) => {
            const guidance = findHmsErrorCode(alarm.normalizedCode ?? alarm.code)
            const displayCode = alarm.normalizedCode ?? alarm.code
            const deviceName = alarm.deviceType
              ? PRODUCT_NAMES[alarm.deviceType] ?? '未收录设备'
              : '未上报'
            const severityClass = alarm.level === 2
              ? 'warning'
              : alarm.level === 1
                ? 'reminder'
                : alarm.level === 0
                  ? 'notice'
                  : 'unknown'
            return (
              <section
                className={`hms-alarm-item ${severityClass}`}
                key={`${displayCode}:${index}`}
                role="listitem"
              >
                <header>
                  <div className="hms-alarm-title">
                    <span className="hms-alarm-index">#{index + 1}</span>
                    <span className={`hms-level-badge ${severityClass}`}>{hmsLevelLabel(alarm.level)}</span>
                    <code>{displayCode}</code>
                    <strong>{guidance?.message ?? guidance?.faq ?? '错误码库暂未收录该告警'}</strong>
                  </div>
                  <span className={`hms-imminent-badge${alarm.imminent === 1 ? ' active' : ''}`}>
                    {hmsImminentLabel(alarm.imminent)}
                  </span>
                </header>

                <div className="hms-alarm-detail">
                  <dl className="hms-alarm-fields">
                    <div><dt>事件模块</dt><dd>{hmsModuleLabel(alarm.module)}</dd></div>
                    <div><dt>飞行状态</dt><dd>{hmsFlightStateLabel(alarm.inTheSky)}</dd></div>
                    <div><dt>设备类型</dt><dd title={alarm.deviceType}>{deviceName}{alarm.deviceType ? ` (${alarm.deviceType})` : ''}</dd></div>
                    <div><dt>组件索引</dt><dd>{alarm.args?.componentIndex ?? '未上报'}</dd></div>
                    <div><dt>传感器索引</dt><dd>{alarm.args?.sensorIndex ?? '未上报'}</dd></div>
                  </dl>

                  {guidance && (
                    <div className="hms-guidance">
                      {guidance.cause && <span><small>可能原因</small><p>{guidance.cause}</p></span>}
                      {(guidance.solution || guidance.faq) && (
                        <span><small>处理建议</small><p>{guidance.solution ?? guidance.faq}</p></span>
                      )}
                      {guidance.materials.length > 0 && (
                        <span><small>相关物料</small><p>{guidance.materials.join('、')}</p></span>
                      )}
                    </div>
                  )}
                </div>
              </section>
            )
          })}
        </div>
      ) : (
        <div className="hms-empty-list">报文已解析，但 data.list 中没有有效告警项。</div>
      )}

      <details className="hms-raw-payload">
        <summary><Braces size={13} /><span>原始 MQTT 报文</span><ChevronDown size={13} /></summary>
        <JsonPayloadView payload={payload} />
      </details>
    </div>
  )
}

export function DeviceEventWorkspace({
  activities,
  onNotify,
}: {
  activities: DeviceActivity[]
  onNotify?: (text: string, tone?: 'info' | 'success' | 'error') => void
}) {
  const [selectedMethod, setSelectedMethod] = useState<string>(EVENT_TYPE_OPTIONS[0].method)
  const [selectedMessageId, setSelectedMessageId] = useState('')
  const selectedType = EVENT_TYPE_OPTIONS.find((option) => option.method === selectedMethod)
    ?? EVENT_TYPE_OPTIONS[0]
  const selectedActivities = activities
    .filter((activity) => activity.method === selectedType.method)
    .slice()
    .sort((left, right) => right.record.timestamp - left.record.timestamp)
  const selectedMessageIndex = selectedActivities.findIndex((activity) => activity.record.id === selectedMessageId)
  const selectedActivity = selectedMessageIndex >= 0 ? selectedActivities[selectedMessageIndex] : undefined
  const selectedMessageNumber = selectedActivity ? selectedActivities.length - selectedMessageIndex : undefined

  const copyMessageValue = async (value: string, label: 'Topic' | 'Payload'): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      onNotify?.(`${label} 已复制`, 'success')
    } catch (error) {
      onNotify?.(error instanceof Error ? error.message : `${label} 复制失败`, 'error')
    }
  }

  return (
    <section className="event-workspace">
      <aside className="event-type-pane">
        <header className="event-pane-header">
          <div><Bell size={17} /><h3>事件类型</h3></div>
          <span>{EVENT_TYPE_OPTIONS.length} 种</span>
        </header>
        <nav className="event-type-list" aria-label="事件类型">
          {EVENT_TYPE_OPTIONS.map((option) => {
            const count = activities.filter((activity) => activity.method === option.method).length
            const active = selectedType.method === option.method
            return (
              <button
                type="button"
                key={option.method}
                className={active ? 'active' : ''}
                aria-current={active ? 'page' : undefined}
                onClick={() => {
                  setSelectedMethod(option.method)
                  setSelectedMessageId('')
                }}
              >
                <span className="event-type-icon"><Bell size={16} /></span>
                <span className="event-type-copy">
                  <strong>{option.label}</strong>
                  <code>{option.method}</code>
                </span>
                <small>{count}</small>
                <ChevronRight size={15} className="event-type-chevron" />
              </button>
            )
          })}
        </nav>
      </aside>

      <section className={`event-detail-pane${selectedActivity ? '' : ' list-mode'}`}>
        {selectedActivity && selectedMessageNumber && (
          <header className="event-pane-header event-detail-header">
            <div>
              <Radio size={17} />
              <span>
                <h3>告警详情</h3>
                <small>{selectedType.label} · 消息 #{selectedMessageNumber}</small>
              </span>
            </div>
            <span>{selectedActivities.length} 条</span>
          </header>
        )}

        {selectedActivity && selectedMessageNumber ? (
          <div className="event-detail-body detail-mode">
            <div className="event-detail-toolbar">
              <button type="button" className="event-detail-back" onClick={() => setSelectedMessageId('')}>
                <ArrowLeft size={14} /><span>返回消息列表</span>
              </button>
              <time dateTime={new Date(selectedActivity.record.timestamp).toISOString()}>
                {new Date(selectedActivity.record.timestamp).toLocaleString()}
              </time>
            </div>
            <div className="event-detail-list">
              <article className="event-message-detail" key={selectedActivity.record.id}>
                  <header>
                    <div>
                      <span className="event-message-index">#{selectedMessageNumber}</span>
                      <strong>{selectedType.label}</strong>
                      <code>{selectedActivity.method}</code>
                    </div>
                    <div className="event-message-actions">
                      <Tooltip label="复制 Topic">
                        <button type="button" aria-label="复制 Topic" onClick={() => void copyMessageValue(selectedActivity.record.topic, 'Topic')}>
                          <Copy size={13} />
                        </button>
                      </Tooltip>
                      <Tooltip label="复制 Payload">
                        <button type="button" aria-label="复制 Payload" onClick={() => void copyMessageValue(selectedActivity.record.payload, 'Payload')}>
                          <Braces size={13} />
                        </button>
                      </Tooltip>
                    </div>
                  </header>
                  <dl className="event-message-meta">
                    <div className="event-message-topic"><dt>Topic</dt><dd title={selectedActivity.record.topic}>{selectedActivity.record.topic}</dd></div>
                    <div><dt>QoS</dt><dd>{selectedActivity.record.qos}</dd></div>
                    <div><dt>大小</dt><dd>{selectedActivity.record.size} B</dd></div>
                  </dl>
                  <HmsPayloadDetails payload={selectedActivity.record.payload} />
              </article>
            </div>
          </div>
        ) : selectedActivities.length ? (
          <div className="event-message-list" role="table" aria-label="HMS 消息列表">
            <div className="event-message-list-head" role="row">
              <span role="columnheader">序号</span>
              <span role="columnheader">上报消息</span>
              <span role="columnheader">告警项</span>
              <span role="columnheader">最高等级</span>
              <span role="columnheader">实时性</span>
              <span role="columnheader">操作</span>
            </div>
            <div className="event-message-list-body" role="rowgroup">
              {selectedActivities.map((activity, index) => {
                const parsed = parseHmsPayload(activity.record.payload)
                const highestLevel = parsed?.alarms.reduce<number | undefined>((highest, alarm) => (
                  alarm.level === undefined ? highest : Math.max(highest ?? alarm.level, alarm.level)
                ), undefined)
                const imminentCount = parsed?.alarms.filter((alarm) => alarm.imminent === 1).length ?? 0
                const severityClass = highestLevel === 2
                  ? 'warning'
                  : highestLevel === 1
                    ? 'reminder'
                    : highestLevel === 0
                      ? 'notice'
                      : 'unknown'
                return (
                  <div className="event-message-list-row" role="row" key={activity.record.id}>
                    <span className="event-list-index" role="cell">#{selectedActivities.length - index}</span>
                    <span className="event-list-message" role="cell">
                      <strong>{new Date(activity.record.timestamp).toLocaleString()}</strong>
                      <code title={activity.record.topic}>{activity.record.topic}</code>
                    </span>
                    <strong role="cell">{parsed?.alarms.length ?? 0}</strong>
                    <span role="cell"><span className={`hms-level-badge ${severityClass}`}>{hmsLevelLabel(highestLevel)}</span></span>
                    <strong role="cell">{imminentCount}</strong>
                    <span role="cell">
                      <button
                        type="button"
                        className="event-message-detail-button"
                        onClick={() => setSelectedMessageId(activity.record.id)}
                      >
                        <span>详情</span><ChevronRight size={13} />
                      </button>
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        ) : (
          <div className="event-detail-empty">
            <Bell size={24} />
            <strong>暂无 HMS 消息</strong>
            <span>收到 method = hms 的设备事件后将在此显示。</span>
          </div>
        )}
      </section>
    </section>
  )
}

export function Overview({
  profile,
  telemetry,
  selectedDeviceSn,
  records,
  transactions,
  status = 'disconnected',
  busy = false,
  onPublish,
  onService,
  onExport,
  onClear,
  onNotify,
  onOpenOssManager,
  objectStorageProfiles = [],
  activeObjectStorageId = '',
  onSelectObjectStorage,
  telemetryLayout = DEFAULT_TELEMETRY_LAYOUT,
  mediaServers = [],
}: OverviewProps) {
  const [activeTab, setActiveTab] = useState<WorkbenchTab>('remote')
  const [activeControlCenterTab, setActiveControlCenterTab] = useState<ControlCenterTab>('controls')
  const [activeTelemetryTab, setActiveTelemetryTab] = useState<TelemetryTabId>('operation')
  const [activeTelemetrySection, setActiveTelemetrySection] = useState<TelemetrySectionId>()
  const [telemetrySearch, setTelemetrySearch] = useState('')
  const [selectedPsdkIndex, setSelectedPsdkIndex] = useState<number>()
  const [propertySetTarget, setPropertySetTarget] = useState<PropertySetTarget>()
  const telemetryPanelsRef = useRef<HTMLDivElement>(null)
  const requestedConfigured = profile.devices.find((device) => device.sn === selectedDeviceSn)
  const requestedTelemetry = telemetry.find((device) => device.sn === selectedDeviceSn)
  const fallbackSn = profile.devices[0]?.sn ?? telemetry[0]?.sn ?? ''
  const deviceSn = requestedConfigured || requestedTelemetry ? selectedDeviceSn : fallbackSn
  const selected = telemetry.find((device) => device.sn === deviceSn)
  const configured = profile.devices.find((device) => device.sn === deviceSn)
  const deviceType = configured?.type ?? selected?.type
  const topologyProductKey = selected?.identity ? djiProductKey(selected.identity) : undefined
  const selectedProvider = resolveGatewayProvider(configured, selected)
  const gatewaySn = deviceType === 'dock' || deviceType === 'pilot'
    ? deviceSn
    : selected?.gatewaySn ?? configured?.parentSn
  const configuredGateway = gatewaySn ? profile.devices.find((device) => device.sn === gatewaySn) : undefined
  const runtimeGateway = gatewaySn ? telemetry.find((device) => device.sn === gatewaySn) : undefined
  const gatewayProvider = resolveGatewayProvider(configuredGateway, runtimeGateway)
  const gatewayCapabilities = gatewayCapabilitiesForProvider(gatewayProvider)
  const usesSuperDockMetadata = deviceType === 'dock' && selectedProvider === 'superdock'
  const usesDock2Metadata = deviceType === 'dock'
    && !usesSuperDockMetadata
    && (topologyProductKey
      ? topologyProductKey === '3-2-0'
      : Boolean(configured) && (configured?.dockModel ?? 'dock2') === 'dock2')
  const usesDock3Metadata = deviceType === 'dock'
    && !usesSuperDockMetadata
    && (topologyProductKey
      ? topologyProductKey === '3-3-0'
      : configured?.dockModel === 'dock3')
  const source = useMemo(
    () => mergeNestedRecords(selected?.status ?? {}, selected?.state ?? {}, selected?.osd ?? {}),
    [selected],
  )
  const flattenedTelemetry = useMemo(
    () => {
      const osd = flattenTelemetry(selected?.osd ?? {})
      const remaining = Math.max(0, MAX_TELEMETRY_FIELDS - osd.fields.length)
      const state = flattenTelemetry(selected?.state ?? {}, remaining)
      return {
        fields: [
          ...osd.fields.map(([path, value]) => ({ path, value, source: 'osd' as const })),
          ...state.fields.map(([path, value]) => ({ path, value, source: 'state' as const })),
        ],
        truncated: osd.truncated || state.truncated,
      }
    },
    [selected],
  )
  const fields = flattenedTelemetry.fields
  const deviceLayout = telemetryLayout.devices[deviceType ?? 'pilot']
  const layoutFieldsByKey = new Map(deviceLayout.fields.map((field) => [field.key, field]))
  const visibleFields = fields.filter((field) => {
    const configuredField = layoutFieldsByKey.get(normalizeTelemetryFieldKey(field.path))
    return configuredField ? configuredField.visible : isTelemetryFieldVisible(field.path, deviceType)
  })
  const assignedSections = new Map<string, string>()
  const fallbackSections = new Map<TelemetrySectionKind, string>()
  deviceLayout.tabs.forEach((tab) => tab.sections.forEach((section) => {
    const sectionKey = `${tab.id}:${section.id}`
    if (!fallbackSections.has(section.kind)) fallbackSections.set(section.kind, sectionKey)
    section.fieldKeys.forEach((key) => assignedSections.set(key, sectionKey))
  }))
  const defaultSectionKey = fallbackSections.get('other')
    ?? `${deviceLayout.tabs[0]?.id ?? ''}:${deviceLayout.tabs[0]?.sections[0]?.id ?? ''}`
  const sectionKeyForField = (path: string): string => {
    const key = normalizeTelemetryFieldKey(path)
    return assignedSections.get(key)
      ?? fallbackSections.get(telemetrySectionKindForPath(key, deviceType))
      ?? defaultSectionKey
  }
  const searchableFields = visibleFields
  const telemetrySearchQuery = telemetrySearch.trim()
  const filteredTelemetryFields = searchableFields.filter((field) =>
    telemetryFieldMatchesSearch(
      field.path,
      telemetrySearchQuery,
      deviceType,
      usesDock2Metadata,
      layoutFieldsByKey.get(normalizeTelemetryFieldKey(field.path)),
      usesDock3Metadata,
      usesSuperDockMetadata,
    ),
  )
  const telemetryTabs = deviceLayout.tabs
    .map((tab) => ({
      id: tab.id,
      label: tab.name || '未命名页签',
      icon: telemetryTabIcons[tab.kind],
      sections: tab.sections.map((section) => {
        const fieldOrder = new Map(section.fieldKeys.map((key, index) => [key, index]))
        const sectionKey = `${tab.id}:${section.id}`
        return {
          id: section.id,
          label: section.name || '未命名页签',
          icon: telemetrySectionIcons[section.kind],
          fields: filteredTelemetryFields
            .filter((field) => sectionKeyForField(field.path) === sectionKey)
            .sort((left, right) => {
              const leftOrder = fieldOrder.get(normalizeTelemetryFieldKey(left.path)) ?? Number.MAX_SAFE_INTEGER
              const rightOrder = fieldOrder.get(normalizeTelemetryFieldKey(right.path)) ?? Number.MAX_SAFE_INTEGER
              return leftOrder - rightOrder
            }),
        }
      }).filter((section) => section.fields.length),
    }))
    .map((tab) => ({
      ...tab,
      fieldCount: tab.sections.reduce((count, section) => count + section.fields.length, 0),
    }))
    .filter((tab) => tab.fieldCount)
  const selectedTelemetryTab = telemetryTabs.find((tab) => tab.id === activeTelemetryTab) ?? telemetryTabs[0]
  const selectedTelemetrySection = selectedTelemetryTab?.sections.find((section) => section.id === activeTelemetrySection)
    ?? selectedTelemetryTab?.sections[0]
  useEffect(() => {
    telemetryPanelsRef.current
      ?.querySelector<HTMLElement>('.telemetry-tab-panel:not([hidden]) .telemetry-section-panels')
      ?.scrollTo({ top: 0 })
  }, [activeTelemetryTab, activeTelemetrySection, deviceSn, telemetrySearchQuery])
  const deviceRecords = records.filter((record) => !deviceSn || record.topic.includes(`/${deviceSn}/`))
  const deviceActivities = deviceRecords.flatMap((record) => {
    const activity = parseDeviceActivity(record)
    return activity ? [activity] : []
  })
  const aircraftGatewaySn = deviceType === 'aircraft' ? selected?.gatewaySn ?? configured?.parentSn : undefined
  const propertyGatewaySn = deviceType === 'aircraft' ? aircraftGatewaySn : deviceSn
  const payloadGatewaySn = deviceType === 'dock' ? deviceSn : aircraftGatewaySn
  const payloadRecords = payloadGatewaySn
    ? records.filter((record) => record.topic.includes(`/${payloadGatewaySn}/`))
    : []
  const payloadActivities = payloadRecords.flatMap((record) => {
    const activity = parseDeviceActivity(record)
    return activity && isPayloadActivity(activity) ? [activity] : []
  })
  const generalActivities = deviceActivities.filter((activity) => !isPayloadActivity(activity))
  const hmsActivities = generalActivities.filter((activity) => activity.method === 'hms')
  const payloadIndexes = Array.from(new Set(payloadActivities.map((activity) => activity.psdkIndex)))
    .sort((left, right) => left - right)
  const latestPsdkIndex = payloadActivities.at(-1)?.psdkIndex
  const activePsdkIndex = selectedPsdkIndex !== undefined && payloadIndexes.includes(selectedPsdkIndex)
    ? selectedPsdkIndex
    : latestPsdkIndex
  const selectedPayloadActivities = activePsdkIndex === undefined
    ? payloadActivities
    : payloadActivities.filter((activity) => activity.psdkIndex === activePsdkIndex)
  const latestPayloadActivity = selectedPayloadActivities.at(-1)
  const latestPayloadEnvelope = latestPayloadActivity ? parseServicePayload(latestPayloadActivity.record.payload) : undefined
  const latestPayloadData = latestPayloadEnvelope?.data
  const latestPayloadValue = latestPayloadData && typeof latestPayloadData === 'object' && !Array.isArray(latestPayloadData)
    ? (latestPayloadData as Record<string, unknown>).value
    : undefined
  const latestPayloadText = typeof latestPayloadValue === 'string'
    ? latestPayloadValue
    : latestPayloadValue === undefined
      ? latestPayloadData === undefined
        ? ''
        : JSON.stringify(latestPayloadData, null, 2)
      : JSON.stringify(latestPayloadValue, null, 2)
  const aircraftModelKey = deviceType === 'aircraft' ? telemetryValue(source, 'device_model_key') : undefined
  const legacyProductKey = typeof aircraftModelKey === 'string' ? aircraftModelKey : undefined
  const productKey = topologyProductKey ?? legacyProductKey
  const typeMeta = deviceTypeCopy[deviceType ?? 'pilot']
  const DeviceIcon = typeMeta.icon
  const deviceOnline = status === 'connected'
    && Boolean(selected && selected.online !== false && Date.now() - selected.lastSeenAt < 20_000)
  const deviceStatus = `${typeMeta.label}${deviceOnline ? '在线' : '离线'}`
  const configuredDockModel = configured?.type === 'dock'
    ? dockModelName(configured.dockModel, deviceProvider(configured))
    : deviceType === 'dock' && selectedProvider === 'superdock'
      ? 'SuperDock 机场'
      : typeMeta.model
  const enumeratedDeviceModel = productKey
    ? DJI_PRODUCT_NAMES[productKey] ?? SUPERDOCK_PRODUCT_NAMES[productKey]
    : undefined
  const deviceModel = (enumeratedDeviceModel
    ?? (deviceType === 'aircraft' ? '飞机型号待识别' : deviceType === 'dock' ? configuredDockModel : typeMeta.model))
    .replace(/^SuperDock\s+/, '')
  const providerName = productKey && DJI_PRODUCT_NAMES[productKey]
    ? 'DJI'
    : productKey && SUPERDOCK_PRODUCT_NAMES[productKey]
      ? '草莓创新'
      : '未知'
  const identityProtocol = selected?.identity
    ? [selected.identity.thingVersion ? `v${selected.identity.thingVersion}` : undefined, selected.identity.channelIndex ? `通道 ${selected.identity.channelIndex}` : undefined]
      .filter(Boolean)
      .join(' / ') || '尚未上报'
    : '尚未上报'
  const lastSeen = selected?.lastSeenAt
    ? formatElapsedTime(Date.now() - selected.lastSeenAt)
    : '尚未上报'
  const reportedFirmwareVersion = telemetryValue(source, 'firmware_version')
  const firmwareVersion = typeof reportedFirmwareVersion === 'string' || typeof reportedFirmwareVersion === 'number'
    ? String(reportedFirmwareVersion)
    : '尚未上报'
  const tabs: { id: WorkbenchTab; label: string; icon: typeof Activity; count?: number }[] = [
    { id: 'remote', label: '遥测', icon: Activity },
    { id: 'events', label: '事件', icon: Bell, count: hmsActivities.length },
    { id: 'commands', label: '控制中心', icon: Command },
    { id: 'payload', label: '负载', icon: Box, count: payloadIndexes.length },
    { id: 'messages', label: 'MQTT 消息', icon: MessagesSquare, count: deviceRecords.length },
    { id: 'history', label: '最近指令', icon: Clock3, count: transactions.length },
  ]
  const configuredTabs = configured
    ? tabs.filter((tab) => (
        (tab.id !== 'commands' || gatewayCapabilities.deviceControl)
        && (tab.id !== 'payload' || gatewayCapabilities.payload)
      ))
    : tabs.filter((tab) => tab.id !== 'commands' && tab.id !== 'payload')
  const visibleTabs = deviceType === 'aircraft'
    ? configuredTabs.filter((tab) => tab.id === 'remote' || tab.id === 'messages')
    : deviceType === 'dock'
      ? configuredTabs
      : configuredTabs.filter((tab) => tab.id !== 'payload')
  const activeWorkbenchTab = visibleTabs.some((tab) => tab.id === activeTab) ? activeTab : 'remote'
  const supportsRemoteLogs = deviceType === 'dock' && gatewayCapabilities.remoteLogs
  const supportsFirmwareUpgrade = deviceType === 'dock' && gatewayCapabilities.firmwareUpgrade
  const effectiveControlCenterTab = (
    (activeControlCenterTab === 'logs' && !supportsRemoteLogs)
    || (activeControlCenterTab === 'firmware' && !supportsFirmwareUpgrade)
  ) ? 'controls' : activeControlCenterTab
  const renderTelemetryTable = (categoryFields: typeof fields) => {
    type TelemetryField = (typeof fields)[number]
    type TelemetryTreeNode = {
      segment: string
      path: string
      field?: TelemetryField
      children: Map<string, TelemetryTreeNode>
    }
    type TelemetryRenderEntry =
      | { kind: 'field'; field: TelemetryField }
      | { kind: 'array'; node: TelemetryTreeNode }
    type TelemetryRenderBlock =
      | { kind: 'fields'; key: string; fields: TelemetryField[] }
      | { kind: 'array'; key: string; node: TelemetryTreeNode }

    const sourceRoots = new Map<TelemetryField['source'], TelemetryTreeNode>()
    categoryFields.forEach((field) => {
      let node = sourceRoots.get(field.source)
      if (!node) {
        node = { segment: field.source, path: '', children: new Map() }
        sourceRoots.set(field.source, node)
      }

      field.path.split('.').forEach((segment, index, segments) => {
        const path = segments.slice(0, index + 1).join('.')
        let child = node?.children.get(segment)
        if (!child) {
          child = { segment, path, children: new Map() }
          node?.children.set(segment, child)
        }
        node = child
      })
      if (node) node.field = field
    })

    const isArrayNode = (node: TelemetryTreeNode): boolean =>
      node.children.size > 0
      && Array.from(node.children.keys()).every((segment) => /^\d+$/.test(segment))

    const descendantFieldCount = (node: TelemetryTreeNode): number =>
      (node.field ? 1 : 0)
      + Array.from(node.children.values()).reduce(
        (count, child) => count + descendantFieldCount(child),
        0,
      )

    const collectRenderEntries = (nodes: Iterable<TelemetryTreeNode>): TelemetryRenderEntry[] => {
      const entries: TelemetryRenderEntry[] = []
      Array.from(nodes).forEach((node) => {
        if (isArrayNode(node)) {
          entries.push({ kind: 'array', node })
          return
        }
        if (node.field) entries.push({ kind: 'field', field: node.field })
        entries.push(...collectRenderEntries(node.children.values()))
      })
      return entries
    }

    const createRenderBlocks = (entries: TelemetryRenderEntry[]): TelemetryRenderBlock[] => {
      const blocks: TelemetryRenderBlock[] = []
      entries.forEach((entry) => {
        if (entry.kind === 'array') {
          blocks.push({ kind: 'array', key: `array:${entry.node.path}`, node: entry.node })
          return
        }
        const previous = blocks.at(-1)
        if (previous?.kind === 'fields') {
          previous.fields.push(entry.field)
          return
        }
        blocks.push({
          kind: 'fields',
          key: `fields:${entry.field.source}:${entry.field.path}`,
          fields: [entry.field],
        })
      })
      return blocks
    }

    const renderTelemetryRow = (field: TelemetryField, context?: TelemetryArrayContext) => {
        const leaf = field.path.split('.').at(-1) ?? field.path
        const layoutField = layoutFieldsByKey.get(normalizeTelemetryFieldKey(field.path))
        const presentation = telemetryFieldPresentation(
          field.path,
          deviceType,
          usesDock2Metadata,
          context,
          layoutField,
          usesDock3Metadata,
          usesSuperDockMetadata,
        )
        const { label, description, unit, officialMetadata, metadataSourceLabel, propertyPath } = presentation
        const arrayItemIndex = context?.primitiveItem ? Number(leaf) : undefined
        const hasValue = field.value !== undefined && field.value !== null && field.value !== ''
        return (
          <div className="telemetry-row" key={`${field.source}:${field.path}`}>
            <div className="telemetry-field-label">
              <span className={arrayItemIndex !== undefined ? 'telemetry-index-badge' : undefined}>{label}</span>
              {(usesDock2Metadata || usesSuperDockMetadata || deviceType === 'aircraft' || officialMetadata || description) && (
                <FieldHelp
                  path={field.path}
                  metadata={officialMetadata}
                  sourceLabel={metadataSourceLabel}
                  displayLabel={label}
                  description={description}
                />
              )}
            </div>
            <div className="telemetry-field-value">
              <strong>
                {Array.isArray(field.value)
                  ? '空数组'
                  : field.value && typeof field.value === 'object' && !Object.keys(field.value).length
                    ? '空对象'
                    : officialMetadata ? formatDjiFieldValue(field.value, officialMetadata) : formatValue(field.value)}
                {!officialMetadata && unit && hasValue ? ` ${unit}` : ''}
              </strong>
              {officialMetadata?.accessMode === 'rw' && onPublish && (
                <Tooltip label={status === 'connected' && propertyGatewaySn ? `设置${label}` : '连接 MQTT 后可设置'}>
                  <button
                    type="button"
                    className="telemetry-property-set-button"
                    disabled={status !== 'connected' || busy || !propertyGatewaySn}
                    onClick={() => setPropertySetTarget({
                      path: propertyPath,
                      label,
                      value: field.value,
                      metadata: officialMetadata,
                      sourceLabel: metadataSourceLabel,
                    })}
                  >
                    <Pencil size={13} />
                  </button>
                </Tooltip>
              )}
            </div>
            <code><span className={`telemetry-source ${field.source}`}>{field.source.toUpperCase()}</span>{field.path}</code>
          </div>
        )
    }

    const renderArrayNode = (
      node: TelemetryTreeNode,
      source: TelemetryField['source'],
      depth: number,
      parentArrayPath?: string,
    ) => {
          const arrayLabelPath = node.path
            .split('.')
            .filter((segment) => !/^\d+$/.test(segment))
            .join('.')
          const arrayLeaf = arrayLabelPath.split('.').at(-1) ?? arrayLabelPath
          const relayedAircraftArray = deviceType === 'aircraft'
            && /^(drone_charge_state|drone_battery_maintenance_info)(\.|$)/.test(node.path)
          const dockArrayMetadata = relayedAircraftArray
            ? getDjiFieldMetadata(arrayLabelPath)
            : usesSuperDockMetadata
              ? getSuperDockFieldMetadata(arrayLabelPath)
              : usesDock3Metadata
                ? getDjiDock3FieldMetadata(arrayLabelPath)
                : usesDock2Metadata
                  ? getDjiFieldMetadata(arrayLabelPath)
                  : undefined
          const aircraftArrayMetadata = deviceType === 'aircraft' && !relayedAircraftArray
            ? getDjiAircraftFieldMetadata(arrayLabelPath)
            : undefined
          const arrayMetadata = dockArrayMetadata ?? aircraftArrayMetadata
          const arrayFallback = FIELD_LABELS[arrayLabelPath] ?? FIELD_LABELS[arrayLeaf]
          const arrayLayoutField = layoutFieldsByKey.get(normalizeTelemetryFieldKey(arrayLabelPath))
          const baselineArrayMetadata = relayedAircraftArray || deviceType === 'dock'
            ? getDjiFieldMetadata(arrayLabelPath)
            : deviceType === 'aircraft'
              ? getDjiAircraftFieldMetadata(arrayLabelPath)
              : undefined
          const arrayLayoutOverrides = telemetryLayoutOverrides(
            arrayLabelPath,
            arrayLayoutField,
            baselineArrayMetadata,
          )
          const arrayLabel = arrayLayoutOverrides.label || arrayMetadata?.label || arrayFallback?.label || arrayLeaf
          const arrayItems = Array.from(node.children.values())
            .sort((left, right) => Number(left.segment) - Number(right.segment))
          const primitiveArray = arrayItems.every((item) => item.field && !item.children.size)
          const fieldCount = descendantFieldCount(node)
          return (
            <details
              className="telemetry-array-collection"
              key={`${source}:${node.path}`}
              data-array-path={node.path}
              data-parent-array-path={parentArrayPath}
              data-array-depth={depth}
              open
            >
              <summary className="telemetry-array-header">
                <div>
                  <strong>
                    <Braces size={13} className="telemetry-array-icon" />
                    {arrayLabel}
                    <span className="telemetry-array-badge">数组</span>
                    {(arrayMetadata || arrayLayoutField?.description) && (
                      <FieldHelp
                        path={node.path}
                        metadata={arrayMetadata}
                        sourceLabel={usesSuperDockMetadata && dockArrayMetadata
                          ? `SuperDock 机场设备属性 · ${SUPERDOCK_PROPERTY_DOC_DATE}`
                          : usesDock3Metadata && dockArrayMetadata
                          ? `DJI Dock 3 设备属性 · ${DJI_DOCK3_PROPERTY_DOC_DATE}`
                          : dockArrayMetadata || usesDock2Metadata
                            ? `DJI Dock 2 设备属性 · ${DJI_DOCK2_PROPERTY_DOC_DATE}`
                            : `DJI 飞行器设备属性（通用字段） · ${DJI_AIRCRAFT_PROPERTY_DOC_DATE}`}
                        displayLabel={arrayLabel}
                        description={arrayLayoutOverrides.description || arrayMetadata?.description}
                      />
                    )}
                  </strong>
                  <code><span className={`telemetry-source ${source}`}>{source.toUpperCase()}</span>{node.path}</code>
                </div>
                <small>{arrayItems.length} 项 · {fieldCount} 个字段</small>
                <ChevronDown size={14} className="telemetry-array-chevron" />
              </summary>
              {primitiveArray ? (
                <div className="telemetry-field-grid telemetry-array-values">
                  {arrayItems.flatMap((item) => item.field
                    ? [renderTelemetryRow(item.field, telemetryArrayContext(item.field.path))]
                    : [])}
                </div>
              ) : (
                <div className="telemetry-array-items">
                  {arrayItems.map((item, index) => {
                    const itemIndex = Number(item.segment)
                    const itemEntries = collectRenderEntries(item.children.values())
                    if (item.field) itemEntries.unshift({ kind: 'field', field: item.field })
                    const itemBlocks = createRenderBlocks(itemEntries)
                    return (
                      <details className="telemetry-array-item" key={item.segment} open={index === 0}>
                        <summary>
                          <span className="telemetry-index-badge">[{itemIndex}]</span>
                          <span>第 {itemIndex + 1} 项</span>
                          <small>{descendantFieldCount(item)} 个字段</small>
                          <ChevronDown size={14} />
                        </summary>
                        <div className="telemetry-array-item-content">
                          {itemBlocks.map((block) => block.kind === 'fields'
                            ? (
                                <div className="telemetry-field-grid telemetry-array-values" key={block.key}>
                                  {block.fields.map((field) => renderTelemetryRow(field, telemetryArrayContext(field.path)))}
                                </div>
                              )
                            : renderArrayNode(block.node, source, depth + 1, node.path))}
                        </div>
                      </details>
                    )
                  })}
                </div>
              )}
            </details>
          )
    }

    return (
      <div className="telemetry-table">
        {Array.from(sourceRoots.entries()).flatMap(([source, root]) =>
          createRenderBlocks(collectRenderEntries(root.children.values())).map((block) => block.kind === 'fields'
            ? <div className="telemetry-field-grid" key={`${source}:${block.key}`}>{block.fields.map((field) => renderTelemetryRow(field))}</div>
            : renderArrayNode(block.node, source, 0)))}
      </div>
    )
  }
  const telemetryPanel = (
    <section className="telemetry-workspace">
      {searchableFields.length > 0 && (
        <header className="telemetry-search-toolbar">
          <div className="telemetry-search-box">
            <Search size={15} />
            <input
              type="search"
              value={telemetrySearch}
              aria-label="搜索遥测字段"
              placeholder="搜索名称或原始字段名"
              onChange={(event) => setTelemetrySearch(event.target.value)}
            />
            {telemetrySearch && (
              <button
                type="button"
                aria-label="清除遥测搜索"
                title="清除搜索"
                onClick={() => setTelemetrySearch('')}
              >
                <X size={14} />
              </button>
            )}
          </div>
          <span aria-live="polite">
            {telemetrySearchQuery
              ? `${filteredTelemetryFields.length}/${searchableFields.length} 个字段`
              : `${searchableFields.length} 个字段`}
          </span>
        </header>
      )}
      {telemetryTabs.length ? (
        <div className="telemetry-category-view">
          <nav
            className="telemetry-category-tabs"
            aria-label="遥测数据分类"
            aria-orientation="vertical"
            role="tablist"
          >
            {telemetryTabs.map((tab) => {
              const TabIcon = tab.icon
              const active = selectedTelemetryTab?.id === tab.id
              return (
                <button
                  key={tab.id}
                  className={active ? 'active' : ''}
                  id={`telemetry-tab-${tab.id}`}
                  role="tab"
                  aria-selected={active}
                  aria-controls={`telemetry-panel-${tab.id}`}
                  onClick={() => {
                    setActiveTelemetryTab(tab.id)
                    setActiveTelemetrySection(tab.sections[0]?.id)
                  }}
                >
                  <TabIcon size={15} />
                  <span>{tab.label}</span>
                  <small>{tab.fieldCount}</small>
                </button>
              )
            })}
          </nav>
          <div className="telemetry-category-panels" ref={telemetryPanelsRef}>
            {telemetryTabs.map((tab) => {
              const active = selectedTelemetryTab?.id === tab.id
              const activeSection = active
                ? tab.sections.find((section) => section.id === selectedTelemetrySection?.id) ?? tab.sections[0]
                : tab.sections[0]
              return (
                <section
                  className="telemetry-tab-panel"
                  id={`telemetry-panel-${tab.id}`}
                  key={tab.id}
                  role="tabpanel"
                  aria-labelledby={`telemetry-tab-${tab.id}`}
                  hidden={!active}
                >
                  <nav className="telemetry-section-tabs" aria-label={`${tab.label}二级分类`} role="tablist">
                    {tab.sections.map((section) => {
                      const SectionIcon = section.icon
                      const sectionActive = activeSection?.id === section.id
                      return (
                        <button
                          className={sectionActive ? 'active' : ''}
                          id={`telemetry-section-tab-${tab.id}-${section.id}`}
                          key={section.id}
                          role="tab"
                          aria-selected={sectionActive}
                          aria-controls={`telemetry-section-panel-${tab.id}-${section.id}`}
                          onClick={() => setActiveTelemetrySection(section.id)}
                        >
                          <SectionIcon size={14} />
                          <span>{section.label}</span>
                          <small>{section.fields.length}</small>
                        </button>
                      )
                    })}
                  </nav>
                  <div className="telemetry-section-panels">
                    {tab.sections.map((section) => {
                      const sectionActive = activeSection?.id === section.id
                      return (
                        <section
                          className="telemetry-section-panel"
                          id={`telemetry-section-panel-${tab.id}-${section.id}`}
                          key={section.id}
                          role="tabpanel"
                          aria-labelledby={`telemetry-section-tab-${tab.id}-${section.id}`}
                          hidden={!sectionActive}
                        >
                          <section className="telemetry-group">
                            {renderTelemetryTable(section.fields)}
                          </section>
                        </section>
                      )
                    })}
                  </div>
                </section>
              )
            })}
          </div>
        </div>
      ) : (
        <div className="panel-empty">
          {telemetrySearchQuery ? <Search size={24} /> : <Plane size={24} />}
          <span>
            {telemetrySearchQuery
              ? `未找到与“${telemetrySearchQuery}”匹配的遥测字段`
              : visibleFields.length
                ? '遥测字段已归入负载页面'
                : '订阅 OSD 或 state Topic 后显示设备字段'}
          </span>
        </div>
      )}
    </section>
  )
  const renderEventRows = (activities: typeof deviceActivities) => activities.map((activity) => {
    const { record } = activity
    return (
      <div className="event-row" key={record.id}>
        <div className="event-meta">
          <div className="event-title">
            <span className={`event-kind ${activity.kind}`}>{activity.kind === 'event' ? '事件' : '请求'}</span>
            <strong>{activity.label}</strong>
            <code>{activity.method}</code>
          </div>
          <span>{new Date(record.timestamp).toLocaleTimeString()}</span>
        </div>
        <code>{record.topic}</code>
        <pre>{prettyPayload(record.payload).slice(0, 360)}</pre>
      </div>
    )
  })
  const renderEventList = (activities: typeof deviceActivities, emptyText: string) => (
    <div className="event-list">
      {renderEventRows(activities.slice().reverse())}
      {!activities.length && <div className="panel-empty small"><Radio size={22} /><span>{emptyText}</span></div>}
    </div>
  )

  if (!deviceSn) {
    return (
      <div className="empty-workspace">
        <div className="empty-visual"><Radio size={38} /></div>
        <h2>等待设备配置</h2>
        <p>从左侧添加机场或飞机后，OSD、状态与指令响应会在这里聚合。</p>
      </div>
    )
  }

  return (
    <div className="overview-view">
      <section className="device-summary">
        <div className="device-summary-heading">
          <div className={`device-kind-icon ${deviceOnline ? 'online' : ''}`}><DeviceIcon size={24} /></div>
          <div className="device-summary-title">
            <span className="eyebrow">当前所选{typeMeta.label}</span>
            <h1>{configured?.name ?? selected?.name ?? deviceSn}</h1>
            <span className={`device-status-chip ${deviceOnline ? 'online' : 'offline'}`}>
              <span className="live-pulse" />{deviceStatus}
            </span>
          </div>
        </div>
        <div className="device-facts">
          <div><span>设备 SN</span><strong title={deviceSn}>{deviceSn}</strong></div>
          <div><span>设备厂商</span><strong>{providerName}</strong></div>
          <div><span>设备型号</span><strong title={productKey}>{deviceModel}</strong></div>
          <div><span>产品枚举</span><strong title={productKey}>{productKey ?? '尚未上报'}</strong></div>
          <div><span>物模型 / 通道</span><strong title={identityProtocol}>{identityProtocol}</strong></div>
          <div><span>固件版本</span><strong title={firmwareVersion}>{firmwareVersion}</strong></div>
          <div><span>最后上报</span><strong>{lastSeen}</strong></div>
        </div>
      </section>

      <section className="device-tab-region">
        <nav className="device-tabs" aria-label="设备功能">
          {visibleTabs.map((tab) => {
            const Icon = tab.icon
            return (
              <button key={tab.id} className={activeWorkbenchTab === tab.id ? 'active' : ''} onClick={() => setActiveTab(tab.id)}>
                <Icon size={16} /><span>{tab.label}</span>
                {tab.count !== undefined && <small>{tab.count}</small>}
              </button>
            )
          })}
        </nav>

        <div className={`device-tab-content ${activeWorkbenchTab}-tab`}>
          {activeWorkbenchTab === 'remote' && (
            <div className="remote-workspace">
              {telemetryPanel}
            </div>
          )}
          {activeWorkbenchTab === 'payload' && (
            <section className="payload-workspace">
              <div className="payload-dashboard">
                <section className="payload-info-panel">
                  <header className="event-workspace-header">
                    <div><Box size={17} /><h3>负载信息</h3></div>
                    <span>{latestPayloadActivity ? new Date(latestPayloadActivity.record.timestamp).toLocaleTimeString() : '尚未上报'}</span>
                  </header>
                  {payloadIndexes.length > 0 && (
                    <nav className="psdk-index-tabs" aria-label="PSDK 负载索引" role="tablist">
                      {payloadIndexes.map((index) => {
                        const active = activePsdkIndex === index
                        return (
                          <button
                            key={index}
                            className={active ? 'active' : ''}
                            role="tab"
                            aria-selected={active}
                            onClick={() => setSelectedPsdkIndex(index)}
                          >
                            PSDK {index}
                          </button>
                        )
                      })}
                    </nav>
                  )}
                  {latestPayloadActivity ? (
                    <div className="psdk-latest-report">
                      <div className="psdk-report-meta">
                        <span><small>上报方法</small><code>{latestPayloadActivity.method}</code></span>
                        <span><small>PSDK 索引</small><strong>{latestPayloadActivity.psdkIndex}</strong></span>
                        <span><small>数据长度</small><strong>{typeof latestPayloadValue === 'string' ? latestPayloadValue.length : 0} 字符</strong></span>
                      </div>
                      <div className="psdk-report-value">
                        <span>{latestPayloadValue === undefined ? 'data（原始字段）' : 'data.value（原始数据）'}</span>
                        <pre>{latestPayloadText || '（空数据）'}</pre>
                      </div>
                    </div>
                  ) : <div className="panel-empty small"><Box size={22} /><span>暂无 PSDK 负载上报</span></div>}
                </section>
                <section className="payload-event-panel">
                  <header className="event-workspace-header">
                    <div><Bell size={17} /><h3>PSDK 数据消息</h3></div>
                    <span>{selectedPayloadActivities.length} 条</span>
                  </header>
                  {renderEventList(selectedPayloadActivities, '暂无 PSDK 数据消息')}
                </section>
              </div>
            </section>
          )}
          {activeWorkbenchTab === 'events' && (
            <DeviceEventWorkspace activities={generalActivities} onNotify={onNotify} />
          )}
          {activeWorkbenchTab === 'history' && (
            <CommandHistory transactions={transactions} onNotify={onNotify} />
          )}
          {configured && gatewayCapabilities.deviceControl && <section className="control-center-workspace" hidden={activeWorkbenchTab !== 'commands'}>
            <nav className="control-center-tabs" aria-label="控制中心功能" role="tablist">
              <button className={effectiveControlCenterTab === 'controls' ? 'active' : ''} role="tab" aria-selected={effectiveControlCenterTab === 'controls'} onClick={() => setActiveControlCenterTab('controls')}><Command size={15} /><span>设备控制</span></button>
              {(supportsRemoteLogs || supportsFirmwareUpgrade) && (
                <>
                  {supportsRemoteLogs && (
                  <button className={effectiveControlCenterTab === 'logs' ? 'active' : ''} role="tab" aria-selected={effectiveControlCenterTab === 'logs'} onClick={() => setActiveControlCenterTab('logs')}><FileArchive size={15} /><span>远程日志</span></button>
                  )}
                  {supportsFirmwareUpgrade && (
                  <button className={effectiveControlCenterTab === 'firmware' ? 'active' : ''} role="tab" aria-selected={effectiveControlCenterTab === 'firmware'} onClick={() => setActiveControlCenterTab('firmware')}><Package size={15} /><span>固件升级</span></button>
                  )}
                </>
              )}
            </nav>
            <div className={`control-center-content ${effectiveControlCenterTab}`}>
              {onPublish && configured && (
                <div className="persistent-command-center" hidden={activeWorkbenchTab !== 'commands' || effectiveControlCenterTab !== 'controls'}>
                    <CommandCenter
                      profile={profile}
                      status={status}
                      busy={busy}
                      selectedDeviceSn={deviceSn}
                      telemetry={telemetry}
                      onPublish={onPublish}
                      onService={onService}
                      onNotify={onNotify}
                      allowedCategories={['debug', 'flight', 'payload']}
                      mediaServers={mediaServers}
                    />
                </div>
              )}
              {supportsRemoteLogs && effectiveControlCenterTab === 'logs' && onPublish && onNotify && onOpenOssManager && onSelectObjectStorage && (
                <RemoteLogCenter
                  profileId={profile.id}
                  gatewaySn={deviceSn}
                  status={status}
                  busy={busy}
                  records={records}
                  objectStorageProfiles={objectStorageProfiles}
                  activeObjectStorageId={activeObjectStorageId}
                  onSelectObjectStorage={onSelectObjectStorage}
                  onPublish={onPublish}
                  onNotify={onNotify}
                  onOpenOssManager={onOpenOssManager}
                />
              )}
              {supportsFirmwareUpgrade && effectiveControlCenterTab === 'firmware' && onService && onSelectObjectStorage && onOpenOssManager && (
                <FirmwareUpgradeCenter
                  profile={profile}
                  gatewaySn={deviceSn}
                  status={status}
                  busy={busy}
                  telemetry={telemetry}
                  records={records}
                  objectStorageProfiles={objectStorageProfiles}
                  activeObjectStorageId={activeObjectStorageId}
                  onSelectObjectStorage={onSelectObjectStorage}
                  onOpenOssManager={onOpenOssManager}
                  onService={onService}
                  onNotify={onNotify}
                />
              )}
            </div>
          </section>}
          {activeWorkbenchTab === 'messages' && onPublish && onExport && onClear && (
            <MqttConsole profile={profile} status={status} busy={busy} records={deviceRecords} selectedDeviceSn={deviceSn} onPublish={onPublish} onExport={onExport} onClear={onClear} />
          )}
        </div>
      </section>
      {propertySetTarget && propertyGatewaySn && onPublish && (
        <PropertySetModal
          target={propertySetTarget}
          gatewaySn={propertyGatewaySn}
          records={records}
          onClose={() => setPropertySetTarget(undefined)}
          onPublish={onPublish}
        />
      )}
    </div>
  )
}
