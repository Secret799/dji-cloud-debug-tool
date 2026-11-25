import { expect, it } from 'vitest'
import {
  buildMacInstallScript,
  buildWindowsInstallCommand,
  currentMacAppPath,
} from './app-update-installer'

it('builds a detached hidden Windows NSIS install command', () => {
  const command = buildWindowsInstallCommand('C:\\Users\\tester\\Downloads\\HangarLab Studio setup.exe')

  expect(command).toEqual({
    file: 'C:\\Users\\tester\\Downloads\\HangarLab Studio setup.exe',
    args: ['/S', '/force-run'],
    options: { detached: true, windowsHide: true, stdio: 'ignore' },
  })
})

it('builds a macOS helper script with safely quoted paths and replacement steps', () => {
  const script = buildMacInstallScript(
    "/tmp/HangarLab's Studio.dmg",
    "/Applications/HangarLab Studio.app",
    '1234',
  )

  expect(script).toContain("'/tmp/HangarLab'\\''s Studio.dmg'")
  expect(script).toContain("'/Applications/HangarLab Studio.app'")
  expect(script).toContain('kill -0 1234')
  expect(script).toContain('hdiutil attach')
  expect(script).toContain('trap')
  expect(script).not.toContain('maxdepth')
  expect(script).toContain('ditto')
  expect(script).toContain('hdiutil detach')
  expect(script).toContain('open')
})

it('resolves the installed macOS app bundle from app.asar path', () => {
  expect(currentMacAppPath('/Applications/HangarLab Studio.app/Contents/Resources/app.asar'))
    .toBe('/Applications/HangarLab Studio.app')
})

it('rejects an app path that is not inside a macOS app bundle', () => {
  expect(() => currentMacAppPath('/Users/tester/project/out/main'))
    .toThrow('无法确定当前 macOS 应用目录')
})
