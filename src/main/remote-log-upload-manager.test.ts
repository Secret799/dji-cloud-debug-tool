import { describe, expect, it, vi } from 'vitest'
import type { ConnectionProfile, ObjectStorageProfile, RemoteLogUploadRequest } from '../shared/contracts'
import { RemoteLogUploadManager } from './remote-log-upload-manager'

const storageProfile = (overrides: Partial<ObjectStorageProfile> = {}): ObjectStorageProfile => ({
  id: 'storage-1',
  name: '日志存储',
  provider: 'ali',
  bucket: 'flight-logs',
  region: 'cn-hangzhou',
  endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
  accessKeyId: 'access-id',
  accessKeySecret: 'access-secret',
  securityToken: 'session-token',
  expire: Date.now() + 60_000,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

const uploadRequest = (): RemoteLogUploadRequest => ({
  profileId: 'profile-1',
  gatewaySn: 'DOCK-1',
  objectStorageProfileId: 'storage-1',
  files: [
    { module: '3', bootIndex: 10 },
    { module: '3', bootIndex: 11 },
    { module: '3', bootIndex: 10 },
    { module: '0', bootIndex: 20 },
  ],
  objectKeys: { '0': 'logs/aircraft.log', '3': 'logs/dock.log' },
})

const connectionProfile = (overrides: Partial<ConnectionProfile> = {}): ConnectionProfile => ({
  id: 'profile-1',
  name: 'Test',
  protocol: 'mqtt',
  host: 'localhost',
  port: 1883,
  path: '/mqtt',
  clientId: 'client-1',
  username: '',
  password: '',
  mqttVersion: '3.1.1',
  clean: true,
  keepalive: 60,
  connectTimeout: 10,
  reconnectPeriod: 3,
  rejectUnauthorized: true,
  caPath: '',
  certPath: '',
  keyPath: '',
  devices: [{ id: 'dock', name: 'Dock', sn: 'DOCK-1', type: 'dock', provider: 'dji' }],
  subscriptions: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

const profileReader = (profile: ConnectionProfile | undefined = connectionProfile()) => ({
  get: vi.fn().mockResolvedValue(profile),
})

describe('RemoteLogUploadManager', () => {
  it('resolves credentials in main and publishes a grouped fileupload_start command', async () => {
    const resolve = vi.fn().mockResolvedValue(storageProfile())
    const publish = vi.fn().mockResolvedValue({ ok: true })
    const request = uploadRequest()
    const manager = new RemoteLogUploadManager({ resolve }, { publish }, profileReader())

    await expect(manager.start(request)).resolves.toEqual({ ok: true })

    expect(JSON.stringify(request)).not.toMatch(/access.?key.?secret|security.?token/i)
    expect(resolve).toHaveBeenCalledWith('storage-1')
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      profileId: 'profile-1',
      topic: 'thing/product/DOCK-1/services',
      qos: 1,
      retain: false,
    }))
    const published = publish.mock.calls[0][0] as { payload: string }
    const payload = JSON.parse(published.payload)
    expect(payload).toMatchObject({
      method: 'fileupload_start',
      data: {
        bucket: 'flight-logs',
        region: 'cn-hangzhou',
        endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
        provider: 'ali',
        credentials: {
          access_key_id: 'access-id',
          access_key_secret: 'access-secret',
          security_token: 'session-token',
        },
        params: { files: [
          { object_key: 'logs/dock.log', module: '3', list: [{ boot_index: 10 }, { boot_index: 11 }] },
          { object_key: 'logs/aircraft.log', module: '0', list: [{ boot_index: 20 }] },
        ] },
      },
    })
  })

  it('does not publish when the storage profile is missing', async () => {
    const publish = vi.fn()
    const manager = new RemoteLogUploadManager(
      { resolve: vi.fn().mockResolvedValue(undefined) },
      { publish },
      profileReader(),
    )

    await expect(manager.start(uploadRequest())).resolves.toEqual({ ok: false, error: '对象存储配置不存在' })
    expect(publish).not.toHaveBeenCalled()
  })

  it.each([
    ['missing secret', storageProfile({ accessKeySecret: '' }), '缺少有效凭据'],
    ['expired milliseconds', storageProfile({ expire: Date.now() - 1 }), '已过期'],
    ['expired seconds', storageProfile({ expire: Math.floor(Date.now() / 1_000) - 1 }), '已过期'],
  ])('rejects %s credentials', async (_label, profile, error) => {
    const publish = vi.fn()
    const manager = new RemoteLogUploadManager(
      { resolve: vi.fn().mockResolvedValue(profile) },
      { publish },
      profileReader(),
    )

    await expect(manager.start(uploadRequest())).resolves.toEqual({ ok: false, error: expect.stringContaining(error) })
    expect(publish).not.toHaveBeenCalled()
  })

  it.each([
    ['missing profile', undefined],
    ['unknown dock', connectionProfile({ devices: [] })],
    ['SuperDock device', connectionProfile({
      devices: [{ id: 'dock', name: 'SuperDock', sn: 'DOCK-1', type: 'dock', provider: 'superdock' }],
    })],
    ['model-only SuperDock device', connectionProfile({
      devices: [{ id: 'dock', name: 'Legacy SuperDock', sn: 'DOCK-1', type: 'dock', dockModel: 's24m4' }],
    })],
    ['disabled dock', connectionProfile({
      devices: [{ id: 'dock', name: 'Dock', sn: 'DOCK-1', type: 'dock', provider: 'dji', enabled: false }],
    })],
  ])('does not resolve credentials for %s', async (_label, connection) => {
    const resolve = vi.fn()
    const publish = vi.fn()
    const manager = new RemoteLogUploadManager(
      { resolve },
      { publish },
      { get: vi.fn().mockResolvedValue(connection) },
    )

    await expect(manager.start(uploadRequest())).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/连接配置不存在|不属于/),
    })
    expect(resolve).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })

  it.each([
    ['empty key', ''],
    ['parent segment', 'logs/../secret.log'],
    ['backslash', 'logs\\dock.log'],
    ['control character', 'logs/secret\n.log'],
    ['oversized key', 'x'.repeat(1_025)],
  ])('rejects %s object keys before resolving credentials', async (_label, objectKey) => {
    const resolve = vi.fn()
    const publish = vi.fn()
    const request = uploadRequest()
    request.objectKeys['3'] = objectKey
    const manager = new RemoteLogUploadManager({ resolve }, { publish }, profileReader())

    await expect(manager.start(request)).resolves.toEqual({ ok: false, error: expect.any(String) })
    expect(resolve).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })
})
