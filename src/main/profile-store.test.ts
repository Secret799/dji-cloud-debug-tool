import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  userDataPath: '',
  encryptString: vi.fn((value: string) => Buffer.from(value, 'utf8')),
  decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => electronMocks.userDataPath,
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: electronMocks.encryptString,
    decryptString: electronMocks.decryptString,
  },
}))

import { ProfileStore } from './profile-store'

describe('ProfileStore', () => {
  let userDataPath: string

  beforeEach(async () => {
    userDataPath = await mkdtemp(join(tmpdir(), 'dji-profile-store-'))
    electronMocks.userDataPath = userDataPath
    electronMocks.encryptString.mockClear()
    electronMocks.decryptString.mockClear()
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

  it('clears an encrypted password only when explicitly requested', async () => {
    const store = new ProfileStore()
    const [base] = await store.list()
    const saved = await store.save({ ...base, password: 'secret' })

    expect(saved.hasStoredPassword).toBe(true)
    expect(await store.resolvePassword(base.id)).toBe('secret')
    expect((await store.getForConnection(base.id, ''))?.password).toBe('')

    const cleared = await store.save({
      ...saved,
      password: '',
      clearStoredPassword: true,
    })

    expect(cleared.hasStoredPassword).toBe(false)
    expect(cleared).not.toHaveProperty('clearStoredPassword')
    expect(await store.resolvePassword(base.id)).toBe('')
    expect(await readFile(join(userDataPath, 'connection-profiles.json'), 'utf8')).not.toContain('encryptedPassword')
  })
})
