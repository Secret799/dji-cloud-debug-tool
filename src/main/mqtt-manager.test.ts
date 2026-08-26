import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionProfile, MqttRuntimeEvent } from '../shared/contracts'
import { MAX_MQTT_PAYLOAD_BYTES } from '../shared/limits'

const mqttMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  readFile: vi.fn(),
}))

vi.mock('mqtt', () => ({
  default: { connect: mqttMocks.connect },
  ReasonCodes: {
    128: 'Unspecified error',
    135: 'Not authorized',
  },
}))

vi.mock('node:fs/promises', () => ({
  readFile: mqttMocks.readFile,
}))

import { MqttConnectionManager } from './mqtt-manager'

class FakeMqttClient extends EventEmitter {
  connected = true
  stream = { destroy: vi.fn() }
  end = vi.fn((_force: boolean, _options: object, callback: (error?: Error) => void) => callback())
  publish = vi.fn()
  subscribe = vi.fn()
  unsubscribe = vi.fn()
}

const createProfile = (): ConnectionProfile => ({
  id: 'profile-1',
  name: 'Test',
  protocol: 'mqtt',
  host: 'localhost',
  port: 1883,
  path: '/mqtt',
  clientId: 'client-1',
  username: '',
  password: '',
  mqttVersion: '5.0',
  clean: true,
  keepalive: 60,
  connectTimeout: 10,
  reconnectPeriod: 3,
  rejectUnauthorized: true,
  caPath: '',
  certPath: '',
  keyPath: '',
  devices: [],
  subscriptions: [],
  createdAt: 1,
  updatedAt: 1,
})

describe('MqttConnectionManager', () => {
  beforeEach(() => {
    mqttMocks.connect.mockReset()
    mqttMocks.readFile.mockReset()
    mqttMocks.readFile.mockResolvedValue(Buffer.from('certificate'))
  })

  it('serializes concurrent connect calls for the same profile', async () => {
    let releaseRead!: (value: Buffer) => void
    const firstRead = new Promise<Buffer>((resolve) => {
      releaseRead = resolve
    })
    mqttMocks.readFile.mockReturnValueOnce(firstRead)
    mqttMocks.connect.mockImplementation(() => new FakeMqttClient())
    const manager = new MqttConnectionManager(() => undefined)
    const profile = { ...createProfile(), caPath: '/tmp/ca.pem' }

    const first = manager.connect(profile, '')
    await vi.waitFor(() => expect(mqttMocks.readFile).toHaveBeenCalledTimes(1))
    const second = manager.connect(profile, '')
    await Promise.resolve()

    expect(mqttMocks.readFile).toHaveBeenCalledTimes(1)
    expect(mqttMocks.connect).not.toHaveBeenCalled()

    releaseRead(Buffer.from('certificate'))
    await Promise.all([first, second])
    expect(mqttMocks.connect).toHaveBeenCalledTimes(2)
  })

  it('normalizes a pasted broker URL before applying the selected protocol and port', async () => {
    mqttMocks.connect.mockReturnValue(new FakeMqttClient())
    const manager = new MqttConnectionManager(() => undefined)

    await manager.connect({
      ...createProfile(),
      protocol: 'wss',
      host: 'mqtt://broker.example.com:1883/ignored-path',
      port: 8084,
      path: 'mqtt',
    }, '')

    expect(mqttMocks.connect).toHaveBeenCalledWith(
      'wss://broker.example.com:8084/mqtt',
      expect.any(Object),
    )
  })

  it('exposes the latest connection status for a renderer reload', async () => {
    const client = new FakeMqttClient()
    mqttMocks.connect.mockReturnValue(client)
    const manager = new MqttConnectionManager(() => undefined)

    await manager.connect(createProfile(), '')
    expect(manager.getRuntime()).toEqual([
      expect.objectContaining({ profileId: 'profile-1', status: 'connecting' }),
    ])

    client.emit('connect')
    expect(manager.getRuntime()).toEqual([
      expect.objectContaining({ profileId: 'profile-1', status: 'connected' }),
    ])
  })

  it('returns a failure for MQTT 5 SUBACK and UNSUBACK rejection codes', async () => {
    const client = new FakeMqttClient()
    client.subscribe.mockImplementation((_topic, _options, callback) => {
      callback(null, [{ topic: 'restricted/topic', qos: 128 }], { cmd: 'suback', granted: [135] })
    })
    client.unsubscribe.mockImplementation((_topic, callback) => {
      callback(null, { cmd: 'unsuback', granted: [135] })
    })
    mqttMocks.connect.mockReturnValue(client)
    const events: MqttRuntimeEvent[] = []
    const manager = new MqttConnectionManager((event) => events.push(event))
    await manager.connect(createProfile(), '')

    const subscribe = await manager.subscribe('profile-1', 'restricted/topic', 1)
    const unsubscribe = await manager.unsubscribe('profile-1', 'restricted/topic')

    expect(subscribe).toEqual({ ok: false, error: expect.stringContaining('Not authorized') })
    expect(unsubscribe).toEqual({ ok: false, error: expect.stringContaining('Not authorized') })
    expect(events.filter((event) => event.type === 'subscription')).toEqual([
      expect.objectContaining({ subscribed: false, error: expect.stringContaining('Not authorized') }),
      expect.objectContaining({ subscribed: true, error: expect.stringContaining('Not authorized') }),
    ])
  })

  it('accepts an MQTT 3 UNSUBACK without reason codes', async () => {
    const client = new FakeMqttClient()
    client.unsubscribe.mockImplementation((_topic, callback) => {
      callback(null, { cmd: 'unsuback' })
    })
    mqttMocks.connect.mockReturnValue(client)
    const events: MqttRuntimeEvent[] = []
    const manager = new MqttConnectionManager((event) => events.push(event))
    await manager.connect({ ...createProfile(), mqttVersion: '3.1.1' }, '')

    await expect(manager.unsubscribe('profile-1', 'custom/topic')).resolves.toEqual({ ok: true })
    expect(events).toContainEqual(expect.objectContaining({
      type: 'subscription',
      topic: 'custom/topic',
      subscribed: false,
      error: undefined,
    }))
  })

  it('rejects oversized outbound payloads and disconnects on oversized inbound payloads', async () => {
    const client = new FakeMqttClient()
    mqttMocks.connect.mockReturnValue(client)
    const events: MqttRuntimeEvent[] = []
    const manager = new MqttConnectionManager((event) => events.push(event))
    await manager.connect(createProfile(), '')
    const oversized = 'x'.repeat(MAX_MQTT_PAYLOAD_BYTES + 1)

    const publish = await manager.publish({
      profileId: 'profile-1',
      topic: 'test/topic',
      payload: oversized,
      qos: 0,
      retain: false,
    })
    client.emit('message', 'test/topic', Buffer.from(oversized), {
      qos: 0,
      retain: false,
      dup: false,
    })
    await vi.waitFor(() => expect(client.end).toHaveBeenCalled())

    expect(publish).toEqual({ ok: false, error: expect.stringContaining('1 MiB') })
    expect(client.publish).not.toHaveBeenCalled()
    expect(events.some((event) => event.type === 'message')).toBe(false)
    expect(events).toContainEqual(expect.objectContaining({ type: 'status', status: 'error', detail: expect.stringContaining('1 MiB') }))
  })
})
