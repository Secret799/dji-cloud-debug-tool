import type { ObjectStorageProfile, ObjectStorageProvider } from '../../../shared/contracts'

export type { ObjectStorageProvider }

export interface ObjectStorageCredentials {
  accessKeyId: string
  accessKeySecret: string
  securityToken: string
  expire: number
}

export interface ObjectStorageConfig {
  provider: ObjectStorageProvider
  bucket: string
  region: string
  endpoint: string
  credentials: ObjectStorageCredentials
}

const STORAGE_KEY = 'dji-cloud-studio.object-storage.v1'
const PROVIDERS = new Set<ObjectStorageProvider>(['ali', 'aws', 'minio'])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export const createEmptyObjectStorageConfig = (): ObjectStorageConfig => ({
  provider: 'ali',
  bucket: '',
  region: '',
  endpoint: '',
  credentials: {
    accessKeyId: '',
    accessKeySecret: '',
    securityToken: '',
    expire: 0,
  },
})

export const createObjectStorageProfile = (): ObjectStorageProfile => {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    name: '新对象存储',
    provider: 'ali',
    bucket: '',
    region: 'cn-hangzhou',
    endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
    accessKeyId: '',
    accessKeySecret: '',
    securityToken: '',
    expire: now + 60 * 60 * 1000,
    createdAt: now,
    updatedAt: now,
  }
}

export const parseObjectStorageConfig = (value: unknown): ObjectStorageConfig => {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.config)) return createEmptyObjectStorageConfig()
  const config = value.config
  const credentials = isRecord(config.credentials) ? config.credentials : {}
  const provider = typeof config.provider === 'string' && PROVIDERS.has(config.provider as ObjectStorageProvider)
    ? config.provider as ObjectStorageProvider
    : 'ali'

  return {
    provider,
    bucket: typeof config.bucket === 'string' ? config.bucket : '',
    region: typeof config.region === 'string' ? config.region : '',
    endpoint: typeof config.endpoint === 'string' ? config.endpoint : '',
    credentials: {
      accessKeyId: typeof credentials.accessKeyId === 'string' ? credentials.accessKeyId : '',
      accessKeySecret: typeof credentials.accessKeySecret === 'string' ? credentials.accessKeySecret : '',
      securityToken: typeof credentials.securityToken === 'string' ? credentials.securityToken : '',
      expire: typeof credentials.expire === 'number' && Number.isInteger(credentials.expire)
        ? credentials.expire
        : 0,
    },
  }
}

export const objectStorageConfigIssues = (config: ObjectStorageConfig): string[] => {
  const issues: string[] = []
  if (!config.bucket.trim()) issues.push('Bucket')
  if (config.provider !== 'minio' && !config.region.trim()) issues.push('Region')
  if (!config.endpoint.trim()) issues.push('Endpoint')
  if (!config.credentials.accessKeyId.trim()) issues.push('Access Key ID')
  if (!config.credentials.accessKeySecret) issues.push('Access Key Secret')
  if (!Number.isInteger(config.credentials.expire) || config.credentials.expire <= 0) issues.push('凭证过期时间戳')
  return issues
}

export const objectStorageProfileIssues = (profile: ObjectStorageProfile): string[] => {
  const issues: string[] = []
  if (!profile.name.trim()) issues.push('配置名称')
  if (!profile.bucket.trim()) issues.push('Bucket')
  if (profile.provider !== 'minio' && !profile.region.trim()) issues.push('Region')
  if (!profile.endpoint.trim()) issues.push('Endpoint')
  if (!profile.accessKeyId.trim()) issues.push('Access Key ID')
  if (!profile.accessKeySecret && !profile.hasStoredAccessKeySecret) issues.push('Access Key Secret')
  if (!Number.isInteger(profile.expire) || profile.expire <= 0) issues.push('凭证过期时间戳')
  return issues
}

export const objectStorageProfileToConfig = (profile: ObjectStorageProfile): ObjectStorageConfig => ({
  provider: profile.provider,
  bucket: profile.bucket,
  region: profile.region,
  endpoint: profile.endpoint,
  credentials: {
    accessKeyId: profile.accessKeyId,
    accessKeySecret: profile.accessKeySecret,
    securityToken: profile.securityToken,
    expire: profile.expire,
  },
})

export const objectStorageConfigToProfile = (
  config: ObjectStorageConfig,
  name = '默认对象存储',
): ObjectStorageProfile => {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    name,
    provider: config.provider,
    bucket: config.bucket,
    region: config.region,
    endpoint: config.endpoint,
    accessKeyId: config.credentials.accessKeyId,
    accessKeySecret: config.credentials.accessKeySecret,
    securityToken: config.credentials.securityToken,
    expire: config.credentials.expire,
    createdAt: now,
    updatedAt: now,
  }
}

export const loadObjectStorageConfig = (): ObjectStorageConfig => {
  if (typeof window === 'undefined') return createEmptyObjectStorageConfig()
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return stored ? parseObjectStorageConfig(JSON.parse(stored) as unknown) : createEmptyObjectStorageConfig()
  } catch {
    return createEmptyObjectStorageConfig()
  }
}

export const clearObjectStorageConfig = (): void => {
  if (typeof window !== 'undefined') window.localStorage.removeItem(STORAGE_KEY)
}
