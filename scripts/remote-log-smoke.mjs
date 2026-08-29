import electronPath from 'electron'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const projectRoot = resolve(import.meta.dirname, '..')
const userData = await mkdtemp(join(tmpdir(), 'dji-cloud-studio-log-smoke-'))
const screenshotPath = process.env.DJI_STUDIO_SCREENSHOT || join(tmpdir(), 'dji-cloud-studio-remote-logs.png')
const ossScreenshotPath = screenshotPath.replace(/\.png$/i, '-oss.png')
const errors = []

const electronApp = await electron.launch({
  executablePath: electronPath,
  args: [projectRoot, `--user-data-dir=${userData}`],
  cwd: projectRoot,
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
})

try {
  const window = await electronApp.firstWindow()
  window.on('pageerror', (error) => errors.push(error.message))
  window.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await window.locator('.app-shell').waitFor({ state: 'visible', timeout: 15_000 })

  const browserWindow = await electronApp.browserWindow(window)
  await browserWindow.evaluate((instance) => instance.setContentSize(1024, 680))
  await window.waitForFunction(() => window.innerWidth === 1024 && window.innerHeight === 680)

  await window.getByRole('button', { name: '添加设备' }).click()
  await window.locator('.device-modal select').first().selectOption('dock3')
  await window.locator('.device-modal input').nth(0).fill('日志测试机场')
  await window.locator('.device-modal input').nth(1).fill('DOCK-LOG-SMOKE-001')
  await window.getByRole('button', { name: '保存设备' }).click()
  await window.locator('.toast').waitFor({ state: 'hidden', timeout: 6_000 })

  const profileId = await window.evaluate(async () => (await window.djiApi.profiles.list())[0]?.id)
  if (!profileId) throw new Error('Unable to resolve smoke profile')

  await window.evaluate(async () => {
    const now = Date.now()
    const base = {
      provider: 'ali',
      region: 'cn-hangzhou',
      endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
      accessKeyId: 'smoke-access-key',
      accessKeySecret: 'smoke-secret',
      securityToken: 'smoke-token',
      expire: now + 60 * 60 * 1000,
      createdAt: now,
      updatedAt: now,
    }
    await window.djiApi.objectStorage.save({ ...base, id: 'smoke-primary', name: '主日志存储', bucket: 'primary-logs' })
    await window.djiApi.objectStorage.save({ ...base, id: 'smoke-archive', name: '归档日志存储', bucket: 'archive-logs' })
  })
  await window.reload()
  await window.locator('.app-shell').waitFor({ state: 'visible', timeout: 15_000 })

  const messages = [
    {
      id: 'remote-log-list',
      topic: 'thing/product/DOCK-LOG-SMOKE-001/services_reply',
      payload: {
        tid: 'remote-log-list',
        method: 'fileupload_list',
        data: {
          result: 0,
          files: [
            {
              module: '3',
              device_sn: 'DOCK-LOG-SMOKE-001',
              result: 0,
              list: [{ boot_index: 101, start_time: 1_725_000_000_000, end_time: 1_725_000_300_000, size: 4_194_304 }],
            },
            {
              module: '0',
              device_sn: 'AIR-LOG-SMOKE-001',
              result: 0,
              list: [{ boot_index: 202, start_time: 1_725_000_100_000, end_time: 1_725_000_400_000, size: 2_097_152 }],
            },
          ],
        },
      },
    },
    {
      id: 'remote-log-progress',
      topic: 'thing/product/DOCK-LOG-SMOKE-001/events',
      payload: {
        tid: 'remote-log-progress',
        method: 'fileupload_progress',
        data: {
          output: {
            ext: {
              files: [{
                module: '3',
                device_sn: 'DOCK-LOG-SMOKE-001',
                key: 'dji-logs/DOCK-LOG-SMOKE-001/dock.log',
                fingerprint: 'smoke-fingerprint',
                size: 4_194_304,
                progress: { progress: 64, upload_rate: 262_144, current_step: 12, total_step: 20, result: 0, status: 'uploading' },
              }],
            },
          },
        },
      },
    },
  ]

  for (const message of messages) {
    const payload = JSON.stringify(message.payload)
    await electronApp.evaluate(({ BrowserWindow }, event) => {
      for (const instance of BrowserWindow.getAllWindows()) instance.webContents.send('runtime:event', event)
    }, {
      type: 'message',
      profileId,
      message: {
        id: message.id,
        profileId,
        direction: 'in',
        topic: message.topic,
        payload,
        qos: 1,
        retain: false,
        timestamp: Date.now(),
        size: Buffer.byteLength(payload),
      },
    })
  }

  await window.getByRole('button', { name: 'OSS 管理' }).click()
  await window.locator('.oss-manager').waitFor({ state: 'visible' })
  if (!(await window.getByText('Access Key ID', { exact: true }).isVisible())) errors.push('OSS credentials are missing from OSS management')
  if (await window.locator('.oss-profile-row').count() !== 2) errors.push('Expected two managed object storage profiles')
  if (!(await window.locator('.oss-profile-row').filter({ hasText: '主日志存储' }).isVisible())) errors.push('Primary storage profile is missing')
  if (!(await window.locator('.oss-profile-row').filter({ hasText: '归档日志存储' }).isVisible())) errors.push('Archive storage profile is missing')
  await window.screenshot({ path: ossScreenshotPath })

  await browserWindow.evaluate((instance) => instance.setContentSize(1480, 920))
  await window.waitForFunction(() => window.innerWidth === 1480 && window.innerHeight === 920)
  await window.getByRole('button', { name: '设备工作台' }).click()
  await window.getByRole('button', { name: '控制中心', exact: true }).click()
  await window.locator('.control-center-tabs').getByRole('tab', { name: '远程日志', exact: true }).click()
  await window.locator('.remote-log-center').waitFor({ state: 'visible' })
  if (await window.getByText('目标机场', { exact: true }).count()) errors.push('Redundant target dock selector is still visible')
  if (await window.locator('.remote-log-file-row').count() !== 2) errors.push('Expected two log file rows')
  if (await window.locator('.remote-log-progress-row').count() !== 1) errors.push('Expected one progress row')

  await window.locator('.remote-log-file-row:has(.module-3)').click()
  if (!(await window.getByText('机场对象 Key', { exact: true }).isVisible())) errors.push('Dock object key field is missing')
  if (await window.getByText('Access Key ID', { exact: true }).count()) errors.push('OSS credentials should not be editable in remote logs')
  const storageSelect = window.locator('.remote-log-storage-select select')
  if (await storageSelect.locator('option').count() !== 2) errors.push('Remote logs did not expose both storage profiles')
  await storageSelect.selectOption('smoke-archive')
  if (await storageSelect.inputValue() !== 'smoke-archive') errors.push('Unable to switch the upload target storage')

  await electronApp.evaluate(({ BrowserWindow, ipcMain }, smokeProfileId) => {
    globalThis.__remoteLogSmokeRequests = []
    ipcMain.removeHandler('remote-log:start-upload')
    ipcMain.handle('remote-log:start-upload', (_event, request) => {
      globalThis.__remoteLogSmokeRequests.push(request)
      return { ok: true }
    })
    for (const instance of BrowserWindow.getAllWindows()) {
      instance.webContents.send('runtime:event', {
        type: 'status',
        profileId: smokeProfileId,
        status: 'connected',
        at: Date.now(),
      })
    }
  }, profileId)
  await window.getByRole('button', { name: '发起上传', exact: true }).click()
  await window.getByText('已发起 1 个日志文件上传', { exact: true }).waitFor({ state: 'visible' })
  const remoteLogRequests = await electronApp.evaluate(() => globalThis.__remoteLogSmokeRequests)
  if (remoteLogRequests.length !== 1) {
    errors.push(`Expected one remote log upload request (${JSON.stringify(remoteLogRequests)})`)
  } else {
    const [request] = remoteLogRequests
    if (
      request.profileId !== profileId
      || request.gatewaySn !== 'DOCK-LOG-SMOKE-001'
      || request.objectStorageProfileId !== 'smoke-archive'
      || request.files?.length !== 1
      || request.files[0]?.module !== '3'
      || request.files[0]?.bootIndex !== 101
      || !request.objectKeys?.['3']
    ) {
      errors.push(`Remote log upload request shape is invalid (${JSON.stringify(request)})`)
    }
    const serializedRequest = JSON.stringify(request)
    for (const secret of ['smoke-access-key', 'smoke-secret', 'smoke-token']) {
      if (serializedRequest.includes(secret)) errors.push(`Remote log renderer request exposed ${secret}`)
    }
  }

  const layout = await window.evaluate(() => {
    const selectors = ['.remote-log-center', '.remote-log-toolbar', '.remote-log-layout', '.remote-log-files', '.remote-log-upload', '.remote-log-progress-panel']
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      elements: selectors.map((selector) => {
        const element = document.querySelector(selector)
        if (!(element instanceof HTMLElement)) return { selector, missing: true }
        const rect = element.getBoundingClientRect()
        return {
          selector,
          missing: false,
          clientWidth: element.clientWidth,
          clientHeight: element.clientHeight,
          scrollWidth: element.scrollWidth,
          scrollHeight: element.scrollHeight,
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
        }
      }),
    }
  })

  for (const item of layout.elements) {
    if (item.missing) errors.push(`Missing ${item.selector}`)
    else if (
      item.left < -1
      || item.right > layout.viewport.width + 1
      || item.top < -1
      || item.bottom > layout.viewport.height + 1
    ) errors.push(`${item.selector} is outside the viewport`)
  }

  await window.screenshot({ path: screenshotPath })
  await browserWindow.evaluate((instance) => instance.setContentSize(1200, 680))
  await window.waitForFunction(() => window.innerWidth === 1200 && window.innerHeight === 680)
  const compactLayout = await window.evaluate(async () => {
    const scroller = document.querySelector('.device-tab-content.commands-tab')
    const center = document.querySelector('.remote-log-center')
    const progress = document.querySelector('.remote-log-progress-panel')
    if (!(scroller instanceof HTMLElement) || !(center instanceof HTMLElement) || !(progress instanceof HTMLElement)) {
      return { missing: true }
    }
    scroller.scrollTop = scroller.scrollHeight
    await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame))
    const progressRect = progress.getBoundingClientRect()
    return {
      missing: false,
      viewportHeight: window.innerHeight,
      centerClientWidth: center.clientWidth,
      centerScrollWidth: center.scrollWidth,
      scrollerClientHeight: scroller.clientHeight,
      scrollerScrollHeight: scroller.scrollHeight,
      scrollerScrollTop: scroller.scrollTop,
      progressTop: Math.round(progressRect.top),
      progressBottom: Math.round(progressRect.bottom),
    }
  })
  if (compactLayout.missing) errors.push('Compact remote log layout is missing required elements')
  else {
    if (compactLayout.centerScrollWidth > compactLayout.centerClientWidth + 1) {
      errors.push('Compact remote log layout clips horizontal content')
    }
    if (compactLayout.scrollerScrollHeight > compactLayout.scrollerClientHeight && compactLayout.scrollerScrollTop <= 0) {
      errors.push('Compact remote log layout cannot scroll to its bottom content')
    }
    if (compactLayout.progressTop < -1 || compactLayout.progressBottom > compactLayout.viewportHeight + 1) {
      errors.push('Compact remote log progress panel cannot be brought into view')
    }
  }

  process.stdout.write(`${JSON.stringify({ screenshotPath, ossScreenshotPath, layout, compactLayout, errors }, null, 2)}\n`)
  if (errors.length) process.exitCode = 1
} finally {
  await electronApp.close()
}
