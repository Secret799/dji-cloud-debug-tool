import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/channels'
import type {
  ConnectionProfile,
  DeviceArchive,
  DjiDesktopApi,
  ExportMessageOptions,
  FirmwareUploadProgress,
  FirmwareUploadRequest,
  MediaServerProfile,
  MediaServerRuntime,
  MqttQos,
  MqttRuntimeEvent,
  ObjectStorageProfile,
  PublishRequest,
  RtmpRelayStartRequest,
  TelemetryLayoutConfig,
  WhepOfferRequest,
} from '../shared/contracts'

const api: DjiDesktopApi = {
  profiles: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.profilesList),
    save: (profile: ConnectionProfile) => ipcRenderer.invoke(IPC_CHANNELS.profilesSave, profile),
    remove: (profileId: string) => ipcRenderer.invoke(IPC_CHANNELS.profilesRemove, profileId),
  },
  deviceArchives: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.deviceArchivesList),
    replaceProfile: (profileId: string, archives: DeviceArchive[]) =>
      ipcRenderer.invoke(IPC_CHANNELS.deviceArchivesReplaceProfile, profileId, archives),
  },
  mqtt: {
    getRuntime: () => ipcRenderer.invoke(IPC_CHANNELS.mqttRuntime),
    connect: (profileId: string, sessionPassword?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.mqttConnect, profileId, sessionPassword),
    disconnect: (profileId: string) => ipcRenderer.invoke(IPC_CHANNELS.mqttDisconnect, profileId),
    publish: (request: PublishRequest) => ipcRenderer.invoke(IPC_CHANNELS.mqttPublish, request),
    subscribe: (profileId: string, topic: string, qos: MqttQos) =>
      ipcRenderer.invoke(IPC_CHANNELS.mqttSubscribe, profileId, topic, qos),
    unsubscribe: (profileId: string, topic: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.mqttUnsubscribe, profileId, topic),
  },
  dialogs: {
    pickCertificate: () => ipcRenderer.invoke(IPC_CHANNELS.dialogPickCertificate),
    exportMessages: (options: ExportMessageOptions) =>
      ipcRenderer.invoke(IPC_CHANNELS.dialogExportMessages, options),
    importTelemetryLayout: () => ipcRenderer.invoke(IPC_CHANNELS.dialogImportTelemetryLayout),
    exportTelemetryLayout: (config: TelemetryLayoutConfig) =>
      ipcRenderer.invoke(IPC_CHANNELS.dialogExportTelemetryLayout, config),
  },
  media: {
    listServers: () => ipcRenderer.invoke(IPC_CHANNELS.mediaServersList),
    saveServer: (profile: MediaServerProfile) => ipcRenderer.invoke(IPC_CHANNELS.mediaServersSave, profile),
    removeServer: (profileId: string) => ipcRenderer.invoke(IPC_CHANNELS.mediaServersRemove, profileId),
    checkServer: (profileId: string) => ipcRenderer.invoke(IPC_CHANNELS.mediaServersCheck, profileId),
    startLocal: () => ipcRenderer.invoke(IPC_CHANNELS.mediaLocalStart),
    stopLocal: () => ipcRenderer.invoke(IPC_CHANNELS.mediaLocalStop),
    getLocalRuntime: () => ipcRenderer.invoke(IPC_CHANNELS.mediaLocalRuntime),
    negotiateWhep: (request: WhepOfferRequest) => ipcRenderer.invoke(IPC_CHANNELS.mediaWhepOffer, request),
    startRtmpRelay: (request: RtmpRelayStartRequest) => ipcRenderer.invoke(IPC_CHANNELS.mediaRtmpRelayStart, request),
    stopRtmpRelay: (relayId: string) => ipcRenderer.invoke(IPC_CHANNELS.mediaRtmpRelayStop, relayId),
    onRuntimeEvent: (listener: (runtime: MediaServerRuntime) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, runtime: MediaServerRuntime): void => listener(runtime)
      ipcRenderer.on(IPC_CHANNELS.mediaRuntimeEvent, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.mediaRuntimeEvent, handler)
    },
  },
  objectStorage: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.objectStorageList),
    save: (profile: ObjectStorageProfile) => ipcRenderer.invoke(IPC_CHANNELS.objectStorageSave, profile),
    remove: (profileId: string) => ipcRenderer.invoke(IPC_CHANNELS.objectStorageRemove, profileId),
    resolve: (profileId: string) => ipcRenderer.invoke(IPC_CHANNELS.objectStorageResolve, profileId),
  },
  firmware: {
    pickPackage: () => ipcRenderer.invoke(IPC_CHANNELS.firmwarePickPackage),
    uploadPackage: (request: FirmwareUploadRequest) => ipcRenderer.invoke(IPC_CHANNELS.firmwareUploadPackage, request),
    onUploadProgress: (listener: (progress: FirmwareUploadProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: FirmwareUploadProgress): void => listener(progress)
      ipcRenderer.on(IPC_CHANNELS.firmwareUploadProgress, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.firmwareUploadProgress, handler)
    },
  },
  events: {
    onRuntimeEvent: (listener: (event: MqttRuntimeEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, runtimeEvent: MqttRuntimeEvent): void => listener(runtimeEvent)
      ipcRenderer.on(IPC_CHANNELS.runtimeEvent, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.runtimeEvent, handler)
    },
  },
}

contextBridge.exposeInMainWorld('djiApi', api)
