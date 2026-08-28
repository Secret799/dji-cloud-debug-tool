import { describe, expect, it } from 'vitest'
import { compareAppVersions, parseChecksums, plainTextReleaseNotes, selectReleaseAsset } from './app-update-utils'

describe('app update helpers', () => {
  it('compares stable and prerelease semantic versions', () => {
    expect(compareAppVersions('1.2.0', '1.1.9')).toBeGreaterThan(0)
    expect(compareAppVersions('v1.2.0-beta.2', '1.2.0-beta.10')).toBeLessThan(0)
    expect(compareAppVersions('1.2.0', '1.2.0-rc.1')).toBeGreaterThan(0)
    expect(compareAppVersions('1.2.0+build.5', '1.2.0')).toBe(0)
  })

  it('selects the installer for the current platform and architecture', () => {
    const assets = [
      { name: 'DJI Cloud Studio-1.2.0-mac-arm64.dmg', browser_download_url: 'mac', size: 10 },
      { name: 'DJI Cloud Studio-1.2.0-windows-x64-setup.exe', browser_download_url: 'win', size: 20 },
    ]
    expect(selectReleaseAsset(assets, 'darwin', 'arm64')?.browser_download_url).toBe('mac')
    expect(selectReleaseAsset(assets, 'win32', 'x64')?.browser_download_url).toBe('win')
    expect(selectReleaseAsset(assets, 'linux', 'x64')).toBeUndefined()
  })

  it('parses GNU checksum output with spaces in filenames', () => {
    const hash = 'a'.repeat(64)
    expect(parseChecksums(`${hash}  DJI Cloud Studio-1.2.0-mac-arm64.dmg\n`).get(
      'DJI Cloud Studio-1.2.0-mac-arm64.dmg',
    )).toBe(hash)
  })

  it('turns basic markdown release notes into readable text', () => {
    expect(plainTextReleaseNotes('**Full Changelog**: [compare](https://example.com)')).toBe(
      'Full Changelog: compare: https://example.com',
    )
    expect(plainTextReleaseNotes(null)).toBeUndefined()
  })
})
