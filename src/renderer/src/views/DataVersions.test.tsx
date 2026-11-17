import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DataVersions } from './DataVersions'

describe('DataVersions status view', () => {
  it('keeps the credential rotation warning visible before any version is listed', () => {
    const markup = renderToStaticMarkup(<DataVersions onNotify={vi.fn()} />)

    expect(markup).toContain('尚未配置云同步')
    expect(markup).toContain('添加 WebDAV 端点后开始加密同步')
    expect(markup).toContain('旧凭据创建的历史版本将无法解密')
    expect(markup).toContain('个云端数据版本 · AES-256-GCM')
    expect(markup).toContain('配置 WebDAV')
  })
})