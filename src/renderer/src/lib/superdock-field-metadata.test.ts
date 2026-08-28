import { describe, expect, it } from 'vitest'
import {
  SUPERDOCK_FIELDS,
  getSuperDockFieldMetadata,
  getSuperDockFieldOverride,
} from './superdock-field-metadata'

describe('SuperDock field metadata', () => {
  it('uses SuperDock-specific property definitions', () => {
    expect(SUPERDOCK_FIELDS.map((field) => field.path)).toEqual([
      'drone_rtcm_info',
      'drone_rtcm_info.mount_point',
      'drone_rtcm_info.port',
      'drone_rtcm_info.host',
      'drone_rtcm_info.rtcm_device_type',
      'drone_rtcm_info.source_type',
      'air_transfer_enable',
      'cloud_transfer_enable',
      'soft_emergency_stop_state',
      'dongle_infos.sim_phone_area_code',
      'dongle_infos.sim_phone_number',
      'dongle_infos.sim_remaining_time',
      'dongle_infos.sim_last_authenticated_time',
      'dongle_infos.sim_is_authentication_available',
      'dongle_infos.sim_link_workmode',
    ])
    expect(getSuperDockFieldMetadata('cloud_transfer_enable')).toMatchObject({
      label: '空中回传（机场到云端）',
      accessMode: 'rw',
      pushMode: '1',
    })
    expect(getSuperDockFieldMetadata('drone_rtcm_info.source_type')?.enumValues?.['2']).toBe('网络 RTK 源')
    expect(getSuperDockFieldMetadata('soft_emergency_stop_state')?.enumValues?.['1']).toBe('开启')
    expect(getSuperDockFieldOverride('drone_rtcm_info.0.source_type')?.label).toBe('标定类型')
    expect(getSuperDockFieldOverride('dongle_infos.0.sim_remaining_time')).toMatchObject({
      label: '剩余校验时间',
      type: 'int',
      unit: 's',
    })
    expect(getSuperDockFieldOverride('dongle_infos.0.sim_last_authenticated_time')).toMatchObject({
      label: '上次校验时间',
      type: 'int',
      unit: 's',
    })
    expect(getSuperDockFieldOverride('dongle_infos.0.sim_link_workmode')).toMatchObject({
      label: '增强图传模式',
      type: 'bool',
    })
  })

  it('falls back to compatible dock metadata for shared fields', () => {
    expect(getSuperDockFieldOverride('cover_state')).toBeUndefined()
    expect(getSuperDockFieldMetadata('cover_state')).toMatchObject({
      label: '舱盖状态',
      accessMode: 'r',
    })
    expect(getSuperDockFieldMetadata('dongle_infos.0.imei')?.label).toBe('dongle imei')
  })
})
