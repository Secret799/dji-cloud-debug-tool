import { app, net, shell } from 'electron'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { AppUpdateState, OperationResult } from '../shared/contracts'
import { APP_UPDATE_PUBLIC_KEY } from './app-update-public-key'
import {
  selectUpdateManifestAsset,
  verifyUpdateManifest,
  type UpdateManifest,
  type UpdateManifestAsset,
} from './app-update-manifest'
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
const RELEASES_URL = 'https://github.com/Secret799/dji-cloud-debug-tool/releases'
const LATEST_RELEASE_URL = `${RELEASES_URL}/latest`
const LATEST_DOWNLOAD_URL = `${RELEASES_URL}/latest/download`
const MANIFEST_URL = `${LATEST_DOWNLOAD_URL}/latest.json`
const MANIFEST_SIGNATURE_URL = `${LATEST_DOWNLOAD_URL}/latest.json.sig`
const USER_AGENT = 'HangarLab-Studio-Updater'
const CHECK_TIMEOUT_MS = 15_000

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export class AppUpdateManager {
  private state: AppUpdateState
  private release?: GithubRelease
  private manifestInstaller?: UpdateManifestAsset
  private installerAsset?: GithubReleaseAsset
  private installerPath?: string
  private checkPromise?: Promise<AppUpdateState>
  private downloadPromise?: Promise<OperationResult>

  constructor(
    private readonly notify: (state: AppUpdateState) => void,
    private readonly publicKeyPem: string = APP_UPDATE_PUBLIC_KEY,
  ) {
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

  private async fetchRelease(): Promise<GithubRelease> {
    const response = await net.fetch(RELEASE_API_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
    if (response.ok) return await response.json() as GithubRelease
    const apiError = `GitHub Releases 请求失败（HTTP ${response.status}）`
    if (response.status !== 403 && response.status !== 429) throw new Error(apiError)

    const reason = response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0'
      ? 'GitHub API 已限流，请稍后重试'
      : 'GitHub API 拒绝访问，请检查网络或代理设置'
    try {
      return await this.fetchPublicRelease()
    } catch (error) {
      throw new Error(`${apiError}；${reason}。公开发布页检查也失败：${errorMessage(error)}。可打开发布页面手动下载`)
    }
  }

  private async fetchPublicRelease(): Promise<GithubRelease> {
    // The public latest redirect and checksum asset do not consume REST API quota.
    const response = await net.fetch(LATEST_RELEASE_URL, {
      method: 'HEAD',
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`发布页面请求失败（HTTP ${response.status}）`)
    const prefix = `${RELEASES_URL}/tag/`
    if (!response.url.startsWith(prefix)) throw new Error('发布页面未返回有效版本地址')
    const tag = decodeURIComponent(response.url.slice(prefix.length))
    const comparison = compareAppVersions(tag, this.state.currentVersion)
    const release: GithubRelease = { tag_name: tag, name: null, body: null, html_url: response.url, assets: [] }
    if (comparison <= 0) return release

    // Pin every asset to the resolved tag so a new release cannot mix versions.
    const downloadUrl = `${RELEASES_URL}/download/${encodeURIComponent(tag)}`
    const checksumUrl = `${downloadUrl}/SHA256SUMS.txt`
    const checksumResponse = await net.fetch(checksumUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
    if (!checksumResponse.ok) throw new Error(`下载校验文件失败（HTTP ${checksumResponse.status}）`)
    const checksums = parseChecksums(await checksumResponse.text())
    if (!checksums.size) throw new Error('发布版本的 SHA256SUMS.txt 无效')
    // Older manifests contain paths/spaces; GitHub normalizes asset spaces to dots.
    const names = new Set([...checksums.keys()].map((name) => name.replaceAll(' ', '.')))
    release.assets = [...names].map((name) => ({ name, size: 0, browser_download_url: `${downloadUrl}/${encodeURIComponent(name)}` }))
    release.assets.push({ name: 'SHA256SUMS.txt', size: 0, browser_download_url: checksumUrl })
    return release
  }

  private async fetchManifest(): Promise<UpdateManifest | undefined> {
    let response: Response
    try {
      response = await net.fetch(MANIFEST_URL, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      })
    } catch {
      return undefined
    }
    // 旧版本发布没有清单，回退到 GitHub API 检查；清单存在但签名无效时直接报错，绝不降级绕过验签。
    if (!response.ok) return undefined
    const manifestText = await response.text()
    const signatureResponse = await net.fetch(MANIFEST_SIGNATURE_URL, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
    if (!signatureResponse.ok) throw new Error(`更新清单签名下载失败（HTTP ${signatureResponse.status}）`)
    return verifyUpdateManifest(manifestText, await signatureResponse.text(), this.publicKeyPem)
  }

  private async performCheck(): Promise<AppUpdateState> {
    this.release = undefined
    this.manifestInstaller = undefined
    this.installerAsset = undefined
    this.installerPath = undefined
    this.setState({ status: 'checking', availableVersion: undefined, releaseName: undefined, releaseNotes: undefined, releaseUrl: LATEST_RELEASE_URL, progress: undefined, error: undefined })
    try {
      const manifest = await this.fetchManifest()
      if (manifest) {
        const availableVersion = manifest.version
        if (compareAppVersions(availableVersion, this.state.currentVersion) <= 0) {
          this.setState({ status: 'not-available', availableVersion, releaseUrl: `${RELEASES_URL}/tag/${manifest.tag}` })
          return this.getState()
        }
        const installer = selectUpdateManifestAsset(manifest, process.platform, process.arch)
        this.manifestInstaller = installer
        this.installerAsset = {
          name: installer.name,
          size: installer.size,
          browser_download_url: `${RELEASES_URL}/download/${manifest.tag}/${encodeURIComponent(installer.name)}`,
        }
        this.setState({
          status: 'available',
          availableVersion,
          releaseName: `航坞联调台 v${availableVersion}`,
          releaseNotes: plainTextReleaseNotes(manifest.notes),
          releaseUrl: `${RELEASES_URL}/tag/${manifest.tag}`,
        })
        return this.getState()
      }

      const release = await this.fetchRelease()
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
        releaseName: release.name ?? `航坞联调台 v${availableVersion}`,
        releaseNotes: plainTextReleaseNotes(release.body),
        releaseUrl: release.html_url,
      })
    } catch (error) {
      this.setState({ status: 'error', error: errorMessage(error) })
    }
    return this.getState()
  }

  private async expectedInstallerHash(): Promise<string> {
    if (this.manifestInstaller) return this.manifestInstaller.sha256
    if (!this.release || !this.installerAsset) throw new Error('发布版本缺少校验信息')
    const checksumAsset = this.release.assets.find((asset) => asset.name === 'SHA256SUMS.txt')
    if (!checksumAsset) throw new Error('发布版本缺少 SHA256SUMS.txt，已拒绝下载')
    const checksumResponse = await net.fetch(checksumAsset.browser_download_url, {
      headers: { 'User-Agent': USER_AGENT },
    })
    if (!checksumResponse.ok) throw new Error(`下载校验文件失败（HTTP ${checksumResponse.status}）`)
    const expectedHash = parseChecksums(await checksumResponse.text()).get(this.installerAsset.name)
    if (!expectedHash) throw new Error('校验文件中没有当前安装包的 SHA-256')
    return expectedHash
  }

  private async performDownload(): Promise<OperationResult> {
    if (!this.installerAsset || this.state.status !== 'available') {
      return { ok: false, error: '请先检查并确认有可用更新' }
    }
    try {
      this.setState({ status: 'downloading', progress: 0, error: undefined })
      const expectedHash = await this.expectedInstallerHash()

      const targetDirectory = join(app.getPath('temp'), 'dji-cloud-studio-updates', this.state.availableVersion ?? 'latest')
      await mkdir(targetDirectory, { recursive: true })
      const targetPath = join(targetDirectory, basename(this.installerAsset.name))
      await rm(targetPath, { force: true })
      const response = await net.fetch(this.installerAsset.browser_download_url, {
        headers: { 'User-Agent': USER_AGENT },
      })
      if (!response.ok || !response.body) throw new Error(`下载安装包失败（HTTP ${response.status}）`)

      const total = Number(response.headers.get('content-length')) || this.installerAsset.size
      const hash = createHash('sha256')
      let loaded = 0
      const progressStream = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          hash.update(chunk)
          loaded += chunk.length
          const progress = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : undefined
          if (progress !== this.state.progress) this.setState({ progress })
          callback(null, chunk)
        },
      })
      try {
        // Attach pipeline error handlers in the same turn that opens the file.
        await pipeline(
          Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>),
          progressStream,
          createWriteStream(targetPath, { flags: 'wx' }),
        )
        if (hash.digest('hex') !== expectedHash) throw new Error('安装包 SHA-256 校验失败，文件可能不完整')
      } catch (error) {
        await rm(targetPath, { force: true }).catch(() => {})
        throw error
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
