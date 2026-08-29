import { safeStorage } from 'electron'
import {
  decryptCredential,
  encryptCredential,
  isApplicationCredential,
  type CredentialContext,
} from './credential-crypto'

interface StoredCredentialSource {
  encrypted?: string
  plaintext?: string
}

interface CredentialMigration {
  encrypted?: string
  migrated: boolean
  error?: Error
}

const legacyCredentialError = (label: string): Error =>
  new Error(`旧版${label}无法迁移，请重新输入并保存`)

const decryptLegacyCredential = (encrypted: string, label: string): string => {
  try {
    if (!safeStorage.isEncryptionAvailable()) throw legacyCredentialError(label)
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  } catch {
    throw legacyCredentialError(label)
  }
}

export const hasStoredCredential = ({ encrypted, plaintext }: StoredCredentialSource): boolean =>
  Boolean(plaintext || encrypted)

export const resolveStoredCredential = (
  source: StoredCredentialSource,
  context: CredentialContext,
  label: string,
): string => {
  if (source.plaintext !== undefined && (source.plaintext !== '' || !source.encrypted)) return source.plaintext
  if (!source.encrypted) return ''
  return isApplicationCredential(source.encrypted)
    ? decryptCredential(source.encrypted, context)
    : decryptLegacyCredential(source.encrypted, label)
}

export const migrateStoredCredential = (
  source: StoredCredentialSource,
  context: CredentialContext,
  label: string,
): CredentialMigration => {
  if (source.plaintext !== undefined && (source.plaintext !== '' || !source.encrypted)) {
    try {
      return {
        encrypted: source.plaintext ? encryptCredential(source.plaintext, context) : undefined,
        migrated: true,
      }
    } catch (error) {
      return {
        encrypted: source.encrypted,
        migrated: false,
        error: error instanceof Error ? error : invalidMigrationError(label),
      }
    }
  }
  if (source.plaintext === '' && source.encrypted) {
    return { encrypted: source.encrypted, migrated: true }
  }
  if (!source.encrypted || isApplicationCredential(source.encrypted)) {
    return { encrypted: source.encrypted, migrated: false }
  }
  try {
    const plaintext = decryptLegacyCredential(source.encrypted, label)
    return {
      encrypted: plaintext ? encryptCredential(plaintext, context) : undefined,
      migrated: true,
    }
  } catch (error) {
    return {
      encrypted: source.encrypted,
      migrated: false,
      error: error instanceof Error ? error : legacyCredentialError(label),
    }
  }
}

const invalidMigrationError = (label: string): Error =>
  new Error(`${label}无法迁移，请重新输入并保存`)
