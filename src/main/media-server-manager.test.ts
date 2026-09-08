import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MediaServerManager } from './media-server-manager'
import type { MediaServerStore } from './media-server-store'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), writeFile: vi.fn(), probe: vi.fn(), access: vi.fn() }))
vi.mock('electron', () => ({ app: { getAppPath: () => '/virtual', getPath: () => '/virtual', isPackaged: false } }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('node:fs/promises', () => ({ access: mocks.access, mkdir: vi.fn(), writeFile: mocks.writeFile }))
vi.mock('./media-server-path', () => ({ resolveMediaServerBinaryPath: () => '/virtual/MediaServer' }))
vi.mock('./media-server-probe', () => ({ probeMediaServer: mocks.probe }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const running = { profileId: 'local-zlmediakit', state: 'running', checkedAt: 1 }
function child() {
  const process = Object.assign(new EventEmitter(), { pid: 123, stdout: new PassThrough(), stderr: new PassThrough(), killed: false, kill: vi.fn() })
  process.kill.mockImplementation(() => { process.killed = true; queueMicrotask(() => process.emit('exit', 0, 'SIGTERM')); return true })
  return process
}
function manager() {
  return new MediaServerManager({ getWithSecret: async () => ({ id: 'local-zlmediakit', kind: 'local-zlm', secret: 'fixture' }) } as unknown as MediaServerStore, vi.fn())
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.spawn.mockImplementation(child)
  mocks.probe.mockResolvedValue(running)
})
afterEach(() => { vi.useRealTimers() })

it('does not spawn after stop completes during runtime preparation', async () => {
  const prepare = deferred<void>()
  mocks.writeFile.mockReturnValueOnce(prepare.promise)
  const service = manager()
  const start = service.startLocal()
  await vi.waitFor(() => expect(mocks.writeFile).toHaveBeenCalledOnce())
  expect((await service.stopLocal()).runtime?.state).toBe('stopped')
  prepare.resolve()
  expect((await start).ok).toBe(false)
  expect(mocks.spawn).not.toHaveBeenCalled()
  expect((await service.getLocalRuntime()).state).toBe('stopped')
})

it('ignores a successful readiness probe arriving after stop', async () => {
  const probe = deferred<typeof running>()
  mocks.probe.mockReturnValueOnce(probe.promise)
  const service = manager()
  const start = service.startLocal()
  await vi.waitFor(() => expect(mocks.probe).toHaveBeenCalledOnce())
  await service.stopLocal()
  probe.resolve(running)
  expect((await start).ok).toBe(false)
  expect((await service.getLocalRuntime()).state).toBe('stopped')
})

it('lets the newest start win and ignores errors and exits from a replaced child', async () => {
  const probe = deferred<typeof running>()
  mocks.probe.mockReturnValueOnce(probe.promise)
  const service = manager()
  const first = service.startLocal()
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce())
  const oldChild = mocks.spawn.mock.results[0].value
  expect((await service.startLocal()).ok).toBe(true)
  oldChild.emit('error', new Error('late old error'))
  oldChild.emit('exit', 1, null)
  probe.resolve(running)
  expect((await first).ok).toBe(false)
  expect((await service.getLocalRuntime()).state).toBe('running')
  await service.stopLocal()
})

it('restarts when start is requested while a running child is stopping', async () => {
  const service = manager()
  expect((await service.startLocal()).ok).toBe(true)
  const oldChild = mocks.spawn.mock.results[0].value
  oldChild.kill.mockReturnValue(true)
  const stop = service.stopLocal()
  const restart = service.startLocal()
  oldChild.emit('exit', 0, 'SIGTERM')
  expect((await restart).ok).toBe(true)
  expect((await stop).ok).toBe(false)
  expect(mocks.spawn).toHaveBeenCalledTimes(2)
  expect((await service.getLocalRuntime()).state).toBe('running')
  await service.stopLocal()
})

it('does not let overlapping preparations overwrite the newest runtime configuration', async () => {
  const prepare = deferred<void>()
  mocks.writeFile.mockReturnValueOnce(prepare.promise)
  const service = manager()
  const first = service.startLocal()
  await vi.waitFor(() => expect(mocks.writeFile).toHaveBeenCalledOnce())
  const second = service.startLocal()
  await new Promise((resolve) => setImmediate(resolve))
  expect(mocks.writeFile).toHaveBeenCalledOnce()
  prepare.resolve()
  expect((await first).ok).toBe(false)
  expect((await second).ok).toBe(true)
  expect(mocks.spawn).toHaveBeenCalledOnce()
  await service.stopLocal()
})
