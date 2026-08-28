import electronPath from 'electron'
import { mkdtemp, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const projectRoot = resolve(import.meta.dirname, '..')
const userData = await mkdtemp(join(tmpdir(), 'dji-cloud-studio-webdav-'))
const secondUserData = await mkdtemp(join(tmpdir(), 'dji-cloud-studio-webdav-second-'))
const screenshotPath = process.env.DJI_STUDIO_WEBDAV_SCREENSHOT || join(tmpdir(), 'dji-cloud-studio-webdav.png')
const screenshotBase = screenshotPath.replace(/\.png$/i, '')
const errors = []
const files = new Map()
let collectionExists = false
const expectedAuthorization = `Basic ${Buffer.from('admin:example-secret').toString('base64')}`
const webDavServer = createServer((request, response) => {
  if (request.headers.authorization !== expectedAuthorization) {
    response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="smoke"' }).end()
    return
  }
  const path = new URL(request.url || '/', 'http://localhost').pathname
  const fileName = decodeURIComponent(path.split('/').at(-1) || '')
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
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
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
await new Promise((resolve) => webDavServer.listen(0, '127.0.0.1', resolve))
const webDavAddress = webDavServer.address()
const webDavEndpoint = `http://127.0.0.1:${webDavAddress.port}/dav/`

const electronApp = await electron.launch({
  executablePath: electronPath,
  args: [projectRoot, `--user-data-dir=${userData}`],
  cwd: projectRoot,
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
})
let firstElectronAppClosed = false
let secondElectronApp

const waitForJson = async (path, predicate, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(path, 'utf8'))
      if (predicate(value)) return value
    } catch {
      // The application may still be writing its first document.
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`Timed out waiting for ${path}`)
}

const inspectBounds = async (window, selectors, label) => {
  const results = await window.evaluate((targets) => targets.map((selector) => {
    const element = document.querySelector(selector)
    if (!(element instanceof HTMLElement)) return { selector, missing: true }
    const rect = element.getBoundingClientRect()
    return {
      selector,
      missing: false,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      overflowX: getComputedStyle(element).overflowX,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
    }
  }), selectors)
  for (const result of results) {
    if (result.missing) {
      errors.push(`${label}: missing ${result.selector}`)
      continue
    }
    if (result.left < -1 || result.right > result.viewportWidth + 1 || result.top < -1 || result.bottom > result.viewportHeight + 1) {
      errors.push(`${label}: ${result.selector} is outside viewport`)
    }
    if (['hidden', 'clip'].includes(result.overflowX) && result.scrollWidth > result.clientWidth + 1) {
      errors.push(`${label}: ${result.selector} clips horizontal content`)
    }
  }
}

try {
  const window = await electronApp.firstWindow()
  window.on('pageerror', (error) => errors.push(error.message))
  window.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  await window.locator('.app-shell').waitFor({ state: 'visible', timeout: 15_000 })

  const browserWindow = await electronApp.browserWindow(window)
  await browserWindow.evaluate((instance) => instance.setContentSize(1024, 680))
  await window.waitForFunction(() => innerWidth === 1024 && innerHeight === 680)

  await window.getByRole('button', { name: '云同步', exact: true }).click()
  await window.locator('.data-versions-page').waitFor({ state: 'visible' })
  await window.locator('.version-empty').waitFor({ state: 'visible' })
  await inspectBounds(window, [
    '.data-versions-page',
    '.webdav-account-band',
    '.version-summary-grid',
    '.data-version-actions',
    '.data-version-layout',
  ], 'page')
  await window.screenshot({ path: `${screenshotBase}-page.png` })

  await window.getByRole('button', { name: 'WebDAV 设置', exact: true }).click()
  const dialog = window.getByRole('dialog', { name: 'WebDAV 设置' })
  await dialog.waitFor({ state: 'visible' })
  await dialog.getByLabel('端点地址').fill(webDavEndpoint)
  await dialog.getByLabel('用户名').fill('admin')
  await dialog.getByLabel('密码', { exact: true }).fill('example-secret')
  await dialog.getByLabel('认证方式').selectOption('digest')
  await dialog.getByLabel('允许不安全的连接（忽略证书错误）').check()
  await inspectBounds(window, ['.webdav-settings-modal', '.webdav-settings-footer'], 'settings')
  await window.screenshot({ path: `${screenshotBase}-settings.png` })

  await dialog.getByLabel('认证方式').selectOption('token')
  if (await dialog.getByLabel('用户名', { exact: true }).count()) errors.push('settings: username remains visible for Token authentication')
  if (!(await dialog.getByLabel('Token', { exact: true }).isVisible())) errors.push('settings: Token secret field is not visible')

  await dialog.getByLabel('认证方式').selectOption('basic')
  await dialog.getByLabel('允许不安全的连接（忽略证书错误）').uncheck()
  await dialog.getByRole('button', { name: '测试连接', exact: true }).click()
  await dialog.getByText('连接成功，备份目录可以使用', { exact: true }).waitFor({ state: 'visible' })
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await window.getByText('云同步已启用', { exact: true }).waitFor({ state: 'visible' })
  const syncRailButton = window.getByRole('button', { name: '云同步', exact: true })
  await syncRailButton.waitFor({ state: 'visible' })
  if (!(await syncRailButton.evaluate((element) => element.classList.contains('sync-enabled')))) {
    errors.push('sync: navigation does not show the enabled state')
  }
  if (!(await syncRailButton.locator('.rail-sync-indicator').isVisible())) {
    errors.push('sync: enabled status indicator is not visible')
  }
  await syncRailButton.hover()
  const syncTooltip = window.getByRole('tooltip')
  await syncTooltip.waitFor({ state: 'visible' })
  if (await syncTooltip.textContent() !== '云同步已启用') {
    errors.push(`sync: unexpected enabled tooltip (${JSON.stringify(await syncTooltip.textContent())})`)
  }
  await window.mouse.move(500, 350)
  await syncTooltip.waitFor({ state: 'hidden' })
  await window.getByRole('button', { name: '立即同步', exact: true }).click()
  await window.locator('.version-history-row').getByText('v1', { exact: true }).waitFor({ state: 'visible' })
  if (files.size !== 1) errors.push(`sync: expected one uploaded version, received ${files.size}`)
  const uploadedBody = files.values().next().value?.toString('utf8') || ''
  if (uploadedBody.includes('本地调试')) errors.push('sync: uploaded version contains unencrypted profile data')
  await window.screenshot({ path: `${screenshotBase}-synced.png` })

  await electronApp.close()
  firstElectronAppClosed = true
  const firstProfiles = JSON.parse(await readFile(join(userData, 'connection-profiles.json'), 'utf8'))
  const firstProfileId = firstProfiles.profiles[0]?.id
  const versionsBeforeSecondClient = [...files.keys()].filter((name) => name.endsWith('.djibak')).sort()
  const firstVersionId = versionsBeforeSecondClient.at(-1)
  secondElectronApp = await electron.launch({
    executablePath: electronPath,
    args: [projectRoot, `--user-data-dir=${secondUserData}`],
    cwd: projectRoot,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  })
  const secondWindow = await secondElectronApp.firstWindow()
  secondWindow.on('pageerror', (error) => errors.push(`second client: ${error.message}`))
  secondWindow.on('console', (message) => { if (message.type() === 'error') errors.push(`second client: ${message.text()}`) })
  await secondWindow.locator('.app-shell').waitFor({ state: 'visible', timeout: 15_000 })
  await secondWindow.getByRole('button', { name: '云同步', exact: true }).click()
  await secondWindow.getByRole('button', { name: 'WebDAV 设置', exact: true }).click()
  const secondDialog = secondWindow.getByRole('dialog', { name: 'WebDAV 设置' })
  await secondDialog.getByLabel('端点地址').fill(webDavEndpoint)
  await secondDialog.getByLabel('用户名').fill('admin')
  await secondDialog.getByLabel('密码', { exact: true }).fill('example-secret')
  await secondDialog.getByRole('button', { name: '保存', exact: true }).click()
  await waitForJson(
    join(secondUserData, 'webdav-sync-state.json'),
    (state) => state.baseVersionId === firstVersionId,
  )
  const secondProfiles = JSON.parse(await readFile(join(secondUserData, 'connection-profiles.json'), 'utf8'))
  if (secondProfiles.profiles[0]?.id !== firstProfileId) {
    errors.push('second client: cloud profiles were not applied as the initial baseline')
  }
  const versionFiles = [...files.keys()].filter((name) => name.endsWith('.djibak'))
  if (versionFiles.length !== versionsBeforeSecondClient.length) {
    errors.push(`second client: initial synchronization increased version count from ${versionsBeforeSecondClient.length} to ${versionFiles.length}`)
  }

  process.stdout.write(`${JSON.stringify({ screenshotBase, errors }, null, 2)}\n`)
  if (errors.length) process.exitCode = 1
} finally {
  if (secondElectronApp) await secondElectronApp.close()
  if (!firstElectronAppClosed) await electronApp.close()
  await new Promise((resolve, reject) => webDavServer.close((error) => error ? reject(error) : resolve()))
}
