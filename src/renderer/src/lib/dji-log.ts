import type { MqttMessageRecord } from '../../../shared/contracts'

export type DjiLogModule = '0' | '3'

export interface DjiLogFile {
  module: DjiLogModule
  deviceSn: string
  bootIndex: number
  startTime: number
  endTime: number
  size: number
}

export interface DjiLogProgress {
  module: DjiLogModule
  deviceSn: string
  key: string
  fingerprint: string
  size: number
  progress: number
  uploadRate: number
  finishTime?: number
  currentStep?: number
  totalStep?: number
  result?: number
  status?: string
  receivedAt: number
}

export interface DjiLogServiceReply {
  method: 'fileupload_list' | 'fileupload_start' | 'fileupload_update'
  tid: string
  result?: number
  receivedAt: number
}

interface ServiceEnvelope {
  tid?: unknown
  method?: unknown
  data?: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const finiteNumber = (value: unknown): number | undefined => {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(number) ? number : undefined
}

const integer = (value: unknown): number | undefined => {
  const number = finiteNumber(value)
  return number !== undefined && Number.isInteger(number) ? number : undefined
}

const text = (value: unknown): string => typeof value === 'string' ? value : ''

const moduleValue = (value: unknown): DjiLogModule | undefined => {
  const normalized = String(value)
  return normalized === '0' || normalized === '3' ? normalized : undefined
}

const parseEnvelope = (record: MqttMessageRecord): ServiceEnvelope | undefined => {
  try {
    const parsed = JSON.parse(record.payload) as unknown
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const servicePayload = (method: string, data: Record<string, unknown>): string => JSON.stringify({
  tid: crypto.randomUUID(),
  bid: crypto.randomUUID(),
  timestamp: Date.now(),
  method,
  data,
}, null, 2)

export const logFileId = (file: DjiLogFile): string =>
  `${file.module}:${file.deviceSn}:${file.bootIndex}`

export const buildLogListPayload = (modules: DjiLogModule[]): string =>
  servicePayload('fileupload_list', { module_list: modules })

export const buildLogCancelPayload = (modules: DjiLogModule[]): string =>
  servicePayload('fileupload_update', { status: 'cancel', module_list: modules })

export const parseLogFileList = (record: MqttMessageRecord): DjiLogFile[] | undefined => {
  if (record.direction !== 'in' || !record.topic.endsWith('/services_reply')) return undefined
  const envelope = parseEnvelope(record)
  if (envelope?.method !== 'fileupload_list' || !isRecord(envelope.data)) return undefined
  const files = Array.isArray(envelope.data.files) ? envelope.data.files : []
  const result: DjiLogFile[] = []

  files.forEach((group) => {
    if (!isRecord(group)) return
    const module = moduleValue(group.module)
    const deviceSn = text(group.device_sn)
    if (!module || !deviceSn || (integer(group.result) ?? 0) !== 0) return
    const list = Array.isArray(group.list) ? group.list : []
    list.forEach((item) => {
      if (!isRecord(item)) return
      const bootIndex = integer(item.boot_index)
      const startTime = integer(item.start_time)
      const endTime = integer(item.end_time ?? item.end_ime)
      const size = integer(item.size)
      if (bootIndex === undefined || startTime === undefined || endTime === undefined || size === undefined) return
      result.push({ module, deviceSn, bootIndex, startTime, endTime, size })
    })
  })

  return result
}

export const latestLogFileList = (records: MqttMessageRecord[], gatewaySn: string): DjiLogFile[] => {
  let latest: DjiLogFile[] = []
  records.forEach((record) => {
    if (!record.topic.endsWith(`/product/${gatewaySn}/services_reply`)) return
    const parsed = parseLogFileList(record)
    if (parsed) latest = parsed
  })
  return latest.sort((a, b) => b.startTime - a.startTime || b.bootIndex - a.bootIndex)
}

export const parseLogProgress = (record: MqttMessageRecord): DjiLogProgress[] => {
  if (record.direction !== 'in' || !record.topic.endsWith('/events')) return []
  const envelope = parseEnvelope(record)
  if (envelope?.method !== 'fileupload_progress' || !isRecord(envelope.data)) return []
  const output = isRecord(envelope.data.output) ? envelope.data.output : undefined
  const ext = output && isRecord(output.ext) ? output.ext : undefined
  const files = ext && Array.isArray(ext.files) ? ext.files : []

  return files.flatMap((file): DjiLogProgress[] => {
    if (!isRecord(file) || !isRecord(file.progress)) return []
    const module = moduleValue(file.module)
    const progress = integer(file.progress.progress ?? file.progress.prgress)
    if (!module || progress === undefined) return []
    return [{
      module,
      deviceSn: text(file.device_sn),
      key: text(file.key),
      fingerprint: text(file.fingerprint),
      size: integer(file.size) ?? 0,
      progress: Math.max(0, Math.min(100, progress)),
      uploadRate: finiteNumber(file.progress.upload_rate) ?? 0,
      finishTime: integer(file.progress.finish_time),
      currentStep: integer(file.progress.current_step),
      totalStep: integer(file.progress.total_step),
      result: integer(file.progress.result),
      status: text(file.progress.status) || undefined,
      receivedAt: record.timestamp,
    }]
  })
}

export const latestLogProgress = (records: MqttMessageRecord[], gatewaySn: string): DjiLogProgress[] => {
  const latest = new Map<string, DjiLogProgress>()
  records.forEach((record) => {
    if (!record.topic.endsWith(`/product/${gatewaySn}/events`)) return
    parseLogProgress(record).forEach((progress) => {
      const identity = `${progress.module}:${progress.deviceSn}:${progress.key || progress.fingerprint}`
      latest.set(identity, progress)
    })
  })
  return [...latest.values()].sort((a, b) => b.receivedAt - a.receivedAt)
}

export const latestLogServiceReplies = (records: MqttMessageRecord[], gatewaySn: string): DjiLogServiceReply[] => {
  const methods = new Set(['fileupload_list', 'fileupload_start', 'fileupload_update'])
  return records.flatMap((record): DjiLogServiceReply[] => {
    if (record.direction !== 'in' || !record.topic.endsWith(`/product/${gatewaySn}/services_reply`)) return []
    const envelope = parseEnvelope(record)
    if (!envelope || typeof envelope.method !== 'string' || !methods.has(envelope.method) || typeof envelope.tid !== 'string') return []
    const data = isRecord(envelope.data) ? envelope.data : undefined
    return [{
      method: envelope.method as DjiLogServiceReply['method'],
      tid: envelope.tid,
      result: data ? integer(data.result) : undefined,
      receivedAt: record.timestamp,
    }]
  }).sort((a, b) => b.receivedAt - a.receivedAt)
}
