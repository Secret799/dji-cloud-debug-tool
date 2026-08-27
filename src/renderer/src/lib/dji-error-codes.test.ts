import { describe, expect, it } from 'vitest'
import {
  errorCodeStats,
  findCloudErrorCode,
  findHmsErrorCode,
  formatServiceError,
  hmsDecimalCode,
  lookupServiceError,
  normalizeHmsErrorCode,
  serviceResultToHmsCode,
} from './dji-error-codes'

describe('DJI error code data', () => {
  it('loads every normalized workbook section', () => {
    expect(errorCodeStats).toEqual({ cloud: 551, hms: 92, faq: 26, total: 669 })
    expect(findCloudErrorCode(316031)).toMatchObject({
      source: '设备端',
      message: '机场系统运行异常，请重新下发任务',
      solution: '2代机库下发任务需指定返航模式',
    })
  })

  it('accepts hexadecimal, unprefixed hexadecimal and decimal HMS codes', () => {
    expect(normalizeHmsErrorCode('0x19110002')).toBe('0x19110002')
    expect(normalizeHmsErrorCode('19110002')).toBe('0x19110002')
    expect(normalizeHmsErrorCode(420544514)).toBe('0x19110002')
    expect(hmsDecimalCode('0x19110002')).toBe('420544514')
    expect(findHmsErrorCode(420544514)?.message).toContain('舱盖位置误差过大')
  })

  it('converts 328XXX service results into aircraft HMS codes', () => {
    expect(serviceResultToHmsCode(328022)).toBe('0x16100016')
    expect(lookupServiceError(328022)).toMatchObject({
      hmsCode: '0x16100016',
      message: '无法起飞:飞行器未激活，请重启App进行激活',
      solution: '激活飞行器',
    })
  })

  it('formats a non-zero reply with its treatment', () => {
    expect(formatServiceError(316031)).toContain('处理措施：2代机库下发任务需指定返航模式')
    expect(formatServiceError(999999)).toContain('错误码库暂无该条目')
  })
})
