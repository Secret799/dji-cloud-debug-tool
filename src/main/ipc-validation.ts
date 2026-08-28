import type {
  ConnectionProfile,
  DeviceArchive,
  DeviceArchiveCamera,
  DeviceArchiveVideo,
  DjiDevice,
  FirmwareUploadRequest,
  MqttMessageRecord,
  MqttQos,
  MediaServerProfile,
  ObjectStorageProfile,
  PublishRequest,
  RtmpRelayStartRequest,
  SeiMessageDetailRequest,
  SeiParserStartRequest,
  TopicSubscription,
  WebDavConfig,
  WebDavSyncRequest,
  WhepOfferRequest,
} from '../shared/contracts'
import {
  MAX_EXPORT_BYTES,
  MAX_EXPORT_RECORDS,
  MAX_MQTT_PAYLOAD_BYTES,
  MAX_PROFILE_DOCUMENT_BYTES,
} from '../shared/limits'

const MAX_PROFILE_ID_BYTES = 256
const MAX_TOPIC_BYTES = 65_535
const MAX_TEXT_FIELD_BYTES = 4_096
const MAX_CLIENT_ID_BYTES = 65_535
const MAX_DEVICES = 1_000
const MAX_ARCHIVE_CAMERAS = 64
const MAX_ARCHIVE_VIDEOS = 64
const MAX_SUBSCRIPTIONS = 5_000
const MAX_DEVICE_PRODUCT_TYPE = 4_294_967_295
const MAX_WHEP_SDP_BYTES = 256 * 1024
const MAX_WEBDAV_BACKUP_BYTES = 16 * 1024 * 1024
const ALLOWED_RENDERER_STORAGE_KEYS = new Set([
  'dji-cloud-studio.sidebar-width',
  'dji-cloud-studio.telemetry-cache.v1',
  'dji-cloud-studio.telemetry-layout.v1',
])

export class IpcValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IpcValidationError'
  }
}

interface ValidatedExport {
  profileName: string
  content: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const byteLength = (value: string): number => Buffer.byteLength(value, 'utf8')

const requireRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) throw new IpcValidationError(`${label}格式无效`)
  return value
}

const requireString = (
  value: unknown,
  label: string,
  options: { allowEmpty?: boolean; allowNullCharacter?: boolean; maxBytes?: number } = {},
): string => {
  if (typeof value !== 'string') throw new IpcValidationError(`${label}必须是字符串`)
  const normalized = value.trim()
  if (!options.allowEmpty && !normalized) throw new IpcValidationError(`${label}不能为空`)
  if (byteLength(value) > (options.maxBytes ?? MAX_TEXT_FIELD_BYTES)) {
    throw new IpcValidationError(`${label}过长`)
  }
  if (!options.allowNullCharacter && value.includes('\0')) throw new IpcValidationError(`${label}不能包含空字符`)
  return value
}

const requireBoolean = (value: unknown, label: string): boolean => {
  if (typeof value !== 'boolean') throw new IpcValidationError(`${label}必须是布尔值`)
  return value
}

const requireOptionalBoolean = (value: unknown, label: string): void => {
  if (value !== undefined && typeof value !== 'boolean') throw new IpcValidationError(`${label}必须是布尔值`)
}

const requireInteger = (value: unknown, label: string, min: number, max: number): number => {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new IpcValidationError(`${label}必须是 ${min} 到 ${max} 之间的整数`)
  }
  return value as number
}

const requireFiniteNumber = (value: unknown, label: string, min = 0): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new IpcValidationError(`${label}必须是有效数字`)
  }
  return value
}

const requireArray = (value: unknown, label: string, maxLength: number): unknown[] => {
  if (!Array.isArray(value)) throw new IpcValidationError(`${label}必须是数组`)
  if (value.length > maxLength) throw new IpcValidationError(`${label}数量不能超过 ${maxLength}`)
  return value
}

const requireSerializedSize = (value: unknown, label: string, maxBytes: number): void => {
  let serialized: string
  try {
    serialized = JSON.stringify(value)
    if (serialized === undefined) throw new Error('Not serializable')
  } catch {
    throw new IpcValidationError(`${label}必须可以序列化为 JSON`)
  }
  if (byteLength(serialized) > maxBytes) throw new IpcValidationError(`${label}超过大小限制`)
}

export const validateProfileId = (value: unknown): string =>
  requireString(value, 'Profile ID', { maxBytes: MAX_PROFILE_ID_BYTES }).trim()

const validateArchiveVideo = (value: unknown): DeviceArchiveVideo => {
  const video = requireRecord(value, '档案视频源')
  const videoIndex = requireString(video.videoIndex, '视频源下标', { maxBytes: 256 }).trim()
  const videoType = requireString(video.videoType, '镜头类型', { maxBytes: 256 }).trim()
  const switchableVideoTypes = requireArray(video.switchableVideoTypes, '可切换镜头', 32).map((type) =>
    requireString(type, '镜头类型', { maxBytes: 256 }).trim(),
  )
  return { videoIndex, videoType, switchableVideoTypes }
}

const validateArchiveCamera = (value: unknown): DeviceArchiveCamera => {
  const camera = requireRecord(value, '相机档案')
  const availableVideoNumber = camera.availableVideoNumber === undefined
    ? undefined
    : requireFiniteNumber(camera.availableVideoNumber, '可用视频路数')
  const coexistVideoNumberMax = camera.coexistVideoNumberMax === undefined
    ? undefined
    : requireFiniteNumber(camera.coexistVideoNumberMax, '最大并发视频路数')
  return {
    gatewaySn: requireString(camera.gatewaySn, '相机网关 SN').trim(),
    sourceSn: requireString(camera.sourceSn, '相机设备 SN').trim(),
    cameraIndex: requireString(camera.cameraIndex, '相机下标', { maxBytes: 256 }).trim(),
    availableVideoNumber,
    coexistVideoNumberMax,
    videos: requireArray(camera.videos, '相机视频源', MAX_ARCHIVE_VIDEOS).map(validateArchiveVideo),
  }
}

const validateDeviceArchive = (value: unknown, profileId: string): DeviceArchive => {
  const archive = requireRecord(value, '设备档案')
  if (validateProfileId(archive.profileId) !== profileId) throw new IpcValidationError('设备档案不属于当前连接')
  if (archive.type !== 'dock' && archive.type !== 'aircraft' && archive.type !== 'pilot') {
    throw new IpcValidationError('档案设备类型无效')
  }
  let identity: DeviceArchive['identity']
  if (archive.identity !== undefined) {
    const rawIdentity = requireRecord(archive.identity, '设备产品标识')
    identity = {
      domain: requireString(rawIdentity.domain, '产品领域', { maxBytes: 64 }).trim(),
      productType: requireInteger(rawIdentity.productType, '产品类型', 0, MAX_DEVICE_PRODUCT_TYPE),
      productSubType: requireInteger(rawIdentity.productSubType, '产品子类型', 0, 65_535),
      channelIndex: rawIdentity.channelIndex === undefined
        ? undefined
        : requireString(rawIdentity.channelIndex, '产品通道', { maxBytes: 256 }).trim(),
      thingVersion: rawIdentity.thingVersion === undefined
        ? undefined
        : requireString(rawIdentity.thingVersion, '物模型版本', { maxBytes: 256 }).trim(),
    }
  }
  return {
    profileId,
    sn: requireString(archive.sn, '档案设备 SN').trim(),
    gatewaySn: archive.gatewaySn === undefined ? undefined : requireString(archive.gatewaySn, '档案网关 SN').trim(),
    type: archive.type,
    name: requireString(archive.name, '档案设备名称').trim(),
    identity,
    modelKey: archive.modelKey === undefined ? undefined : requireString(archive.modelKey, '设备型号标识', { maxBytes: 256 }).trim(),
    firmwareVersion: archive.firmwareVersion === undefined
      ? undefined
      : requireString(archive.firmwareVersion, '固件版本', { maxBytes: 256 }).trim(),
    cameras: requireArray(archive.cameras, '相机档案', MAX_ARCHIVE_CAMERAS).map(validateArchiveCamera),
    updatedAt: requireFiniteNumber(archive.updatedAt, '档案更新时间'),
    lastReportedAt: archive.lastReportedAt === undefined
      ? undefined
      : requireFiniteNumber(archive.lastReportedAt, '档案最后上报时间'),
  }
}

export const validateDeviceArchives = (rawProfileId: unknown, value: unknown): DeviceArchive[] => {
  requireSerializedSize(value, '设备档案', MAX_PROFILE_DOCUMENT_BYTES)
  const profileId = validateProfileId(rawProfileId)
  const archives = requireArray(value, '设备档案', MAX_DEVICES).map((archive) => validateDeviceArchive(archive, profileId))
  if (new Set(archives.map((archive) => archive.sn)).size !== archives.length) {
    throw new IpcValidationError('设备档案中存在重复 SN')
  }
  return archives
}

export const validateSessionPassword = (value: unknown): string | undefined => {
  if (value === undefined) return undefined
  return requireString(value, '临时密码', {
    allowEmpty: true,
    allowNullCharacter: true,
    maxBytes: MAX_TOPIC_BYTES,
  })
}

export const validateWebDavConfig = (value: unknown): WebDavConfig => {
  const config = requireRecord(value, 'WebDAV 配置')
  const endpoint = requireString(config.endpoint, 'WebDAV 端点地址').trim()
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new IpcValidationError('WebDAV 端点地址无效')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new IpcValidationError('WebDAV 端点仅支持 HTTP 或 HTTPS')
  }
  if (url.username || url.password) throw new IpcValidationError('请勿在 WebDAV 地址中包含用户名或密码')
  if (config.authType !== 'basic' && config.authType !== 'digest' && config.authType !== 'token') {
    throw new IpcValidationError('WebDAV 认证方式无效')
  }
  const username = requireString(config.username, 'WebDAV 用户名', {
    allowEmpty: config.authType === 'token',
    maxBytes: 1_024,
  }).trim()
  const secret = requireString(config.secret, config.authType === 'token' ? 'Token' : '密码', {
    allowEmpty: true,
    allowNullCharacter: true,
    maxBytes: 65_535,
  })
  requireOptionalBoolean(config.hasStoredSecret, '已保存 WebDAV 密钥标记')
  requireOptionalBoolean(config.clearStoredSecret, '清除 WebDAV 密钥标记')
  const rejectUnauthorized = requireBoolean(config.rejectUnauthorized, 'WebDAV 证书校验')
  const autoSync = config.autoSync === undefined
    ? true
    : requireBoolean(config.autoSync, 'WebDAV 自动同步')
  const syncStrategy = config.syncStrategy === undefined ? 'smart-merge' : config.syncStrategy
  if (syncStrategy !== 'smart-merge' && syncStrategy !== 'cloud-first' && syncStrategy !== 'local-first') {
    throw new IpcValidationError('WebDAV 同步策略无效')
  }
  const updatedAt = requireFiniteNumber(config.updatedAt, 'WebDAV 配置更新时间')
  return {
    endpoint: url.toString(),
    authType: config.authType,
    username,
    secret,
    hasStoredSecret: config.hasStoredSecret as boolean | undefined,
    clearStoredSecret: config.clearStoredSecret as boolean | undefined,
    rejectUnauthorized,
    autoSync,
    syncStrategy,
    updatedAt,
  }
}

export const validateWebDavSyncRequest = (value: unknown): WebDavSyncRequest => {
  requireSerializedSize(value, 'WebDAV 备份数据', MAX_WEBDAV_BACKUP_BYTES)
  const request = requireRecord(value, 'WebDAV 同步请求')
  const rawStorage = requireRecord(request.rendererStorage, '渲染进程数据')
  const rendererStorage: Record<string, string> = {}
  for (const [key, rawValue] of Object.entries(rawStorage)) {
    if (!ALLOWED_RENDERER_STORAGE_KEYS.has(key)) throw new IpcValidationError(`不支持备份本地数据项：${key}`)
    rendererStorage[key] = requireString(rawValue, key, {
      allowEmpty: true,
      allowNullCharacter: true,
      maxBytes: MAX_WEBDAV_BACKUP_BYTES,
    })
  }
  return { rendererStorage }
}

export const validateWebDavVersionId = (value: unknown): string => {
  const id = requireString(value, 'WebDAV 版本 ID', { maxBytes: 256 }).trim()
  if (!/^v\d{6}-\d{13}-[a-f0-9-]{36}\.djibak$/i.test(id)) {
    throw new IpcValidationError('WebDAV 版本 ID 无效')
  }
  return id
}

export const validateTopic = (value: unknown, label = 'Topic'): string => {
  const topic = requireString(value, label, { maxBytes: MAX_TOPIC_BYTES }).trim()
  return topic
}

export const validateQos = (value: unknown): MqttQos => {
  if (value !== 0 && value !== 1 && value !== 2) throw new IpcValidationError('QoS 必须是 0、1 或 2')
  return value
}

export const validateWhepOfferRequest = (value: unknown): WhepOfferRequest => {
  const request = requireRecord(value, 'WHEP 请求')
  const rawUrl = requireString(request.url, 'WHEP URL', { maxBytes: 4_096 }).trim()
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new IpcValidationError('WHEP URL 无效')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new IpcValidationError('WHEP URL 仅支持 HTTP 或 HTTPS')
  if (url.username || url.password) throw new IpcValidationError('WHEP URL 不能包含认证信息')
  const sdp = requireString(request.sdp, 'WHEP SDP', { maxBytes: MAX_WHEP_SDP_BYTES })
  if (!sdp.trimStart().startsWith('v=')) throw new IpcValidationError('WHEP SDP 格式无效')
  return { url: url.toString(), sdp }
}

export const validateRtmpRelayStartRequest = (value: unknown): RtmpRelayStartRequest => {
  const request = requireRecord(value, 'RTMP 播放请求')
  const rawUrl = requireString(request.url, 'RTMP URL', { maxBytes: 4_096 }).trim()
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new IpcValidationError('RTMP URL 无效')
  }
  if (url.protocol !== 'rtmp:' && url.protocol !== 'rtmps:') {
    throw new IpcValidationError('RTMP 播放仅支持 RTMP 或 RTMPS URL')
  }
  return { url: url.toString() }
}

export const validateRtmpRelayId = (value: unknown): string => {
  const relayId = requireString(value, 'RTMP relay ID', { maxBytes: 64 }).trim()
  if (!/^[a-f0-9-]+$/.test(relayId)) throw new IpcValidationError('RTMP relay ID 无效')
  return relayId
}

export const validateSeiParserStartRequest = (value: unknown): SeiParserStartRequest => {
  const request = requireRecord(value, 'SEI 解析请求')
  const streamId = requireString(request.streamId, '视频流 ID', { maxBytes: 512 }).trim()
  if (request.source !== 'local-zlm' && request.source !== 'secret-ems') {
    throw new IpcValidationError('SEI 来源无效')
  }
  const rawUrl = requireString(request.url, 'SEI URL', { maxBytes: 4_096 }).trim()
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new IpcValidationError('SEI URL 无效')
  }
  if (url.username || url.password) throw new IpcValidationError('SEI URL 不能包含认证信息')
  if (url.hash) throw new IpcValidationError('SEI URL 不能包含片段')
  if (request.source === 'local-zlm') {
    if (url.protocol !== 'rtsp:') throw new IpcValidationError('本地 SEI 解析仅支持 RTSP URL')
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '[::1]') {
      throw new IpcValidationError('本地 SEI 解析仅支持本地 ZLMediaKit')
    }
  } else {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new IpcValidationError('SecretEMS SEI 仅支持 HTTP 或 HTTPS URL')
    }
    const diagnosticPath = url.pathname === '/easyMedia/api/sei/events'
    const deviceMatch = /^\/easyMedia\/api\/sei\/devices\/([^/]+)\/events$/.exec(url.pathname)
    let devicePath = false
    if (deviceMatch) {
      try {
        devicePath = /^[A-Za-z0-9_.-]{1,128}$/.test(decodeURIComponent(deviceMatch[1]))
      } catch {
        devicePath = false
      }
    }
    if (!diagnosticPath && !devicePath) throw new IpcValidationError('SecretEMS SEI 接口路径无效')
    if (diagnosticPath) {
      const appName = url.searchParams.get('app') ?? ''
      const streamName = url.searchParams.get('stream') ?? ''
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(appName) || !/^[A-Za-z0-9_.-]{1,128}$/.test(streamName)) {
        throw new IpcValidationError('SecretEMS SEI app 或 stream 无效')
      }
    }
  }
  return { streamId, url: url.toString(), source: request.source }
}

export const validateSeiParserId = (value: unknown): string => {
  const sessionId = requireString(value, 'SEI parser ID', { maxBytes: 64 }).trim()
  if (!/^[a-f0-9-]+$/.test(sessionId)) throw new IpcValidationError('SEI parser ID 无效')
  return sessionId
}

export const validateSeiMessageDetailRequest = (value: unknown): SeiMessageDetailRequest => {
  const request = requireRecord(value, 'SEI 消息详情请求')
  const sessionId = validateSeiParserId(request.sessionId)
  const messageId = requireString(request.messageId, 'SEI message ID', { maxBytes: 128 }).trim()
  if (!/^[A-Za-z0-9_.:-]+$/.test(messageId)) throw new IpcValidationError('SEI message ID 无效')
  return { sessionId, messageId }
}

export const validateMediaServerProfile = (value: unknown): MediaServerProfile => {
  const profile = requireRecord(value, '媒体服务配置')
  const id = validateProfileId(profile.id)
  requireString(profile.name, '媒体服务名称', { maxBytes: 256 })
  if (profile.kind !== 'local-zlm' && profile.kind !== 'remote-zlm' && profile.kind !== 'remote-srs' && profile.kind !== 'remote-easymedia') {
    throw new IpcValidationError('媒体服务类型无效')
  }
  requireString(profile.host, '媒体服务主机', { maxBytes: 512 })
  if (profile.apiProtocol !== 'http' && profile.apiProtocol !== 'https') throw new IpcValidationError('API 协议无效')
  if (profile.httpProtocol !== 'http' && profile.httpProtocol !== 'https') throw new IpcValidationError('播放协议无效')
  requireInteger(profile.apiPort, 'API 端口', 1, 65_535)
  requireInteger(profile.httpPort, 'HTTP 端口', 1, 65_535)
  requireInteger(profile.rtmpPort, 'RTMP 端口', 1, 65_535)
  requireInteger(profile.rtspPort, 'RTSP 端口', 0, 65_535)
  requireInteger(profile.webrtcPort, 'WebRTC 端口', profile.kind === 'local-zlm' || profile.kind === 'remote-easymedia' ? 1 : 0, 65_535)
  if (profile.kind === 'local-zlm' && profile.apiPort !== profile.httpPort) {
    throw new IpcValidationError('本地 ZLMediaKit 的 API 端口必须与 HTTP 端口一致')
  }
  if (profile.kind === 'remote-easymedia') {
    if (profile.rtspPort !== 0) throw new IpcValidationError('SecretEMS 不开放 RTSP 端口')
    if (profile.apiPort !== profile.httpPort || profile.apiProtocol !== profile.httpProtocol) {
      throw new IpcValidationError('SecretEMS 的 WHIP/WHEP 协议和端口必须保持一致')
    }
  }
  requireString(profile.secret, 'API 密钥', { allowEmpty: true, allowNullCharacter: true, maxBytes: 4_096 })
  requireOptionalBoolean(profile.isDefault, '默认媒体服务标记')
  requireOptionalBoolean(profile.hasStoredSecret, '已保存 API 密钥标记')
  requireOptionalBoolean(profile.clearStoredSecret, '清除 API 密钥标记')
  requireFiniteNumber(profile.createdAt, '创建时间')
  requireFiniteNumber(profile.updatedAt, '更新时间')
  return { ...profile, id } as unknown as MediaServerProfile
}

export const validateObjectStorageProfile = (value: unknown): ObjectStorageProfile => {
  const profile = requireRecord(value, '对象存储配置')
  const id = validateProfileId(profile.id)
  requireString(profile.name, '对象存储名称', { maxBytes: 256 })
  if (profile.provider !== 'ali' && profile.provider !== 'aws' && profile.provider !== 'minio') {
    throw new IpcValidationError('对象存储厂商无效')
  }
  requireString(profile.bucket, 'Bucket', { maxBytes: 1_024 })
  requireString(profile.region, 'Region', { allowEmpty: profile.provider === 'minio', maxBytes: 1_024 })
  const endpoint = requireString(profile.endpoint, 'Endpoint', { maxBytes: 4_096 }).trim()
  let parsedEndpoint: URL
  try {
    parsedEndpoint = new URL(endpoint)
  } catch {
    throw new IpcValidationError('Endpoint URL 无效')
  }
  if (parsedEndpoint.protocol !== 'http:' && parsedEndpoint.protocol !== 'https:') {
    throw new IpcValidationError('Endpoint 仅支持 HTTP 或 HTTPS')
  }
  if (parsedEndpoint.username || parsedEndpoint.password) throw new IpcValidationError('Endpoint 不能包含认证信息')
  requireString(profile.accessKeyId, 'Access Key ID', { maxBytes: 4_096 })
  requireString(profile.accessKeySecret, 'Access Key Secret', {
    allowEmpty: true,
    allowNullCharacter: true,
    maxBytes: 65_535,
  })
  requireString(profile.securityToken, 'Security Token', {
    allowEmpty: true,
    allowNullCharacter: true,
    maxBytes: 65_535,
  })
  requireOptionalBoolean(profile.hasStoredAccessKeySecret, '已保存 Access Key Secret 标记')
  requireOptionalBoolean(profile.hasStoredSecurityToken, '已保存 Security Token 标记')
  requireOptionalBoolean(profile.clearStoredAccessKeySecret, '清除 Access Key Secret 标记')
  requireOptionalBoolean(profile.clearStoredSecurityToken, '清除 Security Token 标记')
  requireInteger(profile.expire, '凭证过期时间戳', 1, Number.MAX_SAFE_INTEGER)
  requireFiniteNumber(profile.createdAt, '创建时间')
  requireFiniteNumber(profile.updatedAt, '更新时间')
  return { ...profile, id, endpoint } as unknown as ObjectStorageProfile
}

export const validateFirmwareUploadRequest = (value: unknown): FirmwareUploadRequest => {
  const request = requireRecord(value, '固件上传请求')
  const selectionToken = requireString(request.selectionToken, '固件选择令牌', { maxBytes: 256 }).trim()
  const objectStorageProfileId = validateProfileId(request.objectStorageProfileId)
  const objectKey = requireString(request.objectKey, '对象 Key', { maxBytes: 2_048 }).trim()
  return { selectionToken, objectStorageProfileId, objectKey }
}

const validateDevice = (value: unknown): DjiDevice => {
  const device = requireRecord(value, '设备')
  requireString(device.id, '设备 ID', { maxBytes: MAX_PROFILE_ID_BYTES })
  requireString(device.name, '设备名称')
  requireString(device.sn, '设备 SN')
  if (device.type !== 'dock' && device.type !== 'aircraft' && device.type !== 'pilot') {
    throw new IpcValidationError('设备类型无效')
  }
  if (device.provider !== undefined && device.provider !== 'dji' && device.provider !== 'superdock') {
    throw new IpcValidationError('设备厂商无效')
  }
  if (device.type !== 'dock' && device.provider === 'superdock') {
    throw new IpcValidationError('SuperDock 厂商仅适用于机场设备')
  }
  if (
    device.dockModel !== undefined
    && device.dockModel !== 'dock2'
    && device.dockModel !== 'dock3'
    && device.dockModel !== 's22m300'
    && device.dockModel !== 's2201'
    && device.dockModel !== 's2301'
    && device.dockModel !== 's24m350'
    && device.dockModel !== 's24m350s'
    && device.dockModel !== 's24m3'
    && device.dockModel !== 's24m4'
    && device.dockModel !== 's25m4'
    && device.dockModel !== 's25m400'
    && device.dockModel !== 's25m400s'
    && device.dockModel !== 'other'
  ) {
    throw new IpcValidationError('机场型号无效')
  }
  if (device.type !== 'dock' && device.dockModel !== undefined) {
    throw new IpcValidationError('非机场设备不能设置机场型号')
  }
  const superDockModels = new Set([
    's22m300', 's2201', 's2301', 's24m350', 's24m350s',
    's24m3', 's24m4', 's25m4', 's25m400', 's25m400s',
  ])
  if (device.provider === 'superdock' && device.dockModel !== undefined && device.dockModel !== 'other'
    && !superDockModels.has(String(device.dockModel))) {
    throw new IpcValidationError('SuperDock 厂商与机场型号不匹配')
  }
  if (device.provider === 'dji' && superDockModels.has(String(device.dockModel))) {
    throw new IpcValidationError('DJI 厂商与机场型号不匹配')
  }
  requireOptionalBoolean(device.enabled, '设备启用状态')
  if (device.parentSn !== undefined) requireString(device.parentSn, '父设备 SN')
  return device as unknown as DjiDevice
}

const validateSubscription = (value: unknown): TopicSubscription => {
  const subscription = requireRecord(value, '订阅')
  requireString(subscription.id, '订阅 ID', { maxBytes: MAX_PROFILE_ID_BYTES })
  validateTopic(subscription.topic, '订阅 Topic')
  validateQos(subscription.qos)
  requireBoolean(subscription.enabled, '订阅启用状态')
  if (subscription.source !== 'dji' && subscription.source !== 'superdock' && subscription.source !== 'custom') {
    throw new IpcValidationError('订阅来源无效')
  }
  return subscription as unknown as TopicSubscription
}

export const validateConnectionProfile = (value: unknown): ConnectionProfile => {
  requireSerializedSize(value, '连接配置', MAX_PROFILE_DOCUMENT_BYTES)
  const profile = requireRecord(value, '连接配置')
  const profileId = validateProfileId(profile.id)
  requireString(profile.name, '连接名称')
  if (profile.protocol !== 'mqtt' && profile.protocol !== 'mqtts' && profile.protocol !== 'ws' && profile.protocol !== 'wss') {
    throw new IpcValidationError('MQTT 协议无效')
  }
  requireString(profile.host, 'Broker 地址')
  requireInteger(profile.port, 'Broker 端口', 1, 65_535)
  requireString(profile.path, 'WebSocket Path', { allowEmpty: true })
  requireString(profile.clientId, 'Client ID', { maxBytes: MAX_CLIENT_ID_BYTES })
  requireString(profile.username, '用户名', { allowEmpty: true })
  requireString(profile.password, '密码', {
    allowEmpty: true,
    allowNullCharacter: true,
    maxBytes: MAX_TOPIC_BYTES,
  })
  requireOptionalBoolean(profile.hasStoredPassword, '已保存密码标记')
  requireOptionalBoolean(profile.clearStoredPassword, '清除密码标记')
  if (profile.mqttVersion !== '3.1.1' && profile.mqttVersion !== '5.0') {
    throw new IpcValidationError('MQTT 版本无效')
  }
  requireBoolean(profile.clean, 'Clean Session')
  requireInteger(profile.keepalive, 'Keep Alive', 0, 65_535)
  requireInteger(profile.connectTimeout, '连接超时', 1, 3_600)
  requireInteger(profile.reconnectPeriod, '重连间隔', 0, 3_600)
  requireBoolean(profile.rejectUnauthorized, '服务器证书校验')
  requireString(profile.caPath, 'CA 证书路径', { allowEmpty: true })
  requireString(profile.certPath, '客户端证书路径', { allowEmpty: true })
  requireString(profile.keyPath, '客户端私钥路径', { allowEmpty: true })
  requireArray(profile.devices, '设备', MAX_DEVICES).forEach(validateDevice)
  requireArray(profile.subscriptions, '订阅', MAX_SUBSCRIPTIONS).forEach(validateSubscription)
  requireFiniteNumber(profile.createdAt, '创建时间')
  requireFiniteNumber(profile.updatedAt, '更新时间')
  return { ...profile, id: profileId } as unknown as ConnectionProfile
}

export const validatePublishRequest = (value: unknown): PublishRequest => {
  const request = requireRecord(value, '发布请求')
  const profileId = validateProfileId(request.profileId)
  const topic = validateTopic(request.topic, '发布 Topic')
  const payload = requireString(request.payload, '发布 Payload', {
    allowEmpty: true,
    allowNullCharacter: true,
    maxBytes: MAX_MQTT_PAYLOAD_BYTES,
  })
  const qos = validateQos(request.qos)
  const retain = requireBoolean(request.retain, 'Retain')
  return { profileId, topic, payload, qos, retain }
}

const validateMessageRecord = (value: unknown): MqttMessageRecord => {
  const record = requireRecord(value, '导出消息')
  requireString(record.id, '消息 ID', { maxBytes: MAX_PROFILE_ID_BYTES })
  validateProfileId(record.profileId)
  if (record.direction !== 'in' && record.direction !== 'out') throw new IpcValidationError('消息方向无效')
  validateTopic(record.topic, '消息 Topic')
  requireString(record.payload, '消息 Payload', {
    allowEmpty: true,
    allowNullCharacter: true,
    maxBytes: MAX_MQTT_PAYLOAD_BYTES,
  })
  validateQos(record.qos)
  requireBoolean(record.retain, '消息 Retain')
  requireFiniteNumber(record.timestamp, '消息时间')
  requireFiniteNumber(record.size, '消息大小')
  requireOptionalBoolean(record.duplicate, '消息 Duplicate')
  if (record.properties !== undefined && !isRecord(record.properties)) {
    throw new IpcValidationError('MQTT Properties 格式无效')
  }
  return record as unknown as MqttMessageRecord
}

export const validateExportMessageOptions = (value: unknown): ValidatedExport => {
  const options = requireRecord(value, '导出选项')
  const profileName = requireString(options.profileName, 'Profile 名称', { maxBytes: 256 })
  const records = requireArray(options.records, '导出消息', MAX_EXPORT_RECORDS).map(validateMessageRecord)
  const lines: string[] = []
  let totalBytes = 0

  for (const record of records) {
    let line: string
    try {
      line = JSON.stringify(record)
    } catch {
      throw new IpcValidationError('导出消息包含无法序列化的字段')
    }
    totalBytes += byteLength(line) + (lines.length ? 1 : 0)
    if (totalBytes > MAX_EXPORT_BYTES) throw new IpcValidationError('导出内容超过 32 MiB 限制')
    lines.push(line)
  }

  return { profileName, content: lines.join('\n') }
}
