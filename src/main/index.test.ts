import { describe, expect, it, vi } from 'vitest'

// src/main/index.ts 是 Electron 入口：只有把 electron 换成桩、并让 app.whenReady 永不 resolve，
// 才能在单元测试里导入它而不真的启动应用。探测链路目前没有其它可注入的接缝。
vi.mock('electron', () => ({
  app: {
    setName: vi.fn(),
    isPackaged: false,
    getPath: () => '/tmp/dji-cloud-studio-unit-test',
    whenReady: () => new Promise(() => undefined),
    on: vi.fn(),
    quit: vi.fn(),
  },
  BrowserWindow: class {},
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  net: { fetch: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  shell: { openExternal: vi.fn() },
}))

import { mapProbeErrorMessage } from './index'

describe('map probe error messages', () => {
  it('translates the timeout the runtime actually reports', () => {
    // 实测（黑洞上游 + AbortSignal.timeout）：net.fetch 超时抛的就是这个 DOMException
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    expect(mapProbeErrorMessage(timeout)).toBe('探测超时，请检查地址与网络')
  })

  it('translates any error carrying the timeout name', () => {
    expect(mapProbeErrorMessage(Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' })))
      .toBe('探测超时，请检查地址与网络')
  })

  it('keeps upstream failures untouched so the diagnosis still reaches the user', () => {
    expect(mapProbeErrorMessage(new Error('上游返回 HTTP 401'))).toBe('上游返回 HTTP 401')
    expect(mapProbeErrorMessage(new Error('getaddrinfo ENOTFOUND tiles.example.com')))
      .toBe('getaddrinfo ENOTFOUND tiles.example.com')
    expect(mapProbeErrorMessage(new Error('未找到瓦片 0/0/0'))).toBe('未找到瓦片 0/0/0')
    expect(mapProbeErrorMessage('探测失败')).toBe('探测失败')
  })

  it('does not translate an abort that is not a timeout', () => {
    expect(mapProbeErrorMessage(new DOMException('The operation was aborted', 'AbortError')))
      .toBe('The operation was aborted')
  })
})
