import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  Activity,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Database,
  Download,
  Info,
  LayoutDashboard,
  ListTree,
  MonitorPlay,
  Power,
  RadioTower,
  Settings,
  Unplug,
} from 'lucide-react'
import type {
  ConnectionProfile,
  ConnectionStatus,
  DeviceArchive,
  DjiDevice,
  MediaServerProfile,
  MediaServerRuntime,
  MqttMessageRecord,
  MqttQos,
  ObjectStorageProfile,
  OperationResult,
  TopicSubscription,
  TelemetryLayoutConfig,
} from '../../shared/contracts'
import { ConnectionModal } from './components/ConnectionModal'
import { AboutModal } from './components/AboutModal'
import { DeviceModal } from './components/DeviceModal'
import { Sidebar } from './components/Sidebar'
import { Tooltip } from './components/Tooltip'
import {
  buildServicePayload,
  commandTransactions,
  createDevice,
  createProfile,
  discoveredAircraftForProfile,
  isSubscriptionActive,
  mergeTelemetry,
  parseServiceReply,
  retainRecentMessages,
  subscriptionsForDevice,
  withLiveAircraftRelationships,
  type DeviceTelemetry,
  type ServiceCaller,
  type ServiceCallResult,
} from './lib/dji'
import { MediaCenter } from './views/MediaCenter'
import { Overview } from './views/Overview'
import { TelemetryManager } from './views/TelemetryManager'
import { ErrorCodeManager } from './views/ErrorCodeManager'
import { OssManager } from './views/OssManager'
import { errorCodeStats, formatServiceError } from './lib/dji-error-codes'
import { buildFirmwareEventReply } from './lib/dji-firmware'
import {
  loadTelemetryLayout,
  reconcileTelemetryLayout,
  saveTelemetryLayout,
} from './lib/telemetry-layout'
import { loadTelemetryCache, saveTelemetryCache } from './lib/telemetry-cache'
import {
  buildDeviceArchives,
  deviceArchivesEqual,
  mergeDeviceArchivesIntoTelemetry,
} from './lib/device-archive'
import {
  clearObjectStorageConfig,
  loadObjectStorageConfig,
  objectStorageConfigIssues,
  objectStorageConfigToProfile,
} from './lib/object-storage'

type WorkspaceView = 'overview' | 'media' | 'oss' | 'errors' | 'telemetry'

const viewMeta: Record<WorkspaceView, { label: string; description: string }> = {
  overview: { label: '设备工作台', description: '设备状态与调试功能' },
  media: { label: '媒体中心', description: '外部视频源与本地流媒体' },
  oss: { label: 'OSS 管理', description: '多个远程日志存储目标与临时凭证' },
  errors: { label: '错误码管理', description: '上云回复码、机场 HMS 与常见问题' },
  telemetry: { label: '遥测项管理', description: '遥测页签、指标顺序与字段说明' },
}

const statusCopy: Record<ConnectionStatus, string> = {
  disconnected: '未连接',
  connecting: '连接中',
  connected: '已连接',
  reconnecting: '正在重连',
  offline: '网络离线',
  error: '连接异常',
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const topicBelongsToDevice = (topic: string, sn: string): boolean => topic.includes(`/${sn}/`)

const shouldDisconnectForProfileSave = (status: ConnectionStatus): boolean => status !== 'disconnected'

const isGatewayType = (type: DjiDevice['type']): boolean => type === 'dock' || type === 'pilot'

const SERVICE_REPLY_TIMEOUT_MS = 20_000
const DEFAULT_SIDEBAR_WIDTH = 240
const MIN_SIDEBAR_WIDTH = 210
const MAX_SIDEBAR_WIDTH = 420
const MIN_WORKSPACE_WIDTH = 420
const SIDEBAR_WIDTH_STORAGE_KEY = 'dji-cloud-studio.sidebar-width'

const clampSidebarWidth = (width: number): number => {
  const viewportMax = typeof window === 'undefined'
    ? MAX_SIDEBAR_WIDTH
    : window.innerWidth - 54 - MIN_WORKSPACE_WIDTH
  const maxWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, viewportMax))
  return Math.round(Math.min(maxWidth, Math.max(MIN_SIDEBAR_WIDTH, width)))
}

const loadSidebarWidth = (): number => {
  if (typeof window === 'undefined') return DEFAULT_SIDEBAR_WIDTH
  try {
    const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY))
    return Number.isFinite(stored) && stored > 0 ? clampSidebarWidth(stored) : DEFAULT_SIDEBAR_WIDTH
  } catch {
    return DEFAULT_SIDEBAR_WIDTH
  }
}

interface PendingServiceReply {
  profileId: string
  bid?: string
  timer: number
  resolve: (result: ServiceCallResult) => void
}

const serviceReplyKey = (profileId: string, gatewaySn: string, tid: string): string =>
  `${profileId}:${gatewaySn}:${tid}`

const activeSubscriptionChanges = (
  current: ConnectionProfile,
  next: ConnectionProfile,
): { removed: TopicSubscription[]; added: TopicSubscription[] } => {
  const currentActive = current.subscriptions.filter((subscription) => isSubscriptionActive(current, subscription))
  const nextActive = next.subscriptions.filter((subscription) => isSubscriptionActive(next, subscription))
  const hasEquivalent = (subscriptions: TopicSubscription[], candidate: TopicSubscription): boolean =>
    subscriptions.some((item) => item.topic === candidate.topic && item.qos === candidate.qos)
  return {
    removed: currentActive.filter((subscription) => !hasEquivalent(nextActive, subscription)),
    added: nextActive.filter((subscription) => !hasEquivalent(currentActive, subscription)),
  }
}

export default function App() {
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([])
  const profilesRef = useRef<ConnectionProfile[]>([])
  const [activeProfileId, setActiveProfileId] = useState('')
  const [statuses, setStatuses] = useState<Record<string, ConnectionStatus>>({})
  const statusesRef = useRef<Record<string, ConnectionStatus>>({})
  const statusUpdatedAtRef = useRef<Record<string, number>>({})
  const [recordsByProfile, setRecordsByProfile] = useState<Record<string, MqttMessageRecord[]>>({})
  const [telemetryByKey, setTelemetryByKey] = useState<Record<string, DeviceTelemetry>>(() => loadTelemetryCache())
  const telemetryByKeyRef = useRef<Record<string, DeviceTelemetry>>(telemetryByKey)
  const telemetryCacheTimerRef = useRef<number>()
  const [deviceArchives, setDeviceArchives] = useState<DeviceArchive[]>([])
  const deviceArchivesRef = useRef<DeviceArchive[]>([])
  const [selectedDeviceSn, setSelectedDeviceSn] = useState('')
  const [activeView, setActiveView] = useState<WorkspaceView>('overview')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth)
  const [sidebarResizing, setSidebarResizing] = useState(false)
  const sidebarResizeStartRef = useRef({ x: 0, width: DEFAULT_SIDEBAR_WIDTH })
  const [objectStorageProfiles, setObjectStorageProfiles] = useState<ObjectStorageProfile[]>([])
  const [activeObjectStorageId, setActiveObjectStorageId] = useState('')
  const [mediaServers, setMediaServers] = useState<MediaServerProfile[]>([])
  const [mediaServerRuntimes, setMediaServerRuntimes] = useState<Record<string, MediaServerRuntime>>({})
  const [mediaServersLoading, setMediaServersLoading] = useState(true)
  const [telemetryLayout, setTelemetryLayout] = useState<TelemetryLayoutConfig>(() => loadTelemetryLayout())
  const [connectionEditor, setConnectionEditor] = useState<{ profile: ConnectionProfile; isNew: boolean } | null>(null)
  const [deviceEditor, setDeviceEditor] = useState<{ device: DjiDevice; isNew: boolean } | null>(null)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [toast, setToast] = useState<{ id: number; text: string; tone: 'info' | 'success' | 'error' } | null>(null)
  const toastIdRef = useRef(0)
  const [loading, setLoading] = useState(true)
  const [clock, setClock] = useState(() => Date.now())
  const [profileMutationCounts, setProfileMutationCounts] = useState<Record<string, number>>({})
  const profileMutationCountsRef = useRef<Record<string, number>>({})
  const profileMutationQueueRef = useRef<Promise<void>>(Promise.resolve())
  const [subscriptionSyncing, setSubscriptionSyncing] = useState<Record<string, boolean>>({})
  const subscriptionSyncingRef = useRef<Record<string, boolean>>({})
  const subscriptionSyncGenerationRef = useRef<Record<string, number>>({})
  const discoveredAircraftSubscriptionRef = useRef(new Set<string>())
  const pendingServiceRepliesRef = useRef(new Map<string, PendingServiceReply>())

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth))
    } catch {
      // The current window can still use the resized width when storage is unavailable.
    }
  }, [sidebarWidth])

  useEffect(() => {
    const fitSidebarToViewport = (): void => setSidebarWidth((current) => clampSidebarWidth(current))
    window.addEventListener('resize', fitSidebarToViewport)
    return () => window.removeEventListener('resize', fitSidebarToViewport)
  }, [])

  useEffect(() => {
    if (!sidebarResizing) return

    const resizeSidebar = (event: PointerEvent): void => {
      const delta = event.clientX - sidebarResizeStartRef.current.x
      setSidebarWidth(clampSidebarWidth(sidebarResizeStartRef.current.width + delta))
    }
    const finishResize = (): void => setSidebarResizing(false)

    window.addEventListener('pointermove', resizeSidebar)
    window.addEventListener('pointerup', finishResize)
    window.addEventListener('pointercancel', finishResize)
    return () => {
      window.removeEventListener('pointermove', resizeSidebar)
      window.removeEventListener('pointerup', finishResize)
      window.removeEventListener('pointercancel', finishResize)
    }
  }, [sidebarResizing])

  const startSidebarResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || sidebarCollapsed) return
    event.preventDefault()
    sidebarResizeStartRef.current = { x: event.clientX, width: sidebarWidth }
    setSidebarResizing(true)
  }

  const showToast = useCallback((text: string, tone: 'info' | 'success' | 'error' = 'info'): void => {
    toastIdRef.current += 1
    setToast({ id: toastIdRef.current, text, tone })
  }, [])

  const updateMediaServerRuntime = useCallback((runtime: MediaServerRuntime): void => {
    setMediaServerRuntimes((current) => {
      const previous = current[runtime.profileId]
      if (previous && previous.checkedAt > runtime.checkedAt) return current
      return { ...current, [runtime.profileId]: runtime }
    })
  }, [])

  useEffect(() => {
    const unsubscribe = window.djiApi.media.onRuntimeEvent(updateMediaServerRuntime)
    void window.djiApi.media.getLocalRuntime()
      .then(updateMediaServerRuntime)
      .catch((error) => showToast(`加载本地媒体服务状态失败：${errorMessage(error)}`, 'error'))
    return unsubscribe
  }, [showToast, updateMediaServerRuntime])

  useEffect(() => {
    let disposed = false
    void window.djiApi.media.listServers().then((servers) => {
      if (disposed) return
      setMediaServers(servers)
      servers.filter((server) => server.kind !== 'local-zlm').forEach((server) => {
        void window.djiApi.media.checkServer(server.id).then((result) => {
          if (!disposed && result.runtime) updateMediaServerRuntime(result.runtime)
        })
      })
    }).catch((error) => {
      if (!disposed) showToast(`加载媒体服务失败：${errorMessage(error)}`, 'error')
    }).finally(() => {
      if (!disposed) setMediaServersLoading(false)
    })
    return () => { disposed = true }
  }, [showToast, updateMediaServerRuntime])

  const handleObjectStorageSave = async (profile: ObjectStorageProfile): Promise<ObjectStorageProfile> => {
    const saved = await window.djiApi.objectStorage.save(profile)
    setObjectStorageProfiles((current) => {
      const exists = current.some((item) => item.id === saved.id)
      return exists ? current.map((item) => item.id === saved.id ? saved : item) : [...current, saved]
    })
    setActiveObjectStorageId(saved.id)
    return saved
  }

  const handleObjectStorageRemove = async (profileId: string): Promise<OperationResult> => {
    const result = await window.djiApi.objectStorage.remove(profileId)
    if (!result.ok) return result
    const next = objectStorageProfiles.filter((profile) => profile.id !== profileId)
    setObjectStorageProfiles(next)
    setActiveObjectStorageId((selected) => selected === profileId ? next[0]?.id ?? '' : selected)
    return result
  }

  useEffect(() => {
    let disposed = false
    void window.djiApi.objectStorage.list().then(async (profiles) => {
      let next = profiles
      if (!next.length) {
        const legacy = loadObjectStorageConfig()
        if (!objectStorageConfigIssues(legacy).length) {
          const migrated = await window.djiApi.objectStorage.save(objectStorageConfigToProfile(legacy))
          clearObjectStorageConfig()
          next = [migrated]
        }
      }
      if (disposed) return
      setObjectStorageProfiles(next)
      setActiveObjectStorageId(next[0]?.id ?? '')
    }).catch((error) => {
      if (!disposed) showToast(`加载对象存储配置失败：${errorMessage(error)}`, 'error')
    })
    return () => {
      disposed = true
    }
  }, [showToast])

  const setProfilesSnapshot = (next: ConnectionProfile[]): void => {
    profilesRef.current = next
    setProfiles(next)
  }

  const replaceProfileInState = (profile: ConnectionProfile): void => {
    const current = profilesRef.current
    const exists = current.some((item) => item.id === profile.id)
    setProfilesSnapshot(exists ? current.map((item) => (item.id === profile.id ? profile : item)) : [...current, profile])
  }

  const updateTelemetrySnapshot = (
    updater: (current: Record<string, DeviceTelemetry>) => Record<string, DeviceTelemetry>,
  ): Record<string, DeviceTelemetry> => {
    const next = updater(telemetryByKeyRef.current)
    telemetryByKeyRef.current = next
    setTelemetryByKey(next)
    if (telemetryCacheTimerRef.current !== undefined) window.clearTimeout(telemetryCacheTimerRef.current)
    telemetryCacheTimerRef.current = window.setTimeout(() => {
      telemetryCacheTimerRef.current = undefined
      saveTelemetryCache(telemetryByKeyRef.current)
    }, 1_000)
    return next
  }

  const refreshDeviceArchives = (profile: ConnectionProfile, telemetry: DeviceTelemetry[]): DeviceArchive[] => {
    const currentForProfile = deviceArchivesRef.current.filter((archive) => archive.profileId === profile.id)
    const nextForProfile = buildDeviceArchives(profile, telemetry, currentForProfile)
    if (deviceArchivesEqual(currentForProfile, nextForProfile)) return currentForProfile
    const next = [
      ...deviceArchivesRef.current.filter((archive) => archive.profileId !== profile.id),
      ...nextForProfile,
    ]
    deviceArchivesRef.current = next
    setDeviceArchives(next)
    void window.djiApi.deviceArchives.replaceProfile(profile.id, nextForProfile).catch((error) => {
      showToast(`保存设备档案失败：${errorMessage(error)}`, 'error')
    })
    return nextForProfile
  }

  const setStatusSnapshot = (profileId: string, status: ConnectionStatus, at = Date.now()): void => {
    if ((statusUpdatedAtRef.current[profileId] ?? 0) > at) return
    const next = { ...statusesRef.current, [profileId]: status }
    statusUpdatedAtRef.current = { ...statusUpdatedAtRef.current, [profileId]: at }
    statusesRef.current = next
    setStatuses(next)
  }

  const setSubscriptionSyncingSnapshot = (profileId: string, syncing: boolean): void => {
    const next = { ...subscriptionSyncingRef.current, [profileId]: syncing }
    subscriptionSyncingRef.current = next
    setSubscriptionSyncing(next)
  }

  const updateProfileMutationCount = (profileId: string, delta: number): void => {
    const count = Math.max(0, (profileMutationCountsRef.current[profileId] ?? 0) + delta)
    const next = { ...profileMutationCountsRef.current }
    if (count) next[profileId] = count
    else delete next[profileId]
    profileMutationCountsRef.current = next
    setProfileMutationCounts(next)
  }

  const enqueueProfileOperation = <T,>(profileId: string, operation: () => Promise<T>): Promise<T> => {
    updateProfileMutationCount(profileId, 1)
    const pending = profileMutationQueueRef.current.then(operation, operation)
    profileMutationQueueRef.current = pending.then(() => undefined, () => undefined)
    return pending.finally(() => updateProfileMutationCount(profileId, -1))
  }

  const currentProfile = (profileId: string): ConnectionProfile => {
    const profile = profilesRef.current.find((item) => item.id === profileId)
    if (!profile) throw new Error('连接配置已不存在')
    return profile
  }

  const syncSubscriptionChanges = async (
    profileId: string,
    removed: TopicSubscription[],
    added: TopicSubscription[],
  ): Promise<{ failures: string[]; disconnectError?: string }> => {
    if (statusesRef.current[profileId] !== 'connected') return { failures: [] }
    const failures: string[] = []
    const removedResults = await Promise.all(
      removed.map(async (subscription) => {
        try {
          return { subscription, result: await window.djiApi.mqtt.unsubscribe(profileId, subscription.topic) }
        } catch (error) {
          return { subscription, result: { ok: false, error: errorMessage(error) } as OperationResult }
        }
      }),
    )
    removedResults.forEach(({ subscription, result }) => {
      if (!result.ok) failures.push(`取消 ${subscription.topic}: ${result.error ?? '未知错误'}`)
    })

    const addedResults = await Promise.all(
      added.map(async (subscription) => {
        try {
          return { subscription, result: await window.djiApi.mqtt.subscribe(profileId, subscription.topic, subscription.qos) }
        } catch (error) {
          return { subscription, result: { ok: false, error: errorMessage(error) } as OperationResult }
        }
      }),
    )
    addedResults.forEach(({ subscription, result }) => {
      if (!result.ok) failures.push(`订阅 ${subscription.topic}: ${result.error ?? '未知错误'}`)
    })
    if (!failures.length) return { failures }

    let disconnectResult: OperationResult
    try {
      disconnectResult = await window.djiApi.mqtt.disconnect(profileId)
    } catch (error) {
      disconnectResult = { ok: false, error: errorMessage(error) }
    }
    if (disconnectResult.ok) {
      setStatusSnapshot(profileId, 'disconnected')
      return { failures }
    }

    const disconnectError = disconnectResult.error ?? '未知错误'
    setStatusSnapshot(profileId, 'error')
    return { failures, disconnectError }
  }

  const ensureDiscoveredAircraftSubscriptions = (
    profileId: string,
    sn: string,
    gatewaySn: string,
    discoveredName: string,
  ): void => {
    const discoveryKey = `${profileId}:${sn}`
    if (discoveredAircraftSubscriptionRef.current.has(discoveryKey)) return
    discoveredAircraftSubscriptionRef.current.add(discoveryKey)

    void enqueueProfileOperation(profileId, async () => {
      const current = currentProfile(profileId)
      const existingDevice = current.devices.find((device) => device.sn === sn)
      const discoveredDevice: DjiDevice | undefined = existingDevice ? undefined : {
        id: crypto.randomUUID(),
        name: discoveredName || '已发现飞机',
        sn,
        type: 'aircraft',
        enabled: true,
        parentSn: gatewaySn,
      }
      const existingTopics = new Set(current.subscriptions.map((item) => item.topic))
      const addedSubscriptions = subscriptionsForDevice({
        id: `discovered-${sn}`,
        name: '已发现飞机',
        sn,
        type: 'aircraft',
      }).filter((item) => !existingTopics.has(item.topic))
      const relationshipChanged = Boolean(
        existingDevice
        && existingDevice.type === 'aircraft'
        && existingDevice.parentSn !== gatewaySn,
      )
      if (!discoveredDevice && !relationshipChanged && !addedSubscriptions.length) return

      const devices = discoveredDevice
        ? [...current.devices, discoveredDevice]
        : relationshipChanged
          ? current.devices.map((device) => device.id === existingDevice?.id ? { ...device, parentSn: gatewaySn } : device)
          : current.devices

      const nextProfile: ConnectionProfile = {
        ...current,
        devices,
        subscriptions: [...current.subscriptions, ...addedSubscriptions],
      }
      const { removed, added } = activeSubscriptionChanges(current, nextProfile)
      const saved = await window.djiApi.profiles.save(nextProfile)
      replaceProfileInState(saved)
      const { failures, disconnectError } = await syncSubscriptionChanges(profileId, removed, added)
      if (!failures.length) return
      showToast(
        disconnectError
          ? `已发现飞机 ${sn}，但自动订阅失败且连接断开失败：${disconnectError}。${failures[0]}`
          : `已发现飞机 ${sn}，但自动订阅失败。连接已断开，请重连。${failures[0]}`,
        'error',
      )
    }).catch((error) => {
      discoveredAircraftSubscriptionRef.current.delete(discoveryKey)
      showToast(`自动保存飞机 Topic 失败：${errorMessage(error)}`, 'error')
    })
  }

  const restoreSubscriptions = (profileId: string): void => {
    const generation = (subscriptionSyncGenerationRef.current[profileId] ?? 0) + 1
    subscriptionSyncGenerationRef.current[profileId] = generation
    const profile = profilesRef.current.find((item) => item.id === profileId)
    if (!profile) return

    setSubscriptionSyncingSnapshot(profileId, true)
    const enabled = profile.subscriptions.filter((subscription) => isSubscriptionActive(profile, subscription))
    void Promise.all(
      enabled.map(async (subscription) => {
        try {
          return { subscription, result: await window.djiApi.mqtt.subscribe(profileId, subscription.topic, subscription.qos) }
        } catch (error) {
          return { subscription, result: { ok: false, error: errorMessage(error) } as OperationResult }
        }
      }),
    ).then(async (results) => {
      if (subscriptionSyncGenerationRef.current[profileId] !== generation) return
      const failures = results.filter(({ result }) => !result.ok)
      if (failures.length) {
        const first = failures[0]
        showToast(`连接已建立，但 ${failures.length} 个订阅恢复失败，正在断开：${first.subscription.topic}（${first.result.error ?? '未知错误'}）`, 'error')
        let disconnectResult: OperationResult
        try {
          disconnectResult = await window.djiApi.mqtt.disconnect(profileId)
        } catch (error) {
          disconnectResult = { ok: false, error: errorMessage(error) }
        }
        if (subscriptionSyncGenerationRef.current[profileId] !== generation) return
        setSubscriptionSyncingSnapshot(profileId, false)
        if (!disconnectResult.ok) {
          setStatusSnapshot(profileId, 'error')
          showToast(`订阅恢复失败且无法断开连接：${disconnectResult.error ?? '未知错误'}`, 'error')
        }
        return
      }
      setSubscriptionSyncingSnapshot(profileId, false)
    })
  }

  useEffect(() => {
    let disposed = false
    const unsubscribe = window.djiApi.events.onRuntimeEvent((event) => {
      if (disposed) return
      if (event.type === 'status') {
        setStatusSnapshot(event.profileId, event.status, event.at)
        if (event.status === 'error' && event.detail) showToast(event.detail, 'error')
        if (event.status === 'connected') {
          restoreSubscriptions(event.profileId)
        } else {
          updateTelemetrySnapshot((current) => Object.fromEntries(
            Object.entries(current).map(([key, telemetry]) => [
              key,
              telemetry.profileId === event.profileId ? { ...telemetry, online: false } : telemetry,
            ]),
          ))
          pendingServiceRepliesRef.current.forEach((pending, key) => {
            if (pending.profileId !== event.profileId) return
            window.clearTimeout(pending.timer)
            pendingServiceRepliesRef.current.delete(key)
            pending.resolve({ ok: false, tid: key.split(':').at(-1) ?? '', error: 'MQTT 连接已断开，未收到设备回执' })
          })
          subscriptionSyncGenerationRef.current[event.profileId] = (subscriptionSyncGenerationRef.current[event.profileId] ?? 0) + 1
          setSubscriptionSyncingSnapshot(event.profileId, false)
        }
        return
      }

      if (event.type === 'message') {
        const firmwareEventReply = buildFirmwareEventReply(event.message)
        if (firmwareEventReply) {
          void window.djiApi.mqtt.publish({
            profileId: event.profileId,
            topic: firmwareEventReply.topic,
            payload: firmwareEventReply.payload,
            qos: 1,
            retain: false,
          }).then((result) => {
            if (!result.ok) showToast(`固件升级进度确认失败：${result.error ?? '未知错误'}`, 'error')
          }).catch((error) => showToast(`固件升级进度确认失败：${errorMessage(error)}`, 'error'))
        }
        const reply = parseServiceReply(event.message)
        if (reply) {
          if (reply.result !== undefined && reply.result !== 0) {
            showToast(formatServiceError(reply.result), 'error')
          }
          const key = serviceReplyKey(event.profileId, reply.gatewaySn, reply.tid)
          const pending = pendingServiceRepliesRef.current.get(key)
          if (pending && (!pending.bid || !reply.bid || pending.bid === reply.bid)) {
            window.clearTimeout(pending.timer)
            pendingServiceRepliesRef.current.delete(key)
            pending.resolve({
              ok: reply.result === 0,
              tid: reply.tid,
              bid: reply.bid,
              result: reply.result,
              output: reply.output,
              error: reply.result === 0
                ? undefined
                : reply.result === undefined
                  ? '设备回执缺少 result 字段'
                  : formatServiceError(reply.result),
            })
          }
        }
        setRecordsByProfile((current) => {
          const records = [...(current[event.profileId] ?? []), event.message]
          return { ...current, [event.profileId]: retainRecentMessages(records) }
        })
        const profile = profilesRef.current.find((item) => item.id === event.profileId)
        if (profile) {
          const merged = updateTelemetrySnapshot((current) => mergeTelemetry(current, profile, event.message))
          refreshDeviceArchives(
            profile,
            Object.values(merged).filter((telemetry) => telemetry.profileId === profile.id),
          )
          discoveredAircraftForProfile(Object.values(merged), profile.id).forEach((telemetry) => {
            ensureDiscoveredAircraftSubscriptions(profile.id, telemetry.sn, telemetry.gatewaySn, telemetry.name)
          })
        }
      }
    })

    void Promise.all([
      window.djiApi.profiles.list(),
      window.djiApi.mqtt.getRuntime(),
      window.djiApi.deviceArchives.list(),
    ])
      .then(([loadedProfiles, runtime, loadedArchives]) => {
        if (disposed) return
        setProfilesSnapshot(loadedProfiles)
        const profileIds = new Set(loadedProfiles.map((profile) => profile.id))
        updateTelemetrySnapshot((current) => Object.fromEntries(
          Object.entries(current).filter(([, telemetry]) => profileIds.has(telemetry.profileId)),
        ))
        const cachedTelemetry = Object.values(telemetryByKeyRef.current)
        let migratedArchives = loadedArchives.filter((archive) => profileIds.has(archive.profileId))
        const migrations: Promise<unknown>[] = []
        loadedProfiles.forEach((profile) => {
          const currentForProfile = migratedArchives.filter((archive) => archive.profileId === profile.id)
          const nextForProfile = buildDeviceArchives(
            profile,
            cachedTelemetry.filter((telemetry) => telemetry.profileId === profile.id),
            currentForProfile,
          )
          migratedArchives = [
            ...migratedArchives.filter((archive) => archive.profileId !== profile.id),
            ...nextForProfile,
          ]
          if (!deviceArchivesEqual(currentForProfile, nextForProfile)) {
            migrations.push(window.djiApi.deviceArchives.replaceProfile(profile.id, nextForProfile))
          }
        })
        deviceArchivesRef.current = migratedArchives
        setDeviceArchives(migratedArchives)
        void Promise.all(migrations).catch((error) => showToast(`迁移设备档案失败：${errorMessage(error)}`, 'error'))
        setActiveProfileId(loadedProfiles[0]?.id ?? '')
        const runtimeByProfile = new Map(runtime.map((item) => [item.profileId, item]))
        const nextStatuses = { ...statusesRef.current }
        const nextUpdatedAt = { ...statusUpdatedAtRef.current }
        loadedProfiles.forEach((profile) => {
          const snapshot = runtimeByProfile.get(profile.id)
          if (snapshot && snapshot.at >= (nextUpdatedAt[profile.id] ?? 0)) {
            nextStatuses[profile.id] = snapshot.status
            nextUpdatedAt[profile.id] = snapshot.at
          } else if (!nextStatuses[profile.id]) {
            nextStatuses[profile.id] = 'disconnected'
          }
        })
        statusesRef.current = nextStatuses
        statusUpdatedAtRef.current = nextUpdatedAt
        setStatuses(nextStatuses)
        loadedProfiles.forEach((profile) => {
          if (nextStatuses[profile.id] === 'connected') restoreSubscriptions(profile.id)
        })
        setLoading(false)
      })
      .catch((error) => {
        if (disposed) return
        showToast(`加载连接配置失败：${errorMessage(error)}`, 'error')
        setLoading(false)
      })

    return () => {
      disposed = true
      unsubscribe()
      pendingServiceRepliesRef.current.forEach((pending, key) => {
        window.clearTimeout(pending.timer)
        pending.resolve({ ok: false, tid: key.split(':').at(-1) ?? '', error: '应用已停止等待设备回执' })
      })
      pendingServiceRepliesRef.current.clear()
    }
  }, [])

  const activeProfile = profiles.find((profile) => profile.id === activeProfileId)
  const activeStatus = statuses[activeProfileId] ?? 'disconnected'
  const activeRecords = recordsByProfile[activeProfileId] ?? []
  const activeTelemetry = useMemo(() => mergeDeviceArchivesIntoTelemetry(
    deviceArchives.filter((archive) => archive.profileId === activeProfileId),
    Object.values(telemetryByKey).filter((device) => device.profileId === activeProfileId),
  ), [activeProfileId, deviceArchives, telemetryByKey])
  const effectiveTelemetryLayout = useMemo(
    () => reconcileTelemetryLayout(telemetryLayout, Object.values(telemetryByKey)),
    [telemetryLayout, telemetryByKey],
  )
  const transactions = useMemo(() => commandTransactions(activeRecords, clock), [activeRecords, clock])

  useEffect(() => {
    if (effectiveTelemetryLayout === telemetryLayout) return
    try {
      saveTelemetryLayout(effectiveTelemetryLayout)
      setTelemetryLayout(effectiveTelemetryLayout)
    } catch (error) {
      showToast(`保存遥测项配置失败：${errorMessage(error)}`, 'error')
    }
  }, [effectiveTelemetryLayout, telemetryLayout, showToast])

  const handleTelemetryLayoutChange = (next: TelemetryLayoutConfig): void => {
    try {
      saveTelemetryLayout(next)
      setTelemetryLayout(next)
    } catch (error) {
      showToast(`保存遥测项配置失败：${errorMessage(error)}`, 'error')
    }
  }

  useEffect(() => {
    const flushTelemetryCache = (): void => {
      if (telemetryCacheTimerRef.current !== undefined) {
        window.clearTimeout(telemetryCacheTimerRef.current)
        telemetryCacheTimerRef.current = undefined
      }
      saveTelemetryCache(telemetryByKeyRef.current)
    }
    window.addEventListener('beforeunload', flushTelemetryCache)
    return () => {
      window.removeEventListener('beforeunload', flushTelemetryCache)
      flushTelemetryCache()
    }
  }, [])

  useEffect(() => {
    if (!activeProfile) {
      setSelectedDeviceSn('')
      return
    }
    const stillExists = activeProfile.devices.some((device) => device.sn === selectedDeviceSn)
      || activeTelemetry.some((device) => device.sn === selectedDeviceSn)
    if (!stillExists) setSelectedDeviceSn(activeProfile.devices[0]?.sn ?? activeTelemetry[0]?.sn ?? '')
  }, [activeProfile, activeTelemetry, selectedDeviceSn])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 3400)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  const handleSaveProfile = async (profile: ConnectionProfile): Promise<void> => {
    const isNew = !profilesRef.current.some((item) => item.id === profile.id)
    await enqueueProfileOperation(profile.id, async () => {
      const current = profilesRef.current.find((item) => item.id === profile.id)
      const nextProfile = current
        ? { ...profile, devices: current.devices, subscriptions: current.subscriptions, createdAt: current.createdAt }
        : profile
      const saved = await window.djiApi.profiles.save(nextProfile)
      const status = statusesRef.current[profile.id] ?? 'disconnected'
      let disconnectError = ''
      if (current && shouldDisconnectForProfileSave(status)) {
        const result = await window.djiApi.mqtt.disconnect(profile.id)
        if (!result.ok) disconnectError = result.error ?? '断开旧连接失败'
      }
      replaceProfileInState(saved)
      if (isNew) setActiveProfileId(saved.id)
      if (!(saved.id in statusesRef.current)) setStatusSnapshot(saved.id, 'disconnected')
      if (disconnectError) setStatusSnapshot(saved.id, 'error')
      setConnectionEditor(null)
      showToast(
        disconnectError
          ? `连接配置已保存，但旧连接未能断开：${disconnectError}`
          : current && shouldDisconnectForProfileSave(status)
            ? '连接配置已保存，旧连接已断开，请重新连接'
            : '连接配置已保存',
        disconnectError ? 'error' : 'success',
      )
    })
  }

  const handleRemoveProfile = async (profileId: string): Promise<void> => {
    if (profilesRef.current.length <= 1) {
      showToast('至少需要保留一个连接配置', 'error')
      return
    }
    if (!window.confirm('确认删除这个连接及其设备和订阅配置？')) return
    try {
      await enqueueProfileOperation(profileId, async () => {
        if (profilesRef.current.length <= 1) throw new Error('至少需要保留一个连接配置')
        const result = await window.djiApi.profiles.remove(profileId)
        if (!result.ok) throw new Error(result.error ?? '删除失败')
        const remaining = profilesRef.current.filter((profile) => profile.id !== profileId)
        setProfilesSnapshot(remaining)
        setActiveProfileId((current) => current === profileId ? remaining[0]?.id ?? '' : current)
        setRecordsByProfile((current) => {
          const next = { ...current }
          delete next[profileId]
          return next
        })
        updateTelemetrySnapshot((current) => Object.fromEntries(
          Object.entries(current).filter(([, telemetry]) => telemetry.profileId !== profileId),
        ))
        const nextArchives = deviceArchivesRef.current.filter((archive) => archive.profileId !== profileId)
        deviceArchivesRef.current = nextArchives
        setDeviceArchives(nextArchives)
        const nextStatuses = { ...statusesRef.current }
        delete nextStatuses[profileId]
        statusesRef.current = nextStatuses
        setStatuses(nextStatuses)
        subscriptionSyncGenerationRef.current[profileId] = (subscriptionSyncGenerationRef.current[profileId] ?? 0) + 1
        setSubscriptionSyncingSnapshot(profileId, false)
        setConnectionEditor(null)
        showToast('连接已删除', 'success')
      })
    } catch (error) {
      showToast(errorMessage(error), 'error')
    }
  }

  const handleConnectToggle = async (): Promise<void> => {
    const profile = profilesRef.current.find((item) => item.id === activeProfileId)
    if (!profile) return
    if (profileMutationCountsRef.current[profile.id]) {
      showToast('连接配置正在保存，请稍候', 'info')
      return
    }
    const status = statusesRef.current[profile.id] ?? 'disconnected'
    const result = status === 'connected' || status === 'connecting' || status === 'reconnecting'
      ? await window.djiApi.mqtt.disconnect(profile.id)
      : await window.djiApi.mqtt.connect(profile.id)
    if (!result.ok) showToast(result.error ?? (status === 'connected' ? '断开失败' : '连接失败'), 'error')
  }

  const handleSaveDevice = async (device: DjiDevice): Promise<void> => {
    if (!activeProfile) return
    const profileId = activeProfile.id
    const normalizedDevice: DjiDevice = {
      ...device,
      name: device.name.trim(),
      sn: device.sn.trim(),
      dockModel: device.type === 'dock' ? device.dockModel ?? 'dock2' : undefined,
      parentSn: device.type === 'aircraft' ? device.parentSn : undefined,
    }
    try {
      const outcome = await enqueueProfileOperation(profileId, async () => {
        const current = currentProfile(profileId)
        const duplicate = current.devices.find((item) => item.sn === normalizedDevice.sn && item.id !== normalizedDevice.id)
        if (duplicate) throw new Error('同一连接中不能添加重复的设备 SN')

        const existing = current.devices.find((item) => item.id === normalizedDevice.id)
        let devices = existing
          ? current.devices.map((item) => (item.id === normalizedDevice.id ? normalizedDevice : item))
          : [...current.devices, normalizedDevice]
        if (existing && (existing.sn !== normalizedDevice.sn || isGatewayType(existing.type) && !isGatewayType(normalizedDevice.type))) {
          devices = devices.map((item) => item.id !== normalizedDevice.id && item.parentSn === existing.sn
            ? { ...item, parentSn: isGatewayType(normalizedDevice.type) ? normalizedDevice.sn : undefined }
            : item)
        }

        let subscriptions = current.subscriptions
        if (!existing || existing.sn !== normalizedDevice.sn || existing.type !== normalizedDevice.type) {
          if (existing) {
            subscriptions = subscriptions.filter(
              (subscription) => !(subscription.source === 'dji' && topicBelongsToDevice(subscription.topic, existing.sn)),
            )
          }
          const existingTopics = new Set(subscriptions.map((item) => item.topic))
          subscriptions = [
            ...subscriptions,
            ...subscriptionsForDevice(normalizedDevice).filter((item) => !existingTopics.has(item.topic)),
          ]
        }

        const nextProfile = { ...current, devices, subscriptions }
        const { removed, added } = activeSubscriptionChanges(current, nextProfile)
        const saved = await window.djiApi.profiles.save(nextProfile)
        replaceProfileInState(saved)
        const { failures, disconnectError } = await syncSubscriptionChanges(profileId, removed, added)

        const telemetrySnapshot = updateTelemetrySnapshot((currentTelemetry) => {
          const next = { ...currentTelemetry }
          if (existing && existing.sn !== normalizedDevice.sn) delete next[`${profileId}:${existing.sn}`]
          const deviceKey = `${profileId}:${normalizedDevice.sn}`
          if (next[deviceKey]) {
            next[deviceKey] = {
              ...next[deviceKey],
              name: normalizedDevice.name,
              type: normalizedDevice.type,
              gatewaySn: normalizedDevice.parentSn,
            }
          }
          if (existing) {
            for (const [key, telemetry] of Object.entries(next)) {
              if (telemetry.profileId === profileId && telemetry.gatewaySn === existing.sn) {
                next[key] = { ...telemetry, gatewaySn: isGatewayType(normalizedDevice.type) ? normalizedDevice.sn : undefined }
              }
            }
          }
          return next
        })
        if (existing && existing.sn !== normalizedDevice.sn) {
          const nextArchives = deviceArchivesRef.current.filter(
            (archive) => archive.profileId !== profileId || archive.sn !== existing.sn,
          )
          deviceArchivesRef.current = nextArchives
          setDeviceArchives(nextArchives)
        }
        refreshDeviceArchives(
          saved,
          Object.values(telemetrySnapshot).filter((telemetry) => telemetry.profileId === profileId),
        )
        return { failures, disconnectError }
      })
      setSelectedDeviceSn(normalizedDevice.sn)
      setDeviceEditor(null)
      showToast(
        outcome.failures.length
          ? outcome.disconnectError
            ? `设备已保存，但 Topic 同步失败，且连接断开失败：${outcome.disconnectError}。${outcome.failures[0]}`
            : `设备已保存，但 Topic 同步失败。连接已断开，请重连。${outcome.failures[0]}`
          : '设备及默认 Topic 已保存',
        outcome.failures.length ? 'error' : 'success',
      )
    } catch (error) {
      showToast(errorMessage(error), 'error')
    }
  }

  const handleToggleDevice = async (device: DjiDevice): Promise<void> => {
    if (!activeProfile) return
    const profileId = activeProfile.id
    try {
      const outcome = await enqueueProfileOperation(profileId, async () => {
        const current = currentProfile(profileId)
        const liveAircraft = Object.values(telemetryByKeyRef.current).filter(
          (item) => item.profileId === profileId && item.type === 'aircraft' && item.gatewaySn,
        )
        const devices = withLiveAircraftRelationships(current.devices, liveAircraft)
        const currentWithRelationships: ConnectionProfile = { ...current, devices }
        const currentDevice = devices.find((item) => item.id === device.id)
        if (!currentDevice) throw new Error('设备已不存在')
        const enabled = currentDevice.enabled === false
        const nextProfile: ConnectionProfile = {
          ...current,
          devices: devices.map((item) => item.id === currentDevice.id ? { ...item, enabled } : item),
        }
        const { removed, added } = activeSubscriptionChanges(currentWithRelationships, nextProfile)
        const saved = await window.djiApi.profiles.save(nextProfile)
        replaceProfileInState(saved)
        const sync = await syncSubscriptionChanges(profileId, removed, added)
        return { ...sync, enabled }
      })
      const action = outcome.enabled ? '启用' : '禁用'
      showToast(
        outcome.failures.length
          ? outcome.disconnectError
            ? `设备已${action}，但 Topic 同步失败且连接断开失败：${outcome.disconnectError}。${outcome.failures[0]}`
            : `设备已${action}，但 Topic 同步失败。连接已断开，请重连。${outcome.failures[0]}`
          : `设备已${action}`,
        outcome.failures.length ? 'error' : 'success',
      )
    } catch (error) {
      showToast(errorMessage(error), 'error')
    }
  }

  const handleRemoveDevice = async (deviceId: string): Promise<void> => {
    if (!activeProfile) return
    const profileId = activeProfile.id
    const device = profilesRef.current.find((item) => item.id === profileId)?.devices.find((item) => item.id === deviceId)
    if (!device || !window.confirm(`确认删除设备“${device.name}”？`)) return
    try {
      const outcome = await enqueueProfileOperation(profileId, async () => {
        const current = currentProfile(profileId)
        const currentDevice = current.devices.find((item) => item.id === deviceId)
        if (!currentDevice) throw new Error('设备已不存在')
        const removedDevices = current.devices.filter(
          (item) => item.id === deviceId || item.parentSn === currentDevice.sn,
        )
        const removedSns = new Set(removedDevices.map((item) => item.sn))
        const nextProfile: ConnectionProfile = {
          ...current,
          devices: current.devices.filter((item) => !removedSns.has(item.sn)),
          subscriptions: current.subscriptions.filter(
            (subscription) => !(subscription.source === 'dji'
              && [...removedSns].some((sn) => topicBelongsToDevice(subscription.topic, sn))),
          ),
        }
        const { removed } = activeSubscriptionChanges(current, nextProfile)
        const saved = await window.djiApi.profiles.save(nextProfile)
        replaceProfileInState(saved)
        const { failures, disconnectError } = await syncSubscriptionChanges(profileId, removed, [])
        updateTelemetrySnapshot((currentTelemetry) => Object.fromEntries(
          Object.entries(currentTelemetry).filter(([, telemetry]) => telemetry.profileId !== profileId || !removedSns.has(telemetry.sn)),
        ))
        const nextArchivesForProfile = deviceArchivesRef.current.filter(
          (archive) => archive.profileId === profileId && !removedSns.has(archive.sn),
        )
        const nextArchives = [
          ...deviceArchivesRef.current.filter((archive) => archive.profileId !== profileId),
          ...nextArchivesForProfile,
        ]
        deviceArchivesRef.current = nextArchives
        setDeviceArchives(nextArchives)
        await window.djiApi.deviceArchives.replaceProfile(profileId, nextArchivesForProfile)
        return { failures, disconnectError, removedSns, fallbackSn: saved.devices[0]?.sn ?? '' }
      })
      setSelectedDeviceSn((current) => outcome.removedSns.has(current) ? outcome.fallbackSn : current)
      setDeviceEditor(null)
      showToast(
        outcome.failures.length
          ? outcome.disconnectError
            ? `设备已删除，但 Topic 取消失败，且连接断开失败：${outcome.disconnectError}。${outcome.failures[0]}`
            : `设备已删除，但 Topic 取消失败。连接已断开，请重连。${outcome.failures[0]}`
          : '设备已删除',
        outcome.failures.length ? 'error' : 'success',
      )
    } catch (error) {
      showToast(errorMessage(error), 'error')
    }
  }

  const handleToggleSubscription = async (subscription: TopicSubscription): Promise<void> => {
    if (!activeProfile) return
    const profileId = activeProfile.id
    try {
      await enqueueProfileOperation(profileId, async () => {
        const current = currentProfile(profileId)
        const currentSubscription = current.subscriptions.find((item) => item.id === subscription.id)
        if (!currentSubscription) throw new Error('订阅已不存在')
        const enabled = !currentSubscription.enabled
        const nextProfile: ConnectionProfile = {
          ...current,
          subscriptions: current.subscriptions.map((item) => item.id === currentSubscription.id ? { ...item, enabled } : item),
        }
        const wasActive = isSubscriptionActive(current, currentSubscription)
        const nextSubscription = nextProfile.subscriptions.find((item) => item.id === currentSubscription.id)!
        const willBeActive = isSubscriptionActive(nextProfile, nextSubscription)
        if (statusesRef.current[profileId] === 'connected' && wasActive !== willBeActive) {
          const result = willBeActive
            ? await window.djiApi.mqtt.subscribe(profileId, nextSubscription.topic, nextSubscription.qos)
            : await window.djiApi.mqtt.unsubscribe(profileId, nextSubscription.topic)
          if (!result.ok) throw new Error(result.error ?? '订阅操作失败')
        }
        const saved = await window.djiApi.profiles.save(nextProfile)
        replaceProfileInState(saved)
      })
    } catch (error) {
      showToast(errorMessage(error), 'error')
    }
  }

  const handleSetSubscriptionsEnabled = async (
    subscriptions: TopicSubscription[],
    enabled: boolean,
    all = false,
  ): Promise<void> => {
    if (!activeProfile) return
    const profileId = activeProfile.id
    const subscriptionIds = new Set(subscriptions.map((item) => item.id))
    try {
      const outcome = await enqueueProfileOperation(profileId, async () => {
        const current = currentProfile(profileId)
        const changedSubscriptions = current.subscriptions.filter(
          (item) => subscriptionIds.has(item.id) && item.enabled !== enabled,
        )
        if (!changedSubscriptions.length) return { failures: [], disconnectError: undefined }

        const nextProfile: ConnectionProfile = {
          ...current,
          subscriptions: current.subscriptions.map(
            (item) => subscriptionIds.has(item.id) ? { ...item, enabled } : item,
          ),
        }
        const { removed, added } = activeSubscriptionChanges(current, nextProfile)
        const saved = await window.djiApi.profiles.save(nextProfile)
        replaceProfileInState(saved)
        return syncSubscriptionChanges(profileId, removed, added)
      })

      const action = enabled ? '启用' : '禁用'
      const scope = all ? 'Topic 已全部' : '分组 Topic 已'
      showToast(
        outcome.failures.length
          ? outcome.disconnectError
            ? `${scope}${action}，但同步失败且连接断开失败：${outcome.disconnectError}。${outcome.failures[0]}`
            : `${scope}${action}，但同步失败。连接已断开，请重连。${outcome.failures[0]}`
          : `${scope}${action}`,
        outcome.failures.length ? 'error' : 'success',
      )
    } catch (error) {
      showToast(errorMessage(error), 'error')
    }
  }

  const handleAddSubscription = async (topic: string, qos: MqttQos): Promise<void> => {
    if (!activeProfile) return
    const profileId = activeProfile.id
    try {
      await enqueueProfileOperation(profileId, async () => {
        const current = currentProfile(profileId)
        if (current.subscriptions.some((item) => item.topic === topic)) throw new Error('这个 Topic 已存在')
        const nextSubscription: TopicSubscription = {
          id: crypto.randomUUID(),
          topic,
          qos,
          enabled: true,
          source: 'custom',
        }
        const nextProfile: ConnectionProfile = {
          ...current,
          subscriptions: [...current.subscriptions, nextSubscription],
        }
        if (statusesRef.current[profileId] === 'connected' && isSubscriptionActive(nextProfile, nextSubscription)) {
          const result = await window.djiApi.mqtt.subscribe(profileId, topic, qos)
          if (!result.ok) throw new Error(result.error ?? '订阅失败')
        }
        const saved = await window.djiApi.profiles.save(nextProfile)
        replaceProfileInState(saved)
      })
    } catch (error) {
      showToast(errorMessage(error), 'error')
    }
  }

  const handleRemoveSubscription = async (subscription: TopicSubscription): Promise<void> => {
    if (!activeProfile) return
    const profileId = activeProfile.id
    try {
      await enqueueProfileOperation(profileId, async () => {
        const current = currentProfile(profileId)
        const currentSubscription = current.subscriptions.find((item) => item.id === subscription.id)
        if (!currentSubscription) throw new Error('订阅已不存在')
        if (currentSubscription.source === 'dji') throw new Error('系统内置 Topic 不可删除，可以将其禁用')
        if (statusesRef.current[profileId] === 'connected' && isSubscriptionActive(current, currentSubscription)) {
          const result = await window.djiApi.mqtt.unsubscribe(profileId, currentSubscription.topic)
          if (!result.ok) throw new Error(result.error ?? '取消订阅失败')
        }
        const saved = await window.djiApi.profiles.save({
          ...current,
          subscriptions: current.subscriptions.filter((item) => item.id !== currentSubscription.id),
        })
        replaceProfileInState(saved)
      })
    } catch (error) {
      showToast(errorMessage(error), 'error')
    }
  }

  const handlePublish = async (
    topic: string,
    payload: string,
    qos: MqttQos,
    retain: boolean,
  ): Promise<OperationResult> => {
    const profile = profilesRef.current.find((item) => item.id === activeProfileId)
    if (!profile) return { ok: false, error: '请先选择连接' }
    if (statusesRef.current[profile.id] !== 'connected') return { ok: false, error: '当前连接尚未就绪' }
    if (profileMutationCountsRef.current[profile.id] || subscriptionSyncingRef.current[profile.id]) {
      return { ok: false, error: '连接配置或订阅正在同步，请稍候' }
    }
    return window.djiApi.mqtt.publish({ profileId: profile.id, topic, payload, qos, retain })
  }

  const handleServiceCall: ServiceCaller = async (gatewaySn, method, data, timeoutMs = SERVICE_REPLY_TIMEOUT_MS) => {
    const profile = profilesRef.current.find((item) => item.id === activeProfileId)
    if (!profile) return { ok: false, tid: '', error: '请先选择连接' }

    const payload = buildServicePayload(method, data)
    const request = JSON.parse(payload) as { tid: string; bid?: string }
    const key = serviceReplyKey(profile.id, gatewaySn, request.tid)
    const replyPromise = new Promise<ServiceCallResult>((resolve) => {
      const timer = window.setTimeout(() => {
        pendingServiceRepliesRef.current.delete(key)
        resolve({
          ok: false,
          tid: request.tid,
          bid: request.bid,
          error: `等待设备 services_reply 超时（${Math.round(timeoutMs / 1_000)} 秒）`,
        })
      }, timeoutMs)
      pendingServiceRepliesRef.current.set(key, {
        profileId: profile.id,
        bid: request.bid,
        timer,
        resolve,
      })
    })

    try {
      const published = await handlePublish(`thing/product/${gatewaySn}/services`, payload, 1, false)
      if (published.ok) return replyPromise
      const pending = pendingServiceRepliesRef.current.get(key)
      if (pending) window.clearTimeout(pending.timer)
      pendingServiceRepliesRef.current.delete(key)
      return { ok: false, tid: request.tid, bid: request.bid, error: published.error ?? '指令发送失败' }
    } catch (error) {
      const pending = pendingServiceRepliesRef.current.get(key)
      if (pending) window.clearTimeout(pending.timer)
      pendingServiceRepliesRef.current.delete(key)
      return { ok: false, tid: request.tid, bid: request.bid, error: errorMessage(error) }
    }
  }

  const handleExport = async (records: MqttMessageRecord[] = activeRecords): Promise<void> => {
    if (!activeProfile) return
    if (!records.length) {
      showToast('当前没有可导出的消息', 'error')
      return
    }
    const result = await window.djiApi.dialogs.exportMessages({ profileName: activeProfile.name, records })
    if (result.ok) showToast(`已导出 ${records.length} 条消息`, 'success')
  }

  if (loading) {
    return <div className="app-loading"><RadioTower size={28} /><span>正在加载工作台…</span></div>
  }

  if (!activeProfile) {
    return (
      <div className="app-loading">
        <CircleAlert size={28} />
        <span>没有可用连接</span>
        <button className="button primary" onClick={() => setConnectionEditor({ profile: createProfile(), isNew: true })}>新建连接</button>
      </div>
    )
  }

  const connected = activeStatus === 'connected'
  const connectionTransitioning = activeStatus === 'connecting' || activeStatus === 'reconnecting'
  const profileMutationBusy = Boolean(profileMutationCounts[activeProfile.id])
  const runtimeBusy = profileMutationBusy || Boolean(subscriptionSyncing[activeProfile.id])

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="brand-block">
          <span className="brand-mark"><RadioTower size={18} /></span>
          <div><strong>大疆云调试台</strong><small>DJI Cloud Studio</small></div>
        </div>
        <div className="titlebar-context">
          <span className={`status-dot ${activeStatus}`} />
          <strong>{activeProfile.name}</strong>
          <span>{activeProfile.protocol}://{activeProfile.host}:{activeProfile.port}</span>
        </div>
        <div className="titlebar-actions">
          <Tooltip label="导出全部消息">
            <button className="icon-button" onClick={() => void handleExport()}><Download size={16} /></button>
          </Tooltip>
          <Tooltip label="连接设置">
            <button className="icon-button" onClick={() => setConnectionEditor({ profile: activeProfile, isNew: false })}><Settings size={16} /></button>
          </Tooltip>
          <button className={`button connection-button ${connected ? 'connected' : ''}`} disabled={profileMutationBusy} onClick={() => void handleConnectToggle()}>
            {connected ? <Unplug size={15} /> : <Power size={15} />}
            {profileMutationBusy ? '保存中' : connectionTransitioning ? statusCopy[activeStatus] : connected ? '断开' : '连接'}
          </button>
        </div>
      </header>

      <div
        className={`app-body ${activeView !== 'overview' ? 'wide-mode' : ''} ${activeView === 'overview' && sidebarCollapsed ? 'sidebar-collapsed' : ''} ${sidebarResizing ? 'sidebar-resizing' : ''}`}
        style={{ '--app-sidebar-width': `${sidebarWidth}px` } as CSSProperties}
      >
        <nav className="app-rail" aria-label="主导航">
          <div className="rail-top">
            <Tooltip label="设备工作台">
              <button className={activeView === 'overview' ? 'active' : ''} onClick={() => setActiveView('overview')}><LayoutDashboard size={20} /></button>
            </Tooltip>
            <Tooltip label="媒体中心">
              <button className={activeView === 'media' ? 'active' : ''} onClick={() => setActiveView('media')}><MonitorPlay size={20} /></button>
            </Tooltip>
            <Tooltip label="OSS 管理">
              <button className={activeView === 'oss' ? 'active' : ''} onClick={() => setActiveView('oss')}><Database size={20} /></button>
            </Tooltip>
          </div>
          <div className="rail-bottom">
            <Tooltip label="错误码管理">
              <button className={activeView === 'errors' ? 'active' : ''} onClick={() => setActiveView('errors')}><CircleAlert size={20} /></button>
            </Tooltip>
            <Tooltip label="遥测项管理">
              <button className={activeView === 'telemetry' ? 'active' : ''} onClick={() => setActiveView('telemetry')}><ListTree size={20} /></button>
            </Tooltip>
            <Tooltip label="关于">
              <button onClick={() => setAboutOpen(true)}><Info size={20} /></button>
            </Tooltip>
          </div>
        </nav>

        {activeView === 'overview' && (
          <>
            {!sidebarCollapsed && (
              <div
                className="sidebar-resize-handle"
                role="separator"
                aria-label="调整侧栏宽度"
                aria-orientation="vertical"
                aria-valuemin={MIN_SIDEBAR_WIDTH}
                aria-valuemax={MAX_SIDEBAR_WIDTH}
                aria-valuenow={sidebarWidth}
                tabIndex={0}
                onPointerDown={startSidebarResize}
                onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                  event.preventDefault()
                  setSidebarWidth((current) => clampSidebarWidth(current + (event.key === 'ArrowRight' ? 12 : -12)))
                }}
              />
            )}
            <div className="sidebar-edge-toggle-slot">
              <Tooltip label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}>
                <button
                  className="sidebar-edge-toggle"
                  aria-expanded={!sidebarCollapsed}
                  aria-controls="device-sidebar"
                  onClick={() => setSidebarCollapsed((current) => !current)}
                >
                  {sidebarCollapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
                </button>
              </Tooltip>
            </div>
          </>
        )}

        {activeView === 'overview' && (
          <Sidebar
            profiles={profiles}
            activeProfileId={activeProfileId}
            statuses={statuses}
            busy={runtimeBusy}
            telemetry={activeTelemetry}
            selectedDeviceSn={selectedDeviceSn}
            onSelectProfile={setActiveProfileId}
            onAddProfile={() => setConnectionEditor({ profile: createProfile(), isNew: true })}
            onEditProfile={(profile) => setConnectionEditor({ profile, isNew: false })}
            onAddDevice={() => setDeviceEditor({ device: createDevice(), isNew: true })}
            onEditDevice={(device) => setDeviceEditor({ device, isNew: false })}
            onRemoveDevice={handleRemoveDevice}
            onSelectDevice={setSelectedDeviceSn}
            onToggleDevice={handleToggleDevice}
            onToggleSubscription={handleToggleSubscription}
            onSetSubscriptionsEnabled={handleSetSubscriptionsEnabled}
            onAddSubscription={handleAddSubscription}
            onRemoveSubscription={handleRemoveSubscription}
          />
        )}

        <main className={`workspace ${activeView === 'overview' ? 'device-workspace' : ''}`}>
          {activeView !== 'overview' && (
            <header className="workspace-header">
              <div>
                <span className="eyebrow">{viewMeta[activeView].description}</span>
                <h1>{viewMeta[activeView].label}</h1>
              </div>
              {activeView === 'media' ? (
                <div className="workspace-status">
                  <span className={`connection-state ${activeStatus}`}><Activity size={14} />{statusCopy[activeStatus]}</span>
                  {subscriptionSyncing[activeProfile.id] && <span>正在恢复订阅</span>}
                  <span>{activeRecords.length.toLocaleString()} 条消息</span>
                  <span>{activeTelemetry.length} 台已发现设备</span>
                </div>
              ) : activeView === 'errors' ? (
                <div className="workspace-status">
                  <span>{errorCodeStats.cloud} 条上云错误码</span>
                  <span>{errorCodeStats.hms} 条 HMS 告警</span>
                  <span>{errorCodeStats.faq} 条常见问题</span>
                </div>
              ) : activeView === 'telemetry' ? (
                <div className="workspace-status">
                  <span>{Object.values(effectiveTelemetryLayout.devices).reduce((count, layout) => count + layout.fields.length, 0)} 个配置字段</span>
                  <span>本地自动保存</span>
                </div>
              ) : (
                <div className="workspace-status">
                  <span>远程日志共用配置</span>
                  <span>本地保存</span>
                </div>
              )}
            </header>
          )}
          <div className={`workspace-content ${activeView}-content`}>
            <div key={activeProfile.id} className="persistent-overview" hidden={activeView !== 'overview'}>
              <Overview
                profile={activeProfile}
                status={activeStatus}
                busy={runtimeBusy}
                telemetry={activeTelemetry}
                selectedDeviceSn={selectedDeviceSn}
                records={activeRecords}
                transactions={transactions}
                telemetryLayout={effectiveTelemetryLayout}
                onPublish={handlePublish}
                onService={handleServiceCall}
                onExport={handleExport}
                onClear={() => setRecordsByProfile((current) => ({ ...current, [activeProfile.id]: [] }))}
                onNotify={showToast}
                onOpenOssManager={() => setActiveView('oss')}
                objectStorageProfiles={objectStorageProfiles}
                activeObjectStorageId={activeObjectStorageId}
                onSelectObjectStorage={setActiveObjectStorageId}
                mediaServers={mediaServers}
              />
            </div>
            {activeView === 'media' && (
              <MediaCenter
                servers={mediaServers}
                runtimeById={mediaServerRuntimes}
                loading={mediaServersLoading}
                onServersChange={setMediaServers}
                onRuntimeChange={updateMediaServerRuntime}
                onNotify={showToast}
              />
            )}
            {activeView === 'oss' && (
              <OssManager
                profiles={objectStorageProfiles}
                selectedId={activeObjectStorageId}
                onSelect={setActiveObjectStorageId}
                onSave={handleObjectStorageSave}
                onRemove={handleObjectStorageRemove}
                onNotify={showToast}
              />
            )}
            {activeView === 'errors' && <ErrorCodeManager />}
            {activeView === 'telemetry' && (
              <TelemetryManager
                config={effectiveTelemetryLayout}
                onChange={handleTelemetryLayoutChange}
                onNotify={showToast}
              />
            )}
          </div>
        </main>
      </div>

      {connectionEditor && (
        <ConnectionModal
          profile={connectionEditor.profile}
          isNew={connectionEditor.isNew}
          onClose={() => setConnectionEditor(null)}
          onSave={handleSaveProfile}
          onRemove={handleRemoveProfile}
        />
      )}
      {deviceEditor && (
        <DeviceModal
          device={deviceEditor.device}
          isNew={deviceEditor.isNew}
          gatewayDevices={activeProfile.devices.filter((device) => isGatewayType(device.type))}
          onClose={() => setDeviceEditor(null)}
          onSave={handleSaveDevice}
          onRemove={handleRemoveDevice}
        />
      )}
      {aboutOpen && <AboutModal onClose={() => setAboutOpen(false)} />}
      {toast && (
        <div key={toast.id} className={`toast ${toast.tone}`} role="status" aria-live="polite">
          {toast.tone === 'success' ? <CheckCircle2 size={16} /> : toast.tone === 'error' ? <CircleAlert size={16} /> : <Info size={16} />}
          <span>{toast.text}</span>
        </div>
      )}
    </div>
  )
}
