import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ErrorCodeSourceData } from './ErrorCodeSourceData'

describe('ErrorCodeSourceData', () => {
  it('renders source metadata, category counts, and raw JSON', () => {
    const markup = renderToStaticMarkup(<ErrorCodeSourceData />)

    expect(markup).toContain('源数据分类')
    expect(markup).toContain('上云错误码')
    expect(markup).toContain('机场 HMS')
    expect(markup).toContain('常见问题')
    expect(markup).toContain('>551<')
    expect(markup).toContain('DJI上云常见问题汇总.xlsx')
    expect(markup).toContain('&quot;code&quot;: &quot;219004&quot;')
    expect(markup).toContain('&quot;solution&quot;: &quot;司空2重新选择任务执行时间&quot;')
    expect(markup).toContain('下载 JSON')
    expect(markup).toContain('复制 JSON')
  })
})
