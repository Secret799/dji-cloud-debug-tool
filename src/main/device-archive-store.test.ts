import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeviceArchive } from '../shared/contracts'

const electronMocks = vi.hoisted(() => ({ userDataPath: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => electronMocks.userDataPath },
}))

import { DeviceArchiveStore } from './device-archive-store'

const archive = (profileId: string, sn: string): DeviceArchive => ({
  profileId,
  sn,
  type: 'dock',
  name: sn,
  cameras: [],
  updatedAt: 100,
})

describe('DeviceArchiveStore', () => {
  let userDataPath: string

  beforeEach(async () => {
    userDataPath = await mkdtemp(join(tmpdir(), 'dji-device-archive-'))
    electronMocks.userDataPath = userDataPath
  })

  afterEach(async () => {
    await rm(userDataPath, { recursive: true, force: true })
  })

  it('replaces one profile without changing other profile archives', async () => {
    const store = new DeviceArchiveStore()
    await store.replaceProfile('a', [archive('a', 'DOCK-A')])
    await store.replaceProfile('b', [archive('b', 'DOCK-B')])
    await store.replaceProfile('a', [archive('a', 'DOCK-A2')])

    expect(await store.list()).toEqual([
      expect.objectContaining({ profileId: 'b', sn: 'DOCK-B' }),
      expect.objectContaining({ profileId: 'a', sn: 'DOCK-A2' }),
    ])
    expect(JSON.parse(await readFile(join(userDataPath, 'device-archives.json'), 'utf8'))).toMatchObject({ version: 1 })
  })

  it('removes every archive owned by a deleted profile', async () => {
    const store = new DeviceArchiveStore()
    await store.replaceProfile('a', [archive('a', 'DOCK-A')])
    await store.replaceProfile('b', [archive('b', 'DOCK-B')])

    expect(await store.removeProfile('a')).toBe(true)
    expect(await store.list()).toEqual([expect.objectContaining({ profileId: 'b' })])
  })

  it('backs up a corrupt archive document without blocking startup', async () => {
    await writeFile(join(userDataPath, 'device-archives.json'), '{broken', 'utf8')
    const store = new DeviceArchiveStore()

    expect(await store.list()).toEqual([])
    expect((await readdir(userDataPath)).some((name) => name.includes('.corrupt-'))).toBe(true)
    expect(JSON.parse(await readFile(join(userDataPath, 'device-archives.json'), 'utf8'))).toEqual({ version: 1, archives: [] })
  })
})
