import type { MqttMessageRecord } from '../../../shared/contracts'

export type PayloadKind = 'speaker' | 'parachute'
export type PayloadRecognitionMode = 'auto' | 'manual'

export interface PayloadTypeAssignment {
  mode: PayloadRecognitionMode
  manualType?: PayloadKind
}

export type PayloadTypeAssignments = Record<string, PayloadTypeAssignment>

export interface RecognizedPayloadType {
  type: PayloadKind
  evidence: string
}

interface PayloadTypeDocument {
  version: 1
  assignments: PayloadTypeAssignments
}

const STORAGE_KEY = 'dji-cloud-studio.payload-types.v1'
const MAX_ASSIGNMENTS = 500
const PAYLOAD_KINDS = new Set<PayloadKind>(['speaker', 'parachute'])
const TYPE_FIELD_NAMES = new Set([
  'payload_type',
  'payloadType',
  'payload_kind',
  'payloadKind',
  'device_type',
  'deviceType',
  'device_name',
  'deviceName',
  'product_name',
  'productName',
  'model',
  'name',
  'type',
])

export const PAYLOAD_TYPE_OPTIONS: ReadonlyArray<{ value: PayloadKind; label: string }> = [
  { value: 'speaker', label: '喊话器' },
  { value: 'parachute', label: '降落伞' },
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const typeFromText = (value: string): PayloadKind | undefined => {
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (!normalized) return undefined
  if (normalized.includes('降落伞') || normalized.includes('parachute')) return 'parachute'
  if (
    normalized.includes('喊话器')
    || normalized.includes('speaker')
    || normalized.includes('loudspeaker')
    || normalized.includes('megaphone')
  ) return 'speaker'
  return undefined
}

const psdkIndexFromData = (data: Record<string, unknown>): number | undefined => {
  const value = data.psdk_index
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return undefined
}

const explicitTypeFromData = (data: Record<string, unknown>): RecognizedPayloadType | undefined => {
  for (const [field, value] of Object.entries(data)) {
    if (!TYPE_FIELD_NAMES.has(field) || typeof value !== 'string') continue
    const type = typeFromText(value)
    if (type) return { type, evidence: `字段 ${field}=${value}` }
  }
  return undefined
}

export const recognizePayloadType = (
  records: MqttMessageRecord[],
  psdkIndex: number,
): RecognizedPayloadType | undefined => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    try {
      const envelope = JSON.parse(records[index].payload) as unknown
      if (!isRecord(envelope) || !isRecord(envelope.data) || psdkIndexFromData(envelope.data) !== psdkIndex) continue

      const explicit = explicitTypeFromData(envelope.data)
      if (explicit) return explicit

      const method = typeof envelope.method === 'string' ? envelope.method.trim() : ''
      const type = typeFromText(method)
      if (type) return { type, evidence: `方法 ${method}` }
    } catch {
      // MQTT consoles may contain arbitrary non-JSON payloads.
    }
  }
  return undefined
}

export const payloadTypeLabel = (type: PayloadKind | undefined): string =>
  PAYLOAD_TYPE_OPTIONS.find((option) => option.value === type)?.label ?? '未识别'

export const payloadTypeAssignmentKey = (
  profileId: string,
  gatewaySn: string,
  psdkIndex: number,
): string => `${profileId}:${gatewaySn}:${psdkIndex}`

export const parsePayloadTypeAssignments = (value: unknown): PayloadTypeAssignments => {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.assignments)) return {}
  const assignments: PayloadTypeAssignments = {}
  Object.entries(value.assignments).slice(0, MAX_ASSIGNMENTS).forEach(([key, candidate]) => {
    if (!key || !isRecord(candidate) || (candidate.mode !== 'auto' && candidate.mode !== 'manual')) return
    const manualType = candidate.manualType
    if (manualType !== undefined && (typeof manualType !== 'string' || !PAYLOAD_KINDS.has(manualType as PayloadKind))) return
    if (candidate.mode === 'manual' && manualType === undefined) return
    assignments[key] = {
      mode: candidate.mode,
      ...(manualType ? { manualType: manualType as PayloadKind } : {}),
    }
  })
  return assignments
}

export const loadPayloadTypeAssignments = (): PayloadTypeAssignments => {
  if (typeof window === 'undefined') return {}
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return stored ? parsePayloadTypeAssignments(JSON.parse(stored) as unknown) : {}
  } catch {
    return {}
  }
}

export const savePayloadTypeAssignments = (assignments: PayloadTypeAssignments): boolean => {
  if (typeof window === 'undefined') return false
  try {
    const document: PayloadTypeDocument = { version: 1, assignments }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(document))
    return true
  } catch {
    return false
  }
}
