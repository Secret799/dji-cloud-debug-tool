import { describe, expect, it } from 'vitest'
import type { DeviceTelemetry } from './dji'
import { devicePosition, devicePositions } from './map-device-position'

const telemetry = (patch: Partial<DeviceTelemetry> = {}): DeviceTelemetry => ({
  profileId: 'profile-1',
  sn: 'DOCK-1',
  type: 'dock',
  provider: 'dji',
  name: '一号机场',
  online: true,
  lastSeenAt: 1_700_000_000_000,
  lastTopic: 'thing/product/DOCK-1/osd',
  osd: { latitude: 39.90869, longitude: 116.39740, height: 43.5 },
  state: {},
  status: {},
  ...patch,
})

describe('device position extraction', () => {
  it('reads dock position from the osd record', () => {
    expect(devicePosition(telemetry())).toEqual({
      sn: 'DOCK-1',
      name: '一号机场',
      type: 'dock',
      provider: 'dji',
      online: true,
      lastSeenAt: 1_700_000_000_000,
      wgs84: { latitude: 39.90869, longitude: 116.39740 },
      height: 43.5,
    })
  })

  it('falls back to the state record when osd has no coordinates', () => {
    const position = devicePosition(telemetry({
      osd: { height: 43.5 },
      state: { latitude: 31.2304, longitude: 121.4737 },
    }))
    expect(position?.wgs84).toEqual({ latitude: 31.2304, longitude: 121.4737 })
  })

  it('prefers the osd record when both records carry coordinates', () => {
    const position = devicePosition(telemetry({
      state: { latitude: 31.2304, longitude: 121.4737 },
    }))
    expect(position?.wgs84).toEqual({ latitude: 39.90869, longitude: 116.39740 })
  })

  it('reads the aircraft home point when present', () => {
    const position = devicePosition(telemetry({
      type: 'aircraft',
      sn: '1581F5FKD2',
      osd: {
        latitude: 39.91000, longitude: 116.40000, height: 120,
        home_latitude: 39.90869, home_longitude: 116.39740,
      },
    }))
    expect(position?.home).toEqual({ latitude: 39.90869, longitude: 116.39740 })
  })

  it('omits the home point for docks even when the device reports one', () => {
    const position = devicePosition(telemetry({
      osd: {
        latitude: 39.90869,
        longitude: 116.39740,
        home_latitude: 39.8,
        home_longitude: 116.3,
      },
    }))
    expect(position?.home).toBeUndefined()
  })

  it('rejects devices without a usable fix', () => {
    expect(devicePosition(telemetry({ osd: {} }))).toBeUndefined()
    expect(devicePosition(telemetry({ osd: { latitude: 39.9 } }))).toBeUndefined()
    expect(devicePosition(telemetry({ osd: { latitude: Number.NaN, longitude: 116.4 } }))).toBeUndefined()
    expect(devicePosition(telemetry({ osd: { latitude: '39.9', longitude: 116.4 } }))).toBeUndefined()
  })

  it('treats the zero coordinate placeholder as no fix', () => {
    expect(devicePosition(telemetry({ osd: { latitude: 0, longitude: 0 } }))).toBeUndefined()
  })

  it('rejects out-of-range coordinates', () => {
    expect(devicePosition(telemetry({ osd: { latitude: 91, longitude: 116.4 } }))).toBeUndefined()
    expect(devicePosition(telemetry({ osd: { latitude: 39.9, longitude: 181 } }))).toBeUndefined()
  })

  it('keeps offline devices so the last known position stays visible', () => {
    const position = devicePosition(telemetry({ online: false }))
    expect(position?.online).toBe(false)
    expect(position?.wgs84).toEqual({ latitude: 39.90869, longitude: 116.39740 })
  })

  it('drops unusable devices but keeps the rest', () => {
    const positions = devicePositions([
      telemetry(),
      telemetry({ sn: 'DOCK-2', osd: {} }),
      telemetry({ sn: 'DOCK-3', type: 'aircraft', osd: { latitude: 39.9, longitude: 116.4 } }),
    ])
    expect(positions.map((position) => position.sn)).toEqual(['DOCK-1', 'DOCK-3'])
  })
})
