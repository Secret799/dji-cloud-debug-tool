import { describe, expect, it } from 'vitest'
import {
  superDockErrorCodeData,
  superDockErrorCodeStats,
  superDockHmsErrors,
  superDockTaskErrors,
  superDockWaylineInterrupts,
} from './superdock-error-codes'

describe('SuperDock error code data', () => {
  it('loads the official task, dock HMS and wayline interruption records', () => {
    expect(superDockErrorCodeStats).toEqual({ task: 927, hms: 258, wayline: 249, total: 1434 })
    expect(superDockTaskErrors.find((entry) => entry.code === '600001')).toBeDefined()
    expect(superDockHmsErrors.find((entry) => entry.code === '0x12040000')).toMatchObject({
      message: '机场RTK设备断连',
    })
    expect(superDockWaylineInterrupts.find((entry) => entry.code === '-19')).toMatchObject({
      description: '文件传输失败',
    })
    expect(superDockErrorCodeData.source.taskErrorsUrl).toContain('docs.sb.im')
  })
})
