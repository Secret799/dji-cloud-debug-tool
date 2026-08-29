import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionProfile } from '../shared/contracts'

const electronMocks = vi.hoisted(() => ({
  userDataPath: '',
  encryptionAvailable: true,
  decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => electronMocks.userDataPath,
  },
  safeStorage: {
    isEncryptionAvailable: () => electronMocks.encryptionAvailable,
    decryptString: electronMocks.decryptString,
  },
}))

import { ProfileStore } from './profile-store'

describe('ProfileStore', () => {
  let userDataPath: string

  beforeEach(async () => {
    userDataPath = await mkdtemp(join(tmpdir(), 'dji-profile-store-'))
    electronMocks.userDataPath = userDataPath
    electronMocks.encryptionAvailable = true
    electronMocks.decryptString.mockReset()
    electronMocks.decryptString.mockImplementation((value: Buffer) => value.toString('utf8'))
  })

  afterEach(async () => {
    await rm(userDataPath, { recursive: true, force: true })
  })

  it('serializes concurrent full-document saves without losing profiles', async () => {
    const store = new ProfileStore()
    const [base] = await store.list()

    await Promise.all([
      store.save({ ...base, id: 'profile-a', name: 'Profile A' }),
      store.save({ ...base, id: 'profile-b', name: 'Profile B' }),
    ])

    const profiles = await store.list()
    expect(profiles.map((profile) => profile.id)).toEqual(
      expect.arrayContaining([base.id, 'profile-a', 'profile-b']),
    )
    expect((await readdir(userDataPath)).some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  it('backs up invalid JSON before restoring defaults', async () => {
    const store = new ProfileStore()
    await store.list()
    const filePath = join(userDataPath, 'connection-profiles.json')
    await writeFile(filePath, '{not-json', 'utf8')

    const profiles = await store.list()
    const backupName = (await readdir(userDataPath)).find((name) => name.includes('.corrupt-'))

    expect(profiles).toHaveLength(1)
    expect(backupName).toBeDefined()
    expect(await readFile(join(userDataPath, backupName!), 'utf8')).toBe('{not-json')
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toMatchObject({ version: 1 })
  })

  it('encrypts, resolves and clears a password in the application profile file', async () => {
    const store = new ProfileStore()
    const [base] = await store.list()
    const saved = await store.save({ ...base, password: 'secret' })

    expect(saved.hasStoredPassword).toBe(true)
    expect(await store.resolvePassword(base.id)).toBe('secret')
    expect((await store.getForConnection(base.id, ''))?.password).toBe('')
    const encrypted = await readFile(join(userDataPath, 'connection-profiles.json'), 'utf8')
    expect(encrypted).toContain('encryptedPassword')
    expect(encrypted).toContain('dcdt:v1:k1:')
    expect(encrypted).not.toContain('secret')

    const cleared = await store.save({
      ...saved,
      password: '',
      clearStoredPassword: true,
    })

    expect(cleared.hasStoredPassword).toBe(false)
    expect(cleared).not.toHaveProperty('clearStoredPassword')
    expect(await store.resolvePassword(base.id)).toBe('')
    const stored = await readFile(join(userDataPath, 'connection-profiles.json'), 'utf8')
    expect(stored).not.toContain('storedPassword')
    expect(stored).not.toContain('encryptedPassword')
  })

  it('migrates plaintext credentials written by the transitional application version', async () => {
    const store = new ProfileStore()
    const [base] = await store.list()
    const filePath = join(userDataPath, 'connection-profiles.json')
    const document = JSON.parse(await readFile(filePath, 'utf8'))
    document.profiles[0].storedPassword = 'transitional-secret'
    await writeFile(filePath, JSON.stringify(document), 'utf8')

    expect(await new ProfileStore().resolvePassword(base.id)).toBe('transitional-secret')
    const migrated = await readFile(filePath, 'utf8')
    expect(migrated).toContain('dcdt:v1:k1:')
    expect(migrated).not.toContain('storedPassword')
    expect(migrated).not.toContain('transitional-secret')
  })

  it('migrates legacy safeStorage credentials only when reading the old format', async () => {
    const store = new ProfileStore()
    const [base] = await store.list()
    const filePath = join(userDataPath, 'connection-profiles.json')
    const document = JSON.parse(await readFile(filePath, 'utf8'))
    document.profiles[0].encryptedPassword = Buffer.from('legacy-secret', 'utf8').toString('base64')
    await writeFile(filePath, JSON.stringify(document), 'utf8')

    expect(await new ProfileStore().resolvePassword(base.id)).toBe('legacy-secret')
    expect(electronMocks.decryptString).toHaveBeenCalledTimes(1)
    const migrated = await readFile(filePath, 'utf8')
    expect(migrated).toContain('dcdt:v1:k1:')
    expect(migrated).not.toContain(Buffer.from('legacy-secret', 'utf8').toString('base64'))
  })

  it('keeps legacy ciphertext unchanged when system decryption is unavailable', async () => {
    const store = new ProfileStore()
    await store.list()
    const filePath = join(userDataPath, 'connection-profiles.json')
    const document = JSON.parse(await readFile(filePath, 'utf8'))
    document.profiles[0].encryptedPassword = Buffer.from('legacy-secret', 'utf8').toString('base64')
    const legacyDocument = JSON.stringify(document)
    await writeFile(filePath, legacyDocument, 'utf8')
    electronMocks.encryptionAvailable = false

    const [profile] = await new ProfileStore().list()

    expect(profile.hasStoredPassword).toBe(true)
    expect(await readFile(filePath, 'utf8')).toBe(legacyDocument)
    expect(electronMocks.decryptString).not.toHaveBeenCalled()
  })

  it('keeps legacy ciphertext unchanged when system decryption fails', async () => {
    const store = new ProfileStore()
    await store.list()
    const filePath = join(userDataPath, 'connection-profiles.json')
    const document = JSON.parse(await readFile(filePath, 'utf8'))
    document.profiles[0].encryptedPassword = Buffer.from('legacy-secret', 'utf8').toString('base64')
    const legacyDocument = JSON.stringify(document)
    await writeFile(filePath, legacyDocument, 'utf8')
    electronMocks.decryptString.mockImplementation(() => { throw new Error('denied') })

    const [profile] = await new ProfileStore().list()

    expect(profile.hasStoredPassword).toBe(true)
    expect(await readFile(filePath, 'utf8')).toBe(legacyDocument)
    expect(electronMocks.decryptString).toHaveBeenCalledTimes(1)
  })

  it('ignores injected internal fields and removes an empty transitional field', async () => {
    const store = new ProfileStore()
    const [base] = await store.list()
    await store.save({
      ...base,
      password: 'real-secret',
      storedPassword: 'injected-plaintext',
      encryptedPassword: 'injected-ciphertext',
    } as ConnectionProfile & { storedPassword: string; encryptedPassword: string })
    const filePath = join(userDataPath, 'connection-profiles.json')
    let stored = await readFile(filePath, 'utf8')
    expect(stored).not.toContain('injected-plaintext')
    expect(stored).not.toContain('injected-ciphertext')

    const document = JSON.parse(stored)
    document.profiles[0].storedPassword = ''
    await writeFile(filePath, JSON.stringify(document), 'utf8')

    expect(await new ProfileStore().resolvePassword(base.id)).toBe('real-secret')
    stored = await readFile(filePath, 'utf8')
    expect(stored).not.toContain('storedPassword')
  })

  it('does not overwrite an unmigratable transitional credential', async () => {
    const store = new ProfileStore()
    await store.list()
    const filePath = join(userDataPath, 'connection-profiles.json')
    const document = JSON.parse(await readFile(filePath, 'utf8'))
    document.profiles[0].storedPassword = 'x'.repeat(64 * 1024 + 1)
    delete document.profiles[0].encryptedPassword
    const original = JSON.stringify(document)
    await writeFile(filePath, original, 'utf8')

    const [profile] = await new ProfileStore().list()
    await expect(new ProfileStore().save({ ...profile, name: 'Changed' })).rejects.toThrow('凭据长度不能超过 64 KiB')
    expect(await readFile(filePath, 'utf8')).toBe(original)

    const replacementStore = new ProfileStore()
    await replacementStore.save({ ...profile, password: 'replacement-secret' })
    expect(await replacementStore.resolvePassword(profile.id)).toBe('replacement-secret')
    expect(await readFile(filePath, 'utf8')).not.toContain('storedPassword')
  })
})
