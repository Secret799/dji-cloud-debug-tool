import { describe, expect, it } from 'vitest'
import type { ConnectionProfile, DeviceArchive } from '../../../shared/contracts'
import type { DeviceTelemetry } from './dji'
import { collectCameraSources } from './camera'
import { buildDeviceArchives, mergeDeviceArchivesIntoTelemetry } from './device-archive'

const profile = {
  id: 'profile',
  updatedAt: 10,
  devices: [
    { id: 'dock', name: '一号机场', sn: 'DOCK-1', type: 'dock' },
    { id: 'aircraft', name: '一号飞机', sn: 'AIR-1', type: 'aircraft', parentSn: 'DOCK-1' },
  ],
} as ConnectionProfile

const dockTelemetry = (lastSeenAt = 100): DeviceTelemetry => ({
  profileId: 'profile',
  sn: 'DOCK-1',
  type: 'dock',
  name: '一号机场',
  online: true,
  lastSeenAt,
  lastTopic: 'thing/product/DOCK-1/state',
  identity: { domain: '3', productType: 3, productSubType: 0 },
  status: {},
  state: { firmware_version: '01.02.03' },
  osd: {
    live_capacity: {
      device_list: [{
        sn: 'AIR-1',
        camera_list: [{
          camera_index: '81-0-0',
          coexist_video_number_max: 2,
          video_list: [{ video_index: 'wide-0', video_type: 'wide', switchable_video_types: ['wide', 'zoom'] }],
        }],
      }],
    },
  },
})

describe('device archives', () => {
  it('extracts stable device, camera and lens information from telemetry', () => {
    const archives = buildDeviceArchives(profile, [dockTelemetry()], [])

    expect(archives.find((archive) => archive.sn === 'DOCK-1')).toMatchObject({
      firmwareVersion: '01.02.03',
      identity: { domain: '3', productType: 3, productSubType: 0 },
    })
    expect(archives.find((archive) => archive.sn === 'AIR-1')?.cameras).toEqual([expect.objectContaining({
      gatewaySn: 'DOCK-1',
      cameraIndex: '81-0-0',
      videos: [expect.objectContaining({ videoIndex: 'wide-0', switchableVideoTypes: ['wide', 'zoom'] })],
    })])
  })

  it('keeps archived camera information when a later snapshot omits it', () => {
    const existing = buildDeviceArchives(profile, [dockTelemetry()], [])
    const next = buildDeviceArchives(profile, [{ ...dockTelemetry(200), osd: {} }], existing)

    expect(next.find((archive) => archive.sn === 'AIR-1')?.cameras).toEqual(
      existing.find((archive) => archive.sn === 'AIR-1')?.cameras,
    )
  })

  it('materializes an offline device snapshot from an archive', () => {
    const archives: DeviceArchive[] = [{
      profileId: 'profile', sn: 'AIR-1', gatewaySn: 'DOCK-1', type: 'aircraft', name: '一号飞机',
      modelKey: '0-91-1', firmwareVersion: '9.9.9', cameras: [], updatedAt: 100, lastReportedAt: 90,
    }]

    const telemetry = mergeDeviceArchivesIntoTelemetry(archives, [])
    expect(telemetry).toEqual([expect.objectContaining({
      sn: 'AIR-1', online: false, lastSeenAt: 90,
      state: { firmware_version: '9.9.9' }, status: { device_model_key: '0-91-1' },
    })])
  })

  it('recreates archived camera sources without a new airport report', () => {
    const archives = buildDeviceArchives(profile, [dockTelemetry()], [])
    const offlineTelemetry = mergeDeviceArchivesIntoTelemetry(archives, [])

    expect(collectCameraSources(profile, offlineTelemetry)).toEqual([expect.objectContaining({
      sourceSn: 'AIR-1', cameraIndex: '81-0-0', online: false,
      videos: [expect.objectContaining({ videoType: 'wide', status: undefined })],
    })])
  })
})
