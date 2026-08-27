import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ErrorCodeManager } from './ErrorCodeManager'

describe('ErrorCodeManager', () => {
  it('renders the extracted error library and treatment details', () => {
    const markup = renderToStaticMarkup(<ErrorCodeManager />)

    expect(markup).toContain('上云错误码')
    expect(markup).toContain('机场 HMS')
    expect(markup).toContain('常见问题')
    expect(markup).toContain('>551<')
    expect(markup).toContain('<code>219004</code>')
    expect(markup).toContain('飞行任务已过期，无法执行')
    expect(markup).toContain('司空2重新选择任务执行时间')
    expect(markup).toContain('DJI上云常见问题汇总.xlsx')
  })
})
