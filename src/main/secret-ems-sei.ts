import type { SeiMessagePreview } from '../shared/contracts'

const MAX_SSE_BUFFER_CHARS = 1024 * 1024
const MAX_SSE_EVENT_CHARS = 512 * 1024
const MAX_TEXT_PREVIEW_CHARS = 160
const MAX_HEX_PREVIEW_BYTES = 32
const MAX_PAYLOAD_BYTES = 256 * 1024

export interface ServerSentEvent {
  event: string
  data: string
  id?: string
}

export interface SecretEmsSeiUpdate {
  active?: boolean
  codec?: 'h264' | 'h265'
  videoFrames?: number
  seiNalUnits?: number
  seiMessages?: number
  parseIssues?: number
  recentMessages?: SeiMessagePreview[]
  recentPayloads?: Array<{ id: string; payload: Buffer }>
  message?: SeiMessagePreview
  messagePayload?: Buffer
  issue?: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const boundedInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

const codecValue = (value: unknown): 'h264' | 'h265' | undefined => {
  if (typeof value !== 'string') return undefined
  const normalized = value.toLowerCase()
  if (normalized === 'h264' || normalized === 'avc' || normalized === 'avc1') return 'h264'
  if (normalized === 'h265' || normalized === 'hevc' || normalized === 'hev1') return 'h265'
  return undefined
}

const timestampValue = (value: unknown): number => {
  if (typeof value !== 'string') return Date.now()
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : Date.now()
}

const stringValue = (value: unknown, maxLength: number): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, maxLength) : undefined

const base64HexPreview = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return ''
  const bytes = Buffer.from(value.slice(0, 44), 'base64').subarray(0, MAX_HEX_PREVIEW_BYTES)
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(' ')
}

const payloadValue = (value: unknown, expectedBytes: number): Buffer | undefined => {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_PAYLOAD_BYTES / 3) * 4 + 4) return undefined
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return undefined
  const payload = Buffer.from(value, 'base64')
  return payload.length === expectedBytes && payload.length <= MAX_PAYLOAD_BYTES ? payload : undefined
}

const messagePreview = (
  value: unknown,
  eventId?: string,
): SeiMessagePreview | undefined => {
  if (!isRecord(value)) return undefined
  const payloadType = boundedInteger(value.payloadType)
  const payloadSize = boundedInteger(value.payloadBytes)
  if (payloadType === undefined || payloadSize === undefined) return undefined
  const idValue = boundedInteger(value.id)
  return {
    id: `${eventId ?? idValue ?? crypto.randomUUID()}`,
    at: timestampValue(value.time ?? value.parsedAt),
    codec: codecValue(value.codec) ?? 'h264',
    payloadType,
    payloadSize,
    uuid: stringValue(value.uuid, 64),
    textPreview: stringValue(value.text ?? value.data, MAX_TEXT_PREVIEW_CHARS),
    hexPreview: stringValue(value.hex, MAX_HEX_PREVIEW_BYTES * 3) ?? base64HexPreview(value.payloadBase64),
  }
}

const statsUpdate = (value: unknown): SecretEmsSeiUpdate | undefined => {
  if (!isRecord(value)) return undefined
  return {
    active: typeof value.active === 'boolean' ? value.active : undefined,
    codec: codecValue(value.codec),
    videoFrames: boundedInteger(value.videoFrames),
    seiNalUnits: boundedInteger(value.seiNalUnits),
    seiMessages: boundedInteger(value.seiMessages),
    parseIssues: boundedInteger(value.parseIssues),
  }
}

export const parseSecretEmsSeiEvent = (event: ServerSentEvent): SecretEmsSeiUpdate | undefined => {
  let data: unknown
  try {
    data = JSON.parse(event.data)
  } catch {
    return undefined
  }

  if (event.event === 'snapshot' && isRecord(data)) {
    const update = statsUpdate(data.stats) ?? {}
    const recentEvents = Array.isArray(data.recentEvents) ? data.recentEvents : []
    const messages = recentEvents
      .map((item) => ({ raw: item, preview: messagePreview(item) }))
      .filter((item): item is { raw: Record<string, unknown>; preview: SeiMessagePreview } => Boolean(item.preview) && isRecord(item.raw))
      .reverse()
      .slice(0, 20)
    update.recentMessages = messages.map(({ preview }) => preview)
    update.recentPayloads = messages.flatMap(({ raw, preview }) => {
      const payload = payloadValue(raw.payloadBase64, preview.payloadSize)
      return payload ? [{ id: preview.id, payload }] : []
    })
    return update
  }
  if (event.event === 'stats' || event.event === 'stream') return statsUpdate(data)
  if (event.event === 'sei') {
    const message = messagePreview(data, event.id)
    if (!message) return undefined
    const messagePayload = isRecord(data) ? payloadValue(data.payloadBase64, message.payloadSize) : undefined
    return { active: true, codec: message.codec, message, messagePayload }
  }
  if (event.event === 'issue') return { active: true, issue: true }
  return undefined
}

const eventBoundary = (value: string): { index: number; length: number } | undefined => {
  const candidates = ['\r\n\r\n', '\n\n', '\r\r']
    .map((separator) => ({ index: value.indexOf(separator), length: separator.length }))
    .filter((candidate) => candidate.index >= 0)
    .sort((left, right) => left.index - right.index)
  return candidates[0]
}

const parseEventBlock = (block: string): ServerSentEvent | undefined => {
  let event = 'message'
  let id: string | undefined
  const data: string[] = []
  for (const line of block.split(/\r\n|\r|\n/)) {
    if (!line || line.startsWith(':')) continue
    const separator = line.indexOf(':')
    const field = separator < 0 ? line : line.slice(0, separator)
    const rawValue = separator < 0 ? '' : line.slice(separator + 1)
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue
    if (field === 'event') event = value || 'message'
    else if (field === 'data') data.push(value)
    else if (field === 'id' && !value.includes('\0')) id = value.slice(0, 128)
  }
  if (!data.length) return undefined
  const joined = data.join('\n')
  if (joined.length > MAX_SSE_EVENT_CHARS) throw new Error('SecretEMS SEI 事件超过大小限制')
  return { event, data: joined, id }
}

export class BoundedSseParser {
  private readonly decoder = new TextDecoder()
  private buffer = ''

  push(chunk: Uint8Array): ServerSentEvent[] {
    this.buffer += this.decoder.decode(chunk, { stream: true })
    const events: ServerSentEvent[] = []
    let boundary = eventBoundary(this.buffer)
    while (boundary) {
      const block = this.buffer.slice(0, boundary.index)
      this.buffer = this.buffer.slice(boundary.index + boundary.length)
      const event = parseEventBlock(block)
      if (event) events.push(event)
      boundary = eventBoundary(this.buffer)
    }
    if (this.buffer.length > MAX_SSE_BUFFER_CHARS) throw new Error('SecretEMS SSE 缓冲区超过大小限制')
    return events
  }

  reset(): void {
    this.buffer = ''
    this.decoder.decode()
  }
}
