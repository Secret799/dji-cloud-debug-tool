import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC_CHANNELS } from '../shared/channels'
import type { OperationResult } from '../shared/contracts'
import { parseTelemetryLayoutConfig } from '../shared/telemetry-layout'
import {
  validateConnectionProfile,
  validateDeviceArchives,
  validateExportMessageOptions,
  validateFirmwareUploadRequest,
  validateMediaServerProfile,
  validateObjectStorageProfile,
  validateProfileId,
  validatePublishRequest,
  validateQos,
  validateRtmpRelayId,
  validateRtmpRelayStartRequest,
  validateSessionPassword,
  validateTopic,
  validateWebDavConfig,
  validateWebDavSyncRequest,
  validateWebDavVersionId,
  validateWhepOfferRequest,
} from './ipc-validation'
import { MqttConnectionManager } from './mqtt-manager'
import { ProfileStore } from './profile-store'
import { MediaServerStore } from './media-server-store'
import { MediaServerManager } from './media-server-manager'
import { negotiateWhep } from './whep-client'
import { ObjectStorageStore } from './object-storage-store'
import { RtmpRelayManager } from './rtmp-relay-manager'
import { DeviceArchiveStore } from './device-archive-store'
import { FirmwareUploadManager } from './firmware-upload-manager'
import { AppUpdateManager } from './app-update-manager'
import { WebDavConfigStore } from './webdav-config-store'
import { WebDavBackupManager } from './webdav-backup-manager'

const PRODUCT_NAME = 'DJI Cloud Studio'

app.setName(PRODUCT_NAME)

let mainWindow: BrowserWindow | null = null
let profileStore: ProfileStore
let mqttManager: MqttConnectionManager
let mediaServerStore: MediaServerStore
let mediaServerManager: MediaServerManager
let rtmpRelayManager: RtmpRelayManager
let objectStorageStore: ObjectStorageStore
let deviceArchiveStore: DeviceArchiveStore
let firmwareUploadManager: FirmwareUploadManager
let appUpdateManager: AppUpdateManager
let webDavBackupManager: WebDavBackupManager
let quitCleanupStarted = false
let quitCleanupComplete = false

const developmentIconPath = app.isPackaged ? undefined : join(__dirname, '../../build/icon.png')

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const operationFailure = (error: unknown): OperationResult => ({ ok: false, error: errorMessage(error) })

const createWindow = (): void => {
  const window = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#f4f5f2',
    icon: developmentIconPath,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow = window

  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) window.show()
  })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
    void mqttManager?.disconnectAll().catch((error) => {
      console.warn('Unable to disconnect MQTT connections after window close:', error)
    })
    void mediaServerManager?.stopLocal().catch((error) => {
      console.warn('Unable to stop local ZLMediaKit after window close:', error)
    })
    void rtmpRelayManager?.close().catch((error) => {
      console.warn('Unable to stop RTMP relays after window close:', error)
    })
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event) => event.preventDefault())

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const registerIpc = (): void => {
  ipcMain.handle(IPC_CHANNELS.profilesList, () => profileStore.list())
  ipcMain.handle(IPC_CHANNELS.profilesSave, async (_event, profile: unknown) => {
    const saved = await profileStore.save(validateConnectionProfile(profile))
    webDavBackupManager.notifyLocalChange()
    return saved
  })
  ipcMain.handle(IPC_CHANNELS.profilesRemove, async (_event, rawProfileId: unknown) => {
    try {
      const profileId = validateProfileId(rawProfileId)
      await mqttManager.disconnect(profileId)
      const removed = await profileStore.remove(profileId)
      if (removed) await deviceArchiveStore.removeProfile(profileId)
      if (removed) webDavBackupManager.notifyLocalChange()
      return removed ? { ok: true } : { ok: false, error: '未找到连接配置' }
    } catch (error) {
      return operationFailure(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.deviceArchivesList, () => deviceArchiveStore.list())
  ipcMain.handle(IPC_CHANNELS.deviceArchivesReplaceProfile, async (_event, rawProfileId: unknown, rawArchives: unknown) => {
    const profileId = validateProfileId(rawProfileId)
    if (!await profileStore.get(profileId)) throw new Error('设备档案对应的连接配置不存在')
    const archives = await deviceArchiveStore.replaceProfile(profileId, validateDeviceArchives(profileId, rawArchives))
    return archives
  })
  ipcMain.handle(IPC_CHANNELS.mqttRuntime, () => mqttManager.getRuntime())
  ipcMain.handle(IPC_CHANNELS.mqttConnect, async (_event, rawProfileId: unknown, rawSessionPassword?: unknown) => {
    try {
      const profileId = validateProfileId(rawProfileId)
      const sessionPassword = validateSessionPassword(rawSessionPassword)
      const connection = await profileStore.getForConnection(profileId, sessionPassword)
      if (!connection) return { ok: false, error: '未找到连接配置' }
      return mqttManager.connect(connection.profile, connection.password)
    } catch (error) {
      return operationFailure(error)
    }
  })
  ipcMain.handle(IPC_CHANNELS.mqttDisconnect, async (_event, rawProfileId: unknown) => {
    try {
      return await mqttManager.disconnect(validateProfileId(rawProfileId))
    } catch (error) {
      return operationFailure(error)
    }
  })
  ipcMain.handle(IPC_CHANNELS.mqttPublish, async (_event, rawRequest: unknown) => {
    try {
      return await mqttManager.publish(validatePublishRequest(rawRequest))
    } catch (error) {
      return operationFailure(error)
    }
  })
  ipcMain.handle(
    IPC_CHANNELS.mqttSubscribe,
    async (_event, rawProfileId: unknown, rawTopic: unknown, rawQos: unknown) => {
      try {
        return await mqttManager.subscribe(
          validateProfileId(rawProfileId),
          validateTopic(rawTopic, '订阅 Topic'),
          validateQos(rawQos),
        )
      } catch (error) {
        return operationFailure(error)
      }
    },
  )
  ipcMain.handle(IPC_CHANNELS.mqttUnsubscribe, async (_event, rawProfileId: unknown, rawTopic: unknown) => {
    try {
      return await mqttManager.unsubscribe(
        validateProfileId(rawProfileId),
        validateTopic(rawTopic, '订阅 Topic'),
      )
    } catch (error) {
      return operationFailure(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.dialogPickCertificate, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择证书文件',
      properties: ['openFile'],
      filters: [{ name: '证书与密钥', extensions: ['pem', 'crt', 'cer', 'key'] }],
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle(IPC_CHANNELS.dialogExportMessages, async (_event, rawOptions: unknown) => {
    try {
      const options = validateExportMessageOptions(rawOptions)
      const safeName = options.profileName.replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
      const result = await dialog.showSaveDialog({
        title: '导出 MQTT 抓包',
        defaultPath: `${safeName || 'mqtt'}-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`,
        filters: [{ name: 'NDJSON', extensions: ['ndjson'] }],
      })
      if (result.canceled || !result.filePath) return { ok: false, error: '已取消导出' }
      await writeFile(result.filePath, options.content, 'utf8')
      return { ok: true }
    } catch (error) {
      return operationFailure(error)
    }
  })
  ipcMain.handle(IPC_CHANNELS.dialogImportTelemetryLayout, async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: '导入遥测项配置',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })
      if (result.canceled || !result.filePaths[0]) return { canceled: true }
      const filePath = result.filePaths[0]
      const fileStat = await stat(filePath)
      if (fileStat.size > 5 * 1024 * 1024) return { canceled: false, error: '配置文件不能超过 5 MiB' }
      const data = parseTelemetryLayoutConfig(JSON.parse(await readFile(filePath, 'utf8')) as unknown)
      return { canceled: false, data }
    } catch (error) {
      return { canceled: false, error: errorMessage(error) }
    }
  })
  ipcMain.handle(IPC_CHANNELS.dialogExportTelemetryLayout, async (_event, rawConfig: unknown) => {
    try {
      const serialized = JSON.stringify(rawConfig)
      if (Buffer.byteLength(serialized, 'utf8') > 5 * 1024 * 1024) {
        return { ok: false, error: '遥测项配置不能超过 5 MiB' }
      }
      const config = parseTelemetryLayoutConfig(rawConfig)
      const result = await dialog.showSaveDialog({
        title: '导出遥测项配置',
        defaultPath: `telemetry-layout-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })
      if (result.canceled || !result.filePath) return { ok: false, error: '已取消导出' }
      await writeFile(result.filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
      return { ok: true }
    } catch (error) {
      return operationFailure(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.mediaServersList, () => mediaServerStore.list())
  ipcMain.handle(IPC_CHANNELS.mediaServersSave, async (_event, rawProfile: unknown) => {
    const saved = await mediaServerStore.save(validateMediaServerProfile(rawProfile))
    webDavBackupManager.notifyLocalChange()
    return saved
  })
  ipcMain.handle(IPC_CHANNELS.mediaServersRemove, async (_event, rawProfileId: unknown) => {
    try {
      const removed = await mediaServerStore.remove(validateProfileId(rawProfileId))
      if (removed) webDavBackupManager.notifyLocalChange()
      return removed ? { ok: true } : { ok: false, error: '媒体服务配置不存在' }
    } catch (error) {
      return operationFailure(error)
    }
  })
  ipcMain.handle(IPC_CHANNELS.mediaServersCheck, (_event, rawProfileId: unknown) =>
    mediaServerManager.check(validateProfileId(rawProfileId)),
  )
  ipcMain.handle(IPC_CHANNELS.mediaLocalStart, () => mediaServerManager.startLocal())
  ipcMain.handle(IPC_CHANNELS.mediaLocalStop, () => mediaServerManager.stopLocal())
  ipcMain.handle(IPC_CHANNELS.mediaLocalRuntime, () => mediaServerManager.getLocalRuntime())
  ipcMain.handle(IPC_CHANNELS.mediaWhepOffer, async (_event, rawRequest: unknown) => {
    try {
      return await negotiateWhep(validateWhepOfferRequest(rawRequest))
    } catch (error) {
      return operationFailure(error)
    }
  })
  ipcMain.handle(IPC_CHANNELS.mediaRtmpRelayStart, (_event, rawRequest: unknown) => {
    try {
      return rtmpRelayManager.start(validateRtmpRelayStartRequest(rawRequest).url)
    } catch (error) {
      return operationFailure(error)
    }
  })
  ipcMain.handle(IPC_CHANNELS.mediaRtmpRelayStop, (_event, rawRelayId: unknown) => {
    try {
      return rtmpRelayManager.stop(validateRtmpRelayId(rawRelayId))
    } catch (error) {
      return operationFailure(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.objectStorageList, () => objectStorageStore.list())
  ipcMain.handle(IPC_CHANNELS.objectStorageSave, async (_event, rawProfile: unknown) => {
    const saved = await objectStorageStore.save(validateObjectStorageProfile(rawProfile))
    webDavBackupManager.notifyLocalChange()
    return saved
  })
  ipcMain.handle(IPC_CHANNELS.objectStorageRemove, async (_event, rawProfileId: unknown) => {
    try {
      const removed = await objectStorageStore.remove(validateProfileId(rawProfileId))
      if (removed) webDavBackupManager.notifyLocalChange()
      return removed ? { ok: true } : { ok: false, error: '对象存储配置不存在' }
    } catch (error) {
      return operationFailure(error)
    }
  })
  ipcMain.handle(IPC_CHANNELS.objectStorageResolve, (_event, rawProfileId: unknown) =>
    objectStorageStore.resolve(validateProfileId(rawProfileId)),
  )
  ipcMain.handle(IPC_CHANNELS.firmwarePickPackage, async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: '选择本地固件包',
        properties: ['openFile'],
        filters: [
          { name: '固件包', extensions: ['zip', 'bin', 'tar', 'gz', 'tgz', 'pkg'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      })
      if (result.canceled || !result.filePaths[0]) return { canceled: true }
      return { canceled: false, package: await firmwareUploadManager.select(result.filePaths[0]) }
    } catch (error) {
      return { canceled: false, error: errorMessage(error) }
    }
  })
  ipcMain.handle(IPC_CHANNELS.firmwareUploadPackage, (_event, rawRequest: unknown) =>
    firmwareUploadManager.upload(validateFirmwareUploadRequest(rawRequest)),
  )
  ipcMain.handle(IPC_CHANNELS.appUpdateState, () => appUpdateManager.getState())
  ipcMain.handle(IPC_CHANNELS.appUpdateCheck, () => appUpdateManager.check())
  ipcMain.handle(IPC_CHANNELS.appUpdateDownload, () => appUpdateManager.download())
  ipcMain.handle(IPC_CHANNELS.appUpdateOpenInstaller, () => appUpdateManager.openInstaller())
  ipcMain.handle(IPC_CHANNELS.webdavOverview, () => webDavBackupManager.getOverview())
  ipcMain.handle(IPC_CHANNELS.webdavSaveConfig, (_event, rawConfig: unknown) =>
    webDavBackupManager.saveConfig(validateWebDavConfig(rawConfig)),
  )
  ipcMain.handle(IPC_CHANNELS.webdavRemoveConfig, () => webDavBackupManager.removeConfig())
  ipcMain.handle(IPC_CHANNELS.webdavTest, (_event, rawConfig?: unknown) =>
    webDavBackupManager.test(rawConfig === undefined ? undefined : validateWebDavConfig(rawConfig)),
  )
  ipcMain.handle(IPC_CHANNELS.webdavSync, (_event, rawRequest: unknown) =>
    webDavBackupManager.sync(validateWebDavSyncRequest(rawRequest)),
  )
  ipcMain.handle(IPC_CHANNELS.webdavChanged, (_event, rawRequest: unknown) => {
    webDavBackupManager.notifyLocalChange(validateWebDavSyncRequest(rawRequest))
  })
  ipcMain.handle(IPC_CHANNELS.webdavRestore, (_event, rawVersionId: unknown) =>
    webDavBackupManager.restore(validateWebDavVersionId(rawVersionId)),
  )
  ipcMain.handle(IPC_CHANNELS.webdavRemoveVersion, (_event, rawVersionId: unknown) =>
    webDavBackupManager.removeVersion(validateWebDavVersionId(rawVersionId)),
  )
}

app.whenReady().then(() => {
  if (process.platform === 'darwin' && developmentIconPath) {
    app.dock?.setIcon(developmentIconPath)
  }

  profileStore = new ProfileStore()
  mqttManager = new MqttConnectionManager((event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.runtimeEvent, event)
    }
  })
  mediaServerStore = new MediaServerStore()
  mediaServerManager = new MediaServerManager(mediaServerStore, (runtime) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_CHANNELS.mediaRuntimeEvent, runtime)
  })
  rtmpRelayManager = new RtmpRelayManager()
  objectStorageStore = new ObjectStorageStore()
  firmwareUploadManager = new FirmwareUploadManager(objectStorageStore, (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.firmwareUploadProgress, progress)
    }
  })
  deviceArchiveStore = new DeviceArchiveStore()
  webDavBackupManager = new WebDavBackupManager(
    new WebDavConfigStore(),
    profileStore,
    mediaServerStore,
    objectStorageStore,
    () => mqttManager.disconnectAll(),
    (rendererStorage) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.webdavRemoteData, rendererStorage)
      }
    },
  )
  appUpdateManager = new AppUpdateManager((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_CHANNELS.appUpdateEvent, state)
  })
  registerIpc()
  createWindow()
  setTimeout(() => void appUpdateManager.check(), 5_000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (quitCleanupComplete) return
  event.preventDefault()
  if (quitCleanupStarted) return
  quitCleanupStarted = true

  const cleanup = Promise.all([
    webDavBackupManager ? webDavBackupManager.flushPending() : Promise.resolve(),
    mqttManager ? mqttManager.disconnectAll() : Promise.resolve(),
    mediaServerManager ? mediaServerManager.stopLocal().then(() => undefined) : Promise.resolve(),
    rtmpRelayManager ? rtmpRelayManager.close() : Promise.resolve(),
  ]).then(() => undefined)
  void cleanup
    .catch((error) => console.warn('Unable to disconnect MQTT connections before quit:', error))
    .finally(() => {
      quitCleanupComplete = true
      app.quit()
    })
})
