import { describe, expect, it, vi } from 'vitest'
import type { ConnectionProfile, MqttMessageRecord } from '../../../shared/contracts'
import type { DeviceTelemetry } from './dji'
import {
  buildServicePayload,
  commandTransactions,
  discoveredAircraftForProfile,
  DJI_COMMANDS,
  DJI_PRODUCT_NAMES,
  extractTopicSn,
  groupDeviceActivities,
  isPayloadActivity,
  isSubscriptionActive,
  mergeTelemetry,
  parseDeviceActivity,
  parseServiceReply,
  refreshServicePayload,
  retainRecentMessages,
  serviceMethodFromPayload,
  subscriptionsForDevice,
  withLiveAircraftRelationships,
} from './dji'

describe('DJI protocol helpers', () => {
  it('extracts a device SN from DJI topics', () => {
    expect(extractTopicSn('thing/product/DOCK-001/osd')).toBe('DOCK-001')
    expect(extractTopicSn('sys/product/GATEWAY/status')).toBe('GATEWAY')
    expect(extractTopicSn('custom/topic')).toBeUndefined()
  })

  it('parses a device service reply for command waiters', () => {
    const record = {
      id: 'reply', profileId: 'p', direction: 'in', topic: 'thing/product/DOCK-1/services_reply',
      payload: JSON.stringify({ tid: 'tid-1', bid: 'bid-1', method: 'live_start_push', data: { result: 13003, output: 'old-stream' } }),
      qos: 1, retain: false, timestamp: 1, size: 1,
    } as MqttMessageRecord

    expect(parseServiceReply(record)).toEqual({
      gatewaySn: 'DOCK-1',
      tid: 'tid-1',
      bid: 'bid-1',
      method: 'live_start_push',
      result: 13003,
      output: 'old-stream',
    })
  })

  it('creates default subscriptions for a dock', () => {
    const subscriptions = subscriptionsForDevice({ id: '1', name: 'Dock', sn: 'DOCK-001', type: 'dock' })
    expect(subscriptions.map((item) => item.topic)).toContain('thing/product/DOCK-001/osd')
    expect(subscriptions.map((item) => item.topic)).toContain('thing/product/DOCK-001/services_reply')
  })

  it('uses different status topic roots for Dock and Pilot gateways', () => {
    const dockTopics = subscriptionsForDevice({ id: 'dock', name: 'Dock', sn: 'DOCK-001', type: 'dock' }).map((item) => item.topic)
    const pilotTopics = subscriptionsForDevice({ id: 'pilot', name: 'Pilot', sn: 'PILOT-001', type: 'pilot' }).map((item) => item.topic)

    expect(dockTopics).toContain('sys/product/DOCK-001/status')
    expect(pilotTopics).toContain('thing/product/PILOT-001/status')
    expect(pilotTopics).not.toContain('sys/product/PILOT-001/status')
  })

  it('uses the current official product enumeration', () => {
    expect(DJI_PRODUCT_NAMES['3-3-0']).toBe('DJI Dock 3')
    expect(DJI_PRODUCT_NAMES['0-100-0']).toBe('DJI Matrice 4D')
    expect(DJI_PRODUCT_NAMES['0-103-0']).toBe('DJI Matrice 400')
    expect(DJI_PRODUCT_NAMES['0-89-0']).toBe('DJI Matrice 350 RTK')
  })

  it('pauses device subscriptions when the device or its parent gateway is disabled', () => {
    const subscription = {
      id: 'air-osd', topic: 'thing/product/AIR-1/osd', qos: 0, enabled: true, source: 'dji',
    } as const
    const profile = {
      devices: [
        { id: 'dock', name: 'Dock', sn: 'DOCK-1', type: 'dock', enabled: false },
        { id: 'air', name: 'Aircraft', sn: 'AIR-1', type: 'aircraft', parentSn: 'DOCK-1', enabled: true },
      ],
    } as Pick<ConnectionProfile, 'devices'>

    expect(isSubscriptionActive(profile, subscription)).toBe(false)
    profile.devices[0].enabled = true
    expect(isSubscriptionActive(profile, subscription)).toBe(true)
    expect(isSubscriptionActive(profile, { ...subscription, enabled: false })).toBe(false)
  })

  it('adds live aircraft ownership to legacy device profiles', () => {
    const devices = [{ id: 'dock', name: 'Dock', sn: 'DOCK-1', type: 'dock', enabled: false }] satisfies ConnectionProfile['devices']
    const telemetry = [{
      profileId: 'profile', sn: 'AIR-1', gatewaySn: 'DOCK-1', type: 'aircraft', name: '已发现飞机',
      online: true, lastSeenAt: 1, lastTopic: 'thing/product/DOCK-1/osd', osd: {}, state: {}, status: {},
    }] satisfies DeviceTelemetry[]

    const merged = withLiveAircraftRelationships(devices, telemetry, () => 'air-id')
    expect(merged[1]).toMatchObject({ id: 'air-id', sn: 'AIR-1', parentSn: 'DOCK-1', enabled: true })
    expect(isSubscriptionActive({ devices: merged }, {
      id: 'air-osd', topic: 'thing/product/AIR-1/osd', qos: 0, enabled: true, source: 'dji',
    })).toBe(false)
  })

  it('limits discovered aircraft to the connection that reported them', () => {
    const aircraft = (profileId: string, sn: string, gatewaySn?: string): DeviceTelemetry => ({
      profileId,
      sn,
      gatewaySn,
      type: 'aircraft',
      name: '已发现飞机',
      online: true,
      lastSeenAt: 1,
      lastTopic: `thing/product/${sn}/osd`,
      osd: {},
      state: {},
      status: {},
    })

    const discoveries = discoveredAircraftForProfile([
      aircraft('test-profile', 'TEST-AIR', 'TEST-DOCK'),
      aircraft('production-profile', 'PRODUCTION-AIR', 'PRODUCTION-DOCK'),
      aircraft('production-profile', 'UNASSIGNED-AIR'),
    ], 'production-profile')

    expect(discoveries.map((item) => item.sn)).toEqual(['PRODUCTION-AIR'])
  })

  it('uses supported integer defaults in the takeoff template', () => {
    const takeoff = DJI_COMMANDS.find((command) => command.id === 'takeoff')
    expect(takeoff?.data).toMatchObject({ rth_mode: 1, flight_safety_advance_check: 1 })
    expect(typeof takeoff?.data.flight_safety_advance_check).toBe('number')
  })

  it('builds a DJI service envelope', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000)
    const payload = JSON.parse(buildServicePayload('cover_open', {})) as Record<string, unknown>
    expect(payload.method).toBe('cover_open')
    expect(payload.timestamp).toBe(1700000000000)
    expect(payload.tid).toBeTruthy()
    expect(payload.bid).toBeTruthy()
    vi.restoreAllMocks()
  })

  it('refreshes service transaction fields without losing edited command data', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000001000)
    const refreshedText = refreshServicePayload(JSON.stringify({
      tid: 'old-tid',
      bid: 'old-bid',
      timestamp: 1,
      method: 'cover_open',
      data: { custom: true },
    }))
    const refreshed = JSON.parse(refreshedText) as Record<string, unknown>

    expect(refreshed.tid).not.toBe('old-tid')
    expect(refreshed.bid).not.toBe('old-bid')
    expect(refreshed.timestamp).toBe(1700000001000)
    expect(refreshed.data).toEqual({ custom: true })
    expect(serviceMethodFromPayload(refreshedText)).toBe('cover_open')
    vi.restoreAllMocks()
  })

  it('classifies device activities by method before topic', () => {
    const record = {
      id: 'event', profileId: 'profile', direction: 'in', topic: 'thing/product/DOCK-1/requests',
      payload: JSON.stringify({ method: 'hms', data: {} }), qos: 1, retain: false, timestamp: 100, size: 1,
    } as MqttMessageRecord

    expect(parseDeviceActivity(record)).toMatchObject({
      method: 'hms', kind: 'event', label: '设备告警', knownMethod: true,
    })
  })

  it('distinguishes request methods and falls back only for unknown methods', () => {
    const base = {
      id: 'request', profileId: 'profile', direction: 'in', topic: 'thing/product/DOCK-1/events',
      qos: 1, retain: false, timestamp: 100, size: 1,
    } as MqttMessageRecord

    expect(parseDeviceActivity({
      ...base,
      payload: JSON.stringify({ method: 'storage_config_get', data: {} }),
    })).toMatchObject({ kind: 'request', label: '获取对象存储配置', knownMethod: true })
    expect(parseDeviceActivity({
      ...base,
      payload: JSON.stringify({ method: 'vendor_custom_event', data: {} }),
    })).toMatchObject({ kind: 'event', label: '未识别设备事件', knownMethod: false })
  })

  it('classifies payload activity by psdk_index without inspecting encrypted data', () => {
    const base = {
      id: 'payload-event', profileId: 'profile', direction: 'in', topic: 'thing/product/DOCK-1/events',
      qos: 1, retain: false, timestamp: 100, size: 1,
    } as MqttMessageRecord
    const photo = parseDeviceActivity({
      ...base,
      payload: JSON.stringify({ method: 'camera_photo_take_progress', data: {} }),
    })
    const vendorGimbal = parseDeviceActivity({
      ...base,
      payload: JSON.stringify({ method: 'vendor_gimbal_status_notify', data: {} }),
    })
    const psdk = parseDeviceActivity({
      ...base,
      payload: JSON.stringify({
        method: 'custom_data_transmission_from_psdk',
        data: { psdk_index: 2, value: 'ENC:AAECA/8=' },
      }),
    })
    const vendorPsdk = parseDeviceActivity({
      ...base,
      payload: JSON.stringify({ method: 'vendor_payload_notify', data: { psdk_index: 4, value: 'opaque' } }),
    })
    const psdkWithoutIndex = parseDeviceActivity({
      ...base,
      payload: JSON.stringify({ method: 'custom_data_transmission_from_psdk', data: { value: 'opaque' } }),
    })
    const hms = parseDeviceActivity({
      ...base,
      payload: JSON.stringify({ method: 'hms', data: {} }),
    })

    expect(photo && isPayloadActivity(photo)).toBe(false)
    expect(vendorGimbal && isPayloadActivity(vendorGimbal)).toBe(false)
    expect(psdk).toMatchObject({ psdkIndex: 2 })
    expect(psdk && isPayloadActivity(psdk)).toBe(true)
    expect(vendorPsdk).toMatchObject({ psdkIndex: 4 })
    expect(vendorPsdk && isPayloadActivity(vendorPsdk)).toBe(true)
    expect(psdkWithoutIndex && isPayloadActivity(psdkWithoutIndex)).toBe(false)
    expect(hms && isPayloadActivity(hms)).toBe(false)
  })

  it('recognizes PSDK monitoring data and UI button messages', () => {
    const base = {
      id: 'psdk-event', profileId: 'profile', direction: 'in', topic: 'thing/product/DOCK-1/events',
      qos: 1, retain: false, timestamp: 100, size: 1,
    } as MqttMessageRecord

    const monitoring = parseDeviceActivity({
      ...base,
      payload: JSON.stringify({ method: 'psdk_floating_window_text', data: { psdk_index: 1 } }),
    })
    const uiButton = parseDeviceActivity({
      ...base,
      id: 'psdk-ui-event',
      payload: JSON.stringify({ method: 'psdk_ui_resource_upload_result', data: { psdk_index: 1 } }),
    })

    expect(monitoring).toMatchObject({
      kind: 'event', label: 'PSDK 监测数据', knownMethod: true, psdkIndex: 1,
    })
    expect(uiButton).toMatchObject({
      kind: 'event', label: 'PSDK UI 按钮', knownMethod: true, psdkIndex: 1,
    })
    expect(monitoring && isPayloadActivity(monitoring)).toBe(true)
    expect(uiButton && isPayloadActivity(uiButton)).toBe(true)
  })

  it('groups device activities by kind and method with newest groups first', () => {
    const activity = (id: string, method: string, timestamp: number, topicKind: 'events' | 'requests' = 'events') =>
      parseDeviceActivity({
        id,
        profileId: 'profile',
        direction: 'in',
        topic: `thing/product/DOCK-1/${topicKind}`,
        payload: JSON.stringify({ method, data: {} }),
        qos: 1,
        retain: false,
        timestamp,
        size: 1,
      } as MqttMessageRecord)!

    const groups = groupDeviceActivities([
      activity('drc-old', 'drc_status_notify', 100),
      activity('hms', 'hms', 200),
      activity('drc-new', 'drc_status_notify', 300),
      activity('request', 'storage_config_get', 250, 'requests'),
    ])

    expect(groups.map((group) => [group.id, group.activities.map((item) => item.record.id)])).toEqual([
      ['event:drc_status_notify', ['drc-new', 'drc-old']],
      ['request:storage_config_get', ['request']],
      ['event:hms', ['hms']],
    ])
  })

  it('provides a PSDK custom-data downlink template', () => {
    expect(DJI_COMMANDS.find((command) => command.id === 'psdk-custom-data')).toMatchObject({
      category: 'psdk',
      method: 'custom_data_transmission_to_psdk',
      data: { psdk_index: 0, value: '' },
    })
  })

  it('does not treat payloads without a method as device activities', () => {
    const base = {
      id: 'invalid', profileId: 'profile', direction: 'in', topic: 'thing/product/DOCK-1/events',
      qos: 1, retain: false, timestamp: 100, size: 1,
    } as MqttMessageRecord

    expect(parseDeviceActivity({ ...base, payload: JSON.stringify({ data: {} }) })).toBeUndefined()
    expect(parseDeviceActivity({ ...base, payload: 'not-json' })).toBeUndefined()
    expect(parseDeviceActivity({ ...base, direction: 'out', payload: JSON.stringify({ method: 'hms' }) })).toBeUndefined()
    expect(parseDeviceActivity({
      ...base,
      topic: 'thing/product/DOCK-1/services_reply',
      payload: JSON.stringify({ method: 'cover_open', data: { result: 0 } }),
    })).toBeUndefined()
  })

  it('merges incremental OSD payloads and discovers an aircraft', () => {
    const profile = {
      id: 'profile',
      devices: [{ id: 'dock', name: 'Dock', sn: 'DOCK-1', type: 'dock' }],
    } as ConnectionProfile
    const base = {
      id: 'm1',
      profileId: 'profile',
      direction: 'in',
      topic: 'thing/product/DOCK-1/osd',
      qos: 0,
      retain: false,
      timestamp: 100,
      size: 10,
    } as MqttMessageRecord

    const first = mergeTelemetry({}, profile, {
      ...base,
      payload: JSON.stringify({
        data: {
          temperature: 22,
          battery: { capacity_percent: 90, voltage: 48 },
          sub_device: {
            device_sn: 'AIR-1',
            latitude: 31.2,
            longitude: 121.5,
            battery: { capacity_percent: 90 },
          },
        },
      }),
    })
    const second = mergeTelemetry(first, profile, {
      ...base,
      id: 'm2',
      timestamp: 200,
      payload: JSON.stringify({ data: { humidity: 48, battery: { capacity_percent: 80 } } }),
    })

    expect(second['profile:DOCK-1'].osd).toMatchObject({ temperature: 22, humidity: 48 })
    expect(second['profile:DOCK-1'].osd.battery).toEqual({ capacity_percent: 80, voltage: 48 })
    expect(second['profile:AIR-1'].gatewaySn).toBe('DOCK-1')
    expect(second['profile:AIR-1'].osd).toMatchObject({
      latitude: 31.2,
      longitude: 121.5,
      battery: { capacity_percent: 90 },
    })
    expect(second['profile:AIR-1'].status).toEqual({})
  })

  it('keeps discovered aircraft OSD, state and status data in separate sections', () => {
    const profile = { id: 'profile', devices: [] } as unknown as ConnectionProfile
    const message = {
      id: 'child',
      profileId: 'profile',
      direction: 'in',
      qos: 0,
      retain: false,
      timestamp: 100,
      size: 1,
    } as MqttMessageRecord

    const withOsd = mergeTelemetry({}, profile, {
      ...message,
      topic: 'thing/product/DOCK-1/osd',
      payload: JSON.stringify({ data: { sub_device: { device_sn: 'AIR-1', horizontal_speed: 4.5 } } }),
    })
    const withState = mergeTelemetry(withOsd, profile, {
      ...message,
      topic: 'thing/product/DOCK-1/state',
      payload: JSON.stringify({ data: { sub_device: { device_sn: 'AIR-1', mode_code: 2 } } }),
    })
    const withStatus = mergeTelemetry(withState, profile, {
      ...message,
      topic: 'sys/product/DOCK-1/status',
      payload: JSON.stringify({
        method: 'update_topo',
        data: {
          domain: '3', type: 3, sub_type: 0, thing_version: '1.2.0',
          device_secret: 'dock-secret', nonce: 'dock-nonce',
          sub_devices: [{
            sn: 'AIR-1', domain: '0', type: 100, sub_type: 1, index: 'A', thing_version: '1.3.0',
            device_online_status: 1, device_secret: 'air-secret', nonce: 'air-nonce',
          }],
        },
      }),
    })

    expect(withStatus['profile:DOCK-1']).toMatchObject({
      identity: { domain: '3', productType: 3, productSubType: 0, thingVersion: '1.2.0' },
    })
    expect(withStatus['profile:DOCK-1'].status).not.toHaveProperty('device_secret')
    expect(withStatus['profile:DOCK-1'].status).not.toHaveProperty('nonce')
    expect(withStatus['profile:DOCK-1'].status).not.toHaveProperty('sub_devices')
    expect(withStatus['profile:AIR-1']).toMatchObject({
      name: 'DJI Matrice 4TD',
      identity: {
        domain: '0', productType: 100, productSubType: 1, channelIndex: 'A', thingVersion: '1.3.0',
      },
      osd: { device_sn: 'AIR-1', horizontal_speed: 4.5 },
      state: { device_sn: 'AIR-1', mode_code: 2 },
      status: { sn: 'AIR-1', device_online_status: 1 },
    })
    expect(JSON.stringify(withStatus)).not.toContain('dock-secret')
    expect(JSON.stringify(withStatus)).not.toContain('air-secret')
  })

  it('only changes device topology for update_topo and marks omitted aircraft offline', () => {
    const profile = { id: 'profile', devices: [] } as unknown as ConnectionProfile
    const message = {
      id: 'status', profileId: 'profile', direction: 'in', topic: 'sys/product/DOCK-1/status',
      qos: 1, retain: false, timestamp: 100, size: 1,
    } as MqttMessageRecord
    const ignored = mergeTelemetry({}, profile, {
      ...message,
      payload: JSON.stringify({ method: 'other_status', data: { sub_devices: [{ sn: 'AIR-1' }] } }),
    })
    expect(ignored['profile:AIR-1']).toBeUndefined()

    const online = mergeTelemetry(ignored, profile, {
      ...message,
      timestamp: 200,
      payload: JSON.stringify({
        method: 'update_topo',
        data: { domain: '3', type: 3, sub_type: 0, sub_devices: [{ sn: 'AIR-1', domain: '0', type: 100, sub_type: 0 }] },
      }),
    })
    const offline = mergeTelemetry(online, profile, {
      ...message,
      timestamp: 300,
      payload: JSON.stringify({
        method: 'update_topo',
        data: { domain: '3', type: 3, sub_type: 0, sub_devices: [] },
      }),
    })

    expect(online['profile:AIR-1'].online).toBe(true)
    expect(offline['profile:AIR-1'].online).toBe(false)
    expect(offline['profile:AIR-1'].lastSeenAt).toBe(200)
  })

  it('moves aircraft data reported by a dock onto the related aircraft', () => {
    const profile = {
      id: 'profile',
      devices: [{ id: 'dock', name: 'Dock', sn: 'DOCK-1', type: 'dock' }],
    } as ConnectionProfile
    const message = {
      id: 'relay',
      profileId: 'profile',
      direction: 'in',
      topic: 'thing/product/DOCK-1/osd',
      qos: 0,
      retain: false,
      timestamp: 100,
      size: 1,
      payload: JSON.stringify({
        gateway: 'DOCK-1',
        data: {
          temperature: 32,
          sub_device: {
            device_sn: 'AIR-1',
            device_model_key: '0-91-1',
            device_online_status: 1,
          },
          drone_charge_state: { state: 1, capacity_percent: 57 },
          drone_battery_maintenance_info: {
            maintenance_state: 0,
            batteries: [{ index: 0, capacity_percent: 57 }],
          },
        },
      }),
    } as MqttMessageRecord

    const result = mergeTelemetry({}, profile, message)

    expect(result['profile:DOCK-1'].osd).toEqual({ temperature: 32 })
    expect(result['profile:AIR-1']).toMatchObject({
      gatewaySn: 'DOCK-1',
      type: 'aircraft',
      osd: {
        device_sn: 'AIR-1',
        device_model_key: '0-91-1',
        device_online_status: 1,
        drone_charge_state: { state: 1, capacity_percent: 57 },
        drone_battery_maintenance_info: {
          maintenance_state: 0,
          batteries: [{ index: 0, capacity_percent: 57 }],
        },
      },
    })
  })

  it('uses the payload gateway to relate direct aircraft telemetry to its dock', () => {
    const profile = { id: 'profile', devices: [] } as unknown as ConnectionProfile
    const result = mergeTelemetry({}, profile, {
      id: 'aircraft',
      profileId: 'profile',
      direction: 'in',
      topic: 'thing/product/AIR-1/osd',
      qos: 0,
      retain: false,
      timestamp: 100,
      size: 1,
      payload: JSON.stringify({ gateway: 'DOCK-1', data: { horizontal_speed: 4.5 } }),
    })

    expect(result['profile:AIR-1']).toMatchObject({
      type: 'aircraft',
      gatewaySn: 'DOCK-1',
      osd: { horizontal_speed: 4.5 },
    })
  })

  it('ignores valid non-object JSON telemetry payloads', () => {
    const profile = { id: 'profile', devices: [] } as unknown as ConnectionProfile
    const current = {} as Record<string, ReturnType<typeof mergeTelemetry>[string]>
    const base = {
      id: 'm1',
      profileId: 'profile',
      direction: 'in',
      topic: 'thing/product/DOCK-1/osd',
      qos: 0,
      retain: false,
      timestamp: 100,
      size: 4,
    } as MqttMessageRecord

    expect(mergeTelemetry(current, profile, { ...base, payload: 'null' })).toBe(current)
    expect(mergeTelemetry(current, profile, { ...base, payload: '[]' })).toBe(current)
  })

  it('corrects an unconfigured gateway to dock after its sys status arrives', () => {
    const profile = { id: 'profile', devices: [] } as unknown as ConnectionProfile
    const first = mergeTelemetry({}, profile, {
      id: 'thing',
      profileId: 'profile',
      direction: 'in',
      topic: 'thing/product/DOCK-1/osd',
      payload: JSON.stringify({ data: { temperature: 22 } }),
      qos: 0,
      retain: false,
      timestamp: 100,
      size: 1,
    })
    const second = mergeTelemetry(first, profile, {
      id: 'sys',
      profileId: 'profile',
      direction: 'in',
      topic: 'sys/product/DOCK-1/status',
      payload: JSON.stringify({ data: { online_status: 1 } }),
      qos: 1,
      retain: false,
      timestamp: 200,
      size: 1,
    })

    expect(first['profile:DOCK-1'].type).toBe('aircraft')
    expect(second['profile:DOCK-1'].type).toBe('dock')
  })

  it('retains newest messages within count and byte limits', () => {
    const records = [1, 2, 3].map((value) => ({
      id: String(value),
      profileId: 'p',
      direction: 'in',
      topic: 'test',
      payload: String(value),
      qos: 0,
      retain: false,
      timestamp: value,
      size: 4,
    })) as MqttMessageRecord[]

    expect(retainRecentMessages(records, 10, 8).map((record) => record.id)).toEqual(['2', '3'])
    expect(retainRecentMessages(records, 1, 100).map((record) => record.id)).toEqual(['3'])
  })

  it('correlates service replies by tid', () => {
    const records = [
      {
        id: 'out',
        profileId: 'p',
        direction: 'out',
        topic: 'thing/product/D1/services',
        payload: JSON.stringify({ tid: 'tid-1', bid: 'bid-1', method: 'cover_open', data: {} }),
        qos: 1,
        retain: false,
        timestamp: 100,
        size: 1,
      },
      {
        id: 'in',
        profileId: 'p',
        direction: 'in',
        topic: 'thing/product/D1/services_reply',
        payload: JSON.stringify({ tid: 'tid-1', data: { result: 0 } }),
        qos: 1,
        retain: false,
        timestamp: 150,
        size: 1,
      },
    ] as MqttMessageRecord[]

    expect(commandTransactions(records, 200)[0]).toMatchObject({
      method: 'cover_open',
      status: 'success',
      result: 0,
      request: { id: 'out' },
      response: { id: 'in' },
    })
  })

  it('does not associate a reply from another gateway or bid', () => {
    const records = [
      {
        id: 'out', profileId: 'p', direction: 'out', topic: 'thing/product/D1/services',
        payload: JSON.stringify({ tid: 'tid-1', bid: 'bid-1', method: 'cover_open', data: {} }),
        qos: 1, retain: false, timestamp: 100, size: 1,
      },
      {
        id: 'wrong-gateway', profileId: 'p', direction: 'in', topic: 'thing/product/D2/services_reply',
        payload: JSON.stringify({ tid: 'tid-1', bid: 'bid-1', data: { result: 0 } }),
        qos: 1, retain: false, timestamp: 120, size: 1,
      },
      {
        id: 'wrong-bid', profileId: 'p', direction: 'in', topic: 'thing/product/D1/services_reply',
        payload: JSON.stringify({ tid: 'tid-1', bid: 'bid-2', data: { result: 0 } }),
        qos: 1, retain: false, timestamp: 130, size: 1,
      },
    ] as MqttMessageRecord[]

    expect(commandTransactions(records, 200)[0]).toMatchObject({ gatewaySn: 'D1', status: 'pending' })
  })
})
