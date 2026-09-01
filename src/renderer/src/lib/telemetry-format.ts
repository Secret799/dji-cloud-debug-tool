import type { TelemetryValueFormatter } from '../../../shared/contracts'

export const TELEMETRY_FORMATTER_OPTIONS: ReadonlyArray<{
  value: TelemetryValueFormatter
  label: string
}> = [
  { value: 'datetime', label: '时间戳 -> 日期时间' },
  { value: 'date', label: '时间戳 -> 日期' },
  { value: 'time', label: '时间戳 -> 时间' },
  { value: 'number', label: '数字分组' },
  { value: 'fixed_2', label: '保留两位小数' },
  { value: 'percent', label: '小数 -> 百分比' },
  { value: 'seconds_to_minutes', label: '秒 -> 分钟' },
  { value: 'seconds_to_hours', label: '秒 -> 小时' },
  { value: 'seconds_to_duration', label: '秒 -> x 时 x 分 x 秒' },
  { value: 'meters_to_kilometers', label: '米 -> 千米' },
  { value: 'kilobytes_to_megabytes', label: 'KB -> MB' },
  { value: 'kilobytes_to_gigabytes', label: 'KB -> GB' },
  { value: 'json', label: 'JSON 美化' },
  { value: 'uppercase', label: '文本转大写' },
  { value: 'lowercase', label: '文本转小写' },
]

export const rawTelemetryValue = (value: unknown): string => {
  if (value === undefined || value === null || value === '') return '--'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

const numericValue = (value: unknown): number | undefined => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || !value.trim()) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const dateValue = (value: unknown): Date | undefined => {
  const numeric = numericValue(value)
  const parsed = numeric === undefined
    ? new Date(String(value))
    : new Date(Math.abs(numeric) < 100_000_000_000 ? numeric * 1_000 : numeric)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

const dateOptions: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}

const timeOptions: Intl.DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
}

const formatConvertedNumber = (value: number): string =>
  new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 }).format(value)

const formatDuration = (value: number): string => {
  const absolute = Math.abs(value)
  const hours = Math.floor(absolute / 3_600)
  const minutes = Math.floor((absolute % 3_600) / 60)
  const seconds = absolute - hours * 3_600 - minutes * 60
  const sign = value < 0 ? '负 ' : ''
  return `${sign}${hours} 时 ${minutes} 分 ${formatConvertedNumber(seconds)} 秒`
}

const timestampFieldPattern = /(^|\.)(activation_time|first_power_on|last_maintain_time|last_authenticated_time|timestamp|time_stamp)$/i

export const telemetryFormatterRecommendations = (
  unit: string | undefined,
  path: string,
  valueType?: string,
): TelemetryValueFormatter[] => {
  const normalizedUnit = unit?.trim().toLocaleLowerCase()
  if (!normalizedUnit) return []
  if (normalizedUnit === 'kb' || normalizedUnit === 'kib') {
    return ['kilobytes_to_megabytes', 'kilobytes_to_gigabytes']
  }
  if (normalizedUnit === 'm' || normalizedUnit === 'meter' || normalizedUnit === 'meters' || normalizedUnit === '米') {
    return ['meters_to_kilometers']
  }
  if (normalizedUnit === 'ms' && (valueType === 'date' || timestampFieldPattern.test(path))) {
    return ['datetime', 'date', 'time']
  }
  if (normalizedUnit === 's' || normalizedUnit === 'sec' || normalizedUnit === 'second' || normalizedUnit === 'seconds' || normalizedUnit === '秒') {
    return valueType === 'date' || timestampFieldPattern.test(path)
      ? ['datetime', 'date', 'time']
      : ['seconds_to_duration', 'seconds_to_minutes', 'seconds_to_hours']
  }
  return []
}

export const formatTelemetryValue = (value: unknown, formatter: TelemetryValueFormatter): string => {
  const raw = rawTelemetryValue(value)
  if (raw === '--') return raw

  if (formatter === 'datetime' || formatter === 'date' || formatter === 'time') {
    const parsed = dateValue(value)
    if (!parsed) return raw
    const options = formatter === 'datetime'
      ? { ...dateOptions, ...timeOptions }
      : formatter === 'date'
        ? dateOptions
        : timeOptions
    return parsed.toLocaleString('zh-CN', options)
  }

  if (formatter === 'number' || formatter === 'fixed_2' || formatter === 'percent') {
    const numeric = numericValue(value)
    if (numeric === undefined) return raw
    if (formatter === 'fixed_2') return numeric.toFixed(2)
    if (formatter === 'percent') {
      return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(numeric * 100)}%`
    }
    return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 20 }).format(numeric)
  }

  if (
    formatter === 'seconds_to_minutes'
    || formatter === 'seconds_to_hours'
    || formatter === 'seconds_to_duration'
    || formatter === 'meters_to_kilometers'
    || formatter === 'kilobytes_to_megabytes'
    || formatter === 'kilobytes_to_gigabytes'
  ) {
    const numeric = numericValue(value)
    if (numeric === undefined) return raw
    if (formatter === 'seconds_to_minutes') return `${formatConvertedNumber(numeric / 60)} 分钟`
    if (formatter === 'seconds_to_hours') return `${formatConvertedNumber(numeric / 3_600)} 小时`
    if (formatter === 'meters_to_kilometers') return `${formatConvertedNumber(numeric / 1_000)} 千米`
    if (formatter === 'kilobytes_to_megabytes') return `${formatConvertedNumber(numeric / 1_024)} MB`
    if (formatter === 'kilobytes_to_gigabytes') return `${formatConvertedNumber(numeric / 1_048_576)} GB`
    return formatDuration(numeric)
  }

  if (formatter === 'json') {
    try {
      const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
      return JSON.stringify(parsed, null, 2) ?? raw
    } catch {
      return raw
    }
  }

  return formatter === 'uppercase' ? raw.toLocaleUpperCase() : raw.toLocaleLowerCase()
}
