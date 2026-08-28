import { describe, expect, it } from 'vitest'
import type { ConnectionProfile, DeviceArchive } from '../shared/contracts'
import {
  fingerprintWebDavData,
  mergeWebDavData,
  reconcileWebDavData,
  type WebDavSyncData,
} from './webdav-sync-merge'

const profile = (id: string, name: string, updatedAt: number): ConnectionProfile => ({
  id, name, updatedAt, createdAt: 1, protocol: 'mqtt', host: 'localhost', port: 1883, path: '/mqtt',
  clientId: id, username: '', password: '', mqttVersion: '3.1.1', clean: true, keepalive: 60,
  connectTimeout: 10, reconnectPeriod: 3, rejectUnauthorized: true, caPath: '', certPath: '', keyPath: '',
  devices: [], subscriptions: [],
})

const archive = (profileId: string, sn: string, name: string, updatedAt: number): DeviceArchive => ({
  profileId, sn, name, updatedAt, type: 'dock', cameras: [],
})

const data = (profiles: ConnectionProfile[], deviceArchives: DeviceArchive[] = []): WebDavSyncData => ({
  profiles, deviceArchives, mediaServers: [], objectStorageProfiles: [], rendererStorage: {},
})

describe('WebDAV three-way merge', () => {
  it('uses the cloud snapshot as the baseline for a new client', () => {
    const local = data([profile('local-default', 'Local default', 10)])
    const remote = data([profile('cloud-profile', 'Cloud profile', 5)])

    const reconciled = reconcileWebDavData(local, remote, false)

    expect(reconciled).toBe(remote)
    expect(reconciled.profiles.map((item) => item.id)).toEqual(['cloud-profile'])
  })

  it('merges after the client has established a synchronization baseline', () => {
    const base = data([profile('cloud-profile', 'Cloud profile', 1)])
    const local = data([
      profile('cloud-profile', 'Cloud profile', 1),
      profile('local-profile', 'Local profile', 2),
    ])
    const remote = data([profile('cloud-profile', 'Remote edit', 3)])

    const reconciled = reconcileWebDavData(local, remote, true, fingerprintWebDavData(base))

    expect(reconciled.profiles.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'cloud-profile', name: 'Remote edit' },
      { id: 'local-profile', name: 'Local profile' },
    ])
  })

  it('keeps independent changes made by two clients', () => {
    const base = data([profile('a', 'A', 1), profile('b', 'B', 1)])
    const local = data([profile('a', 'Local A', 2), profile('b', 'B', 1)])
    const remote = data([profile('a', 'A', 1), profile('b', 'Remote B', 3)])

    const merged = mergeWebDavData(local, remote, fingerprintWebDavData(base))

    expect(merged.profiles.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'a', name: 'Local A' },
      { id: 'b', name: 'Remote B' },
    ])
  })

  it('uses the newest update when both clients edit the same record', () => {
    const base = data([profile('a', 'A', 1)])
    const merged = mergeWebDavData(
      data([profile('a', 'Local', 2)]),
      data([profile('a', 'Remote', 3)]),
      fingerprintWebDavData(base),
    )
    expect(merged.profiles[0].name).toBe('Remote')
  })

  it('preserves a concurrent modification instead of applying a deletion', () => {
    const base = data([profile('a', 'A', 1)])
    const merged = mergeWebDavData(data([]), data([profile('a', 'Remote', 2)]), fingerprintWebDavData(base))
    expect(merged.profiles[0].name).toBe('Remote')
  })

  it('removes archives whose parent profile was deleted on both sides', () => {
    const base = data([profile('a', 'A', 1)], [archive('a', 'SN1', 'Dock', 1)])
    const merged = mergeWebDavData(data([], []), data([], []), fingerprintWebDavData(base))
    expect(merged.deviceArchives).toEqual([])
  })
})
