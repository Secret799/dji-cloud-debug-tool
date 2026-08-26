import { readFile } from 'node:fs/promises'
import mqtt, { ReasonCodes, type IClientOptions, type MqttClient } from 'mqtt'
import type {
  ConnectionProfile,
  ConnectionStatus,
  MqttConnectionRuntime,
  MqttQos,
  MqttRuntimeEvent,
  OperationResult,
  PublishRequest,
} from '../shared/contracts'
import { MAX_MQTT_PAYLOAD_BYTES } from '../shared/limits'

interface ActiveConnection {
  profile: ConnectionProfile
  client: MqttClient
  generation: string
}

type EventSink = (event: MqttRuntimeEvent) => void

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const DISCONNECT_TIMEOUT_MS = 5_000
const reasonCodes = ReasonCodes as Record<number, string | undefined>

const rejectionMessage = (operation: string, code: number): string => {
  const reason = reasonCodes[code] || 'Unknown reason'
  return `${operation}被 Broker 拒绝：${reason} (0x${code.toString(16).padStart(2, '0')})`
}

export class MqttConnectionManager {
  private readonly connections = new Map<string, ActiveConnection>()
  private readonly operationQueues = new Map<string, Promise<void>>()
  private readonly runtimes = new Map<string, MqttConnectionRuntime>()

  constructor(private readonly eventSink: EventSink) {}

  getRuntime(): MqttConnectionRuntime[] {
    return [...this.runtimes.values()].map((runtime) => ({ ...runtime }))
  }

  async connect(profile: ConnectionProfile, password: string): Promise<OperationResult> {
    return this.runProfileOperation(profile.id, () => this.connectCurrent(profile, password))
  }

  private async connectCurrent(profile: ConnectionProfile, password: string): Promise<OperationResult> {
    await this.disconnectCurrent(profile.id)
    this.emitStatus(profile.id, 'connecting')

    try {
      const options = await this.buildOptions(profile, password)
      const url = this.buildUrl(profile)
      const client = mqtt.connect(url, options)
      const generation = crypto.randomUUID()
      this.connections.set(profile.id, { profile, client, generation })

      client.on('connect', () => this.isCurrent(profile.id, generation) && this.emitStatus(profile.id, 'connected'))
      client.on('reconnect', () => this.isCurrent(profile.id, generation) && this.emitStatus(profile.id, 'reconnecting'))
      client.on('offline', () => this.isCurrent(profile.id, generation) && this.emitStatus(profile.id, 'offline'))
      client.on('close', () => this.isCurrent(profile.id, generation) && this.emitStatus(profile.id, 'disconnected'))
      client.on('error', (error) => this.isCurrent(profile.id, generation) && this.emitStatus(profile.id, 'error', error.message))
      client.on('message', (topic, payload, packet) => {
        if (!this.isCurrent(profile.id, generation)) return
        if (payload.byteLength > MAX_MQTT_PAYLOAD_BYTES) {
          const detail = `收到的 MQTT Payload 为 ${payload.byteLength.toLocaleString()} 字节，超过 1 MiB 限制，连接已断开`
          this.emitStatus(profile.id, 'error', detail)
          void this.disconnect(profile.id)
          return
        }
        const properties = packet.properties ? JSON.parse(JSON.stringify(packet.properties)) : undefined
        this.eventSink({
          type: 'message',
          profileId: profile.id,
          message: {
            id: crypto.randomUUID(),
            profileId: profile.id,
            direction: 'in',
            topic,
            payload: payload.toString('utf8'),
            qos: packet.qos,
            retain: packet.retain,
            duplicate: packet.dup,
            timestamp: Date.now(),
            size: payload.byteLength,
            properties,
          },
        })
      })

      return { ok: true }
    } catch (error) {
      const detail = errorMessage(error)
      this.emitStatus(profile.id, 'error', detail)
      return { ok: false, error: detail }
    }
  }

  async disconnect(profileId: string): Promise<OperationResult> {
    return this.runProfileOperation(profileId, () => this.disconnectCurrent(profileId))
  }

  private async disconnectCurrent(profileId: string): Promise<OperationResult> {
    const active = this.connections.get(profileId)
    if (!active) return { ok: true }
    this.connections.delete(profileId)

    return new Promise((resolve) => {
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.emitStatus(profileId, 'disconnected')
        resolve(error ? { ok: false, error: error.message } : { ok: true })
      }
      const timer = setTimeout(() => {
        try {
          active.client.stream.destroy()
        } catch (error) {
          console.warn(`Unable to force-close MQTT connection ${profileId}:`, error)
        }
        finish(new Error('MQTT 连接在 5 秒内未能正常断开，已强制关闭'))
      }, DISCONNECT_TIMEOUT_MS)

      try {
        active.client.end(false, {}, (error) => finish(error))
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async publish(request: PublishRequest): Promise<OperationResult> {
    const active = this.connections.get(request.profileId)
    if (!active?.client.connected) return { ok: false, error: '当前连接尚未就绪' }
    if (!request.topic.trim() || /[+#]/.test(request.topic)) {
      return { ok: false, error: '发布 Topic 不能为空，且不能包含 + 或 # 通配符' }
    }
    if (Buffer.byteLength(request.payload, 'utf8') > MAX_MQTT_PAYLOAD_BYTES) {
      return { ok: false, error: '发布 Payload 超过 1 MiB 限制' }
    }

    return new Promise((resolve) => {
      active.client.publish(
        request.topic.trim(),
        request.payload,
        { qos: request.qos, retain: request.retain },
        (error) => {
          if (error) {
            resolve({ ok: false, error: error.message })
            return
          }
          const payloadSize = Buffer.byteLength(request.payload)
          this.eventSink({
            type: 'message',
            profileId: request.profileId,
            message: {
              id: crypto.randomUUID(),
              profileId: request.profileId,
              direction: 'out',
              topic: request.topic.trim(),
              payload: request.payload,
              qos: request.qos,
              retain: request.retain,
              timestamp: Date.now(),
              size: payloadSize,
            },
          })
          resolve({ ok: true })
        },
      )
    })
  }

  async subscribe(profileId: string, topic: string, qos: MqttQos): Promise<OperationResult> {
    const active = this.connections.get(profileId)
    if (!active?.client.connected) return { ok: false, error: '当前连接尚未就绪' }
    const filter = topic.trim()
    if (!filter) return { ok: false, error: '订阅 Topic 不能为空' }

    return new Promise((resolve) => {
      active.client.subscribe(filter, { qos }, (error, grants, packet) => {
        const packetReasonCodes = packet?.granted.flatMap((code) => (typeof code === 'number' ? [code] : [])) ?? []
        const rejectionCode = packetReasonCodes.find((code) => code >= 0x80)
          ?? (grants?.find((grant) => grant.qos === 128) ? 0x80 : undefined)
        const failure = error?.message ?? (rejectionCode === undefined ? undefined : rejectionMessage('订阅', rejectionCode))
        const grantedQos = grants?.[0]?.qos
        const resultQos: MqttQos = grantedQos === 0 || grantedQos === 1 || grantedQos === 2 ? grantedQos : qos
        this.eventSink({
          type: 'subscription',
          profileId,
          topic: filter,
          subscribed: !failure,
          qos: resultQos,
          at: Date.now(),
          error: failure,
        })
        resolve(failure ? { ok: false, error: failure } : { ok: true })
      })
    })
  }

  async unsubscribe(profileId: string, topic: string): Promise<OperationResult> {
    const active = this.connections.get(profileId)
    if (!active?.client.connected) return { ok: false, error: '当前连接尚未就绪' }

    const filter = topic.trim()
    if (!filter) return { ok: false, error: '订阅 Topic 不能为空' }

    return new Promise((resolve) => {
      active.client.unsubscribe(filter, (error, packet) => {
        const rejectionCode = packet?.cmd === 'unsuback'
          ? packet.granted?.find((code) => code >= 0x80)
          : undefined
        const failure = error?.message ?? (rejectionCode === undefined ? undefined : rejectionMessage('取消订阅', rejectionCode))
        this.eventSink({
          type: 'subscription',
          profileId,
          topic: filter,
          subscribed: Boolean(failure),
          qos: 0,
          at: Date.now(),
          error: failure,
        })
        resolve(failure ? { ok: false, error: failure } : { ok: true })
      })
    })
  }

  async disconnectAll(): Promise<void> {
    const profileIds = new Set([...this.connections.keys(), ...this.operationQueues.keys()])
    await Promise.all([...profileIds].map((profileId) => this.disconnect(profileId)))
  }

  private buildUrl(profile: ConnectionProfile): string {
    const rawHost = profile.host.trim()
    const parseTarget = /^[a-z][a-z\d+.-]*:\/\//i.test(rawHost)
      ? rawHost
      : `${profile.protocol}://${rawHost}`
    let normalizedHost: string
    try {
      normalizedHost = new URL(parseTarget).hostname
    } catch {
      throw new Error('Broker 地址格式无效')
    }
    if (!normalizedHost) throw new Error('Broker 地址格式无效')
    const configuredPath = profile.path.trim() || '/mqtt'
    const path = profile.protocol === 'ws' || profile.protocol === 'wss'
      ? configuredPath.startsWith('/') ? configuredPath : `/${configuredPath}`
      : ''
    return `${profile.protocol}://${normalizedHost}:${profile.port}${path}`
  }

  private async buildOptions(profile: ConnectionProfile, password: string): Promise<IClientOptions> {
    const options: IClientOptions = {
      clientId: profile.clientId,
      username: profile.username || undefined,
      password: password || undefined,
      protocolVersion: profile.mqttVersion === '5.0' ? 5 : 4,
      clean: profile.clean,
      keepalive: profile.keepalive,
      connectTimeout: profile.connectTimeout * 1000,
      reconnectPeriod: profile.reconnectPeriod * 1000,
      resubscribe: false,
      rejectUnauthorized: profile.rejectUnauthorized,
    }

    if (profile.caPath) options.ca = await readFile(profile.caPath)
    if (profile.certPath) options.cert = await readFile(profile.certPath)
    if (profile.keyPath) options.key = await readFile(profile.keyPath)
    return options
  }

  private isCurrent(profileId: string, generation: string): boolean {
    return this.connections.get(profileId)?.generation === generation
  }

  private runProfileOperation<T>(profileId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueues.get(profileId) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.operationQueues.set(profileId, tail)
    void tail.then(() => {
      if (this.operationQueues.get(profileId) === tail) this.operationQueues.delete(profileId)
    })
    return result
  }

  private emitStatus(profileId: string, status: ConnectionStatus, detail?: string): void {
    const at = Math.max(Date.now(), (this.runtimes.get(profileId)?.at ?? 0) + 1)
    const runtime = { profileId, status, detail, at }
    this.runtimes.set(profileId, runtime)
    this.eventSink({ type: 'status', ...runtime })
  }
}
