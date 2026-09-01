import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SpeakerControl } from './SpeakerControl'

describe('SpeakerControl', () => {
  it('renders the speaker PSDK channel for the selected index', () => {
    const markup = renderToStaticMarkup(
      <SpeakerControl
        gatewaySn="DOCK-1"
        psdkIndex={2}
        status="connected"
        busy={false}
        onService={async () => ({ ok: true, tid: 'tid-1' })}
      />,
    )

    expect(markup).toContain('aria-label="PSDK 2 喊话器控制"')
    expect(markup).toContain('thing/product/DOCK-1/services · PSDK 2')
    expect(markup).toContain('TTS 喊话')
    expect(markup).toContain('文字方式')
    expect(markup).toContain('语音方式')
    expect(markup).toContain('设置音量')
    expect(markup).toContain('停止播放')
    expect(markup).toContain('通道就绪')
  })
})
