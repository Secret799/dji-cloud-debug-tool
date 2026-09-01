import type { MqttMessageRecord } from '../shared/contracts'

export const REDACTED_MQTT_VALUE = '[REDACTED]'
export const OMITTED_MQTT_PAYLOAD = '[REDACTED: sensitive MQTT payload omitted]'

const MAX_REDACTION_DEPTH = 64
const MAX_REDACTION_NODES = 50_000
const SENSITIVE_KEYS = new Set([
  'authorization',
  'proxyauthorization',
  'accesskeyid',
  'awsaccesskeyid',
  'ossaccesskeyid',
  'accesskey',
  'accessid',
  'secretid',
  'accesskeysecret',
  'secretaccesskey',
  'awssecretaccesskey',
  'securitytoken',
  'sessiontoken',
  'ststoken',
  'awssessiontoken',
  'xamzcredential',
  'xamzsignature',
  'xosscredential',
  'xosssignature',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authtoken',
  'bearertoken',
  'clientsecret',
  'devicesecret',
  'apikeysecret',
  'secretkey',
  'privatekey',
  'password',
  'passwd',
  'token',
  'secret',
])
const SENSITIVE_KEY_PATTERN = [
  '(?:(?:aws|oss)[\\s_.-]*)?access[\\s_.-]*key(?:[\\s_.-]*(?:id|secret))?',
  'access[\\s_.-]*id',
  '(?:(?:aws|oss)[\\s_.-]*)?secret[\\s_.-]*(?:access[\\s_.-]*key|id|key)',
  '(?:(?:x[\\s_.-]*amz|x[\\s_.-]*oss)[\\s_.-]*)?(?:security|session|sts|access|refresh|id|auth|bearer)[\\s_.-]*token',
  'x[\\s_.-]*(?:amz|oss)[\\s_.-]*(?:credential|signature)',
  '(?:client|device|api)[\\s_.-]*secret',
  'private[\\s_.-]*key',
  '(?:proxy[\\s_.-]*)?authorization',
  'password',
  'passwd',
  'token',
  'secret',
].join('|')
const SENSITIVE_ASSIGNMENT_PATTERN = new RegExp(
  `(?:^|[^a-z0-9])['"]?(?:${SENSITIVE_KEY_PATTERN})['"]?\\s*[:=]`,
  'i',
)
const SENSITIVE_XML_PATTERN = new RegExp(
  `<\\s*(?:[a-z_][a-z0-9_.-]*:)?(?:${SENSITIVE_KEY_PATTERN})(?:\\s|>)`,
  'i',
)

interface RedactionState {
  changed: boolean
  nodes: number
  seen: WeakSet<object>
}

class RedactionLimitError extends Error {}

const normalizeKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '')

const isSensitiveKey = (key: string): boolean => {
  const normalized = normalizeKey(key)
  return SENSITIVE_KEYS.has(normalized)
    || normalized.endsWith('password')
    || normalized.endsWith('accesskeyid')
    || normalized.endsWith('accesskey')
    || normalized.endsWith('accesskeysecret')
    || normalized.endsWith('securitytoken')
    || normalized.endsWith('sessiontoken')
    || normalized.endsWith('ststoken')
    || normalized.endsWith('clientsecret')
    || normalized.endsWith('devicesecret')
    || normalized.endsWith('privatekey')
}

const containsSensitiveMarker = (value: string): boolean => {
  return SENSITIVE_ASSIGNMENT_PATTERN.test(value) || SENSITIVE_XML_PATTERN.test(value)
}

const redactSignedUrl = (value: string): string | undefined => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined

  let changed = false
  if (url.username) {
    url.username = 'REDACTED'
    changed = true
  }
  if (url.password) {
    url.password = 'REDACTED'
    changed = true
  }
  for (const [key, item] of url.searchParams) {
    const normalizedKey = normalizeKey(key)
    if (
      isSensitiveKey(key)
      || normalizedKey === 'signature'
      || normalizedKey.endsWith('signature')
      || containsSensitiveMarker(item)
    ) {
      url.searchParams.set(key, 'REDACTED')
      changed = true
    }
  }
  return changed ? url.toString() : undefined
}

const cloneAndRedact = (value: unknown, state: RedactionState, depth: number): unknown => {
  state.nodes += 1
  if (depth > MAX_REDACTION_DEPTH || state.nodes > MAX_REDACTION_NODES) throw new RedactionLimitError()

  if (typeof value === 'string') {
    const redactedUrl = redactSignedUrl(value)
    if (redactedUrl) {
      state.changed = true
      return redactedUrl
    }
    if (!containsSensitiveMarker(value)) return value
    state.changed = true
    return REDACTED_MQTT_VALUE
  }
  if (!value || typeof value !== 'object') return value
  if (state.seen.has(value)) throw new RedactionLimitError()
  state.seen.add(value)

  if (Array.isArray(value)) {
    const result = value.map((item) => cloneAndRedact(item, state, depth + 1))
    state.seen.delete(value)
    return result
  }

  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      result[key] = REDACTED_MQTT_VALUE
      state.changed = true
    } else {
      result[key] = cloneAndRedact(item, state, depth + 1)
    }
  }
  state.seen.delete(value)
  return result
}

const redactStructuredValue = (value: unknown): { value: unknown; changed: boolean } => {
  const state: RedactionState = { changed: false, nodes: 0, seen: new WeakSet() }
  return { value: cloneAndRedact(value, state, 0), changed: state.changed }
}

export const redactMqttPayload = (payload: string): string => {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return containsSensitiveMarker(payload) ? OMITTED_MQTT_PAYLOAD : payload
  }

  try {
    const redacted = redactStructuredValue(parsed)
    if (!redacted.changed) return payload
    return JSON.stringify(redacted.value)
  } catch {
    return OMITTED_MQTT_PAYLOAD
  }
}

const redactMqttProperties = (properties: Record<string, unknown>): Record<string, unknown> => {
  try {
    return redactStructuredValue(properties).value as Record<string, unknown>
  } catch {
    return { redacted: '[REDACTED: MQTT properties omitted]' }
  }
}

export const redactMqttMessageRecord = (record: MqttMessageRecord): MqttMessageRecord => {
  const redacted: MqttMessageRecord = {
    id: record.id,
    profileId: record.profileId,
    direction: record.direction,
    topic: record.topic,
    payload: redactMqttPayload(record.payload),
    qos: record.qos,
    retain: record.retain,
    timestamp: record.timestamp,
    size: record.size,
  }
  if (record.duplicate !== undefined) redacted.duplicate = record.duplicate
  if (record.properties !== undefined) redacted.properties = redactMqttProperties(record.properties)
  return redacted
}
