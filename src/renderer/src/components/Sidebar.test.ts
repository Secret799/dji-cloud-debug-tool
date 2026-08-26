import { describe, expect, it } from 'vitest'
import type { ConnectionProfile, DjiDevice, TopicSubscription } from '../../../shared/contracts'
import type { DeviceTelemetry } from '../lib/dji'
import { aircraftPowerState, devicesForTree, subscriptionsByParentDevice } from './Sidebar'

const device = (sn: string, name: string, type: DjiDevice['type'], parentSn?: string): DjiDevice => ({
  id: sn,
  name,
  sn,
  type,
  parentSn,
})

const runtime = (sn: string, type: DjiDevice['type'], gatewaySn?: string): DeviceTelemetry => ({
  profileId: 'profile',
  sn,
  gatewaySn,
  type,
  name: type === 'aircraft' ? `已发现飞机 ${sn}` : `已发现机场 ${sn}`,
  online: true,
  lastSeenAt: 100,
  lastTopic: `thing/product/${sn}/osd`,
  osd: {},
  state: {},
  status: {},
})

const profile = (devices: DjiDevice[]): ConnectionProfile => ({
  id: 'profile',
  devices,
} as ConnectionProfile)

describe('devicesForTree', () => {
  it('places each discovered aircraft directly after its own airport', () => {
    const result = devicesForTree(
      profile([
        device('DOCK-B', '机场 B', 'dock'),
        device('DOCK-A', '机场 A', 'dock'),
      ]),
      [
        runtime('AIR-B', 'aircraft', 'DOCK-B'),
        runtime('AIR-A', 'aircraft', 'DOCK-A'),
      ],
    )

    expect(result.map(({ sn, parentSn }) => [sn, parentSn])).toEqual([
      ['DOCK-A', undefined],
      ['AIR-A', 'DOCK-A'],
      ['DOCK-B', undefined],
      ['AIR-B', 'DOCK-B'],
    ])
  })

  it('uses live gateway ownership for an already configured aircraft', () => {
    const result = devicesForTree(
      profile([
        device('DOCK-A', '机场 A', 'dock'),
        device('DOCK-B', '机场 B', 'dock'),
        device('AIR-1', '巡检飞机', 'aircraft', 'DOCK-A'),
      ]),
      [runtime('AIR-1', 'aircraft', 'DOCK-B')],
    )

    expect(result.map(({ sn }) => sn)).toEqual(['DOCK-A', 'DOCK-B', 'AIR-1'])
    expect(result[2].parentSn).toBe('DOCK-B')
  })

  it('keeps an aircraft at root when its gateway is unknown', () => {
    const result = devicesForTree(
      profile([device('DOCK-A', '机场 A', 'dock')]),
      [runtime('AIR-1', 'aircraft', 'MISSING-DOCK')],
    )

    expect(result.map(({ sn }) => sn)).toEqual(['DOCK-A', 'AIR-1'])
    expect(result[1].parentSn).toBeUndefined()
  })
})

describe('aircraftPowerState', () => {
  it('reads the aircraft power state from telemetry sections', () => {
    expect(aircraftPowerState({
      ...runtime('AIR-1', 'aircraft'),
      osd: { device_online_status: 1 },
    })).toBe('on')
    expect(aircraftPowerState({
      ...runtime('AIR-1', 'aircraft'),
      state: { device_online_status: '0' },
    })).toBe('off')
  })

  it('returns unknown when the aircraft has not reported a valid power state', () => {
    expect(aircraftPowerState(runtime('AIR-1', 'aircraft'))).toBe('unknown')
    expect(aircraftPowerState(undefined)).toBe('unknown')
  })
})

describe('subscriptionsByParentDevice', () => {
  it('groups gateway and child-aircraft topics under the parent gateway', () => {
    const devices = [
      device('DOCK-A', '机场 A', 'dock'),
      device('AIR-A', '飞机 A', 'aircraft', 'DOCK-A'),
      device('DOCK-B', '机场 B', 'dock'),
    ]
    const subscriptions = [
      { id: 'dock-a', topic: 'thing/product/DOCK-A/osd', qos: 0, enabled: true, source: 'dji' },
      { id: 'air-a', topic: 'thing/product/AIR-A/osd', qos: 0, enabled: true, source: 'dji' },
      { id: 'dock-b', topic: 'sys/product/DOCK-B/status', qos: 1, enabled: true, source: 'dji' },
      { id: 'custom', topic: 'custom/debug', qos: 0, enabled: true, source: 'custom' },
    ] satisfies TopicSubscription[]

    const groups = subscriptionsByParentDevice({
      ...profile(devices),
      subscriptions,
    }, devices)

    expect(groups.map((group) => [group.label, group.subscriptions.map((item) => item.id)])).toEqual([
      ['机场 A', ['dock-a', 'air-a']],
      ['机场 B', ['dock-b']],
      ['其他订阅', ['custom']],
    ])
  })

  it('removes topics owned by disabled devices and drops empty groups', () => {
    const devices = [
      { ...device('DOCK-A', '机场 A', 'dock'), enabled: false },
      device('AIR-A', '飞机 A', 'aircraft', 'DOCK-A'),
      device('DOCK-B', '机场 B', 'dock'),
    ]
    const subscriptions = [
      { id: 'dock-a', topic: 'thing/product/DOCK-A/osd', qos: 0, enabled: true, source: 'dji' },
      { id: 'air-a', topic: 'thing/product/AIR-A/osd', qos: 0, enabled: true, source: 'dji' },
      { id: 'dock-b', topic: 'sys/product/DOCK-B/status', qos: 1, enabled: true, source: 'dji' },
      { id: 'custom', topic: 'custom/debug', qos: 0, enabled: true, source: 'custom' },
    ] satisfies TopicSubscription[]

    const groups = subscriptionsByParentDevice({
      ...profile(devices),
      subscriptions,
    }, devices)

    expect(groups.map((group) => [group.label, group.subscriptions.map((item) => item.id)])).toEqual([
      ['机场 B', ['dock-b']],
      ['其他订阅', ['custom']],
    ])
  })
})
