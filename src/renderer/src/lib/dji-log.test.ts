import { describe, expect, it, vi } from 'vitest'
import type { MqttMessageRecord } from '../../../shared/contracts'
import {
  buildLogCancelPayload,
  buildLogListPayload,
  buildLogUploadPayload,
  parseLogFileList,
  parseLogProgress,
  type DjiLogFile,
} from './dji-log'

vi.stubGlobal('crypto', { randomUUID: () => 'test-id' })

const incoming = (topic: string, payload: unknown): MqttMessageRecord => ({
  id: 'record',
  profileId: 'profile',
  direction: 'in',
  topic,
  payload: JSON.stringify(payload),
  qos: 1,
  retain: false,
  timestamp: 1_700_000_000_000,
  size: 100,
})

describe('DJI remote log protocol', () => {
  it('builds list and cancel service payloads with string module codes', () => {
    expect(JSON.parse(buildLogListPayload(['0', '3']))).toMatchObject({
      method: 'fileupload_list',
      data: { module_list: ['0', '3'] },
    })
    expect(JSON.parse(buildLogCancelPayload(['3']))).toMatchObject({
      method: 'fileupload_update',
      data: { status: 'cancel', module_list: ['3'] },
    })
  })

  it('groups selected boot indexes by module when starting an upload', () => {
    const files: DjiLogFile[] = [
      { module: '3', deviceSn: 'dock', bootIndex: 10, startTime: 1, endTime: 2, size: 3 },
      { module: '3', deviceSn: 'dock', bootIndex: 11, startTime: 2, endTime: 3, size: 4 },
      { module: '0', deviceSn: 'drone', bootIndex: 20, startTime: 1, endTime: 2, size: 5 },
    ]
    const payload = JSON.parse(buildLogUploadPayload(files, {
      provider: 'ali',
      bucket: 'bucket',
      region: 'cn-hangzhou',
      endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
      credentials: { accessKeyId: 'id', accessKeySecret: 'secret', securityToken: 'token', expire: 1_700_000_300_000 },
      objectKeys: { '0': 'logs/aircraft.log', '3': 'logs/dock.log' },
    }))

    expect(payload.method).toBe('fileupload_start')
    expect(payload.data.params.files).toEqual([
      { object_key: 'logs/dock.log', module: '3', list: [{ boot_index: 10 }, { boot_index: 11 }] },
      { object_key: 'logs/aircraft.log', module: '0', list: [{ boot_index: 20 }] },
    ])
  })

  it('parses file list replies and tolerates the documented end_ime typo', () => {
    const files = parseLogFileList(incoming('thing/product/dock/services_reply', {
      method: 'fileupload_list',
      data: { files: [{
        module: '3',
        device_sn: 'dock',
        result: 0,
        list: [{ boot_index: 7, start_time: 1000, end_ime: 2000, size: 4096 }],
      }] },
    }))
    expect(files).toEqual([{ module: '3', deviceSn: 'dock', bootIndex: 7, startTime: 1000, endTime: 2000, size: 4096 }])
  })

  it('parses upload progress events', () => {
    const progress = parseLogProgress(incoming('thing/product/dock/events', {
      method: 'fileupload_progress',
      data: { output: { ext: { files: [{
        module: '3', device_sn: 'dock', key: 'logs/dock.log', fingerprint: 'abc', size: 4096,
        progress: { progress: 75, upload_rate: 1024, current_step: 3, total_step: 4, status: 'uploading', result: 0 },
      }] } } },
    }))
    expect(progress[0]).toMatchObject({ module: '3', deviceSn: 'dock', key: 'logs/dock.log', progress: 75, uploadRate: 1024 })
  })
})
