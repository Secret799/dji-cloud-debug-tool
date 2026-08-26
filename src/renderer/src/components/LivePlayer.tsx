import { useEffect, useRef, useState } from 'react'
import { CircleAlert, LoaderCircle, Video } from 'lucide-react'
import type { MediaPlaybackProtocol } from '../lib/media'
import { setRemoteAnswerWithIceFallback } from '../lib/webrtc'

interface LivePlayerProps {
  src?: string
  protocol: MediaPlaybackProtocol
  title: string
}

type PlayerState = 'idle' | 'loading' | 'ready' | 'waiting' | 'error' | 'unsupported'

const waitForIceGathering = (connection: RTCPeerConnection): Promise<void> => {
  if (connection.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    function finish(): void {
      connection.removeEventListener('icegatheringstatechange', handleChange)
      resolve()
    }
    function handleChange(): void {
      if (connection.iceGatheringState === 'complete') finish()
    }
    connection.addEventListener('icegatheringstatechange', handleChange)
  })
}

export function LivePlayer({ src, protocol, title }: LivePlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [state, setState] = useState<PlayerState>(src ? 'loading' : 'idle')
  const [errorDetail, setErrorDetail] = useState('')

  useEffect(() => {
    const video = videoRef.current
    if (!video || !src) {
      setState('idle')
      return undefined
    }

    let disposed = false
    let tsPlayer: ReturnType<(typeof import('mpegts.js'))['default']['createPlayer']> | undefined
    let peerConnection: RTCPeerConnection | undefined
    let relayId: string | undefined
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let attemptTimer: ReturnType<typeof setTimeout> | undefined
    setState('loading')
    setErrorDetail('')

    const ready = (): void => {
      if (disposed) return
      clearTimeout(attemptTimer)
      setState('ready')
      void video.play().catch(() => undefined)
    }
    const fail = (nextState: PlayerState = 'error', detail = ''): void => {
      if (disposed) return
      setState(nextState)
      if (detail) setErrorDetail(detail)
    }
    video.addEventListener('playing', ready)

    if (protocol === 'http-ts' || protocol === 'rtmp') {
      void (async () => {
        let mediaUrl = src
        if (protocol === 'rtmp') {
          const response = await window.djiApi.media.startRtmpRelay({ url: src })
          if (!response.ok || !response.relayId || !response.playbackUrl) {
            throw new Error(response.error ?? '无法启动 RTMP 播放器')
          }
          if (disposed) {
            await window.djiApi.media.stopRtmpRelay(response.relayId)
            return
          }
          relayId = response.relayId
          mediaUrl = response.playbackUrl
        }

        const { default: mpegts } = await import('mpegts.js')
        if (disposed) return
        if (!mpegts.isSupported()) {
          setState('unsupported')
          return
        }

        const destroyPlayer = (): void => {
          if (!tsPlayer) return
          tsPlayer.pause()
          tsPlayer.unload()
          tsPlayer.detachMediaElement()
          tsPlayer.destroy()
          tsPlayer = undefined
        }
        const connect = (): void => {
          if (disposed) return
          clearTimeout(retryTimer)
          destroyPlayer()
          tsPlayer = mpegts.createPlayer({
            type: protocol === 'rtmp' ? 'flv' : 'mpegts',
            isLive: true,
            url: mediaUrl,
            cors: true,
          }, {
            enableWorker: true,
            enableStashBuffer: false,
            lazyLoad: false,
            liveBufferLatencyChasing: true,
            liveBufferLatencyMaxLatency: 1.5,
            liveBufferLatencyMinRemain: 0.5,
          })
          tsPlayer.attachMediaElement(video)
          tsPlayer.on(mpegts.Events.MEDIA_INFO, ready)
          tsPlayer.on(mpegts.Events.ERROR, (type, detail) => {
            if (disposed) return
            const message = String(detail ?? '视频流网络或媒体错误')
            if (type !== mpegts.ErrorTypes.NETWORK_ERROR) {
              fail('error', message)
              return
            }
            fail('waiting', message)
            destroyPlayer()
            retryTimer = setTimeout(connect, 2_000)
          })
          tsPlayer.load()
          void Promise.resolve(tsPlayer.play()).catch(() => undefined)
        }

        connect()
      })().catch((error) => fail('error', error instanceof Error ? error.message : String(error)))
    } else if (typeof RTCPeerConnection === 'undefined') {
      setState('unsupported')
    } else {
      const retry = (connection: RTCPeerConnection, detail: string): void => {
        if (disposed || peerConnection !== connection) return
        clearTimeout(attemptTimer)
        fail('waiting', detail)
        connection.close()
        peerConnection = undefined
        retryTimer = setTimeout(() => void connect(), 2_000)
      }
      const connect = async (): Promise<void> => {
        if (disposed) return
        clearTimeout(retryTimer)
        clearTimeout(attemptTimer)
        peerConnection?.close()
        const connection = new RTCPeerConnection()
        const mediaStream = new MediaStream()
        peerConnection = connection
        video.srcObject = mediaStream
        connection.addTransceiver('video', { direction: 'recvonly' })
        connection.addTransceiver('audio', { direction: 'recvonly' })
        connection.addEventListener('track', (event) => {
          if (disposed || peerConnection !== connection) return
          mediaStream.addTrack(event.track)
          ready()
        })
        connection.addEventListener('connectionstatechange', () => {
          if (connection.connectionState === 'failed' || connection.connectionState === 'disconnected') {
            retry(connection, `WebRTC 连接状态：${connection.connectionState}`)
          }
        })
        attemptTimer = setTimeout(() => retry(connection, '连接超时，正在重新查找视频流'), 15_000)

        try {
          const offer = await connection.createOffer()
          await connection.setLocalDescription(offer)
          await waitForIceGathering(connection)
          if (disposed || peerConnection !== connection) return
          const localSdp = connection.localDescription?.sdp ?? offer.sdp
          if (!localSdp) throw new Error('浏览器未生成 WebRTC SDP offer')
          const response = await window.djiApi.media.negotiateWhep({
            url: src,
            sdp: localSdp,
          })
          if (disposed || peerConnection !== connection) return
          if (!response.ok || !response.sdp) {
            retry(connection, response.error ?? '视频流尚未上线')
            return
          }
          await setRemoteAnswerWithIceFallback(connection, response.sdp)
        } catch (error) {
          if (!disposed && peerConnection === connection) {
            console.error('WebRTC playback failed', error)
            fail('error', error instanceof Error ? error.message : String(error))
            clearTimeout(attemptTimer)
            connection.close()
            peerConnection = undefined
          }
        }
      }

      void connect()
    }

    return () => {
      disposed = true
      clearTimeout(retryTimer)
      clearTimeout(attemptTimer)
      if (relayId) void window.djiApi.media.stopRtmpRelay(relayId)
      tsPlayer?.pause()
      tsPlayer?.unload()
      tsPlayer?.detachMediaElement()
      tsPlayer?.destroy()
      peerConnection?.close()
      video.removeEventListener('playing', ready)
      video.pause()
      video.srcObject = null
      video.removeAttribute('src')
      video.load()
    }
  }, [protocol, src])

  const message = state === 'idle'
    ? '选择视频源后播放'
    : state === 'loading'
      ? protocol === 'webrtc' ? '正在建立 WebRTC 连接' : protocol === 'rtmp' ? '正在连接 RTMP 视频流' : '正在连接视频流'
      : state === 'waiting'
        ? '等待设备开始推流'
        : state === 'unsupported'
          ? `当前环境不支持${protocol === 'webrtc' ? ' WebRTC' : '视频'}播放`
          : state === 'error'
            ? errorDetail || '视频流加载失败，请检查媒体服务地址和端口配置'
            : ''

  return (
    <div className="camera-player">
      <video ref={videoRef} aria-label={title} controls muted playsInline />
      {state !== 'ready' && (
        <div className={`camera-player-state ${state}`}>
          {state === 'loading' || state === 'waiting'
            ? <LoaderCircle className="spin" size={24} />
            : state === 'error' || state === 'unsupported'
              ? <CircleAlert size={24} />
              : <Video size={25} />}
          <span>{message}</span>
        </div>
      )}
    </div>
  )
}
