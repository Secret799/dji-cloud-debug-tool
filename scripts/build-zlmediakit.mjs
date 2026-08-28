import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const requestedArch = process.argv[2] ?? process.arch

const run = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (process.platform === 'darwin') {
  if (!['arm64', 'x64', 'x86_64'].includes(requestedArch)) {
    throw new Error(`Unsupported macOS architecture: ${requestedArch}`)
  }
  run('bash', ['scripts/build-zlmediakit-macos.sh', requestedArch])
} else if (process.platform === 'win32') {
  if (!['arm64', 'x64'].includes(requestedArch)) {
    throw new Error(`Unsupported Windows architecture: ${requestedArch}`)
  }
  run('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', 'scripts/build-zlmediakit-windows.ps1',
    '-Architecture', requestedArch,
  ])
} else {
  throw new Error(`Local ZLMediaKit builds are not configured for ${process.platform}`)
}
