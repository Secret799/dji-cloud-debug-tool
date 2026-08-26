import type { ConnectionProfile, DeviceArchive, DeviceArchiveCamera } from '../../../shared/contracts'
import { collectCameraSources } from './camera'
import { mergeNestedRecords, telemetryValue, type DeviceTelemetry } from './dji'

const textValue = (value: unknown): string | undefined =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim() || undefined
    : undefined

const archiveCameraKey = (camera: DeviceArchiveCamera): string =>
  `${camera.gatewaySn}:${camera.sourceSn}:${camera.cameraIndex}`

const mergeCameras = (
  existing: DeviceArchiveCamera[],
  reported: DeviceArchiveCamera[],
): DeviceArchiveCamera[] => {
  const cameras = new Map(existing.map((camera) => [archiveCameraKey(camera), camera]))
  reported.forEach((camera) => {
    const previous = cameras.get(archiveCameraKey(camera))
    const videos = new Map(previous?.videos.map((video) => [video.videoIndex, video]) ?? [])
    camera.videos.forEach((video) => videos.set(video.videoIndex, video))
    cameras.set(archiveCameraKey(camera), {
      ...previous,
      ...camera,
      coexistVideoNumberMax: camera.coexistVideoNumberMax ?? previous?.coexistVideoNumberMax,
      videos: [...videos.values()].sort((left, right) => left.videoIndex.localeCompare(right.videoIndex)),
    })
  })
  return [...cameras.values()].sort((left, right) => archiveCameraKey(left).localeCompare(archiveCameraKey(right)))
}

const staticArchiveValue = (archive: DeviceArchive): Omit<DeviceArchive, 'updatedAt' | 'lastReportedAt'> => {
  const { updatedAt: _updatedAt, lastReportedAt: _lastReportedAt, ...value } = archive
  return value
}

const LAST_REPORTED_WRITE_INTERVAL_MS = 60_000

export const buildDeviceArchives = (
  profile: ConnectionProfile,
  telemetry: DeviceTelemetry[],
  existing: DeviceArchive[],
): DeviceArchive[] => {
  const existingBySn = new Map(existing.filter((archive) => archive.profileId === profile.id).map((archive) => [archive.sn, archive]))
  const configuredBySn = new Map(profile.devices.map((device) => [device.sn, device]))
  const telemetryBySn = new Map(telemetry.filter((device) => device.profileId === profile.id).map((device) => [device.sn, device]))
  const reportedCameras = collectCameraSources(profile, telemetry).reduce((bySn, camera) => {
    const cameras = bySn.get(camera.sourceSn) ?? []
    cameras.push({
      gatewaySn: camera.gatewaySn,
      sourceSn: camera.sourceSn,
      cameraIndex: camera.cameraIndex,
      coexistVideoNumberMax: camera.coexistVideoNumberMax,
      videos: camera.videos.map((video) => ({
        videoIndex: video.videoIndex,
        videoType: video.videoType,
        switchableVideoTypes: [...video.switchableVideoTypes],
      })),
    })
    bySn.set(camera.sourceSn, cameras)
    return bySn
  }, new Map<string, DeviceArchiveCamera[]>())
  const sns = new Set([...existingBySn.keys(), ...configuredBySn.keys(), ...telemetryBySn.keys()])

  return [...sns].flatMap((sn) => {
    const previous = existingBySn.get(sn)
    const configured = configuredBySn.get(sn)
    const runtime = telemetryBySn.get(sn)
    if (!previous && !configured && !runtime) return []
    const source = runtime ? mergeNestedRecords(runtime.status, runtime.state, runtime.osd) : {}
    const modelKey = textValue(telemetryValue(source, 'device_model_key')) ?? previous?.modelKey
    const firmwareVersion = textValue(telemetryValue(source, 'firmware_version')) ?? previous?.firmwareVersion
    const cameras = mergeCameras(previous?.cameras ?? [], reportedCameras.get(sn) ?? [])
    const candidate: DeviceArchive = {
      profileId: profile.id,
      sn,
      gatewaySn: runtime?.gatewaySn ?? configured?.parentSn ?? previous?.gatewaySn,
      type: configured?.type ?? runtime?.type ?? previous?.type ?? 'aircraft',
      name: configured?.name ?? runtime?.name ?? previous?.name ?? sn,
      identity: runtime?.identity ?? previous?.identity,
      modelKey,
      firmwareVersion,
      cameras,
      updatedAt: previous?.updatedAt ?? runtime?.lastSeenAt ?? profile.updatedAt,
      lastReportedAt: previous?.lastReportedAt ?? runtime?.lastSeenAt,
    }
    const staticChanged = !previous
      || JSON.stringify(staticArchiveValue(previous)) !== JSON.stringify(staticArchiveValue(candidate))
    const reportAdvanced = Boolean(
      runtime
      && runtime.lastSeenAt - (previous?.lastReportedAt ?? 0) >= LAST_REPORTED_WRITE_INTERVAL_MS,
    )
    if (!staticChanged && !reportAdvanced) return [previous]
    return [{
      ...candidate,
      updatedAt: staticChanged ? Date.now() : previous?.updatedAt ?? Date.now(),
      lastReportedAt: runtime?.lastSeenAt ?? previous?.lastReportedAt,
    }]
  }).sort((left, right) => left.sn.localeCompare(right.sn))
}

export const mergeDeviceArchivesIntoTelemetry = (
  archives: DeviceArchive[],
  telemetry: DeviceTelemetry[],
): DeviceTelemetry[] => {
  const devices = new Map<string, DeviceTelemetry>()
  const camerasByGateway = archives.flatMap((archive) => archive.cameras).reduce((byGateway, camera) => {
    const deviceCameras = byGateway.get(camera.gatewaySn) ?? new Map<string, DeviceArchiveCamera[]>()
    const cameras = deviceCameras.get(camera.sourceSn) ?? []
    cameras.push(camera)
    deviceCameras.set(camera.sourceSn, cameras)
    byGateway.set(camera.gatewaySn, deviceCameras)
    return byGateway
  }, new Map<string, Map<string, DeviceArchiveCamera[]>>())
  archives.forEach((archive) => {
    const gatewayCameras = camerasByGateway.get(archive.sn)
    const liveCapacity = gatewayCameras ? {
      coexist_video_number_max: [...gatewayCameras.values()].flat()
        .reduce<number | undefined>((maximum, camera) => camera.coexistVideoNumberMax === undefined
          ? maximum
          : Math.max(maximum ?? 0, camera.coexistVideoNumberMax), undefined),
      device_list: [...gatewayCameras].map(([sourceSn, cameras]) => ({
        sn: sourceSn,
        camera_list: cameras.map((camera) => ({
          camera_index: camera.cameraIndex,
          coexist_video_number_max: camera.coexistVideoNumberMax,
          video_list: camera.videos.map((video) => ({
            video_index: video.videoIndex,
            video_type: video.videoType,
            switchable_video_types: video.switchableVideoTypes,
          })),
        })),
      })),
    } : undefined
    devices.set(archive.sn, {
      profileId: archive.profileId,
      sn: archive.sn,
      gatewaySn: archive.gatewaySn,
      type: archive.type,
      name: archive.name,
      online: false,
      lastSeenAt: archive.lastReportedAt ?? 0,
      lastTopic: 'device-archive',
      identity: archive.identity,
      osd: {
        ...(liveCapacity ? { live_capacity: liveCapacity } : {}),
        ...(archive.cameras.length ? { cameras: archive.cameras.map((camera) => ({ payload_index: camera.cameraIndex })) } : {}),
      },
      state: archive.firmwareVersion ? { firmware_version: archive.firmwareVersion } : {},
      status: archive.modelKey ? { device_model_key: archive.modelKey } : {},
    })
  })
  telemetry.forEach((device) => {
    const archived = devices.get(device.sn)
    devices.set(device.sn, archived ? {
      ...archived,
      ...device,
      identity: device.identity ?? archived.identity,
      osd: mergeNestedRecords(archived.osd, device.osd),
      state: mergeNestedRecords(archived.state, device.state),
      status: mergeNestedRecords(archived.status, device.status),
    } : device)
  })
  return [...devices.values()]
}

export const deviceArchivesEqual = (left: DeviceArchive[], right: DeviceArchive[]): boolean =>
  JSON.stringify(left) === JSON.stringify(right)
