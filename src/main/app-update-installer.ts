import { dirname, posix } from 'node:path'

export interface WindowsInstallCommand {
  file: string
  args: string[]
  options: {
    detached: true
    windowsHide: true
    stdio: 'ignore'
  }
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

export const buildWindowsInstallCommand = (installerPath: string): WindowsInstallCommand => ({
  file: installerPath,
  args: ['/S', '/force-run'],
  options: { detached: true, windowsHide: true, stdio: 'ignore' },
})

export const currentMacAppPath = (appPath: string): string => {
  const normalizedPath = posix.normalize(appPath)
  const marker = '.app/'
  const markerIndex = normalizedPath.indexOf(marker)
  if (markerIndex < 0 || !normalizedPath.endsWith('/Contents/Resources/app.asar')) {
    throw new Error('无法确定当前 macOS 应用目录')
  }
  return `${normalizedPath.slice(0, markerIndex)}.app`
}

export const buildMacInstallScript = (installerPath: string, appPath: string, processId = '$$'): string => {
  const temporaryMount = `"${posix.join('/tmp', `hangarlab-update-${processId}`)}"`
  const installer = shellQuote(installerPath)
  const target = shellQuote(appPath)
  const targetDirectory = shellQuote(dirname(appPath))

  return [
    '#!/bin/sh',
    'set -eu',
    `while kill -0 ${processId} 2>/dev/null; do sleep 1; done`,
    `mount_point=${temporaryMount}`,
    'mounted=0',
    'cleanup() { if [ "$mounted" = "1" ]; then hdiutil detach "$mount_point" -force >/dev/null 2>&1 || true; fi; }',
    'trap cleanup EXIT',
    'mkdir -p "$mount_point"',
    `hdiutil attach ${installer} -nobrowse -readonly -mountpoint "$mount_point"`,
    'mounted=1',
    'source_app=$(find "$mount_point" -type d -name "*.app" -print | sed -n "1p")',
    '[ -n "$source_app" ]',
    `ditto "$source_app" ${target}`,
    `open ${target}`,
    `rmdir "$mount_point" 2>/dev/null || true`,
    `cd ${targetDirectory}`,
  ].join('\n')
}

