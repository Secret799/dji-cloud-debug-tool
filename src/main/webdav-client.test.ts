import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebDavConfig } from '../shared/contracts'
import { createDigestAuthorization, WebDavClient } from './webdav-client'
import { encryptWebDavBackup, decryptWebDavBackup } from './webdav-backup-crypto'
import { MAX_BACKUP_ENVELOPE_BYTES } from './webdav-backup-limits'

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close((error) => error ? reject(error) : resolve())
  })))
})

describe('WebDAV Digest authentication', () => {
  it('matches the RFC 2617 qop=auth example', () => {
    const authorization = createDigestAuthorization(
      'GET',
      new URL('http://www.example.com/dir/index.html'),
      'Mufasa',
      'Circle Of Life',
      'Digest realm="testrealm@host.com", qop="auth", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
      '0a4f113b',
    )

    expect(authorization).toContain('response="6629fae49393a05397450978507c4ef1"')
    expect(authorization).toContain('uri="/dir/index.html"')
    expect(authorization).toContain('qop=auth')
    expect(authorization).toContain('nc=00000001')
  })

  it('rejects unsupported digest algorithms', () => {
    expect(() => createDigestAuthorization(
      'GET',
      new URL('https://example.com/dav/'),
      'admin',
      'secret',
      'Digest realm="dav", nonce="nonce", algorithm="SHA-512"',
    )).toThrow('暂不支持 WebDAV Digest 算法')
  })
})

describe('WebDAV client', () => {
  const lockClient = (options: { ignoreConditions?: boolean; etag?: string } = {}) => {
    const client = new WebDavClient({ endpoint: 'http://unused.invalid/' } as WebDavConfig)
    const files = new Map<string, Buffer>([['.sync-lock.json', Buffer.from(JSON.stringify({ owner: 'old', expiresAt: 0 }))]])
    let replaceBeforeDelete = true
    const replacement = Buffer.from(JSON.stringify({ owner: 'new', expiresAt: Date.now() + 120_000 }))
    const etag = (body: Buffer) => options.etag ?? `"${body.toString('base64')}"`
    const request = vi.fn(async (method: string, url: URL, body?: Buffer, headers: Record<string, string> = {}) => {
      const name = url.pathname.split('/').at(-1)!
      const reply = (status: number, value: Buffer = Buffer.alloc(0), responseHeaders = {}) => ({ url, status, body: value, headers: responseHeaders })
      if (method === 'PROPFIND') return reply(207)
      if (method === 'PUT') {
        if (files.has(name)) return reply(412)
        files.set(name, body!)
        return reply(201)
      }
      if (method === 'GET') {
        const current = files.get(name)
        return current ? reply(200, current, { etag: etag(current) }) : reply(404)
      }
      if (method === 'DELETE') {
        if (name === '.sync-lock.json' && replaceBeforeDelete) {
          files.set(name, replacement)
          replaceBeforeDelete = false
        }
        const current = files.get(name)
        if (!current) return reply(404)
        if (!options.ignoreConditions && headers['If-Match'] && headers['If-Match'] !== etag(current)) return reply(412)
        files.delete(name)
        return reply(204)
      }
      throw new Error(`Unexpected request ${method}`)
    })
    Object.assign(client, { request })
    return { client, files, replacement, request }
  }

  it('does not delete a replacement live lock after reading an expired lock', async () => {
    const { client, files, replacement } = lockClient()
    expect(await client.removeExpiredSyncLock()).toBe(false)
    expect(files.get('.sync-lock.json')).toEqual(replacement)
  })

  it('does not release a replacement lock after reading its own old lock', async () => {
    const { client, files, replacement } = lockClient()
    await client.releaseSyncLock('old')
    expect(files.get('.sync-lock.json')).toEqual(replacement)
  })

  it('refuses deletion when a server ignores If-Match', async () => {
    const { client, files, request } = lockClient({ ignoreConditions: true })
    const original = files.get('.sync-lock.json')
    await expect(client.removeExpiredSyncLock()).rejects.toThrow(/If-Match/)
    expect(files.get('.sync-lock.json')).toEqual(original)
    expect(request.mock.calls.some(([method, url]) => method === 'DELETE' && url.pathname.endsWith('/.sync-lock.json'))).toBe(false)
  })

  it.each(['', 'W/"weak"'])('refuses lock deletion without a strong ETag (%s)', async (etag) => {
    const { client, files } = lockClient({ etag })
    const original = files.get('.sync-lock.json')
    await expect(client.removeExpiredSyncLock()).rejects.toThrow(/ETag/)
    expect(files.get('.sync-lock.json')).toEqual(original)
  })

  it('downloads a 25 MiB plaintext backup with an envelope larger than 32 MiB', async () => {
    const backup = { text: 'x'.repeat(25 * 1024 * 1024) }
    const payload = encryptWebDavBackup(backup, 'secret', 1)
    const server = createServer((_request, response) => response.writeHead(200).end(payload))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    const client = new WebDavClient({ endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, authType: 'basic', username: 'test', secret: 'secret' } as WebDavConfig)
    expect(decryptWebDavBackup(await client.download('backup'), 'secret')).toEqual(backup)
  })

  it('rejects oversized uploads before issuing a request', async () => {
    const { client, request } = lockClient()
    await expect(client.upload('backup', Buffer.alloc(MAX_BACKUP_ENVELOPE_BYTES + 1))).rejects.toThrow(/大小限制/)
    expect(request).not.toHaveBeenCalled()
  })

  it('rejects a truncated HTTP response after headers have arrived', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Length': '1000' })
      response.write('partial')
      setTimeout(() => response.destroy(), 10)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    const client = new WebDavClient({ endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, authType: 'basic', username: 'test', secret: 'secret' } as WebDavConfig)
    const outcome = client.download('backup').then(() => 'resolved', () => 'rejected')
    expect(await Promise.race([outcome, new Promise((resolve) => setTimeout(() => resolve('pending'), 150))])).toBe('rejected')
  })

  it('enforces an absolute deadline even while response bytes keep arriving', async () => {
    let received!: () => void
    const started = new Promise<void>((resolve) => { received = resolve })
    let ongoingResponse: import('node:http').ServerResponse | undefined
    const server = createServer((_request, response) => {
      ongoingResponse = response
      response.writeHead(200)
      response.write('first')
      received()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const client = new WebDavClient({ endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, authType: 'basic', username: 'test', secret: 'secret' } as WebDavConfig)
    let outcome = 'pending'
    const downloading = client.download('backup').then(() => { outcome = 'resolved' }, (error: Error) => { outcome = error.message })
    await started
    await vi.advanceTimersByTimeAsync(10_000)
    ongoingResponse!.write('still sending')
    await new Promise<void>((resolve) => setImmediate(resolve))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(outcome).toMatch(/总时限/)
    await downloading
  })

  it('creates the collection and manages encrypted version files over Basic auth', async () => {
    const files = new Map<string, Buffer>()
    let collectionExists = false
    const expectedAuthorization = `Basic ${Buffer.from('admin:secret').toString('base64')}`
    const server = createServer((request, response) => {
      if (request.headers.authorization !== expectedAuthorization) {
        response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' }).end()
        return
      }
      const path = new URL(request.url ?? '/', 'http://localhost').pathname
      const fileName = decodeURIComponent(path.split('/').at(-1) ?? '')
      const etag = (body: Buffer) => `"${createHash('sha256').update(body).digest('hex')}"`
      if (request.method === 'PROPFIND' && path.endsWith('/dji-cloud-studio-backups/')) {
        if (!collectionExists) {
          response.writeHead(404).end()
          return
        }
        const children = [...files.entries()].map(([name, body]) => `
          <d:response><d:href>/dav/dji-cloud-studio-backups/${encodeURIComponent(name)}</d:href>
          <d:propstat><d:prop><d:getcontentlength>${body.byteLength}</d:getcontentlength></d:prop></d:propstat></d:response>`).join('')
        response.writeHead(207, { 'Content-Type': 'application/xml' }).end(
          `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/dji-cloud-studio-backups/</d:href></d:response>${request.headers.depth === '1' ? children : ''}</d:multistatus>`,
        )
        return
      }
      if (request.method === 'MKCOL') {
        collectionExists = true
        response.writeHead(201).end()
        return
      }
      if (request.method === 'PUT') {
        const chunks: Buffer[] = []
        request.on('data', (chunk: Buffer) => chunks.push(chunk))
        request.on('end', () => {
          if (request.headers['if-none-match'] === '*' && files.has(fileName)) {
            response.writeHead(412).end()
            return
          }
          files.set(fileName, Buffer.concat(chunks))
          response.writeHead(201).end()
        })
        return
      }
      if (request.method === 'GET' && files.has(fileName)) {
        response.writeHead(200, { ETag: etag(files.get(fileName)!) }).end(files.get(fileName))
        return
      }
      if (request.method === 'DELETE' && files.has(fileName) && request.headers['if-match'] && request.headers['if-match'] !== etag(files.get(fileName)!)) {
        response.writeHead(412).end()
        return
      }
      if (request.method === 'DELETE' && files.delete(fileName)) {
        response.writeHead(204).end()
        return
      }
      response.writeHead(404).end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    const address = server.address() as AddressInfo
    const config: WebDavConfig = {
      endpoint: `http://127.0.0.1:${address.port}/dav/`,
      authType: 'basic',
      username: 'admin',
      secret: 'secret',
      rejectUnauthorized: true,
      autoSync: true,
      syncStrategy: 'smart-merge',
      updatedAt: Date.now(),
    }
    const client = new WebDavClient(config)
    const id = 'v000001-1787875200000-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.djibak'
    const payload = Buffer.from('encrypted-backup')

    await client.test()
    const lock = Buffer.from(JSON.stringify({ owner: 'client-a', expiresAt: Date.now() + 60_000 }))
    expect(await client.tryAcquireSyncLock(lock)).toBe(true)
    expect(await client.tryAcquireSyncLock(lock)).toBe(false)
    await client.releaseSyncLock('client-a')
    await client.upload(id, payload)
    expect(await client.listVersions()).toEqual([{
      id,
      revision: 1,
      createdAt: 1_787_875_200_000,
      size: payload.byteLength,
    }])
    expect(await client.download(id)).toEqual(payload)
    await client.remove(id)
    expect(await client.listVersions()).toEqual([])
  })
})
