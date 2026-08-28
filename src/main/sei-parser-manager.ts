import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { app } from 'electron'
import type {
  OperationResult,
  SeiMessageDetail,
  SeiMessageDetailResult,
  SeiMessagePreview,
  SeiParserEvent,
  SeiParserStartRequest,
  SeiParserStartResult,
} from '../shared/contracts'
import { findFfmpegExecutable } from './ffmpeg-path'
import { BoundedSseParser, parseSecretEmsSeiEvent, type ServerSentEvent } from './secret-ems-sei'
import { AnnexBSeiStreamParser, type SeiCodec, type SeiParseResult } from './sei-parser'

interface SeiSession {
  id: string
  streamId: string
  sourceUrl: string
  source: SeiParserStartRequest['source']
  state: SeiParserEvent['state']
  codec?: SeiCodec
  process?: ChildProcessByStdio<null, Readable, Readable>
  abortController?: AbortController
  retryTimer?: NodeJS.Timeout
  eventTimer?: NodeJS.Timeout
  parser?: AnnexBSeiStreamParser
  stopped: boolean
  videoNalUnits: number
  seiNalUnits: number
  seiMessages: number
  malformedMessages: number
  latestMessages: SeiMessagePreview[]
  messagePayloads: Map<string, Buffer>
  detail?: string
  lastEmittedAt: number
}

type EventListener = (event: SeiParserEvent) => void

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)
const MAX_SEI_SESSIONS = 16
const MAX_RECENT_MESSAGES = 20

export const ffmpegAnnexBOutputForCodec = (codec: SeiCodec): { format: string; bitstreamFilter: string } =>
  codec === 'h264'
    ? { format: 'h264', bitstreamFilter: 'h264_mp4toannexb' }
    : { format: 'hevc', bitstreamFilter: 'hevc_mp4toannexb' }

const textPreview = (payload: Uint8Array, payloadType: number): string | undefined => {
  const content = payloadType === 5 && payload.length >= 16 ? payload.subarray(16) : payload
  if (!content.length) return undefined
  const decoded = new TextDecoder('utf-8').decode(content.subarray(0, 160))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '.')
    .trim()
  if (!decoded || decoded === '.'.repeat(decoded.length)) return undefined
  return decoded
}

const hexPreview = (payload: Uint8Array): string => [...payload.subarray(0, 32)]
  .map((value) => value.toString(16).padStart(2, '0'))
  .join(' ')

const fullText = (payload: Buffer, payloadType: number): string | undefined => {
  const content = payloadType === 5 && payload.length >= 16 ? payload.subarray(16) : payload
  if (!content.length) return undefined
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(content).replace(/\0+$/g, '')
    if (!decoded.trim()) return undefined
    const controls = decoded.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g)?.length ?? 0
    return controls / decoded.length > 0.02 ? undefined : decoded
  } catch {
    return undefined
  }
}

export const buildSeiMessageDetail = (preview: SeiMessagePreview, payload: Buffer): SeiMessageDetail => ({
  id: preview.id,
  payloadType: preview.payloadType,
  payloadSize: payload.length,
  uuid: preview.uuid,
  text: fullText(payload, preview.payloadType),
  hex: [...payload].map((value) => value.toString(16).padStart(2, '0')).join(' '),
  base64: payload.toString('base64'),
})

export class SeiParserManager {
  private readonly sessions = new Map<string, SeiSession>()
  private ffmpegPath: string | undefined

  constructor(private readonly onEvent: EventListener) {}

  async start(request: SeiParserStartRequest): Promise<SeiParserStartResult> {
    try {
      if (this.sessions.size >= MAX_SEI_SESSIONS) {
        return { ok: false, error: `SEI 解析会话不能超过 ${MAX_SEI_SESSIONS} 路` }
      }
      if (request.source === 'local-zlm') await this.resolveFfmpegPath()
      const id = crypto.randomUUID()
      let session: SeiSession
      const parser = request.source === 'local-zlm'
        ? new AnnexBSeiStreamParser((result) => this.handleNalUnit(session, result))
        : undefined
      session = {
        id,
        streamId: request.streamId,
        sourceUrl: request.url,
        source: request.source,
        state: 'waiting',
        parser,
        stopped: false,
        videoNalUnits: 0,
        seiNalUnits: 0,
        seiMessages: 0,
        malformedMessages: 0,
        latestMessages: [],
        messagePayloads: new Map(),
        detail: request.source === 'local-zlm' ? '等待本地 ZLMediaKit 码流' : '正在连接 SecretEMS SEI',
        lastEmittedAt: 0,
      }
      this.sessions.set(id, session)
      this.emit(session, true)
      if (request.source === 'local-zlm') this.spawnReader(session)
      else void this.connectSecretEms(session)
      return { ok: true, sessionId: id }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  }

  stop(sessionId: string): OperationResult {
    const session = this.sessions.get(sessionId)
    if (!session) return { ok: true }
    this.sessions.delete(sessionId)
    session.stopped = true
    session.state = 'stopped'
    session.detail = undefined
    if (session.retryTimer) clearTimeout(session.retryTimer)
    if (session.eventTimer) clearTimeout(session.eventTimer)
    if (session.process && !session.process.killed) session.process.kill('SIGTERM')
    session.abortController?.abort()
    session.parser?.reset()
    this.emit(session, true)
    return { ok: true }
  }

  close(): void {
    for (const sessionId of [...this.sessions.keys()]) this.stop(sessionId)
  }

  getMessageDetail(sessionId: string, messageId: string): SeiMessageDetailResult {
    const session = this.sessions.get(sessionId)
    if (!session) return { ok: false, error: 'SEI 解析会话不存在或已停止' }
    const preview = session.latestMessages.find((message) => message.id === messageId)
    const payload = session.messagePayloads.get(messageId)
    if (!preview || !payload) return { ok: false, error: 'SEI 消息详情已过期或不可用' }
    return { ok: true, message: buildSeiMessageDetail(preview, payload) }
  }

  private spawnReader(session: SeiSession): void {
    if (session.stopped || !this.sessions.has(session.id)) return
    session.parser!.reset()
    const probing = !session.codec
    const annexBOutput = session.codec ? ffmpegAnnexBOutputForCodec(session.codec) : undefined
    const outputArgs = session.codec
      ? [
          '-map', '0:v:0',
          '-an',
          '-c:v', 'copy',
          '-bsf:v', annexBOutput!.bitstreamFilter,
          '-f', annexBOutput!.format,
          'pipe:1',
        ]
      : [
          '-map', '0:v:0',
          '-an',
          '-c:v', 'copy',
          '-f', 'null',
          '-',
        ]
    const process = spawn(this.ffmpegPath!, [
      '-hide_banner',
      '-nostats',
      '-loglevel', 'info',
      '-rtsp_transport', 'tcp',
      '-rw_timeout', '5000000',
      '-i', session.sourceUrl,
      ...outputArgs,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    session.process = process
    let recentError = ''
    let receivedData = false

    process.stdout.on('data', (chunk: Buffer) => {
      if (session.stopped) return
      if (!receivedData) {
        receivedData = true
        session.state = 'running'
        session.detail = undefined
        this.emit(session, true)
      }
      session.parser!.push(chunk)
    })
    process.stderr.on('data', (chunk: Buffer) => {
      const output = chunk.toString('utf8')
      recentError = `${recentError}${output}`.slice(-2_000)
      const detectedCodec = /Video:\s*(?:h264|avc1)\b/i.test(recentError)
        ? 'h264'
        : /Video:\s*(?:hevc|h265|hev1)\b/i.test(recentError)
          ? 'h265'
          : undefined
      if (detectedCodec && detectedCodec !== session.codec) {
        session.codec = detectedCodec
        session.parser!.setCodec(detectedCodec)
        if (probing && !process.killed) process.kill('SIGTERM')
      }
    })
    process.once('error', (error) => {
      if (session.stopped) return
      session.state = 'error'
      session.detail = error.message
      this.emit(session, true)
    })
    process.once('exit', () => {
      if (session.process === process) session.process = undefined
      if (session.stopped || !this.sessions.has(session.id)) return
      session.state = 'waiting'
      session.detail = probing && session.codec
        ? `已识别 ${session.codec.toUpperCase()}，正在连接码流`
        : receivedData
        ? '码流已中断，正在重连'
        : this.compactFfmpegError(recentError)
      this.emit(session, true)
      session.retryTimer = setTimeout(() => this.spawnReader(session), probing && session.codec ? 0 : 2_000)
    })
  }

  private async connectSecretEms(session: SeiSession): Promise<void> {
    if (session.stopped || !this.sessions.has(session.id)) return
    const controller = new AbortController()
    session.abortController = controller
    const connectTimer = setTimeout(() => controller.abort(new Error('连接超时')), 10_000)
    try {
      const response = await fetch(session.sourceUrl, {
        headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
        signal: controller.signal,
      })
      clearTimeout(connectTimer)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
        throw new Error('响应不是 text/event-stream')
      }
      if (!response.body) throw new Error('响应没有事件流')

      session.state = 'waiting'
      session.detail = 'SecretEMS 已连接，等待码流'
      this.emit(session, true)
      const parser = new BoundedSseParser()
      const reader = response.body.getReader()
      try {
        while (!session.stopped) {
          const result = await reader.read()
          if (result.done) break
          for (const event of parser.push(result.value)) this.handleSecretEmsEvent(session, event)
        }
      } finally {
        reader.releaseLock()
      }
      if (!session.stopped) throw new Error('事件流已断开')
    } catch (error) {
      clearTimeout(connectTimer)
      if (session.stopped || controller.signal.aborted && !this.sessions.has(session.id)) return
      session.state = 'error'
      session.detail = `SecretEMS SEI 连接失败：${errorMessage(error)}，正在重连`
      this.emit(session, true)
    } finally {
      if (session.abortController === controller) session.abortController = undefined
    }
    if (!session.stopped && this.sessions.has(session.id)) {
      session.retryTimer = setTimeout(() => void this.connectSecretEms(session), 2_000)
    }
  }

  private handleSecretEmsEvent(session: SeiSession, event: ServerSentEvent): void {
    if (session.stopped) return
    const update = parseSecretEmsSeiEvent(event)
    if (!update) return
    if (update.codec) session.codec = update.codec
    if (update.videoFrames !== undefined) session.videoNalUnits = update.videoFrames
    if (update.seiNalUnits !== undefined) session.seiNalUnits = update.seiNalUnits
    if (update.seiMessages !== undefined) session.seiMessages = update.seiMessages
    if (update.parseIssues !== undefined) session.malformedMessages = update.parseIssues
    if (update.recentMessages) {
      session.latestMessages = update.recentMessages
      session.messagePayloads.clear()
      for (const item of update.recentPayloads ?? []) session.messagePayloads.set(item.id, Buffer.from(item.payload))
    }
    if (update.message) {
      session.latestMessages.unshift(update.message)
      if (update.messagePayload) session.messagePayloads.set(update.message.id, Buffer.from(update.messagePayload))
      session.latestMessages = session.latestMessages.slice(0, MAX_RECENT_MESSAGES)
      this.prunePayloads(session)
      session.seiMessages += 1
    }
    if (update.issue) session.malformedMessages += 1
    if (update.active !== undefined) {
      session.state = update.active ? 'running' : 'waiting'
      session.detail = update.active ? undefined : 'SecretEMS 已连接，等待码流'
    }
    this.emit(session, Boolean(update.message || update.issue || update.recentMessages))
  }

  private handleNalUnit(session: SeiSession, result: SeiParseResult): void {
    if (session.stopped) return
    session.videoNalUnits += 1
    session.seiNalUnits += result.seiNalUnitCount
    session.seiMessages += result.messages.length
    session.malformedMessages += result.issues.length
    if (result.codec) session.codec = result.codec
    for (const message of result.messages) {
      const id = crypto.randomUUID()
      session.latestMessages.unshift({
        id,
        at: Date.now(),
        codec: result.codec ?? session.codec ?? 'h264',
        payloadType: message.payloadType,
        payloadSize: message.payload.length,
        uuid: message.uuid,
        textPreview: textPreview(message.payload, message.payloadType),
        hexPreview: hexPreview(message.payload),
      })
      session.messagePayloads.set(id, Buffer.from(message.payload))
    }
    session.latestMessages = session.latestMessages.slice(0, MAX_RECENT_MESSAGES)
    this.prunePayloads(session)
    this.emit(session, result.messages.length > 0 || result.issues.length > 0)
  }

  private emit(session: SeiSession, immediate: boolean): void {
    const now = Date.now()
    const elapsed = now - session.lastEmittedAt
    if (!immediate && elapsed < 1_000) {
      if (!session.eventTimer) {
        session.eventTimer = setTimeout(() => {
          session.eventTimer = undefined
          if (!session.stopped) this.emit(session, true)
        }, 1_000 - elapsed)
      }
      return
    }
    session.lastEmittedAt = now
    this.onEvent({
      sessionId: session.id,
      streamId: session.streamId,
      source: session.source,
      state: session.state,
      at: now,
      codec: session.codec,
      videoNalUnits: session.videoNalUnits,
      seiNalUnits: session.seiNalUnits,
      seiMessages: session.seiMessages,
      malformedMessages: session.malformedMessages,
      latestMessages: session.latestMessages,
      detail: session.detail,
    })
  }

  private compactFfmpegError(stderr: string): string {
    const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    const detail = lines.at(-1) ?? '等待本地 ZLMediaKit 码流'
    return detail.length > 180 ? `${detail.slice(0, 177)}...` : detail
  }

  private prunePayloads(session: SeiSession): void {
    const retainedIds = new Set(session.latestMessages.map((message) => message.id))
    for (const id of session.messagePayloads.keys()) {
      if (!retainedIds.has(id)) session.messagePayloads.delete(id)
    }
  }

  private async resolveFfmpegPath(): Promise<string> {
    if (this.ffmpegPath) return this.ffmpegPath
    this.ffmpegPath = await findFfmpegExecutable({
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      overridePath: process.env.FFMPEG_PATH,
      searchPath: process.env.PATH,
    })
    return this.ffmpegPath
  }
}
