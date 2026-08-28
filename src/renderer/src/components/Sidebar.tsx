import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Ban,
  Box,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Lock,
  MoreHorizontal,
  Plane,
  Plus,
  RadioTower,
  SatelliteDish,
  Trash2,
} from 'lucide-react'
import type {
  ConnectionProfile,
  ConnectionStatus,
  DjiDevice,
  MqttQos,
  TopicSubscription,
} from '../../../shared/contracts'
import type { DeviceTelemetry } from '../lib/dji'
import {
  extractTopicSn,
  isDeviceEffectivelyEnabled,
  isSubscriptionActive,
  mergeNestedRecords,
  telemetryValue,
} from '../lib/dji'
import { Tooltip } from './Tooltip'

interface SidebarProps {
  profiles: ConnectionProfile[]
  activeProfileId: string
  statuses: Record<string, ConnectionStatus>
  busy: boolean
  telemetry: DeviceTelemetry[]
  selectedDeviceSn: string
  onSelectProfile: (profileId: string) => void
  onAddProfile: () => void
  onEditProfile: (profile: ConnectionProfile) => void
  onAddDevice: () => void
  onEditDevice: (device: DjiDevice) => void
  onRemoveDevice: (deviceId: string) => Promise<void>
  onSelectDevice: (sn: string) => void
  onToggleDevice: (device: DjiDevice) => Promise<void>
  onToggleSubscription: (subscription: TopicSubscription) => Promise<void>
  onSetSubscriptionsEnabled: (subscriptions: TopicSubscription[], enabled: boolean, all?: boolean) => Promise<void>
  onAddSubscription: (topic: string, qos: MqttQos) => Promise<void>
  onRemoveSubscription: (subscription: TopicSubscription) => Promise<void>
}

const statusLabel: Record<ConnectionStatus, string> = {
  disconnected: '未连接',
  connecting: '连接中',
  connected: '已连接',
  reconnecting: '重连中',
  offline: '离线',
  error: '连接错误',
}

const compareDevices = (a: DjiDevice, b: DjiDevice): number =>
  a.name.localeCompare(b.name) || a.sn.localeCompare(b.sn)

export type AircraftPowerState = 'on' | 'off' | 'unknown'

export const aircraftPowerState = (telemetry: DeviceTelemetry | undefined): AircraftPowerState => {
  if (!telemetry) return 'unknown'
  const source = mergeNestedRecords(telemetry.status, telemetry.state, telemetry.osd)
  const rawState = telemetryValue(source, 'device_online_status')
  const state = typeof rawState === 'number'
    ? rawState
    : typeof rawState === 'string' && rawState.trim()
      ? Number(rawState)
      : Number.NaN
  return state === 1 ? 'on' : state === 0 ? 'off' : 'unknown'
}

const aircraftPowerLabel: Record<AircraftPowerState, string> = {
  on: '已开机',
  off: '已关机',
  unknown: '状态未知',
}

export const devicesForTree = (
  profile: ConnectionProfile | undefined,
  telemetry: DeviceTelemetry[],
): DjiDevice[] => {
  if (!profile) return []

  const devicesBySn = new Map<string, DjiDevice>()
  profile.devices.forEach((device) => devicesBySn.set(device.sn, device))
  telemetry.forEach((item) => {
    const configured = devicesBySn.get(item.sn)
    if (configured) {
      devicesBySn.set(item.sn, {
        ...configured,
        parentSn: configured.type === 'aircraft'
          ? item.gatewaySn ?? configured.parentSn
          : undefined,
      })
      return
    }
    devicesBySn.set(item.sn, {
      id: `discovered-${item.sn}`,
      name: item.name,
      sn: item.sn,
      type: item.type,
      parentSn: item.type === 'aircraft' ? item.gatewaySn : undefined,
    })
  })

  const gatewaySns = new Set(
    [...devicesBySn.values()]
      .filter((device) => device.type === 'dock' || device.type === 'pilot')
      .map((device) => device.sn),
  )
  const devices = [...devicesBySn.values()].map((device) =>
    device.type === 'aircraft' && device.parentSn && !gatewaySns.has(device.parentSn)
      ? { ...device, parentSn: undefined }
      : device,
  )
  const gateways = devices
    .filter((device) => device.type === 'dock' || device.type === 'pilot')
    .sort(compareDevices)
  const childrenByGateway = new Map<string, DjiDevice[]>()
  devices.forEach((device) => {
    if (device.type !== 'aircraft' || !device.parentSn) return
    const children = childrenByGateway.get(device.parentSn) ?? []
    children.push(device)
    childrenByGateway.set(device.parentSn, children)
  })

  const grouped = gateways.flatMap((gateway) => [
    gateway,
    ...(childrenByGateway.get(gateway.sn) ?? []).sort(compareDevices),
  ])
  const groupedSns = new Set(grouped.map((device) => device.sn))
  return [
    ...grouped,
    ...devices.filter((device) => !groupedSns.has(device.sn)).sort(compareDevices),
  ]
}

interface SubscriptionGroup {
  id: string
  label: string
  subtitle?: string
  subscriptions: TopicSubscription[]
}

interface DeviceContextMenuState {
  deviceId: string
  x: number
  y: number
}

const DEVICE_CONTEXT_MENU_WIDTH = 132
const DEVICE_CONTEXT_MENU_HEIGHT = 42
const DEVICE_CONTEXT_MENU_MARGIN = 8

export const deviceContextMenuPosition = (
  clientX: number,
  clientY: number,
  viewportWidth: number,
  viewportHeight: number,
): { x: number; y: number } => ({
  x: Math.max(
    DEVICE_CONTEXT_MENU_MARGIN,
    Math.min(clientX, viewportWidth - DEVICE_CONTEXT_MENU_WIDTH - DEVICE_CONTEXT_MENU_MARGIN),
  ),
  y: Math.max(
    DEVICE_CONTEXT_MENU_MARGIN,
    Math.min(clientY, viewportHeight - DEVICE_CONTEXT_MENU_HEIGHT - DEVICE_CONTEXT_MENU_MARGIN),
  ),
})

export const subscriptionsByParentDevice = (
  profile: ConnectionProfile,
  devices: DjiDevice[],
): SubscriptionGroup[] => {
  const devicesBySn = new Map(devices.map((device) => [device.sn, device]))
  const groups = new Map<string, SubscriptionGroup>()

  profile.subscriptions.forEach((subscription) => {
    const sn = extractTopicSn(subscription.topic)
    const device = sn ? devicesBySn.get(sn) : undefined
    if (device && !isDeviceEffectivelyEnabled(devices, device.sn)) return
    const parent = device?.parentSn ? devicesBySn.get(device.parentSn) : undefined
    const owner = parent ?? device
    const id = owner ? `device:${owner.sn}` : sn ? `unassigned:${sn}` : 'other'
    const group = groups.get(id) ?? {
      id,
      label: owner?.name ?? sn ?? '其他订阅',
      subtitle: owner?.sn ?? (sn ? '未配置设备' : undefined),
      subscriptions: [],
    }
    group.subscriptions.push(subscription)
    groups.set(id, group)
  })

  const rootOrder = new Map<string, number>()
  devices.forEach((device) => {
    const rootSn = device.parentSn && devicesBySn.has(device.parentSn) ? device.parentSn : device.sn
    if (!rootOrder.has(rootSn)) rootOrder.set(rootSn, rootOrder.size)
  })
  return [...groups.values()].sort((a, b) => {
    if (a.id === 'other') return 1
    if (b.id === 'other') return -1
    const aOrder = rootOrder.get(a.id.replace('device:', '')) ?? Number.MAX_SAFE_INTEGER
    const bOrder = rootOrder.get(b.id.replace('device:', '')) ?? Number.MAX_SAFE_INTEGER
    return aOrder - bOrder || a.label.localeCompare(b.label)
  })
}

export function Sidebar({
  profiles,
  activeProfileId,
  statuses,
  busy,
  telemetry,
  selectedDeviceSn,
  onSelectProfile,
  onAddProfile,
  onEditProfile,
  onAddDevice,
  onEditDevice,
  onRemoveDevice,
  onSelectDevice,
  onToggleDevice,
  onToggleSubscription,
  onSetSubscriptionsEnabled,
  onAddSubscription,
  onRemoveSubscription,
}: SidebarProps) {
  const [devicesOpen, setDevicesOpen] = useState(true)
  const [subscriptionsOpen, setSubscriptionsOpen] = useState(true)
  const [collapsedSubscriptionGroups, setCollapsedSubscriptionGroups] = useState<Set<string>>(() => new Set())
  const [newTopic, setNewTopic] = useState('')
  const [newQos, setNewQos] = useState<MqttQos>(0)
  const [deviceContextMenu, setDeviceContextMenu] = useState<DeviceContextMenuState | null>(null)
  const deviceContextMenuRef = useRef<HTMLDivElement>(null)
  const profile = profiles.find((item) => item.id === activeProfileId)
  const connected = statuses[activeProfileId] === 'connected'
  const devices = useMemo(() => devicesForTree(profile, telemetry), [profile, telemetry])
  const subscriptionGroups = useMemo(
    () => profile ? subscriptionsByParentDevice(profile, devices) : [],
    [profile, devices],
  )
  const visibleSubscriptions = useMemo(
    () => subscriptionGroups.flatMap((group) => group.subscriptions),
    [subscriptionGroups],
  )
  const hasEnabledSubscriptions = visibleSubscriptions.some((item) => item.enabled)
  const hasDisabledSubscriptions = visibleSubscriptions.some((item) => !item.enabled)
  const profileWithLiveRelationships = useMemo(
    () => profile ? { ...profile, devices } : undefined,
    [profile, devices],
  )
  const activeSubscriptionCount = profileWithLiveRelationships
    ? visibleSubscriptions.filter(
      (subscription) => isSubscriptionActive(profileWithLiveRelationships, subscription),
    ).length
    : 0
  const contextMenuDevice = deviceContextMenu
    ? devices.find((device) => device.id === deviceContextMenu.deviceId)
    : undefined

  useEffect(() => {
    setDeviceContextMenu(null)
  }, [activeProfileId])

  useEffect(() => {
    if (!deviceContextMenu) return

    const closeOnPointerDown = (event: PointerEvent): void => {
      if (!deviceContextMenuRef.current?.contains(event.target as Node)) setDeviceContextMenu(null)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setDeviceContextMenu(null)
    }
    const close = (): void => setDeviceContextMenu(null)

    window.addEventListener('pointerdown', closeOnPointerDown)
    window.addEventListener('keydown', closeOnEscape)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('pointerdown', closeOnPointerDown)
      window.removeEventListener('keydown', closeOnEscape)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [deviceContextMenu])

  const openDeviceContextMenu = (device: DjiDevice, x: number, y: number): void => {
    const position = deviceContextMenuPosition(x, y, window.innerWidth, window.innerHeight)
    onSelectDevice(device.sn)
    setDeviceContextMenu({ deviceId: device.id, ...position })
  }

  const submitSubscription = async (): Promise<void> => {
    if (busy || !newTopic.trim()) return
    await onAddSubscription(newTopic.trim(), newQos)
    setNewTopic('')
  }

  const toggleSubscriptionGroup = (groupId: string): void => {
    const key = `${activeProfileId}:${groupId}`
    setCollapsedSubscriptionGroups((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <aside className="sidebar" id="device-sidebar">
      <section className="sidebar-section connection-section">
        <div className="section-heading">
          <span>连接</span>
          <Tooltip label="新建连接">
            <button className="icon-button small" onClick={onAddProfile}><Plus size={15} /></button>
          </Tooltip>
        </div>
        <div className="connection-list">
          {profiles.map((item) => {
            const status = statuses[item.id] ?? 'disconnected'
            return (
              <button
                key={item.id}
                className={`connection-row ${item.id === activeProfileId ? 'selected' : ''}`}
                onClick={() => onSelectProfile(item.id)}
              >
                <span className={`status-dot ${status}`} title={statusLabel[status]} />
                <span className="connection-copy">
                  <strong>{item.name}</strong>
                  <small>{item.protocol}://{item.host}:{item.port}</small>
                </span>
                <Tooltip label="连接设置">
                  <span
                    className="row-action"
                    role="button"
                    tabIndex={0}
                    onClick={(event) => {
                      event.stopPropagation()
                      onEditProfile(item)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') onEditProfile(item)
                    }}
                  >
                    <MoreHorizontal size={16} />
                  </span>
                </Tooltip>
              </button>
            )
          })}
        </div>
      </section>

      <section className="sidebar-section tree-section">
        <div className="section-heading interactive" onClick={() => setDevicesOpen((value) => !value)}>
          <span className="heading-label">
            {devicesOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            设备
          </span>
          <Tooltip label="添加设备">
            <button
              className="icon-button small"
              onClick={(event) => {
                event.stopPropagation()
                onAddDevice()
              }}
              disabled={!profile || busy}
            >
              <Plus size={15} />
            </button>
          </Tooltip>
        </div>
        {devicesOpen && (
          <div className="device-tree">
            {devices.length === 0 ? (
              <div className="sidebar-empty">暂无设备</div>
            ) : (
              devices.map((device) => {
                const runtime = telemetry.find((item) => item.sn === device.sn)
                const recentlyReported = Boolean(runtime && Date.now() - runtime.lastSeenAt < 20_000)
                const online = connected && recentlyReported
                const discovered = device.id.startsWith('discovered-')
                const deviceEnabled = isDeviceEffectivelyEnabled(devices, device.sn)
                const inheritedDisabled = device.enabled !== false && !deviceEnabled
                const Icon = device.type === 'dock' ? RadioTower : device.type === 'aircraft' ? Plane : Box
                const powerState = device.type === 'aircraft' ? aircraftPowerState(runtime) : undefined
                return (
                  <div
                    key={device.id}
                    className={`device-row ${selectedDeviceSn === device.sn ? 'selected' : ''} ${device.parentSn ? 'child' : ''} ${deviceEnabled ? '' : 'disabled'}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelectDevice(device.sn)}
                    onDoubleClick={() => !discovered && !busy && onEditDevice(device)}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      openDeviceContextMenu(device, event.clientX, event.clientY)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') onSelectDevice(device.sn)
                      if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) {
                        event.preventDefault()
                        const bounds = event.currentTarget.getBoundingClientRect()
                        openDeviceContextMenu(device, bounds.left + 24, bounds.top + bounds.height / 2)
                      }
                    }}
                  >
                    <Icon size={15} />
                    <span className="device-copy">
                      <span className="device-name-line">
                        <strong>{device.name}</strong>
                        {powerState && (
                          <span className={`aircraft-power-state ${powerState}`}>
                            {aircraftPowerLabel[powerState]}
                          </span>
                        )}
                      </span>
                      <small>{device.sn}</small>
                    </span>
                    {!discovered && (
                      <Tooltip label={inheritedDisabled ? '已随上级设备禁用' : device.enabled === false ? '启用设备' : '禁用设备'}>
                        <button
                          className={`device-toggle ${deviceEnabled ? 'enabled' : ''}`}
                          aria-pressed={deviceEnabled}
                          disabled={busy || inheritedDisabled}
                          onClick={(event) => {
                            event.stopPropagation()
                            void onToggleDevice(device)
                          }}
                          onDoubleClick={(event) => event.stopPropagation()}
                        >
                          <span className="toggle-thumb" />
                        </button>
                      </Tooltip>
                    )}
                    <span
                      className={`device-state ${deviceEnabled && online ? 'online' : ''}`}
                      title={!deviceEnabled ? '设备已禁用' : online ? '在线，最近收到遥测' : connected ? '已连接，最近未收到遥测' : 'MQTT 未连接'}
                    />
                  </div>
                )
              })
            )}
          </div>
        )}
      </section>

      {deviceContextMenu && contextMenuDevice && (
        <div
          ref={deviceContextMenuRef}
          className="device-context-menu"
          role="menu"
          aria-label={`${contextMenuDevice.name}操作`}
          style={{ left: deviceContextMenu.x, top: deviceContextMenu.y }}
        >
          <button
            type="button"
            role="menuitem"
            className="device-context-menu-delete"
            disabled={busy || contextMenuDevice.id.startsWith('discovered-')}
            title={contextMenuDevice.id.startsWith('discovered-') ? '自动发现的设备无法删除' : undefined}
            onClick={() => {
              setDeviceContextMenu(null)
              void onRemoveDevice(contextMenuDevice.id)
            }}
          >
            <Trash2 size={14} />
            <span>删除</span>
          </button>
        </div>
      )}

      <section className="sidebar-section subscription-section">
        <div className="section-heading interactive" onClick={() => setSubscriptionsOpen((value) => !value)}>
          <span className="heading-label">
            {subscriptionsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            订阅
          </span>
          <span className="subscription-heading-actions">
            <span className="count-badge">
              {activeSubscriptionCount}/{visibleSubscriptions.length}
            </span>
            <Tooltip label="全部启用">
              <button
                className="icon-button small"
                disabled={busy || !hasDisabledSubscriptions}
                onClick={(event) => {
                  event.stopPropagation()
                  void onSetSubscriptionsEnabled(visibleSubscriptions, true, true)
                }}
              >
                <CheckCheck size={14} />
              </button>
            </Tooltip>
            <Tooltip label="全部禁用">
              <button
                className="icon-button small"
                disabled={busy || !hasEnabledSubscriptions}
                onClick={(event) => {
                  event.stopPropagation()
                  void onSetSubscriptionsEnabled(visibleSubscriptions, false, true)
                }}
              >
                <Ban size={14} />
              </button>
            </Tooltip>
          </span>
        </div>
        {subscriptionsOpen && profile && (
          <>
            <div className="subscription-list">
              {subscriptionGroups.map((group) => {
                const groupKey = `${activeProfileId}:${group.id}`
                const collapsed = collapsedSubscriptionGroups.has(groupKey)
                const activeCount = group.subscriptions.filter(
                  (item) => isSubscriptionActive(profileWithLiveRelationships ?? profile, item),
                ).length
                const groupEnabled = group.subscriptions.every((item) => item.enabled)
                return (
                  <section className={`subscription-group ${collapsed ? 'collapsed' : ''}`} key={group.id}>
                    <header className="subscription-group-header">
                      <button
                        type="button"
                        className="subscription-group-collapse"
                        aria-expanded={!collapsed}
                        onClick={() => toggleSubscriptionGroup(group.id)}
                      >
                        {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                        <span className="subscription-group-copy">
                          <strong title={group.label}>{group.label}</strong>
                          {group.subtitle && <small title={group.subtitle}>{group.subtitle}</small>}
                        </span>
                        <span className="subscription-group-count">{activeCount}/{group.subscriptions.length}</span>
                      </button>
                      <Tooltip label={groupEnabled ? '禁用分组 Topic' : '启用分组 Topic'}>
                        <button
                          type="button"
                          className={`subscription-group-toggle ${groupEnabled ? 'enabled' : ''}`}
                          aria-pressed={groupEnabled}
                          disabled={busy}
                          onClick={() => void onSetSubscriptionsEnabled(group.subscriptions, !groupEnabled)}
                        >
                          <span className="toggle-thumb" />
                        </button>
                      </Tooltip>
                    </header>
                    {!collapsed && group.subscriptions.map((subscription) => {
                      const active = isSubscriptionActive(profileWithLiveRelationships ?? profile, subscription)
                      return (
                        <div className={`subscription-row ${subscription.enabled && !active ? 'device-disabled' : ''}`} key={subscription.id}>
                          <span className="subscription-topic" title={subscription.topic}>{subscription.topic}</span>
                          <Tooltip label={subscription.enabled ? '禁用 Topic' : '启用 Topic'}>
                            <button
                              className={`subscription-toggle ${subscription.enabled ? 'enabled' : ''}`}
                              aria-pressed={subscription.enabled}
                              disabled={busy}
                              onClick={() => void onToggleSubscription(subscription)}
                            >
                              <span className="toggle-thumb" />
                            </button>
                          </Tooltip>
                          <small>Q{subscription.qos}</small>
                          {subscription.source === 'custom' ? (
                            <Tooltip label="删除订阅">
                              <button
                                className="subscription-delete"
                                disabled={busy}
                                onClick={() => void onRemoveSubscription(subscription)}
                              >
                                <Trash2 size={13} />
                              </button>
                            </Tooltip>
                          ) : (
                            <Tooltip label="系统内置 Topic 不可删除">
                              <span className="subscription-system-lock"><Lock size={11} /></span>
                            </Tooltip>
                          )}
                        </div>
                      )
                    })}
                  </section>
                )
              })}
              {!subscriptionGroups.length && <div className="sidebar-empty">暂无订阅</div>}
            </div>
            <div className="subscription-add">
              <SatelliteDish size={14} />
              <input
                value={newTopic}
                onChange={(event) => setNewTopic(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && void submitSubscription()}
                placeholder="topic/filter"
                disabled={busy}
              />
              <select disabled={busy} value={newQos} onChange={(event) => setNewQos(Number(event.target.value) as MqttQos)}>
                <option value={0}>Q0</option>
                <option value={1}>Q1</option>
                <option value={2}>Q2</option>
              </select>
              <Tooltip label="添加订阅">
                <button className="icon-button small" disabled={busy} onClick={() => void submitSubscription()}><Plus size={14} /></button>
              </Tooltip>
            </div>
          </>
        )}
      </section>
    </aside>
  )
}
