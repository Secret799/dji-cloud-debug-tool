import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ffmpegExecutableName,
  ffmpegVendorDirectory,
  resolveBundledFfmpegPath,
} from './ffmpeg-path'

describe('FFmpeg platform paths', () => {
  it('selects the architecture-specific macOS binary in development', () => {
    expect(ffmpegExecutableName('darwin')).toBe('ffmpeg')
    expect(ffmpegVendorDirectory('darwin', 'arm64')).toBe('darwin-arm64')
    expect(resolveBundledFfmpegPath({
      appPath: '/project',
      arch: 'x64',
      isPackaged: false,
      platform: 'darwin',
      resourcesPath: '/resources',
    })).toBe(join('/project', 'vendor', 'ffmpeg', 'darwin-x64', 'ffmpeg'))
  })

  it('uses ffmpeg.exe for Windows development builds', () => {
    expect(ffmpegExecutableName('win32')).toBe('ffmpeg.exe')
    expect(ffmpegVendorDirectory('win32', 'arm64')).toBe('win32-arm64')
    expect(resolveBundledFfmpegPath({
      appPath: 'C:\\project',
      arch: 'arm64',
      isPackaged: false,
      platform: 'win32',
      resourcesPath: 'C:\\resources',
    })).toBe(join('C:\\project', 'vendor', 'ffmpeg', 'win32-arm64', 'ffmpeg.exe'))
  })

  it('uses the binary copied into packaged resources', () => {
    expect(resolveBundledFfmpegPath({
      appPath: '/project',
      arch: 'x64',
      isPackaged: true,
      platform: 'win32',
      resourcesPath: '/resources',
    })).toBe(join('/resources', 'ffmpeg', 'ffmpeg.exe'))
  })
})
