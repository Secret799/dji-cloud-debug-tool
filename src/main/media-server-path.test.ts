import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  mediaServerExecutableName,
  mediaServerVendorDirectory,
  resolveMediaServerBinaryPath,
} from './media-server-path'

describe('media server platform paths', () => {
  it('keeps the existing macOS vendor layout', () => {
    expect(mediaServerExecutableName('darwin')).toBe('MediaServer')
    expect(mediaServerVendorDirectory('darwin', 'arm64')).toBe('arm64')
    expect(resolveMediaServerBinaryPath({
      appPath: '/project',
      arch: 'x64',
      isPackaged: false,
      platform: 'darwin',
      resourcesPath: '/resources',
    })).toBe(join('/project', 'vendor', 'zlmediakit', 'x64', 'MediaServer'))
  })

  it('selects the architecture-specific Windows executable in development', () => {
    expect(mediaServerExecutableName('win32')).toBe('MediaServer.exe')
    expect(mediaServerVendorDirectory('win32', 'x64')).toBe('win32-x64')
    expect(mediaServerVendorDirectory('win32', 'arm64')).toBe('win32-arm64')
    expect(resolveMediaServerBinaryPath({
      appPath: '/project',
      arch: 'arm64',
      isPackaged: false,
      platform: 'win32',
      resourcesPath: '/resources',
    })).toBe(join('/project', 'vendor', 'zlmediakit', 'win32-arm64', 'MediaServer.exe'))
  })

  it('uses the single platform binary copied into packaged resources', () => {
    expect(resolveMediaServerBinaryPath({
      appPath: '/project',
      arch: 'x64',
      isPackaged: true,
      platform: 'win32',
      resourcesPath: '/resources',
    })).toBe(join('/resources', 'zlmediakit', 'MediaServer.exe'))
  })
})
