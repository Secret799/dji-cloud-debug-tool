import type { MqttMessageRecord } from '../../../shared/contracts'

export type FirmwareUpgradeType = 2 | 3 | 4
export type FirmwareTaskStatus =
  | 'canceled'
  | 'failed'
  | 'in_progress'
  | 'ok'
  | 'paused'
  | 'rejected'
  | 'sent'
  | 'timeout'

export interface FirmwareUpgradeDeviceDraft {
  enabled: boolean
  sn: string
  productVersion: string
  fileUrl: string
  md5: string
  fileSize: string
  fileName: string
  upgradeType: FirmwareUpgradeType
}

export interface FirmwareUpgradeDevice {
  sn: string
  product_version: string
  file_url?: string
  md5?: string
  file_size?: number
  file_name?: string
  firmware_upgrade_type: FirmwareUpgradeType
}

export interface FirmwareProgress {
  id: string
  gatewaySn: string
  tid?: string
  bid?: string
  result?: number
  status?: FirmwareTaskStatus
  percent?: number
  currentStep?: 'download_firmware' | 'upgrade_firmware' | string
  receivedAt: number
}

const TASK_STATUSES = new Set<FirmwareTaskStatus>([
  'canceled',
  'failed',
  'in_progress',
  'ok',
  'paused',
  'rejected',
  'sent',
  'timeout',
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const finiteInteger = (value: unknown): number | undefined => {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isInteger(number) ? number : undefined
}

const optionalText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

const gatewaySnFromTopic = (topic: string): string | undefined =>
  topic.match(/^thing\/product\/([^/]+)\/events$/)?.[1]

export const createFirmwareDeviceDraft = (
  sn: string,
  productVersion = '',
): FirmwareUpgradeDeviceDraft => ({
  enabled: true,
  sn,
  productVersion,
  fileUrl: '',
  md5: '',
  fileSize: '',
  fileName: '',
  upgradeType: 3,
})

export const createFirmwareObjectKey = (
  gatewaySn: string,
  fileName: string,
  now = new Date(),
  id: string = crypto.randomUUID(),
): string => {
  const safeGateway = gatewaySn.replace(/[^a-zA-Z0-9_-]/g, '-') || 'gateway'
  const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '-') || 'firmware.bin'
  return `firmware/${safeGateway}/${now.toISOString().slice(0, 10)}/${id}-${safeFileName}`
}

export const firmwareDeviceIssues = (draft: FirmwareUpgradeDeviceDraft): string[] => {
  if (!draft.enabled) return []
  const issues: string[] = []
  const label = draft.sn.trim() || '未命名设备'
  if (!draft.sn.trim()) issues.push('设备 SN 不能为空')
  if (!draft.productVersion.trim()) issues.push(`${label} 的目标版本不能为空`)

  const packageValues = [draft.fileUrl, draft.md5, draft.fileSize, draft.fileName].map((value) => value.trim())
  const packageFieldCount = packageValues.filter(Boolean).length
  if (packageFieldCount > 0 && packageFieldCount < packageValues.length) {
    issues.push(`${label} 的固件 URL、MD5、文件大小和文件名必须同时填写`)
  }
  if (draft.fileUrl.trim()) {
    try {
      const protocol = new URL(draft.fileUrl.trim()).protocol
      if (protocol !== 'http:' && protocol !== 'https:') issues.push(`${label} 的固件 URL 必须使用 HTTP 或 HTTPS`)
    } catch {
      issues.push(`${label} 的固件 URL 格式无效`)
    }
  }
  if (draft.fileSize.trim()) {
    const fileSize = Number(draft.fileSize)
    if (!Number.isInteger(fileSize) || fileSize <= 0) issues.push(`${label} 的文件大小必须是正整数（字节）`)
  }
  return issues
}

export const buildFirmwareUpgradeDevices = (
  drafts: FirmwareUpgradeDeviceDraft[],
): FirmwareUpgradeDevice[] => {
  const enabled = drafts.filter((draft) => draft.enabled)
  if (!enabled.length) throw new Error('请至少选择一个升级设备')
  if (enabled.length > 2) throw new Error('DJI ota_create 单次最多支持 2 个设备')
  const issues = enabled.flatMap(firmwareDeviceIssues)
  if (issues.length) throw new Error(issues[0])

  return enabled.map((draft) => {
    const device: FirmwareUpgradeDevice = {
      sn: draft.sn.trim(),
      product_version: draft.productVersion.trim(),
      firmware_upgrade_type: draft.upgradeType,
    }
    if (draft.fileUrl.trim()) {
      device.file_url = draft.fileUrl.trim()
      device.md5 = draft.md5.trim()
      device.file_size = Number(draft.fileSize)
      device.file_name = draft.fileName.trim()
    }
    return device
  })
}

export const parseFirmwareProgress = (record: MqttMessageRecord): FirmwareProgress | undefined => {
  if (record.direction !== 'in') return undefined
  const gatewaySn = gatewaySnFromTopic(record.topic)
  if (!gatewaySn) return undefined

  try {
    const envelope = JSON.parse(record.payload) as unknown
    if (!isRecord(envelope) || envelope.method !== 'ota_progress' || !isRecord(envelope.data)) return undefined
    const output = isRecord(envelope.data.output) ? envelope.data.output : undefined
    const progress = output && isRecord(output.progress) ? output.progress : undefined
    const rawStatus = optionalText(output?.status)
    const status = rawStatus && TASK_STATUSES.has(rawStatus as FirmwareTaskStatus)
      ? rawStatus as FirmwareTaskStatus
      : undefined
    const rawPercent = finiteInteger(progress?.percent)
    return {
      id: record.id,
      gatewaySn,
      tid: optionalText(envelope.tid),
      bid: optionalText(envelope.bid),
      result: finiteInteger(envelope.data.result),
      status,
      percent: rawPercent === undefined ? undefined : Math.max(0, Math.min(100, rawPercent)),
      currentStep: optionalText(progress?.current_step),
      receivedAt: record.timestamp,
    }
  } catch {
    return undefined
  }
}

export const firmwareProgressHistory = (
  records: MqttMessageRecord[],
  gatewaySn: string,
): FirmwareProgress[] => records
  .flatMap((record) => {
    const progress = parseFirmwareProgress(record)
    return progress?.gatewaySn === gatewaySn ? [progress] : []
  })
  .sort((left, right) => right.receivedAt - left.receivedAt)

export const buildFirmwareEventReply = (record: MqttMessageRecord): { topic: string; payload: string } | undefined => {
  const progress = parseFirmwareProgress(record)
  if (!progress?.tid) return undefined
  let envelope: Record<string, unknown>
  try {
    const parsed = JSON.parse(record.payload) as unknown
    if (!isRecord(parsed)) return undefined
    envelope = parsed
  } catch {
    return undefined
  }
  return {
    topic: `thing/product/${progress.gatewaySn}/events_reply`,
    payload: JSON.stringify({
      tid: progress.tid,
      ...(progress.bid ? { bid: progress.bid } : {}),
      timestamp: Date.now(),
      method: envelope.method,
      data: { result: 0 },
    }),
  }
}
