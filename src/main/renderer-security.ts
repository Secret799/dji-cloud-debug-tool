export interface RendererFrameIdentity {
  processId: number
  routingId: number
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export const validateDevelopmentRendererUrl = (value: string): string => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('ELECTRON_RENDERER_URL 必须是有效 URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('开发页面仅支持 HTTP 或 HTTPS')
  }
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('开发页面只能使用 localhost、127.0.0.1 或 ::1')
  }
  if (url.username || url.password) throw new Error('开发页面 URL 不能包含认证信息')
  return url.toString()
}

export const isSameRendererFrame = (
  actual: RendererFrameIdentity | null,
  expected: RendererFrameIdentity,
): boolean => Boolean(
  actual
  && actual.processId === expected.processId
  && actual.routingId === expected.routingId,
)

export const isTrustedRendererUrl = (actualValue: string, expectedValue: string): boolean => {
  try {
    const actual = new URL(actualValue)
    const expected = new URL(expectedValue)
    if (expected.protocol === 'file:') {
      actual.hash = ''
      expected.hash = ''
      return actual.href === expected.href
    }
    return (expected.protocol === 'http:' || expected.protocol === 'https:')
      && actual.origin === expected.origin
  } catch {
    return false
  }
}
