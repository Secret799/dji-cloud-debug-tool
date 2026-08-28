import { app } from 'electron'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import type {
  MediaServerOperationResult,
  MediaServerProfile,
  MediaServerRuntime,
} from '../shared/contracts'
import { resolveMediaServerBinaryPath } from './media-server-path'
import { LOCAL_ZLM_ID, MediaServerStore } from './media-server-store'
import { probeMediaServer } from './media-server-probe'

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds))
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

export class MediaServerManager {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null
  private stopRequested = false
  private recentOutput = ''
  private runtime: MediaServerRuntime = {
    profileId: LOCAL_ZLM_ID,
    state: 'stopped',
    checkedAt: Date.now(),
  }

  constructor(
    private readonly store: MediaServerStore,
    private readonly onRuntime: (runtime: MediaServerRuntime) => void,
  ) {}

  async getLocalRuntime(): Promise<MediaServerRuntime> {
    const binaryAvailable = await this.hasBinary()
    return { ...this.runtime, binaryAvailable }
  }

  async check(profileId: string): Promise<MediaServerOperationResult> {
    const profile = await this.store.getWithSecret(profileId)
    if (!profile) return { ok: false, error: '媒体服务配置不存在' }
    const runtime = await this.probe(profile)
    if (profile.kind === 'local-zlm') this.setRuntime({ ...runtime, pid: this.child?.pid, binaryAvailable: await this.hasBinary() })
    return { ok: runtime.state === 'running', runtime, error: runtime.state === 'running' ? undefined : runtime.detail }
  }

  async startLocal(): Promise<MediaServerOperationResult> {
    if (this.child && this.runtime.state === 'running') return { ok: true, runtime: await this.getLocalRuntime() }
    const profile = await this.store.getWithSecret(LOCAL_ZLM_ID)
    if (!profile) return { ok: false, error: '本地 ZLMediaKit 配置不存在' }
    const binaryPath = this.binaryPath()
    if (!(await this.hasBinary())) {
      const runtime = this.setRuntime({
        profileId: LOCAL_ZLM_ID,
        state: 'error',
        checkedAt: Date.now(),
        binaryAvailable: false,
        detail: `未找到当前架构的 MediaServer：${binaryPath}`,
      })
      return { ok: false, runtime, error: runtime.detail }
    }

    try {
      await this.stopLocal()
      const paths = await this.prepareRuntime(profile)
      this.stopRequested = false
      this.recentOutput = ''
      this.setRuntime({ profileId: LOCAL_ZLM_ID, state: 'starting', checkedAt: Date.now(), binaryAvailable: true })
      const child = spawn(binaryPath, ['-c', paths.config, '-l', '2', '--affinity', '0', '--log-dir', paths.logs], {
        cwd: paths.root,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      this.child = child
      const capture = (chunk: Buffer): void => {
        this.recentOutput = `${this.recentOutput}${chunk.toString('utf8')}`.slice(-4_000)
      }
      child.stdout.on('data', capture)
      child.stderr.on('data', capture)
      child.once('error', (error) => {
        this.child = null
        this.setRuntime({ profileId: LOCAL_ZLM_ID, state: 'error', checkedAt: Date.now(), detail: error.message, binaryAvailable: true })
      })
      child.once('exit', (code, signal) => {
        if (this.child === child) this.child = null
        this.setRuntime({
          profileId: LOCAL_ZLM_ID,
          state: this.stopRequested ? 'stopped' : 'error',
          checkedAt: Date.now(),
          binaryAvailable: true,
          detail: this.stopRequested ? undefined : `MediaServer 已退出（code=${code ?? '-'}, signal=${signal ?? '-'}）${this.recentOutput ? `\n${this.recentOutput.slice(-600)}` : ''}`,
        })
      })

      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (this.child !== child) break
        const runtime = await this.probe(profile)
        if (runtime.state === 'running') {
          const next = this.setRuntime({ ...runtime, pid: child.pid, binaryAvailable: true })
          return { ok: true, runtime: next }
        }
        await delay(250)
      }
      const detail = this.recentOutput.slice(-1_000) || 'ZLMediaKit 启动超时，请检查端口是否被占用'
      await this.stopLocal()
      const runtime = this.setRuntime({ profileId: LOCAL_ZLM_ID, state: 'error', checkedAt: Date.now(), detail, binaryAvailable: true })
      return { ok: false, runtime, error: detail }
    } catch (error) {
      const detail = errorMessage(error)
      const runtime = this.setRuntime({ profileId: LOCAL_ZLM_ID, state: 'error', checkedAt: Date.now(), detail, binaryAvailable: await this.hasBinary() })
      return { ok: false, runtime, error: detail }
    }
  }

  async stopLocal(): Promise<MediaServerOperationResult> {
    const child = this.child
    this.stopRequested = true
    if (!child) {
      const runtime = this.setRuntime({ profileId: LOCAL_ZLM_ID, state: 'stopped', checkedAt: Date.now(), binaryAvailable: await this.hasBinary() })
      return { ok: true, runtime }
    }
    child.kill('SIGTERM')
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      delay(3_000).then(() => { if (!child.killed || this.child === child) child.kill('SIGKILL') }),
    ])
    if (this.child === child) this.child = null
    const runtime = this.setRuntime({ profileId: LOCAL_ZLM_ID, state: 'stopped', checkedAt: Date.now(), binaryAvailable: await this.hasBinary() })
    return { ok: true, runtime }
  }

  private async probe(profile: MediaServerProfile): Promise<MediaServerRuntime> {
    return probeMediaServer(profile)
  }

  private binaryPath(): string {
    return resolveMediaServerBinaryPath({
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    })
  }

  private async hasBinary(): Promise<boolean> {
    try {
      await access(this.binaryPath(), constants.X_OK)
      return true
    } catch {
      return false
    }
  }

  private async prepareRuntime(profile: MediaServerProfile): Promise<{ root: string; config: string; logs: string }> {
    const root = join(app.getPath('userData'), 'zlmediakit')
    const logs = join(root, 'logs')
    const www = join(root, 'www')
    const config = join(root, 'config.ini')
    await Promise.all([mkdir(logs, { recursive: true }), mkdir(www, { recursive: true })])
    const ini = [
      '[api]',
      'apiDebug=0',
      `secret=${profile.secret}`,
      `snapRoot=${join(www, 'snap')}`,
      `downloadRoot=${www}`,
      '',
      '[general]',
      'enableVhost=0',
      `mediaServerId=${crypto.randomUUID()}`,
      '',
      '[protocol]',
      'enable_hls=1',
      'enable_rtsp=1',
      'enable_rtmp=1',
      'enable_ts=1',
      'enable_fmp4=1',
      'enable_mp4=0',
      '',
      '[http]',
      `port=${profile.httpPort}`,
      'sslport=0',
      `rootPath=${www}`,
      'allow_cross_domains=1',
      '',
      '[rtmp]',
      `port=${profile.rtmpPort}`,
      'sslport=0',
      'directProxy=1',
      '',
      '[rtsp]',
      `port=${profile.rtspPort}`,
      'sslport=0',
      'directProxy=1',
      '',
      '[rtc]',
      'signalingPort=0',
      'signalingSslPort=0',
      'icePort=0',
      'iceTcpPort=0',
      'enableTurn=0',
      `port=${profile.webrtcPort}`,
      `tcpPort=${profile.webrtcPort}`,
      '',
      '[rtp_proxy]',
      'port=10000',
      'port_range=30000-35000',
      '',
      '[hls]',
      'segDur=2',
      'segNum=3',
      'segRetain=5',
      '',
      '[hook]',
      'enable=0',
      '',
      '[shell]',
      'port=0',
      '',
    ].join('\n')
    await writeFile(config, ini, { encoding: 'utf8', mode: 0o600 })
    return { root, config, logs }
  }

  private setRuntime(runtime: MediaServerRuntime): MediaServerRuntime {
    this.runtime = runtime
    this.onRuntime({ ...runtime })
    return { ...runtime }
  }
}
