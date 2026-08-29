import { describe, expect, it } from 'vitest'
import type { ConnectionProfile, MqttMessageRecord } from '../shared/contracts'
import { MAX_EXPORT_RECORDS, MAX_MQTT_PAYLOAD_BYTES } from '../shared/limits'
import {
  validateConnectionProfile,
  validateDeviceArchives,
  validateExportMessageOptions,
  validateFirmwareUploadRequest,
  validateMediaServerProfile,
  validateObjectStorageProfile,
  validatePublishRequest,
  validateRemoteLogUploadRequest,
  validateRtmpRelayId,
  validateRtmpRelayStartRequest,
  validateSeiMessageDetailRequest,
  validateSeiParserId,
  validateSeiParserStartRequest,
  validateSessionPassword,
  validateWhepOfferRequest,
} from './ipc-validation'

const createProfile = (): ConnectionProfile => ({
  id: 'profile-1',
  name: 'Test',
  protocol: 'mqtt',
  host: 'localhost',
  port: 1883,
  path: '/mqtt',
  clientId: 'client-1',
  username: '',
  password: '',
  clearStoredPassword: true,
  mqttVersion: '3.1.1',
  clean: true,
  keepalive: 60,
  connectTimeout: 10,
  reconnectPeriod: 3,
  rejectUnauthorized: true,
  caPath: '',
  certPath: '',
  keyPath: '',
  devices: [],
  subscriptions: [],
  createdAt: 1,
  updatedAt: 1,
})

const createRecord = (id: string): MqttMessageRecord => ({
  id,
  profileId: 'profile-1',
  direction: 'in',
  topic: 'test/topic',
  payload: '{}',
  qos: 0,
  retain: false,
  timestamp: 1,
  size: 2,
})

describe('IPC validation', () => {
  it('accepts the transient clear-password field and an explicit empty session password', () => {
    expect(validateConnectionProfile(createProfile()).clearStoredPassword).toBe(true)
    expect(validateSessionPassword('')).toBe('')
  })

  it('strips credential-store implementation fields from validated profiles', () => {
    const mqtt = validateConnectionProfile({
      ...createProfile(),
      storedPassword: 'plaintext',
      encryptedPassword: 'ciphertext',
    })
    expect(mqtt).not.toHaveProperty('storedPassword')
    expect(mqtt).not.toHaveProperty('encryptedPassword')

    const media = validateMediaServerProfile({
      id: 'srs-1', name: 'SRS', kind: 'remote-srs', host: 'media.example.com',
      apiProtocol: 'https', apiPort: 1985, httpProtocol: 'https', httpPort: 443,
      rtmpPort: 1935, rtspPort: 0, webrtcPort: 8000, secret: '', createdAt: 1, updatedAt: 1,
      storedSecret: 'plaintext', encryptedSecret: 'ciphertext',
    })
    expect(media).not.toHaveProperty('storedSecret')
    expect(media).not.toHaveProperty('encryptedSecret')

    const objectStorage = validateObjectStorageProfile({
      id: 'storage-1', name: 'Primary OSS', provider: 'ali', bucket: 'bucket', region: 'cn-hangzhou',
      endpoint: 'https://oss-cn-hangzhou.aliyuncs.com', accessKeyId: 'key', accessKeySecret: 'secret',
      securityToken: '', expire: 1_900_000_000_000, createdAt: 1, updatedAt: 1,
      storedAccessKeySecret: 'plaintext', encryptedAccessKeySecret: 'ciphertext',
    })
    expect(objectStorage).not.toHaveProperty('storedAccessKeySecret')
    expect(objectStorage).not.toHaveProperty('encryptedAccessKeySecret')
  })

  it('accepts a valid WHEP offer and rejects unsafe URLs or invalid SDP', () => {
    const request = { url: 'https://media.example.com/whep?app=live&stream=main', sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0' }
    expect(validateWhepOfferRequest(request)).toEqual(request)
    expect(() => validateWhepOfferRequest({ ...request, url: 'file:///tmp/answer.sdp' })).toThrow('HTTP 或 HTTPS')
    expect(() => validateWhepOfferRequest({ ...request, url: 'https://user:pass@media.example.com/whep' })).toThrow('认证信息')
    expect(() => validateWhepOfferRequest({ ...request, sdp: 'not sdp' })).toThrow('SDP 格式')
  })

  it('accepts RTMP relay URLs and rejects other protocols or invalid relay IDs', () => {
    expect(validateRtmpRelayStartRequest({ url: 'rtmp://media.example.com/live/main' })).toEqual({
      url: 'rtmp://media.example.com/live/main',
    })
    expect(() => validateRtmpRelayStartRequest({ url: 'https://media.example.com/live/main' })).toThrow('RTMP 或 RTMPS')
    expect(validateRtmpRelayId('01234567-89ab-cdef-0123-456789abcdef')).toBe('01234567-89ab-cdef-0123-456789abcdef')
    expect(() => validateRtmpRelayId('../relay')).toThrow('无效')
  })

  it('validates local ZLM and SecretEMS SEI sources', () => {
    expect(validateSeiParserStartRequest({ source: 'local-zlm', streamId: 'dock-1', url: 'rtsp://127.0.0.1:8554/live/dock-1' })).toEqual({
      source: 'local-zlm',
      streamId: 'dock-1',
      url: 'rtsp://127.0.0.1:8554/live/dock-1',
    })
    expect(validateSeiParserStartRequest({
      source: 'secret-ems',
      streamId: 'dock-1',
      url: 'https://webrtc.example.com/easyMedia/api/sei/events?app=live&stream=dock-1',
    })).toEqual({
      source: 'secret-ems',
      streamId: 'dock-1',
      url: 'https://webrtc.example.com/easyMedia/api/sei/events?app=live&stream=dock-1',
    })
    expect(() => validateSeiParserStartRequest({ source: 'local-zlm', streamId: 'dock-1', url: 'rtsp://media.example.com/live/dock-1' }))
      .toThrow('本地 ZLMediaKit')
    expect(() => validateSeiParserStartRequest({ source: 'local-zlm', streamId: 'dock-1', url: 'http://127.0.0.1/live/dock-1' }))
      .toThrow('RTSP URL')
    expect(() => validateSeiParserStartRequest({ source: 'secret-ems', streamId: 'dock-1', url: 'https://media.example.com/other/events' }))
      .toThrow('接口路径')
    expect(() => validateSeiParserStartRequest({ source: 'secret-ems', streamId: 'dock-1', url: 'https://user:pass@media.example.com/easyMedia/api/sei/events?app=live&stream=dock-1' }))
      .toThrow('认证信息')
    expect(validateSeiParserId('01234567-89ab-cdef-0123-456789abcdef')).toBe('01234567-89ab-cdef-0123-456789abcdef')
    expect(validateSeiMessageDetailRequest({
      sessionId: '01234567-89ab-cdef-0123-456789abcdef',
      messageId: 'secret-ems:42',
    })).toEqual({
      sessionId: '01234567-89ab-cdef-0123-456789abcdef',
      messageId: 'secret-ems:42',
    })
    expect(() => validateSeiMessageDetailRequest({
      sessionId: '01234567-89ab-cdef-0123-456789abcdef',
      messageId: '../42',
    })).toThrow('message ID 无效')
  })

  it('rejects invalid QoS and payloads larger than 1 MiB', () => {
    expect(() => validatePublishRequest({
      profileId: 'profile-1',
      topic: 'test/topic',
      payload: 'x',
      qos: 3,
      retain: false,
    })).toThrow('QoS')
    expect(() => validatePublishRequest({
      profileId: 'profile-1',
      topic: 'test/topic',
      payload: 'x'.repeat(MAX_MQTT_PAYLOAD_BYTES + 1),
      qos: 0,
      retain: false,
    })).toThrow('过长')
  })

  it('limits exported record count', () => {
    const records = Array.from({ length: MAX_EXPORT_RECORDS + 1 }, (_, index) => createRecord(String(index)))
    expect(() => validateExportMessageOptions({ profileName: 'Test', records })).toThrow('数量不能超过')
  })

  it('redacts credentials from NDJSON exports as defense in depth', () => {
    const result = validateExportMessageOptions({
      profileName: 'Test',
      records: [
        {
          ...createRecord('structured'),
          payload: JSON.stringify({
            access_key_id: 'export-access-id',
            accessKeySecret: 'export-camel-secret',
            security_token: 'export-snake-token',
            sts_token: 'export-sts-token',
            nested: {
              device_secret: 'export-device-secret',
              wrapper: 'access_key_secret=export-wrapped-secret',
              values: ['sts_token=export-wrapped-token', 'password reset documentation'],
            },
          }),
          properties: {
            userProperties: {
              authorization: 'Bearer export-auth-secret',
              note: 'security_token=export-property-wrapped-token',
              safeNote: 'security token rotation documentation',
            },
          },
          securityToken: 'unknown-top-level-token',
        },
        {
          ...createRecord('malformed'),
          payload: 'access_key_secret=export-plain-secret&broken={',
        },
      ],
    })

    expect(result.content).not.toContain('export-access-id')
    expect(result.content).not.toContain('export-camel-secret')
    expect(result.content).not.toContain('export-snake-token')
    expect(result.content).not.toContain('export-sts-token')
    expect(result.content).not.toContain('export-device-secret')
    expect(result.content).not.toContain('export-wrapped-secret')
    expect(result.content).not.toContain('export-wrapped-token')
    expect(result.content).not.toContain('export-auth-secret')
    expect(result.content).not.toContain('export-property-wrapped-token')
    expect(result.content).not.toContain('unknown-top-level-token')
    expect(result.content).not.toContain('export-plain-secret')

    const [structured, malformed] = result.content.split('\n').map((line) => JSON.parse(line) as MqttMessageRecord)
    expect(JSON.parse(structured.payload)).toMatchObject({
      access_key_id: '[REDACTED]',
      accessKeySecret: '[REDACTED]',
      security_token: '[REDACTED]',
      sts_token: '[REDACTED]',
      nested: {
        device_secret: '[REDACTED]',
        wrapper: '[REDACTED]',
        values: ['[REDACTED]', 'password reset documentation'],
      },
    })
    expect(structured.properties).toEqual({
      userProperties: {
        authorization: '[REDACTED]',
        note: '[REDACTED]',
        safeNote: 'security token rotation documentation',
      },
    })
    expect(structured).not.toHaveProperty('securityToken')
    expect(malformed.payload).toBe('[REDACTED: sensitive MQTT payload omitted]')
  })

  it('validates that dock model metadata is only configured for dock devices', () => {
    const valid = createProfile()
    valid.devices = [{ id: 'dock', name: 'Dock 3', sn: 'DOCK-1', type: 'dock', dockModel: 'dock3' }]
    expect(validateConnectionProfile(valid).devices[0].dockModel).toBe('dock3')

    const invalid = createProfile()
    invalid.devices = [{
      id: 'aircraft',
      name: 'Aircraft',
      sn: 'AIR-1',
      type: 'aircraft',
      dockModel: 'dock2',
    }]
    expect(() => validateConnectionProfile(invalid)).toThrow('非机场设备')
  })

  it('accepts SuperDock devices and rejects inconsistent provider metadata', () => {
    const valid = createProfile()
    valid.devices = [{
      id: 'superdock',
      name: 'SuperDock S24M4',
      sn: 'SB-001',
      type: 'dock',
      provider: 'superdock',
      dockModel: 's24m4',
    }]
    valid.subscriptions = [{
      id: 'superdock-osd',
      topic: 'thing/product/SB-001/osd',
      qos: 0,
      enabled: true,
      source: 'superdock',
    }]
    expect(validateConnectionProfile(valid).devices[0]).toMatchObject({
      provider: 'superdock',
      dockModel: 's24m4',
    })

    const aircraft = createProfile()
    aircraft.devices = [{
      id: 'aircraft', name: 'Aircraft', sn: 'AIR-1', type: 'aircraft', provider: 'superdock',
    }]
    expect(() => validateConnectionProfile(aircraft)).toThrow('SuperDock 厂商仅适用于机场')

    const mismatched = createProfile()
    mismatched.devices = [{
      id: 'dock', name: 'Dock 2', sn: 'DOCK-1', type: 'dock', provider: 'superdock', dockModel: 'dock2',
    }]
    expect(() => validateConnectionProfile(mismatched)).toThrow('厂商与机场型号不匹配')
  })

  it('accepts a disabled device and rejects non-boolean device state', () => {
    const valid = createProfile()
    valid.devices = [{ id: 'dock', name: 'Dock', sn: 'DOCK-1', type: 'dock', enabled: false }]
    expect(validateConnectionProfile(valid).devices[0].enabled).toBe(false)

    const invalid = createProfile() as unknown as { devices: Record<string, unknown>[] }
    invalid.devices = [{ id: 'dock', name: 'Dock', sn: 'DOCK-1', type: 'dock', enabled: 'no' }]
    expect(() => validateConnectionProfile(invalid)).toThrow('设备启用状态')
  })

  it('validates device archive ownership and strips unknown runtime fields', () => {
    const archive = {
      profileId: 'profile-1', sn: 'AIR-1', gatewaySn: 'DOCK-1', type: 'aircraft', name: 'Aircraft',
      cameras: [{
        gatewaySn: 'DOCK-1', sourceSn: 'AIR-1', cameraIndex: '81-0-0',
        videos: [{ videoIndex: 'wide-0', videoType: 'wide', switchableVideoTypes: ['wide', 'zoom'], status: 1 }],
      }],
      updatedAt: 100,
      online: true,
    }
    const validated = validateDeviceArchives('profile-1', [archive])

    expect(validated[0]).not.toHaveProperty('online')
    expect(validated[0].cameras[0].videos[0]).not.toHaveProperty('status')
    expect(() => validateDeviceArchives('other-profile', [archive])).toThrow('不属于当前连接')
  })

  it('accepts SuperDock product types in persisted device archives', () => {
    const [archive] = validateDeviceArchives('profile-1', [{
      profileId: 'profile-1',
      sn: 'SUPERDOCK-1',
      type: 'dock',
      name: 'SuperDock S24M4',
      identity: { domain: '3', productType: 88103, productSubType: 0 },
      cameras: [],
      updatedAt: 100,
    }])

    expect(archive.identity).toEqual({ domain: '3', productType: 88103, productSubType: 0 })
  })

  it('accepts remote SRS ports and rejects unknown media server kinds', () => {
    const profile = {
      id: 'srs-1', name: 'SRS', kind: 'remote-srs', host: 'media.example.com',
      apiProtocol: 'https', apiPort: 1985, httpProtocol: 'https', httpPort: 443,
      rtmpPort: 1935, rtspPort: 0, webrtcPort: 8000, secret: '', createdAt: 1, updatedAt: 1,
    }
    expect(validateMediaServerProfile(profile).kind).toBe('remote-srs')
    expect(() => validateMediaServerProfile({ ...profile, kind: 'unknown' })).toThrow('类型无效')
    expect(() => validateMediaServerProfile({ ...profile, webrtcPort: 65_536 })).toThrow('WebRTC 端口')
  })

  it('accepts the SecretEMS WHIP/WHEP shape and rejects legacy listener ports', () => {
    const profile = {
      id: 'easymedia-1', name: 'SecretEMS', kind: 'remote-easymedia', host: 'webrtc.example.com',
      apiProtocol: 'https', apiPort: 443, httpProtocol: 'https', httpPort: 443,
      rtmpPort: 1935, rtspPort: 0, webrtcPort: 8000, secret: '', createdAt: 1, updatedAt: 1,
    }
    expect(validateMediaServerProfile(profile).kind).toBe('remote-easymedia')
    expect(() => validateMediaServerProfile({ ...profile, rtmpPort: 0 })).toThrow('RTMP 端口')
    expect(() => validateMediaServerProfile({ ...profile, rtspPort: 554 })).toThrow('SecretEMS 不开放')
    expect(() => validateMediaServerProfile({ ...profile, httpPort: 8443 })).toThrow('WHIP/WHEP')
  })

  it('validates object storage providers and endpoint URLs', () => {
    const profile = {
      id: 'storage-1', name: 'Primary OSS', provider: 'ali', bucket: 'bucket', region: 'cn-hangzhou',
      endpoint: 'https://oss-cn-hangzhou.aliyuncs.com', accessKeyId: 'key', accessKeySecret: 'secret',
      securityToken: '', expire: 1_900_000_000_000, createdAt: 1, updatedAt: 1,
    }
    expect(validateObjectStorageProfile(profile).provider).toBe('ali')
    expect(() => validateObjectStorageProfile({ ...profile, provider: 'unknown' })).toThrow('厂商无效')
    expect(() => validateObjectStorageProfile({ ...profile, endpoint: 'file:///tmp/storage' })).toThrow('HTTP 或 HTTPS')
    expect(() => validateObjectStorageProfile({ ...profile, endpoint: 'https://user:pass@example.com' })).toThrow('认证信息')
  })

  it('validates firmware upload tokens, storage profiles, and object keys', () => {
    const request = {
      selectionToken: 'selection-token',
      objectStorageProfileId: 'storage-1',
      objectKey: 'firmware/DOCK-1/package.zip',
    }
    expect(validateFirmwareUploadRequest(request)).toEqual(request)
    expect(() => validateFirmwareUploadRequest({ ...request, selectionToken: '' })).toThrow('不能为空')
    expect(() => validateFirmwareUploadRequest({ ...request, selectionToken: 'x'.repeat(257) })).toThrow('过长')
    expect(() => validateFirmwareUploadRequest({ ...request, objectKey: '' })).toThrow('不能为空')
    expect(() => validateFirmwareUploadRequest({ ...request, objectKey: { path: 'firmware.zip' } })).toThrow('字符串')
  })

  it('validates remote log uploads and strips unselected object keys', () => {
    const request = {
      profileId: 'profile-1',
      gatewaySn: 'DOCK-1',
      objectStorageProfileId: 'storage-1',
      files: [{ module: '3', bootIndex: 7 }],
      objectKeys: { '0': 'logs/unused.log', '3': ' logs/dock.log ' },
    }

    expect(validateRemoteLogUploadRequest(request)).toEqual({
      profileId: 'profile-1',
      gatewaySn: 'DOCK-1',
      objectStorageProfileId: 'storage-1',
      files: [{ module: '3', bootIndex: 7 }],
      objectKeys: { '3': 'logs/dock.log' },
    })
  })

  it.each([
    ['empty files', { files: [] }, '至少选择'],
    ['invalid module', { files: [{ module: '2', bootIndex: 1 }] }, '模块无效'],
    ['negative boot index', { files: [{ module: '3', bootIndex: -1 }] }, 'Boot Index'],
    ['topic injection', { gatewaySn: 'DOCK-1/services/#' }, 'SN 格式'],
    ['missing object key', { objectKeys: {} }, '对象 Key'],
    ['parent segment', { objectKeys: { '3': 'logs/../secret.log' } }, '.. 路径段'],
    ['backslash', { objectKeys: { '3': 'logs\\dock.log' } }, '无效字符'],
    ['oversized object key', { objectKeys: { '3': 'x'.repeat(1_025) } }, '过长'],
    ['oversized gateway SN', { gatewaySn: 'D'.repeat(129) }, '过长'],
    ['unknown request field', { accessKeySecret: 'must-not-cross-ipc' }, '不支持的字段'],
    ['unknown object key field', { objectKeys: { '3': 'logs/dock.log', security_token: 'nope' } }, '不支持的字段'],
    ['unknown file field', { files: [{ module: '3', bootIndex: 1, token: 'nope' }] }, '不支持的字段'],
  ])('rejects remote log uploads with %s', (_label, overrides, error) => {
    const request = {
      profileId: 'profile-1',
      gatewaySn: 'DOCK-1',
      objectStorageProfileId: 'storage-1',
      files: [{ module: '3', bootIndex: 7 }],
      objectKeys: { '3': 'logs/dock.log' },
      ...overrides,
    }
    expect(() => validateRemoteLogUploadRequest(request)).toThrow(error)
  })

  it('limits remote log upload file count', () => {
    expect(() => validateRemoteLogUploadRequest({
      profileId: 'profile-1',
      gatewaySn: 'DOCK-1',
      objectStorageProfileId: 'storage-1',
      files: Array.from({ length: 1_001 }, () => ({ module: '3', bootIndex: 1 })),
      objectKeys: { '3': 'logs/dock.log' },
    })).toThrow('数量不能超过')
  })
})
