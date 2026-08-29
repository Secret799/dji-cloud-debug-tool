import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

export interface CredentialContext {
  store: 'mqtt' | 'media' | 'object-storage' | 'webdav'
  recordId: string
  field: string
}

const ENVELOPE_PREFIX = 'dcdt'
const ENVELOPE_VERSION = 'v1'
const CURRENT_KEY_ID = 'k1'
const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const AUTH_TAG_BYTES = 16
const MAX_CIPHERTEXT_BYTES = 64 * 1024
const KEY_DERIVATION_SALT = Buffer.from('dji-cloud-debug-tool:credential-store:v1', 'utf8')

const KEYRING: Readonly<Record<string, Buffer>> = Object.freeze({
  k1: Buffer.from('txsL9DBJutIS6kTovCMT9KvxrhUtJ79J1X4Nl0db6Q0=', 'base64'),
})

const invalidCredential = (): Error => new Error('凭据密文无效或已损坏')
const oversizedCredential = (): Error => new Error('凭据长度不能超过 64 KiB')

const decodeBase64Url = (value: string, allowEmpty = false): Buffer => {
  if (!value) {
    if (allowEmpty) return Buffer.alloc(0)
    throw invalidCredential()
  }
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw invalidCredential()
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.toString('base64url') !== value) throw invalidCredential()
  return decoded
}

const contextAad = (context: CredentialContext, keyId: string): Buffer => Buffer.from(JSON.stringify([
  'dji-cloud-debug-tool',
  ENVELOPE_VERSION,
  keyId,
  context.store,
  context.recordId,
  context.field,
]), 'utf8')

const derivedKey = (keyId: string, store: CredentialContext['store']): Buffer => {
  const masterKey = KEYRING[keyId]
  if (!masterKey || masterKey.byteLength !== 32) throw invalidCredential()
  return Buffer.from(hkdfSync(
    'sha256',
    masterKey,
    KEY_DERIVATION_SALT,
    Buffer.from(`credential-domain:${store}`, 'utf8'),
    32,
  ))
}

export const isApplicationCredential = (value: string): boolean =>
  value.startsWith(`${ENVELOPE_PREFIX}:`)

export const encryptCredential = (plaintext: string, context: CredentialContext): string => {
  if (Buffer.byteLength(plaintext, 'utf8') > MAX_CIPHERTEXT_BYTES) throw oversizedCredential()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, derivedKey(CURRENT_KEY_ID, context.store), iv)
  cipher.setAAD(contextAad(context, CURRENT_KEY_ID))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    ENVELOPE_PREFIX,
    ENVELOPE_VERSION,
    CURRENT_KEY_ID,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':')
}

export const decryptCredential = (envelope: string, context: CredentialContext): string => {
  try {
    const [prefix, version, keyId, rawIv, rawTag, rawCiphertext, ...extra] = envelope.split(':')
    if (
      prefix !== ENVELOPE_PREFIX
      || version !== ENVELOPE_VERSION
      || !keyId
      || extra.length
    ) {
      throw invalidCredential()
    }

    const iv = decodeBase64Url(rawIv)
    const tag = decodeBase64Url(rawTag)
    const ciphertext = decodeBase64Url(rawCiphertext, true)
    if (iv.byteLength !== IV_BYTES || tag.byteLength !== AUTH_TAG_BYTES || ciphertext.byteLength > MAX_CIPHERTEXT_BYTES) {
      throw invalidCredential()
    }

    const decipher = createDecipheriv(ALGORITHM, derivedKey(keyId, context.store), iv)
    decipher.setAAD(contextAad(context, keyId))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    throw invalidCredential()
  }
}
