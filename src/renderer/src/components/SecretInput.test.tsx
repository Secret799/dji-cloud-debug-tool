import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SecretInput } from './SecretInput'

describe('SecretInput', () => {
  it('masks decrypted values by default and exposes an accessible reveal control', () => {
    const markup = renderToStaticMarkup(
      <SecretInput label="密码" value="decrypted-secret" onChange={() => undefined} />,
    )

    expect(markup).toContain('type="password"')
    expect(markup).toContain('value="decrypted-secret"')
    expect(markup).toContain('aria-label="显示密码"')
    expect(markup).toContain('aria-pressed="false"')
    expect(markup).toContain('spellcheck="false"')
    expect(markup).toContain('autoCapitalize="none"')
  })
})
