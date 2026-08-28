import { useEffect, useMemo, useState } from 'react'
import {
  CheckCircle2,
  CircleAlert,
  Clock3,
  CloudUpload,
  Copy,
  Database,
  FileArchive,
  FolderOpen,
  LoaderCircle,
  Package,
  Plane,
  RadioTower,
  RotateCcw,
  Settings,
  Upload,
} from 'lucide-react'
import type {
  ConnectionProfile,
  ConnectionStatus,
  FirmwareArtifact,
  FirmwarePackageSelection,
  FirmwareUploadProgress,
  MqttMessageRecord,
  ObjectStorageProfile,
} from '../../../shared/contracts'
import type { DeviceTelemetry, ServiceCaller } from '../lib/dji'
import { mergeNestedRecords, telemetryValue } from '../lib/dji'
import {
  buildFirmwareUpgradeDevices,
  createFirmwareDeviceDraft,
  createFirmwareObjectKey,
  firmwareDeviceIssues,
  firmwareProgressHistory,
  type FirmwareProgress,
  type FirmwareTaskStatus,
  type FirmwareUpgradeDevice,
  type FirmwareUpgradeDeviceDraft,
  type FirmwareUpgradeType,
} from '../lib/dji-firmware'
import { objectStorageProfileIssues } from '../lib/object-storage'
import { Tooltip } from '../components/Tooltip'

interface FirmwareUpgradeCenterProps {
  profile: ConnectionProfile
  gatewaySn: string
  status: ConnectionStatus
  busy: boolean
  telemetry: DeviceTelemetry[]
  records: MqttMessageRecord[]
  objectStorageProfiles: ObjectStorageProfile[]
  activeObjectStorageId: string
  onSelectObjectStorage: (profileId: string) => void
  onOpenOssManager: () => void
  onService: ServiceCaller
  onNotify?: (text: string, tone?: 'info' | 'success' | 'error') => void
}

interface UpgradeTarget {
  sn: string
  name: string
  type: 'dock' | 'aircraft'
  currentVersion: string
}

interface ActiveUpgradeTask {
  startedAt: number
  tid?: string
  bid?: string
}

const statusLabels: Record<FirmwareTaskStatus, string> = {
  canceled: '已取消', failed: '失败', in_progress: '执行中', ok: '升级成功', paused: '已暂停',
  rejected: '已拒绝', sent: '已下发', timeout: '已超时',
}
const stepLabels: Record<string, string> = { download_firmware: '下载固件', upgrade_firmware: '安装固件' }
const providerLabels: Record<ObjectStorageProfile['provider'], string> = {
  ali: '阿里云 OSS', aws: 'Amazon S3', minio: 'MinIO',
}
const terminalStatuses = new Set<FirmwareTaskStatus>(['canceled', 'failed', 'ok', 'rejected', 'timeout'])

const firmwareVersion = (telemetry: DeviceTelemetry | undefined): string => {
  if (!telemetry) return '尚未上报'
  const source = mergeNestedRecords(telemetry.status, telemetry.state, telemetry.osd)
  const value = telemetryValue(source, 'firmware_version')
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '尚未上报'
}

const progressTone = (progress: FirmwareProgress | undefined): 'success' | 'danger' | 'active' | 'neutral' => {
  if (progress?.status === 'ok') return 'success'
  if (progress?.status === 'failed' || progress?.status === 'rejected' || progress?.status === 'timeout') return 'danger'
  if (progress?.status === 'in_progress' || progress?.status === 'sent') return 'active'
  return 'neutral'
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_024 ** 2) return `${(bytes / 1_024).toFixed(1)} KiB`
  if (bytes < 1_024 ** 3) return `${(bytes / 1_024 ** 2).toFixed(1)} MiB`
  return `${(bytes / 1_024 ** 3).toFixed(2)} GiB`
}

const applyArtifact = (
  drafts: FirmwareUpgradeDeviceDraft[],
  packageTargetSn: string,
  artifact: FirmwareArtifact,
): FirmwareUpgradeDeviceDraft[] => drafts.map((draft) => draft.sn === packageTargetSn ? {
  ...draft,
  fileUrl: artifact.fileUrl,
  md5: artifact.md5,
  fileSize: String(artifact.fileSize),
  fileName: artifact.fileName,
} : { ...draft, fileUrl: '', md5: '', fileSize: '', fileName: '' })

export function FirmwareUpgradeCenter({
  profile,
  gatewaySn,
  status,
  busy,
  telemetry,
  records,
  objectStorageProfiles,
  activeObjectStorageId,
  onSelectObjectStorage,
  onOpenOssManager,
  onService,
  onNotify,
}: FirmwareUpgradeCenterProps) {
  const targets = useMemo(() => {
    const result = new Map<string, UpgradeTarget>()
    const dockConfig = profile.devices.find((device) => device.sn === gatewaySn && device.type === 'dock')
    const dockTelemetry = telemetry.find((device) => device.sn === gatewaySn)
    result.set(gatewaySn, {
      sn: gatewaySn,
      name: dockConfig?.name ?? dockTelemetry?.name ?? '机场',
      type: 'dock',
      currentVersion: firmwareVersion(dockTelemetry),
    })
    const aircraftConfig = profile.devices.find((device) => device.type === 'aircraft' && device.parentSn === gatewaySn)
    const aircraftTelemetry = telemetry.find((device) =>
      device.type === 'aircraft' && (device.gatewaySn === gatewaySn || device.sn === aircraftConfig?.sn),
    )
    const aircraftSn = aircraftConfig?.sn ?? aircraftTelemetry?.sn
    if (aircraftSn) {
      result.set(aircraftSn, {
        sn: aircraftSn,
        name: aircraftConfig?.name ?? aircraftTelemetry?.name ?? '飞行器',
        type: 'aircraft',
        currentVersion: firmwareVersion(aircraftTelemetry),
      })
    }
    return [...result.values()].slice(0, 2)
  }, [gatewaySn, profile.devices, telemetry])
  const targetKey = targets.map((target) => target.sn).join(':')
  const selectedStorage = objectStorageProfiles.find((item) => item.id === activeObjectStorageId)
    ?? objectStorageProfiles[0]
  const [drafts, setDrafts] = useState<FirmwareUpgradeDeviceDraft[]>([])
  const [selection, setSelection] = useState<FirmwarePackageSelection>()
  const [artifact, setArtifact] = useState<FirmwareArtifact>()
  const [objectKey, setObjectKey] = useState('')
  const [packageTargetSn, setPackageTargetSn] = useState('')
  const [uploadProgress, setUploadProgress] = useState<FirmwareUploadProgress>()
  const [picking, setPicking] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [activeTask, setActiveTask] = useState<ActiveUpgradeTask>()

  useEffect(() => {
    setDrafts(targets.map((target) => createFirmwareDeviceDraft(target.sn)))
    setPackageTargetSn(targets[0]?.sn ?? '')
    setSelection(undefined)
    setArtifact(undefined)
    setObjectKey('')
    setUploadProgress(undefined)
    setConfirmed(false)
    setActiveTask(undefined)
    setSubmitting(false)
  }, [gatewaySn, targetKey])

  useEffect(() => window.djiApi.firmware.onUploadProgress((progress) => {
    if (progress.selectionToken === selection?.token) setUploadProgress(progress)
  }), [selection?.token])

  useEffect(() => {
    if (selectedStorage || !objectStorageProfiles[0]) return
    onSelectObjectStorage(objectStorageProfiles[0].id)
  }, [objectStorageProfiles, onSelectObjectStorage, selectedStorage])

  const history = useMemo(() => firmwareProgressHistory(records, gatewaySn), [records, gatewaySn])
  const latestProgress = activeTask
    ? history.find((progress) => progress.receivedAt >= activeTask.startedAt
      && (!activeTask.bid || !progress.bid || progress.bid === activeTask.bid))
    : history[0]
  const latestPercent = latestProgress?.percent ?? 0
  const latestStatus = latestProgress?.status
  const taskFinished = Boolean(latestStatus && terminalStatuses.has(latestStatus))
  const targetIssues = drafts.flatMap(firmwareDeviceIssues)
  const enabledDrafts = drafts.filter((draft) => draft.enabled)
  const storageIssues = selectedStorage ? objectStorageProfileIssues(selectedStorage) : ['对象存储配置']
  const artifactExpired = Boolean(artifact && artifact.urlExpiresAt <= Date.now() + 60_000)
  const preparedDevices = useMemo<FirmwareUpgradeDevice[]>(() => {
    if (!artifact || !packageTargetSn) return []
    try {
      return buildFirmwareUpgradeDevices(applyArtifact(drafts, packageTargetSn, artifact))
    } catch {
      return []
    }
  }, [artifact, drafts, packageTargetSn])
  const canUpload = Boolean(selection && selectedStorage && !storageIssues.length && objectKey.trim() && !uploading)
  const canSubmit = status === 'connected'
    && !busy
    && !submitting
    && Boolean(artifact)
    && !artifactExpired
    && confirmed
    && enabledDrafts.some((draft) => draft.sn === packageTargetSn)
    && targetIssues.length === 0
    && preparedDevices.length > 0

  const updateDraft = (index: number, patch: Partial<FirmwareUpgradeDeviceDraft>): void => {
    setDrafts((current) => current.map((draft, itemIndex) => itemIndex === index ? { ...draft, ...patch } : draft))
    setConfirmed(false)
  }

  const pickPackage = async (): Promise<void> => {
    setPicking(true)
    try {
      const result = await window.djiApi.firmware.pickPackage()
      if (result.canceled) return
      if (!result.package) throw new Error(result.error ?? '固件包读取失败')
      setSelection(result.package)
      setObjectKey(createFirmwareObjectKey(gatewaySn, result.package.fileName))
      setArtifact(undefined)
      setUploadProgress(undefined)
      setConfirmed(false)
    } catch (error) {
      onNotify?.(error instanceof Error ? error.message : '固件包读取失败', 'error')
    } finally {
      setPicking(false)
    }
  }

  const uploadPackage = async (): Promise<void> => {
    if (!selection || !selectedStorage) return
    setUploading(true)
    setUploadProgress({ selectionToken: selection.token, loaded: 0, total: selection.fileSize, percent: 0, at: Date.now() })
    try {
      const result = await window.djiApi.firmware.uploadPackage({
        selectionToken: selection.token,
        objectStorageProfileId: selectedStorage.id,
        objectKey,
      })
      if (!result.ok || !result.artifact) throw new Error(result.error ?? '固件包上传失败')
      setArtifact(result.artifact)
      setConfirmed(false)
      onNotify?.('固件包已上传，请核对信息后下发', 'success')
    } catch (error) {
      onNotify?.(error instanceof Error ? error.message : '固件包上传失败', 'error')
    } finally {
      setUploading(false)
    }
  }

  const resetUpload = (): void => {
    setArtifact(undefined)
    setUploadProgress(undefined)
    setConfirmed(false)
  }

  const copyUrl = async (): Promise<void> => {
    if (!artifact) return
    try {
      await navigator.clipboard.writeText(artifact.fileUrl)
      onNotify?.('访问 URL 已复制', 'success')
    } catch (error) {
      onNotify?.(error instanceof Error ? error.message : '复制失败', 'error')
    }
  }

  const startUpgrade = async (): Promise<void> => {
    if (!artifact) return
    let devices: FirmwareUpgradeDevice[]
    try {
      if (artifactExpired) throw new Error('固件下载 URL 已过期，请重新上传')
      devices = buildFirmwareUpgradeDevices(applyArtifact(drafts, packageTargetSn, artifact))
    } catch (error) {
      onNotify?.(error instanceof Error ? error.message : '升级信息校验失败', 'error')
      return
    }
    if (!window.confirm(`已核对固件包与 OSS 信息，确认向 ${devices.length} 个设备下发升级？\n\n升级期间请勿断电、断网或执行飞行任务。`)) return
    const startedAt = Date.now()
    setActiveTask({ startedAt })
    setSubmitting(true)
    try {
      const result = await onService(gatewaySn, 'ota_create', { devices }, 60_000)
      if (!result.ok) throw new Error(result.error ?? '升级任务下发失败')
      setActiveTask({ startedAt, tid: result.tid, bid: result.bid })
      onNotify?.('设备已接收升级任务', 'success')
    } catch (error) {
      setActiveTask(undefined)
      onNotify?.(error instanceof Error ? error.message : '升级任务下发失败', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="firmware-workspace">
      <section className="firmware-status-panel work-panel">
        <header className="firmware-panel-header">
          <div><Package size={18} /><span><strong>升级任务</strong><small>ota_create / ota_progress</small></span></div>
          <span className={`firmware-state ${progressTone(latestProgress)}`}>
            {latestProgress?.status === 'ok' ? <CheckCircle2 size={14} /> : latestProgress ? <LoaderCircle size={14} /> : <Clock3 size={14} />}
            {submitting ? '等待设备接单' : latestStatus ? statusLabels[latestStatus] : '尚无升级进度'}
          </span>
        </header>
        <div className="firmware-progress-summary">
          <div className="firmware-progress-copy">
            <span>{latestProgress?.currentStep ? stepLabels[latestProgress.currentStep] ?? latestProgress.currentStep : submitting ? '任务下发中' : '等待 ota_progress'}</span>
            <strong>{latestPercent}%</strong>
          </div>
          <div className="firmware-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={latestPercent}>
            <span className={progressTone(latestProgress)} style={{ width: `${latestPercent}%` }} />
          </div>
          <dl className="firmware-task-meta">
            <div><dt>网关 SN</dt><dd title={gatewaySn}>{gatewaySn}</dd></div>
            <div><dt>TID</dt><dd>{latestProgress?.tid ?? activeTask?.tid ?? '-'}</dd></div>
            <div><dt>BID</dt><dd>{latestProgress?.bid ?? activeTask?.bid ?? '-'}</dd></div>
            <div><dt>返回码</dt><dd>{latestProgress?.result ?? '-'}</dd></div>
          </dl>
        </div>
      </section>

      <section className="firmware-editor firmware-upload-panel work-panel">
        <header className="firmware-panel-header">
          <div><CloudUpload size={18} /><span><strong>固件包上传</strong><small>本地文件 → 对象存储</small></span></div>
          <span className={artifact ? 'success-text' : ''}>{artifact ? '已上传' : uploading ? '上传中' : '1 / 3'}</span>
        </header>
        <div className="firmware-upload-body">
          <div className={`firmware-file-picker ${selection ? 'selected' : ''}`}>
            <span className="firmware-file-icon"><FileArchive size={21} /></span>
            <span className="firmware-file-copy">
              <strong>{selection?.fileName ?? '选择本地固件包'}</strong>
              <small>{picking ? '正在读取文件并计算 MD5' : selection ? `${formatBytes(selection.fileSize)} · MD5 ${selection.md5}` : '支持 ZIP、BIN、TAR、GZ 等固件文件'}</small>
            </span>
            <button className="button secondary compact" disabled={picking || uploading} onClick={() => void pickPackage()}>
              {picking ? <LoaderCircle size={14} className="spin" /> : <FolderOpen size={14} />}{selection ? '重新选择' : '选择文件'}
            </button>
          </div>

          <div className="firmware-upload-fields">
            <label><span>目标对象存储</span><div className="firmware-storage-control"><select disabled={uploading || Boolean(artifact)} value={selectedStorage?.id ?? ''} onChange={(event) => { onSelectObjectStorage(event.target.value); setConfirmed(false) }}><option value="">选择 OSS 配置</option>{objectStorageProfiles.map((item) => <option key={item.id} value={item.id}>{item.name} · {providerLabels[item.provider]} · {item.bucket}</option>)}</select><Tooltip label="管理 OSS 配置"><button className="icon-button small" onClick={onOpenOssManager}><Settings size={14} /></button></Tooltip></div></label>
            <label><span>对象 Key</span><input disabled={!selection || uploading || Boolean(artifact)} value={objectKey} onChange={(event) => setObjectKey(event.target.value)} placeholder="firmware/gateway/date/package.zip" /></label>
          </div>

          {uploading && uploadProgress && (
            <div className="firmware-upload-progress">
              <div><span>正在上传到 {selectedStorage?.name}</span><strong>{uploadProgress.percent}%</strong></div>
              <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={uploadProgress.percent}><span style={{ width: `${uploadProgress.percent}%` }} /></div>
              <small>{formatBytes(uploadProgress.loaded)} / {formatBytes(uploadProgress.total)}</small>
            </div>
          )}

          {!artifact ? (
            <button className="button primary firmware-upload-button" disabled={!canUpload} onClick={() => void uploadPackage()}>
              {uploading ? <LoaderCircle size={15} className="spin" /> : <Upload size={15} />}{uploading ? '正在上传' : '上传到 OSS'}
            </button>
          ) : (
            <div className="firmware-artifact-review">
              <header><div><CheckCircle2 size={16} /><strong>上传结果</strong></div><button className="button secondary compact" onClick={resetUpload}><RotateCcw size={13} />重新上传</button></header>
              <dl>
                <div><dt>存储</dt><dd>{artifact.objectStorageProfileName} / {artifact.bucket}</dd></div>
                <div><dt>文件名</dt><dd title={artifact.fileName}>{artifact.fileName}</dd></div>
                <div><dt>文件大小</dt><dd>{formatBytes(artifact.fileSize)} ({artifact.fileSize} B)</dd></div>
                <div><dt>MD5</dt><dd><code>{artifact.md5}</code></dd></div>
                <div className="wide"><dt>对象 Key</dt><dd><code>{artifact.objectKey}</code></dd></div>
                <div className="wide"><dt>签名 URL 有效至</dt><dd className={artifactExpired ? 'danger-text' : ''}>{new Date(artifact.urlExpiresAt).toLocaleString()}</dd></div>
                <div className="wide"><dt>设备访问 URL</dt><dd className="firmware-url-value"><code title={artifact.fileUrl}>{artifact.fileUrl}</code><Tooltip label="复制访问 URL"><button onClick={() => void copyUrl()}><Copy size={13} /></button></Tooltip></dd></div>
              </dl>
            </div>
          )}
          {!objectStorageProfiles.length && <button className="firmware-oss-empty" onClick={onOpenOssManager}><Database size={16} /><span>先添加对象存储配置</span></button>}
        </div>
      </section>

      <section className="firmware-history work-panel">
        <header className="firmware-panel-header"><div><Clock3 size={18} /><span><strong>进度记录</strong><small>events / ota_progress</small></span></div><span>{history.length} 条</span></header>
        {history.length ? <div className="firmware-history-list">{history.slice(0, 20).map((item) => <div className="firmware-history-row" key={item.id}><time>{new Date(item.receivedAt).toLocaleString()}</time><span>{item.currentStep ? stepLabels[item.currentStep] ?? item.currentStep : '-'}</span><strong>{item.percent ?? 0}%</strong><span className={`firmware-state ${progressTone(item)}`}>{item.status ? statusLabels[item.status] : '未知状态'}</span><code>{item.result ?? '-'}</code></div>)}</div> : <div className="panel-empty small"><Package size={22} /><span>暂无固件升级进度</span></div>}
      </section>

      <section className="firmware-target-panel work-panel">
        <header className="firmware-panel-header">
          <div><RadioTower size={18} /><span><strong>升级目标与下发确认</strong><small>核对后生成 ota_create</small></span></div>
          <span>{enabledDrafts.length} / {drafts.length} 已选 · 2 / 3</span>
        </header>
        <div className="firmware-device-list">
          {drafts.map((draft, index) => {
            const target = targets.find((item) => item.sn === draft.sn)
            const TargetIcon = target?.type === 'aircraft' ? Plane : RadioTower
            return <article className={`firmware-device-card ${draft.enabled ? 'enabled' : ''}`} key={draft.sn || index}>
              <header><label className="firmware-device-toggle"><input type="checkbox" checked={draft.enabled} onChange={(event) => { const enabled = event.target.checked; updateDraft(index, { enabled }); if (!enabled && packageTargetSn === draft.sn) setPackageTargetSn(drafts.find((item, itemIndex) => itemIndex !== index && item.enabled)?.sn ?? '') }} /><span className="firmware-device-icon"><TargetIcon size={17} /></span><span><strong>{target?.name ?? draft.sn}</strong><small>{draft.sn}</small></span></label><span className="firmware-current-version">当前版本 <strong>{target?.currentVersion ?? '尚未上报'}</strong></span></header>
              <div className="firmware-device-fields"><label><span>升级类型</span><select disabled={!draft.enabled} value={draft.upgradeType} onChange={(event) => updateDraft(index, { upgradeType: Number(event.target.value) as FirmwareUpgradeType })}><option value={3}>普通升级</option><option value={2}>一致性升级</option><option value={4}>PSDK 升级</option></select></label><label><span>目标版本</span><input disabled={!draft.enabled} value={draft.productVersion} placeholder="01.02.03.04" onChange={(event) => updateDraft(index, { productVersion: event.target.value })} /></label></div>
            </article>
          })}
        </div>
        <div className="firmware-confirmation">
          <label><span>固件包关联设备</span><select disabled={!artifact} value={packageTargetSn} onChange={(event) => { setPackageTargetSn(event.target.value); setConfirmed(false) }}>{enabledDrafts.map((draft) => <option key={draft.sn} value={draft.sn}>{targets.find((target) => target.sn === draft.sn)?.name ?? draft.sn} · {draft.sn}</option>)}</select></label>
          <details><summary>查看将要下发的 devices 数据</summary><pre>{JSON.stringify(preparedDevices, null, 2)}</pre></details>
          <label className="firmware-confirm-check"><input type="checkbox" disabled={!artifact || artifactExpired || Boolean(targetIssues.length)} checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>已核对文件名、大小、MD5、签名 URL、目标设备与版本</span></label>
        </div>
        <footer className="firmware-editor-footer">
          <span className={targetIssues.length || artifactExpired ? 'firmware-validation-error' : ''}>{artifactExpired ? <><CircleAlert size={14} />签名 URL 已过期，请重新上传</> : targetIssues.length ? <><CircleAlert size={14} />{targetIssues[0]}</> : !artifact ? <><CircleAlert size={14} />请先选择固件包并上传到 OSS</> : <><CheckCircle2 size={14} />上传信息已生成，等待用户确认</>}</span>
          <button className="button primary" disabled={!canSubmit} onClick={() => void startUpgrade()}>{submitting ? <LoaderCircle size={15} className="spin" /> : <CloudUpload size={15} />}{submitting ? '下发中' : taskFinished ? '确认并再次下发' : '确认并下发升级'}</button>
        </footer>
      </section>
    </div>
  )
}
