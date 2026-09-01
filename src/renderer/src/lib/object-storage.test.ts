import { describe, expect, it } from 'vitest'
import {
  createEmptyObjectStorageConfig,
  createObjectStorageProfile,
  objectStorageConfigIssues,
  objectStorageProfileIssues,
  parseObjectStorageConfig,
} from './object-storage'

describe('object storage configuration', () => {
  it('parses a persisted configuration', () => {
    expect(parseObjectStorageConfig({
      version: 1,
      config: {
        provider: 'minio',
        bucket: 'logs',
        region: '',
        endpoint: 'https://minio.example.com',
        credentials: {
          accessKeyId: 'key',
          accessKeySecret: 'secret',
          securityToken: '',
          expire: 1_900_000_000_000,
        },
      },
    })).toMatchObject({ provider: 'minio', bucket: 'logs' })
  })

  it('falls back safely for malformed persisted values', () => {
    expect(parseObjectStorageConfig({ version: 2 })).toEqual(createEmptyObjectStorageConfig())
  })

  it('allows MinIO without a region and reports required credentials', () => {
    const config = createEmptyObjectStorageConfig()
    config.provider = 'minio'
    config.bucket = 'logs'
    config.endpoint = 'https://minio.example.com'
    config.credentials.accessKeyId = 'key'
    config.credentials.accessKeySecret = 'secret'
    expect(objectStorageConfigIssues(config)).toEqual([])
  })

  it('accepts an encrypted credential marker when editing a managed profile', () => {
    const profile = createObjectStorageProfile()
    profile.name = 'Archive'
    profile.bucket = 'archive'
    profile.accessKeyId = 'key'
    profile.accessKeySecret = ''
    profile.hasStoredAccessKeySecret = true
    expect(objectStorageProfileIssues(profile)).toEqual([])
  })
})
