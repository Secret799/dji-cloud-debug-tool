import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ObjectStorageProfile } from '../shared/contracts'

const electronMocks = vi.hoisted(() => ({
  userDataPath: '',
  decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
}))

vi.mock('electron', () => ({
  app: { getPath: () => electronMocks.userDataPath },
  safeStorage: {
    isEncryptionAvailable: () => true,
    decryptString: electronMocks.decryptString,
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

  it('persists encrypted credentials without exposing them in list results', async () => {
    const store = new ObjectStorageStore()
    await store.save(createProfile('primary', '主存储'))
    await store.save({ ...createProfile('archive', '归档存储'), provider: 'aws' })

    const profiles = await store.list()
    expect(profiles).toHaveLength(2)
    expect(profiles.map((profile) => profile.name)).toEqual(['主存储', '归档存储'])
    expect(profiles[0]).toMatchObject({ accessKeySecret: '', securityToken: '', hasStoredAccessKeySecret: true, hasStoredSecurityToken: true })

    const stored = await readFile(join(userDataPath, 'object-storage-profiles.json'), 'utf8')
    expect(stored).toContain('encryptedAccessKeySecret')
    expect(stored).toContain('dcdt:v1:k1:')
    expect(stored).not.toContain('primary-secret')
    expect(stored).not.toContain('primary-token')
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

  it('clears an optional security token without clearing the access key secret', async () => {
    const store = new ObjectStorageStore()
    const saved = await store.save(createProfile('temporary'))

    const cleared = await store.save({
      ...saved,
      clearStoredSecurityToken: true,
    })

    expect(cleared).toMatchObject({ hasStoredAccessKeySecret: true, hasStoredSecurityToken: false })
    expect(await store.resolve('temporary')).toMatchObject({
      accessKeySecret: 'temporary-secret',
      securityToken: '',
    })
    const document = JSON.parse(await readFile(join(userDataPath, 'object-storage-profiles.json'), 'utf8'))
    expect(document.profiles[0]).not.toHaveProperty('encryptedSecurityToken')
  })

  it('never persists injected internal plaintext fields', async () => {
    const store = new ObjectStorageStore()
    await store.save({
      ...createProfile('injected'),
      storedAccessKeySecret: 'plaintext-access-key-secret',
      storedSecurityToken: 'plaintext-security-token',
    } as ObjectStorageProfile & { storedAccessKeySecret: string; storedSecurityToken: string })

    const stored = await readFile(join(userDataPath, 'object-storage-profiles.json'), 'utf8')
    expect(stored).not.toContain('plaintext-access-key-secret')
    expect(stored).not.toContain('plaintext-security-token')
    expect(stored).not.toContain('storedAccessKeySecret')
    expect(stored).not.toContain('storedSecurityToken')
  })

  it('removes one profile without affecting the others', async () => {
    const store = new ObjectStorageStore()
    await store.save(createProfile('one'))
    await store.save(createProfile('two'))
    expect(await store.remove('one')).toBe(true)
    expect((await store.list()).map((profile) => profile.id)).toEqual(['two'])
  })

  it('migrates transitional plaintext object-storage credentials', async () => {
    const filePath = join(userDataPath, 'object-storage-profiles.json')
    const profile = createProfile('legacy')
    const { accessKeySecret, securityToken, ...plain } = profile
    await writeFile(filePath, JSON.stringify({
      version: 1,
      profiles: [{
        ...plain,
        expire: 1_900_000_000_000,
        storedAccessKeySecret: accessKeySecret,
        storedSecurityToken: securityToken,
      }],
    }), 'utf8')

    expect(await new ObjectStorageStore().resolve('legacy')).toMatchObject({
      accessKeySecret: 'legacy-secret',
      securityToken: 'legacy-token',
    })
    const migrated = await readFile(filePath, 'utf8')
    expect(migrated).not.toContain('storedAccessKeySecret')
    expect(migrated).not.toContain('storedSecurityToken')
    expect(migrated).not.toContain('"expire"')
    expect(migrated).not.toContain('legacy-secret')
    expect(migrated).toContain('dcdt:v1:k1:')
  })

  it('does not overwrite an unmigratable transitional access key secret', async () => {
    const filePath = join(userDataPath, 'object-storage-profiles.json')
    const { accessKeySecret: _accessKeySecret, securityToken: _securityToken, ...plain } = createProfile('oversized')
    const document = {
      version: 1,
      profiles: [{ ...plain, storedAccessKeySecret: 'x'.repeat(64 * 1024 + 1) }],
    }
    const original = JSON.stringify(document)
    await writeFile(filePath, original, 'utf8')

    const [profile] = await new ObjectStorageStore().list()
    await expect(new ObjectStorageStore().save({ ...profile, name: 'Changed' })).rejects.toThrow('凭据长度不能超过 64 KiB')
    expect(await readFile(filePath, 'utf8')).toBe(original)

    const replacementStore = new ObjectStorageStore()
    await replacementStore.save({ ...profile, accessKeySecret: 'replacement-secret' })
    expect(await replacementStore.resolve(profile.id)).toMatchObject({ accessKeySecret: 'replacement-secret' })
    expect(await readFile(filePath, 'utf8')).not.toContain('storedAccessKeySecret')
  })
})
