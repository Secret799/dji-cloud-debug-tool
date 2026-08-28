import { createHash, randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingHttpHeaders } from 'node:http'
import { basename } from 'node:path/posix'
import { XMLParser } from 'fast-xml-parser'
import type { WebDavConfig, WebDavVersion } from '../shared/contracts'

interface WebDavResponse {
  url: URL
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
}

interface DigestChallenge {
  realm: string
  nonce: string
  opaque?: string
  algorithm: string
  qop?: string
}

const VERSION_PATTERN = /^v(\d{6})-(\d{13})-([a-f0-9-]{36})\.djibak$/i
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024
export const WEB_DAV_SYNC_LOCK_NAME = '.sync-lock.json'

const parseDigestChallenge = (header: string): DigestChallenge => {
  const prefix = header.match(/^\s*Digest\s+/i)
  if (!prefix) throw new Error('服务器未返回可用的 Digest 认证信息')
  const values: Record<string, string> = {}
  const source = header.slice(prefix[0].length)
  const pattern = /([A-Za-z0-9_-]+)\s*=\s*(?:"((?:\\.|[^"])*)"|([^,\s]+))/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source))) values[match[1].toLowerCase()] = (match[2] ?? match[3]).replace(/\\"/g, '"')
  if (!values.realm || !values.nonce) throw new Error('Digest 认证信息缺少 realm 或 nonce')
  return {
    realm: values.realm,
    nonce: values.nonce,
    opaque: values.opaque,
    algorithm: values.algorithm ?? 'MD5',
    qop: values.qop,
  }
}

const digestHashName = (algorithm: string): 'md5' | 'sha256' => {
  const normalized = algorithm.toUpperCase()
  if (normalized === 'MD5' || normalized === 'MD5-SESS') return 'md5'
  if (normalized === 'SHA-256' || normalized === 'SHA-256-SESS') return 'sha256'
  throw new Error(`暂不支持 WebDAV Digest 算法：${algorithm}`)
}

const quoteDigest = (value: string): string => `"${value.replace(/(["\\])/g, '\\$1')}"`

export const createDigestAuthorization = (
  method: string,
  url: URL,
  username: string,
  password: string,
  challengeHeader: string,
  cnonce = randomBytes(12).toString('hex'),
): string => {
  const challenge = parseDigestChallenge(challengeHeader)
  const hashName = digestHashName(challenge.algorithm)
  const hash = (value: string): string => createHash(hashName).update(value).digest('hex')
  const uri = `${url.pathname}${url.search}`
  let ha1 = hash(`${username}:${challenge.realm}:${password}`)
  if (challenge.algorithm.toUpperCase().endsWith('-SESS')) ha1 = hash(`${ha1}:${challenge.nonce}:${cnonce}`)
  const ha2 = hash(`${method}:${uri}`)
  const qop = challenge.qop?.split(',').map((item) => item.trim().toLowerCase()).find((item) => item === 'auth')
  if (challenge.qop && !qop) throw new Error('WebDAV Digest 服务端不支持 qop=auth')
  const nc = '00000001'
  const response = qop
    ? hash(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : hash(`${ha1}:${challenge.nonce}:${ha2}`)
  const parts = [
    `username=${quoteDigest(username)}`,
    `realm=${quoteDigest(challenge.realm)}`,
    `nonce=${quoteDigest(challenge.nonce)}`,
    `uri=${quoteDigest(uri)}`,
    `response=${quoteDigest(response)}`,
    `algorithm=${challenge.algorithm}`,
  ]
  if (challenge.opaque) parts.push(`opaque=${quoteDigest(challenge.opaque)}`)
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce=${quoteDigest(cnonce)}`)
  return `Digest ${parts.join(', ')}`
}

const asArray = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value]

const parseVersionName = (name: string, size = 0): WebDavVersion | undefined => {
  const match = VERSION_PATTERN.exec(name)
  if (!match) return undefined
  return {
    id: name,
    revision: Number(match[1]),
    createdAt: Number(match[2]),
    size: Number.isFinite(size) ? size : 0,
  }
}

const normalizeEndpoint = (endpoint: string): URL => {
  const url = new URL(endpoint)
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}

export class WebDavClient {
  private readonly directoryUrl: URL

  constructor(private readonly config: WebDavConfig) {
    this.directoryUrl = new URL('dji-cloud-studio-backups/', normalizeEndpoint(config.endpoint))
  }

  async test(): Promise<void> {
    await this.ensureCollection()
    await this.listVersions()
  }

  async listVersions(): Promise<WebDavVersion[]> {
    await this.ensureCollection()
    const response = await this.request('PROPFIND', this.directoryUrl, Buffer.from(
      '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>',
      'utf8',
    ), { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' })
    this.expectStatus(response, [207], '读取 WebDAV 版本列表')
    let document: unknown
    try {
      document = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false }).parse(response.body.toString('utf8')) as unknown
    } catch {
      throw new Error('WebDAV 服务器返回了无效的目录 XML')
    }
    const root = document as { multistatus?: { response?: unknown | unknown[] } }
    return asArray(root.multistatus?.response).flatMap((entry) => {
      const responseEntry = entry as {
        href?: string
        propstat?: { prop?: { getcontentlength?: string | number } } | Array<{ prop?: { getcontentlength?: string | number } }>
      }
      if (typeof responseEntry.href !== 'string') return []
      let name: string
      try {
        name = decodeURIComponent(basename(new URL(responseEntry.href, this.directoryUrl).pathname))
      } catch {
        return []
      }
      const prop = asArray(responseEntry.propstat).find((item) => item?.prop)?.prop
      const version = parseVersionName(name, Number(prop?.getcontentlength ?? 0))
      return version ? [version] : []
    }).sort((left, right) => right.revision - left.revision || right.createdAt - left.createdAt)
  }

  async upload(versionId: string, payload: Buffer): Promise<void> {
    const response = await this.request('PUT', new URL(encodeURIComponent(versionId), this.directoryUrl), payload, {
      'Content-Type': 'application/octet-stream',
      'If-None-Match': '*',
    })
    this.expectStatus(response, [201, 204], '上传 WebDAV 数据版本')
  }

  async tryAcquireSyncLock(payload: Buffer): Promise<boolean> {
    await this.ensureCollection()
    const response = await this.request('PUT', new URL(WEB_DAV_SYNC_LOCK_NAME, this.directoryUrl), payload, {
      'Content-Type': 'application/json; charset=utf-8',
      'If-None-Match': '*',
    })
    if (response.status === 412 || response.status === 423) return false
    if (response.status === 201) return true
    if (response.status === 204) throw new Error('WebDAV 服务器未执行同步锁的 If-None-Match 条件')
    this.expectStatus(response, [201], '获取 WebDAV 同步锁')
    return false
  }

  async readSyncLock(): Promise<Buffer | undefined> {
    await this.ensureCollection()
    const response = await this.request('GET', new URL(WEB_DAV_SYNC_LOCK_NAME, this.directoryUrl))
    if (response.status === 404) return undefined
    this.expectStatus(response, [200], '读取 WebDAV 同步锁')
    return response.body
  }

  async releaseSyncLock(owner: string): Promise<void> {
    const current = await this.readSyncLock()
    if (!current) return
    try {
      const document = JSON.parse(current.toString('utf8')) as { owner?: unknown }
      if (document.owner !== owner) return
    } catch {
      return
    }
    const response = await this.request('DELETE', new URL(WEB_DAV_SYNC_LOCK_NAME, this.directoryUrl))
    if (response.status !== 404) this.expectStatus(response, [200, 204], '释放 WebDAV 同步锁')
  }

  async removeExpiredSyncLock(now = Date.now()): Promise<boolean> {
    const current = await this.readSyncLock()
    if (!current) return true
    try {
      const document = JSON.parse(current.toString('utf8')) as { expiresAt?: unknown }
      if (typeof document.expiresAt !== 'number' || document.expiresAt > now) return false
    } catch {
      return false
    }
    const response = await this.request('DELETE', new URL(WEB_DAV_SYNC_LOCK_NAME, this.directoryUrl))
    if (response.status !== 404) this.expectStatus(response, [200, 204], '清理过期 WebDAV 同步锁')
    return true
  }

  async download(versionId: string): Promise<Buffer> {
    const response = await this.request('GET', new URL(encodeURIComponent(versionId), this.directoryUrl))
    this.expectStatus(response, [200], '下载 WebDAV 数据版本')
    return response.body
  }

  async remove(versionId: string): Promise<void> {
    const response = await this.request('DELETE', new URL(encodeURIComponent(versionId), this.directoryUrl))
    this.expectStatus(response, [200, 204], '删除 WebDAV 数据版本')
  }

  private async ensureCollection(): Promise<void> {
    const exists = await this.request('PROPFIND', this.directoryUrl, undefined, { Depth: '0' })
    if (exists.status === 207 || exists.status === 200) return
    if (exists.status !== 404) this.expectStatus(exists, [207, 200], '检查 WebDAV 备份目录')
    const created = await this.request('MKCOL', this.directoryUrl)
    this.expectStatus(created, [201, 405], '创建 WebDAV 备份目录')
  }

  private async request(
    method: string,
    url: URL,
    body?: Buffer,
    extraHeaders: Record<string, string> = {},
  ): Promise<WebDavResponse> {
    const headers = { ...extraHeaders }
    if (body) headers['Content-Length'] = String(body.byteLength)
    if (this.config.authType === 'basic') {
      headers.Authorization = `Basic ${Buffer.from(`${this.config.username}:${this.config.secret}`, 'utf8').toString('base64')}`
      return this.requestFollowingRedirects(method, url, body, headers)
    }
    if (this.config.authType === 'token') {
      headers.Authorization = `Bearer ${this.config.secret}`
      return this.requestFollowingRedirects(method, url, body, headers)
    }
    const challenge = await this.requestFollowingRedirects(method, url, body, headers)
    if (challenge.status !== 401) return challenge
    const authenticate = asArray(challenge.headers['www-authenticate']).find((value) => /^\s*Digest\s+/i.test(value))
    if (!authenticate) throw new Error('WebDAV 服务器未提供 Digest 认证')
    return this.requestFollowingRedirects(method, url, body, {
      ...headers,
      Authorization: createDigestAuthorization(method, challenge.url, this.config.username, this.config.secret, authenticate),
    })
  }

  private async requestFollowingRedirects(
    method: string,
    url: URL,
    body: Buffer | undefined,
    headers: Record<string, string>,
    redirects = 0,
  ): Promise<WebDavResponse> {
    const response = await this.requestOnce(method, url, body, headers)
    if (![301, 302, 307, 308].includes(response.status) || !response.headers.location) return response
    if (redirects >= 3) throw new Error('WebDAV 端点重定向次数过多')
    const redirected = new URL(response.headers.location, url)
    if (redirected.origin !== url.origin) throw new Error('WebDAV 端点试图重定向到其他站点')
    return this.requestFollowingRedirects(method, redirected, body, headers, redirects + 1)
  }

  private requestOnce(
    method: string,
    url: URL,
    body: Buffer | undefined,
    headers: Record<string, string>,
  ): Promise<WebDavResponse> {
    return new Promise((resolve, reject) => {
      const transport = url.protocol === 'https:' ? httpsRequest : httpRequest
      const request = transport(url, {
        method,
        headers,
        rejectUnauthorized: this.config.rejectUnauthorized,
        timeout: 20_000,
      }, (response) => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.byteLength
          if (size > MAX_RESPONSE_BYTES) {
            request.destroy(new Error('WebDAV 响应超过 32 MiB 限制'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => resolve({
          url,
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }))
      })
      request.on('timeout', () => request.destroy(new Error('WebDAV 请求超时')))
      request.on('error', reject)
      if (body) request.write(body)
      request.end()
    })
  }

  private expectStatus(response: WebDavResponse, allowed: number[], action: string): void {
    if (allowed.includes(response.status)) return
    const detail = response.body.toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 300)
    throw new Error(`${action}失败（HTTP ${response.status}${detail ? `：${detail}` : ''}）`)
  }
}
