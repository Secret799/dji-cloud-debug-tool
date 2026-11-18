import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { MediaServerProfile } from '../../../shared/contracts'
import { MediaCenter, previewModeLabel, resolveExternalPreview } from './MediaCenter'
import type { ExternalMediaPreviewRequest } from '../lib/media'

const localServer: MediaServerProfile = {
  id: 'local-zlm',
  name: '本地 ZLMediaKit',
  kind: 'local-zlm',
  host: '127.0.0.1',
  apiProtocol: 'http',
  apiPort: 9090,
  httpProtocol: 'http',
  httpPort: 9090,
  rtmpPort: 1935,
  rtspPort: 8554,
  webrtcPort: 8000,
  secret: '',
  isDefault: true,
  createdAt: 1,
  updatedAt: 1,
}

describe('MediaCenter preview panel', () => {
  it('renders the preview and SEI panel next to the media service configuration', () => {
    const markup = renderToStaticMarkup(
      <MediaCenter
        servers={[localServer]}
        runtimeById={{}}
        loading={false}
        onServersChange={vi.fn()}
        onRuntimeChange={vi.fn()}
        onNotify={vi.fn()}
      />,
    )

    expect(markup).toContain('class="media-preview-panel"')
    expect(markup).toContain('码流预览')
    expect(markup).toContain('点击“预览”播放当前流')
    expect(markup).toContain('HLS 播放')
    expect(markup).toContain('SEI 诊断')
    expect(markup).toContain('从本地 RTSP 旁路解析 SEI')
    expect(markup).toContain('media-endpoint-list')
    expect(markup).toContain('media-capability-grid')
    expect(markup).toContain('WebRTC')
    expect(markup).toContain('切换协议会停止当前预览')
  })
})

describe('previewModeLabel', () => {
  it('labels each playback mode without falling back to HTTP-TS', () => {
    expect(previewModeLabel('hls')).toBe('HLS')
    expect(previewModeLabel('webrtc')).toBe('WebRTC')
    expect(previewModeLabel('http-ts')).toBe('HTTP-TS')
    expect(previewModeLabel('rtmp')).toBe('RTMP')
  })
})

describe('external media preview', () => {
  it('uses the request playback address and keeps its source metadata', () => {
    const request: ExternalMediaPreviewRequest = {
      serverId: 'local-zlm',
      app: 'live',
      stream: 'air-1-0-0',
      url: 'http://127.0.0.1/index/api/webrtc?app=live&stream=air-1-0-0&type=play',
      protocol: 'webrtc',
      title: '飞机 AIR-1 · 普通',
      sourceSn: 'AIR-1',
      nonce: 1,
    }

    expect(resolveExternalPreview(request)).toEqual({
      mode: 'webrtc',
      url: request.url,
      title: request.title,
      sourceLabel: '设备 › 负载',
    })
  })
})
