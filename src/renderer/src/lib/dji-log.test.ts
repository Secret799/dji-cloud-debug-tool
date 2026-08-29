import { describe, expect, it, vi } from 'vitest'
import type { MqttMessageRecord } from '../../../shared/contracts'
import {
  buildLogCancelPayload,
  buildLogListPayload,
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
