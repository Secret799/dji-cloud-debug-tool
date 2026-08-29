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

  it('renders the official SuperDock task, HMS and wayline error libraries', () => {
    const markup = renderToStaticMarkup(<ErrorCodeManager provider="superdock" />)

    expect(markup).toContain('任务错误码')
    expect(markup).toContain('机场 HMS')
    expect(markup).toContain('航线中断')
    expect(markup).toContain('>927<')
    expect(markup).toContain('>258<')
    expect(markup).toContain('>249<')
    expect(markup).toContain('<code>321528</code>')
    expect(markup).toContain('触碰自定义飞行区边界，航线任务已暂停')
    expect(markup).toContain('草莓创新 SuperDock 官方开发者文档')
  })
})
