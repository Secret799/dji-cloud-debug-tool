import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Aperture,
  Binary,
  Camera,
  ChevronDown,
  CircleStop,
  Copy,
  Crosshair,
  LockKeyhole,
  Maximize2,
  Pause,
  Play,
  RotateCcw,
  Video,
  X,
} from 'lucide-react'
import type {
  ConnectionProfile,
  ConnectionStatus,
  DeviceProvider,
  MediaServerProfile,
  MqttQos,
  OperationResult,
  SeiMessageDetail,
  SeiParserEvent,
  SeiParserStartRequest,
} from '../../../shared/contracts'
import { LivePlayer } from '../components/LivePlayer'
import { Tooltip } from '../components/Tooltip'
import {
  cameraStreamName,
  collectCameraSources,
  normalizeLiveResultCode,
  videoTypeLabel,
  type CameraSource,
  type CameraVideoStream,
} from '../lib/camera'
import {
  buildServicePayload,
  DJI_COMMANDS,
  type DeviceTelemetry,
  type ServiceCaller,
  type ServiceCallResult,
} from '../lib/dji'
import {
  buildMediaEndpoints,
  selectMediaPlaybackEndpoint,
  type MediaPlaybackProtocol,
  type StreamEndpoints,
} from '../lib/media'
import { formatJsonText } from '../lib/json'

interface CameraCenterProps {
  profile: ConnectionProfile
  telemetry: DeviceTelemetry[]
  gatewaySn: string
  provider: DeviceProvider
  status: ConnectionStatus
  busy: boolean
  mediaServers: MediaServerProfile[]
  selectedMediaServerId: string
  onSelectMediaServer: (id: string) => void
  onPublish: (topic: string, payload: string, qos: MqttQos, retain: boolean) => Promise<OperationResult>
  onService?: ServiceCaller
  onNotify?: (text: string, tone?: 'info' | 'success' | 'error') => void
}

interface ActivePlayback {
  stream: CameraVideoStream
  protocol: MediaPlaybackProtocol
  playbackUrl: string
  streamUrl: string
  seiSessionId?: string
}

type PushProtocol = 'rtmp' | 'webrtc'
type SeiDetailFormat = 'text' | 'json' | 'hex' | 'base64'

export const selectCameraPushEndpoint = (
  provider: DeviceProvider,
  serverKind: MediaServerProfile['kind'],
  endpoints: StreamEndpoints,
  pushProtocol: PushProtocol,
): string | undefined => {
  if (pushProtocol === 'rtmp') return endpoints.rtmp
  if (provider === 'superdock') return endpoints.whip
  return serverKind === 'remote-easymedia' ? endpoints.whip : endpoints.webrtc
}

export const isCameraLiveQualityLocked = (
  provider: DeviceProvider,
  sourceType: CameraSource['sourceType'],
  live: boolean,
): boolean => provider === 'superdock' && sourceType === 'dock' && live

const qualityOptions = [
  { value: 0, label: '自适应' },
  { value: 1, label: '流畅' },
  { value: 2, label: '标清' },
  { value: 3, label: '高清' },
  { value: 4, label: '超清' },
]

const dockCameraPositions = [
  { value: 0, label: '舱内' },
  { value: 1, label: '舱外' },
]

const cameraActions = [
  { id: 'payload-authority-grab', icon: LockKeyhole },
  { id: 'camera-photo', icon: Camera },
  { id: 'camera-record-start', icon: Video },
  { id: 'camera-record-stop', icon: CircleStop },
  { id: 'gimbal-reset', icon: RotateCcw },
]

const videoLensTypes = (video: CameraVideoStream): string[] => [...new Set(
  [...video.switchableVideoTypes, video.videoType],
)].filter(Boolean)

const cameraLensTypes = (videos: CameraVideoStream[]): string[] => [...new Set(
  videos.flatMap(videoLensTypes),
)]

const LIVE_ERROR_MESSAGES: Record<number, string> = {
  13001: '未发现飞行器',
  13002: '未发现相机',
  13003: '相机已经在向旧地址直播',
  13004: '设备不支持此功能',
  13005: '设备不支持此直播策略',
  13006: 'Pilot 当前不在相机界面',
  13007: '遥控器没有飞行控制权',
  13008: '当前没有可用视频数据',
  13009: '操作过于频繁',
  13010: '推流服务启用失败',
  13011: '当前没有直播流',
  13012: '已有其他相机直播，不能直接切换',
  13013: '设备不支持此推流协议',
  13014: '直播参数异常或不完整',
  13015: '设备网络拥塞',
  13016: '设备视频解码失败',
  13099: '设备内部错误',
}

const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => {
  window.setTimeout(resolve, milliseconds)
})

const liveCommandError = (result: ServiceCallResult, fallback: string): string => {
  if (result.result !== undefined) {
    return `${fallback}（${result.result}：${LIVE_ERROR_MESSAGES[normalizeLiveResultCode(result.result) ?? result.result] ?? '设备拒绝了指令'}）`
  }
  return result.error ?? fallback
}

const hasLiveResult = (result: ServiceCallResult, code: number): boolean =>
  normalizeLiveResultCode(result.result) === code

const seiStatusLabel = (event?: SeiParserEvent): string => {
  if (!event || event.state === 'waiting') return '等待码流'
  if (event.state === 'error') return '解析异常'
  if (event.state === 'stopped') return '已停止'
  return event.seiMessages ? `已解析 ${event.seiMessages} 条` : '解析中 · 未发现 SEI'
}

export function CameraCenter({
  profile,
  telemetry,
  gatewaySn,
  provider,
  status,
  busy,
  mediaServers,
  selectedMediaServerId,
  onSelectMediaServer,
  onPublish,
  onService,
  onNotify,
}: CameraCenterProps) {
  const isSuperDock = provider === 'superdock'
  const providerLabel = isSuperDock ? 'SuperDock' : 'DJI'
  const realtimePushLabel = isSuperDock ? 'WHIP' : 'WebRTC'
  const cameras = useMemo(() => {
    return collectCameraSources(profile, telemetry).filter((camera) => camera.gatewaySn === gatewaySn)
  }, [gatewaySn, profile, telemetry])
  const [selectedCameraId, setSelectedCameraId] = useState(cameras[0]?.id ?? '')
  const selectedCamera = cameras.find((camera) => camera.id === selectedCameraId) ?? cameras[0]
  const [selectedVideoId, setSelectedVideoId] = useState(selectedCamera?.videos[0]?.id ?? '')
  const selectedVideo = selectedCamera?.videos.find((video) => video.id === selectedVideoId) ?? selectedCamera?.videos[0]
  const videoSources = useMemo(
    () => cameras.flatMap((camera) => camera.videos.map((video) => ({ camera, video }))),
    [cameras],
  )
  const [pushProtocol, setPushProtocol] = useState<PushProtocol>('rtmp')
  const compatibleMediaServers = useMemo(
    () => mediaServers.filter((server) => pushProtocol === 'webrtc'
      ? (() => {
          const endpoints = buildMediaEndpoints(server, 'live', 'probe')
          return Boolean(selectCameraPushEndpoint(provider, server.kind, endpoints, pushProtocol) && endpoints.whep)
        })()
      : server.rtmpPort > 0),
    [mediaServers, provider, pushProtocol],
  )
  const selectedServer = compatibleMediaServers.find((server) => server.id === selectedMediaServerId) ?? compatibleMediaServers[0]
  const [quality, setQuality] = useState(2)
  const [sending, setSending] = useState('')
  const [playbacks, setPlaybacks] = useState<Record<string, ActivePlayback>>({})
  const [seiEvents, setSeiEvents] = useState<Record<string, SeiParserEvent>>({})
  const [seiDetailStreamId, setSeiDetailStreamId] = useState<string>()
  const [selectedSeiMessageId, setSelectedSeiMessageId] = useState<string>()
  const [seiMessageDetail, setSeiMessageDetail] = useState<SeiMessageDetail>()
  const [seiDetailFormat, setSeiDetailFormat] = useState<SeiDetailFormat>('text')
  const [seiDetailError, setSeiDetailError] = useState('')
  const [pausedSeiEvent, setPausedSeiEvent] = useState<SeiParserEvent>()
  const seiSessionIdsRef = useRef(new Set<string>())
  const [selectedLensTypes, setSelectedLensTypes] = useState<Record<string, string>>({})
  const [selectedDockCameraPositions, setSelectedDockCameraPositions] = useState<Record<string, number>>({})
  const [selectedQualities, setSelectedQualities] = useState<Record<string, number>>({})
  const hasActivePlaybacks = Object.keys(playbacks).length > 0
  const qualityForVideo = (video: CameraVideoStream): number =>
    selectedQualities[video.id] ?? video.videoQuality ?? quality
  useEffect(() => {
    if (!cameras.length) {
      setSelectedCameraId('')
      return
    }
    if (!cameras.some((camera) => camera.id === selectedCameraId)) setSelectedCameraId(cameras[0].id)
  }, [cameras, selectedCameraId])

  useEffect(() => {
    if (!selectedCamera?.videos.length) {
      setSelectedVideoId('')
      return
    }
    if (!selectedCamera.videos.some((video) => video.id === selectedVideoId)) {
      setSelectedVideoId(selectedCamera.videos[0].id)
    }
  }, [selectedCamera, selectedVideoId])

  useEffect(() => window.djiApi.media.onSeiParserEvent((event) => {
    setSeiEvents((current) => ({ ...current, [event.sessionId]: event }))
  }), [])

  const detailPlayback = seiDetailStreamId ? playbacks[seiDetailStreamId] : undefined
  const detailCamera = detailPlayback
    ? cameras.find((camera) => camera.sourceSn === detailPlayback.stream.sourceSn && camera.cameraIndex === detailPlayback.stream.cameraIndex)
    : undefined
  const liveDetailSeiEvent = detailPlayback?.seiSessionId ? seiEvents[detailPlayback.seiSessionId] : undefined
  const detailSeiEvent = pausedSeiEvent?.sessionId === detailPlayback?.seiSessionId
    ? pausedSeiEvent
    : liveDetailSeiEvent
  const detailMessages = detailSeiEvent?.latestMessages ?? []
  const formattedSeiJson = formatJsonText(seiMessageDetail?.text)
  const seiDetailValue = !seiMessageDetail
    ? undefined
    : seiDetailFormat === 'text'
      ? seiMessageDetail.text
      : seiDetailFormat === 'json'
        ? formattedSeiJson
        : seiMessageDetail[seiDetailFormat]

  useEffect(() => {
    if (!seiDetailStreamId) return
    if (!detailPlayback || !detailMessages.length) {
      setSeiDetailStreamId(undefined)
      setSelectedSeiMessageId(undefined)
      setSeiMessageDetail(undefined)
      setSeiDetailError('')
      setPausedSeiEvent(undefined)
      return
    }
    if (!selectedSeiMessageId || !detailMessages.some((message) => message.id === selectedSeiMessageId)) {
      setSelectedSeiMessageId(detailMessages[0].id)
    }
  }, [detailMessages, detailPlayback, seiDetailStreamId, selectedSeiMessageId])

  useEffect(() => {
    const sessionId = detailPlayback?.seiSessionId
    if (!sessionId || !selectedSeiMessageId) return
    let current = true
    setSeiMessageDetail(undefined)
    setSeiDetailError('')
    void window.djiApi.media.getSeiMessageDetail({ sessionId, messageId: selectedSeiMessageId })
      .then((result) => {
        if (!current) return
        if (!result.ok || !result.message) {
          setSeiDetailError(result.error ?? '无法读取 SEI 消息详情')
          return
        }
        setSeiMessageDetail(result.message)
        setSeiDetailFormat((format) => format === 'text' && !result.message?.text ? 'hex' : format)
      })
      .catch((error) => {
        if (current) setSeiDetailError(error instanceof Error ? error.message : String(error))
      })
    return () => { current = false }
  }, [detailPlayback?.seiSessionId, selectedSeiMessageId])

  useEffect(() => {
    if (!seiDetailStreamId) return undefined
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSeiDetailStreamId(undefined)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [seiDetailStreamId])

  useEffect(() => () => {
    for (const sessionId of seiSessionIdsRef.current) {
      void window.djiApi.media.stopSeiParser(sessionId)
    }
    seiSessionIdsRef.current.clear()
  }, [])

  const startSeiParser = async (
    video: CameraVideoStream,
    request?: Pick<SeiParserStartRequest, 'source' | 'url'>,
  ): Promise<string | undefined> => {
    if (!request) return undefined
    try {
      const result = await window.djiApi.media.startSeiParser({ streamId: video.id, ...request })
      if (!result.ok || !result.sessionId) {
        onNotify?.(`视频已开始播放，但 SEI 解析未启动：${result.error ?? '未知错误'}`, 'error')
        return undefined
      }
      seiSessionIdsRef.current.add(result.sessionId)
      return result.sessionId
    } catch (error) {
      onNotify?.(`视频已开始播放，但 SEI 解析未启动：${error instanceof Error ? error.message : String(error)}`, 'error')
      return undefined
    }
  }

  const stopSeiParser = (sessionId?: string): void => {
    if (!sessionId) return
    seiSessionIdsRef.current.delete(sessionId)
    setSeiEvents((current) => {
      const next = { ...current }
      delete next[sessionId]
      return next
    })
    void window.djiApi.media.stopSeiParser(sessionId)
  }

  const openSeiDetail = (streamId: string, event: SeiParserEvent): void => {
    if (!event.latestMessages.length) return
    setPausedSeiEvent(undefined)
    setSeiDetailStreamId(streamId)
    setSelectedSeiMessageId(event.latestMessages[0].id)
    setSeiMessageDetail(undefined)
    setSeiDetailFormat('text')
    setSeiDetailError('')
  }

  const closeSeiDetail = (): void => {
    setPausedSeiEvent(undefined)
    setSeiDetailStreamId(undefined)
    setSelectedSeiMessageId(undefined)
    setSeiMessageDetail(undefined)
    setSeiDetailError('')
  }

  const toggleSeiDetailPause = (): void => {
    if (pausedSeiEvent) {
      setPausedSeiEvent(undefined)
      return
    }
    if (liveDetailSeiEvent) {
      setPausedSeiEvent({
        ...liveDetailSeiEvent,
        latestMessages: liveDetailSeiEvent.latestMessages.map((message) => ({ ...message })),
      })
    }
  }

  const publishService = async (
    gatewaySn: string,
    method: string,
    data: Record<string, unknown>,
  ): Promise<ServiceCallResult> => {
    if (onService) return onService(gatewaySn, method, data)
    const payload = buildServicePayload(method, data)
    const request = JSON.parse(payload) as { tid: string; bid?: string }
    const result = await onPublish(`thing/product/${gatewaySn}/services`, payload, 1, false)
    return { ...result, tid: request.tid, bid: request.bid }
  }

  const publishLiveService = async (
    gatewaySn: string,
    method: string,
    data: Record<string, unknown>,
  ): Promise<ServiceCallResult> => {
    let result = await publishService(gatewaySn, method, data)
    if (hasLiveResult(result, 13009)) {
      await wait(1_200)
      result = await publishService(gatewaySn, method, data)
    }
    return result
  }

  const stopDeviceStream = async (video: CameraVideoStream): Promise<ServiceCallResult> =>
    publishLiveService(video.gatewaySn, 'live_stop_push', { video_id: video.id })

  const startDeviceStream = async (
    video: CameraVideoStream,
    pushUrl: string,
    webRtc: boolean,
  ): Promise<ServiceCallResult> => {
    let stoppedExisting = false
    if (video.status === 1) {
      const stopped = await stopDeviceStream(video)
      if (!stopped.ok && !hasLiveResult(stopped, 13011)) return stopped
      stoppedExisting = true
      await wait(800)
    }

    const start = (): Promise<ServiceCallResult> => publishLiveService(video.gatewaySn, 'live_start_push', {
      url_type: webRtc ? 4 : 1,
      url: pushUrl,
      video_id: video.id,
      video_quality: qualityForVideo(video),
    })
    let result = await start()
    if (hasLiveResult(result, 13003) && !stoppedExisting) {
      const stopped = await stopDeviceStream(video)
      if (!stopped.ok && !hasLiveResult(stopped, 13011)) return stopped
      await wait(800)
      result = await start()
    }
    return result
  }

  const stopPlayback = async (current: ActivePlayback): Promise<boolean> => {
    setSending(`stop:${current.stream.id}`)
    try {
      const response = await stopDeviceStream(current.stream)
      if (!response.ok && !hasLiveResult(response, 13011)) {
        onNotify?.(liveCommandError(response, '停止推流失败'), 'error')
        return false
      }
      stopSeiParser(current.seiSessionId)
      setPlaybacks((active) => {
        const next = { ...active }
        delete next[current.stream.id]
        return next
      })
      onNotify?.('设备已停止推流', 'success')
      return true
    } catch (error) {
      onNotify?.(error instanceof Error ? error.message : String(error), 'error')
      return false
    } finally {
      setSending('')
    }
  }

  const stopAllPlaybacks = async (): Promise<void> => {
    const activePlaybacks = Object.values(playbacks)
    if (!activePlaybacks.length) return
    setSending('stop-all')
    try {
      const results: ServiceCallResult[] = []
      for (const current of activePlaybacks) {
        results.push(await stopDeviceStream(current.stream))
        if (current !== activePlaybacks.at(-1)) await wait(350)
      }
      const failedIds = activePlaybacks
        .filter((_, index) => !results[index]?.ok && !hasLiveResult(results[index], 13011))
        .map((current) => current.stream.id)
      activePlaybacks.forEach((current) => {
        if (!failedIds.includes(current.stream.id)) stopSeiParser(current.seiSessionId)
      })
      setPlaybacks((active) => Object.fromEntries(
        Object.entries(active).filter(([id]) => failedIds.includes(id)),
      ))
      onNotify?.(failedIds.length ? `${failedIds.length} 路视频停止失败` : '已停止全部视频', failedIds.length ? 'error' : 'success')
    } catch (error) {
      onNotify?.(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setSending('')
    }
  }

  const startAllPlaybacks = async (): Promise<void> => {
    if (!selectedServer) {
      onNotify?.('请先在媒体中心配置流媒体服务器', 'error')
      return
    }
    if (status !== 'connected' || busy) {
      onNotify?.(status !== 'connected' ? 'MQTT 连接尚未就绪' : '连接配置正在同步，请稍候', 'error')
      return
    }

    const activeCounts = new Map<string, number>()
    Object.values(playbacks).forEach((current) => {
      const key = `${current.stream.sourceSn}:${current.stream.cameraIndex}`
      activeCounts.set(key, (activeCounts.get(key) ?? 0) + 1)
    })
    let limitedCount = 0
    const candidates = videoSources.filter(({ camera, video }) => {
      if (playbacks[video.id]) return false
      const key = `${video.sourceSn}:${video.cameraIndex}`
      const activeCount = activeCounts.get(key) ?? 0
      if (camera.coexistVideoNumberMax && activeCount >= camera.coexistVideoNumberMax) {
        limitedCount += 1
        return false
      }
      activeCounts.set(key, activeCount + 1)
      return true
    })
    if (!candidates.length) {
      onNotify?.(limitedCount ? '设备并发视频路数已达到上限' : '全部视频已经在播放', limitedCount ? 'error' : 'info')
      return
    }

    const webRtc = pushProtocol === 'webrtc'
    const prepared = candidates.flatMap(({ video }) => {
      const endpoints = buildMediaEndpoints(selectedServer, 'live', cameraStreamName(video))
      const localEndpoints = selectedServer.kind === 'local-zlm'
        ? buildMediaEndpoints({ ...selectedServer, host: '127.0.0.1' }, 'live', cameraStreamName(video))
        : endpoints
      const pushUrl = webRtc
        ? selectCameraPushEndpoint(provider, selectedServer.kind, endpoints, pushProtocol)
        : endpoints.rtmp
      const playbackEndpoint = selectMediaPlaybackEndpoint(endpoints, pushProtocol)
      const streamUrl = webRtc ? endpoints.whep : endpoints.rtmp
      const seiRequest: Pick<SeiParserStartRequest, 'source' | 'url'> | undefined =
        webRtc && selectedServer.kind === 'local-zlm' && localEndpoints.rtsp
          ? { source: 'local-zlm', url: localEndpoints.rtsp }
          : selectedServer.kind === 'remote-easymedia' && endpoints.seiDiagnostics
            ? { source: 'secret-ems', url: endpoints.seiDiagnostics }
            : undefined
      return pushUrl && playbackEndpoint && streamUrl
        ? [{ video, pushUrl, playbackEndpoint, streamUrl, seiRequest }]
        : []
    })
    if (!prepared.length) {
      onNotify?.(`当前媒体服务不支持 ${providerLabel} ${webRtc ? realtimePushLabel : 'RTMP'} 推流与播放`, 'error')
      return
    }

    setSending('play-all')
    try {
      const started: typeof prepared = []
      const failures: ServiceCallResult[] = []
      for (let index = 0; index < prepared.length; index += 1) {
        const item = prepared[index]
        const result = await startDeviceStream(item.video, item.pushUrl, webRtc)
        if (result.ok) {
          const seiSessionId = await startSeiParser(item.video, item.seiRequest)
          started.push(item)
          setPlaybacks((active) => ({
            ...active,
            [item.video.id]: {
              stream: item.video,
              protocol: item.playbackEndpoint.protocol,
              playbackUrl: item.playbackEndpoint.url,
              streamUrl: item.streamUrl,
              seiSessionId,
            },
          }))
        } else {
          failures.push(result)
        }
        if (index < prepared.length - 1) await wait(350)
      }
      const failedCount = prepared.length - started.length
      const details = [
        started.length ? `${started.length} 路已开始` : '',
        failedCount ? `${failedCount} 路失败` : '',
        limitedCount ? `${limitedCount} 路受设备并发限制` : '',
      ].filter(Boolean).join('，')
      const firstFailure = failures[0]
      onNotify?.(
        firstFailure ? `${details}。${liveCommandError(firstFailure, '设备未开始推流')}` : details || '没有可启动的视频',
        failedCount || !started.length ? 'error' : 'success',
      )
    } catch (error) {
      onNotify?.(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setSending('')
    }
  }

  const playVideo = async (video: CameraVideoStream): Promise<void> => {
    const source = videoSources.find((item) => item.video.id === video.id)
    if (!selectedServer) {
      onNotify?.('请先在媒体中心配置流媒体服务器', 'error')
      return
    }
    if (status !== 'connected' || busy) {
      onNotify?.(status !== 'connected' ? 'MQTT 连接尚未就绪' : '连接配置正在同步，请稍候', 'error')
      return
    }
    const currentPlayback = playbacks[video.id]
    if (currentPlayback) {
      await stopPlayback(currentPlayback)
      return
    }

    if (source?.camera.coexistVideoNumberMax) {
      const activeForCamera = Object.values(playbacks).filter((current) => (
        current.stream.sourceSn === video.sourceSn
        && current.stream.cameraIndex === video.cameraIndex
      )).length
      if (activeForCamera >= source.camera.coexistVideoNumberMax) {
        onNotify?.(`该相机最多同时播放 ${source.camera.coexistVideoNumberMax} 路视频`, 'error')
        return
      }
    }

    setSelectedCameraId(source?.camera.id ?? selectedCameraId)
    setSelectedVideoId(video.id)
    setSending(`play:${video.id}`)
    try {
      const endpoints = buildMediaEndpoints(selectedServer, 'live', cameraStreamName(video))
      const localEndpoints = selectedServer.kind === 'local-zlm'
        ? buildMediaEndpoints({ ...selectedServer, host: '127.0.0.1' }, 'live', cameraStreamName(video))
        : endpoints
      const webRtc = pushProtocol === 'webrtc'
      const pushUrl = webRtc
        ? selectCameraPushEndpoint(provider, selectedServer.kind, endpoints, pushProtocol)
        : endpoints.rtmp
      const playbackEndpoint = selectMediaPlaybackEndpoint(endpoints, pushProtocol)
      const streamUrl = webRtc ? endpoints.whep : endpoints.rtmp
      if (!pushUrl || !playbackEndpoint || !streamUrl) {
        onNotify?.(`当前媒体服务不支持 ${providerLabel} ${webRtc ? realtimePushLabel : 'RTMP'} 推流与播放`, 'error')
        return
      }
      const response = await startDeviceStream(video, pushUrl, webRtc)
      if (!response.ok) {
        onNotify?.(liveCommandError(response, '开始推流失败'), 'error')
        return
      }
      const seiRequest: Pick<SeiParserStartRequest, 'source' | 'url'> | undefined =
        webRtc && selectedServer.kind === 'local-zlm' && localEndpoints.rtsp
          ? { source: 'local-zlm', url: localEndpoints.rtsp }
          : selectedServer.kind === 'remote-easymedia' && endpoints.seiDiagnostics
            ? { source: 'secret-ems', url: endpoints.seiDiagnostics }
            : undefined
      const seiSessionId = await startSeiParser(video, seiRequest)
      setPlaybacks((active) => ({
        ...active,
        [video.id]: {
          stream: video,
          protocol: playbackEndpoint.protocol,
          playbackUrl: playbackEndpoint.url,
          streamUrl,
          seiSessionId,
        },
      }))
      onNotify?.(`设备已确认开始 ${webRtc ? realtimePushLabel : 'RTMP'} 推流，正在连接画面`, 'success')
    } catch (error) {
      onNotify?.(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setSending('')
    }
  }

  const sendCameraAction = async (commandId: string): Promise<void> => {
    if (!selectedCamera) return
    const command = DJI_COMMANDS.find((item) => item.id === commandId)
    if (!command) return
    setSending(command.id)
    try {
      const response = await publishService(selectedCamera.gatewaySn, command.method, command.id === 'payload-authority-grab'
        ? command.data
        : { ...command.data, payload_index: selectedCamera.cameraIndex })
      onNotify?.(
        response.ok ? `设备已执行${command.label}` : liveCommandError(response, `${command.label}失败`),
        response.ok ? 'success' : 'error',
      )
    } catch (error) {
      onNotify?.(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setSending('')
    }
  }

  const switchVideoLens = async (video: CameraVideoStream, lensType: string): Promise<void> => {
    const source = videoSources.find((item) => item.video.id === video.id)
    if (source) setSelectedCameraId(source.camera.id)
    setSelectedVideoId(video.id)
    const currentLensType = selectedLensTypes[video.id] ?? video.videoType
    if (currentLensType.toLowerCase() === lensType.toLowerCase()) return
    const sendingId = `lens:${video.id}:${lensType}`
    setSending(sendingId)
    try {
      const response = await publishService(video.gatewaySn, 'live_lens_change', {
        video_id: video.id,
        video_type: lensType,
      })
      if (!response.ok) {
        onNotify?.(liveCommandError(response, '切换视频镜头失败'), 'error')
        return
      }
      setSelectedLensTypes((current) => ({ ...current, [video.id]: lensType }))
      onNotify?.(`已切换到${videoTypeLabel(lensType)}镜头`, 'success')
    } catch (error) {
      onNotify?.(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setSending('')
    }
  }

  const switchDockCameraPosition = async (video: CameraVideoStream, cameraPosition: number): Promise<void> => {
    const source = videoSources.find((item) => item.video.id === video.id)
    if (source) setSelectedCameraId(source.camera.id)
    setSelectedVideoId(video.id)
    if (selectedDockCameraPositions[video.id] === cameraPosition) return

    const sendingId = `camera-position:${video.id}`
    setSending(sendingId)
    try {
      const response = await publishLiveService(video.gatewaySn, 'live_camera_change', {
        video_id: video.id,
        camera_position: cameraPosition,
      })
      if (!response.ok) {
        onNotify?.(liveCommandError(response, '切换机场直播相机失败'), 'error')
        return
      }
      setSelectedDockCameraPositions((current) => ({ ...current, [video.id]: cameraPosition }))
      const positionLabel = dockCameraPositions.find((position) => position.value === cameraPosition)?.label ?? String(cameraPosition)
      onNotify?.(`已切换到${positionLabel}相机`, 'success')
    } catch (error) {
      onNotify?.(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setSending('')
    }
  }

  const switchVideoQuality = async (video: CameraVideoStream, nextQuality: number): Promise<void> => {
    const source = videoSources.find((item) => item.video.id === video.id)
    if (source) setSelectedCameraId(source.camera.id)
    setSelectedVideoId(video.id)
    if (qualityForVideo(video) === nextQuality) return

    const isLive = Boolean(playbacks[video.id]) || video.status === 1
    if (!isLive) {
      setSelectedQualities((current) => ({ ...current, [video.id]: nextQuality }))
      return
    }

    if (isSuperDock && source?.camera.sourceType === 'dock') {
      onNotify?.('SuperDock 机场相机直播中不支持切换清晰度', 'error')
      return
    }

    const sendingId = `quality:${video.id}`
    setSending(sendingId)
    try {
      const response = await publishLiveService(video.gatewaySn, 'live_set_quality', {
        video_id: video.id,
        video_quality: nextQuality,
      })
      if (!response.ok) {
        onNotify?.(liveCommandError(response, '切换清晰度失败'), 'error')
        return
      }
      setSelectedQualities((current) => ({ ...current, [video.id]: nextQuality }))
      const qualityLabel = qualityOptions.find((option) => option.value === nextQuality)?.label ?? String(nextQuality)
      onNotify?.(`已切换到${qualityLabel}`, 'success')
    } catch (error) {
      onNotify?.(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setSending('')
    }
  }

  if (!cameras.length) {
    return (
      <section className="camera-console empty">
        <Camera size={28} />
        <h3>暂未发现相机</h3>
        <p>等待机场上报 live_capacity，或飞机上报 cameras 属性。</p>
      </section>
    )
  }

  const copyPlaybackUrl = async (value: string, label: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      onNotify?.(`${label}已复制`, 'success')
    } catch (error) {
      onNotify?.(error instanceof Error ? error.message : '复制播放地址失败', 'error')
    }
  }

  return (
    <section className="camera-console">
      <div className="camera-console-layout">
        <aside className="camera-source-panel">
          <div className="camera-source-list" aria-label="相机列表">
            {cameras.map((camera) => {
              const sourceTypeLabel = camera.sourceType === 'aircraft' ? '飞机' : camera.sourceType === 'dock' ? '机场' : '遥控器'
              const cameraConnected = status === 'connected' && camera.online
              const live = camera.videos.some((video) => Boolean(playbacks[video.id]) || (cameraConnected && video.status === 1))
              const lensTypes = cameraLensTypes(camera.videos)
              return (
                <button
                  key={camera.id}
                  className={`camera-source-row ${selectedCamera?.id === camera.id ? 'selected' : ''}`}
                  onClick={() => setSelectedCameraId(camera.id)}
                >
                  <span className="camera-source-copy">
                    <strong>{sourceTypeLabel} · {camera.sourceName}</strong>
                    <small title={camera.sourceSn}>设备 SN：{camera.sourceSn}</small>
                    <small>相机下标：{camera.cameraIndex}</small>
                    <span className="camera-source-lenses">
                      <span className="camera-lens-cluster" aria-hidden="true">
                        {(lensTypes.length ? lensTypes : ['unknown']).slice(0, 4).map((type) => (
                          <i key={type} />
                        ))}
                      </span>
                      <small>{lensTypes.length
                        ? lensTypes.map(videoTypeLabel).join(' / ')
                        : '镜头信息待上报'}</small>
                    </span>
                  </span>
                  <span className={`camera-stream-status ${live ? 'live' : ''}`}>{live ? '直播中' : cameraConnected ? '未直播' : '离线档案'}</span>
                </button>
              )
            })}
          </div>

          <div className="camera-source-divider" role="separator" aria-orientation="horizontal" />

          <div className="camera-stream-toolbar" aria-label="直播设置">
            <label className="field">
              <span>流媒体服务器</span>
              <select value={selectedServer?.id ?? ''} onChange={(event) => onSelectMediaServer(event.target.value)} disabled={!compatibleMediaServers.length || hasActivePlaybacks}>
                {!compatibleMediaServers.length && <option value="">暂无支持 {providerLabel} {pushProtocol === 'webrtc' ? realtimePushLabel : 'RTMP'} 的服务</option>}
                {compatibleMediaServers.map((server) => <option key={server.id} value={server.id}>{server.name} · {server.host}</option>)}
              </select>
            </label>
            <label className="field compact-select">
              <span>推流协议</span>
              <select value={pushProtocol} onChange={(event) => setPushProtocol(event.target.value as PushProtocol)} disabled={hasActivePlaybacks}>
                <option value="rtmp">RTMP</option>
                <option value="webrtc">{realtimePushLabel}</option>
              </select>
            </label>
            <label className="field compact-select">
              <span>清晰度</span>
              <select value={quality} onChange={(event) => setQuality(Number(event.target.value))}>
                {qualityOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <div className="camera-stream-bulk-actions">
              {videoSources.some(({ video }) => !playbacks[video.id]) && (
                <button className="button primary compact" disabled={!selectedServer || status !== 'connected' || busy || Boolean(sending)} onClick={() => void startAllPlaybacks()}>
                  <Play size={14} />{sending === 'play-all' ? '启动中' : '全部播放'}
                </button>
              )}
              {hasActivePlaybacks && (
                <button className="button secondary compact" disabled={Boolean(sending)} onClick={() => void stopAllPlaybacks()}>
                  <CircleStop size={14} />{sending === 'stop-all' ? '停止中' : '全部停止'}
                </button>
              )}
            </div>
          </div>
        </aside>

        <div className="camera-detail">
          <div className="camera-monitor-grid" aria-label="多路相机监看">
            {!videoSources.length && <span className="camera-lens-empty">暂无可播放的视频源</span>}
            {videoSources.map(({ camera, video }) => {
              const playback = playbacks[video.id]
              const seiEvent = playback?.seiSessionId ? seiEvents[playback.seiSessionId] : undefined
              const activeLensType = selectedLensTypes[video.id] ?? video.videoType
              const supportedTypes = videoLensTypes(video)
              const selectedQuality = qualityForVideo(video)
              const live = Boolean(playback) || (status === 'connected' && camera.online && video.status === 1)
              const liveQualityLocked = isCameraLiveQualityLocked(provider, camera.sourceType, live)
              const selected = selectedCamera?.id === camera.id && selectedVideo?.id === video.id
              const processing = sending === `play:${video.id}` || sending === `stop:${video.id}`
              return (
                <article key={video.id} className={`camera-monitor-tile ${playback ? 'playing' : ''} ${selected ? 'selected' : ''}`}>
                  <header className="camera-monitor-header">
                    <button type="button" onClick={() => { setSelectedCameraId(camera.id); setSelectedVideoId(video.id) }}>
                      <span className="camera-lens-optic"><Aperture size={17} /></span>
                      <span>
                        <strong>{camera.sourceName} · {videoTypeLabel(activeLensType)}</strong>
                        <small>{camera.cameraIndex} / {video.videoIndex}</small>
                      </span>
                    </button>
                    <span className={`camera-lens-state ${live ? 'live' : ''}`}>
                      {live ? '直播中' : '待机'}
                    </span>
                  </header>

                  <LivePlayer
                    src={playback?.playbackUrl}
                    protocol={playback?.protocol ?? 'http-ts'}
                    title={`${camera.sourceName} ${videoTypeLabel(activeLensType)}视频`}
                  />

                  {playback && (
                    <div className="camera-monitor-address">
                      <code title={playback.streamUrl}>{playback.streamUrl}</code>
                      <Tooltip label="复制播放地址">
                        <button className="icon-button small" onClick={() => void copyPlaybackUrl(playback.streamUrl, '播放地址')}><Copy size={13} /></button>
                      </Tooltip>
                    </div>
                  )}

                  {playback?.seiSessionId && (
                    <section className="camera-sei-panel" aria-label={`${video.videoIndex} SEI 解析`}>
                      <header>
                        <span><Binary size={13} />SEI</span>
                        <strong className={seiEvent?.seiMessages ? 'detected' : ''}>{seiStatusLabel(seiEvent)}</strong>
                        <small>{seiEvent?.codec?.toUpperCase() ?? '待识别'} · {seiEvent?.source === 'secret-ems' ? '帧' : 'NAL'} {seiEvent?.videoNalUnits ?? 0}</small>
                        {Boolean(seiEvent?.malformedMessages) && <small className="warning">异常 {seiEvent?.malformedMessages}</small>}
                        {Boolean(seiEvent?.latestMessages.length) && (
                          <Tooltip label="查看 SEI 详情">
                            <button
                              type="button"
                              className="icon-button small camera-sei-detail-button"
                              aria-label="查看 SEI 详情"
                              onClick={() => openSeiDetail(video.id, seiEvent!)}
                            ><Maximize2 size={13} /></button>
                          </Tooltip>
                        )}
                      </header>
                      {!seiEvent?.latestMessages.length && <p>{seiEvent?.detail ?? '正在扫描 H.264/H.265 SEI NAL 单元'}</p>}
                    </section>
                  )}

                  <footer className="camera-monitor-footer">
                    <div className="camera-monitor-options">
                      {camera.sourceType === 'dock' ? (
                        <label className="camera-monitor-select-control camera-position-control">
                          <span>相机</span>
                          <select
                            className="camera-monitor-select camera-position-select"
                            aria-label={`${video.videoIndex} 切换机场相机`}
                            value={selectedDockCameraPositions[video.id] ?? ''}
                            disabled={status !== 'connected' || busy || Boolean(sending)}
                            onChange={(event) => void switchDockCameraPosition(video, Number(event.target.value))}
                          >
                            <option value="" disabled>选择</option>
                            {dockCameraPositions.map((position) => (
                              <option key={position.value} value={position.value}>{position.label}</option>
                            ))}
                          </select>
                          <ChevronDown size={13} aria-hidden="true" />
                        </label>
                      ) : null}
                      {supportedTypes.length > 1 ? (
                        <label className="camera-monitor-select-control camera-lens-control">
                          <span>镜头</span>
                          <select
                            className="camera-monitor-select camera-lens-select"
                            aria-label={`${video.videoIndex} 切换镜头`}
                            value={activeLensType}
                            disabled={status !== 'connected' || busy || Boolean(sending)}
                            onChange={(event) => void switchVideoLens(video, event.target.value)}
                          >
                            {supportedTypes.map((lensType) => (
                              <option key={lensType} value={lensType}>{videoTypeLabel(lensType)}</option>
                            ))}
                          </select>
                          <ChevronDown size={13} aria-hidden="true" />
                        </label>
                      ) : null}
                      <label className="camera-monitor-select-control camera-quality-control">
                        <span>清晰度</span>
                        <select
                          className="camera-monitor-select camera-quality-select"
                          aria-label={`${video.videoIndex} 切换清晰度`}
                          value={selectedQuality}
                          disabled={liveQualityLocked || busy || Boolean(sending) || (live && status !== 'connected')}
                          onChange={(event) => void switchVideoQuality(video, Number(event.target.value))}
                        >
                          {qualityOptions.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                        <ChevronDown size={13} aria-hidden="true" />
                      </label>
                    </div>
                    <button
                      className={`button compact ${playback ? 'secondary' : 'primary'}`}
                      disabled={!selectedServer || status !== 'connected' || busy || Boolean(sending)}
                      onClick={() => void playVideo(video)}
                    >
                      {playback ? <CircleStop size={14} /> : <Play size={14} />}
                      {processing ? '处理中' : playback ? '停止' : '播放'}
                    </button>
                  </footer>
                </article>
              )
            })}
          </div>

          <div className="camera-actions">
            <span><Crosshair size={14} />当前控制：{selectedCamera?.sourceName} · {selectedCamera?.cameraIndex}</span>
            <div>
              {cameraActions.map((action) => {
                const command = DJI_COMMANDS.find((item) => item.id === action.id)
                const Icon = action.icon
                return command ? (
                  <button key={action.id} className="button secondary compact" disabled={status !== 'connected' || busy || Boolean(sending)} onClick={() => void sendCameraAction(action.id)}>
                    <Icon size={14} />{sending === action.id ? '发送中' : command.label}
                  </button>
                ) : null
              })}
            </div>
          </div>
        </div>
      </div>

      {detailPlayback && detailSeiEvent && detailMessages.length > 0 && (
        <div className="modal-backdrop camera-sei-detail-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeSeiDetail()
        }}>
          <div className="modal camera-sei-detail-modal" role="dialog" aria-modal="true" aria-label="SEI 详情">
            <header className="modal-header">
              <div>
                <span className="eyebrow">LIVE SEI</span>
                <h2>视频与 SEI 详情</h2>
              </div>
              <Tooltip label="关闭">
                <button type="button" className="icon-button" aria-label="关闭 SEI 详情" onClick={closeSeiDetail}><X size={17} /></button>
              </Tooltip>
            </header>
            <div className="camera-sei-detail-body">
              <section className="camera-sei-detail-video" aria-label="实时画面">
                <header>
                  <strong>{detailCamera?.sourceName ?? detailPlayback.stream.sourceSn} · {videoTypeLabel(detailPlayback.stream.videoType)}</strong>
                  <span>{detailPlayback.protocol.toUpperCase()}</span>
                </header>
                <LivePlayer
                  src={detailPlayback.playbackUrl}
                  protocol={detailPlayback.protocol}
                  title={`${detailCamera?.sourceName ?? detailPlayback.stream.sourceSn} SEI 详情视频`}
                />
              </section>
              <aside className="camera-sei-detail-data" aria-label="SEI 数据">
                <header>
                  <div>
                    <strong>SEI 消息</strong>
                    <span>{detailSeiEvent.codec?.toUpperCase() ?? '待识别'} · 共 {detailSeiEvent.seiMessages} 条{pausedSeiEvent ? ' · 已暂停' : ''}</span>
                  </div>
                  <div className="camera-sei-detail-controls">
                    <Tooltip label={pausedSeiEvent ? '继续接收最新消息' : '暂停消息刷新'}>
                      <button
                        type="button"
                        className={`icon-button small camera-sei-pause-button ${pausedSeiEvent ? 'active' : ''}`}
                        aria-label={pausedSeiEvent ? '继续 SEI 消息刷新' : '暂停 SEI 消息刷新'}
                        aria-pressed={Boolean(pausedSeiEvent)}
                        onClick={toggleSeiDetailPause}
                      >{pausedSeiEvent ? <Play size={13} /> : <Pause size={13} />}</button>
                    </Tooltip>
                    <div className="segmented camera-sei-format-tabs" role="tablist" aria-label="SEI 数据格式">
                      <button type="button" role="tab" className={seiDetailFormat === 'text' ? 'active' : ''} disabled={!seiMessageDetail?.text} onClick={() => setSeiDetailFormat('text')}>文本</button>
                      <button type="button" role="tab" className={seiDetailFormat === 'json' ? 'active' : ''} disabled={!formattedSeiJson} onClick={() => setSeiDetailFormat('json')}>JSON</button>
                      <button type="button" role="tab" className={seiDetailFormat === 'hex' ? 'active' : ''} onClick={() => setSeiDetailFormat('hex')}>HEX</button>
                      <button type="button" role="tab" className={seiDetailFormat === 'base64' ? 'active' : ''} onClick={() => setSeiDetailFormat('base64')}>Base64</button>
                    </div>
                  </div>
                </header>
                <div className="camera-sei-detail-content">
                  <div className="camera-sei-detail-list" role="listbox" aria-label="SEI 消息列表">
                    {detailMessages.map((message) => (
                      <button
                        type="button"
                        role="option"
                        key={message.id}
                        className={message.id === selectedSeiMessageId ? 'selected' : ''}
                        aria-selected={message.id === selectedSeiMessageId}
                        onClick={() => {
                          setSelectedSeiMessageId(message.id)
                          setSeiDetailFormat('text')
                        }}
                      >
                        <span><time>{new Date(message.at).toLocaleTimeString('zh-CN', { hour12: false })}</time><small>{message.payloadSize} B</small></span>
                        <strong>{message.payloadType === 5 ? 'user_data_unregistered' : `payload type ${message.payloadType}`}</strong>
                        <code>{message.textPreview ?? message.hexPreview ?? '空 payload'}</code>
                      </button>
                    ))}
                  </div>
                  <section className="camera-sei-payload" aria-live="polite">
                    <header>
                      <span>{seiMessageDetail ? `${seiMessageDetail.payloadSize} B` : '读取中'}</span>
                      {seiMessageDetail && (
                        <Tooltip label="复制当前 SEI 数据">
                          <button type="button" className="icon-button small" aria-label="复制当前 SEI 数据" onClick={() => {
                            void copyPlaybackUrl(seiDetailValue ?? '', 'SEI 数据')
                          }}><Copy size={13} /></button>
                        </Tooltip>
                      )}
                    </header>
                    {seiDetailError
                      ? <p className="camera-sei-detail-error">{seiDetailError}</p>
                      : <pre>{seiMessageDetail ? seiDetailValue : '正在读取完整 SEI 数据...'}</pre>}
                  </section>
                </div>
              </aside>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
