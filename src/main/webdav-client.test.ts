import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { WebDavConfig } from '../shared/contracts'
import { createDigestAuthorization, WebDavClient } from './webdav-client'

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
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
        response.writeHead(200).end(files.get(fileName))
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
