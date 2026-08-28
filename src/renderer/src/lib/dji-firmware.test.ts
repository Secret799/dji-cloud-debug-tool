import { describe, expect, it, vi } from 'vitest'
import type { MqttMessageRecord } from '../../../shared/contracts'
import {
  buildFirmwareEventReply,
  buildFirmwareUpgradeDevices,
  createFirmwareObjectKey,
  createFirmwareDeviceDraft,
  parseFirmwareProgress,
} from './dji-firmware'

const incoming = (payload: unknown): MqttMessageRecord => ({
  id: 'progress-1',
  profileId: 'profile',
  direction: 'in',
  topic: 'thing/product/DOCK-3/events',
  payload: JSON.stringify(payload),
  qos: 1,
  retain: false,
  timestamp: 1_700_000_000_000,
  size: 100,
})

describe('DJI firmware upgrade protocol', () => {
  it('builds ota_create devices and omits an unused package block', () => {
    const dock = { ...createFirmwareDeviceDraft('DOCK-3', '12.01.02.03'), upgradeType: 2 as const }
    const aircraft = {
      ...createFirmwareDeviceDraft('AIR-3', '13.02.03.04'),
      fileUrl: 'https://firmware.example/air.zip',
      md5: 'abcdef',
      fileSize: '653467234',
      fileName: 'air.zip',
    }

    expect(buildFirmwareUpgradeDevices([dock, aircraft])).toEqual([
      { sn: 'DOCK-3', product_version: '12.01.02.03', firmware_upgrade_type: 2 },
      {
        sn: 'AIR-3',
        product_version: '13.02.03.04',
        firmware_upgrade_type: 3,
        file_url: 'https://firmware.example/air.zip',
        md5: 'abcdef',
        file_size: 653467234,
        file_name: 'air.zip',
      },
    ])
  })

  it('rejects partial package metadata', () => {
    const draft = { ...createFirmwareDeviceDraft('DOCK-3', '1.0.0'), fileUrl: 'https://example.com/fw.zip' }
    expect(() => buildFirmwareUpgradeDevices([draft])).toThrow('必须同时填写')
  })

  it('creates a dated object key scoped to the gateway', () => {
    expect(createFirmwareObjectKey('DOCK:3', '机场 固件.zip', new Date('2026-08-27T00:00:00Z'), 'upload-id'))
      .toBe('firmware/DOCK-3/2026-08-27/upload-id------.zip')
  })

  it('parses ota progress and clamps its percentage', () => {
    const record = incoming({
      tid: 'tid-1',
      bid: 'bid-1',
      method: 'ota_progress',
      data: {
        result: 0,
        output: {
          status: 'in_progress',
          progress: { percent: 110, current_step: 'download_firmware' },
        },
      },
    })
    expect(parseFirmwareProgress(record)).toMatchObject({
      gatewaySn: 'DOCK-3',
      tid: 'tid-1',
      bid: 'bid-1',
      result: 0,
      status: 'in_progress',
      percent: 100,
      currentStep: 'download_firmware',
    })
  })

  it('builds the required events reply for ota progress', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_100)
    const reply = buildFirmwareEventReply(incoming({
      tid: 'tid-1', bid: 'bid-1', method: 'ota_progress', data: { result: 0, output: {} },
    }))
    expect(reply?.topic).toBe('thing/product/DOCK-3/events_reply')
    expect(JSON.parse(reply?.payload ?? '{}')).toEqual({
      tid: 'tid-1', bid: 'bid-1', timestamp: 1_700_000_000_100, method: 'ota_progress', data: { result: 0 },
    })
    vi.restoreAllMocks()
  })
})
