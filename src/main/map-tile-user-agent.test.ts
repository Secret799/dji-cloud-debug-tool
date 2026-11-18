import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getVersion: () => '9.9.9' },
}))

import { mapTileUserAgent } from './map-tile-user-agent'

describe('mapTileUserAgent', () => {
  it('identifies the app and version to public tile servers', () => {
    // 只写应用名与版本，不带浏览器 UA 片段：OSM 会按 UA 判断请求方是否遵守使用政策
    expect(mapTileUserAgent()).toBe('HangarLabStudio/9.9.9 (map tile debugging)')
  })
})