import { describe, expect, it } from 'vitest'
import type { MediaServerProfile } from '../../../shared/contracts'
import type { CameraSource, CameraVideoStream } from '../lib/camera'
import { buildMediaPreviewRequest } from './CameraCenter'

const server = {
  id: 'local-zlm',
} as MediaServerProfile

const camera = {
  sourceName: '飞机 AIR-1',
} as CameraSource

const video: CameraVideoStream = {
  id: 'AIR-1/0/0',
  gatewaySn: 'DOCK-1',
  sourceSn: 'AIR-1',
  cameraIndex: '0',
  videoIndex: '0',
  videoType: 'normal',
  switchableVideoTypes: [],
}

describe('CameraCenter media preview handoff', () => {
  it('builds a media preview request from the active camera playback', () => {
    expect(buildMediaPreviewRequest(
      server,
      camera,
      video,
      { playbackUrl: 'http://127.0.0.1/live/air-1-0-0.m3u8', protocol: 'webrtc' },
      7,
    )).toEqual({
      serverId: 'local-zlm',
      app: 'live',
      stream: 'air-1-0-0',
      url: 'http://127.0.0.1/live/air-1-0-0.m3u8',
      protocol: 'webrtc',
      title: '飞机 AIR-1 · 普通',
      sourceSn: 'AIR-1',
      nonce: 7,
    })
  })
})
