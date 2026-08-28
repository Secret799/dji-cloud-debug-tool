import { describe, expect, it } from 'vitest'
import {
  HMS_LIST_LIMIT,
  hmsFlightStateLabel,
  hmsImminentLabel,
  hmsLevelLabel,
  hmsModuleLabel,
  parseHmsPayload,
} from './dji-hms'

describe('Dock 3 HMS payload parsing', () => {
  it('parses the fields and enums from the DJI HMS example', () => {
    const parsed = parseHmsPayload(JSON.stringify({
      bid: 'bid-1',
      tid: 'tid-1',
      timestamp: 1654070968655,
      method: 'hms',
      data: {
        list: [{
          args: { component_index: 0, sensor_index: 1 },
          code: '0x16100083',
          device_type: '0-67-0',
          imminent: 1,
          in_the_sky: 0,
          level: 2,
          module: 3,
        }],
      },
    }))

    expect(parsed).toEqual({
      bid: 'bid-1',
      tid: 'tid-1',
      timestamp: 1654070968655,
      alarms: [{
        args: { componentIndex: 0, sensorIndex: 1 },
        code: '0x16100083',
        normalizedCode: '0x16100083',
        deviceType: '0-67-0',
        imminent: 1,
        inTheSky: 0,
        level: 2,
        module: 3,
      }],
      exceedsListLimit: false,
    })
    expect(hmsLevelLabel(2)).toBe('警告')
    expect(hmsModuleLabel(3)).toBe('HMS')
    expect(hmsFlightStateLabel(0)).toBe('在地上')
    expect(hmsImminentLabel(1)).toBe('实时性')
  })

  it('ignores invalid list entries and reports a document limit violation', () => {
    const list = Array.from({ length: HMS_LIST_LIMIT + 1 }, (_, index) => (
      index === 0 ? null : { code: 420544514, level: 9 }
    ))
    const parsed = parseHmsPayload(JSON.stringify({ method: 'hms', data: { list } }))

    expect(parsed?.alarms).toHaveLength(HMS_LIST_LIMIT)
    expect(parsed?.alarms[0]).toMatchObject({ code: '420544514', normalizedCode: '0x19110002' })
    expect(parsed?.exceedsListLimit).toBe(true)
    expect(hmsLevelLabel(9)).toBe('未知 (9)')
  })

  it('rejects malformed JSON and other event methods', () => {
    expect(parseHmsPayload('not-json')).toBeUndefined()
    expect(parseHmsPayload(JSON.stringify({ method: 'drc_status_notify', data: {} }))).toBeUndefined()
  })
})
