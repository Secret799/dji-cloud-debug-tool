import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
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
  temporaryDirectory?: string
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
const MULTIPART_SIZE = 10 * 1024 * 1024

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
    private readonly fileLabel = '固件包',
  ) {}

  async select(filePath: string): Promise<FirmwarePackageSelection> {
    return this.selectPath(filePath)
  }

  async selectBytes(fileName: string, data: Uint8Array): Promise<FirmwarePackageSelection> {
    const safeName = basename(fileName)
    if (safeName !== fileName || !safeName) throw new Error(`${this.fileLabel}文件名无效`)
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'dji-speaker-audio-'))
    const filePath = join(temporaryDirectory, safeName)
    try {
      await writeFile(filePath, data)
      return await this.selectPath(filePath, temporaryDirectory)
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true })
      throw error
    }
  }

  async dispose(): Promise<void> {
    const directories = new Set([...this.selections.values()]
      .map((selection) => selection.temporaryDirectory)
      .filter((directory): directory is string => Boolean(directory)))
    this.selections.clear()
    await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })))
  }

  private async selectPath(filePath: string, temporaryDirectory?: string): Promise<FirmwarePackageSelection> {
    const file = await stat(filePath)
    if (!file.isFile()) throw new Error(`所选${this.fileLabel}不是普通文件`)
    if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new Error(`${this.fileLabel}为空或文件大小无效`)
    const token = randomUUID()
    const selection: SelectedPackage = {
      token,
      filePath,
      temporaryDirectory,
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
    if (!selection) return { ok: false, error: `本地${this.fileLabel}选择已失效，请重新选择` }
    if (this.activeUploads.has(selection.token)) return { ok: false, error: `该${this.fileLabel}正在上传` }
    const profile = await this.objectStorageStore.resolve(request.objectStorageProfileId)
    if (!profile) return { ok: false, error: '对象存储配置不存在' }
    const objectKey = normalizeFirmwareObjectKey(request.objectKey)
    const beforeUpload = await stat(selection.filePath)
    if (beforeUpload.size !== selection.fileSize || beforeUpload.mtimeMs !== selection.mtimeMs) {
      return { ok: false, error: `本地${this.fileLabel}在选择后已发生变化，请重新选择` }
    }

    const expiresIn = URL_VALIDITY_MS / 1_000
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
        throw new Error(`${this.fileLabel}在上传过程中发生变化，上传结果不可用`)
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
      const selection = removable.shift()!
      this.selections.delete(selection.token)
      if (selection.temporaryDirectory) {
        void rm(selection.temporaryDirectory, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }
}
