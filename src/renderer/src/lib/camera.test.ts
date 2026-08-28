import { describe, expect, it } from 'vitest'
import type { ConnectionProfile } from '../../../shared/contracts'
import type { DeviceTelemetry } from './dji'
import { cameraLiveCapacity, cameraStreamName, collectCameraSources, normalizeLiveResultCode } from './camera'

const runtime = (
  sn: string,
  type: DeviceTelemetry['type'],
  osd: Record<string, unknown>,
  gatewaySn?: string,
): DeviceTelemetry => ({
  profileId: 'profile',
  sn,
  gatewaySn,
  type,
  name: sn,
  online: true,
  lastSeenAt: Date.now(),
  lastTopic: `thing/product/${gatewaySn ?? sn}/osd`,
  status: {},
  state: {},
  osd,
})

describe('camera source aggregation', () => {
  it('keeps every gateway, aircraft camera and video stream associated with its gateway', () => {
    const profile = {
      id: 'profile',
      devices: [
        { id: 'dock-a', name: '一号机场', sn: 'DOCK-A', type: 'dock' },
        { id: 'air-a', name: '一号飞机', sn: 'AIR-A', type: 'aircraft', parentSn: 'DOCK-A' },
        { id: 'dock-b', name: '二号机场', sn: 'DOCK-B', type: 'dock' },
        { id: 'air-b', name: '二号飞机', sn: 'AIR-B', type: 'aircraft', parentSn: 'DOCK-B' },
      ],
    } as ConnectionProfile
    const telemetry = [
      runtime('DOCK-A', 'dock', {
        live_capacity: {
          available_video_number: 3,
          coexist_video_number_max: 2,
          device_list: [
            {
              sn: 'DOCK-A',
              camera_list: [{ camera_index: '165-0-0', video_list: [{ video_index: 'normal-0', video_type: 'normal' }] }],
            },
            {
              sn: 'AIR-A',
              camera_list: [{
                camera_index: '81-0-0',
                available_video_number: 2,
                video_list: [
                  { video_index: 'wide-0', video_type: 'wide', switchable_video_types: ['wide', 'zoom'] },
                  { video_index: 'infrared-0', video_type: 'infrared' },
                ],
              }],
            },
          ],
        },
        live_status: [{ video_id: 'AIR-A/81-0-0/wide-0', status: 1, video_quality: 3 }],
      }),
      runtime('AIR-A', 'aircraft', { cameras: [{ payload_index: '81-0-0' }] }, 'DOCK-A'),
      runtime('DOCK-B', 'dock', {
        live_capacity: {
          device_list: [{
            sn: 'AIR-B',
            camera_list: [{ camera_index: '99-0-0', video_list: [{ video_index: 'zoom-0', video_type: 'zoom' }] }],
          }],
        },
      }),
      runtime('AIR-B', 'aircraft', { cameras: [{ payload_index: '100-0-0' }] }, 'DOCK-B'),
    ]

    const cameras = collectCameraSources(profile, telemetry)

    expect(cameras).toHaveLength(4)
    expect(cameras.find((camera) => camera.id === 'DOCK-A:AIR-A:81-0-0')).toMatchObject({
      gatewaySn: 'DOCK-A',
      gatewayName: '一号机场',
      sourceName: '一号飞机',
      sourceType: 'aircraft',
      availableVideoNumber: 2,
    })
    expect(cameras.find((camera) => camera.id === 'DOCK-A:AIR-A:81-0-0')?.videos).toEqual([
      expect.objectContaining({ id: 'AIR-A/81-0-0/infrared-0', gatewaySn: 'DOCK-A' }),
      expect.objectContaining({ id: 'AIR-A/81-0-0/wide-0', status: 1, videoQuality: 3 }),
    ])
    expect(cameras.find((camera) => camera.id === 'DOCK-B:AIR-B:100-0-0')?.videos).toEqual([])
    expect(cameras.find((camera) => camera.id === 'DOCK-B:AIR-B:99-0-0')?.videos[0]?.gatewaySn).toBe('DOCK-B')
    expect(cameraLiveCapacity(telemetry, 'DOCK-A')).toEqual({
      availableVideoNumber: 3,
      coexistVideoNumberMax: 2,
      currentVideoNumber: 1,
    })
  })

  it('builds a stable stream name from DJI video identifiers', () => {
    expect(cameraStreamName({
      id: 'AIR/81-0-0/wide-0',
      gatewaySn: 'DOCK',
      sourceSn: 'AIR/ONE',
      cameraIndex: '81-0-0',
      videoIndex: 'wide 0',
      videoType: 'wide',
      switchableVideoTypes: [],
    })).toBe('air-one-81-0-0-wide-0')
  })

  it('counts current live streams from live_status independently of live_capacity', () => {
    const telemetry = [runtime('DOCK', 'dock', {
      live_status: [
        { video_id: 'AIR/81-0-0/wide-0', status: 1 },
        { video_id: 'AIR/81-0-0/wide-0', status: 1 },
        { video_id: 'DOCK/165-0-0/normal-0', status: 0 },
      ],
    })]

    expect(cameraLiveCapacity(telemetry, 'DOCK')).toMatchObject({ currentVideoNumber: 1 })
  })

  it('normalizes current DJI live service result codes to the legacy result family', () => {
    expect(normalizeLiveResultCode(513003)).toBe(13003)
    expect(normalizeLiveResultCode(513011)).toBe(13011)
    expect(normalizeLiveResultCode(13003)).toBe(13003)
    expect(normalizeLiveResultCode(514003)).toBe(514003)
    expect(normalizeLiveResultCode()).toBeUndefined()
  })
})
