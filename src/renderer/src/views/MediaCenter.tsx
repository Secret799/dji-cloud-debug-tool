import { useEffect, useMemo, useRef, useState } from 'react'
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
import { SecretInput } from '../components/SecretInput'
import { Tooltip } from '../components/Tooltip'
import { buildMediaEndpoints } from '../lib/media'

interface MediaCenterProps {
  servers: MediaServerProfile[]
  runtimeById: Record<string, MediaServerRuntime>
  loading: boolean
  onServersChange: (servers: MediaServerProfile[]) => void
  onRuntimeChange: (runtime: MediaServerRuntime) => void
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

export function MediaCenter({
  servers,
  runtimeById,
  loading,
  onServersChange,
  onRuntimeChange,
  onNotify,
}: MediaCenterProps) {
  const [selectedId, setSelectedId] = useState('')
  const [editor, setEditor] = useState<MediaServerProfile | null>(null)
  const editorLoadGeneration = useRef(0)
  const [busyId, setBusyId] = useState('')
  const [streamApp, setStreamApp] = useState('live')
  const [streamName, setStreamName] = useState('dji')

  useEffect(() => {
    setSelectedId((current) => {
      const next = servers.some((server) => server.id === current)
        ? current
        : servers.find((server) => server.isDefault)?.id ?? servers[0]?.id ?? ''
      if (next !== current) editorLoadGeneration.current += 1
      return next
    })
  }, [servers])

  useEffect(() => () => { editorLoadGeneration.current += 1 }, [])

  const selectedServer = servers.find((server) => server.id === selectedId)
    ?? servers.find((server) => server.isDefault)
    ?? servers[0]
  const selectedRuntime = selectedServer ? runtimeById[selectedServer.id] : undefined
  const endpoints = useMemo(
    () => selectedServer ? buildMediaEndpoints(selectedServer, streamApp, streamName) : null,
    [selectedServer, streamApp, streamName],
  )

  const openServerEditor = async (server: MediaServerProfile): Promise<void> => {
    const generation = editorLoadGeneration.current + 1
    editorLoadGeneration.current = generation
    try {
      const resolved = await window.djiApi.media.resolveServer(server.id)
      if (editorLoadGeneration.current !== generation) return
      if (!resolved) throw new Error('媒体服务配置已不存在')
      setEditor(resolved)
    } catch (error) {
      if (editorLoadGeneration.current !== generation) return
      setEditor({ ...server })
      onNotify(`解密 API Secret 失败：${error instanceof Error ? error.message : String(error)}，可重新输入后保存`, 'error')
    }
  }

  const selectServer = (profileId: string): void => {
    editorLoadGeneration.current += 1
    setSelectedId(profileId)
  }

  const closeServerEditor = (): void => {
    editorLoadGeneration.current += 1
    setEditor(null)
  }

  const checkServer = async (server: MediaServerProfile): Promise<void> => {
    setBusyId(server.id)
    try {
      const result = await window.djiApi.media.checkServer(server.id)
      if (result.runtime) onRuntimeChange(result.runtime)
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
      if (result.runtime) onRuntimeChange(result.runtime)
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
      onServersChange(servers.some((server) => server.id === saved.id)
        ? servers.map((server) => server.id === saved.id ? saved : server)
        : [...servers, saved])
      if (saved.kind !== 'local-zlm') {
        void window.djiApi.media.checkServer(saved.id).then((result) => {
          if (result.runtime) onRuntimeChange(result.runtime)
        })
      }
      selectServer(saved.id)
      closeServerEditor()
      if (wasLocalRunning) {
        const result = await window.djiApi.media.startLocal()
        if (result.runtime) onRuntimeChange(result.runtime)
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
      onServersChange(servers.map((item) => item.id === saved.id
        ? saved
        : { ...item, isDefault: false }))
      selectServer(saved.id)
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
      onServersChange(remaining)
      selectServer(remaining.find((server) => server.isDefault)?.id ?? remaining[0]?.id ?? '')
      closeServerEditor()
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
          <button className="button primary compact" onClick={() => {
            editorLoadGeneration.current += 1
            setEditor(createRemoteProfile())
          }}><Plus size={14} />添加远程服务</button>
          {selectedServer && <Tooltip label="刷新状态"><button className="icon-button" disabled={Boolean(busyId)} onClick={() => void checkServer(selectedServer)}><RefreshCw className={busyId === selectedServer.id ? 'spin' : ''} size={15} /></button></Tooltip>}
        </div>
        <div className="media-server-list">
          {servers.map((server) => {
            const runtime = runtimeById[server.id]
            const Icon = server.kind === 'local-zlm' ? HardDrive : server.kind === 'remote-srs' || server.kind === 'remote-easymedia' ? Cloud : Server
            return (
              <div key={server.id} className={`media-server-row ${selectedServer?.id === server.id ? 'selected' : ''}`}>
                <button className="media-server-select" onClick={() => selectServer(server.id)}>
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
                  <Tooltip label="服务设置"><button className="icon-button" onClick={() => void openServerEditor(selectedServer)}><Settings2 size={16} /></button></Tooltip>
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
                {endpoints.seiDiagnostics && <div><span>SEI 诊断</span><code>{endpoints.seiDiagnostics}</code><Tooltip label="复制 SEI 诊断地址"><button className="icon-button small" onClick={() => void copyEndpoint(endpoints.seiDiagnostics!)}><Copy size={13} /></button></Tooltip></div>}
              </div>
            </div>
          </section>
        </div>
      ) : <div className="media-loading"><Server size={22} /><span>暂无媒体服务</span></div>}

      {editor && (
        <div className="modal-backdrop">
          <div className="modal media-server-modal" role="dialog" aria-modal="true" aria-label="媒体服务设置">
            <header className="modal-header"><div><span className="eyebrow">MEDIA SERVER</span><h2>{editor.kind === 'local-zlm' ? '本地 ZLMediaKit 设置' : servers.some((server) => server.id === editor.id) ? '编辑远程服务' : '添加远程服务'}</h2></div><Tooltip label="关闭"><button className="icon-button" onClick={closeServerEditor}><X size={17} /></button></Tooltip></header>
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
                  {editor.kind !== 'remote-srs' && <label className="field"><span>WebRTC 端口{editor.kind === 'local-zlm' ? '' : '（0 禁用）'}</span><input type="number" min={editor.kind === 'local-zlm' ? 1 : 0} max={65535} value={editor.webrtcPort} onChange={(event) => setEditor({ ...editor, webrtcPort: Number(event.target.value) })} /></label>}
                </div>
                {editor.kind !== 'local-zlm' && <div className="field-grid two-columns"><label className="field"><span>API 协议</span><select value={editor.apiProtocol} onChange={(event) => setEditor({ ...editor, apiProtocol: event.target.value as 'http' | 'https' })}><option value="http">HTTP</option><option value="https">HTTPS</option></select></label><label className="field"><span>播放协议</span><select value={editor.httpProtocol} onChange={(event) => setEditor({ ...editor, httpProtocol: event.target.value as 'http' | 'https' })}><option value="http">HTTP</option><option value="https">HTTPS</option></select></label></div>}
                <SecretInput
                  key={editor.id}
                  label="API Secret"
                  value={editor.secret}
                  onChange={(secret) => setEditor({
                    ...editor,
                    secret,
                    clearStoredSecret: secret ? false : Boolean(editor.hasStoredSecret),
                  })}
                  placeholder={editor.clearStoredSecret ? '保存后清除' : editor.hasStoredSecret ? '已加密保存' : '可选'}
                />
              </>}
            </div>
            <footer className="modal-footer">{editor.kind === 'local-zlm' || !servers.some((server) => server.id === editor.id) ? <span /> : <button className="button danger-ghost" onClick={() => void removeServer()}><Trash2 size={14} />删除</button>}<div className="footer-actions"><button className="button secondary" onClick={closeServerEditor}>取消</button><button className="button primary" disabled={busyId === editor.id} onClick={() => void saveServer()}>保存服务</button></div></footer>
          </div>
        </div>
      )}
    </div>
  )
}
