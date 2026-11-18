import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * README 是地图功能的用户级验收口径：开箱默认、署名、令牌字段与失败回退都写在这里，
 * 代码改了而文档没跟，用户会按失效的步骤操作。这里只断言稳定的用户可见承诺，
 * 不锁整句文案，避免正常润色也被判红。
 */
const readme = readFileSync(new URL('../../../../README.md', import.meta.url), 'utf8')

describe('README 地图承诺', () => {
  it('documents the zero-key OpenStreetMap default and its attribution', () => {
    expect(readme).toContain('零 Key')
    expect(readme).toContain('OpenStreetMap')
    expect(readme).toContain('© OpenStreetMap contributors')
  })

  it('documents the provider token field names and the ellipsoid fallback', () => {
    expect(readme).toContain('Cesium ion Access Token')
    expect(readme).toContain('ArcGIS API Key')
    expect(readme).toContain('已回退椭球')
    expect(readme).toContain('检查地形配置')
  })
})