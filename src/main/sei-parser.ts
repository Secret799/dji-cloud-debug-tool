export type SeiCodec = 'h264' | 'h265'

export interface SeiParseLimits {
  maxFrameBytes: number
  maxPayloadBytes: number
  maxSeiMessages: number
  maxIssues: number
}

export interface ParsedSeiMessage {
  payloadType: number
  payload: Uint8Array
  uuid?: string
}

export interface SeiParseIssue {
  code: string
  message: string
}

export interface SeiParseResult {
  codec?: SeiCodec
  seiNalUnitCount: number
  messages: ParsedSeiMessage[]
  issues: SeiParseIssue[]
}

export const DEFAULT_SEI_PARSE_LIMITS: Readonly<SeiParseLimits> = {
  maxFrameBytes: 8 * 1024 * 1024,
  maxPayloadBytes: 256 * 1024,
  maxSeiMessages: 64,
  maxIssues: 16,
}

const findStartCode = (data: Uint8Array, from: number): number => {
  for (let index = from; index + 2 < data.length; index += 1) {
    if (data[index] === 0 && data[index + 1] === 0 && data[index + 2] === 1) return index
    if (index + 3 < data.length
      && data[index] === 0 && data[index + 1] === 0 && data[index + 2] === 0 && data[index + 3] === 1) {
      return index
    }
  }
  return -1
}

const startCodeLength = (data: Uint8Array, index: number): number =>
  index + 3 < data.length && data[index + 2] === 0 ? 4 : 3

const codecForNal = (
  data: Uint8Array,
  start: number,
  end: number,
  codecHint?: SeiCodec,
): SeiCodec | undefined => {
  if (end <= start) return undefined
  if (codecHint !== 'h265' && (data[start] & 0x1f) === 6) return 'h264'
  if (codecHint !== 'h264' && end - start >= 2) {
    const h265Type = (data[start] & 0x7e) >> 1
    if (h265Type === 39 || h265Type === 40) return 'h265'
  }
  return undefined
}

const trailingPaddingStart = (data: Uint8Array, start: number, end: number): number => {
  let paddingStart = end
  while (paddingStart > start && data[paddingStart - 1] === 0) paddingStart -= 1
  return paddingStart > start && data[paddingStart - 1] === 0x80 ? paddingStart : end
}

const hasValidEmulationPreventionBytes = (data: Uint8Array, start: number, end: number): boolean => {
  const validationEnd = trailingPaddingStart(data, start, end)
  let zeroCount = 0
  for (let index = start; index < validationEnd; index += 1) {
    const value = data[index]
    if (zeroCount >= 2) {
      if (value <= 2) return false
      if (value === 3 && (index + 1 >= validationEnd || data[index + 1] > 3)) return false
    }
    if (zeroCount >= 2 && value === 3) {
      zeroCount = 0
      continue
    }
    zeroCount = value === 0 ? zeroCount + 1 : 0
  }
  return true
}

const unescapeRbsp = (data: Uint8Array, start: number, end: number): Uint8Array => {
  const result: number[] = []
  let zeroCount = 0
  for (let index = start; index < end; index += 1) {
    const value = data[index]
    if (zeroCount >= 2 && value === 3) {
      zeroCount = 0
      continue
    }
    result.push(value)
    zeroCount = value === 0 ? zeroCount + 1 : 0
  }
  return Uint8Array.from(result)
}

const payloadUuid = (payloadType: number, payload: Uint8Array): string | undefined => {
  if (payloadType !== 5 || payload.length < 16) return undefined
  const hex = [...payload.subarray(0, 16)].map((value) => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const parseRbsp = (
  rbsp: Uint8Array,
  limits: SeiParseLimits,
  messages: ParsedSeiMessage[],
  issues: SeiParseIssue[],
): void => {
  let position = 0
  const addIssue = (code: string, message: string): void => {
    if (issues.length < limits.maxIssues) issues.push({ code, message })
  }
  const atTrailingBits = (): boolean => {
    if (position >= rbsp.length || rbsp[position] !== 0x80) return false
    for (let index = position + 1; index < rbsp.length; index += 1) {
      if (rbsp[index] !== 0) return false
    }
    return true
  }
  const readExtendedValue = (): number | undefined => {
    let value = 0
    while (position < rbsp.length) {
      const next = rbsp[position]
      position += 1
      if (value > Number.MAX_SAFE_INTEGER - next) return undefined
      value += next
      if (next !== 0xff) return value
    }
    return undefined
  }

  while (issues.length < limits.maxIssues) {
    if (atTrailingBits()) return
    if (position >= rbsp.length) {
      addIssue('MISSING_TRAILING_BITS', 'SEI RBSP is missing trailing bits')
      return
    }
    const payloadType = readExtendedValue()
    const payloadSize = payloadType === undefined ? undefined : readExtendedValue()
    if (payloadType === undefined || payloadSize === undefined) {
      addIssue('TRUNCATED_HEADER', 'SEI payload type or size is incomplete')
      return
    }
    if (payloadSize > limits.maxPayloadBytes) {
      addIssue('PAYLOAD_TOO_LARGE', 'payload bytes exceed configured maximum')
      return
    }
    if (payloadSize > rbsp.length - position) {
      addIssue('TRUNCATED_PAYLOAD', 'declared payload exceeds remaining RBSP bytes')
      return
    }
    if (messages.length >= limits.maxSeiMessages) {
      addIssue('SEI_MESSAGE_LIMIT_REACHED', 'SEI message count reached configured limit')
      return
    }
    const payload = rbsp.slice(position, position + payloadSize)
    position += payloadSize
    messages.push({ payloadType, payload, uuid: payloadUuid(payloadType, payload) })
  }
}

export const parseAnnexBSei = (
  frame: Uint8Array,
  limits: SeiParseLimits = DEFAULT_SEI_PARSE_LIMITS,
  codecHint?: SeiCodec,
): SeiParseResult => {
  if (frame.length > limits.maxFrameBytes) {
    return {
      seiNalUnitCount: 0,
      messages: [],
      issues: [{ code: 'FRAME_TOO_LARGE', message: 'frame bytes exceed configured maximum' }],
    }
  }

  const messages: ParsedSeiMessage[] = []
  const issues: SeiParseIssue[] = []
  let codec: SeiCodec | undefined
  let seiNalUnitCount = 0
  let startCode = findStartCode(frame, 0)
  while (startCode >= 0 && issues.length < limits.maxIssues) {
    const nalStart = startCode + startCodeLength(frame, startCode)
    const nextStartCode = findStartCode(frame, nalStart)
    const nalEnd = nextStartCode < 0 ? frame.length : nextStartCode
    const nalCodec = codecForNal(frame, nalStart, nalEnd, codecHint)
    if (nalCodec) {
      codec = nalCodec
      seiNalUnitCount += 1
      const rbspStart = nalStart + (nalCodec === 'h264' ? 1 : 2)
      if (!hasValidEmulationPreventionBytes(frame, rbspStart, nalEnd)) {
        issues.push({
          code: 'INVALID_EMULATION_PREVENTION_BYTE',
          message: 'invalid or missing emulation prevention byte after two zero bytes',
        })
      } else {
        parseRbsp(unescapeRbsp(frame, rbspStart, nalEnd), limits, messages, issues)
      }
    }
    startCode = nextStartCode
  }
  return { codec, seiNalUnitCount, messages, issues }
}

export class AnnexBSeiStreamParser {
  private pending = Buffer.alloc(0)
  private codecHint: SeiCodec | undefined

  constructor(
    private readonly onNalUnit: (result: SeiParseResult) => void,
    private readonly limits: SeiParseLimits = DEFAULT_SEI_PARSE_LIMITS,
  ) {}

  push(chunk: Buffer): void {
    if (!chunk.length) return
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : Buffer.from(chunk)
    let firstStart = findStartCode(this.pending, 0)
    if (firstStart < 0) {
      this.pending = this.pending.subarray(Math.max(0, this.pending.length - 3))
      return
    }
    if (firstStart > 0) {
      this.pending = this.pending.subarray(firstStart)
      firstStart = 0
    }

    let currentStart = firstStart
    while (true) {
      const nalStart = currentStart + startCodeLength(this.pending, currentStart)
      const nextStart = findStartCode(this.pending, nalStart)
      if (nextStart < 0) break
      this.onNalUnit(parseAnnexBSei(this.pending.subarray(currentStart, nextStart), this.limits, this.codecHint))
      currentStart = nextStart
    }
    this.pending = this.pending.subarray(currentStart)
    if (this.pending.length > this.limits.maxFrameBytes) {
      this.onNalUnit(parseAnnexBSei(this.pending, this.limits, this.codecHint))
      this.pending = Buffer.alloc(0)
    }
  }

  reset(): void {
    this.pending = Buffer.alloc(0)
  }

  setCodec(codec: SeiCodec): void {
    this.codecHint = codec
  }
}
