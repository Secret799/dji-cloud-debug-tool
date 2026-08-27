import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  Battery,
  Bell,
  Box,
  Braces,
  Camera,
  ChevronDown,
  CircleHelp,
  Clock3,
  Cloud,
  Command,
  Cpu,
  FileArchive,
  Gamepad2,
  MapPin,
  MessagesSquare,
  Plane,
  Pencil,
  Radio,
  RadioTower,
  Search,
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
  type CommandTransaction,
  type DeviceTelemetry,
  type ServiceCaller,
  djiProductKey,
  djiProductName,
  formatValue,
  groupDeviceActivities,
  isPayloadActivity,
  mergeNestedRecords,
  parseDeviceActivity,
  parseServicePayload,
  prettyPayload,
  telemetryValue,
} from '../lib/dji'
import { lookupServiceError } from '../lib/dji-error-codes'
import { CommandCenter } from './CommandCenter'
import { MqttConsole } from './MqttConsole'
import { RemoteLogCenter } from './RemoteLogCenter'
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
}

const MAX_TELEMETRY_FIELDS = 500

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

export function CommandHistory({ transactions }: { transactions: CommandTransaction[] }) {
  return (
    <section className="history-workspace">
      <div className="work-panel command-history-panel">
        <header className="panel-header"><div><Clock3 size={16} /><h3>最近指令</h3></div><span>{transactions.length} 条</span></header>
        <div className="command-history-list">
          {transactions.slice(0, 50).map((transaction) => {
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
                    <div><dt>结果码</dt><dd>{transaction.result ?? '--'}</dd></div>
                    <div><dt>发送时间</dt><dd>{new Date(transaction.startedAt).toLocaleString()}</dd></div>
                  </dl>
                  {errorGuidance && (
                    <section className="command-error-guidance">
                      <header><Wrench size={15} /><strong>错误码 {transaction.result} 排障建议</strong>{errorGuidance.hmsCode && <code>{errorGuidance.hmsCode}</code>}</header>
                      <div>
                        <span><small>错误说明</small><p>{errorGuidance.message ?? '错误码库暂未收录该错误的详细说明。'}</p></span>
                        {errorGuidance.cause && <span><small>可能原因</small><p>{errorGuidance.cause}</p></span>}
                        <span className="resolution"><small>处理措施</small><p>{errorGuidance.solution ?? '暂无明确处理措施，请结合返回报文并收集设备日志进一步定位。'}</p></span>
                        {errorGuidance.logs && <span><small>建议日志</small><p>{errorGuidance.logs}</p></span>}
                      </div>
                    </section>
                  )}
                  <div className="command-message-pair">
                    <section className="command-message request">
                      <header><span><ArrowUpRight size={14} />发送信息</span><time>{new Date(transaction.request.timestamp).toLocaleTimeString()}</time></header>
                      <div className="command-message-topic"><span>Topic</span><code>{transaction.request.topic}</code></div>
                      <pre>{prettyPayload(transaction.request.payload)}</pre>
                    </section>
                    <section className={`command-message response ${transaction.response ? '' : 'empty'}`}>
                      <header><span><ArrowDownLeft size={14} />返回信息</span>{transaction.response && <time>{new Date(transaction.response.timestamp).toLocaleTimeString()}</time>}</header>
                      {transaction.response ? (
                        <>
                          <div className="command-message-topic"><span>Topic</span><code>{transaction.response.topic}</code></div>
                          <pre>{prettyPayload(transaction.response.payload)}</pre>
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
    </section>
  )
}

type WorkbenchTab = 'remote' | 'payload' | 'events' | 'logs' | 'history' | 'commands' | 'messages'

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

const telemetryFieldPresentation = (
  path: string,
  deviceType?: DeviceType,
  usesDock2Metadata = false,
  context = telemetryArrayContext(path),
  layoutField?: TelemetryLayoutField,
  usesDock3Metadata = false,
): TelemetryFieldPresentation => {
  const leaf = path.split('.').at(-1) ?? path
  const relayedAircraftField = deviceType === 'aircraft'
    && /^(drone_charge_state|drone_battery_maintenance_info)(\.|$)/.test(path)
  const relayedAircraftIdentityField = deviceType === 'aircraft'
    && /^(device_sn|device_model_key|device_online_status|device_paired)$/.test(path)
  const metadataPath = relayedAircraftIdentityField ? `sub_device.${path}` : path
  const dockMetadata = relayedAircraftField || relayedAircraftIdentityField
    ? getDjiFieldMetadata(metadataPath)
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
  const arrayItemIndex = context?.primitiveItem ? Number(leaf) : undefined
  return {
    label: arrayItemIndex !== undefined
      ? `[${arrayItemIndex}]`
      : layoutField?.label || contextualLabel || officialMetadata?.label || fallbackMetadata?.label || leaf,
    description: layoutField?.description || officialMetadata?.description,
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
}: OverviewProps) {
  const [activeTab, setActiveTab] = useState<WorkbenchTab>('remote')
  const [activeTelemetryTab, setActiveTelemetryTab] = useState<TelemetryTabId>('operation')
  const [activeTelemetrySection, setActiveTelemetrySection] = useState<TelemetrySectionId>()
  const [telemetrySearch, setTelemetrySearch] = useState('')
  const [selectedPsdkIndex, setSelectedPsdkIndex] = useState<number>()
  const [expandedEventGroups, setExpandedEventGroups] = useState<Record<string, boolean>>({})
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
  const usesDock2Metadata = deviceType === 'dock'
    && (topologyProductKey
      ? topologyProductKey === '3-2-0'
      : Boolean(configured) && (configured?.dockModel ?? 'dock2') === 'dock2')
  const usesDock3Metadata = deviceType === 'dock'
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
  useEffect(() => setExpandedEventGroups({}), [deviceSn])
  const deviceRecords = records.filter((record) => !deviceSn || record.topic.includes(`/${deviceSn}/`))
  const deviceActivities = deviceRecords.flatMap((record) => {
    const activity = parseDeviceActivity(record)
    return activity ? [activity] : []
  })
  const payloadGatewaySn = deviceType === 'aircraft' ? selected?.gatewaySn ?? configured?.parentSn : undefined
  const propertyGatewaySn = deviceType === 'aircraft' ? payloadGatewaySn : deviceSn
  const payloadRecords = payloadGatewaySn
    ? records.filter((record) => record.topic.includes(`/${payloadGatewaySn}/`))
    : []
  const payloadActivities = payloadRecords.flatMap((record) => {
    const activity = parseDeviceActivity(record)
    return activity && isPayloadActivity(activity) ? [activity] : []
  })
  const generalActivities = deviceActivities.filter((activity) => !isPayloadActivity(activity))
  const groupedGeneralActivities = groupDeviceActivities(generalActivities)
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
  const configuredDockModel = configured?.dockModel === 'dock3'
    ? 'DJI Dock 3'
    : (configured?.dockModel ?? 'dock2') === 'dock2'
      ? 'DJI Dock 2'
      : typeMeta.model
  const deviceModel = djiProductName(selected?.identity)
    ?? (productKey ? DJI_PRODUCT_NAMES[productKey] : undefined)
    ?? (deviceType === 'aircraft' ? '飞机型号待识别' : configured?.type === 'dock' ? configuredDockModel : typeMeta.model)
  const identityProtocol = selected?.identity
    ? [selected.identity.thingVersion ? `v${selected.identity.thingVersion}` : undefined, selected.identity.channelIndex ? `通道 ${selected.identity.channelIndex}` : undefined]
      .filter(Boolean)
      .join(' / ') || '尚未上报'
    : '尚未上报'
  const lastSeen = selected?.lastSeenAt
    ? `${Math.max(0, Math.round((Date.now() - selected.lastSeenAt) / 1000))} 秒前`
    : '尚未上报'
  const reportedFirmwareVersion = telemetryValue(source, 'firmware_version')
  const firmwareVersion = typeof reportedFirmwareVersion === 'string' || typeof reportedFirmwareVersion === 'number'
    ? String(reportedFirmwareVersion)
    : '尚未上报'
  const tabs: { id: WorkbenchTab; label: string; icon: typeof Activity; count?: number }[] = [
    { id: 'remote', label: '遥测', icon: Activity },
    { id: 'payload', label: '负载', icon: Box, count: payloadIndexes.length },
    { id: 'events', label: '事件', icon: Bell, count: generalActivities.length },
    { id: 'logs', label: '远程日志', icon: FileArchive },
    { id: 'commands', label: '控制中心', icon: Command },
    { id: 'messages', label: 'MQTT 消息', icon: MessagesSquare, count: deviceRecords.length },
    { id: 'history', label: '最近指令', icon: Clock3, count: transactions.length },
  ]
  const visibleTabs = deviceType === 'aircraft'
    ? tabs.filter((tab) => tab.id !== 'events' && tab.id !== 'logs' && tab.id !== 'history' && tab.id !== 'commands')
    : tabs.filter((tab) => tab.id !== 'payload')
  const activeWorkbenchTab = visibleTabs.some((tab) => tab.id === activeTab) ? activeTab : 'remote'
  const renderTelemetryTable = (categoryFields: typeof fields) => {
    type TelemetryField = (typeof fields)[number]
    type TelemetryRenderGroup = {
      key: string
      matchKey: string
      context?: TelemetryArrayContext
      fields: TelemetryField[]
    }
    const renderGroups: TelemetryRenderGroup[] = []

    categoryFields.forEach((field) => {
      const context = telemetryArrayContext(field.path)
      const matchKey = context ? `array:${field.source}:${context.arrayPath}` : `fields:${field.source}`
      const previous = renderGroups.at(-1)
      if (previous?.matchKey === matchKey) {
        previous.fields.push(field)
      } else {
        renderGroups.push({
          key: `${matchKey}:${field.path}`,
          matchKey,
          context,
          fields: [field],
        })
      }
    })

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
        )
        const { label, description, unit, officialMetadata, metadataSourceLabel, propertyPath } = presentation
        const arrayItemIndex = context?.primitiveItem ? Number(leaf) : undefined
        const hasValue = field.value !== undefined && field.value !== null && field.value !== ''
        return (
          <div className="telemetry-row" key={`${field.source}:${field.path}`}>
            <div className="telemetry-field-label">
              <span className={arrayItemIndex !== undefined ? 'telemetry-index-badge' : undefined}>{label}</span>
              {(usesDock2Metadata || deviceType === 'aircraft' || officialMetadata || description) && (
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

    return (
      <div className="telemetry-table">
        {renderGroups.map((group) => {
          if (!group.context) {
            return <div className="telemetry-field-grid" key={group.key}>{group.fields.map((field) => renderTelemetryRow(field))}</div>
          }

          const arrayLabelPath = group.context.arrayPath
            .split('.')
            .filter((segment) => !/^\d+$/.test(segment))
            .join('.')
          const arrayLeaf = arrayLabelPath.split('.').at(-1) ?? arrayLabelPath
          const relayedAircraftArray = deviceType === 'aircraft'
            && /^(drone_charge_state|drone_battery_maintenance_info)(\.|$)/.test(group.context.arrayPath)
          const dockArrayMetadata = relayedAircraftArray
            ? getDjiFieldMetadata(arrayLabelPath)
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
          const arrayLabel = arrayLayoutField?.label || arrayMetadata?.label || arrayFallback?.label || arrayLeaf
          const primitiveArray = group.context.primitiveItem
          const arrayItems = primitiveArray
            ? []
            : Array.from(group.fields.reduce((items, field) => {
                const itemIndex = telemetryArrayContext(field.path)?.itemIndex
                if (itemIndex === undefined) return items
                const itemFields = items.get(itemIndex) ?? []
                itemFields.push(field)
                items.set(itemIndex, itemFields)
                return items
              }, new Map<number, TelemetryField[]>()))
              .sort(([left], [right]) => left - right)
          return (
            <details className="telemetry-array-collection" key={group.key} data-array-path={group.context.arrayPath} open>
              <summary className="telemetry-array-header">
                <div>
                  <strong>
                    <Braces size={13} className="telemetry-array-icon" />
                    {arrayLabel}
                    <span className="telemetry-array-badge">数组</span>
                    {(arrayMetadata || arrayLayoutField?.description) && (
                      <FieldHelp
                        path={group.context.arrayPath}
                        metadata={arrayMetadata}
                        sourceLabel={usesDock3Metadata && dockArrayMetadata
                          ? `DJI Dock 3 设备属性 · ${DJI_DOCK3_PROPERTY_DOC_DATE}`
                          : dockArrayMetadata || usesDock2Metadata
                            ? `DJI Dock 2 设备属性 · ${DJI_DOCK2_PROPERTY_DOC_DATE}`
                            : `DJI 飞行器设备属性（通用字段） · ${DJI_AIRCRAFT_PROPERTY_DOC_DATE}`}
                        displayLabel={arrayLabel}
                        description={arrayLayoutField?.description || arrayMetadata?.description}
                      />
                    )}
                  </strong>
                  <code><span className={`telemetry-source ${group.fields[0].source}`}>{group.fields[0].source.toUpperCase()}</span>{group.context.arrayPath}</code>
                </div>
                <small>{primitiveArray ? group.fields.length : arrayItems.length} 项 · {group.fields.length} 个字段</small>
                <ChevronDown size={14} className="telemetry-array-chevron" />
              </summary>
              {primitiveArray ? (
                <div className="telemetry-field-grid telemetry-array-values">
                  {group.fields.map((field) => renderTelemetryRow(field, telemetryArrayContext(field.path)))}
                </div>
              ) : (
                <div className="telemetry-array-items">
                  {arrayItems.map(([itemIndex, itemFields], index) => (
                    <details className="telemetry-array-item" key={itemIndex} open={index === 0}>
                      <summary>
                        <span className="telemetry-index-badge">[{itemIndex}]</span>
                        <span>第 {itemIndex + 1} 项</span>
                        <small>{itemFields.length} 个字段</small>
                        <ChevronDown size={14} />
                      </summary>
                      <div className="telemetry-field-grid telemetry-array-values">
                        {itemFields.map((field) => renderTelemetryRow(field, telemetryArrayContext(field.path)))}
                      </div>
                    </details>
                  ))}
                </div>
              )}
            </details>
          )
        })}
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
  const renderEventRows = (activities: typeof deviceActivities, grouped = false) => activities.map((activity) => {
    const { record } = activity
    return (
      <div className="event-row" key={record.id}>
        {grouped ? (
          <div className="event-meta grouped-event-meta">
            <code title={record.topic}>{record.topic}</code>
            <span>{new Date(record.timestamp).toLocaleTimeString()}</span>
          </div>
        ) : (
          <>
            <div className="event-meta">
              <div className="event-title">
                <span className={`event-kind ${activity.kind}`}>{activity.kind === 'event' ? '事件' : '请求'}</span>
                <strong>{activity.label}</strong>
                <code>{activity.method}</code>
              </div>
              <span>{new Date(record.timestamp).toLocaleTimeString()}</span>
            </div>
            <code>{record.topic}</code>
          </>
        )}
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
  const renderGroupedEventList = () => groupedGeneralActivities.length ? (
    <div className="event-group-list">
      {groupedGeneralActivities.map((group, index) => (
        <details
          className="event-message-group"
          key={group.id}
          open={expandedEventGroups[group.id] ?? index === 0}
          onToggle={(event) => {
            const open = event.currentTarget.open
            setExpandedEventGroups((current) => current[group.id] === open
              ? current
              : { ...current, [group.id]: open })
          }}
        >
          <summary>
            <span className="event-group-chevron"><ChevronDown size={14} /></span>
            <span className={`event-kind ${group.kind}`}>{group.kind === 'event' ? '事件' : '请求'}</span>
            <span className="event-group-copy">
              <strong>{group.label}</strong>
              <code>{group.method}</code>
            </span>
            <span className="event-group-latest">最近 {new Date(group.latestAt).toLocaleTimeString()}</span>
            <small>{group.activities.length} 条</small>
          </summary>
          <div className="event-list grouped-event-list">
            {renderEventRows(group.activities, true)}
          </div>
        </details>
      ))}
    </div>
  ) : <div className="panel-empty small"><Radio size={22} /><span>暂无设备事件或请求</span></div>

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
          <div><span>设备状态</span><strong className={deviceOnline ? 'online-text' : 'offline-text'}>{deviceStatus}</strong></div>
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
            <section className="event-workspace">
              <header className="event-workspace-header"><div><Bell size={17} /><h3>设备事件</h3></div><span>{groupedGeneralActivities.length} 种类型 · 共 {generalActivities.length} 条</span></header>
              {renderGroupedEventList()}
            </section>
          )}
          {activeWorkbenchTab === 'logs' && onPublish && onNotify && onOpenOssManager && onSelectObjectStorage && (
            <RemoteLogCenter
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
          {activeWorkbenchTab === 'history' && (
            <CommandHistory transactions={transactions} />
          )}
          {onPublish && (
            <div className="persistent-command-center" hidden={activeWorkbenchTab !== 'commands'}>
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
              />
            </div>
          )}
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
