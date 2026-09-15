import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const bundle = process.argv[2]
if (!bundle?.endsWith('.app')) throw new Error('Usage: node scripts/macos-package-smoke.mjs <path-to-app>')
const userData = await mkdtemp(join(tmpdir(), 'dji-packaged-startup-'))
let application
try {
  application = await electron.launch({
    executablePath: join(resolve(bundle), 'Contents/MacOS/DJI Cloud Studio'),
    args: [`--user-data-dir=${userData}`],
    timeout: 30_000,
  })
  const window = await application.firstWindow({ timeout: 15_000 })
  await window.locator('.app-shell').waitFor({ state: 'visible', timeout: 15_000 })
  const version = await application.evaluate(({ app }) => app.getVersion())
  console.log(`Packaged DJI Cloud Studio ${version}: main process and renderer started successfully.`)
} finally {
  try {
    await application?.close()
  } finally {
    await rm(userData, { recursive: true, force: true })
  }
}
