import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  CircleAlert,
  Cloud,
  Copy,
  HardDrive,
  LoaderCircle,
  Plus,
  RefreshCw,
  Server,
  Settings2,
  Square,
  Star,
  Trash2,
  X,
} from 'lucide-react'
import type { MediaServerKind, MediaServerProfile, MediaServerRuntime } from '../../../shared/contracts'
import { Tooltip } from '../components/Tooltip'
import { buildMediaEndpoints } from '../lib/media'

interface MediaCenterProps {
  onNotify: (text: string, tone?: 'info' | 'success' | 'error') => void
}

const runtimeLabel: Record<MediaServerRuntime['state'], string> = {
  stopped: '已停止',
  starting: '启动中',
  running: '在线',
  unreachable: '不可达',
  error: '异常',
}

const kindLabel: Record<MediaServerKind, string> = {
  'local-zlm': '本地 ZLMediaKit',
  'remote-zlm': '远程 ZLMediaKit',
  'remote-srs': '远程 SRS',
  'remote-easymedia': 'SecretEMS',
}

type RemoteMediaServerKind = Exclude<MediaServerKind, 'local-zlm'>

const remoteKindDefaults = (kind: RemoteMediaServerKind): Partial<MediaServerProfile> => {
  if (kind === 'remote-srs') {
    return { name: '远程 SRS', apiProtocol: 'http', apiPort: 1985, httpProtocol: 'http', httpPort: 8080, rtmpPort: 1935, rtspPort: 0, webrtcPort: 8000 }
  }
  if (kind === 'remote-easymedia') {
    return { name: 'SecretEMS', apiProtocol: 'https', apiPort: 443, httpProtocol: 'https', httpPort: 443, rtmpPort: 1935, rtspPort: 0, webrtcPort: 8000, secret: '', clearStoredSecret: true }
  }
  return { name: '远程 ZLMediaKit', apiProtocol: 'http', apiPort: 80, httpProtocol: 'http', httpPort: 80, rtmpPort: 1935, rtspPort: 554, webrtcPort: 8000 }
}

const displayedServerPort = (server: MediaServerProfile): number =>
  server.kind === 'remote-easymedia' ? server.httpPort : server.rtmpPort

const displayedRuntimeLabel = (server: MediaServerProfile, runtime?: MediaServerRuntime): string =>
  runtime ? runtimeLabel[runtime.state] : server.kind === 'local-zlm' ? '已停止' : '未检测'

const createRemoteProfile = (): MediaServerProfile => {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    name: '远程 ZLMediaKit',
    kind: 'remote-zlm',
    host: '',
    apiProtocol: 'http',
    apiPort: 80,
    httpProtocol: 'http',
    httpPort: 80,
    rtmpPort: 1935,
    rtspPort: 554,
    webrtcPort: 8000,
    secret: '',
    isDefault: false,
    createdAt: now,
    updatedAt: now,
  }
}

export function MediaCenter({ onNotify }: MediaCenterProps) {
  const [servers, setServers] = useState<MediaServerProfile[]>([])
  const [runtimeById, setRuntimeById] = useState<Record<string, MediaServerRuntime>>({})
  const [selectedId, setSelectedId] = useState('')
  const [editor, setEditor] = useState<MediaServerProfile | null>(null)
  const [busyId, setBusyId] = useState('')
  const [loading, setLoading] = useState(true)
  const [streamApp, setStreamApp] = useState('live')
  const [streamName, setStreamName] = useState('dji')

  const updateRuntime = (runtime: MediaServerRuntime): void => {
    setRuntimeById((current) => ({ ...current, [runtime.profileId]: runtime }))
  }

  useEffect(() => {
    let disposed = false
    const unsubscribe = window.djiApi.media.onRuntimeEvent((runtime) => {
      if (!disposed) updateRuntime(runtime)
    })
    void Promise.all([window.djiApi.media.listServers(), window.djiApi.media.getLocalRuntime()])
      .then(([loadedServers, localRuntime]) => {
        if (disposed) return
        setServers(loadedServers)
        setSelectedId(loadedServers.find((server) => server.isDefault)?.id ?? loadedServers[0]?.id ?? '')
        updateRuntime(localRuntime)
        setLoading(false)
        loadedServers.filter((server) => server.kind !== 'local-zlm').forEach((server) => {
          void window.djiApi.media.checkServer(server.id).then((result) => {
            if (!disposed && result.runtime) updateRuntime(result.runtime)
          })
        })
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setLoading(false)
          onNotify(`加载媒体服务失败：${error instanceof Error ? error.message : String(error)}`, 'error')
        }
      })
    return () => { disposed = true; unsubscribe() }
  }, [onNotify])

  const selectedServer = servers.find((server) => server.id === selectedId) ?? servers[0]
  const selectedRuntime = selectedServer ? runtimeById[selectedServer.id] : undefined
  const endpoints = useMemo(
    () => selectedServer ? buildMediaEndpoints(selectedServer, streamApp, streamName) : null,
    [selectedServer, streamApp, streamName],
  )

  const checkServer = async (server: MediaServerProfile): Promise<void> => {
    setBusyId(server.id)
    try {
      const result = await window.djiApi.media.checkServer(server.id)
      if (result.runtime) updateRuntime(result.runtime)
      onNotify(result.ok ? `${server.name} 在线` : result.error ?? '媒体服务不可达', result.ok ? 'success' : 'error')
    } finally {
      setBusyId('')
    }
  }

  const toggleLocal = async (): Promise<void> => {
    const local = servers.find((server) => server.kind === 'local-zlm')
    if (!local) return
    setBusyId(local.id)
    try {
      const running = runtimeById[local.id]?.state === 'running' || runtimeById[local.id]?.state === 'starting'
      const result = running ? await window.djiApi.media.stopLocal() : await window.djiApi.media.startLocal()
      if (result.runtime) updateRuntime(result.runtime)
      onNotify(result.ok ? (running ? '本地 ZLMediaKit 已停止' : '本地 ZLMediaKit 已启动') : result.error ?? '本地服务操作失败', result.ok ? 'success' : 'error')
    } finally {
      setBusyId('')
    }
  }

  const saveServer = async (): Promise<void> => {
    if (!editor) return
    if (!editor.name.trim() || !editor.host.trim()) {
      onNotify('请填写服务名称和主机地址', 'error')
      return
    }
    setBusyId(editor.id)
    try {
      const wasLocalRunning = editor.kind === 'local-zlm' && runtimeById[editor.id]?.state === 'running'
      if (wasLocalRunning) await window.djiApi.media.stopLocal()
      const saved = await window.djiApi.media.saveServer(editor)
      setServers((current) => current.some((server) => server.id === saved.id)
        ? current.map((server) => server.id === saved.id ? saved : server)
        : [...current, saved])
      setSelectedId(saved.id)
      setEditor(null)
      if (wasLocalRunning) {
        const result = await window.djiApi.media.startLocal()
        if (result.runtime) updateRuntime(result.runtime)
        if (!result.ok) throw new Error(result.error ?? '新配置已保存，但本地 ZLM 重启失败')
      }
      onNotify('媒体服务配置已保存', 'success')
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusyId('')
    }
  }

  const setDefaultServer = async (server: MediaServerProfile): Promise<void> => {
    if (server.isDefault) return
    setBusyId(server.id)
    try {
      const saved = await window.djiApi.media.saveServer({ ...server, isDefault: true })
      setServers((current) => current.map((item) => item.id === saved.id
        ? saved
        : { ...item, isDefault: false }))
      setSelectedId(saved.id)
      onNotify(`已将${server.name}设为默认媒体服务`, 'success')
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusyId('')
    }
  }

  const removeServer = async (): Promise<void> => {
    if (!editor || editor.kind === 'local-zlm' || !window.confirm(`确认删除“${editor.name}”？`)) return
    setBusyId(editor.id)
    try {
      const result = await window.djiApi.media.removeServer(editor.id)
      if (!result.ok) throw new Error(result.error ?? '删除失败')
      const remaining = await window.djiApi.media.listServers()
      setServers(remaining)
      setSelectedId(remaining.find((server) => server.isDefault)?.id ?? remaining[0]?.id ?? '')
      setEditor(null)
      onNotify('远程媒体服务已删除', 'success')
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusyId('')
    }
  }

  const copyEndpoint = async (value: string): Promise<void> => {
    await navigator.clipboard.writeText(value)
    onNotify('地址已复制', 'success')
  }

  if (loading) return <div className="media-loading"><LoaderCircle className="spin" size={22} /><span>正在加载媒体服务</span></div>

  return (
    <div className="media-center">
      <aside className="media-server-panel">
        <div className="media-server-actions">
          <button className="button primary compact" onClick={() => setEditor(createRemoteProfile())}><Plus size={14} />添加远程服务</button>
          {selectedServer && <Tooltip label="刷新状态"><button className="icon-button" disabled={Boolean(busyId)} onClick={() => void checkServer(selectedServer)}><RefreshCw className={busyId === selectedServer.id ? 'spin' : ''} size={15} /></button></Tooltip>}
        </div>
        <div className="media-server-list">
          {servers.map((server) => {
            const runtime = runtimeById[server.id]
            const Icon = server.kind === 'local-zlm' ? HardDrive : server.kind === 'remote-srs' || server.kind === 'remote-easymedia' ? Cloud : Server
            return (
              <div key={server.id} className={`media-server-row ${selectedServer?.id === server.id ? 'selected' : ''}`}>
                <button className="media-server-select" onClick={() => setSelectedId(server.id)}>
                  <span className={`media-server-icon ${server.kind}`}><Icon size={15} /></span>
                  <span className="media-server-copy"><strong>{server.name}</strong><small>{server.host}:{displayedServerPort(server)}</small></span>
                  <span className={`server-state-dot ${runtime?.state ?? 'stopped'}`} title={displayedRuntimeLabel(server, runtime)} />
                </button>
                <Tooltip label={server.isDefault ? '默认服务' : '设为默认'}>
                  <button
                    className={`media-server-default ${server.isDefault ? 'active' : ''}`}
                    aria-pressed={Boolean(server.isDefault)}
                    disabled={server.isDefault || Boolean(busyId)}
                    onClick={() => void setDefaultServer(server)}
                  >
                    <Star size={14} fill={server.isDefault ? 'currentColor' : 'none'} />
                  </button>
                </Tooltip>
              </div>
            )
          })}
        </div>
      </aside>

      {selectedServer && endpoints ? (
        <div className="media-service-workspace">
          <section className="media-service-config">
            <div className="media-service-config-inner">
              <header className="media-service-header">
                <div><span className={`server-state-dot large ${selectedRuntime?.state ?? 'stopped'}`} /><div><h2>{selectedServer.name}</h2><span>{kindLabel[selectedServer.kind]} · {displayedRuntimeLabel(selectedServer, selectedRuntime)}{selectedRuntime?.version ? ` · ${selectedRuntime.version}` : ''}</span></div></div>
                <div className="media-service-buttons">
                  {selectedServer.kind === 'local-zlm' && (
                    <button className={`button compact ${selectedRuntime?.state === 'running' ? 'secondary' : 'primary'}`} disabled={busyId === selectedServer.id} onClick={() => void toggleLocal()}>
                      {busyId === selectedServer.id ? <LoaderCircle className="spin" size={14} /> : selectedRuntime?.state === 'running' ? <Square size={12} /> : <Activity size={14} />}
                      {selectedRuntime?.state === 'running' ? '停止服务' : '启动服务'}
                    </button>
                  )}
                  <Tooltip label="服务设置"><button className="icon-button" onClick={() => setEditor({ ...selectedServer })}><Settings2 size={16} /></button></Tooltip>
                </div>
              </header>
              {selectedRuntime?.detail && <div className="media-service-alert"><CircleAlert size={14} /><span>{selectedRuntime.detail}</span></div>}
              <div className="stream-target-row">
                <label className="field"><span>应用名</span><input value={streamApp} onChange={(event) => setStreamApp(event.target.value)} /></label>
                <label className="field"><span>流 ID</span><input value={streamName} onChange={(event) => setStreamName(event.target.value)} /></label>
              </div>
              <div className="media-endpoint-list">
                {endpoints.rtmp && <div><span>RTMP 推流</span><code>{endpoints.rtmp}</code><Tooltip label="复制 RTMP 地址"><button className="icon-button small" onClick={() => void copyEndpoint(endpoints.rtmp!)}><Copy size={13} /></button></Tooltip></div>}
                {endpoints.rtsp && <div><span>RTSP 地址</span><code>{endpoints.rtsp}</code><Tooltip label="复制 RTSP 地址"><button className="icon-button small" onClick={() => void copyEndpoint(endpoints.rtsp!)}><Copy size={13} /></button></Tooltip></div>}
                {endpoints.webrtc && <div><span>WebRTC 地址</span><code>{endpoints.webrtc}</code><Tooltip label="复制 WebRTC 地址"><button className="icon-button small" onClick={() => void copyEndpoint(endpoints.webrtc!)}><Copy size={13} /></button></Tooltip></div>}
                {endpoints.hls && <div><span>HLS 地址</span><code>{endpoints.hls}</code><Tooltip label="复制 HLS 地址"><button className="icon-button small" onClick={() => void copyEndpoint(endpoints.hls!)}><Copy size={13} /></button></Tooltip></div>}
                {endpoints.whip && <div><span>WHIP 推流</span><code>{endpoints.whip}</code><Tooltip label="复制 WHIP 地址"><button className="icon-button small" onClick={() => void copyEndpoint(endpoints.whip!)}><Copy size={13} /></button></Tooltip></div>}
                {endpoints.whep && <div><span>WHEP 播放</span><code>{endpoints.whep}</code><Tooltip label="复制 WHEP 地址"><button className="icon-button small" onClick={() => void copyEndpoint(endpoints.whep!)}><Copy size={13} /></button></Tooltip></div>}
              </div>
            </div>
          </section>
        </div>
      ) : <div className="media-loading"><Server size={22} /><span>暂无媒体服务</span></div>}

      {editor && (
        <div className="modal-backdrop">
          <div className="modal media-server-modal" role="dialog" aria-modal="true" aria-label="媒体服务设置">
            <header className="modal-header"><div><span className="eyebrow">MEDIA SERVER</span><h2>{editor.kind === 'local-zlm' ? '本地 ZLMediaKit 设置' : servers.some((server) => server.id === editor.id) ? '编辑远程服务' : '添加远程服务'}</h2></div><Tooltip label="关闭"><button className="icon-button" onClick={() => setEditor(null)}><X size={17} /></button></Tooltip></header>
            <div className="modal-body settings-form">
              {editor.kind !== 'local-zlm' && (
                <label className="field"><span>服务类型</span><select value={editor.kind} onChange={(event) => {
                  const kind = event.target.value as RemoteMediaServerKind
                  setEditor({ ...editor, kind, ...remoteKindDefaults(kind) })
                }}><option value="remote-zlm">ZLMediaKit</option><option value="remote-srs">SRS</option><option value="remote-easymedia">SecretEMS</option></select></label>
              )}
              <div className="field-grid two-columns"><label className="field"><span>名称</span><input value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} /></label><label className="field"><span>{editor.kind === 'local-zlm' ? '对设备公布的局域网 IP' : '主机或 IP'}</span><input value={editor.host} onChange={(event) => setEditor({ ...editor, host: event.target.value })} /></label></div>
              {editor.kind === 'remote-easymedia' ? <>
                <div className="field-grid three-columns media-port-grid">
                  <label className="field"><span>WHIP/WHEP 端口</span><input type="number" min={1} max={65535} value={editor.httpPort} onChange={(event) => {
                    const port = Number(event.target.value)
                    setEditor({ ...editor, apiPort: port, httpPort: port })
                  }} /></label>
                  <label className="field"><span>RTMP 端口</span><input type="number" min={1} max={65535} value={editor.rtmpPort} onChange={(event) => setEditor({ ...editor, rtmpPort: Number(event.target.value) })} /></label>
                  <label className="field"><span>WebRTC 媒体端口</span><input type="number" min={1} max={65535} value={editor.webrtcPort} onChange={(event) => setEditor({ ...editor, webrtcPort: Number(event.target.value) })} /></label>
                </div>
                <label className="field reconnect-field"><span>信令协议</span><select value={editor.httpProtocol} onChange={(event) => {
                  const protocol = event.target.value as 'http' | 'https'
                  setEditor({ ...editor, apiProtocol: protocol, httpProtocol: protocol })
                }}><option value="https">HTTPS</option><option value="http">HTTP</option></select></label>
              </> : <>
                <div className="field-grid three-columns media-port-grid">
                <label className="field"><span>API 端口</span><input type="number" min={1} max={65535} value={editor.apiPort} onChange={(event) => {
                  const apiPort = Number(event.target.value)
                  setEditor({ ...editor, apiPort, httpPort: editor.kind === 'local-zlm' ? apiPort : editor.httpPort })
                }} /></label>
                <label className="field"><span>HTTP/HLS 端口</span><input type="number" min={1} max={65535} value={editor.httpPort} onChange={(event) => {
                  const httpPort = Number(event.target.value)
                  setEditor({ ...editor, httpPort, apiPort: editor.kind === 'local-zlm' ? httpPort : editor.apiPort })
                }} /></label>
                <label className="field"><span>RTMP 端口</span><input type="number" min={1} max={65535} value={editor.rtmpPort} onChange={(event) => setEditor({ ...editor, rtmpPort: Number(event.target.value) })} /></label>
                </div>
                <div className="field-grid two-columns media-secondary-port-grid">
                  {editor.kind !== 'remote-srs' && <label className="field"><span>RTSP 端口</span><input type="number" min={1} max={65535} value={editor.rtspPort} onChange={(event) => setEditor({ ...editor, rtspPort: Number(event.target.value) })} /></label>}
                  {editor.kind !== 'local-zlm' && <label className="field"><span>WebRTC 端口（0 禁用）</span><input type="number" min={0} max={65535} value={editor.webrtcPort} onChange={(event) => setEditor({ ...editor, webrtcPort: Number(event.target.value) })} /></label>}
                </div>
                {editor.kind !== 'local-zlm' && <div className="field-grid two-columns"><label className="field"><span>API 协议</span><select value={editor.apiProtocol} onChange={(event) => setEditor({ ...editor, apiProtocol: event.target.value as 'http' | 'https' })}><option value="http">HTTP</option><option value="https">HTTPS</option></select></label><label className="field"><span>播放协议</span><select value={editor.httpProtocol} onChange={(event) => setEditor({ ...editor, httpProtocol: event.target.value as 'http' | 'https' })}><option value="http">HTTP</option><option value="https">HTTPS</option></select></label></div>}
                <label className="field"><span>API Secret{editor.hasStoredSecret && !editor.secret ? '（已保存，留空保持不变）' : ''}</span><input type="password" value={editor.secret} onChange={(event) => setEditor({ ...editor, secret: event.target.value, clearStoredSecret: false })} /></label>
              </>}
            </div>
            <footer className="modal-footer">{editor.kind === 'local-zlm' || !servers.some((server) => server.id === editor.id) ? <span /> : <button className="button danger-ghost" onClick={() => void removeServer()}><Trash2 size={14} />删除</button>}<div className="footer-actions"><button className="button secondary" onClick={() => setEditor(null)}>取消</button><button className="button primary" disabled={busyId === editor.id} onClick={() => void saveServer()}>保存服务</button></div></footer>
          </div>
        </div>
      )}
    </div>
  )
}
