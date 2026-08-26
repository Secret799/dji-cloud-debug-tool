import type { DjiFieldMetadata } from './dji-field-metadata'

export interface DjiNumericConstraint {
  min?: number
  max?: number
  step?: number
}

const finiteConstraint = (constraint: string | undefined, key: keyof DjiNumericConstraint): number | undefined => {
  if (!constraint) return undefined
  const match = constraint.match(new RegExp(`"${key}"\\s*:\\s*"?(-?\\d+(?:\\.\\d+)?)"?`))
  if (!match) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) ? value : undefined
}

export const djiNumericConstraint = (metadata: DjiFieldMetadata): DjiNumericConstraint => ({
  min: finiteConstraint(metadata.constraint, 'min'),
  max: finiteConstraint(metadata.constraint, 'max'),
  step: finiteConstraint(metadata.constraint, 'step'),
})

export const djiPropertyDraftValue = (value: unknown, metadata: DjiFieldMetadata): string => {
  if (metadata.type === 'bool') return String(value === true || value === 1 || value === 'true')
  if (value === undefined || value === null) return ''
  if (typeof value === 'object') return JSON.stringify(value, null, 2)
  return String(value)
}

export const parseDjiPropertyValue = (draft: string, metadata: DjiFieldMetadata): unknown => {
  const value = draft.trim()

  if (metadata.type === 'bool') {
    if (value === 'true') return true
    if (value === 'false') return false
    throw new Error('布尔值必须为开启或关闭')
  }

  if (['enum_int', 'int', 'date', 'float', 'double'].includes(metadata.type)) {
    if (!value) throw new Error('请输入设置值')
    const number = Number(value)
    if (!Number.isFinite(number)) throw new Error('请输入有效数值')
    if (['enum_int', 'int', 'date'].includes(metadata.type) && !Number.isInteger(number)) {
      throw new Error('请输入整数')
    }
    if (metadata.type === 'enum_int' && !metadata.enumValues) {
      throw new Error('该枚举字段未配置有效的枚举约束')
    }
    if (metadata.type === 'enum_int' && metadata.enumValues && !(value in metadata.enumValues)) {
      throw new Error('请选择文档支持的枚举值')
    }
    const { min, max } = djiNumericConstraint(metadata)
    if (min !== undefined && number < min) throw new Error(`设置值不能小于 ${min}`)
    if (max !== undefined && number > max) throw new Error(`设置值不能大于 ${max}`)
    return number
  }

  if (metadata.type === 'struct' || metadata.type === 'array') {
    try {
      const parsed = JSON.parse(value) as unknown
      if (metadata.type === 'array' && !Array.isArray(parsed)) throw new Error('请输入 JSON 数组')
      if (metadata.type === 'struct' && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
        throw new Error('请输入 JSON 对象')
      }
      return parsed
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('请输入 JSON')) throw error
      throw new Error('请输入有效 JSON')
    }
  }

  if (!value) throw new Error('请输入设置值')
  if (metadata.type === 'enum_string' && !metadata.enumValues) {
    throw new Error('该枚举字段未配置有效的枚举约束')
  }
  if (metadata.type === 'enum_string' && metadata.enumValues && !(value in metadata.enumValues)) {
    throw new Error('请选择文档支持的枚举值')
  }
  return value
}

export const buildDjiPropertyData = (path: string, value: unknown): Record<string, unknown> => {
  const normalizedPath = path.trim()
  if (!normalizedPath) throw new Error('属性路径不能为空')
  const segments = normalizedPath.split('.')
  if (segments.some((segment) => !segment || segment.trim() !== segment)) {
    throw new Error('属性路径格式无效')
  }
  if (segments.some((segment) => /^\d+$/.test(segment))) {
    throw new Error('数组元素不能单独设置，请设置完整数组属性')
  }

  let nested: unknown = value
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    nested = { [segments[index]]: nested }
  }
  return nested as Record<string, unknown>
}

export const buildDjiPropertyPayload = (
  path: string,
  value: unknown,
  tid: string,
  bid: string,
  timestamp = Date.now(),
): string => JSON.stringify({
  bid,
  data: buildDjiPropertyData(path, value),
  tid,
  timestamp,
})

export const djiPropertyReplyResult = (payload: string, path: string): number | undefined => {
  try {
    const envelope = JSON.parse(payload) as { data?: unknown }
    let current = envelope.data
    for (const segment of path.split('.').filter(Boolean)) {
      if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
      current = (current as Record<string, unknown>)[segment]
    }
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    const result = (current as Record<string, unknown>).result
    return typeof result === 'number' ? result : undefined
  } catch {
    return undefined
  }
}
