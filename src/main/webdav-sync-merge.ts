import { createHash } from 'node:crypto'
import type {
  ConnectionProfile,
  DeviceArchive,
  MediaServerProfile,
  ObjectStorageProfile,
  WebDavSyncStrategy,
} from '../shared/contracts'

export interface WebDavSyncData {
  profiles: ConnectionProfile[]
  deviceArchives: DeviceArchive[]
  mediaServers: MediaServerProfile[]
  objectStorageProfiles: ObjectStorageProfile[]
  rendererStorage: Record<string, string>
}

export interface WebDavSyncFingerprint {
  profiles: Record<string, string>
  deviceArchives: Record<string, string>
  mediaServers: Record<string, string>
  objectStorageProfiles: Record<string, string>
  rendererStorage: Record<string, string>
}

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  )
}

const fingerprint = (value: unknown): string => createHash('sha256')
  .update(JSON.stringify(canonicalize(value)))
  .digest('hex')

const mapFingerprint = <T>(items: T[], keyOf: (item: T) => string): Record<string, string> =>
  Object.fromEntries(items.map((item) => [keyOf(item), fingerprint(item)]))

const archiveKey = (archive: DeviceArchive): string => `${archive.profileId}\u0000${archive.sn}`

export const fingerprintWebDavData = (data: WebDavSyncData): WebDavSyncFingerprint => ({
  profiles: mapFingerprint(data.profiles, (profile) => profile.id),
  deviceArchives: mapFingerprint(data.deviceArchives, archiveKey),
  mediaServers: mapFingerprint(data.mediaServers, (profile) => profile.id),
  objectStorageProfiles: mapFingerprint(data.objectStorageProfiles, (profile) => profile.id),
  rendererStorage: Object.fromEntries(
    Object.entries(data.rendererStorage).map(([key, value]) => [key, fingerprint(value)]),
  ),
})

const sameValue = (left: unknown, right: unknown): boolean => fingerprint(left) === fingerprint(right)

const resolveConcurrentItem = <T extends { updatedAt: number }>(local: T | undefined, remote: T | undefined): T | undefined => {
  // A modification wins over a concurrent deletion so synchronization never silently discards data.
  if (!local) return remote
  if (!remote) return local
  if (local.updatedAt !== remote.updatedAt) return local.updatedAt > remote.updatedAt ? local : remote
  return fingerprint(local) >= fingerprint(remote) ? local : remote
}

const mergeCollection = <T extends { updatedAt: number }>(
  local: T[],
  remote: T[],
  base: Record<string, string> | undefined,
  keyOf: (item: T) => string,
): T[] => {
  const localMap = new Map(local.map((item) => [keyOf(item), item]))
  const remoteMap = new Map(remote.map((item) => [keyOf(item), item]))
  const keys = new Set([...Object.keys(base ?? {}), ...localMap.keys(), ...remoteMap.keys()])
  const merged: T[] = []

  for (const key of [...keys].sort()) {
    const localItem = localMap.get(key)
    const remoteItem = remoteMap.get(key)
    const baseHash = base?.[key]
    if (baseHash === undefined) {
      const selected = localItem && remoteItem
        ? resolveConcurrentItem(localItem, remoteItem)
        : localItem ?? remoteItem
      if (selected) merged.push(selected)
      continue
    }

    const localChanged = localItem ? fingerprint(localItem) !== baseHash : true
    const remoteChanged = remoteItem ? fingerprint(remoteItem) !== baseHash : true
    let selected: T | undefined
    if (!localChanged) selected = remoteItem
    else if (!remoteChanged) selected = localItem
    else if (localItem && remoteItem && sameValue(localItem, remoteItem)) selected = localItem
    else selected = resolveConcurrentItem(localItem, remoteItem)
    if (selected) merged.push(selected)
  }
  return merged
}

const mergeRendererStorage = (
  local: Record<string, string>,
  remote: Record<string, string>,
  base: Record<string, string> | undefined,
): Record<string, string> => {
  const keys = new Set([...Object.keys(base ?? {}), ...Object.keys(local), ...Object.keys(remote)])
  const merged: Record<string, string> = {}
  for (const key of [...keys].sort()) {
    const localValue = local[key]
    const remoteValue = remote[key]
    const baseHash = base?.[key]
    if (baseHash === undefined) {
      if (localValue === undefined) merged[key] = remoteValue
      else if (remoteValue === undefined) merged[key] = localValue
      else merged[key] = fingerprint(localValue) >= fingerprint(remoteValue) ? localValue : remoteValue
      continue
    }
    const localChanged = localValue === undefined || fingerprint(localValue) !== baseHash
    const remoteChanged = remoteValue === undefined || fingerprint(remoteValue) !== baseHash
    if (!localChanged && remoteValue !== undefined) merged[key] = remoteValue
    else if (!remoteChanged && localValue !== undefined) merged[key] = localValue
    else if (localValue !== undefined && remoteValue !== undefined) {
      merged[key] = fingerprint(localValue) >= fingerprint(remoteValue) ? localValue : remoteValue
    } else if (localValue !== undefined) merged[key] = localValue
    else if (remoteValue !== undefined) merged[key] = remoteValue
  }
  return merged
}

export const mergeWebDavData = (
  local: WebDavSyncData,
  remote: WebDavSyncData,
  base?: WebDavSyncFingerprint,
): WebDavSyncData => {
  const profiles = mergeCollection(local.profiles, remote.profiles, base?.profiles, (profile) => profile.id)
  const profileIds = new Set(profiles.map((profile) => profile.id))
  return {
    profiles,
    deviceArchives: mergeCollection(
      local.deviceArchives,
      remote.deviceArchives,
      base?.deviceArchives,
      archiveKey,
    ).filter((archive) => profileIds.has(archive.profileId)),
    mediaServers: mergeCollection(local.mediaServers, remote.mediaServers, base?.mediaServers, (profile) => profile.id),
    objectStorageProfiles: mergeCollection(
      local.objectStorageProfiles,
      remote.objectStorageProfiles,
      base?.objectStorageProfiles,
      (profile) => profile.id,
    ),
    rendererStorage: mergeRendererStorage(local.rendererStorage, remote.rendererStorage, base?.rendererStorage),
  }
}

export const reconcileWebDavData = (
  local: WebDavSyncData,
  remote: WebDavSyncData,
  hasSyncBase: boolean,
  base?: WebDavSyncFingerprint,
  strategy: WebDavSyncStrategy = 'smart-merge',
): WebDavSyncData => {
  if (!hasSyncBase) return remote
  if (strategy === 'smart-merge' || !base) return mergeWebDavData(local, remote, base)

  const localChanged = !sameValue(fingerprintWebDavData(local), base)
  const remoteChanged = !sameValue(fingerprintWebDavData(remote), base)
  if (!localChanged || !remoteChanged) return mergeWebDavData(local, remote, base)
  return strategy === 'cloud-first' ? remote : local
}

export const webDavDataEqual = (left: WebDavSyncData, right: WebDavSyncData): boolean =>
  sameValue(left, right)

const mqttRuntimeProfileValue = (profile: ConnectionProfile): unknown => {
  const {
    name: _name,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    hasStoredPassword: _hasStoredPassword,
    clearStoredPassword: _clearStoredPassword,
    ...runtimeValue
  } = profile
  return runtimeValue
}

export const changedMqttRuntimeProfileIds = (
  current: ConnectionProfile[],
  next: ConnectionProfile[],
): string[] => {
  const currentById = new Map(current.map((profile) => [profile.id, profile]))
  const nextById = new Map(next.map((profile) => [profile.id, profile]))
  const profileIds = new Set([...currentById.keys(), ...nextById.keys()])
  return [...profileIds].filter((profileId) => {
    const currentProfile = currentById.get(profileId)
    const nextProfile = nextById.get(profileId)
    return !currentProfile
      || !nextProfile
      || !sameValue(mqttRuntimeProfileValue(currentProfile), mqttRuntimeProfileValue(nextProfile))
  })
}
