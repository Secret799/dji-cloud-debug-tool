import { Duplex } from 'node:stream'
import { MqttClient, type IClientOptions } from 'mqtt'
import { generate, parser, type Packet, type IPublishPacket } from 'mqtt-packet'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MqttMessageRecord } from '../shared/contracts'
import { commandTransactions, createProfile } from '../renderer/src/lib/dji'

const transport = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock('mqtt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('mqtt')>()
  return { ...actual, default: { ...actual.default, connect: transport.connect } }
})

import { MqttConnectionManager } from './mqtt-manager'

type SendPacket = (packet: Packet) => void
const brokerStream = (
  onPublish: (packet: IPublishPacket, stream: Duplex, send: SendPacket) => void,
): Duplex => {
  const decoder = parser()
  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      decoder.parse(chunk)
      callback()
    },
  })
  const send: SendPacket = (packet) => {
    if (!stream.destroyed) stream.push(generate(packet))
  }
  decoder.on('packet', (packet: Packet) => {
    if (packet.cmd === 'connect') setImmediate(() => send({ cmd: 'connack', returnCode: 0, sessionPresent: false }))
    if (packet.cmd === 'publish') onPublish(packet, stream, send)
    if (packet.cmd === 'disconnect') setImmediate(() => stream.push(null))
    if (packet.cmd === 'pingreq') setImmediate(() => send({ cmd: 'pingresp' }))
  })
  return stream
}

const deadline = async <T>(operation: Promise<T>, milliseconds = 1_500): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Operation did not finish within ${milliseconds} ms`)), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

describe('MqttConnectionManager with real mqtt.js and in-memory transport', () => {
  beforeEach(() => { transport.connect.mockReset() })

  it.each([true, false])('cancels lost PUBACK promptly and never replays on automatic reconnect (clean=%s)', async (clean) => {
    let client!: MqttClient
    let connections = 0
    const deliveries: Array<{ connection: number; payload: string }> = []
    transport.connect.mockImplementation((_url: string, options: IClientOptions) => {
      client = new MqttClient(() => {
        const connection = ++connections
        return brokerStream((packet, stream, send) => {
          deliveries.push({ connection, payload: packet.payload.toString() })
          if (connection === 1) setImmediate(() => stream.destroy())
          else setImmediate(() => send({ cmd: 'puback', messageId: packet.messageId! }))
        })
      }, options)
      return client
    })
    const profile = { ...createProfile(), mqttVersion: '3.1.1' as const, clean, reconnectPeriod: 0.05 }
    const manager = new MqttConnectionManager(() => undefined)
    const payload = JSON.stringify({ method: 'takeoff_to_point', tid: 'cancelled', data: {} })
    try {
      await manager.connect(profile, '')
      await deadline(new Promise<void>((resolve) => client.once('connect', () => resolve())))
      const reconnected = new Promise<void>((resolve) => client.once('connect', () => resolve()))
      const publication = manager.publish({ profileId: profile.id, topic: 'thing/product/D/services', payload, qos: 1, retain: false })

      await expect(deadline(publication, 500)).resolves.toMatchObject({ ok: false })
      await deadline(reconnected)
      expect(connections).toBe(2)
      const currentConnection = connections
      const freshPayload = JSON.stringify({ method: 'device_reboot', tid: 'fresh', data: {} })
      await expect(deadline(manager.publish({ profileId: profile.id, topic: 'thing/product/D/services', payload: freshPayload, qos: 1, retain: false }))).resolves.toEqual({ ok: true })
      expect(deliveries).toEqual([
        { connection: 1, payload },
        { connection: currentConnection, payload: freshPayload },
      ])
      expect(Object.keys(client.outgoing)).toHaveLength(0)
    } finally {
      if (client && !client.disconnecting) await deadline(client.endAsync(true))
      await manager.disconnectAll()
    }
  }, 8_000)

  it('correlates a successful services reply received before PUBACK with ordered timestamps', async () => {
    let client!: MqttClient
    let ackTimer: ReturnType<typeof setTimeout> | undefined
    const records: MqttMessageRecord[] = []
    transport.connect.mockImplementation((_url: string, options: IClientOptions) => {
      client = new MqttClient(() => brokerStream((packet, _stream, send) => {
        const request = JSON.parse(packet.payload.toString()) as Record<string, unknown>
        setImmediate(() => {
          send({ cmd: 'publish', qos: 0, retain: false, dup: false, topic: 'thing/product/D/services_reply', payload: JSON.stringify({ ...request, data: { result: 0 } }) })
          ackTimer = setTimeout(() => send({ cmd: 'puback', messageId: packet.messageId! }), 25)
        })
      }), options)
      return client
    })
    const manager = new MqttConnectionManager((event) => {
      if (event.type === 'message') records.push(event.message)
    })
    const profile = { ...createProfile(), mqttVersion: '3.1.1' as const, reconnectPeriod: 0 }
    try {
      await manager.connect(profile, '')
      await deadline(new Promise<void>((resolve) => client.once('connect', () => resolve())))
      const result = await deadline(manager.publish({
        profileId: profile.id, topic: 'thing/product/D/services', qos: 1, retain: false,
        payload: JSON.stringify({ tid: 'early', bid: 'early-bid', method: 'device_reboot', data: {} }),
      }))
      expect(result).toEqual({ ok: true })
      expect(records.map((record) => record.direction)).toEqual(['in', 'out'])
      const transactions = commandTransactions(records, Date.now() + 11_000)
      expect(transactions).toHaveLength(1)
      expect(transactions[0]).toMatchObject({ status: 'success', result: 0, response: records[0], request: records[1] })
      expect(transactions[0].startedAt).toBeLessThanOrEqual(transactions[0].finishedAt!)
    } finally {
      clearTimeout(ackTimer)
      await manager.disconnectAll()
    }
  })
})
