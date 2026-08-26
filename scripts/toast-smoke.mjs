import electronPath from 'electron'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const projectRoot = resolve(import.meta.dirname, '..')
const userData = await mkdtemp(join(tmpdir(), 'dji-cloud-studio-toast-'))
const screenshotPath = process.env.DJI_STUDIO_TOAST_SCREENSHOT || join(tmpdir(), 'dji-cloud-studio-toast.png')
const errors = []

const electronApp = await electron.launch({
  executablePath: electronPath,
  args: [projectRoot, `--user-data-dir=${userData}`],
  cwd: projectRoot,
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
})

try {
  const window = await electronApp.firstWindow()
  await window.locator('.app-shell').waitFor({ state: 'visible', timeout: 15_000 })

  const browserWindow = await electronApp.browserWindow(window)
  await browserWindow.evaluate((instance) => instance.setContentSize(1440, 800))
  await window.waitForFunction(() => window.innerWidth === 1440 && window.innerHeight === 800)

  await window.getByRole('button', { name: '添加设备' }).click()
  await window.locator('.device-modal input').nth(0).fill('提示测试机场')
  await window.locator('.device-modal input').nth(1).fill('DOCK-TOAST-001')
  await window.getByRole('button', { name: '保存设备' }).click()
  const toast = window.locator('.toast')
  await toast.waitFor({ state: 'visible', timeout: 5_000 })

  await window.getByRole('button', { name: '控制中心', exact: true }).click()
  await window.locator('.command-center').waitFor({ state: 'visible' })
  await window.waitForTimeout(250)
  const layout = await toast.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const style = window.getComputedStyle(element)
    return {
      text: element.textContent?.trim(),
      top: Math.round(rect.top),
      centerX: Math.round(rect.left + rect.width / 2),
      viewportCenterX: Math.round(window.innerWidth / 2),
      animationName: style.animationName,
      animationDelay: style.animationDelay,
      animationDuration: style.animationDuration,
    }
  })

  if (Math.abs(layout.top - 88) > 2 || Math.abs(layout.centerX - layout.viewportCenterX) > 2) {
    errors.push(`Toast position is incorrect: ${JSON.stringify(layout)}`)
  }
  if (
    !layout.animationName.includes('toast-exit')
    || !layout.animationDelay.split(',').some((value) => value.trim() === '3s')
    || !layout.animationDuration.split(',').some((value) => value.trim() === '0.4s')
  ) {
    errors.push(`Toast timing is incorrect: ${JSON.stringify(layout)}`)
  }
  if (await window.locator('.debug-operation-result').count()) {
    errors.push('Legacy command result bar is still rendered')
  }

  await window.screenshot({ path: screenshotPath })
  await window.waitForTimeout(2_900)
  const fadeOpacity = Number(await toast.evaluate((element) => window.getComputedStyle(element).opacity))
  if (!(fadeOpacity > 0 && fadeOpacity < 1)) {
    errors.push(`Toast is not fading after three seconds: opacity ${fadeOpacity}`)
  }
  await toast.waitFor({ state: 'hidden', timeout: 1_000 })

  await window.getByRole('button', { name: '相机与云台', exact: true }).click()
  await window.locator('.camera-console').waitFor({ state: 'visible' })
  if (await window.locator('.camera-console-result').count()) {
    errors.push('Legacy camera result bar is still rendered')
  }

  process.stdout.write(`${JSON.stringify({ screenshotPath, layout, fadeOpacity, errors }, null, 2)}\n`)
  if (errors.length) process.exitCode = 1
} finally {
  await electronApp.close()
}
