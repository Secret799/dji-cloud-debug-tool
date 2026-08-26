import type { MediaServerProfile } from '../../../shared/contracts'

export interface StreamEndpoints {
  rtmp?: string
  rtsp?: string
  webrtc?: string
  httpTs?: string
  hls?: string
  whip?: string
  whep?: string
}

export type MediaPlaybackProtocol = 'http-ts' | 'rtmp' | 'webrtc'

export interface MediaPlaybackEndpoint {
  protocol: MediaPlaybackProtocol
  url: string
}

const normalizeSegment = (value: string, fallback: string): string => {
  const normalized = value.trim().replace(/^\/+|\/+$/g, '')
  return normalized || fallback
}

const serverAuthority = (host: string, port: number, defaultPort?: number): string =>
  port === defaultPort ? host : `${host}:${port}`

export const buildMediaEndpoints = (
  server: MediaServerProfile,
  app: string,
  stream: string,
): StreamEndpoints => {
  const safeApp = encodeURIComponent(normalizeSegment(app, 'live'))
  const safeStream = encodeURIComponent(normalizeSegment(stream, 'dji'))
  const httpDefaultPort = server.httpProtocol === 'https' ? 443 : 80
  const httpBase = `${server.httpProtocol}://${serverAuthority(server.host, server.httpPort, httpDefaultPort)}`
  if (server.kind === 'remote-easymedia') {
    const query = `app=${safeApp}&stream=${safeStream}`
    return {
      rtmp: `rtmp://${serverAuthority(server.host, server.rtmpPort)}/${safeApp}/${safeStream}`,
      httpTs: `${httpBase}/${safeApp}/${safeStream}.live.ts`,
      whip: `${httpBase}/easyMedia/api/webrtc/whip?${query}`,
      whep: `${httpBase}/easyMedia/api/webrtc/whep?${query}`,
    }
  }

  const rtmp = `rtmp://${serverAuthority(server.host, server.rtmpPort)}/${safeApp}/${safeStream}`
  return {
    rtmp,
    rtsp: server.rtspPort > 0
      ? `rtsp://${serverAuthority(server.host, server.rtspPort)}/${safeApp}/${safeStream}`
      : undefined,
    webrtc: server.webrtcPort > 0
      ? `webrtc://${serverAuthority(server.host, server.webrtcPort)}/${safeApp}/${safeStream}`
      : undefined,
    httpTs: `${httpBase}/${safeApp}/${safeStream}.live.ts`,
    hls: server.kind === 'remote-srs'
      ? `${httpBase}/${safeApp}/${safeStream}.m3u8`
      : `${httpBase}/${safeApp}/${safeStream}/hls.m3u8`,
  }
}

export const selectMediaPlaybackEndpoint = (
  endpoints: StreamEndpoints,
  pushProtocol: 'rtmp' | 'webrtc',
): MediaPlaybackEndpoint | undefined => {
  if (pushProtocol === 'webrtc') {
    return endpoints.whep ? { protocol: 'webrtc', url: endpoints.whep } : undefined
  }
  return endpoints.rtmp ? { protocol: 'rtmp', url: endpoints.rtmp } : undefined
}
