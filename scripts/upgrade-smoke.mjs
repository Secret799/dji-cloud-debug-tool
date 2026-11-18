import { execFileSync } from 'node:child_process'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

/**
 * 覆盖升级冒烟：在隔离的 CI macOS runner 上装旧版 → 经 djiApi 写入可识别数据 → 装新版 → 校验迁移。
 *
 * 约束（来自验收口径）：
 * - 不传 `--user-data-dir`，也不设 DJI_STUDIO_SKIP_LEGACY_MIGRATION：迁移的源与目标都由应用自身决定，
 *   覆盖默认目录才能测到真实路径；runner 是干净的，所以默认目录即测试数据。
 * - 旧版测试数据全部经 window.djiApi 写入，不手写 JSON，避免 schema 漂移让用例变成假绿。
 */

const projectRoot = resolve(import.meta.dirname, '..')
const dryRun = process.env.UPGRADE_SMOKE_DRY_RUN === '1'
const oldVersion = process.env.UPGRADE_SMOKE_OLD_VERSION ?? 'v1.3.1'
const expectedNewVersion = process.env.UPGRADE_SMOKE_NEW_VERSION ?? '1.4.0'
const oldPackageDir = resolve(projectRoot, process.env.UPGRADE_SMOKE_OLD_DIR ?? 'old-package')
const newPackageDir = resolve(projectRoot, process.env.UPGRADE_SMOKE_NEW_DIR ?? 'new-package')
const installRoot = resolve(process.env.UPGRADE_SMOKE_INSTALL_ROOT ?? join(homedir(), 'Applications'))
const screenshotPath = resolve(process.env.UPGRADE_SMOKE_SCREENSHOT ?? join(projectRoot, 'upgrade-smoke.png'))
const reportPath = resolve(process.env.UPGRADE_SMOKE_REPORT ?? join(projectRoot, 'upgrade-smoke-report.json'))

const APP_ID = 'com.dji-cloud-studio.desktop'
const OLD_USER_DATA = join(homedir(), 'Library', 'Application Support', 'DJI Cloud Studio')
const NEW_USER_DATA = join(homedir(), 'Library', 'Application Support', 'HangarLab Studio')
const MARKER_NAME = '.user-data-migrated.json'
const SEED = {
  profile: '升级冒烟-1.3.1',
  media: '升级冒烟媒体',
  map: '升级冒烟底图',
  webdavUser: 'upgrade-smoke',
  sidebarWidth: '321',
  whitelistValue: '{"smoke":"ok"}',
}
/** 迁移后 marker.copied 必须覆盖这四项配置与渲染进程快照；其余 store 的空文档可有可无 */
const REQUIRED_COPIED = ['connection-profiles.json', 'media-servers.json', 'map-tile-sources.json', 'webdav-config.json', 'Local Storage']

const checks = []
const consoleErrors = []
const volumes = []

const record = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `：${detail}` : ''}`)
}

const sh = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const unmountAll = () => {
  while (volumes.length) {
    try {
      sh('hdiutil', ['detach', volumes.pop(), '-force'])
    } catch {
      // 卸载失败不影响结论
    }
  }
}

const mountDmg = (file) => {
  const output = sh('hdiutil', ['attach', '-nobrowse', '-readonly', file])
  const mountPoint = output.split('\n')
    .map((line) => line.split('\t').pop()?.trim() ?? '')
    .find((value) => value.startsWith('/Volumes/'))
  if (!mountPoint) throw new Error(`无法挂载 ${file}`)
  volumes.push(mountPoint)
  return mountPoint
}

const pickPackage = async (directory, suffix) => {
  const names = await readdir(directory)
  const match = names.find((name) => name.endsWith(suffix))
  if (!match) throw new Error(`${directory} 里没有 ${suffix}`)
  return join(directory, match)
}

const findApp = async (directory) => {
  const names = await readdir(directory)
  const app = names.find((name) => name.endsWith('.app'))
  if (!app) throw new Error(`${directory} 里没有 .app`)
  return join(directory, app)
}

const plist = (appPath, key) => sh('plutil', ['-extract', key, 'raw', '-o', '-', join(appPath, 'Contents', 'Info.plist')]).trim()

const installApp = async (appPath, label) => {
  await mkdir(installRoot, { recursive: true })
  const target = join(installRoot, `${label}.app`)
  await rm(target, { recursive: true, force: true })
  sh('ditto', [appPath, target])
  return target
}

const appLogs = []

const launch = async (appPath) => {
  const application = await electron.launch({
    executablePath: join(appPath, 'Contents', 'MacOS', plist(appPath, 'CFBundleExecutable')),
    timeout: 30_000,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  })
  const child = application.process()
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) appLogs.push(`[${plist(appPath, 'CFBundleName')}] ${line.trim()}`)
      }
    })
  }
  return application
}

const attachErrorListeners = (window) => {
  window.on('pageerror', (error) => consoleErrors.push(error.message))
  window.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
}

const readMarker = async (userData) => JSON.parse(await readFile(join(userData, MARKER_NAME), 'utf8'))

const run = async () => {
  // 侧栏宽度的 localStorage 键名从渲染进程源码读取，脚本里不再抄一份
  const appSource = await readFile(join(projectRoot, 'src/renderer/src/App.tsx'), 'utf8')
  const sidebarKey = appSource.match(/const SIDEBAR_WIDTH_STORAGE_KEY = '([^']+)'/)?.[1]
  if (!sidebarKey) throw new Error('未能从 App.tsx 解析侧栏宽度存储键')

  // 再取一个 WebDAV 快照白名单键，验证 localStorage 整体迁移而不是单个键碰巧还在
  const validationSource = await readFile(join(projectRoot, 'src/main/ipc-validation.ts'), 'utf8')
  const whitelistBlock = validationSource.match(/ALLOWED_RENDERER_STORAGE_KEYS = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? ''
  const whitelistKey = [...whitelistBlock.matchAll(/'([^']+)'/g)]
    .map((match) => match[1])
    .find((key) => key !== sidebarKey)
  if (!whitelistKey) throw new Error('未能从 ipc-validation.ts 解析 localStorage 白名单键')

  const oldDmg = await pickPackage(oldPackageDir, 'mac-arm64.dmg')
  const newDmg = await pickPackage(newPackageDir, 'mac-arm64.dmg')

  const oldMount = mountDmg(oldDmg)
  const oldAppSource = await findApp(oldMount)
  record('旧版安装包内含 app bundle', true, oldAppSource)
  record('旧版 appId 与新版一致', plist(oldAppSource, 'CFBundleIdentifier') === APP_ID, plist(oldAppSource, 'CFBundleIdentifier'))
  const oldInstallTarget = await installApp(oldAppSource, `old-${oldVersion}-app`)
  unmountAll()

  const newMount = mountDmg(newDmg)
  const newAppSource = await findApp(newMount)
  record('新版安装包内含 app bundle', true, newAppSource)
  record('新版 appId 与旧版一致', plist(newAppSource, 'CFBundleIdentifier') === APP_ID, plist(newAppSource, 'CFBundleIdentifier'))
  const newInstallTarget = await installApp(newAppSource, `new-${expectedNewVersion}-app`)
  unmountAll()

  if (dryRun) {
    record('dry-run：跳过两版启动与数据校验', true, installRoot)
    return
  }

  // 新版启动前必须是全新目录，否则测到的不是「首次启动迁移」
  record('新版 userData 目录尚未预建', await stat(NEW_USER_DATA).then(() => false, () => true), NEW_USER_DATA)

  // ── 旧版：写入可识别数据 ───────────────────────────────────────────────
  const oldApp = await launch(oldInstallTarget)
  try {
    const window = await oldApp.firstWindow({ timeout: 20_000 })
    attachErrorListeners(window)
    await window.locator('.app-shell').waitFor({ state: 'visible', timeout: 20_000 })
    const seeded = await window.evaluate(async ({ seed, ids, key, width, extraKey, extraValue }) => {
      const [profile] = await window.djiApi.profiles.list()
      if (!profile) return { ok: false, reason: '旧版没有默认连接配置' }
      await window.djiApi.profiles.save({ ...profile, name: seed.profile, host: 'upgrade.smoke.local' })
      const now = Date.now()
      await window.djiApi.media.saveServer({
        id: ids.media,
        name: seed.media,
        kind: 'remote-zlm',
        host: 'upgrade.smoke.local',
        apiProtocol: 'http',
        apiPort: 8090,
        httpProtocol: 'http',
        httpPort: 8090,
        rtmpPort: 1935,
        rtspPort: 554,
        webrtcPort: 8000,
        secret: '',
        clearStoredSecret: true,
        createdAt: now,
        updatedAt: now,
      })
      await window.djiApi.map.saveSource({
        id: ids.map,
        name: seed.map,
        layer: 'imagery',
        kind: 'url-template',
        urlTemplate: 'https://upgrade.smoke.local/{z}/{x}/{y}.png',
        path: '',
        headers: [],
        coordinateSystem: 'wgs84',
        minZoom: 0,
        maxZoom: 18,
        tileSize: 256,
        tileExtension: '',
        attribution: '',
        createdAt: now,
        updatedAt: now,
      })
      await window.djiApi.webdav.saveConfig({
        endpoint: 'http://127.0.0.1:9/dav',
        authType: 'basic',
        username: seed.webdavUser,
        secret: 'upgrade-smoke',
        rejectUnauthorized: false,
        autoSync: false,
        syncStrategy: 'smart-merge',
        updatedAt: now,
      })
      window.localStorage.setItem(key, width)
      window.localStorage.setItem(extraKey, extraValue)
      return {
        ok: true,
        stored: window.localStorage.getItem(key),
        extra: window.localStorage.getItem(extraKey),
      }
    }, {
      seed: SEED,
      key: sidebarKey,
      width: SEED.sidebarWidth,
      extraKey: whitelistKey,
      extraValue: SEED.whitelistValue,
      ids: { media: 'upgrade-smoke-media', map: 'upgrade-smoke-map' },
    })
    record('旧版经 djiApi 写入 4 项配置与 localStorage', seeded.ok && seeded.stored === SEED.sidebarWidth, seeded.reason ?? seeded.stored)
  } finally {
    await oldApp.close().catch(() => {})
  }

  const oldProfiles = await readFile(join(OLD_USER_DATA, 'connection-profiles.json'), 'utf8').catch(() => '')
  record('旧版 userData 已生成并含测试配置', oldProfiles.includes(SEED.profile), OLD_USER_DATA)

  // ── 新版：校验迁移 ────────────────────────────────────────────────────
  const newApp = await launch(newInstallTarget)
  let migratedAt
  try {
    const window = await newApp.firstWindow({ timeout: 20_000 })
    attachErrorListeners(window)
    await window.locator('.app-shell').waitFor({ state: 'visible', timeout: 20_000 })

    const runtime = await newApp.evaluate(({ app }) => ({
      version: app.getVersion(),
      name: app.getName(),
      userData: app.getPath('userData'),
    }))
    record('新版版本号', runtime.version === expectedNewVersion, runtime.version)
    record('新版应用名', runtime.name === 'HangarLab Studio', runtime.name)
    record('新版 userData 指向新目录', runtime.userData === NEW_USER_DATA, runtime.userData)

    const view = await window.evaluate(async ({ key }) => {
      const [profiles, servers, sources, webdav] = await Promise.all([
        window.djiApi.profiles.list(),
        window.djiApi.media.listServers(),
        window.djiApi.map.listSources(),
        window.djiApi.webdav.resolveConfig(),
      ])
      return {
        profileNames: profiles.map((item) => item.name),
        serverNames: servers.map((item) => item.name),
        sourceNames: sources.map((item) => item.name),
        webdavUser: webdav?.username ?? '',
        stored: window.localStorage.getItem(key),
        extra: window.localStorage.getItem(extraKey),
        brand: document.querySelector('.brand-block strong')?.textContent ?? '',
        title: document.title,
      }
    }, { key: sidebarKey, extraKey: whitelistKey })

    record('连接配置已迁移', view.profileNames.includes(SEED.profile), view.profileNames.join('、'))
    record('媒体服务配置已迁移', view.serverNames.includes(SEED.media), view.serverNames.join('、'))
    record('底图源配置已迁移', view.sourceNames.includes(SEED.map), view.sourceNames.join('、'))
    record('WebDAV 配置已迁移', view.webdavUser === SEED.webdavUser, view.webdavUser)
    record('localStorage 侧栏宽度已迁移', view.stored === SEED.sidebarWidth, String(view.stored))
    record('localStorage 白名单键已迁移', view.extra === SEED.whitelistValue, String(view.extra))
    record('界面标题为新品牌', view.brand === '航坞联调台' && view.title.includes('航坞联调台'), `${view.brand} / ${view.title}`)

    const marker = await readMarker(NEW_USER_DATA)
    const missing = REQUIRED_COPIED.filter((name) => !marker.copied?.includes(name))
    record('迁移标记覆盖 4 项配置与 Local Storage', missing.length === 0, `copied=${marker.copied?.join('、') ?? ''}`)
    record('旧 userData 目录保留', await stat(join(OLD_USER_DATA, 'connection-profiles.json')).then(() => true, () => false), OLD_USER_DATA)
    migratedAt = marker.migratedAt

    await window.screenshot({ path: screenshotPath })
    record('启动截图已保存', true, screenshotPath)
  } finally {
    await newApp.close().catch(() => {})
  }

  // ── 二次启动：marker 不应重写 ──────────────────────────────────────────
  const relaunched = await launch(newInstallTarget)
  try {
    const window = await relaunched.firstWindow({ timeout: 20_000 })
    await window.locator('.app-shell').waitFor({ state: 'visible', timeout: 20_000 })
    const marker = await readMarker(NEW_USER_DATA)
    record('二次启动不重复迁移', marker.migratedAt === migratedAt, `${marker.migratedAt}`)
    record('二次启动后旧目录仍在', await stat(join(OLD_USER_DATA, 'connection-profiles.json')).then(() => true, () => false))
  } finally {
    await relaunched.close().catch(() => {})
  }
}

try {
  await run()
} catch (error) {
  record('升级冒烟执行异常', false, error instanceof Error ? error.message : String(error))
} finally {
  unmountAll()
}

if (consoleErrors.length > 0) {
  record('新版/旧版渲染进程无控制台报错', false, consoleErrors.slice(0, 5).join(' | '))
}

const failed = checks.filter((check) => !check.ok)
const report = { oldVersion, expectedNewVersion, dryRun, failed: failed.length, installRoot, checks, consoleErrors }
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8').catch(() => {})
// 主进程 stdout/stderr 单独落盘：失败时这是判断环境问题还是产品问题的关键证据
await writeFile(
  reportPath.replace(/\.json$/i, '') + '-stderr.log',
  `${appLogs.join('\n')}\n`,
  'utf8',
).catch(() => {})
console.log(JSON.stringify(report, null, 2))
if (failed.length > 0) process.exitCode = 1