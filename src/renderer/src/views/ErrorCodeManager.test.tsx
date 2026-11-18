import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ErrorCodeManager } from './ErrorCodeManager'

describe('ErrorCodeManager', () => {
  it('prefills the error code search and selects the matching record', () => {
    const markup = renderToStaticMarkup(<ErrorCodeManager initialCode="316031" />)

    expect(markup).toContain('value="316031"')
    expect(markup).toContain('设置返航模式失败')
  })

  it('keeps the provider switch on the standalone error-code page', () => {
    const markup = renderToStaticMarkup(<ErrorCodeManager />)

    expect(markup).toContain('aria-label="设备品牌"')
    expect(markup).toContain('>大疆</button>')
    expect(markup).toContain('>草莓</button>')
  })
})
