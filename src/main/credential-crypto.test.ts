import { describe, expect, it } from 'vitest'
import { decryptCredential, encryptCredential, isApplicationCredential } from './credential-crypto'

const context = {
  store: 'mqtt' as const,
  recordId: 'profile-1',
  field: 'password',
}

describe('credential crypto', () => {
  it('round-trips credentials without storing plaintext', () => {
    const plaintext = 'secret-\u4e2d\u6587-\u0000-value'
    const encrypted = encryptCredential(plaintext, context)

    expect(isApplicationCredential(encrypted)).toBe(true)
    expect(encrypted).not.toContain(plaintext)
    expect(decryptCredential(encrypted, context)).toBe(plaintext)
  })

  it('uses a fresh IV for every encryption', () => {
    const first = encryptCredential('same-value', context)
    const second = encryptCredential('same-value', context)

    expect(first).not.toBe(second)
    expect(decryptCredential(first, context)).toBe('same-value')
    expect(decryptCredential(second, context)).toBe('same-value')
  })

  it('rejects tampering and ciphertext copied to another record', () => {
    const encrypted = encryptCredential('secret', context)
    const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith('A') ? 'B' : 'A'}`

    expect(() => decryptCredential(tampered, context)).toThrow('凭据密文无效或已损坏')
    expect(() => decryptCredential(encrypted, { ...context, recordId: 'profile-2' })).toThrow('凭据密文无效或已损坏')
    expect(() => decryptCredential(encrypted, { ...context, field: 'other-field' })).toThrow('凭据密文无效或已损坏')
  })

  it('rejects unsupported envelopes and values above the storage limit', () => {
    expect(isApplicationCredential('dcdt:v2:k2:invalid')).toBe(true)
    expect(() => decryptCredential('dcdt:v2:k2:invalid', context)).toThrow('凭据密文无效或已损坏')
    expect(() => encryptCredential('x'.repeat(64 * 1024 + 1), context)).toThrow('凭据长度不能超过 64 KiB')
  })
})
