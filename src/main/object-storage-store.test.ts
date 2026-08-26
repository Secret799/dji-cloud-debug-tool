import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ObjectStorageProfile } from '../shared/contracts'

const electronMocks = vi.hoisted(() => ({ userDataPath: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => electronMocks.userDataPath },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}))

import { ObjectStorageStore } from './object-storage-store'

const createProfile = (id: string, name = id): ObjectStorageProfile => ({
  id,
  name,
  provider: 'ali',
  bucket: `${id}-bucket`,
  region: 'cn-hangzhou',
  endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
  accessKeyId: `${id}-key`,
  accessKeySecret: `${id}-secret`,
  securityToken: `${id}-token`,
  expire: 1_900_000_000_000,
  createdAt: 1,
  updatedAt: 1,
})

describe('ObjectStorageStore', () => {
  let userDataPath = ''

  beforeEach(async () => {
    userDataPath = await mkdtemp(join(tmpdir(), 'dji-object-storage-store-'))
    electronMocks.userDataPath = userDataPath
  })

  afterEach(async () => {
    await rm(userDataPath, { recursive: true, force: true })
  })

  it('persists multiple profiles without exposing encrypted credentials in list results', async () => {
    const store = new ObjectStorageStore()
    await store.save(createProfile('primary', '主存储'))
    await store.save({ ...createProfile('archive', '归档存储'), provider: 'aws' })

    const profiles = await store.list()
    expect(profiles).toHaveLength(2)
    expect(profiles.map((profile) => profile.name)).toEqual(['主存储', '归档存储'])
    expect(profiles[0]).toMatchObject({ accessKeySecret: '', securityToken: '', hasStoredAccessKeySecret: true, hasStoredSecurityToken: true })

    const stored = await readFile(join(userDataPath, 'object-storage-profiles.json'), 'utf8')
    expect(stored).toContain('encryptedAccessKeySecret')
    expect(stored).not.toContain('primary-secret')
  })

  it('resolves credentials only for the selected profile and preserves blank secrets on edit', async () => {
    const store = new ObjectStorageStore()
    const saved = await store.save(createProfile('primary'))
    await store.save({ ...saved, name: '已编辑', accessKeySecret: '', securityToken: '' })

    expect(await store.resolve('primary')).toMatchObject({
      name: '已编辑',
      accessKeySecret: 'primary-secret',
      securityToken: 'primary-token',
    })
  })

  it('removes one profile without affecting the others', async () => {
    const store = new ObjectStorageStore()
    await store.save(createProfile('one'))
    await store.save(createProfile('two'))
    expect(await store.remove('one')).toBe(true)
    expect((await store.list()).map((profile) => profile.id)).toEqual(['two'])
  })
})
