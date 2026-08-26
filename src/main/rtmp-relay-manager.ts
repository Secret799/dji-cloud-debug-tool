import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { delimiter, join } from 'node:path'
import type { Readable } from 'node:stream'
import { app } from 'electron'
import type { OperationResult, RtmpRelayStartResult } from '../shared/contracts'

interface RelaySession {
  sourceUrl: string
  processes: Set<ChildProcessByStdio<null, Readable, Readable>>
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

export class RtmpRelayManager {
  private server: Server | undefined
  private serverPort = 0
  private startPromise: Promise<number> | undefined
  private ffmpegPath: string | undefined
  private readonly sessions = new Map<string, RelaySession>()

  async start(sourceUrl: string): Promise<RtmpRelayStartResult> {
    try {
      await this.resolveFfmpegPath()
      const port = await this.ensureServer()
      const relayId = crypto.randomUUID()
      this.sessions.set(relayId, { sourceUrl, processes: new Set() })
      return {
        ok: true,
        relayId,
        playbackUrl: `http://127.0.0.1:${port}/rtmp-relay/${relayId}.flv`,
      }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  }

  stop(relayId: string): OperationResult {
    const session = this.sessions.get(relayId)
    if (!session) return { ok: true }
    this.sessions.delete(relayId)
    session.processes.forEach((process) => process.kill('SIGTERM'))
    session.processes.clear()
    return { ok: true }
  }

  async close(): Promise<void> {
    for (const relayId of [...this.sessions.keys()]) this.stop(relayId)
    const server = this.server
    this.server = undefined
    this.serverPort = 0
    this.startPromise = undefined
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async ensureServer(): Promise<number> {
    if (this.server?.listening && this.serverPort) return this.serverPort
    if (this.startPromise) return this.startPromise
    this.startPromise = new Promise<number>((resolve, reject) => {
      const server = createServer((request, response) => this.handleRequest(request.url ?? '', response))
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          server.close()
          reject(new Error('无法创建本地 RTMP 播放端口'))
          return
        }
        server.removeListener('error', reject)
        this.server = server
        this.serverPort = address.port
        resolve(address.port)
      })
    }).finally(() => {
      this.startPromise = undefined
    })
    return this.startPromise
  }

  private handleRequest(rawPath: string, response: ServerResponse): void {
    const match = /^\/rtmp-relay\/([a-f0-9-]+)\.flv$/.exec(rawPath.split('?')[0])
    const session = match ? this.sessions.get(match[1]) : undefined
    if (!session) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('RTMP relay not found')
      return
    }

    const process = spawn(this.ffmpegPath!, [
      '-hide_banner',
      '-loglevel', 'error',
      '-rw_timeout', '15000000',
      '-i', session.sourceUrl,
      '-map', '0:v:0?',
      '-map', '0:a:0?',
      '-c', 'copy',
      '-f', 'flv',
      '-flvflags', 'no_duration_filesize',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    session.processes.add(process)
    let recentError = ''
    let responseStarted = false
    process.stderr.on('data', (chunk: Buffer) => {
      recentError = `${recentError}${chunk.toString('utf8')}`.slice(-2_000)
    })
    process.stdout.once('data', () => {
      responseStarted = true
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'Content-Type': 'video/x-flv',
      })
    })
    process.stdout.pipe(response)

    const finish = (): void => {
      session.processes.delete(process)
      if (!process.killed) process.kill('SIGTERM')
    }
    response.once('close', finish)
    process.once('exit', () => {
      session.processes.delete(process)
      if (!responseStarted && !response.headersSent) {
        response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end(recentError.trim() || 'RTMP relay exited before media became available')
      } else if (!response.writableEnded) {
        response.end()
      }
    })
    process.once('error', (error) => {
      session.processes.delete(process)
      if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
      if (!response.writableEnded) response.end(error.message)
    })
  }

  private async resolveFfmpegPath(): Promise<string> {
    if (this.ffmpegPath) return this.ffmpegPath
    const pathCandidates = (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((path) => join(path, 'ffmpeg'))
    const candidates = [
      process.env.FFMPEG_PATH,
      app.isPackaged ? join(process.resourcesPath, 'ffmpeg', 'ffmpeg') : undefined,
      ...pathCandidates,
      '/opt/homebrew/bin/ffmpeg',
      '/usr/local/bin/ffmpeg',
      '/opt/homebrew/Caskroom/miniconda/base/bin/ffmpeg',
    ].filter((path): path is string => Boolean(path))

    for (const candidate of [...new Set(candidates)]) {
      try {
        await access(candidate, constants.X_OK)
        this.ffmpegPath = candidate
        return candidate
      } catch {
        // Continue through the known executable locations.
      }
    }
    throw new Error('未找到 FFmpeg，无法在应用内播放 RTMP；请安装 FFmpeg 或设置 FFMPEG_PATH')
  }
}
