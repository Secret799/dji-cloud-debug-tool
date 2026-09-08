import { createHash } from 'node:crypto'
import { Writable } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AppUpdateManager } from './app-update-manager'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), output: vi.fn(), rm: vi.fn() }))
vi.mock('electron', () => ({ app: { getVersion: () => '0.1.0', getPath: () => '/virtual' }, net: { fetch: mocks.fetch }, shell: {} }))
vi.mock('node:fs', () => ({ createWriteStream: mocks.output }))
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), rm: mocks.rm }))

const payload = Buffer.from('installer')
const name = `DJI.Cloud.Studio-1.0.0-mac-${process.arch}.dmg`
const hash = createHash('sha256').update(payload).digest('hex')

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(() => {
  vi.resetAllMocks()
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
})
afterEach(() => { Object.defineProperty(process, 'platform', platform) })

async function available(body: ReadableStream<Uint8Array>) {
  const manager = new AppUpdateManager(() => {})
  mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ tag_name: 'v1.0.0', assets: [
    { name, size: payload.length, browser_download_url: 'installer' },
    { name: 'SHA256SUMS.txt', browser_download_url: 'sums' },
  ] }) }).mockResolvedValueOnce({ ok: true, text: async () => `${hash}  ${name}` })
    .mockResolvedValueOnce({ ok: true, headers: new Headers(), body })
  expect((await manager.check()).status).toBe('available')
  return manager
}

it.each(['write', 'open'] as const)('handles asynchronous %s failure with an observed stream error and original error retained', async (failure) => {
  const diskError = new Error(failure === 'write' ? 'ENOSPC: disk full' : 'EACCES: open failed')
  const observed: boolean[] = []
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(diskError) } })
  // The observer prevents the broken implementation from crashing the test worker.
  output.on('error', () => observed.push(output.listenerCount('error') > 1))
  const cancel = vi.fn(async () => { throw new Error('cancel failed') })
  const body = new ReadableStream<Uint8Array>({
    start(controller) { if (failure === 'write') controller.enqueue(payload) }, cancel,
  })
  mocks.output.mockImplementation(() => {
    if (failure === 'open') setImmediate(() => output.destroy(diskError))
    return output
  })
  const manager = await available(body)
  mocks.rm.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('cleanup failed'))
  const result = await Promise.race([manager.download(), new Promise((resolve) => setTimeout(() => resolve('hung'), 300))])
  expect(result).toEqual({ ok: false, error: diskError.message })
  expect(manager.getState().status).toBe('error')
  expect(observed).toEqual([true])
  expect(output.destroyed).toBe(true)
  expect(cancel).toHaveBeenCalledOnce()
  expect(mocks.rm).toHaveBeenCalledTimes(2)
})

it('finishes the output and verifies the digest before accepting the installer', async () => {
  const chunks: Buffer[] = []
  const output = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk); callback() } })
  mocks.output.mockReturnValue(output)
  const manager = await available(new ReadableStream({ start(controller) { controller.enqueue(payload); controller.close() } }))
  expect(await manager.download()).toEqual({ ok: true })
  expect(Buffer.concat(chunks)).toEqual(payload)
  expect(output.writableFinished).toBe(true)
  expect(manager.getState().status).toBe('downloaded')
})
