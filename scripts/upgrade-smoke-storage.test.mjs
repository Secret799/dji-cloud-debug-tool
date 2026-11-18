import { describe, expect, it } from 'vitest'
import { selectUpgradeSmokeStorageKey } from './upgrade-smoke-storage.mjs'

describe('selectUpgradeSmokeStorageKey', () => {
  it('selects the persisted telemetry layout key instead of the runtime cache key', () => {
    const validationSource = `
      const ALLOWED_RENDERER_STORAGE_KEYS = new Set([
        'dji-cloud-studio.sidebar-width',
        'telemetry-cache',
        'telemetry-layout',
      ])
    `
    const layoutSource = "const STORAGE_KEY = 'telemetry-layout'"

    expect(selectUpgradeSmokeStorageKey({ validationSource, layoutSource, sidebarKey: 'dji-cloud-studio.sidebar-width' }))
      .toBe('telemetry-layout')
  })

  it('fails when the persisted layout key is not allowed for WebDAV backup', () => {
    expect(() => selectUpgradeSmokeStorageKey({
      validationSource: "const ALLOWED_RENDERER_STORAGE_KEYS = new Set(['dji-cloud-studio.sidebar-width'])",
      layoutSource: "const STORAGE_KEY = 'telemetry-layout'",
      sidebarKey: 'dji-cloud-studio.sidebar-width',
    })).toThrow('telemetry layout')
  })
})
