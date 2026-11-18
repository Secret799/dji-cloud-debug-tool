import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import packageMetadata from '../../../../package.json'
import { SettingsCenter } from './SettingsCenter'

describe('SettingsCenter general section', () => {
  it('summarizes local data and software update next to the sidebar control', () => {
    const markup = renderToStaticMarkup(
      <SettingsCenter
        sidebarWidth={240}
        defaultSidebarWidth={240}
        minSidebarWidth={210}
        maxSidebarWidth={420}
        onSidebarWidthChange={vi.fn()}
      />,
    )

    expect(markup).toContain('设备侧栏')
    expect(markup).toContain('本地数据')
    expect(markup).toContain('自动保存')
    expect(markup).toContain('云同步')
    expect(markup).toContain('软件更新')
    expect(markup).toContain(`HangarLab Studio v${packageMetadata.version}`)
    expect(markup).toContain('查看更新')
  })
})