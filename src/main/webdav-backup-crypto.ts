import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
} from 'node:crypto'

const FORMAT = 'dji-cloud-studio-encrypted-backup'
const AAD = Buffer.from(`${FORMAT}:1`, 'utf8')
const DEFAULT_ITERATIONS = 310_000
const MAX_ENCRYPTED_BYTES = 32 * 1024 * 1024

interface EncryptedBackupEnvelope {
  format: typeof FORMAT
  version: 1
  kdf: 'pbkdf2-sha256'
  iterations: number
  salt: string
  cipher: 'aes-256-gcm'
  iv: string
  tag: string
  payload: string
}

const decodeBase64 = (value: unknown, label: string): Buffer => {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`备份文件的${label}无效`)
  }
  return Buffer.from(value, 'base64')
}

export const encryptWebDavBackup = (
  value: unknown,
  secret: string,
  iterations = DEFAULT_ITERATIONS,
): Buffer => {
  if (!secret) throw new Error('WebDAV 密钥不能为空')
  if (!Number.isInteger(iterations) || iterations < 1) throw new Error('密钥派生参数无效')
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8')
  if (plaintext.byteLength > MAX_ENCRYPTED_BYTES) throw new Error('备份数据超过 32 MiB 限制')
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = pbkdf2Sync(secret, salt, iterations, 32, 'sha256')
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(AAD)
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const envelope: EncryptedBackupEnvelope = {
    format: FORMAT,
    version: 1,
    kdf: 'pbkdf2-sha256',
    iterations,
    salt: salt.toString('base64'),
    cipher: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    payload: encrypted.toString('base64'),
  }
  return Buffer.from(JSON.stringify(envelope), 'utf8')
}

export const decryptWebDavBackup = (encrypted: Buffer, secret: string): unknown => {
  if (!secret) throw new Error('WebDAV 密钥不能为空')
  if (encrypted.byteLength > MAX_ENCRYPTED_BYTES) throw new Error('备份文件超过 32 MiB 限制')
  let envelope: Partial<EncryptedBackupEnvelope>
  try {
    envelope = JSON.parse(encrypted.toString('utf8')) as Partial<EncryptedBackupEnvelope>
  } catch {
    throw new Error('备份文件不是有效的加密版本')
  }
  if (
    envelope.format !== FORMAT
    || envelope.version !== 1
    || envelope.kdf !== 'pbkdf2-sha256'
    || envelope.cipher !== 'aes-256-gcm'
    || !Number.isInteger(envelope.iterations)
    || (envelope.iterations ?? 0) < 1
    || (envelope.iterations ?? 0) > 2_000_000
  ) {
    throw new Error('备份文件格式或加密参数无效')
  }
  const salt = decodeBase64(envelope.salt, '盐值')
  const iv = decodeBase64(envelope.iv, '随机向量')
  const tag = decodeBase64(envelope.tag, '认证标签')
  const payload = decodeBase64(envelope.payload, '密文')
  if (salt.byteLength !== 16 || iv.byteLength !== 12 || tag.byteLength !== 16) {
    throw new Error('备份文件的加密参数长度无效')
  }
  try {
    const key = pbkdf2Sync(secret, salt, envelope.iterations!, 32, 'sha256')
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(AAD)
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(payload), decipher.final()])
    return JSON.parse(plaintext.toString('utf8')) as unknown
  } catch {
    throw new Error('无法解密备份，请确认 WebDAV 密钥未发生变化')
  }
}
