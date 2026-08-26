import { describe, expect, it } from 'vitest'
import type { DeviceTelemetry } from './dji'
import { parseTelemetryCache, serializeTelemetryCache } from './telemetry-cache'

const telemetry = (
  profileId: string,
  sn: string,
  lastSeenAt: number,
  online = true,
): DeviceTelemetry => ({
  profileId,
  sn,
  type: 'dock',
  name: sn,
  online,
  lastSeenAt,
  lastTopic: `thing/product/${sn}/osd`,
  identity: { domain: '3', productType: 3, productSubType: 0 },
  osd: { temperature: 23 },
  state: { mode: 1 },
  status: { online_status: 1 },
})

describe('telemetry cache', () => {
  it('restores the last snapshot for each profile and marks it offline', () => {
    const cached = parseTelemetryCache(JSON.parse(serializeTelemetryCache({
      'test:DOCK-1': telemetry('test', 'DOCK-1', 100),
      'production:DOCK-1': telemetry('production', 'DOCK-1', 200),
    })) as unknown)

    expect(Object.keys(cached)).toEqual(['production:DOCK-1', 'test:DOCK-1'])
    expect(cached['production:DOCK-1']).toMatchObject({
      profileId: 'production',
      sn: 'DOCK-1',
      online: false,
      osd: { temperature: 23 },
      state: { mode: 1 },
      status: { online_status: 1 },
    })
  })

  it('keeps the newest devices first when the cache reaches its size limit', () => {
    const newer = telemetry('profile', 'NEW', 200)
    const older = telemetry('profile', 'OLD', 100)
    const oneDeviceBudget = new TextEncoder().encode(serializeTelemetryCache({ newer })).byteLength
    const cached = parseTelemetryCache(JSON.parse(serializeTelemetryCache({ older, newer }, oneDeviceBudget)) as unknown)

    expect(Object.keys(cached)).toEqual(['profile:NEW'])
  })

  it('ignores malformed or unsupported cache documents', () => {
    expect(parseTelemetryCache({ version: 2, devices: [] })).toEqual({})
    expect(parseTelemetryCache({
      version: 1,
      devices: [{ profileId: 'profile', sn: 'DOCK', type: 'dock', osd: [] }],
    })).toEqual({})
  })

  it('does not restore stale live stream runtime state', () => {
    const device = telemetry('profile', 'DOCK', 100)
    device.osd.live_status = [{ video_id: 'AIR/81/wide', status: 1 }]
    device.osd.live_capacity = { device_list: [] }

    const cached = parseTelemetryCache(JSON.parse(serializeTelemetryCache({ device })) as unknown)

    expect(cached['profile:DOCK'].osd).not.toHaveProperty('live_status')
    expect(cached['profile:DOCK'].osd).toHaveProperty('live_capacity')
  })
})
