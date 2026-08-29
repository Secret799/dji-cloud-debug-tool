import { randomUUID } from 'node:crypto'
import type {
  ObjectStorageProfile,
  OperationResult,
  RemoteLogModule,
  RemoteLogUploadRequest,
} from '../shared/contracts'
import { resolveDeviceProvider } from '../shared/device-provider'
import type { MqttConnectionManager } from './mqtt-manager'
import type { ObjectStorageStore } from './object-storage-store'
import type { ProfileStore } from './profile-store'

type MqttPublisher = Pick<MqttConnectionManager, 'publish'>
type ObjectStorageResolver = Pick<ObjectStorageStore, 'resolve'>
type ConnectionProfileReader = Pick<ProfileStore, 'get'>

const credentialExpiresAt = (expire: number): number =>
  expire < 1_000_000_000_000 ? expire * 1_000 : expire

export const normalizeRemoteLogObjectKey = (value: string): string => {
  const normalized = value.trim()
  if (!normalized) throw new Error('对象 Key 不能为空')
  if (Buffer.byteLength(normalized, 'utf8') > 1_024) throw new Error('对象 Key 不能超过 1024 字节')
  if (/[\0-\x1f\x7f\\]/.test(normalized)) throw new Error('对象 Key 包含无效字符')
  if (normalized.split('/').some((segment) => segment === '..')) {
    throw new Error('对象 Key 不能包含 .. 路径段')
  }
  return normalized
}

const buildUploadPayload = (
  request: RemoteLogUploadRequest,
  profile: ObjectStorageProfile,
): string => {
  const grouped = new Map<RemoteLogModule, number[]>()
  for (const file of request.files) {
    const indexes = grouped.get(file.module) ?? []
    if (!indexes.includes(file.bootIndex)) indexes.push(file.bootIndex)
    grouped.set(file.module, indexes)
  }

  const files = [...grouped.entries()].map(([module, indexes]) => {
    const objectKey = normalizeRemoteLogObjectKey(request.objectKeys[module] ?? '')
    return {
      object_key: objectKey,
      module,
      list: indexes.map((bootIndex) => ({ boot_index: bootIndex })),
    }
  })

  return JSON.stringify({
    tid: randomUUID(),
    bid: randomUUID(),
    timestamp: Date.now(),
    method: 'fileupload_start',
    data: {
      bucket: profile.bucket.trim(),
      region: profile.region.trim(),
      credentials: {
        access_key_id: profile.accessKeyId.trim(),
        access_key_secret: profile.accessKeySecret,
        expire: profile.expire,
        security_token: profile.securityToken,
      },
      endpoint: profile.endpoint.trim(),
      provider: profile.provider,
      params: { files },
    },
  }, null, 2)
}

export class RemoteLogUploadManager {
  constructor(
    private readonly objectStorageStore: ObjectStorageResolver,
    private readonly mqttManager: MqttPublisher,
    private readonly profileStore: ConnectionProfileReader,
  ) {}

  async start(request: RemoteLogUploadRequest): Promise<OperationResult> {
    if (!request.files.length || request.files.length > 1_000) {
      return { ok: false, error: '远程日志文件数量无效' }
    }
    if (!/^[A-Za-z0-9_-]+$/.test(request.gatewaySn)) {
      return { ok: false, error: '机场 SN 格式无效' }
    }
    const objectKeys: Partial<Record<RemoteLogModule, string>> = {}
    try {
      for (const file of request.files) {
        if ((file.module !== '0' && file.module !== '3')
          || !Number.isInteger(file.bootIndex)
          || file.bootIndex < 0
          || file.bootIndex > 4_294_967_295) {
          return { ok: false, error: '远程日志文件参数无效' }
        }
        objectKeys[file.module] = normalizeRemoteLogObjectKey(request.objectKeys[file.module] ?? '')
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }

    const connectionProfile = await this.profileStore.get(request.profileId)
    if (!connectionProfile) return { ok: false, error: 'MQTT 连接配置不存在' }
    const gateway = connectionProfile.devices.find((device) =>
      device.sn === request.gatewaySn
      && device.type === 'dock'
      && resolveDeviceProvider(device) === 'dji'
      && device.enabled !== false)
    if (!gateway) return { ok: false, error: '远程日志机场不属于当前 DJI 连接配置' }

    const profile = await this.objectStorageStore.resolve(request.objectStorageProfileId)
    if (!profile) return { ok: false, error: '对象存储配置不存在' }
    if (!profile.accessKeyId.trim() || !profile.accessKeySecret) {
      return { ok: false, error: '对象存储配置缺少有效凭据' }
    }
    if (credentialExpiresAt(profile.expire) <= Date.now()) {
      return { ok: false, error: '对象存储临时凭证已过期，请先更新配置' }
    }

    return this.mqttManager.publish({
      profileId: request.profileId,
      topic: `thing/product/${request.gatewaySn}/services`,
      payload: buildUploadPayload({ ...request, objectKeys }, profile),
      qos: 1,
      retain: false,
    })
  }
}
