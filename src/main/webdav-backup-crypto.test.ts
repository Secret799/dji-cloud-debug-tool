import { describe, expect, it } from 'vitest'
import { decryptWebDavBackup, encryptWebDavBackup } from './webdav-backup-crypto'

describe('WebDAV backup encryption', () => {
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
