import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import OSS from 'ali-oss'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type {
  FirmwareArtifact,
  FirmwarePackageSelection,
  FirmwareUploadProgress,
  FirmwareUploadRequest,
  FirmwareUploadResult,
  ObjectStorageProfile,
} from '../shared/contracts'
import type { ObjectStorageStore } from './object-storage-store'

interface SelectedPackage extends FirmwarePackageSelection {
  filePath: string
  mtimeMs: number
  selectedAt: number
}

interface UploadObjectInput {
  profile: ObjectStorageProfile
  filePath: string
  fileName: string
  fileSize: number
  objectKey: string
  expiresIn: number
  onProgress: (loaded: number) => void
}

type ObjectUploader = (input: UploadObjectInput) => Promise<string>
type ProgressSink = (progress: FirmwareUploadProgress) => void

const MAX_SELECTIONS = 20
const URL_VALIDITY_MS = 24 * 60 * 60 * 1_000
const URL_EXPIRY_SAFETY_MS = 60_000
const MULTIPART_SIZE = 10 * 1024 * 1024

const credentialExpiresAt = (expire: number): number => expire < 1_000_000_000_000 ? expire * 1_000 : expire

const fileMd5 = async (filePath: string): Promise<string> => {
  const hash = createHash('md5')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

const uploadToAliOss = async (input: UploadObjectInput): Promise<string> => {
  const endpoint = new URL(input.profile.endpoint)
  const client = new OSS({
    accessKeyId: input.profile.accessKeyId,
    accessKeySecret: input.profile.accessKeySecret,
    stsToken: input.profile.securityToken || undefined,
    bucket: input.profile.bucket,
    region: input.profile.region,
    endpoint: input.profile.endpoint,
    secure: endpoint.protocol === 'https:',
    timeout: 30 * 60 * 1_000,
  })
  await client.multipartUpload(input.objectKey, input.filePath, {
    parallel: 4,
    partSize: MULTIPART_SIZE,
    mime: 'application/octet-stream',
    progress: (percentage: number) => input.onProgress(Math.round(input.fileSize * percentage)),
  })
  return client.asyncSignatureUrl(input.objectKey, { expires: input.expiresIn, method: 'GET' })
}

const uploadToS3 = async (input: UploadObjectInput): Promise<string> => {
  const client = new S3Client({
    region: input.profile.region || 'us-east-1',
    endpoint: input.profile.endpoint,
    forcePathStyle: input.profile.provider === 'minio',
    credentials: {
      accessKeyId: input.profile.accessKeyId,
      secretAccessKey: input.profile.accessKeySecret,
      sessionToken: input.profile.securityToken || undefined,
    },
  })
  try {
    const upload = new Upload({
      client,
      queueSize: 4,
      partSize: MULTIPART_SIZE,
      leavePartsOnError: false,
      params: {
        Bucket: input.profile.bucket,
        Key: input.objectKey,
        Body: createReadStream(input.filePath),
        ContentLength: input.fileSize,
        ContentType: 'application/octet-stream',
      },
    })
    upload.on('httpUploadProgress', (progress) => input.onProgress(progress.loaded ?? 0))
    await upload.done()
    return await getSignedUrl(client, new GetObjectCommand({
      Bucket: input.profile.bucket,
      Key: input.objectKey,
      ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(input.fileName)}`,
    }), { expiresIn: input.expiresIn })
  } finally {
    client.destroy()
  }
}

export const uploadFirmwareObject: ObjectUploader = (input) =>
  input.profile.provider === 'ali' ? uploadToAliOss(input) : uploadToS3(input)

export const normalizeFirmwareObjectKey = (value: string): string => {
  const normalized = value.trim().replace(/^\/+/, '')
  if (!normalized) throw new Error('对象 Key 不能为空')
  if (Buffer.byteLength(normalized, 'utf8') > 1_024) throw new Error('对象 Key 不能超过 1024 字节')
  if (/[\0-\x1f\x7f\\]/.test(normalized)) throw new Error('对象 Key 包含无效字符')
  if (normalized.split('/').some((segment) => segment === '..')) throw new Error('对象 Key 不能包含 .. 路径段')
  return normalized
}

export class FirmwareUploadManager {
  private readonly selections = new Map<string, SelectedPackage>()
  private readonly activeUploads = new Set<string>()

  constructor(
    private readonly objectStorageStore: ObjectStorageStore,
    private readonly progressSink: ProgressSink,
    private readonly uploader: ObjectUploader = uploadFirmwareObject,
  ) {}

  async select(filePath: string): Promise<FirmwarePackageSelection> {
    const file = await stat(filePath)
    if (!file.isFile()) throw new Error('所选固件包不是普通文件')
    if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new Error('固件包为空或文件大小无效')
    const token = randomUUID()
    const selection: SelectedPackage = {
      token,
      filePath,
      fileName: basename(filePath),
      fileSize: file.size,
      md5: await fileMd5(filePath),
      mtimeMs: file.mtimeMs,
      selectedAt: Date.now(),
    }
    this.selections.set(token, selection)
    this.trimSelections()
    const { fileName, fileSize, md5 } = selection
    return { token, fileName, fileSize, md5 }
  }

  async upload(request: FirmwareUploadRequest): Promise<FirmwareUploadResult> {
    const selection = this.selections.get(request.selectionToken)
    if (!selection) return { ok: false, error: '本地固件包选择已失效，请重新选择' }
    if (this.activeUploads.has(selection.token)) return { ok: false, error: '该固件包正在上传' }
    const profile = await this.objectStorageStore.resolve(request.objectStorageProfileId)
    if (!profile) return { ok: false, error: '对象存储配置不存在' }
    const expiresAt = credentialExpiresAt(profile.expire)
    const availableValidity = expiresAt - Date.now() - URL_EXPIRY_SAFETY_MS
    if (availableValidity < 60_000) return { ok: false, error: '对象存储凭证已过期或即将过期' }
    const objectKey = normalizeFirmwareObjectKey(request.objectKey)
    const beforeUpload = await stat(selection.filePath)
    if (beforeUpload.size !== selection.fileSize || beforeUpload.mtimeMs !== selection.mtimeMs) {
      return { ok: false, error: '本地固件包在选择后已发生变化，请重新选择' }
    }

    const expiresIn = Math.max(60, Math.floor(Math.min(URL_VALIDITY_MS, availableValidity) / 1_000))
    this.activeUploads.add(selection.token)
    this.emitProgress(selection, 0)
    try {
      const fileUrl = await this.uploader({
        profile,
        filePath: selection.filePath,
        fileName: selection.fileName,
        fileSize: selection.fileSize,
        objectKey,
        expiresIn,
        onProgress: (loaded) => this.emitProgress(selection, loaded),
      })
      const afterUpload = await stat(selection.filePath)
      if (afterUpload.size !== selection.fileSize || afterUpload.mtimeMs !== selection.mtimeMs) {
        throw new Error('固件包在上传过程中发生变化，上传结果不可用于升级')
      }
      this.emitProgress(selection, selection.fileSize)
      const uploadedAt = Date.now()
      const artifact: FirmwareArtifact = {
        selectionToken: selection.token,
        objectStorageProfileId: profile.id,
        objectStorageProfileName: profile.name,
        provider: profile.provider,
        bucket: profile.bucket,
        objectKey,
        fileName: selection.fileName,
        fileSize: selection.fileSize,
        md5: selection.md5,
        fileUrl,
        urlExpiresAt: uploadedAt + expiresIn * 1_000,
        uploadedAt,
      }
      return { ok: true, artifact }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      this.activeUploads.delete(selection.token)
    }
  }

  private emitProgress(selection: SelectedPackage, loaded: number): void {
    const safeLoaded = Math.max(0, Math.min(selection.fileSize, Math.round(loaded)))
    this.progressSink({
      selectionToken: selection.token,
      loaded: safeLoaded,
      total: selection.fileSize,
      percent: Math.round((safeLoaded / selection.fileSize) * 100),
      at: Date.now(),
    })
  }

  private trimSelections(): void {
    if (this.selections.size <= MAX_SELECTIONS) return
    const removable = [...this.selections.values()]
      .filter((selection) => !this.activeUploads.has(selection.token))
      .sort((left, right) => left.selectedAt - right.selectedAt)
    while (this.selections.size > MAX_SELECTIONS && removable.length) {
      this.selections.delete(removable.shift()!.token)
    }
  }
}
