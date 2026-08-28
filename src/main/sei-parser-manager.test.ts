import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {} }))

import { buildSeiMessageDetail, ffmpegAnnexBOutputForCodec } from './sei-parser-manager'

describe('SEI FFmpeg output selection', () => {
  it('maps internal codec names to Annex-B muxers and bitstream filters', () => {
    expect(ffmpegAnnexBOutputForCodec('h264')).toEqual({
      format: 'h264',
      bitstreamFilter: 'h264_mp4toannexb',
    })
    expect(ffmpegAnnexBOutputForCodec('h265')).toEqual({
      format: 'hevc',
      bitstreamFilter: 'hevc_mp4toannexb',
    })
  })

  it('builds complete text, HEX and Base64 representations on demand', () => {
    const uuid = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
    const payload = Buffer.concat([uuid, Buffer.from('{"flightId":"A-01"}\n{"height":42}', 'utf8')])
    const detail = buildSeiMessageDetail({
      id: 'message-1',
      at: 0,
      codec: 'h265',
      payloadType: 5,
      payloadSize: payload.length,
      uuid: '00112233-4455-6677-8899-aabbccddeeff',
      hexPreview: '00 11',
    }, payload)
    expect(detail.text).toBe('{"flightId":"A-01"}\n{"height":42}')
    expect(detail.hex).toBe([...payload].map((value) => value.toString(16).padStart(2, '0')).join(' '))
    expect(detail.base64).toBe(payload.toString('base64'))
  })

  it('does not expose invalid UTF-8 payloads as text', () => {
    const payload = Buffer.from([0xc3, 0x28])
    expect(buildSeiMessageDetail({
      id: 'message-2', at: 0, codec: 'h264', payloadType: 1, payloadSize: 2, hexPreview: 'c3 28',
    }, payload).text).toBeUndefined()
  })
})
