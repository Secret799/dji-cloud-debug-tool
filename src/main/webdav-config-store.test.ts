import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebDavConfig } from '../shared/contracts'

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

import { WebDavConfigStore } from './webdav-config-store'

const createConfig = (secret = 'webdav-secret'): WebDavConfig => ({
  endpoint: 'https://dav.example.com/backups/',
  authType: 'basic',
  username: 'operator',
  secret,
  rejectUnauthorized: true,
  autoSync: true,
  syncStrategy: 'smart-merge',
  updatedAt: 1,
})

describe('WebDavConfigStore', () => {
  let userDataPath = ''

  beforeEach(async () => {
    userDataPath = await mkdtemp(join(tmpdir(), 'dji-webdav-config-store-'))
    electronMocks.userDataPath = userDataPath
  })

  afterEach(async () => {
    await rm(userDataPath, { recursive: true, force: true })
  })

  it('stores an encrypted secret and reveals it only through resolve', async () => {
    const store = new WebDavConfigStore()
    const saved = await store.save(createConfig())

    expect(saved).toMatchObject({ secret: '', hasStoredSecret: true })
    expect(await store.get()).toMatchObject({ secret: '', hasStoredSecret: true })
    expect(await store.resolve()).toMatchObject({ secret: 'webdav-secret' })

    const stored = await readFile(join(userDataPath, 'webdav-config.json'), 'utf8')
    expect(stored).toContain('encryptedSecret')
    expect(stored).toContain('dcdt:v1:k1:')
    expect(stored).not.toContain('webdav-secret')
  })

  it('preserves, replaces, and refuses to remove the required secret', async () => {
    const store = new WebDavConfigStore()
    const saved = await store.save(createConfig())

    await store.save({ ...saved, endpoint: 'https://dav.example.com/renamed/', secret: '' })
    expect(await store.resolve()).toMatchObject({ secret: 'webdav-secret' })

    const replaced = await store.save({ ...saved, secret: 'replacement-secret' })
    expect(await store.resolve()).toMatchObject({ secret: 'replacement-secret' })
    await expect(store.save({ ...replaced, secret: '', clearStoredSecret: true })).rejects.toThrow('密码不能为空')
    expect(await store.resolve()).toMatchObject({ secret: 'replacement-secret' })
  })

  it('never persists injected internal plaintext fields', async () => {
    const store = new WebDavConfigStore()
    await store.save({
      ...createConfig(),
      storedSecret: 'injected-webdav-plaintext',
      encryptedSecret: 'injected-webdav-ciphertext',
    } as WebDavConfig & { storedSecret: string; encryptedSecret: string })

    const stored = await readFile(join(userDataPath, 'webdav-config.json'), 'utf8')
    expect(stored).not.toContain('injected-webdav-plaintext')
    expect(stored).not.toContain('injected-webdav-ciphertext')
    expect(stored).not.toContain('storedSecret')
  })

  it('migrates a transitional plaintext secret', async () => {
    const { secret, ...config } = createConfig('transitional-webdav-secret')
    const filePath = join(userDataPath, 'webdav-config.json')
    await writeFile(filePath, JSON.stringify({
      version: 1,
      config: { ...config, storedSecret: secret },
    }), 'utf8')

    expect(await new WebDavConfigStore().resolve()).toMatchObject({ secret: 'transitional-webdav-secret' })
    const migrated = await readFile(filePath, 'utf8')
    expect(migrated).not.toContain('storedSecret')
    expect(migrated).not.toContain('transitional-webdav-secret')
    expect(migrated).toContain('dcdt:v1:k1:')
  })

  it('does not overwrite an unmigratable transitional secret', async () => {
    const { secret: _secret, ...config } = createConfig()
    const filePath = join(userDataPath, 'webdav-config.json')
    const document = {
      version: 1,
      config: { ...config, storedSecret: 'x'.repeat(64 * 1024 + 1) },
    }
    const original = JSON.stringify(document)
    await writeFile(filePath, original, 'utf8')

    const publicConfig = await new WebDavConfigStore().get()
    expect(publicConfig).toBeDefined()
    await expect(new WebDavConfigStore().save({ ...publicConfig!, username: 'changed' })).rejects.toThrow('凭据长度不能超过 64 KiB')
    expect(await readFile(filePath, 'utf8')).toBe(original)

    const replacementStore = new WebDavConfigStore()
    await replacementStore.save({ ...publicConfig!, secret: 'replacement-secret' })
    expect(await replacementStore.resolve()).toMatchObject({ secret: 'replacement-secret' })
    expect(await readFile(filePath, 'utf8')).not.toContain('storedSecret')
  })
})
