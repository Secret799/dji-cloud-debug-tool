import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { Writable } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AppUpdateManager } from './app-update-manager'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), output: vi.fn(), rm: vi.fn() }))
vi.mock('electron', () => ({ app: { getVersion: () => '0.1.0', getPath: () => '/virtual' }, net: { fetch: mocks.fetch }, shell: {} }))
vi.mock('node:fs', () => ({ createWriteStream: mocks.output }))
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), rm: mocks.rm }))

const payload = Buffer.from('installer')
const name = `HangarLab.Studio-1.0.0-mac-${process.arch}.dmg`
const hash = createHash('sha256').update(payload).digest('hex')

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(() => {
  vi.resetAllMocks()
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
})
afterEach(() => { Object.defineProperty(process, 'platform', platform) })

async function available(body: ReadableStream<Uint8Array>) {
  const manager = new AppUpdateManager(() => {})
  mocks.fetch.mockResolvedValueOnce(new Response('', { status: 404 }))
    .mockResolvedValueOnce({ ok: true, json: async () => ({ tag_name: 'v1.0.0', assets: [
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

const releasesUrl = 'https://github.com/Secret799/dji-cloud-debug-tool/releases'
const tagUrl = `${releasesUrl}/tag/v1.0.0`
const sumsUrl = `${releasesUrl}/download/v1.0.0/SHA256SUMS.txt`

function publicRelease(status: number, options: { tagUrl?: string; sums?: string; sumsStatus?: number } = {}) {
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url.startsWith('https://api.github.com/')) return new Response('{"message":"API rate limit exceeded"}', {
      status, headers: { 'x-ratelimit-remaining': '0' },
    })
    if (url === `${releasesUrl}/latest/download/latest.json`) return new Response('', { status: 404 })
    if (url === `${releasesUrl}/latest`) {
      const response = new Response(null)
      Object.defineProperty(response, 'url', { value: options.tagUrl ?? tagUrl })
      return response
    }
    if (url === sumsUrl) return new Response(options.sums ?? `${hash}  release/${name}\n`, { status: options.sumsStatus ?? 200 })
    if (url === `${releasesUrl}/download/v1.0.0/${name}`) return new Response(payload)
    throw new Error(`Unexpected URL: ${url}`)
  })
}

it('prefers the signed manifest and verifies the installer hash without the REST API', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const manifestText = `${JSON.stringify({
    version: '1.0.0', tag: 'v1.0.0', publishedAt: '2026-11-18T00:00:00Z', notes: '- 签名清单更新',
    assets: [{ name, size: payload.length, sha256: hash }],
  }, null, 2)}\n`
  const signature = sign(null, Buffer.from(manifestText, 'utf8'), privateKey).toString('base64')
  const chunks: Buffer[] = []
  mocks.output.mockReturnValue(new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk); callback() } }))
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url === `${releasesUrl}/latest/download/latest.json`) return new Response(manifestText)
    if (url === `${releasesUrl}/latest/download/latest.json.sig`) return new Response(signature)
    if (url === `${releasesUrl}/download/v1.0.0/${name}`) return new Response(payload)
    throw new Error(`Unexpected URL: ${url}`)
  })
  const manager = new AppUpdateManager(() => {}, publicKey.export({ type: 'spki', format: 'pem' }).toString())

  expect(await manager.check()).toMatchObject({ status: 'available', availableVersion: '1.0.0', releaseNotes: '- 签名清单更新' })
  expect(await manager.download()).toEqual({ ok: true })
  expect(Buffer.concat(chunks)).toEqual(payload)
  expect(manager.getState().status).toBe('downloaded')
  expect(mocks.fetch.mock.calls.every(([url]) => !String(url).startsWith('https://api.github.com/'))).toBe(true)
})

it('rejects a manifest whose signature does not verify instead of falling back', async () => {
  const { publicKey } = generateKeyPairSync('ed25519')
  const manifestText = JSON.stringify({
    version: '1.0.0', tag: 'v1.0.0', publishedAt: '2026-11-18T00:00:00Z', notes: '',
    assets: [{ name, size: payload.length, sha256: hash }],
  })
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url === `${releasesUrl}/latest/download/latest.json`) return new Response(manifestText)
    if (url === `${releasesUrl}/latest/download/latest.json.sig`) return new Response('dGFtcGVyZWQ=')
    throw new Error(`Unexpected URL: ${url}`)
  })
  const manager = new AppUpdateManager(() => {}, publicKey.export({ type: 'spki', format: 'pem' }).toString())

  const state = await manager.check()
  expect(state.status).toBe('error')
  expect(state.error).toContain('签名')
  expect(mocks.fetch.mock.calls.every(([url]) => !String(url).startsWith('https://api.github.com/'))).toBe(true)
})

it.each([403, 429])('checks and downloads the verified public release when the API returns %s', async (status) => {
  publicRelease(status)
  const chunks: Buffer[] = []
  mocks.output.mockReturnValue(new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk); callback() } }))
  const manager = new AppUpdateManager(() => {})
  expect(await manager.check()).toMatchObject({ status: 'available', availableVersion: '1.0.0', releaseUrl: tagUrl })
  expect(await manager.download()).toEqual({ ok: true })
  expect(Buffer.concat(chunks)).toEqual(payload)
  expect(manager.getState().status).toBe('downloaded')
})

it('reports no update from the public release without needing assets for the installed version', async () => {
  publicRelease(403, { tagUrl: `${releasesUrl}/tag/v0.1.0` })
  expect(await new AppUpdateManager(() => {}).check()).toMatchObject({ status: 'not-available', availableVersion: '0.1.0' })
})

it.each([
  { tagUrl: 'https://example.com/releases/tag/v1.0.0' },
  { tagUrl: `${releasesUrl}/latest` },
  { sumsStatus: 404 },
  { sums: '<html>upstream error</html>' },
])('retains the API failure and manual release link when public metadata is unusable: %j', async (options) => {
  publicRelease(403, options)
  const manager = new AppUpdateManager(() => {})
  const state = await manager.check()
  expect(state.status).toBe('error')
  expect(state.error).toContain('403')
  expect(state.error).toContain('限流')
  expect(state.releaseUrl).toBe(`${releasesUrl}/latest`)
  expect((await manager.download()).ok).toBe(false)
})

it('keeps a manual release link for API errors that are not rate limits', async () => {
  mocks.fetch.mockResolvedValue(new Response(null, { status: 404 }))
  const state = await new AppUpdateManager(() => {}).check()
  expect(state.status).toBe('error')
  expect(state.error).toContain('404')
  expect(state.releaseUrl).toBe(`${releasesUrl}/latest`)
  // 第一次是签名清单探测（该测试里返回 404），第二次才是 GitHub API
  expect(mocks.fetch).toHaveBeenCalledTimes(2)
})
