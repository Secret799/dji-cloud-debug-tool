import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Aperture,
  Camera,
  ChevronDown,
  CircleStop,
  Copy,
  Crosshair,
  LockKeyhole,
  MonitorPlay,
  Play,
  RotateCcw,
  Video,
} from 'lucide-react'
import type {
  ConnectionProfile,
  ConnectionStatus,
  DeviceProvider,
  MediaServerProfile,
  MqttQos,
  OperationResult,
} from '../../../shared/contracts'
import { Tooltip } from '../components/Tooltip'
import { LivePlayer } from '../components/LivePlayer'
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
import type { ExternalMediaPreviewRequest } from '../lib/media'

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
  onOpenMediaPreview?: (request: ExternalMediaPreviewRequest) => void
}

interface ActivePlayback {
  stream: CameraVideoStream
  protocol: MediaPlaybackProtocol
  playbackUrl: string
  streamUrl: string
}

type PushProtocol = 'rtmp' | 'webrtc'

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

export const buildMediaPreviewRequest = (
  server: Pick<MediaServerProfile, 'id'>,
  camera: Pick<CameraSource, 'sourceName'>,
  video: Pick<CameraVideoStream, 'sourceSn' | 'cameraIndex' | 'videoIndex' | 'videoType'>,
  playback: Pick<ActivePlayback, 'playbackUrl' | 'protocol'>,
  nonce: number,
): ExternalMediaPreviewRequest => ({
  serverId: server.id,
  app: 'live',
  stream: cameraStreamName(video),
  url: playback.playbackUrl,
  protocol: playback.protocol,
  title: `${camera.sourceName} · ${videoTypeLabel(video.videoType)}`,
  sourceSn: video.sourceSn,
  nonce,
})

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
  onOpenMediaPreview,
}: CameraCenterProps) {
  const isSuperDock = provider === 'superdock'
  const providerLabel = isSuperDock ? 'SuperDock' : 'DJI'
  const realtimePushLabel = isSuperDock ? 'WHIP' : 'WebRTC'
  const gatewayConnected = status === 'connected' && telemetry.some((device) => (
    device.profileId === profile.id && device.sn === gatewaySn && device.online
  ))
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
  const mediaPreviewNonceRef = useRef(0)
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

  const stopStreams = async (videos: CameraVideoStream[], sendingId: string): Promise<void> => {
    if (!videos.length) return
    setSending(sendingId)
    try {
      const failures: string[] = []
      for (const [index, video] of videos.entries()) {
        try {
          const response = await stopDeviceStream(video)
          if (response.ok || hasLiveResult(response, 13011)) {
            setPlaybacks((active) => {
              if (!active[video.id]) return active
              const next = { ...active }
              delete next[video.id]
              return next
            })
          } else {
            failures.push(liveCommandError(response, '停止推流失败'))
          }
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error))
        }
        if (index < videos.length - 1) await wait(350)
      }
      if (failures.length) {
        const message = videos.length > 1 ? `${failures.length} 路视频停止失败。${failures[0]}` : failures[0]
        onNotify?.(message, 'error')
      } else {
        onNotify?.(sendingId === 'stop-all' ? '已停止全部视频' : '设备已停止推流', 'success')
      }
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
      const pushUrl = webRtc
        ? selectCameraPushEndpoint(provider, selectedServer.kind, endpoints, pushProtocol)
        : endpoints.rtmp
      const playbackEndpoint = selectMediaPlaybackEndpoint(endpoints, pushProtocol)
      const streamUrl = webRtc ? endpoints.whep : endpoints.rtmp
      return pushUrl && playbackEndpoint && streamUrl
        ? [{ video, pushUrl, playbackEndpoint, streamUrl }]
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
          started.push(item)
          setPlaybacks((active) => ({
            ...active,
            [item.video.id]: {
              stream: item.video,
              protocol: item.playbackEndpoint.protocol,
              playbackUrl: item.playbackEndpoint.url,
              streamUrl: item.streamUrl,
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
      await stopStreams([currentPlayback.stream], `stop:${video.id}`)
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
      setPlaybacks((active) => ({
        ...active,
        [video.id]: {
          stream: video,
          protocol: playbackEndpoint.protocol,
          playbackUrl: playbackEndpoint.url,
          streamUrl,
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

  const openMediaPreview = (camera: CameraSource, video: CameraVideoStream, playback: ActivePlayback): void => {
    if (!selectedServer || !onOpenMediaPreview) return
    mediaPreviewNonceRef.current += 1
    onOpenMediaPreview(buildMediaPreviewRequest(selectedServer, camera, video, playback, mediaPreviewNonceRef.current))
  }

  return (
    <section className="camera-console">
      <div className="camera-console-layout">
        <aside className="camera-source-panel">
          <div className="camera-source-list" aria-label="相机列表">
            {cameras.map((camera) => {
              const sourceTypeLabel = camera.sourceType === 'aircraft' ? '飞机' : camera.sourceType === 'dock' ? '机场' : '遥控器'
              const liveVideos = gatewayConnected ? camera.videos.filter((video) => video.status === 1) : []
              const live = liveVideos.length > 0
              const reportedIdle = camera.videos.length > 0 && camera.videos.every((video) => video.status === 0)
              const streamStatus = !gatewayConnected ? '离线档案' : live ? '直播中' : reportedIdle ? '未直播' : '尚未上报'
              const stopId = `stop-camera:${camera.id}`
              const lensTypes = cameraLensTypes(camera.videos)
              return (
                <div key={camera.id} className={`camera-source-row ${selectedCamera?.id === camera.id ? 'selected' : ''}`}>
                  <button type="button" className="camera-source-select" onClick={() => setSelectedCameraId(camera.id)}>
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
                  </button>
                  <div className="camera-source-actions">
                    <span className={`camera-stream-status ${live ? 'live' : ''}`}>{streamStatus}</span>
                    {live && (
                      <button
                        type="button"
                        className="button compact danger-ghost camera-source-stop"
                        aria-label={`${sending === stopId ? '停止中' : '停止推流'}：${camera.sourceName} · ${camera.cameraIndex}`}
                        disabled={busy || Boolean(sending)}
                        onClick={() => void stopStreams(liveVideos, stopId)}
                      >
                        <CircleStop size={12} aria-hidden="true" />
                        {sending === stopId ? '停止中' : '停止推流'}
                      </button>
                    )}
                  </div>
                </div>
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
                  <Play size={14} />{sending === 'play-all' ? '启动中' : '全部开始直播'}
                </button>
              )}
              {hasActivePlaybacks && (
                <button className="button secondary compact" disabled={Boolean(sending)} onClick={() => void stopStreams(Object.values(playbacks).map(({ stream }) => stream), 'stop-all')}>
                  <CircleStop size={14} />{sending === 'stop-all' ? '停止中' : '全部停止直播'}
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
                    <div className="camera-monitor-actions">
                      {playback && onOpenMediaPreview && (
                        <button className="button primary compact" onClick={() => openMediaPreview(camera, video, playback)}>
                          <MonitorPlay size={14} />在媒体页预览
                        </button>
                      )}
                      <button
                        className={`button compact ${playback ? 'secondary' : 'primary'}`}
                        disabled={!selectedServer || status !== 'connected' || busy || Boolean(sending)}
                        onClick={() => void playVideo(video)}
                      >
                        {playback ? <CircleStop size={14} /> : <Play size={14} />}
                        {processing ? '处理中' : playback ? '停止直播' : '开始直播'}
                      </button>
                    </div>
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

    </section>
  )
}
