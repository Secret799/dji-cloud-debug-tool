import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createDefaultTelemetryLayout } from '../lib/telemetry-layout'
import { DjiConfigCenter } from './DjiConfigCenter'

describe('monitoring item configuration', () => {
  it('shows the brand switch and defaults to DJI dock monitoring items', () => {
    const markup = renderToStaticMarkup(
      <DjiConfigCenter
        config={createDefaultTelemetryLayout()}
        onChange={() => undefined}
        onNotify={() => undefined}
      />,
    )

    expect(markup).toContain('aria-label="设备品牌"')
    expect(markup).toContain('class="active">大疆</button>')
    expect(markup).toContain('>草莓</button>')
    expect(markup).toContain('class="active">机场</button>')
    expect(markup).toContain('监测项管理')
  })
})
