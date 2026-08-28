import type { ConnectionProfile, DeviceType } from '../../../shared/contracts'
import { mergeNestedRecords, telemetryValue, type DeviceTelemetry } from './dji'

export interface CameraVideoStream {
  id: string
  gatewaySn: string
  sourceSn: string
  cameraIndex: string
  videoIndex: string
  videoType: string
  switchableVideoTypes: string[]
  status?: number
  errorStatus?: number
  videoQuality?: number
}

export interface CameraSource {
  id: string
  gatewaySn: string
  gatewayName: string
  sourceSn: string
  sourceName: string
  sourceType: DeviceType
  cameraIndex: string
  online: boolean
  availableVideoNumber?: number
  coexistVideoNumberMax?: number
  videos: CameraVideoStream[]
}

export interface CameraLiveCapacity {
  availableVideoNumber?: number
  coexistVideoNumberMax?: number
  currentVideoNumber?: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const textValue = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

const numberValue = (value: unknown): number | undefined => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

export const normalizeLiveResultCode = (code?: number): number | undefined =>
  code !== undefined && code >= 513001 && code <= 513099 ? code - 500000 : code

const recordArray = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : []

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(textValue).filter((item): item is string => Boolean(item)) : []

const cameraId = (gatewaySn: string, sourceSn: string, cameraIndex: string): string =>
  `${gatewaySn}:${sourceSn}:${cameraIndex}`

const sourceFallbackName = (type: DeviceType, sn: string): string =>
  `${type === 'dock' ? '机场' : type === 'aircraft' ? '飞机' : '遥控器'} ${sn}`

export const videoTypeLabel = (type: string): string => ({
  normal: '普通',
  wide: '广角',
  zoom: '变焦',
  ir: '红外',
  infrared: '红外',
  thermal: '热成像',
}[type.toLowerCase()] ?? type)

export const cameraStreamName = (stream: CameraVideoStream): string =>
  `${stream.sourceSn}-${stream.cameraIndex}-${stream.videoIndex}`
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'dji-camera'

export const cameraLiveCapacity = (
  telemetry: DeviceTelemetry[],
  gatewaySn: string,
): CameraLiveCapacity => {
  const gateway = telemetry.find((device) => device.sn === gatewaySn)
  if (!gateway) return {}
  const source = mergeNestedRecords(gateway.status, gateway.state, gateway.osd)
  const capacity = telemetryValue(source, 'live_capacity')
  const liveStatus = telemetryValue(source, 'live_status')
  const currentVideoNumber = Array.isArray(liveStatus)
    ? new Set(recordArray(liveStatus)
      .filter((status) => numberValue(status.status) === 1)
      .map((status, index) => textValue(status.video_id) ?? `unknown-${index}`)).size
    : undefined
  return {
    availableVideoNumber: isRecord(capacity) ? numberValue(capacity.available_video_number) : undefined,
    coexistVideoNumberMax: isRecord(capacity) ? numberValue(capacity.coexist_video_number_max) : undefined,
    currentVideoNumber,
  }
}

export function collectCameraSources(
  profile: ConnectionProfile,
  telemetry: DeviceTelemetry[],
): CameraSource[] {
  const configuredBySn = new Map(profile.devices.map((device) => [device.sn, device]))
  const telemetryBySn = new Map(telemetry.map((device) => [device.sn, device]))
  const cameras = new Map<string, CameraSource>()

  const addCamera = (camera: CameraSource): void => {
    const current = cameras.get(camera.id)
    if (!current) {
      cameras.set(camera.id, camera)
      return
    }
    const videos = new Map(current.videos.map((video) => [video.id, video]))
    camera.videos.forEach((video) => videos.set(video.id, { ...videos.get(video.id), ...video }))
    cameras.set(camera.id, {
      ...current,
      ...camera,
      online: current.online || camera.online,
      videos: [...videos.values()],
    })
  }

  telemetry
    .filter((gateway) => gateway.type === 'dock' || gateway.type === 'pilot')
    .forEach((gateway) => {
      const source = mergeNestedRecords(gateway.status, gateway.state, gateway.osd)
      const capacity = telemetryValue(source, 'live_capacity')
      if (!isRecord(capacity)) return

      const liveStatusByVideoId = new Map(
        recordArray(telemetryValue(source, 'live_status'))
          .map((status) => [textValue(status.video_id), status] as const)
          .filter((entry): entry is [string, Record<string, unknown>] => Boolean(entry[0])),
      )

      recordArray(capacity.device_list).forEach((deviceSource) => {
        const sourceSn = textValue(deviceSource.sn)
        if (!sourceSn) return
        const configured = configuredBySn.get(sourceSn)
        const runtime = telemetryBySn.get(sourceSn)
        const sourceType = configured?.type ?? runtime?.type ?? (sourceSn === gateway.sn ? gateway.type : 'aircraft')
        const sourceName = configured?.name ?? runtime?.name ?? sourceFallbackName(sourceType, sourceSn)

        recordArray(deviceSource.camera_list).forEach((camera) => {
          const cameraIndex = textValue(camera.camera_index)
          if (!cameraIndex) return
          const videos = recordArray(camera.video_list).flatMap((video): CameraVideoStream[] => {
            const videoIndex = textValue(video.video_index)
            if (!videoIndex) return []
            const id = `${sourceSn}/${cameraIndex}/${videoIndex}`
            const liveStatus = liveStatusByVideoId.get(id)
            return [{
              id,
              gatewaySn: gateway.sn,
              sourceSn,
              cameraIndex,
              videoIndex,
              videoType: textValue(video.video_type) ?? videoIndex,
              switchableVideoTypes: stringArray(video.switchable_video_types),
              status: numberValue(liveStatus?.status),
              errorStatus: numberValue(liveStatus?.error_status),
              videoQuality: numberValue(liveStatus?.video_quality),
            }]
          })
          addCamera({
            id: cameraId(gateway.sn, sourceSn, cameraIndex),
            gatewaySn: gateway.sn,
            gatewayName: configuredBySn.get(gateway.sn)?.name ?? gateway.name,
            sourceSn,
            sourceName,
            sourceType,
            cameraIndex,
            online: runtime?.online ?? gateway.online,
            availableVideoNumber: numberValue(camera.available_video_number),
            coexistVideoNumberMax: numberValue(camera.coexist_video_number_max),
            videos,
          })
        })
      })
    })

  telemetry.filter((device) => device.type === 'aircraft').forEach((aircraft) => {
    const configured = configuredBySn.get(aircraft.sn)
    const gatewaySn = aircraft.gatewaySn ?? configured?.parentSn
    if (!gatewaySn) return
    const source = mergeNestedRecords(aircraft.status, aircraft.state, aircraft.osd)
    recordArray(telemetryValue(source, 'cameras')).forEach((camera) => {
      const cameraIndex = textValue(camera.payload_index)
      if (!cameraIndex) return
      addCamera({
        id: cameraId(gatewaySn, aircraft.sn, cameraIndex),
        gatewaySn,
        gatewayName: configuredBySn.get(gatewaySn)?.name ?? telemetryBySn.get(gatewaySn)?.name ?? sourceFallbackName('dock', gatewaySn),
        sourceSn: aircraft.sn,
        sourceName: configured?.name ?? aircraft.name,
        sourceType: 'aircraft',
        cameraIndex,
        online: aircraft.online,
        videos: [],
      })
    })
  })

  return [...cameras.values()]
    .map((camera) => ({
      ...camera,
      videos: [...camera.videos].sort((left, right) => left.videoIndex.localeCompare(right.videoIndex)),
    }))
    .sort((left, right) =>
      left.gatewayName.localeCompare(right.gatewayName, 'zh-CN')
      || left.sourceName.localeCompare(right.sourceName, 'zh-CN')
      || left.cameraIndex.localeCompare(right.cameraIndex),
    )
}
