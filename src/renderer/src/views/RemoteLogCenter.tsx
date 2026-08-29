import { useEffect, useMemo, useState } from 'react'
import {
  Ban,
  CheckCircle2,
  CircleAlert,
  CloudUpload,
  Database,
  FileArchive,
  LoaderCircle,
  RefreshCw,
  Settings,
} from 'lucide-react'
import type {
  ConnectionStatus,
  MqttMessageRecord,
  MqttQos,
  ObjectStorageProfile,
  OperationResult,
} from '../../../shared/contracts'
import {
  buildLogCancelPayload,
  buildLogListPayload,
  latestLogFileList,
  latestLogProgress,
  latestLogServiceReplies,
  logFileId,
  type DjiLogModule,
} from '../lib/dji-log'
import { objectStorageProfileIssues } from '../lib/object-storage'

interface RemoteLogCenterProps {
  profileId: string
  gatewaySn: string
  status: ConnectionStatus
  busy: boolean
  records: MqttMessageRecord[]
  objectStorageProfiles: ObjectStorageProfile[]
  activeObjectStorageId: string
  onPublish: (topic: string, payload: string, qos: MqttQos, retain: boolean) => Promise<OperationResult>
  onNotify: (text: string, tone?: 'info' | 'success' | 'error') => void
  onOpenOssManager: () => void
  onSelectObjectStorage: (profileId: string) => void
}

const moduleLabels: Record<DjiLogModule, string> = { '0': '飞行器', '3': '机场' }
const providerLabels: Record<ObjectStorageProfile['provider'], string> = { ali: '阿里云 OSS', aws: 'Amazon S3', minio: 'MinIO' }

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
}

const formatTime = (timestamp: number): string => new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
}).format(timestamp)

const defaultObjectKey = (gatewaySn: string, module: DjiLogModule): string =>
  `dji-logs/${gatewaySn}/${module === '0' ? 'aircraft' : 'dock'}-${Date.now()}.log`

const resultLabel = (result: number | undefined): string =>
  result === undefined ? '已响应' : result === 0 ? '成功' : `失败 (${result})`

export function RemoteLogCenter({
  profileId,
  gatewaySn,
  status,
  busy,
  records,
  objectStorageProfiles,
  activeObjectStorageId,
  onPublish,
  onNotify,
  onOpenOssManager,
  onSelectObjectStorage,
}: RemoteLogCenterProps) {
  const [queryModules, setQueryModules] = useState<Set<DjiLogModule>>(() => new Set(['0', '3']))
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [objectKeys, setObjectKeys] = useState<Partial<Record<DjiLogModule, string>>>({})
  const [action, setAction] = useState<'list' | 'start' | 'cancel' | ''>('')

  useEffect(() => {
    setSelectedIds(new Set())
    setObjectKeys({})
  }, [gatewaySn])

  const files = useMemo(() => latestLogFileList(records, gatewaySn), [records, gatewaySn])
  const progress = useMemo(() => latestLogProgress(records, gatewaySn), [records, gatewaySn])
  const replies = useMemo(() => latestLogServiceReplies(records, gatewaySn), [records, gatewaySn])
  const latestListReply = replies.find((reply) => reply.method === 'fileupload_list')
  const latestUploadReply = replies.find((reply) => reply.method !== 'fileupload_list')
  const hasListReply = Boolean(latestListReply)
  const selectedFiles = useMemo(
    () => files.filter((file) => selectedIds.has(logFileId(file))),
    [files, selectedIds],
  )
  const selectedModules = useMemo(
    () => [...new Set(selectedFiles.map((file) => file.module))],
    [selectedFiles],
  )
  const activeModules = useMemo(
    () => [...new Set(progress.filter((item) => item.progress < 100 && item.status !== 'ok').map((item) => item.module))],
    [progress],
  )
  const connected = status === 'connected' && !busy
  const activeObjectStorage = objectStorageProfiles.find((profile) => profile.id === activeObjectStorageId)
  const configIssues = activeObjectStorage ? objectStorageProfileIssues(activeObjectStorage) : ['对象存储配置']
  const configReady = Boolean(activeObjectStorage) && !configIssues.length

  useEffect(() => {
    const availableIds = new Set(files.map(logFileId))
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => availableIds.has(id)))
      return next.size === current.size ? current : next
    })
  }, [files])

  const publish = async (payload: string): Promise<void> => {
    const result = await onPublish(`thing/product/${gatewaySn}/services`, payload, 1, false)
    if (!result.ok) throw new Error(result.error ?? 'MQTT 发布失败')
  }

  const queryFiles = async (): Promise<void> => {
    const modules = [...queryModules]
    if (!gatewaySn || !modules.length) return
    setAction('list')
    try {
      await publish(buildLogListPayload(modules))
      setSelectedIds(new Set())
      onNotify('日志文件列表请求已发送', 'success')
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setAction('')
    }
  }

  const toggleFile = (id: string, module: DjiLogModule): void => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setObjectKeys((current) => current[module]
      ? current
      : { ...current, [module]: defaultObjectKey(gatewaySn, module) })
  }

  const startUpload = async (): Promise<void> => {
    if (!selectedFiles.length) return onNotify('请至少选择一个日志文件', 'error')
    if (!activeObjectStorage || !configReady) {
      onNotify(`请先在 OSS 管理中填写：${configIssues.join('、')}`, 'error')
      onOpenOssManager()
      return
    }
    setAction('start')
    try {
      const result = await window.djiApi.remoteLogs.startUpload({
        profileId,
        gatewaySn,
        objectStorageProfileId: activeObjectStorage.id,
        files: selectedFiles.map(({ module, bootIndex }) => ({ module, bootIndex })),
        objectKeys,
      })
      if (!result.ok) throw new Error(result.error ?? '日志上传请求发送失败')
      onNotify(`已发起 ${selectedFiles.length} 个日志文件上传`, 'success')
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setAction('')
    }
  }

  const cancelUpload = async (): Promise<void> => {
    const modules = activeModules.length ? activeModules : selectedModules
    if (!modules.length) return onNotify('没有可取消的日志模块', 'error')
    setAction('cancel')
    try {
      await publish(buildLogCancelPayload(modules))
      onNotify('取消上传请求已发送', 'success')
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setAction('')
    }
  }

  if (!gatewaySn) {
    return (
      <div className="empty-workspace remote-log-empty">
        <FileArchive size={30} />
        <h2>暂无机场设备</h2>
        <p>请先在当前连接中添加 DJI Dock 3 设备。</p>
      </div>
    )
  }

  return (
    <div className="remote-log-center">
      <section className="remote-log-toolbar">
        <fieldset className="remote-log-module-filter">
          <legend>日志模块</legend>
          {(['0', '3'] as DjiLogModule[]).map((module) => (
            <label key={module}>
              <input type="checkbox" checked={queryModules.has(module)} onChange={(event) => setQueryModules((current) => {
                const next = new Set(current)
                if (event.target.checked) next.add(module)
                else next.delete(module)
                return next
              })} />
              <span>{moduleLabels[module]}</span>
            </label>
          ))}
        </fieldset>
        <button className="button primary remote-log-query" disabled={!connected || !queryModules.size || Boolean(action)} onClick={() => void queryFiles()}>
          {action === 'list' ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
          获取文件列表
        </button>
      </section>

      <div className="remote-log-layout">
        <section className="remote-log-panel remote-log-files">
          <header className="remote-log-panel-header">
            <div><FileArchive size={16} /><div><h2>可上传日志</h2><span>{files.length} 个文件 · 已选 {selectedFiles.length} 个</span></div></div>
            {latestListReply && <span className={`remote-log-reply ${latestListReply.result === 0 || latestListReply.result === undefined ? 'success' : 'error'}`}>{resultLabel(latestListReply.result)}</span>}
          </header>
          <div className="remote-log-file-list">
            {files.length ? files.map((file) => {
              const id = logFileId(file)
              return (
                <label className={`remote-log-file-row ${selectedIds.has(id) ? 'selected' : ''}`} key={id}>
                  <input type="checkbox" checked={selectedIds.has(id)} onChange={() => toggleFile(id, file.module)} />
                  <span className={`remote-log-module module-${file.module}`}>{moduleLabels[file.module]}</span>
                  <span className="remote-log-file-copy"><strong>启动索引 {file.bootIndex}</strong><small>{file.deviceSn}</small></span>
                  <span className="remote-log-file-time"><strong>{formatTime(file.startTime)}</strong><small>至 {formatTime(file.endTime)}</small></span>
                  <span className="remote-log-file-size">{formatBytes(file.size)}</span>
                </label>
              )
            }) : (
              <div className="remote-log-placeholder">
                <FileArchive size={22} />
                <span>{hasListReply ? '设备未返回可上传日志' : '尚未获取日志文件列表'}</span>
              </div>
            )}
          </div>
        </section>

        <section className="remote-log-panel remote-log-upload">
          <header className="remote-log-panel-header">
            <div><CloudUpload size={16} /><div><h2>日志上传</h2><span>{selectedFiles.length ? `${selectedFiles.length} 个文件待上传` : '未选择文件'}</span></div></div>
            {latestUploadReply && <span className={`remote-log-reply ${latestUploadReply.result === 0 || latestUploadReply.result === undefined ? 'success' : 'error'}`}>{resultLabel(latestUploadReply.result)}</span>}
          </header>
          <form className="remote-log-form" autoComplete="off" onSubmit={(event) => {
            event.preventDefault()
            void startUpload()
          }}>
            <div className={`remote-log-oss-summary ${configReady ? 'ready' : 'incomplete'}`}>
              <Database size={16} />
              <div>
                <label className="remote-log-storage-select">
                  <span>对象存储</span>
                  <select value={activeObjectStorageId} onChange={(event) => onSelectObjectStorage(event.target.value)}>
                    {!objectStorageProfiles.length && <option value="">尚未配置</option>}
                    {objectStorageProfiles.map((storage) => <option key={storage.id} value={storage.id}>{storage.name} · {providerLabels[storage.provider]}</option>)}
                  </select>
                </label>
                <span>{activeObjectStorage ? `${activeObjectStorage.bucket} · ${activeObjectStorage.endpoint}` : `缺少：${configIssues.join('、')}`}</span>
              </div>
              <button type="button" className="icon-button" title="打开 OSS 管理" aria-label="打开 OSS 管理" onClick={onOpenOssManager}><Settings size={15} /></button>
            </div>
            {selectedModules.map((module) => (
              <label className="field" key={module}><span>{moduleLabels[module]}对象 Key</span><input value={objectKeys[module] ?? ''} onChange={(event) => setObjectKeys((current) => ({ ...current, [module]: event.target.value }))} /></label>
            ))}
            <div className="remote-log-actions">
              <button type="button" className="button secondary" disabled={!connected || Boolean(action) || (!activeModules.length && !selectedModules.length)} onClick={() => void cancelUpload()}>
                {action === 'cancel' ? <LoaderCircle className="spin" size={14} /> : <Ban size={14} />}
                取消上传
              </button>
              <button type="submit" className="button primary" disabled={!connected || !selectedFiles.length || !configReady || Boolean(action)}>
                {action === 'start' ? <LoaderCircle className="spin" size={14} /> : <CloudUpload size={14} />}
                发起上传
              </button>
            </div>
          </form>
        </section>
      </div>

      <section className="remote-log-panel remote-log-progress-panel">
        <header className="remote-log-panel-header"><div><RefreshCw size={16} /><div><h2>上传进度</h2><span>{progress.length} 个上传对象</span></div></div></header>
        <div className="remote-log-progress-list">
          {progress.length ? progress.map((item) => {
            const success = item.progress >= 100 && (item.result === undefined || item.result === 0)
            const failed = item.result !== undefined && item.result !== 0
            return (
              <article className="remote-log-progress-row" key={`${item.module}:${item.deviceSn}:${item.key || item.fingerprint}`}>
                <span className={`remote-log-progress-state ${failed ? 'error' : success ? 'success' : ''}`}>{failed ? <CircleAlert size={15} /> : success ? <CheckCircle2 size={15} /> : <CloudUpload size={15} />}</span>
                <div className="remote-log-progress-copy"><strong>{moduleLabels[item.module]} · {item.deviceSn}</strong><code>{item.key || item.fingerprint || '等待对象 Key'}</code></div>
                <div className="remote-log-progress-meter"><div><span style={{ width: `${item.progress}%` }} /></div><small>{item.progress}%{item.currentStep !== undefined ? ` · 步骤 ${item.currentStep}${item.totalStep !== undefined ? `/${item.totalStep}` : ''}` : ''}</small></div>
                <span className="remote-log-rate">{item.uploadRate > 0 ? `${formatBytes(item.uploadRate)}/s` : success ? '已完成' : item.status || '等待进度'}</span>
              </article>
            )
          }) : <div className="remote-log-placeholder compact"><CloudUpload size={20} /><span>尚未收到上传进度</span></div>}
        </div>
      </section>
    </div>
  )
}
