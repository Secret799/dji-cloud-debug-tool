import { describe, expect, it } from 'vitest'
import {
  isSameRendererFrame,
  isTrustedRendererUrl,
  validateDevelopmentRendererUrl,
} from './renderer-security'

describe('renderer security', () => {
  it('accepts only loopback HTTP development pages without credentials', () => {
    expect(validateDevelopmentRendererUrl('http://localhost:5173')).toBe('http://localhost:5173/')
    expect(validateDevelopmentRendererUrl('https://127.0.0.1:4173/app')).toBe('https://127.0.0.1:4173/app')
    expect(validateDevelopmentRendererUrl('http://[::1]:5173')).toBe('http://[::1]:5173/')

    expect(() => validateDevelopmentRendererUrl('https://example.com')).toThrow('只能使用')
    expect(() => validateDevelopmentRendererUrl('data:text/html,unsafe')).toThrow('仅支持 HTTP')
    expect(() => validateDevelopmentRendererUrl('http://user:pass@localhost:5173')).toThrow('认证信息')
  })

  it('matches stable frame identifiers instead of object identity', () => {
    expect(isSameRendererFrame({ processId: 11, routingId: 22 }, { processId: 11, routingId: 22 })).toBe(true)
    expect(isSameRendererFrame({ processId: 11, routingId: 23 }, { processId: 11, routingId: 22 })).toBe(false)
    expect(isSameRendererFrame(null, { processId: 11, routingId: 22 })).toBe(false)
  })

  it('allows same-origin dev paths and only the exact packaged file', () => {
    expect(isTrustedRendererUrl('http://localhost:5173/settings', 'http://localhost:5173/')).toBe(true)
    expect(isTrustedRendererUrl('http://localhost:5174/', 'http://localhost:5173/')).toBe(false)
    expect(isTrustedRendererUrl('https://localhost:5173/', 'http://localhost:5173/')).toBe(false)
    expect(isTrustedRendererUrl('file:///app/index.html#settings', 'file:///app/index.html')).toBe(true)
    expect(isTrustedRendererUrl('file:///tmp/index.html', 'file:///app/index.html')).toBe(false)
  })
})
