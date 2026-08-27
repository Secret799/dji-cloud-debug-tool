import sourceData from '../data/dji-error-codes.json'

export interface CloudErrorCode {
  code: string
  source: string
  message: string | null
  logs: string | null
  cause: string | null
  solution: string | null
}

export interface HmsErrorCode {
  code: string
  message: string | null
  faq: string | null
  cause: string | null
  solution: string | null
  materials: string[]
}

export interface CommonIssue {
  question: string
  cause: string | null
  solution: string | null
}

export interface ErrorCodeData {
  schemaVersion: number
  source: {
    fileName: string
    extractedOn: string
    attribution: string
    cloudCodeFormat: string
    hmsConversion: string
  }
  cloudErrors: CloudErrorCode[]
  hmsErrors: HmsErrorCode[]
  commonIssues: CommonIssue[]
}

export interface ServiceErrorGuidance {
  result: number
  cloud?: CloudErrorCode
  hmsCode?: string
  hms?: HmsErrorCode
  message?: string
  cause?: string
  solution?: string
  logs?: string
}

export const errorCodeData = sourceData as ErrorCodeData
export const cloudErrorCodes = errorCodeData.cloudErrors
export const hmsErrorCodes = errorCodeData.hmsErrors
export const commonIssues = errorCodeData.commonIssues

export const errorCodeStats = {
  cloud: cloudErrorCodes.length,
  hms: hmsErrorCodes.length,
  faq: commonIssues.length,
  total: cloudErrorCodes.length + hmsErrorCodes.length + commonIssues.length,
} as const

const cloudByCode = new Map(cloudErrorCodes.map((entry) => [entry.code, entry]))
const hmsByCode = new Map(hmsErrorCodes.map((entry) => [entry.code.toUpperCase(), entry]))

const integerString = (value: number | string): string | undefined => {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : undefined
  const normalized = value.trim()
  return /^\d+$/.test(normalized) ? normalized : undefined
}

export const findCloudErrorCode = (value: number | string): CloudErrorCode | undefined => {
  const code = integerString(value)
  return code ? cloudByCode.get(code) : undefined
}

const hexadecimalHmsCode = (value: bigint): string | undefined => {
  if (value < 0n || value > 0xffffffffn) return undefined
  return `0x${value.toString(16).toUpperCase().padStart(8, '0')}`
}

export const normalizeHmsErrorCode = (value: number | string): string | undefined => {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? hexadecimalHmsCode(BigInt(value)) : undefined
  }

  const normalized = value.trim()
  if (/^0x[\da-f]+$/i.test(normalized)) return hexadecimalHmsCode(BigInt(normalized))
  if (/^[\da-f]{8}$/i.test(normalized) && /[a-f]/i.test(normalized)) {
    return hexadecimalHmsCode(BigInt(`0x${normalized}`))
  }
  if (/^\d{8}$/.test(normalized) && /^(12|16|19)/.test(normalized)) {
    return hexadecimalHmsCode(BigInt(`0x${normalized}`))
  }
  return /^\d+$/.test(normalized) ? hexadecimalHmsCode(BigInt(normalized)) : undefined
}

export const findHmsErrorCode = (value: number | string): HmsErrorCode | undefined => {
  const code = normalizeHmsErrorCode(value)
  return code ? hmsByCode.get(code.toUpperCase()) : undefined
}

export const hmsDecimalCode = (code: string): string | undefined => {
  const normalized = normalizeHmsErrorCode(code)
  return normalized ? BigInt(normalized).toString(10) : undefined
}

export const serviceResultToHmsCode = (result: number): string | undefined => {
  if (!Number.isSafeInteger(result) || result < 328000 || result > 328999) return undefined
  return hexadecimalHmsCode(0x16100000n + BigInt(result - 328000))
}

export const lookupServiceError = (result: number): ServiceErrorGuidance => {
  const cloud = findCloudErrorCode(result)
  const hmsCode = serviceResultToHmsCode(result)
  const hms = hmsCode ? findHmsErrorCode(hmsCode) : undefined
  return {
    result,
    cloud,
    hmsCode,
    hms,
    message: cloud?.message ?? hms?.message ?? hms?.faq ?? undefined,
    cause: cloud?.cause ?? hms?.cause ?? undefined,
    solution: cloud?.solution ?? hms?.solution ?? hms?.faq ?? undefined,
    logs: cloud?.logs ?? undefined,
  }
}

const compact = (value: string, maxLength = 180): string => {
  const singleLine = value.replace(/\s*\n\s*/g, '；').replace(/\s+/g, ' ').trim()
  return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength - 1)}…` : singleLine
}

export const formatServiceError = (result: number): string => {
  const guidance = lookupServiceError(result)
  const parts = [`设备返回错误码 ${result}`]
  if (guidance.message) parts.push(compact(guidance.message, 120))
  if (guidance.solution) parts.push(`处理措施：${compact(guidance.solution)}`)
  else if (guidance.hmsCode) parts.push(`对应 HMS 错误码 ${guidance.hmsCode}，暂无更详细处理措施`)
  else parts.push('错误码库暂无该条目')
  return parts.join('：')
}
