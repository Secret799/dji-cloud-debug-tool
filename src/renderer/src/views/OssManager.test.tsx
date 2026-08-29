import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { createObjectStorageProfile } from '../lib/object-storage'
import { OssManager } from './OssManager'

describe('OssManager navigation', () => {
  it('keeps configuration forms out of the main split-pane page', () => {
    const profile = {
      ...createObjectStorageProfile(),
      name: '主存储',
      bucket: 'flight-data',
    }
    const markup = renderToStaticMarkup(
      <OssManager
        profiles={[profile]}
        selectedId={profile.id}
        onSelect={vi.fn()}
        onSave={vi.fn()}
        onRemove={vi.fn()}
        onNotify={vi.fn()}
      />,
    )

    expect(markup).toContain('class="oss-center"')
    expect(markup).toContain('class="oss-server-panel"')
    expect(markup).toContain('class="oss-service-workspace"')
    expect(markup).toContain('添加 OSS 配置')
    expect(markup).toContain('主存储')
    expect(markup).toContain('<dt>Bucket</dt><dd>flight-data</dd>')
    expect(markup).not.toContain('role="dialog"')
    expect(markup).not.toContain('访问凭证')
    expect(markup).not.toContain('保存配置')
  })
})
