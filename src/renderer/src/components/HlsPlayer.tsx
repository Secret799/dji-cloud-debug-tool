import { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import { CircleAlert, LoaderCircle, Video } from 'lucide-react'

interface HlsPlayerProps {
  src?: string
  title: string
}

type PlayerState = 'idle' | 'loading' | 'ready' | 'waiting' | 'error' | 'unsupported'

export function HlsPlayer({ src, title }: HlsPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [state, setState] = useState<PlayerState>(src ? 'loading' : 'idle')

  useEffect(() => {
    const video = videoRef.current
    if (!video || !src) {
      setState('idle')
      return undefined
    }

    let hls: Hls | undefined
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    setState('loading')

    const play = (): void => {
      if (!disposed) void video.play().catch(() => undefined)
    }
    const ready = (): void => {
      if (!disposed) {
        setState('ready')
        play()
      }
    }

    if (Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 30,
      })
      hls.attachMedia(video)
      hls.on(Hls.Events.MEDIA_ATTACHED, () => hls?.loadSource(src))
      hls.on(Hls.Events.MANIFEST_PARSED, ready)
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal || disposed) return
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          setState('waiting')
          clearTimeout(retryTimer)
          retryTimer = setTimeout(() => hls?.startLoad(), 2_000)
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          setState('waiting')
          hls?.recoverMediaError()
        } else {
          setState('error')
        }
      })
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src
      video.addEventListener('loadedmetadata', ready)
      video.addEventListener('error', () => setState('error'))
      video.load()
    } else {
      setState('unsupported')
    }

    return () => {
      disposed = true
      clearTimeout(retryTimer)
      hls?.destroy()
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
  }, [src])

  const message = state === 'idle'
    ? '选择视频源后播放'
    : state === 'loading'
      ? '正在连接视频流'
      : state === 'waiting'
        ? '等待设备开始推流'
        : state === 'unsupported'
          ? '当前环境不支持 HLS 播放'
          : state === 'error'
            ? '视频流加载失败'
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
