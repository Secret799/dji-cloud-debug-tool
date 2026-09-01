import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ObjectStorageProfile } from '../shared/contracts'
import { FirmwareUploadManager, normalizeFirmwareObjectKey } from './firmware-upload-manager'

const profile: ObjectStorageProfile = {
  id: 'oss-1', name: '升级存储', provider: 'minio', bucket: 'firmware', region: '',
  endpoint: 'https://minio.example.com', accessKeyId: 'id', accessKeySecret: 'secret', securityToken: '',
  createdAt: 1, updatedAt: 1,
}

describe('FirmwareUploadManager', () => {
  let directory = ''
  let filePath = ''

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dji-firmware-upload-'))
    filePath = join(directory, 'dock firmware.zip')
    await writeFile(filePath, 'firmware-content')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('inspects a local package and uploads it through the selected OSS profile', async () => {
    const progress = vi.fn()
    const uploader = vi.fn(async (input) => {
      input.onProgress(input.fileSize / 2)
      return 'https://minio.example.com/signed-firmware'
    })
    const store = { resolve: vi.fn(async () => profile) }
    const manager = new FirmwareUploadManager(store as never, progress, uploader)
    const selected = await manager.select(filePath)
    expect(selected).toMatchObject({
      fileName: 'dock firmware.zip', fileSize: 16, md5: '9996ef0a4ed117e76d529396d8279dea',
    })

    const result = await manager.upload({
      selectionToken: selected.token,
      objectStorageProfileId: profile.id,
      objectKey: 'firmware/dock/package.zip',
    })
    expect(result).toMatchObject({
      ok: true,
      artifact: {
        objectStorageProfileName: '升级存储',
        objectKey: 'firmware/dock/package.zip',
        fileName: 'dock firmware.zip',
        fileSize: 16,
        md5: '9996ef0a4ed117e76d529396d8279dea',
        fileUrl: 'https://minio.example.com/signed-firmware',
      },
    })
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ percent: 50 }))
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ percent: 100 }))
    expect(uploader).toHaveBeenCalledWith(expect.objectContaining({ expiresIn: 24 * 60 * 60 }))
  })

  it('rejects a local file changed after selection', async () => {
    const uploader = vi.fn(async () => 'https://example.com/file')
    const manager = new FirmwareUploadManager({ resolve: async () => profile } as never, vi.fn(), uploader)
    const selected = await manager.select(filePath)
    await writeFile(filePath, 'changed-firmware-content')
    await expect(manager.upload({
      selectionToken: selected.token, objectStorageProfileId: profile.id, objectKey: 'firmware/file.zip',
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('发生变化') })
    expect(uploader).not.toHaveBeenCalled()
  })

  it('registers in-memory recordings as temporary upload selections', async () => {
    const uploader = vi.fn(async () => 'https://example.com/voice.wav')
    const manager = new FirmwareUploadManager({ resolve: async () => profile } as never, vi.fn(), uploader, '音频文件')
    const selected = await manager.selectBytes('voice-1.wav', new TextEncoder().encode('recorded-audio'))
    const result = await manager.upload({
      selectionToken: selected.token,
      objectStorageProfileId: profile.id,
      objectKey: 'speaker/voice-1.wav',
    })
    expect(selected).toMatchObject({ fileName: 'voice-1.wav', fileSize: 14 })
    expect(result).toMatchObject({ ok: true, artifact: { fileName: 'voice-1.wav' } })
    await manager.dispose()
  })
})

describe('firmware object keys', () => {
  it('normalizes safe object keys and rejects traversal', () => {
    expect(normalizeFirmwareObjectKey('/firmware/dock/file.zip')).toBe('firmware/dock/file.zip')
    expect(() => normalizeFirmwareObjectKey('firmware/../secret')).toThrow('不能包含 ..')
  })
})
