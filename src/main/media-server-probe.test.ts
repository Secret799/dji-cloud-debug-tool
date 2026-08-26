import { describe, expect, it, vi } from 'vitest'
import type { MediaServerProfile } from '../shared/contracts'
import { probeMediaServer } from './media-server-probe'

const remoteProfile = (overrides: Partial<MediaServerProfile> = {}): MediaServerProfile => ({
  id: 'remote-zlm',
  name: 'Java 内置 ZLM',
  kind: 'remote-zlm',
  host: 'media.example.com',
  apiProtocol: 'http',
  apiPort: 8080,
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

describe('probeMediaServer', () => {
  it('uses the management API when it is available', async () => {
    const connectTcp = vi.fn(async () => false)
    const runtime = await probeMediaServer(remoteProfile(), {
      fetcher: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ code: 0, data: { branchName: 'master', commitHash: 'abc123' } }) })),
      connectTcp,
    })

    expect(runtime.state).toBe('running')
    expect(runtime.version).toBe('master abc123')
    expect(connectTcp).toHaveBeenCalledTimes(3)
  })

  it('treats a remote Java-hosted ZLM as online when its API is hidden but RTMP is reachable', async () => {
    let portProbeStarted = false
    const runtime = await probeMediaServer(remoteProfile(), {
      fetcher: vi.fn(async () => {
        expect(portProbeStarted).toBe(true)
        throw new Error('HTTP 404')
      }),
      connectTcp: vi.fn(async (_host, port) => {
        portProbeStarted = true
        return port === 1935
      }),
    })

    expect(runtime.state).toBe('running')
    expect(runtime.detail).toContain('RTMP 1935')
    expect(runtime.detail).toContain('管理 API 不可用')
  })

  it('reports a remote service unreachable when neither API nor media ports respond', async () => {
    const runtime = await probeMediaServer(remoteProfile(), {
      fetcher: vi.fn(async () => { throw new Error('connect ECONNREFUSED') }),
      connectTcp: vi.fn(async () => false),
    })

    expect(runtime.state).toBe('unreachable')
    expect(runtime.detail).toContain('媒体端口也不可达')
  })

  it('keeps local ZLMediaKit checks strict and does not use a port fallback', async () => {
    const connectTcp = vi.fn(async () => true)
    const runtime = await probeMediaServer(remoteProfile({ id: 'local-zlmediakit', kind: 'local-zlm' }), {
      fetcher: vi.fn(async () => { throw new Error('connect ECONNREFUSED') }),
      connectTcp,
    })

    expect(runtime.state).toBe('unreachable')
    expect(connectTcp).not.toHaveBeenCalled()
  })

  it('recognizes the SecretEMS WHEP route contract from its expected validation response', async () => {
    const fetcher = vi.fn(async (_url: URL, _init: RequestInit) => ({ ok: false, status: 400, json: async () => ({}) }))
    const connectTcp = vi.fn(async () => true)
    const runtime = await probeMediaServer(remoteProfile({
      kind: 'remote-easymedia',
      apiProtocol: 'https',
      apiPort: 443,
      httpProtocol: 'https',
      httpPort: 443,
      rtmpPort: 1935,
      rtspPort: 0,
      webrtcPort: 8000,
    }), { fetcher, connectTcp })

    expect(runtime.state).toBe('running')
    expect(fetcher.mock.calls[0]?.[0].toString()).toBe('https://media.example.com/easyMedia/api/webrtc/whep')
    expect(connectTcp).toHaveBeenCalledTimes(2)
    expect(connectTcp).toHaveBeenCalledWith('media.example.com', 443, 3_000)
    expect(connectTcp).toHaveBeenCalledWith('media.example.com', 1935, 3_000)
  })
})
