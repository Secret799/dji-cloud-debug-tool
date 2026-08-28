export type MqttProtocol = 'mqtt' | 'mqtts' | 'ws' | 'wss'
export type MqttVersion = '3.1.1' | '5.0'
export type MqttQos = 0 | 1 | 2
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'error'
export type DeviceType = 'dock' | 'aircraft' | 'pilot'
export type DockModel = 'dock2' | 'dock3' | 'other'

export type TelemetryTabKind = 'operation' | 'device' | 'maintenance' | 'other' | 'custom'
export type TelemetrySectionKind =
  | 'system'
  | 'power'
  | 'environment'
  | 'position'
  | 'safety'
  | 'network'
  | 'payload'
  | 'equipment'
  | 'maintenance'
  | 'other'
  | 'custom'

export type TelemetryPropertyValueType =
  | 'bool'
  | 'enum_int'
  | 'int'
  | 'float'
  | 'double'
  | 'text'
  | 'enum_string'
  | 'date'
  | 'struct'
  | 'array'

export interface TelemetryPropertySetting {
  enabled: boolean
  path: string
  type: TelemetryPropertyValueType
  constraint: string
}

export interface TelemetryLayoutField {
  key: string
  label: string
  description: string
  visible: boolean
  propertySetting?: TelemetryPropertySetting
}

export interface TelemetryLayoutSection {
  id: string
  name: string
  kind: TelemetrySectionKind
  fieldKeys: string[]
}

export interface TelemetryLayoutTab {
  id: string
  name: string
  kind: TelemetryTabKind
  sections: TelemetryLayoutSection[]
}

export interface TelemetryDeviceLayout {
  tabs: TelemetryLayoutTab[]
  fields: TelemetryLayoutField[]
}

export interface TelemetryLayoutConfig {
  version: 1
  updatedAt: number
  devices: Record<DeviceType, TelemetryDeviceLayout>
}

export interface TelemetryLayoutImportResult {
  canceled: boolean
  data?: unknown
  error?: string
}

export interface DjiDevice {
  id: string
  name: string
  sn: string
  type: DeviceType
  enabled?: boolean
  dockModel?: DockModel
  parentSn?: string
}

export interface DjiDeviceIdentity {
  domain: string
  productType: number
  productSubType: number
  channelIndex?: string
  thingVersion?: string
}

export interface DeviceArchiveVideo {
  videoIndex: string
  videoType: string
  switchableVideoTypes: string[]
}

export interface DeviceArchiveCamera {
  gatewaySn: string
  sourceSn: string
  cameraIndex: string
  availableVideoNumber?: number
  coexistVideoNumberMax?: number
  videos: DeviceArchiveVideo[]
}

export interface DeviceArchive {
  profileId: string
  sn: string
  gatewaySn?: string
  type: DeviceType
  name: string
  identity?: DjiDeviceIdentity
  modelKey?: string
  firmwareVersion?: string
  cameras: DeviceArchiveCamera[]
  updatedAt: number
  lastReportedAt?: number
}

export interface TopicSubscription {
  id: string
  topic: string
  qos: MqttQos
  enabled: boolean
  source: 'dji' | 'custom'
}

export interface ConnectionProfile {
  id: string
  name: string
  protocol: MqttProtocol
  host: string
  port: number
  path: string
  clientId: string
  username: string
  password: string
  hasStoredPassword?: boolean
  clearStoredPassword?: boolean
  mqttVersion: MqttVersion
  clean: boolean
  keepalive: number
  connectTimeout: number
  reconnectPeriod: number
  rejectUnauthorized: boolean
  caPath: string
  certPath: string
  keyPath: string
  devices: DjiDevice[]
  subscriptions: TopicSubscription[]
  createdAt: number
  updatedAt: number
}

export interface PublishRequest {
  profileId: string
  topic: string
  payload: string
  qos: MqttQos
  retain: boolean
}

export interface MqttMessageRecord {
  id: string
  profileId: string
  direction: 'in' | 'out'
  topic: string
  payload: string
  qos: MqttQos
  retain: boolean
  timestamp: number
  size: number
  duplicate?: boolean
  properties?: Record<string, unknown>
}

export interface MqttConnectionRuntime {
  profileId: string
  status: ConnectionStatus
  at: number
  detail?: string
}

export type MqttRuntimeEvent =
  | {
      type: 'status'
      profileId: string
      status: ConnectionStatus
      at: number
      detail?: string
    }
  | {
      type: 'message'
      profileId: string
      message: MqttMessageRecord
    }
  | {
      type: 'subscription'
      profileId: string
      topic: string
      subscribed: boolean
      qos: MqttQos
      at: number
      error?: string
    }

export interface OperationResult {
  ok: boolean
  error?: string
}

export type AppUpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'unsupported'

export interface AppUpdateState {
  status: AppUpdateStatus
  currentVersion: string
  availableVersion?: string
  releaseName?: string
  releaseNotes?: string
  releaseUrl?: string
  progress?: number
  error?: string
}

export type WebDavAuthType = 'basic' | 'digest' | 'token'

export interface WebDavConfig {
  endpoint: string
  authType: WebDavAuthType
  username: string
  secret: string
  hasStoredSecret?: boolean
  clearStoredSecret?: boolean
  rejectUnauthorized: boolean
  updatedAt: number
}

export interface WebDavVersion {
  id: string
  revision: number
  createdAt: number
  size: number
  appVersion?: string
}

export interface WebDavActivity {
  id: string
  type: 'upload' | 'restore' | 'delete'
  revision: number
  at: number
}

export interface WebDavOverview {
  configured: boolean
  connected: boolean
  config?: WebDavConfig
  localVersion?: WebDavVersion
  cloudVersion?: WebDavVersion
  versions: WebDavVersion[]
  activities: WebDavActivity[]
  error?: string
}

export interface WebDavSyncRequest {
  rendererStorage: Record<string, string>
}

export interface WebDavRestoreResult extends OperationResult {
  rendererStorage?: Record<string, string>
  overview?: WebDavOverview
}

export interface ExportMessageOptions {
  profileName: string
  records: MqttMessageRecord[]
}

export type ObjectStorageProvider = 'ali' | 'aws' | 'minio'

export interface ObjectStorageProfile {
  id: string
  name: string
  provider: ObjectStorageProvider
  bucket: string
  region: string
  endpoint: string
  accessKeyId: string
  accessKeySecret: string
  securityToken: string
  expire: number
  hasStoredAccessKeySecret?: boolean
  hasStoredSecurityToken?: boolean
  clearStoredAccessKeySecret?: boolean
  clearStoredSecurityToken?: boolean
  createdAt: number
  updatedAt: number
}

export interface FirmwarePackageSelection {
  token: string
  fileName: string
  fileSize: number
  md5: string
}

export interface FirmwarePackagePickResult {
  canceled: boolean
  package?: FirmwarePackageSelection
  error?: string
}

export interface FirmwareUploadRequest {
  selectionToken: string
  objectStorageProfileId: string
  objectKey: string
}

export interface FirmwareArtifact {
  selectionToken: string
  objectStorageProfileId: string
  objectStorageProfileName: string
  provider: ObjectStorageProvider
  bucket: string
  objectKey: string
  fileName: string
  fileSize: number
  md5: string
  fileUrl: string
  urlExpiresAt: number
  uploadedAt: number
}

export interface FirmwareUploadResult extends OperationResult {
  artifact?: FirmwareArtifact
}

export interface FirmwareUploadProgress {
  selectionToken: string
  loaded: number
  total: number
  percent: number
  at: number
}

export type MediaServerKind = 'local-zlm' | 'remote-zlm' | 'remote-srs' | 'remote-easymedia'
export type MediaServerRuntimeState = 'stopped' | 'starting' | 'running' | 'unreachable' | 'error'

export interface MediaServerProfile {
  id: string
  name: string
  kind: MediaServerKind
  host: string
  apiProtocol: 'http' | 'https'
  apiPort: number
  httpProtocol: 'http' | 'https'
  httpPort: number
  rtmpPort: number
  rtspPort: number
  webrtcPort: number
  secret: string
  isDefault?: boolean
  hasStoredSecret?: boolean
  clearStoredSecret?: boolean
  createdAt: number
  updatedAt: number
}

export interface MediaServerRuntime {
  profileId: string
  state: MediaServerRuntimeState
  checkedAt: number
  pid?: number
  version?: string
  detail?: string
  binaryAvailable?: boolean
}

export interface MediaServerOperationResult extends OperationResult {
  runtime?: MediaServerRuntime
}

export interface WhepOfferRequest {
  url: string
  sdp: string
}

export interface WhepOfferResult extends OperationResult {
  sdp?: string
}

export interface RtmpRelayStartRequest {
  url: string
}

export interface RtmpRelayStartResult extends OperationResult {
  relayId?: string
  playbackUrl?: string
}

export interface DjiDesktopApi {
  profiles: {
    list: () => Promise<ConnectionProfile[]>
    save: (profile: ConnectionProfile) => Promise<ConnectionProfile>
    remove: (profileId: string) => Promise<OperationResult>
  }
  deviceArchives: {
    list: () => Promise<DeviceArchive[]>
    replaceProfile: (profileId: string, archives: DeviceArchive[]) => Promise<DeviceArchive[]>
  }
  mqtt: {
    getRuntime: () => Promise<MqttConnectionRuntime[]>
    connect: (profileId: string, sessionPassword?: string) => Promise<OperationResult>
    disconnect: (profileId: string) => Promise<OperationResult>
    publish: (request: PublishRequest) => Promise<OperationResult>
    subscribe: (profileId: string, topic: string, qos: MqttQos) => Promise<OperationResult>
    unsubscribe: (profileId: string, topic: string) => Promise<OperationResult>
  }
  dialogs: {
    pickCertificate: () => Promise<string | null>
    exportMessages: (options: ExportMessageOptions) => Promise<OperationResult>
    importTelemetryLayout: () => Promise<TelemetryLayoutImportResult>
    exportTelemetryLayout: (config: TelemetryLayoutConfig) => Promise<OperationResult>
  }
  media: {
    listServers: () => Promise<MediaServerProfile[]>
    saveServer: (profile: MediaServerProfile) => Promise<MediaServerProfile>
    removeServer: (profileId: string) => Promise<OperationResult>
    checkServer: (profileId: string) => Promise<MediaServerOperationResult>
    startLocal: () => Promise<MediaServerOperationResult>
    stopLocal: () => Promise<MediaServerOperationResult>
    getLocalRuntime: () => Promise<MediaServerRuntime>
    negotiateWhep: (request: WhepOfferRequest) => Promise<WhepOfferResult>
    startRtmpRelay: (request: RtmpRelayStartRequest) => Promise<RtmpRelayStartResult>
    stopRtmpRelay: (relayId: string) => Promise<OperationResult>
    onRuntimeEvent: (listener: (runtime: MediaServerRuntime) => void) => () => void
  }
  objectStorage: {
    list: () => Promise<ObjectStorageProfile[]>
    save: (profile: ObjectStorageProfile) => Promise<ObjectStorageProfile>
    remove: (profileId: string) => Promise<OperationResult>
    resolve: (profileId: string) => Promise<ObjectStorageProfile | undefined>
  }
  firmware: {
    pickPackage: () => Promise<FirmwarePackagePickResult>
    uploadPackage: (request: FirmwareUploadRequest) => Promise<FirmwareUploadResult>
    onUploadProgress: (listener: (progress: FirmwareUploadProgress) => void) => () => void
  }
  updates: {
    getState: () => Promise<AppUpdateState>
    check: () => Promise<AppUpdateState>
    download: () => Promise<OperationResult>
    openInstaller: () => Promise<OperationResult>
    onStateChange: (listener: (state: AppUpdateState) => void) => () => void
  }
  webdav: {
    getOverview: () => Promise<WebDavOverview>
    saveConfig: (config: WebDavConfig) => Promise<WebDavOverview>
    removeConfig: () => Promise<OperationResult>
    test: (config?: WebDavConfig) => Promise<OperationResult>
    sync: (request: WebDavSyncRequest) => Promise<WebDavOverview>
    changed: (request: WebDavSyncRequest) => Promise<void>
    restore: (versionId: string) => Promise<WebDavRestoreResult>
    removeVersion: (versionId: string) => Promise<WebDavOverview>
    onRemoteDataApplied: (listener: (rendererStorage: Record<string, string>) => void) => () => void
  }
  events: {
    onRuntimeEvent: (listener: (event: MqttRuntimeEvent) => void) => () => void
  }
}
