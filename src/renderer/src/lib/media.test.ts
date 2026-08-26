import { describe, expect, it } from 'vitest'
import type { MediaServerProfile } from '../../../shared/contracts'
import { buildMediaEndpoints, selectMediaPlaybackEndpoint } from './media'

const server = (overrides: Partial<MediaServerProfile> = {}): MediaServerProfile => ({
  id: 'server',
  name: 'Media server',
  kind: 'remote-zlm',
  host: 'media.example.com',
  apiProtocol: 'http',
  apiPort: 80,
  httpProtocol: 'http',
  httpPort: 8080,
  rtmpPort: 1935,
  rtspPort: 554,
  webrtcPort: 8000,
  secret: '',
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

describe('media endpoint helpers', () => {
  it('builds matching ZLMediaKit endpoints from a managed server', () => {
    expect(buildMediaEndpoints(server(), 'live', 'dock-1')).toEqual({
      rtmp: 'rtmp://media.example.com:1935/live/dock-1',
      rtsp: 'rtsp://media.example.com:554/live/dock-1',
      webrtc: 'webrtc://media.example.com:8000/live/dock-1',
      httpTs: 'http://media.example.com:8080/live/dock-1.live.ts',
      hls: 'http://media.example.com:8080/live/dock-1/hls.m3u8',
    })
  })

  it('uses SRS HLS paths and preserves non-default RTMP ports', () => {
    expect(buildMediaEndpoints(server({ kind: 'remote-srs', rtmpPort: 2935, rtspPort: 0 }), 'camera', 'main')).toEqual({
      rtmp: 'rtmp://media.example.com:2935/camera/main',
      rtsp: undefined,
      webrtc: 'webrtc://media.example.com:8000/camera/main',
      httpTs: 'http://media.example.com:8080/camera/main.live.ts',
      hls: 'http://media.example.com:8080/camera/main.m3u8',
    })
  })

  it('omits WebRTC only when its configured port is disabled', () => {
    expect(buildMediaEndpoints(server({ webrtcPort: 0 }), 'live', 'main').webrtc).toBeUndefined()
  })

  it('builds the SecretEMS RTMP, HTTP-TS, WHIP and WHEP endpoints', () => {
    const secretEms = server({
      kind: 'remote-easymedia',
      apiProtocol: 'https',
      apiPort: 443,
      httpProtocol: 'https',
      httpPort: 443,
      rtmpPort: 1935,
      rtspPort: 0,
      webrtcPort: 8000,
    })
    const endpoints = buildMediaEndpoints(secretEms, 'live feed', 'camera/01')
    expect(endpoints).toEqual({
      rtmp: 'rtmp://media.example.com:1935/live%20feed/camera%2F01',
      httpTs: 'https://media.example.com/live%20feed/camera%2F01.live.ts',
      whip: 'https://media.example.com/easyMedia/api/webrtc/whip?app=live%20feed&stream=camera%2F01',
      whep: 'https://media.example.com/easyMedia/api/webrtc/whep?app=live%20feed&stream=camera%2F01',
    })
    expect(selectMediaPlaybackEndpoint(endpoints, 'rtmp')).toEqual({
      protocol: 'rtmp',
      url: endpoints.rtmp,
    })
  })

  it('uses RTMP playback for RTMP pushes and WHEP playback for WHIP pushes', () => {
    const zlm = server()
    const endpoints = buildMediaEndpoints(zlm, 'live', 'main')
    expect(selectMediaPlaybackEndpoint(endpoints, 'rtmp')).toEqual({
      protocol: 'rtmp',
      url: endpoints.rtmp,
    })
    const secretEmsEndpoints = buildMediaEndpoints(server({ kind: 'remote-easymedia' }), 'live', 'main')
    expect(selectMediaPlaybackEndpoint(secretEmsEndpoints, 'webrtc')).toEqual({
      protocol: 'webrtc',
      url: secretEmsEndpoints.whep,
    })
  })
})
