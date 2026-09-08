import { describe, expect, it } from 'vitest'
import { decryptWebDavBackup, encryptWebDavBackup } from './webdav-backup-crypto'
import { MAX_BACKUP_ENVELOPE_BYTES, MAX_BACKUP_PLAINTEXT_BYTES } from './webdav-backup-limits'

describe('WebDAV backup encryption', () => {
  it('round-trips 25 MiB of plaintext after base64 envelope expansion', () => {
    const backup = { text: 'x'.repeat(25 * 1024 * 1024) }
    const encrypted = encryptWebDavBackup(backup, 'secret', 1)
    expect(encrypted.byteLength).toBeGreaterThan(32 * 1024 * 1024)
    expect(decryptWebDavBackup(encrypted, 'secret')).toEqual(backup)
  })

  it('supports exactly 32 MiB of JSON plaintext and rejects larger plaintext', () => {
    const backup = 'x'.repeat(MAX_BACKUP_PLAINTEXT_BYTES - 2)
    const encrypted = encryptWebDavBackup(backup, 'secret', 1)
    expect(encrypted.byteLength).toBeLessThanOrEqual(MAX_BACKUP_ENVELOPE_BYTES)
    expect(decryptWebDavBackup(encrypted, 'secret')).toBe(backup)
    expect(() => encryptWebDavBackup(`${backup}x`, 'secret', 1)).toThrow(/32 MiB/)
    expect(() => decryptWebDavBackup(Buffer.alloc(MAX_BACKUP_ENVELOPE_BYTES + 1), 'secret')).toThrow(/大小限制/)
  })

  it('round-trips structured backup data', () => {
    const backup = {
      version: 1,
      profiles: [{ id: 'profile-1', password: 'sensitive' }],
      rendererStorage: { layout: '{"version":1}' },
    }

    const encrypted = encryptWebDavBackup(backup, 'webdav-secret', 1_000)

    expect(encrypted.toString('utf8')).not.toContain('sensitive')
    expect(decryptWebDavBackup(encrypted, 'webdav-secret')).toEqual(backup)
  })

  it('rejects a wrong secret', () => {
    const encrypted = encryptWebDavBackup({ version: 1 }, 'correct-secret', 1_000)
    expect(() => decryptWebDavBackup(encrypted, 'wrong-secret')).toThrow('无法解密备份')
  })

  it('rejects tampered ciphertext', () => {
    const encrypted = encryptWebDavBackup({ version: 1 }, 'webdav-secret', 1_000)
    const envelope = JSON.parse(encrypted.toString('utf8')) as { payload: string }
    const payload = Buffer.from(envelope.payload, 'base64')
    payload[0] ^= 0xff
    envelope.payload = payload.toString('base64')

    expect(() => decryptWebDavBackup(Buffer.from(JSON.stringify(envelope)), 'webdav-secret')).toThrow('无法解密备份')
  })
})
