import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IPC_CHANNELS } from '../shared/channels'
import type { MapTileProbeResult, MapTileSource, OperationResult } from '../shared/contracts'
import { TERRAIN_SOURCE_KINDS } from '../shared/contracts'
import { parseTelemetryLayoutConfig } from '../shared/telemetry-layout'
import {
  validateConnectionProfile,
  validateDeviceArchives,
  validateExportMessageOptions,
  validateFirmwareUploadRequest,
  validateMapTileSource,
  validateMapTileSourceId,
  validateMediaServerProfile,
  validateObjectStorageProfile,
  validateProfileId,
  validatePublishRequest,
  validateQos,
  validateRemoteLogUploadRequest,
  validateRtmpRelayId,
  validateRtmpRelayStartRequest,
  validateSeiMessageDetailRequest,
  validateSeiParserId,
  validateSeiParserStartRequest,
  validateSpeakerAudioRecordingRequest,
  validateSessionPassword,
  validateTopic,
  validateWebDavConfig,
  validateWebDavSyncRequest,
  validateWebDavVersionId,
  validateWhepOfferRequest,
} from './ipc-validation'
import { MapTileSourceStore } from './map-tile-source-store'
import {
  MAP_TILE_SCHEME,
  MapTileProtocolHandler,
  mapTileProtocolPrivileges,
  registerMapTileProtocol,
} from './map-tile-protocol'
import {
  buildTileHeaders,
  buildTileUrl,
  findLocalTileRequest,
  resolveDirectoryTile,
  resolveMbtilesTile,
  type ResolvedTile,
  type TileRequest,
} from './map-tile-resolver'
import { MqttConnectionManager } from './mqtt-manager'
import { ProfileStore } from './profile-store'
import { MediaServerStore } from './media-server-store'
import { MediaServerManager } from './media-server-manager'
import { negotiateWhep } from './whep-client'
import { ObjectStorageStore } from './object-storage-store'
import { RtmpRelayManager } from './rtmp-relay-manager'
import { SeiParserManager } from './sei-parser-manager'
import { DeviceArchiveStore } from './device-archive-store'
import { FirmwareUploadManager, uploadFirmwareObject } from './firmware-upload-manager'
import { RemoteLogUploadManager } from './remote-log-upload-manager'
import { AppUpdateManager } from './app-update-manager'
import { WebDavConfigStore } from './webdav-config-store'
import { WebDavBackupManager } from './webdav-backup-manager'
import {
  isSameRendererFrame,
  isTrustedRendererUrl,
  validateDevelopmentRendererUrl,
} from './renderer-security'

const PRODUCT_NAME = 'DJI Cloud Studio'

// 必须在 app ready 之前注册协议特权，否则 protocol.handle 会失败
protocol.registerSchemesAsPrivileged([
  { scheme: MAP_TILE_SCHEME, privileges: mapTileProtocolPrivileges },
])

app.setName(PRODUCT_NAME)

let mainWindow: BrowserWindow | null = null
let profileStore: ProfileStore
let mqttManager: MqttConnectionManager
let mediaServerStore: MediaServerStore
let mediaServerManager: MediaServerManager
let rtmpRelayManager: RtmpRelayManager
let seiParserManager: SeiParserManager
let objectStorageStore: ObjectStorageStore
let deviceArchiveStore: DeviceArchiveStore
let firmwareUploadManager: FirmwareUploadManager
let speakerAudioUploadManager: FirmwareUploadManager
let remoteLogUploadManager: RemoteLogUploadManager
let appUpdateManager: AppUpdateManager
let webDavConfigStore: WebDavConfigStore
let webDavBackupManager: WebDavBackupManager
let mapTileSourceStore: MapTileSourceStore
let mapTileProtocolHandler: MapTileProtocolHandler
let trustedRendererUrl: string | null = null
let quitCleanupStarted = false
let quitCleanupComplete = false

const assertTrustedRenderer = (event: Electron.IpcMainInvokeEvent): void => {
  const expectedFrame = mainWindow?.webContents.mainFrame
  if (
    !mainWindow
    || mainWindow.isDestroyed()
    || !expectedFrame
    || event.sender !== mainWindow.webContents
    || !isSameRendererFrame(event.senderFrame, expectedFrame)
    || !trustedRendererUrl
    || !event.senderFrame
    || !isTrustedRendererUrl(event.senderFrame.url, trustedRendererUrl)
  ) {
    throw new Error('拒绝来自非受信页面的凭据访问')
  }
}

type IpcHandler = Parameters<typeof ipcMain.handle>[1]

const handleTrusted = (channel: string, listener: IpcHandler): void => {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedRenderer(event)
    return listener(event, ...args)
  })
}

const developmentIconPath = app.isPackaged ? undefined : join(__dirname, '../../build/icon.png')

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const operationFailure = (error: unknown): OperationResult => ({ ok: false, error: errorMessage(error) })

const PROBE_TIMEOUT_MS = 10_000

/** 探测超时的中文提示，用于替换运行时抛出的英文原文 */
const PROBE_TIMEOUT_MESSAGE = '探测超时，请检查地址与网络'

/**
 * 把探测过程中抛出的异常转成给用户看的文案。
 *
 * 只翻译「整体超时」：net.fetch 超时抛的是 DOMException（name 为 TimeoutError），
 * 其英文原文 The operation was aborted due to timeout 与界面其余中文文案不一致；
 * HTTP 401、DNS 失败等错误带有诊断价值，必须原样保留。
 *
 * @param error 探测过程中抛出的异常
 * @returns 超时的中文提示，或原始的错误信息
 */
export const mapProbeErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.name === 'TimeoutError') return PROBE_TIMEOUT_MESSAGE
  return errorMessage(error)
}

/**
 * 本地瓦片源里一张瓦片都找不到时的提示；路径填错与瓦片集为空合并成同一条。
 */
const PROBE_EMPTY_LOCAL_TILE_MESSAGE = '瓦片集为空或路径错误'

/**
 * 为探测挑一张瓦片坐标。
 *
 * 在线模板没有本地索引可查，且它本就能服务任意坐标，继续用最小缩放级的原点瓦片：
 * 若被上游拒绝，用户得到的正是「模板或密钥有问题」这个有用信号。
 * 本地源必须问数据源要一张真实存在的瓦片，否则城市级瓦片集会误报不可用。
 *
 * @param source 已校验的底图源配置
 * @returns 探测用的瓦片坐标；本地源里没有瓦片时返回 undefined
 * @throws TileRequestError 本地数据源不可读
 */
const probeTileRequest = async (source: MapTileSource): Promise<TileRequest | undefined> =>
  source.kind === 'url-template' ? { z: source.minZoom, x: 0, y: 0 } : await findLocalTileRequest(source)

/**
 * 用一张真实存在的瓦片验证底图源是否可用。
 *
 * 刻意不复用 map-tile 协议处理器：协议层为了不把磁盘绝对路径透给渲染进程，任何失败都返回无响应体的 404，
 * 而探测需要把失败原因回给用户。
 *
 * @param source 已校验的底图源配置
 * @returns 探测结果，成功时带回瓦片字节数
 */
export const probeMapTileSource = async (source: MapTileSource): Promise<MapTileProbeResult> => {
  try {
    const request = await probeTileRequest(source)
    if (!request) return { ok: false, error: PROBE_EMPTY_LOCAL_TILE_MESSAGE }
    const tile = source.kind === 'url-template'
      ? await fetchRemoteTileForProbe(source, request)
      : source.kind === 'directory'
        ? await resolveDirectoryTile(source, request)
        : await resolveMbtilesTile(source, request)
    return { ok: true, bytes: tile.body.byteLength }
  } catch (error) {
    // 超时要换成中文提示；其余错误（HTTP 状态、DNS 失败等）保留原始诊断信息
    return { ok: false, error: mapProbeErrorMessage(error) }
  }
}

/**
 * 为探测直接向上游请求一张瓦片，绕过协议处理器，以便区分「上游拒绝」与「瓦片不存在」。
 *
 * @param source 已校验的底图源配置
 * @param request 瓦片坐标
 * @returns 瓦片字节与内容类型
 * @throws Error 上游返回非成功状态，或请求超过 {@link PROBE_TIMEOUT_MS}
 */
const fetchRemoteTileForProbe = async (
  source: MapTileSource,
  request: { z: number; x: number; y: number },
): Promise<ResolvedTile> => {
  const apiKey = source.apiKey ?? ''
  const url = buildTileUrl(source, request, apiKey, 0)
  const response = await net.fetch(url, {
    headers: buildTileHeaders(source, apiKey),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`上游返回 HTTP ${response.status}`)
  return {
    body: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') ?? 'image/png',
  }
}

/**
 * 为探测解析出带 API Key 的底图源：渲染进程传来的 Key 优先，缺省时回退到已存密钥。
 *
 * Store 读回的底图源只带 hasApiKey，apiKey 永远为空；若直接用渲染进程入参探测，
 * 「打开已保存的带密钥底图源后直接点测试」会被上游当成未授权，误报探测失败。
 *
 * @param source 已校验的底图源配置
 * @param store 底图源存储，主进程中唯一能取到 API Key 明文的入口
 * @returns 补好 API Key 的底图源；渲染进程已带 Key 或 id 为空时原样返回
 */
const resolveProbeMapTileSource = async (
  source: MapTileSource,
  store: MapTileSourceStore,
): Promise<MapTileSource> => {
  // 用户可能刚改了 Key 还没保存，此时以渲染进程传来的为准
  if (source.apiKey || !source.id) return source
  // id 未知视为「没有已存密钥」，不作为错误
  const stored = await store.getWithApiKey(source.id)
  return stored?.apiKey ? { ...source, apiKey: stored.apiKey } : source
}

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
    if (mainWindow === window) {
      mainWindow = null
      trustedRendererUrl = null
    }
    void mqttManager?.disconnectAll().catch((error) => {
      console.warn('Unable to disconnect MQTT connections after window close:', error)
    })
    void mediaServerManager?.stopLocal().catch((error) => {
      console.warn('Unable to stop local ZLMediaKit after window close:', error)
    })
    void rtmpRelayManager?.close().catch((error) => {
      console.warn('Unable to stop RTMP relays after window close:', error)
    })
    seiParserManager?.close()
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event) => event.preventDefault())

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    const rendererUrl = validateDevelopmentRendererUrl(process.env.ELECTRON_RENDERER_URL)
    trustedRendererUrl = rendererUrl
    window.webContents.on('will-redirect', (event, url) => {
      if (!isTrustedRendererUrl(url, rendererUrl)) event.preventDefault()
    })
    void window.loadURL(rendererUrl)
  } else {
    const rendererPath = join(__dirname, '../renderer/index.html')
    trustedRendererUrl = pathToFileURL(rendererPath).toString()
    window.webContents.on('will-redirect', (event) => event.preventDefault())
    void window.loadFile(rendererPath)
  }
}

const registerIpc = (): void => {
  handleTrusted(IPC_CHANNELS.profilesList, () => profileStore.list())
  handleTrusted(IPC_CHANNELS.profilesResolve, (_event, rawProfileId: unknown) => {
    return profileStore.resolve(validateProfileId(rawProfileId))
  })
  handleTrusted(IPC_CHANNELS.profilesSave, async (_event, profile: unknown) => {
    const saved = await profileStore.save(validateConnectionProfile(profile))
    webDavBackupManager.notifyLocalChange()
    return saved
  })
  handleTrusted(IPC_CHANNELS.profilesRemove, async (_event, rawProfileId: unknown) => {
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

  handleTrusted(IPC_CHANNELS.deviceArchivesList, () => deviceArchiveStore.list())
  handleTrusted(IPC_CHANNELS.deviceArchivesReplaceProfile, async (_event, rawProfileId: unknown, rawArchives: unknown) => {
    const profileId = validateProfileId(rawProfileId)
    if (!await profileStore.get(profileId)) throw new Error('设备档案对应的连接配置不存在')
    const archives = await deviceArchiveStore.replaceProfile(profileId, validateDeviceArchives(profileId, rawArchives))
    return archives
  })
  handleTrusted(IPC_CHANNELS.mqttRuntime, () => mqttManager.getRuntime())
  handleTrusted(IPC_CHANNELS.mqttConnect, async (_event, rawProfileId: unknown, rawSessionPassword?: unknown) => {
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
  handleTrusted(IPC_CHANNELS.mqttDisconnect, async (_event, rawProfileId: unknown) => {
    try {
      return await mqttManager.disconnect(validateProfileId(rawProfileId))
    } catch (error) {
      return operationFailure(error)
    }
  })
  handleTrusted(IPC_CHANNELS.mqttPublish, async (_event, rawRequest: unknown) => {
    try {
      return await mqttManager.publish(validatePublishRequest(rawRequest))
    } catch (error) {
      return operationFailure(error)
    }
  })
  handleTrusted(
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
  handleTrusted(IPC_CHANNELS.mqttUnsubscribe, async (_event, rawProfileId: unknown, rawTopic: unknown) => {
    try {
      return await mqttManager.unsubscribe(
        validateProfileId(rawProfileId),
        validateTopic(rawTopic, '订阅 Topic'),
      )
    } catch (error) {
      return operationFailure(error)
    }
  })

  handleTrusted(IPC_CHANNELS.dialogPickCertificate, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择证书文件',
      properties: ['openFile'],
      filters: [{ name: '证书与密钥', extensions: ['pem', 'crt', 'cer', 'key'] }],
    })
    return result.canceled ? null : result.filePaths[0]
  })
  handleTrusted(IPC_CHANNELS.dialogExportMessages, async (_event, rawOptions: unknown) => {
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
  handleTrusted(IPC_CHANNELS.dialogImportTelemetryLayout, async () => {
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
  handleTrusted(IPC_CHANNELS.dialogExportTelemetryLayout, async (_event, rawConfig: unknown) => {
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

  handleTrusted(IPC_CHANNELS.mediaServersList, () => mediaServerStore.list())
  handleTrusted(IPC_CHANNELS.mediaServersResolve, (_event, rawProfileId: unknown) => {
    return mediaServerStore.getWithSecret(validateProfileId(rawProfileId))
  })
  handleTrusted(IPC_CHANNELS.mediaServersSave, async (_event, rawProfile: unknown) => {
    const saved = await mediaServerStore.save(validateMediaServerProfile(rawProfile))
    webDavBackupManager.notifyLocalChange()
    return saved
  })
  handleTrusted(IPC_CHANNELS.mediaServersRemove, async (_event, rawProfileId: unknown) => {
    try {
      const removed = await mediaServerStore.remove(validateProfileId(rawProfileId))
      if (removed) webDavBackupManager.notifyLocalChange()
      return removed ? { ok: true } : { ok: false, error: '媒体服务配置不存在' }
    } catch (error) {
      return operationFailure(error)
    }
  })
  handleTrusted(IPC_CHANNELS.mediaServersCheck, (_event, rawProfileId: unknown) =>
    mediaServerManager.check(validateProfileId(rawProfileId)),
  )
  handleTrusted(IPC_CHANNELS.mediaLocalStart, () => mediaServerManager.startLocal())
  handleTrusted(IPC_CHANNELS.mediaLocalStop, () => mediaServerManager.stopLocal())
  handleTrusted(IPC_CHANNELS.mediaLocalRuntime, () => mediaServerManager.getLocalRuntime())
  handleTrusted(IPC_CHANNELS.mediaWhepOffer, async (_event, rawRequest: unknown) => {
    try {
      return await negotiateWhep(validateWhepOfferRequest(rawRequest))
    } catch (error) {
      return operationFailure(error)
    }
  })
  handleTrusted(IPC_CHANNELS.mediaRtmpRelayStart, (_event, rawRequest: unknown) => {
    try {
      return rtmpRelayManager.start(validateRtmpRelayStartRequest(rawRequest).url)
    } catch (error) {
      return operationFailure(error)
    }
  })
  handleTrusted(IPC_CHANNELS.mediaRtmpRelayStop, (_event, rawRelayId: unknown) => {
    try {
      return rtmpRelayManager.stop(validateRtmpRelayId(rawRelayId))
    } catch (error) {
      return operationFailure(error)
    }
  })
  handleTrusted(IPC_CHANNELS.mediaSeiParserStart, (_event, rawRequest: unknown) => {
    try {
      return seiParserManager.start(validateSeiParserStartRequest(rawRequest))
    } catch (error) {
      return operationFailure(error)
    }
  })
  handleTrusted(IPC_CHANNELS.mediaSeiParserStop, (_event, rawSessionId: unknown) => {
    try {
      return seiParserManager.stop(validateSeiParserId(rawSessionId))
    } catch (error) {
      return operationFailure(error)
    }
  })
  handleTrusted(IPC_CHANNELS.mediaSeiMessageDetail, (_event, rawRequest: unknown) => {
    try {
      const request = validateSeiMessageDetailRequest(rawRequest)
      return seiParserManager.getMessageDetail(request.sessionId, request.messageId)
    } catch (error) {
      return operationFailure(error)
    }
  })

  handleTrusted(IPC_CHANNELS.mapSourcesList, () => mapTileSourceStore.list())
  handleTrusted(IPC_CHANNELS.mapSourcesSave, async (_event, rawSource: unknown) => {
    const saved = await mapTileSourceStore.save(validateMapTileSource(rawSource))
    // 底图源变化后缓存里的瓦片可能已失效
    mapTileProtocolHandler.clearCache()
    return saved
  })
  handleTrusted(IPC_CHANNELS.mapSourcesRemove, async (_event, rawSourceId: unknown) => {
    try {
      const removed = await mapTileSourceStore.remove(validateMapTileSourceId(rawSourceId))
      mapTileProtocolHandler.clearCache()
      return removed ? { ok: true } : { ok: false, error: '底图源不存在' }
    } catch (error) {
      return operationFailure(error)
    }
  })
  handleTrusted(IPC_CHANNELS.mapSourcesProbe, async (_event, rawSource: unknown) => {
    try {
      const source = await resolveProbeMapTileSource(validateMapTileSource(rawSource), mapTileSourceStore)
      return await probeMapTileSource(source)
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  })
  // 这是「已存凭据不回传渲染进程」不变量的唯一刻意例外，且只对地形源开口：
  // Cesium 在渲染进程内构造地形 provider，厂商地形服务要求把 token 放进查询参数或
  // Authorization 头，因此渲染进程必须拿到明文才能加载地形。影像 API Key 永不走此通道。
  handleTrusted(IPC_CHANNELS.mapGetTerrainToken, async (_event, rawSourceId: unknown) => {
    const sourceId = validateMapTileSourceId(rawSourceId)
    const source = await mapTileSourceStore.getWithApiKey(sourceId)
    // 来源不存在或不是 terrain-* 三类时一律返回空串，让渲染进程按「未填写 token」处理
    if (!source || !TERRAIN_SOURCE_KINDS.includes(source.kind)) return ''
    return source.apiKey ?? ''
  })
  handleTrusted(IPC_CHANNELS.mapPickDirectory, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择瓦片目录',
      properties: ['openDirectory'],
    })
    return result.canceled ? null : result.filePaths[0]
  })
  handleTrusted(IPC_CHANNELS.mapPickMbtiles, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择 MBTiles 文件',
      properties: ['openFile'],
      filters: [{ name: 'MBTiles', extensions: ['mbtiles'] }],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  handleTrusted(IPC_CHANNELS.objectStorageList, () => objectStorageStore.list())
  handleTrusted(IPC_CHANNELS.objectStorageSave, async (_event, rawProfile: unknown) => {
    const saved = await objectStorageStore.save(validateObjectStorageProfile(rawProfile))
    webDavBackupManager.notifyLocalChange()
    return saved
  })
  handleTrusted(IPC_CHANNELS.objectStorageRemove, async (_event, rawProfileId: unknown) => {
    try {
      const removed = await objectStorageStore.remove(validateProfileId(rawProfileId))
      if (removed) webDavBackupManager.notifyLocalChange()
      return removed ? { ok: true } : { ok: false, error: '对象存储配置不存在' }
    } catch (error) {
      return operationFailure(error)
    }
  })
  handleTrusted(IPC_CHANNELS.objectStorageResolve, (_event, rawProfileId: unknown) => {
    return objectStorageStore.resolve(validateProfileId(rawProfileId))
  })
  handleTrusted(IPC_CHANNELS.remoteLogStartUpload, async (_event, rawRequest: unknown) => {
    try {
      return await remoteLogUploadManager.start(validateRemoteLogUploadRequest(rawRequest))
    } catch (error) {
      return operationFailure(error)
    }
  })
  handleTrusted(IPC_CHANNELS.firmwarePickPackage, async () => {
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
  handleTrusted(IPC_CHANNELS.firmwareUploadPackage, (_event, rawRequest: unknown) =>
    firmwareUploadManager.upload(validateFirmwareUploadRequest(rawRequest)),
  )
  handleTrusted(IPC_CHANNELS.speakerAudioPick, async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: '选择喊话器音频',
        properties: ['openFile'],
        filters: [
          { name: '喊话器音频', extensions: ['mp3', 'wav'] },
        ],
      })
      if (result.canceled || !result.filePaths[0]) return { canceled: true }
      return { canceled: false, package: await speakerAudioUploadManager.select(result.filePaths[0]) }
    } catch (error) {
      return { canceled: false, error: errorMessage(error) }
    }
  })
  handleTrusted(IPC_CHANNELS.speakerAudioRegisterRecording, async (_event, rawRequest: unknown) => {
    try {
      const request = validateSpeakerAudioRecordingRequest(rawRequest)
      return {
        canceled: false,
        package: await speakerAudioUploadManager.selectBytes(request.fileName, request.data),
      }
    } catch (error) {
      return { canceled: false, error: errorMessage(error) }
    }
  })
  handleTrusted(IPC_CHANNELS.speakerAudioUpload, (_event, rawRequest: unknown) =>
    speakerAudioUploadManager.upload(validateFirmwareUploadRequest(rawRequest)),
  )
  handleTrusted(IPC_CHANNELS.appUpdateState, () => appUpdateManager.getState())
  handleTrusted(IPC_CHANNELS.appUpdateCheck, () => appUpdateManager.check())
  handleTrusted(IPC_CHANNELS.appUpdateDownload, () => appUpdateManager.download())
  handleTrusted(IPC_CHANNELS.appUpdateOpenInstaller, () => appUpdateManager.openInstaller())
  handleTrusted(IPC_CHANNELS.webdavOverview, () => webDavBackupManager.getOverview())
  handleTrusted(IPC_CHANNELS.webdavResolveConfig, () => {
    return webDavConfigStore.resolve()
  })
  handleTrusted(IPC_CHANNELS.webdavSaveConfig, (_event, rawConfig: unknown) =>
    webDavBackupManager.saveConfig(validateWebDavConfig(rawConfig)),
  )
  handleTrusted(IPC_CHANNELS.webdavRemoveConfig, () => webDavBackupManager.removeConfig())
  handleTrusted(IPC_CHANNELS.webdavTest, (_event, rawConfig?: unknown) =>
    webDavBackupManager.test(rawConfig === undefined ? undefined : validateWebDavConfig(rawConfig)),
  )
  handleTrusted(IPC_CHANNELS.webdavSync, (_event, rawRequest: unknown) =>
    webDavBackupManager.sync(validateWebDavSyncRequest(rawRequest)),
  )
  handleTrusted(IPC_CHANNELS.webdavChanged, (_event, rawRequest: unknown) => {
    webDavBackupManager.notifyLocalChange(validateWebDavSyncRequest(rawRequest))
  })
  handleTrusted(IPC_CHANNELS.webdavRestore, (_event, rawVersionId: unknown) =>
    webDavBackupManager.restore(validateWebDavVersionId(rawVersionId)),
  )
  handleTrusted(IPC_CHANNELS.webdavRemoveVersion, (_event, rawVersionId: unknown) =>
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
  seiParserManager = new SeiParserManager((event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.mediaSeiParserEvent, event)
    }
  })
  objectStorageStore = new ObjectStorageStore()
  remoteLogUploadManager = new RemoteLogUploadManager(objectStorageStore, mqttManager, profileStore)
  firmwareUploadManager = new FirmwareUploadManager(objectStorageStore, (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.firmwareUploadProgress, progress)
    }
  })
  speakerAudioUploadManager = new FirmwareUploadManager(objectStorageStore, (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.speakerAudioUploadProgress, progress)
    }
  }, uploadFirmwareObject, '音频文件')
  deviceArchiveStore = new DeviceArchiveStore()
  webDavConfigStore = new WebDavConfigStore()
  webDavBackupManager = new WebDavBackupManager(
    webDavConfigStore,
    profileStore,
    mediaServerStore,
    objectStorageStore,
    async (profileIds) => {
      await Promise.all(profileIds.map((profileId) => mqttManager.disconnect(profileId)))
    },
    (syncEvent) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.webdavSyncEvent, syncEvent)
      }
    },
  )
  appUpdateManager = new AppUpdateManager((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_CHANNELS.appUpdateEvent, state)
  })
  // 协议处理必须在 app ready 之后注册，且早于任何渲染进程请求
  mapTileSourceStore = new MapTileSourceStore()
  mapTileProtocolHandler = new MapTileProtocolHandler(mapTileSourceStore)
  registerMapTileProtocol(mapTileProtocolHandler)
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
    speakerAudioUploadManager ? speakerAudioUploadManager.dispose() : Promise.resolve(),
    Promise.resolve(seiParserManager?.close()),
  ]).then(() => undefined)
  void cleanup
    .catch((error) => console.warn('Unable to disconnect MQTT connections before quit:', error))
    .finally(() => {
      quitCleanupComplete = true
      app.quit()
    })
})
