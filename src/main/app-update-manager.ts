import { app, net, shell } from 'electron'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { finished } from 'node:stream/promises'
import type { AppUpdateState, OperationResult } from '../shared/contracts'
import {
  compareAppVersions,
  parseChecksums,
  plainTextReleaseNotes,
  selectReleaseAsset,
  type GithubReleaseAsset,
} from './app-update-utils'

interface GithubRelease {
  tag_name: string
  name: string | null
  body: string | null
  html_url: string
  assets: GithubReleaseAsset[]
}

const RELEASE_API_URL = 'https://api.github.com/repos/Secret799/dji-cloud-debug-tool/releases/latest'
const USER_AGENT = 'DJI-Cloud-Studio-Updater'

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export class AppUpdateManager {
  private state: AppUpdateState
  private release?: GithubRelease
  private installerAsset?: GithubReleaseAsset
  private installerPath?: string
  private checkPromise?: Promise<AppUpdateState>
  private downloadPromise?: Promise<OperationResult>

  constructor(private readonly notify: (state: AppUpdateState) => void) {
    this.state = {
      status: process.platform === 'darwin' || process.platform === 'win32' ? 'idle' : 'unsupported',
      currentVersion: app.getVersion(),
      error: process.platform === 'darwin' || process.platform === 'win32'
        ? undefined
        : '当前平台暂无可用的桌面安装包',
    }
  }

  getState(): AppUpdateState {
    return { ...this.state }
  }

  check(): Promise<AppUpdateState> {
    if (this.checkPromise) return this.checkPromise
    if (this.state.status === 'unsupported') return Promise.resolve(this.getState())
    this.checkPromise = this.performCheck().finally(() => {
      this.checkPromise = undefined
    })
    return this.checkPromise
  }

  download(): Promise<OperationResult> {
    if (this.downloadPromise) return this.downloadPromise
    this.downloadPromise = this.performDownload().finally(() => {
      this.downloadPromise = undefined
    })
    return this.downloadPromise
  }

  async openInstaller(): Promise<OperationResult> {
    if (!this.installerPath || this.state.status !== 'downloaded') {
      return { ok: false, error: '更新安装包尚未下载完成' }
    }
    const openError = await shell.openPath(this.installerPath)
    if (openError) return { ok: false, error: openError }
    if (process.platform === 'win32') setTimeout(() => app.quit(), 500)
    return { ok: true }
  }

  private setState(patch: Partial<AppUpdateState>): void {
    this.state = { ...this.state, ...patch }
    this.notify(this.getState())
  }

  private async performCheck(): Promise<AppUpdateState> {
    this.release = undefined
    this.installerAsset = undefined
    this.installerPath = undefined
    this.setState({ status: 'checking', availableVersion: undefined, releaseName: undefined, releaseNotes: undefined, releaseUrl: undefined, progress: undefined, error: undefined })
    try {
      const response = await net.fetch(RELEASE_API_URL, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT },
      })
      if (!response.ok) throw new Error(`GitHub Releases 请求失败（HTTP ${response.status}）`)
      const release = await response.json() as GithubRelease
      const availableVersion = release.tag_name.replace(/^v/i, '')
      if (compareAppVersions(availableVersion, this.state.currentVersion) <= 0) {
        this.setState({ status: 'not-available', availableVersion, releaseUrl: release.html_url })
        return this.getState()
      }

      const installerAsset = selectReleaseAsset(release.assets, process.platform, process.arch)
      if (!installerAsset) throw new Error(`新版本没有适用于 ${process.platform}/${process.arch} 的安装包`)
      this.release = release
      this.installerAsset = installerAsset
      this.setState({
        status: 'available',
        availableVersion,
        releaseName: release.name ?? `DJI Cloud Studio v${availableVersion}`,
        releaseNotes: plainTextReleaseNotes(release.body),
        releaseUrl: release.html_url,
      })
    } catch (error) {
      this.setState({ status: 'error', error: errorMessage(error) })
    }
    return this.getState()
  }

  private async performDownload(): Promise<OperationResult> {
    if (!this.release || !this.installerAsset || this.state.status !== 'available') {
      return { ok: false, error: '请先检查并确认有可用更新' }
    }
    try {
      this.setState({ status: 'downloading', progress: 0, error: undefined })
      const checksumAsset = this.release.assets.find((asset) => asset.name === 'SHA256SUMS.txt')
      if (!checksumAsset) throw new Error('发布版本缺少 SHA256SUMS.txt，已拒绝下载')
      const checksumResponse = await net.fetch(checksumAsset.browser_download_url, {
        headers: { 'User-Agent': USER_AGENT },
      })
      if (!checksumResponse.ok) throw new Error(`下载校验文件失败（HTTP ${checksumResponse.status}）`)
      const expectedHash = parseChecksums(await checksumResponse.text()).get(this.installerAsset.name)
      if (!expectedHash) throw new Error('校验文件中没有当前安装包的 SHA-256')

      const targetDirectory = join(app.getPath('temp'), 'dji-cloud-studio-updates', this.state.availableVersion ?? 'latest')
      await mkdir(targetDirectory, { recursive: true })
      const targetPath = join(targetDirectory, basename(this.installerAsset.name))
      await rm(targetPath, { force: true })
      const response = await net.fetch(this.installerAsset.browser_download_url, {
        headers: { 'User-Agent': USER_AGENT },
      })
      if (!response.ok || !response.body) throw new Error(`下载安装包失败（HTTP ${response.status}）`)

      const total = Number(response.headers.get('content-length')) || this.installerAsset.size
      const reader = response.body.getReader()
      const output = createWriteStream(targetPath, { flags: 'wx' })
      const hash = createHash('sha256')
      let loaded = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const chunk = Buffer.from(value)
          hash.update(chunk)
          loaded += chunk.length
          await new Promise<void>((resolve, reject) => {
            output.write(chunk, (error) => error ? reject(error) : resolve())
          })
          const progress = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : undefined
          if (progress !== this.state.progress) this.setState({ progress })
        }
        output.end()
        await finished(output)
      } catch (error) {
        void reader.cancel()
        output.destroy()
        await rm(targetPath, { force: true })
        throw error
      }

      if (hash.digest('hex') !== expectedHash) {
        await rm(targetPath, { force: true })
        throw new Error('安装包 SHA-256 校验失败，文件可能不完整')
      }
      this.installerPath = targetPath
      this.setState({ status: 'downloaded', progress: 100 })
      return { ok: true }
    } catch (error) {
      const message = errorMessage(error)
      this.setState({ status: 'error', error: message })
      return { ok: false, error: message }
    }
  }
}
