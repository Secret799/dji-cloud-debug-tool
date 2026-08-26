import { createConnection } from 'node:net'
import type { MediaServerProfile, MediaServerRuntime } from '../shared/contracts'

const PROBE_TIMEOUT_MS = 3_000

type FetchResponse = Pick<Response, 'ok' | 'status' | 'json'>
type Fetcher = (url: URL, init: RequestInit) => Promise<FetchResponse>
type TcpConnector = (host: string, port: number, timeoutMs: number) => Promise<boolean>

interface ProbeDependencies {
  fetcher?: Fetcher
  connectTcp?: TcpConnector
}

interface MediaPort {
  label: string
  port: number
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

const parseVersion = (kind: MediaServerProfile['kind'], body: unknown): string | undefined => {
  if (!body || typeof body !== 'object') return undefined
  const value = body as Record<string, unknown>
  if (kind === 'remote-srs') {
    const data = value.data as Record<string, unknown> | undefined
    return typeof data?.major_version === 'string' ? data.major_version : typeof value.server === 'string' ? value.server : undefined
  }
  const data = value.data as Record<string, unknown> | undefined
  const commit = typeof data?.commitHash === 'string' ? data.commitHash : undefined
  const branch = typeof data?.branchName === 'string' ? data.branchName : undefined
  return [branch, commit].filter(Boolean).join(' ') || undefined
}

const defaultFetcher: Fetcher = (url, init) => fetch(url, init)

const defaultConnectTcp: TcpConnector = (host, port, timeoutMs) => new Promise((resolve) => {
  let settled = false
  const socket = createConnection({ host, port })
  const finish = (reachable: boolean): void => {
    if (settled) return
    settled = true
    socket.destroy()
    resolve(reachable)
  }
  socket.once('connect', () => finish(true))
  socket.once('error', () => finish(false))
  socket.setTimeout(timeoutMs, () => finish(false))
})

const mediaPorts = (profile: MediaServerProfile): MediaPort[] => {
  const candidates = profile.kind === 'remote-easymedia' ? [
    { label: 'WHIP/WHEP', port: profile.httpPort },
    { label: 'RTMP', port: profile.rtmpPort },
  ] : [
    { label: 'HTTP/HLS', port: profile.httpPort },
    { label: 'RTMP', port: profile.rtmpPort },
    ...(profile.rtspPort > 0 ? [{ label: 'RTSP', port: profile.rtspPort }] : []),
  ]
  const unique = new Map<number, MediaPort>()
  for (const candidate of candidates) {
    const existing = unique.get(candidate.port)
    unique.set(candidate.port, existing
      ? { label: `${existing.label}/${candidate.label}`, port: candidate.port }
      : candidate)
  }
  return [...unique.values()]
}

const probeApi = async (profile: MediaServerProfile, fetcher: Fetcher): Promise<MediaServerRuntime> => {
  const host = profile.kind === 'local-zlm' ? '127.0.0.1' : profile.host
  const path = profile.kind === 'remote-srs'
    ? '/api/v1/versions'
    : profile.kind === 'remote-easymedia'
      ? '/easyMedia/api/webrtc/whep'
      : '/index/api/version'
  const url = new URL(`${profile.apiProtocol}://${host}:${profile.apiPort}${path}`)
  if (profile.secret && profile.kind !== 'remote-srs' && profile.kind !== 'remote-easymedia') url.searchParams.set('secret', profile.secret)
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (profile.kind === 'remote-easymedia' && (response.ok || response.status === 400 || response.status === 405)) {
      return { profileId: profile.id, state: 'running', checkedAt: Date.now() }
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body: unknown = await response.json()
    const code = body && typeof body === 'object' ? (body as Record<string, unknown>).code : undefined
    if (typeof code === 'number' && code !== 0) throw new Error(`API code ${code}`)
    return {
      profileId: profile.id,
      state: 'running',
      checkedAt: Date.now(),
      version: parseVersion(profile.kind, body),
    }
  } catch (error) {
    return { profileId: profile.id, state: 'unreachable', checkedAt: Date.now(), detail: errorMessage(error) }
  }
}

export const probeMediaServer = async (
  profile: MediaServerProfile,
  dependencies: ProbeDependencies = {},
): Promise<MediaServerRuntime> => {
  const connectTcp = dependencies.connectTcp ?? defaultConnectTcp
  const portResults = profile.kind === 'local-zlm' ? undefined : Promise.all(mediaPorts(profile).map(async (endpoint) => ({
    ...endpoint,
    reachable: await connectTcp(profile.host, endpoint.port, PROBE_TIMEOUT_MS).catch(() => false),
  })))
  const apiRuntime = await probeApi(profile, dependencies.fetcher ?? defaultFetcher)
  if (apiRuntime.state === 'running' || profile.kind === 'local-zlm') return apiRuntime

  const results = await portResults ?? []
  const reachable = results.filter((result) => result.reachable)
  if (reachable.length > 0) {
    const endpoints = reachable.map((result) => `${result.label} ${result.port}`).join('、')
    return {
      profileId: profile.id,
      state: 'running',
      checkedAt: Date.now(),
      detail: `管理 API 不可用（${apiRuntime.detail ?? '未知错误'}），但媒体端口可达：${endpoints}`,
    }
  }

  return {
    profileId: profile.id,
    state: 'unreachable',
    checkedAt: Date.now(),
    detail: `管理 API 不可用（${apiRuntime.detail ?? '未知错误'}），媒体端口也不可达`,
  }
}
