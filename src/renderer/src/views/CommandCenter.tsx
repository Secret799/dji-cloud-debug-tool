import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  Battery,
  BatteryCharging,
  BellRing,
  Box,
  Camera,
  ChevronDown,
  Database,
  Dock,
  Gamepad2,
  Lightbulb,
  LockKeyhole,
  MapPin,
  Plane,
  Power,
  Radio,
  RotateCcw,
  Send,
  Snowflake,
  Speaker,
  Wifi,
} from 'lucide-react'
import type { ConnectionProfile, ConnectionStatus, MediaServerProfile, MqttQos, OperationResult } from '../../../shared/contracts'
import {
  buildServicePayload,
  DJI_COMMANDS,
  mergeNestedRecords,
  parseServicePayload,
  refreshServicePayload,
  serviceMethodFromPayload,
  telemetryValue,
  type CommandTemplate,
  type DeviceTelemetry,
  type ServiceCaller,
} from '../lib/dji'
import { CameraCenter } from './CameraCenter'

interface CommandCenterProps {
  profile: ConnectionProfile
  status: ConnectionStatus
  busy: boolean
  selectedDeviceSn: string
  telemetry?: DeviceTelemetry[]
  onPublish: (topic: string, payload: string, qos: MqttQos, retain: boolean) => Promise<OperationResult>
  onService?: ServiceCaller
  onNotify?: (text: string, tone?: 'info' | 'success' | 'error') => void
  allowedCategories?: CommandTemplate['category'][]
  defaultPsdkIndex?: number
  showCategoryBar?: boolean
  mediaServers?: MediaServerProfile[]
}

const categories: { id: CommandTemplate['category']; label: string; icon: typeof Gamepad2 }[] = [
  { id: 'debug', label: '远程调试', icon: Gamepad2 },
  { id: 'flight', label: '飞行控制', icon: Plane },
  { id: 'payload', label: '相机与云台', icon: Camera },
  { id: 'psdk', label: 'PSDK 数据', icon: Box },
  { id: 'speaker', label: '喊话器', icon: Speaker },
] as const

const numericState = (value: unknown): number | undefined => {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(number) ? number : undefined
}

const commandById = (id: string | undefined): CommandTemplate | undefined =>
  id ? DJI_COMMANDS.find((command) => command.id === id) : undefined

const recordArray = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : []

const AIR_CONDITIONER_STATE_LABELS: Record<number, string> = {
  0: '空闲模式',
  1: '制冷模式',
  2: '制热模式',
  3: '除湿模式',
  4: '制冷退出中',
  5: '制热退出中',
  6: '除湿退出中',
  7: '制冷准备中',
  8: '制热准备中',
  9: '除湿准备中',
  10: '风冷准备中',
  11: '风冷中',
  12: '风冷退出中',
  13: '除雾准备中',
  14: '除雾中',
  15: '除雾退出中',
}

const OPERATOR_LABELS: Record<number, string> = { 1: '移动', 2: '联通', 3: '电信' }

interface DebugOperationCardProps {
  icon: ReactNode
  label: string
  status: string
  locked: boolean
  className?: string
  children: ReactNode
}

function DebugOperationCard({ icon, label, status, locked, className = '', children }: DebugOperationCardProps) {
  return (
    <article className={['debug-operation-card', className, locked ? 'locked' : ''].filter(Boolean).join(' ')}>
      <header>
        <span className="debug-operation-icon">{icon}</span>
        <div><span>{label}</span><strong>{status}</strong></div>
      </header>
      {children}
    </article>
  )
}

export function CommandCenter({
  profile,
  status,
  busy,
  selectedDeviceSn,
  telemetry = [],
  onPublish,
  onService,
  onNotify,
  allowedCategories,
  defaultPsdkIndex,
  showCategoryBar = true,
  mediaServers = [],
}: CommandCenterProps) {
  const availableCategories = useMemo(
    () => categories.filter((item) => !allowedCategories || allowedCategories.includes(item.id)),
    [allowedCategories],
  )
  const [category, setCategory] = useState<CommandTemplate['category']>(availableCategories[0]?.id ?? 'debug')
  const commands = useMemo(
    () => DJI_COMMANDS.filter((command) => (
      command.category === category
      && (category !== 'flight' || (command.id !== 'flight-authority-grab' && command.id !== 'flight-authority-release'))
      && (category !== 'debug' || (command.id !== 'debug-open' && command.id !== 'debug-close'))
    )),
    [category],
  )
  const [selectedCommandId, setSelectedCommandId] = useState(commands[0]?.id ?? '')
  const selectedCommand = commands.find((command) => command.id === selectedCommandId) ?? commands[0]
  const [payload, setPayload] = useState(selectedCommand ? buildServicePayload(selectedCommand.method, selectedCommand.data) : '{}')
  const [sending, setSending] = useState(false)
  const [quickSendingCommandId, setQuickSendingCommandId] = useState('')
  const [selectedMediaServerId, setSelectedMediaServerId] = useState('')
  const [airConditionerTarget, setAirConditionerTarget] = useState(0)
  const [operatorTargets, setOperatorTargets] = useState<Record<string, number>>({})
  const [calibrationSn, setCalibrationSn] = useState('')
  const [calibrationModule, setCalibrationModule] = useState('3')
  const [calibrationLongitude, setCalibrationLongitude] = useState('')
  const [calibrationLatitude, setCalibrationLatitude] = useState('')
  const [calibrationHeight, setCalibrationHeight] = useState('')

  const commandData = (command: CommandTemplate): Record<string, unknown> =>
    defaultPsdkIndex !== undefined && (command.category === 'psdk' || command.category === 'speaker')
      ? { ...command.data, psdk_index: defaultPsdkIndex }
      : command.data

  const gatewayDevices = useMemo(
    () => profile.devices.filter((device) => device.type === 'dock' || device.type === 'pilot'),
    [profile.devices],
  )
  const selectedDevice = profile.devices.find((device) => device.sn === selectedDeviceSn)
  const contextualGatewaySn = selectedDevice?.type === 'dock' || selectedDevice?.type === 'pilot'
    ? selectedDevice.sn
    : selectedDevice?.parentSn && gatewayDevices.some((device) => device.sn === selectedDevice.parentSn)
      ? selectedDevice.parentSn
      : gatewayDevices.length === 1
        ? gatewayDevices[0].sn
        : ''
  const [gatewaySn, setGatewaySn] = useState(contextualGatewaySn || gatewayDevices[0]?.sn || '')
  const needsGatewaySelection = !contextualGatewaySn && gatewayDevices.length > 1
  const gatewayTelemetry = telemetry.find((device) => device.sn === gatewaySn)
  const configuredAircraft = profile.devices.find((device) => device.type === 'aircraft' && device.parentSn === gatewaySn)
  const relatedAircraftTelemetry = telemetry.find((device) =>
    device.type === 'aircraft'
    && device.sn === selectedDeviceSn
    && (device.gatewaySn === gatewaySn || selectedDevice?.parentSn === gatewaySn),
  ) ?? telemetry.find((device) =>
    device.type === 'aircraft'
    && (device.gatewaySn === gatewaySn || device.sn === configuredAircraft?.sn),
  )
  const gatewayTelemetrySource = useMemo(
    () => mergeNestedRecords(gatewayTelemetry?.status ?? {}, gatewayTelemetry?.state ?? {}, gatewayTelemetry?.osd ?? {}),
    [gatewayTelemetry],
  )
  const aircraftTelemetrySource = useMemo(
    () => mergeNestedRecords(
      relatedAircraftTelemetry?.status ?? {},
      relatedAircraftTelemetry?.state ?? {},
      relatedAircraftTelemetry?.osd ?? {},
    ),
    [relatedAircraftTelemetry],
  )
  const modeCode = numericState(telemetryValue(gatewayTelemetrySource, 'mode_code'))
  const coverState = numericState(telemetryValue(gatewayTelemetrySource, 'cover_state'))
  const chargeState = numericState(
    telemetryValue(aircraftTelemetrySource, 'drone_charge_state.state')
    ?? telemetryValue(gatewayTelemetrySource, 'drone_charge_state.state'),
  )
  const aircraftPowerState = numericState(telemetryValue(aircraftTelemetrySource, 'device_online_status'))
  const supplementLightState = numericState(telemetryValue(gatewayTelemetrySource, 'supplement_light_state'))
  const alarmState = numericState(telemetryValue(gatewayTelemetrySource, 'alarm_state'))
  const batteryStoreMode = numericState(telemetryValue(gatewayTelemetrySource, 'battery_store_mode'))
  const airConditionerState = numericState(telemetryValue(gatewayTelemetrySource, 'air_conditioner.air_conditioner_state'))
  const airConditionerSwitchTime = numericState(telemetryValue(gatewayTelemetrySource, 'air_conditioner.switch_time')) ?? 0
  const linkWorkmode = numericState(telemetryValue(gatewayTelemetrySource, 'wireless_link.link_workmode'))
  const batteryMaintenanceState = numericState(
    telemetryValue(gatewayTelemetrySource, 'drone_battery_maintenance_info.maintenance_state')
    ?? telemetryValue(aircraftTelemetrySource, 'drone_battery_maintenance_info.maintenance_state'),
  )
  const dockLongitude = numericState(telemetryValue(gatewayTelemetrySource, 'longitude'))
  const dockLatitude = numericState(telemetryValue(gatewayTelemetrySource, 'latitude'))
  const dockHeight = numericState(telemetryValue(gatewayTelemetrySource, 'height'))
  const drcState = numericState(telemetryValue(gatewayTelemetrySource, 'drc_state'))
  const rawControlSource = telemetryValue(aircraftTelemetrySource, 'control_source')
  const controlSource = typeof rawControlSource === 'string' && rawControlSource.trim() ? rawControlSource.trim() : ''
  const remoteDebugActive = modeCode === 2
  const flightAuthorityActive = drcState === 2
  const debugModeStateLabel = modeCode === 2
    ? '远程调试中'
    : modeCode === 1
      ? '现场调试中'
      : modeCode === 3
        ? '固件升级中'
        : modeCode === 4
          ? '作业中'
          : modeCode === 5
            ? '待标定'
            : modeCode === 0
              ? '未进入远程调试'
              : '状态未知'
  const debugModeCommand = commandById(remoteDebugActive ? 'debug-close' : 'debug-open')
  const coverStateLabel = coverState === 0
    ? '已关闭'
    : coverState === 1
      ? '已打开'
      : coverState === 2
        ? '半开状态'
        : coverState === 3
          ? '状态异常'
          : '状态未知'
  const coverCommand = commandById(coverState === 0
    ? 'cover-open'
    : coverState === 1
      ? 'cover-close'
      : coverState === 2 || coverState === 3
        ? 'cover-force-close'
        : undefined)
  const chargeStateLabel = chargeState === 0 ? '未充电' : chargeState === 1 ? '充电中' : '状态未知'
  const chargeCommand = commandById(chargeState === 0 ? 'charge-open' : chargeState === 1 ? 'charge-close' : undefined)
  const aircraftPowerStateLabel = aircraftPowerState === 0 ? '已关机' : aircraftPowerState === 1 ? '已开机' : '状态未知'
  const aircraftPowerCommand = commandById(aircraftPowerState === 0
    ? 'drone-open'
    : aircraftPowerState === 1
      ? 'drone-close'
      : undefined)
  const supplementLightCommand = commandById(supplementLightState === 0
    ? 'supplement-light-open'
    : supplementLightState === 1
      ? 'supplement-light-close'
      : undefined)
  const supplementLightStateLabel = supplementLightState === 0 ? '已关闭' : supplementLightState === 1 ? '已打开' : '状态未知'
  const alarmStateLabel = alarmState === 0 ? '已关闭' : alarmState === 1 ? '已开启' : '状态未知'
  const batteryStoreModeLabel = batteryStoreMode === 1 ? '计划模式' : batteryStoreMode === 2 ? '待命模式' : '状态未知'
  const linkWorkmodeLabel = linkWorkmode === 0 ? '仅 SDR' : linkWorkmode === 1 ? '4G 增强' : '状态未知'
  const batteryMaintenanceStateLabel = batteryMaintenanceState === 0
    ? '无需保养'
    : batteryMaintenanceState === 1
      ? '待保养'
      : batteryMaintenanceState === 2
        ? '正在保养'
        : '状态未知'
  const airConditionerStateLabel = airConditionerState === undefined
    ? '状态未知'
    : AIR_CONDITIONER_STATE_LABELS[airConditionerState] ?? `状态 ${airConditionerState}`
  const dongles = useMemo(() => {
    const byImei = new Map<string, {
      key: string
      imei: string
      deviceType: 'dock' | 'drone'
      label: string
      activateState?: number
      simSlot?: number
      operator?: number
    }>()
    const collect = (items: Record<string, unknown>[], deviceType: 'dock' | 'drone', label: string) => {
      items.forEach((item, index) => {
        const imei = typeof item.imei === 'string' ? item.imei.trim() : ''
        if (!imei) return
        const enabledOperator = recordArray(item.esim_infos).find((info) => info.enabled === true || info.enabled === 1)
        const key = `${deviceType}:${imei}`
        byImei.set(key, {
          key,
          imei,
          deviceType,
          label: `${label}${items.length > 1 ? ` ${index + 1}` : ''}`,
          activateState: numericState(item.esim_activate_state),
          simSlot: numericState(item.sim_slot),
          operator: numericState(enabledOperator?.telecom_operator),
        })
      })
    }
    collect(recordArray(telemetryValue(gatewayTelemetrySource, 'dongle_infos')), 'dock', '机场 Dongle')
    const aircraftDongles = recordArray(telemetryValue(aircraftTelemetrySource, 'dongle_infos'))
    const nestedAircraftDongles = recordArray(telemetryValue(gatewayTelemetrySource, 'sub_device.dongle_infos'))
    collect(aircraftDongles.length ? aircraftDongles : nestedAircraftDongles, 'drone', '飞行器 Dongle')
    return [...byImei.values()]
  }, [aircraftTelemetrySource, gatewayTelemetrySource])
  const flightAuthorityStateLabel = drcState === 2
    ? '已获取控制权'
    : drcState === 1
      ? '控制链路连接中'
      : drcState === 0
        ? '未获取控制权'
        : '状态未知'
  const flightAuthorityCommand = commandById(flightAuthorityActive ? 'flight-authority-release' : 'flight-authority-grab')
  const payloadMethod = serviceMethodFromPayload(payload)
  const payloadCommand = DJI_COMMANDS.find((command) => command.method === payloadMethod)
  const payloadDanger = Boolean(payloadCommand?.danger)
  const selectedMediaServer = mediaServers.find((server) => server.id === selectedMediaServerId)
    ?? mediaServers.find((server) => server.isDefault)
    ?? mediaServers[0]

  useEffect(() => {
    setGatewaySn(contextualGatewaySn || gatewayDevices[0]?.sn || '')
  }, [selectedDeviceSn, profile.id, contextualGatewaySn, gatewayDevices])

  useEffect(() => {
    setCalibrationSn(gatewaySn)
    setCalibrationModule('3')
    setCalibrationLongitude(dockLongitude === undefined ? '' : String(dockLongitude))
    setCalibrationLatitude(dockLatitude === undefined ? '' : String(dockLatitude))
    setCalibrationHeight(dockHeight === undefined ? '' : String(dockHeight))
  }, [gatewaySn])

  useEffect(() => {
    const firstCategory = availableCategories[0]?.id
    if (firstCategory && !availableCategories.some((item) => item.id === category)) setCategory(firstCategory)
  }, [availableCategories, category])

  useEffect(() => {
    const first = commands[0]
    if (first && !commands.some((command) => command.id === selectedCommandId)) setSelectedCommandId(first.id)
  }, [commands, selectedCommandId])

  useEffect(() => {
    if (selectedCommand) setPayload(buildServicePayload(selectedCommand.method, commandData(selectedCommand)))
  }, [selectedCommand?.id, defaultPsdkIndex])

  const chooseCommand = (command: CommandTemplate): void => {
    setSelectedCommandId(command.id)
    setPayload(buildServicePayload(command.method, commandData(command)))
  }

  const send = async (): Promise<void> => {
    if (!gatewaySn) {
      onNotify?.('请先选择网关设备', 'error')
      return
    }
    const parsed = parseServicePayload(payload)
    if (!parsed) {
      onNotify?.('请求体不是有效 JSON 对象', 'error')
      return
    }
    const method = typeof parsed.method === 'string' ? parsed.method.trim() : ''
    if (!method) {
      onNotify?.('请求体 method 不能为空', 'error')
      return
    }
    const actualCommand = DJI_COMMANDS.find((command) => command.method === method)
    if (actualCommand?.requiresDebug && !remoteDebugActive) {
      onNotify?.('请先进入远程调试模式', 'error')
      return
    }
    if (category === 'flight' && !flightAuthorityActive) {
      onNotify?.('请先获取飞行控制权', 'error')
      return
    }
    if (actualCommand?.danger) {
      if (!window.confirm(`确认执行“${actualCommand.label}”？请确保现场环境安全。`)) return
    } else if (!actualCommand && !window.confirm(`即将发送未识别的自定义指令“${method}”，确认继续？`)) {
      return
    }

    setSending(true)
    try {
      const response = await onPublish(`thing/product/${gatewaySn}/services`, payload, 1, false)
      onNotify?.(response.ok ? '指令已发送，等待 services_reply' : response.error ?? '发送失败', response.ok ? 'success' : 'error')
      if (response.ok) setPayload(refreshServicePayload(payload))
    } catch (error) {
      onNotify?.(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setSending(false)
    }
  }

  const sendQuickCommand = async (
    command: CommandTemplate | undefined,
    dataOverride?: Record<string, unknown>,
  ): Promise<void> => {
    if (!command) {
      onNotify?.('等待设备上报当前状态后再操作', 'error')
      return
    }
    if (!gatewaySn) {
      onNotify?.('请先选择网关设备', 'error')
      return
    }
    if (command.requiresDebug && !remoteDebugActive) {
      onNotify?.('请先进入远程调试模式', 'error')
      return
    }
    if (command.requiresFlightAuthority && !flightAuthorityActive) {
      onNotify?.('请先获取飞行控制权', 'error')
      return
    }
    if (command.danger && !window.confirm(`确认执行“${command.label}”？请确保现场环境安全。`)) return

    setQuickSendingCommandId(command.id)
    try {
      const commandPayload = buildServicePayload(command.method, {
        ...commandData(command),
        ...dataOverride,
      })
      const response = await onPublish(`thing/product/${gatewaySn}/services`, commandPayload, 1, false)
      onNotify?.(response.ok ? `${command.label}指令已发送，等待设备状态更新` : response.error ?? '发送失败', response.ok ? 'success' : 'error')
    } catch (error) {
      onNotify?.(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setQuickSendingCommandId('')
    }
  }

  const sendCalibration = (): void => {
    const longitude = Number(calibrationLongitude)
    const latitude = Number(calibrationLatitude)
    const height = Number(calibrationHeight)
    if (!calibrationSn.trim() || !Number.isFinite(longitude) || !Number.isFinite(latitude) || !Number.isFinite(height)) {
      onNotify?.('请填写有效的标定设备 SN、经度、纬度和高度', 'error')
      return
    }
    void sendQuickCommand(commandById('rtk-calibration'), {
      devices: [{
        sn: calibrationSn.trim(),
        type: 1,
        module: calibrationModule,
        data: { longitude, latitude, height },
      }],
    })
  }

  const quickCommandDisabled = (command: CommandTemplate | undefined): boolean =>
    status !== 'connected'
    || busy
    || Boolean(quickSendingCommandId)
    || !command
    || Boolean(command.requiresDebug && !remoteDebugActive)
    || Boolean(command.requiresFlightAuthority && !flightAuthorityActive)

  return (
    <div className="command-center">
      {showCategoryBar && availableCategories.length > 1 && <div className="command-category-bar">
        {availableCategories.map((item) => {
          const Icon = item.icon
          return (
            <button key={item.id} className={category === item.id ? 'active' : ''} onClick={() => setCategory(item.id)}>
              <Icon size={16} />{item.label}
            </button>
          )
        })}
      </div>}

      {needsGatewaySelection && (
        <div className="command-context-bar">
          <label className="field">
            <span>网关设备</span>
            <select value={gatewaySn} onChange={(event) => setGatewaySn(event.target.value)}>
              {gatewayDevices.map((device) => (
                <option key={device.id} value={device.sn}>{device.name} · {device.sn}</option>
              ))}
            </select>
          </label>
        </div>
      )}

      {category === 'flight' && (
        <section className={`flight-authority-console ${flightAuthorityActive ? 'active' : ''}`}>
          <header className="flight-authority-gate">
            <div className="flight-authority-copy">
              <span className="flight-authority-icon"><Plane size={20} /></span>
              <div>
                <span className="eyebrow">FLIGHT AUTHORITY</span>
                <h3>飞行控制权</h3>
                <p>
                  当前状态：<strong>{flightAuthorityStateLabel}</strong>
                  {controlSource && <span> · 控制源 {controlSource}</span>}
                </p>
              </div>
            </div>
            <div className="flight-authority-action">
              <code>thing/product/{gatewaySn || '{gateway_sn}'}/services</code>
              <button
                className={`button ${flightAuthorityActive ? 'secondary' : 'primary'}`}
                disabled={status !== 'connected' || busy || Boolean(quickSendingCommandId) || !flightAuthorityCommand}
                onClick={() => void sendQuickCommand(flightAuthorityCommand)}
              >
                <Radio size={16} />
                {quickSendingCommandId === flightAuthorityCommand?.id ? '发送中' : flightAuthorityCommand?.label ?? '等待状态'}
              </button>
            </div>
          </header>
          {!flightAuthorityActive && (
            <div className="flight-authority-notice">
              <LockKeyhole size={16} />
              <span>请先获取飞行控制权，获取成功并建立 DRC 链路后才能发送后续飞行指令。</span>
            </div>
          )}
        </section>
      )}

      <div className="persistent-camera-center" hidden={category !== 'payload'}>
        <CameraCenter
          profile={profile}
          telemetry={telemetry}
          gatewaySn={gatewaySn}
          status={status}
          busy={busy}
          mediaServers={mediaServers}
          selectedMediaServerId={selectedMediaServer?.id ?? ''}
          onSelectMediaServer={setSelectedMediaServerId}
          onPublish={onPublish}
          onService={onService}
          onNotify={onNotify}
        />
      </div>

      {category === 'debug' ? (
        <section className="remote-debug-console">
          <header className={`debug-mode-gate ${remoteDebugActive ? 'active' : ''}`}>
            <div className="debug-mode-copy">
              <span className="debug-mode-icon"><Gamepad2 size={20} /></span>
              <div>
                <span className="eyebrow">REMOTE DEBUG</span>
                <h3>远程调试模式</h3>
                <p>当前状态：<strong>{debugModeStateLabel}</strong></p>
              </div>
            </div>
            <div className="debug-mode-action">
              <code>thing/product/{gatewaySn || '{gateway_sn}'}/services</code>
              <button
                className={`button ${remoteDebugActive ? 'secondary' : 'primary'}`}
                disabled={status !== 'connected' || busy || Boolean(quickSendingCommandId) || !debugModeCommand}
                onClick={() => void sendQuickCommand(debugModeCommand)}
              >
                <Power size={16} />
                {quickSendingCommandId === debugModeCommand?.id ? '发送中' : debugModeCommand?.label ?? '等待状态'}
              </button>
            </div>
          </header>

          {!remoteDebugActive && (
            <div className="debug-lock-notice">
              <LockKeyhole size={16} />
              <span>请先进入远程调试模式，进入后才能操作机场设备、环境、电池、通信和维护功能。</span>
            </div>
          )}

          <section className="debug-operation-section">
            <header className="debug-section-title">
              <div><Dock size={16} /><h3>基础设备</h3></div>
              <span>状态联动</span>
            </header>
            <div className="debug-operation-grid">
              <DebugOperationCard icon={<Dock size={18} />} label="机场舱盖" status={coverStateLabel} locked={!remoteDebugActive}>
              <button
                className={`button ${coverCommand?.danger ? 'danger-button' : 'secondary'}`}
                disabled={quickCommandDisabled(coverCommand)}
                onClick={() => void sendQuickCommand(coverCommand)}
              >
                {quickSendingCommandId === coverCommand?.id ? '发送中' : coverCommand?.label ?? '等待状态上报'}
              </button>
              </DebugOperationCard>

              <DebugOperationCard icon={<Power size={18} />} label="飞机电源" status={aircraftPowerStateLabel} locked={!remoteDebugActive}>
              <button
                className="button secondary"
                disabled={quickCommandDisabled(aircraftPowerCommand)}
                onClick={() => void sendQuickCommand(aircraftPowerCommand)}
              >
                {quickSendingCommandId === aircraftPowerCommand?.id ? '发送中' : aircraftPowerCommand?.label ?? '等待状态上报'}
              </button>
              </DebugOperationCard>

              <DebugOperationCard icon={<BatteryCharging size={18} />} label="飞机充电" status={chargeStateLabel} locked={!remoteDebugActive}>
              <button
                className="button secondary"
                disabled={quickCommandDisabled(chargeCommand)}
                onClick={() => void sendQuickCommand(chargeCommand)}
              >
                {quickSendingCommandId === chargeCommand?.id ? '发送中' : chargeCommand?.label ?? '等待状态上报'}
              </button>
              </DebugOperationCard>

              <DebugOperationCard icon={<Lightbulb size={18} />} label="机场补光灯" status={supplementLightStateLabel} locked={!remoteDebugActive}>
                <button
                  className="button secondary"
                  disabled={quickCommandDisabled(supplementLightCommand)}
                  onClick={() => void sendQuickCommand(supplementLightCommand)}
                >
                  {quickSendingCommandId === supplementLightCommand?.id ? '发送中' : supplementLightCommand?.label ?? '等待状态上报'}
                </button>
              </DebugOperationCard>
            </div>
          </section>

          <section className="debug-operation-section">
            <header className="debug-section-title">
              <div><Snowflake size={16} /><h3>环境与电池</h3></div>
              <span>按当前状态操作</span>
            </header>
            <div className="debug-operation-grid">
              <DebugOperationCard icon={<BellRing size={18} />} label="声光报警" status={alarmStateLabel} locked={!remoteDebugActive}>
                <button
                  className="button secondary"
                  disabled={quickCommandDisabled(commandById('alarm-state-switch')) || alarmState === undefined}
                  onClick={() => void sendQuickCommand(commandById('alarm-state-switch'), { action: alarmState === 1 ? 0 : 1 })}
                >
                  {quickSendingCommandId === 'alarm-state-switch' ? '发送中' : alarmState === 1 ? '关闭声光报警' : alarmState === 0 ? '开启声光报警' : '等待状态上报'}
                </button>
              </DebugOperationCard>

              <DebugOperationCard icon={<Battery size={18} />} label="电池运行模式" status={batteryStoreModeLabel} locked={!remoteDebugActive}>
                <button
                  className="button secondary"
                  disabled={quickCommandDisabled(commandById('battery-store-mode-switch')) || batteryStoreMode === undefined}
                  onClick={() => void sendQuickCommand(commandById('battery-store-mode-switch'), { action: batteryStoreMode === 1 ? 2 : 1 })}
                >
                  {quickSendingCommandId === 'battery-store-mode-switch'
                    ? '发送中'
                    : batteryStoreMode === 1
                      ? '切换至待命模式'
                      : batteryStoreMode === 2
                        ? '切换至计划模式'
                        : '等待状态上报'}
                </button>
              </DebugOperationCard>

              <DebugOperationCard icon={<BatteryCharging size={18} />} label="电池保养" status={batteryMaintenanceStateLabel} locked={!remoteDebugActive}>
                <button
                  className="button secondary"
                  disabled={quickCommandDisabled(commandById('battery-maintenance-switch')) || batteryMaintenanceState === undefined}
                  onClick={() => void sendQuickCommand(commandById('battery-maintenance-switch'), { action: batteryMaintenanceState === 2 ? 0 : 1 })}
                >
                  {quickSendingCommandId === 'battery-maintenance-switch'
                    ? '发送中'
                    : batteryMaintenanceState === 2
                      ? '停止电池保养'
                      : batteryMaintenanceState === undefined
                        ? '等待状态上报'
                        : '开启电池保养'}
                </button>
              </DebugOperationCard>

              <DebugOperationCard
                icon={<Snowflake size={18} />}
                label="机场空调"
                status={airConditionerSwitchTime > 0 ? `${airConditionerStateLabel} · ${airConditionerSwitchTime}s` : airConditionerStateLabel}
                locked={!remoteDebugActive}
                className="configuration"
              >
                <div className="debug-card-controls inline">
                  <span className="debug-select-control">
                    <select
                      aria-label="机场空调目标模式"
                      value={airConditionerTarget}
                      disabled={!remoteDebugActive || airConditionerSwitchTime > 0}
                      onChange={(event) => setAirConditionerTarget(Number(event.target.value))}
                    >
                      <option value={0}>空闲</option>
                      <option value={1}>制冷</option>
                      <option value={2}>制热</option>
                      <option value={3}>除湿</option>
                    </select>
                    <ChevronDown size={14} aria-hidden="true" />
                  </span>
                  <button
                    className="button secondary"
                    disabled={quickCommandDisabled(commandById('air-conditioner-mode-switch')) || airConditionerSwitchTime > 0 || airConditionerState === airConditionerTarget}
                    onClick={() => void sendQuickCommand(commandById('air-conditioner-mode-switch'), { action: airConditionerTarget })}
                  >
                    {quickSendingCommandId === 'air-conditioner-mode-switch'
                      ? '发送中'
                      : airConditionerSwitchTime > 0
                        ? `等待 ${airConditionerSwitchTime}s`
                        : '应用模式'}
                  </button>
                </div>
              </DebugOperationCard>
            </div>
          </section>

          <section className="debug-operation-section">
            <header className="debug-section-title">
              <div><Wifi size={16} /><h3>通信与 eSIM</h3></div>
              <span>{dongles.length ? `${dongles.length} 个 Dongle` : '等待设备信息'}</span>
            </header>
            <div className="debug-operation-grid">
              <DebugOperationCard icon={<Wifi size={18} />} label="增强图传" status={linkWorkmodeLabel} locked={!remoteDebugActive}>
                <button
                  className="button secondary"
                  disabled={quickCommandDisabled(commandById('sdr-workmode-switch')) || linkWorkmode === undefined}
                  onClick={() => void sendQuickCommand(commandById('sdr-workmode-switch'), { link_workmode: linkWorkmode === 0 ? 1 : 0 })}
                >
                  {quickSendingCommandId === 'sdr-workmode-switch'
                    ? '发送中'
                    : linkWorkmode === 0
                      ? '开启 4G 增强'
                      : linkWorkmode === 1
                        ? '切换至仅 SDR'
                        : '等待状态上报'}
                </button>
              </DebugOperationCard>

              {dongles.map((dongle) => {
                const simSlotLabel = dongle.simSlot === 1 ? '实体 SIM' : dongle.simSlot === 2 ? 'eSIM' : '卡槽未知'
                const activateLabel = dongle.activateState === 2 ? '已激活' : dongle.activateState === 1 ? '未激活' : '激活状态未知'
                const operatorLabel = dongle.operator ? OPERATOR_LABELS[dongle.operator] ?? `运营商 ${dongle.operator}` : '运营商未知'
                const operatorTarget = operatorTargets[dongle.key] ?? (dongle.operator === 1 ? 2 : 1)
                return (
                  <DebugOperationCard
                    key={dongle.key}
                    icon={<Radio size={18} />}
                    label={dongle.label}
                    status={`${simSlotLabel} · ${activateLabel} · ${operatorLabel}`}
                    locked={!remoteDebugActive}
                    className="configuration wide"
                  >
                    <div className="debug-card-controls dongle">
                      <code>{dongle.imei}</code>
                      {dongle.activateState === 1 && (
                        <button
                          className="button secondary"
                          disabled={quickCommandDisabled(commandById('esim-activate'))}
                          onClick={() => void sendQuickCommand(commandById('esim-activate'), { imei: dongle.imei, device_type: dongle.deviceType })}
                        >
                          {quickSendingCommandId === 'esim-activate' ? '发送中' : '激活 eSIM'}
                        </button>
                      )}
                      <button
                        className="button secondary"
                        disabled={
                          quickCommandDisabled(commandById('sim-slot-switch'))
                          || (dongle.simSlot !== 1 && dongle.simSlot !== 2)
                          || (dongle.simSlot === 1 && dongle.activateState !== 2)
                        }
                        onClick={() => void sendQuickCommand(commandById('sim-slot-switch'), {
                          imei: dongle.imei,
                          device_type: dongle.deviceType,
                          sim_slot: dongle.simSlot === 1 ? 2 : 1,
                        })}
                      >
                        {quickSendingCommandId === 'sim-slot-switch'
                          ? '发送中'
                          : dongle.simSlot === 1
                            ? '切换至 eSIM'
                            : dongle.simSlot === 2
                              ? '切换至实体 SIM'
                              : '等待卡槽状态'}
                      </button>
                      <span className="debug-select-control">
                        <select
                          aria-label={`${dongle.label}目标运营商`}
                          value={operatorTarget}
                          disabled={!remoteDebugActive || dongle.activateState !== 2}
                          onChange={(event) => setOperatorTargets((current) => ({
                            ...current,
                            [dongle.key]: Number(event.target.value),
                          }))}
                        >
                          <option value={1}>移动</option>
                          <option value={2}>联通</option>
                          <option value={3}>电信</option>
                        </select>
                        <ChevronDown size={14} aria-hidden="true" />
                      </span>
                      <button
                        className="button secondary"
                        disabled={quickCommandDisabled(commandById('esim-operator-switch')) || dongle.activateState !== 2 || operatorTarget === dongle.operator}
                        onClick={() => void sendQuickCommand(commandById('esim-operator-switch'), {
                          imei: dongle.imei,
                          device_type: dongle.deviceType,
                          esim_operator: operatorTarget,
                        })}
                      >
                        {quickSendingCommandId === 'esim-operator-switch' ? '发送中' : '切换运营商'}
                      </button>
                    </div>
                  </DebugOperationCard>
                )
              })}

              {!dongles.length && (
                <DebugOperationCard icon={<Radio size={18} />} label="eSIM / SIM" status="等待 Dongle 状态上报" locked className="wide">
                  <button className="button secondary" disabled>等待设备信息</button>
                </DebugOperationCard>
              )}
            </div>
          </section>

          <section className="debug-operation-section">
            <header className="debug-section-title">
              <div><RotateCcw size={16} /><h3>维护与标定</h3></div>
              <span>危险操作需确认</span>
            </header>
            <div className="debug-operation-grid">
              <DebugOperationCard icon={<RotateCcw size={18} />} label="机场维护" status={remoteDebugActive ? '可操作' : '已锁定'} locked={!remoteDebugActive} className="maintenance">
                <div className="debug-maintenance-actions">
                  <button
                    className="button danger-button"
                    disabled={quickCommandDisabled(commandById('device-reboot'))}
                    onClick={() => void sendQuickCommand(commandById('device-reboot'))}
                  >
                    {quickSendingCommandId === 'device-reboot' ? '发送中' : '重启机场'}
                  </button>
                  <button
                    className="button secondary"
                    disabled={quickCommandDisabled(commandById('cover-force-close'))}
                    onClick={() => void sendQuickCommand(commandById('cover-force-close'))}
                  >
                    {quickSendingCommandId === 'cover-force-close' ? '发送中' : '强制关闭舱盖'}
                  </button>
                </div>
              </DebugOperationCard>

              <DebugOperationCard icon={<Database size={18} />} label="数据格式化" status={remoteDebugActive ? '可操作' : '已锁定'} locked={!remoteDebugActive} className="maintenance">
                <div className="debug-maintenance-actions">
                  <button
                    className="button danger-button"
                    disabled={quickCommandDisabled(commandById('device-format'))}
                    onClick={() => void sendQuickCommand(commandById('device-format'))}
                  >
                    {quickSendingCommandId === 'device-format' ? '发送中' : '格式化机场'}
                  </button>
                  <button
                    className="button danger-button"
                    disabled={quickCommandDisabled(commandById('drone-format'))}
                    onClick={() => void sendQuickCommand(commandById('drone-format'))}
                  >
                    {quickSendingCommandId === 'drone-format' ? '发送中' : '格式化飞行器'}
                  </button>
                </div>
              </DebugOperationCard>

              <DebugOperationCard icon={<MapPin size={18} />} label="RTK 一键标定" status={calibrationSn || '等待设备信息'} locked={!remoteDebugActive} className="configuration wide calibration">
                <div className="debug-calibration-form">
                  <label><span>设备 SN</span><input value={calibrationSn} disabled={!remoteDebugActive} onChange={(event) => setCalibrationSn(event.target.value)} /></label>
                  <label>
                    <span>模块</span>
                    <span className="debug-select-control">
                      <select value={calibrationModule} disabled={!remoteDebugActive} onChange={(event) => setCalibrationModule(event.target.value)}>
                        <option value="3">机场</option>
                        <option value="6">中继</option>
                      </select>
                      <ChevronDown size={14} aria-hidden="true" />
                    </span>
                  </label>
                  <label><span>经度</span><input inputMode="decimal" value={calibrationLongitude} disabled={!remoteDebugActive} onChange={(event) => setCalibrationLongitude(event.target.value)} /></label>
                  <label><span>纬度</span><input inputMode="decimal" value={calibrationLatitude} disabled={!remoteDebugActive} onChange={(event) => setCalibrationLatitude(event.target.value)} /></label>
                  <label><span>高度</span><input inputMode="decimal" value={calibrationHeight} disabled={!remoteDebugActive} onChange={(event) => setCalibrationHeight(event.target.value)} /></label>
                  <button
                    className="button primary"
                    disabled={quickCommandDisabled(commandById('rtk-calibration'))}
                    onClick={sendCalibration}
                  >
                    {quickSendingCommandId === 'rtk-calibration' ? '发送中' : '开始标定'}
                  </button>
                </div>
              </DebugOperationCard>
            </div>
          </section>

        </section>
      ) : category === 'payload' ? null : <div className={`command-layout ${category === 'flight' && !flightAuthorityActive ? 'flight-locked' : ''}`}>
        <section className="command-catalog">
          <header className="section-title-line">
            <div><Radio size={16} /><h3>快捷指令</h3></div>
            <span>{commands.length} 项</span>
          </header>
          <div className="command-grid">
            {commands.map((command) => (
              <button
                key={command.id}
                className={`command-tile ${selectedCommand?.id === command.id ? 'selected' : ''} ${command.danger ? 'danger' : ''} ${command.requiresFlightAuthority && !flightAuthorityActive ? 'locked' : ''}`}
                disabled={Boolean(command.requiresFlightAuthority && !flightAuthorityActive)}
                onClick={() => chooseCommand(command)}
              >
                <span className="command-icon">{command.danger ? <AlertTriangle size={17} /> : <Radio size={17} />}</span>
                <strong>{command.label}</strong>
                <small>{command.method}</small>
              </button>
            ))}
          </div>
        </section>

        <section className="command-builder">
          <header className="builder-header">
            <div>
              <span className="eyebrow">SERVICE REQUEST</span>
              <h3>{selectedCommand?.label ?? '选择指令'}</h3>
              <p>{selectedCommand?.description}</p>
            </div>
            {(payloadCommand?.requiresDebug ?? selectedCommand?.requiresDebug) && <span className="warning-chip">需远程调试模式</span>}
            {category === 'flight' && !flightAuthorityActive && <span className="warning-chip">需先获取飞行控制权</span>}
          </header>
          <label className="field builder-topic">
            <span>发布 Topic</span>
            <code>thing/product/{gatewaySn || '{gateway_sn}'}/services</code>
          </label>
          <label className="field payload-field">
            <span>请求 Payload</span>
            <textarea value={payload} onChange={(event) => setPayload(event.target.value)} spellCheck={false} />
          </label>
          <div className="builder-actions">
            <button
              className={`button ${payloadDanger ? 'danger-button' : 'primary'}`}
              disabled={status !== 'connected' || busy || sending || (category === 'flight' && !flightAuthorityActive)}
              onClick={() => void send()}
            >
              <Send size={16} />
              {sending ? '发送中' : busy ? '同步中' : category === 'flight' && !flightAuthorityActive ? '等待控制权' : '发送指令'}
            </button>
          </div>
        </section>
      </div>}

    </div>
  )
}
