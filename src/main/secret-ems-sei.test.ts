import { describe, expect, it } from 'vitest'
import { BoundedSseParser, parseSecretEmsSeiEvent } from './secret-ems-sei'

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)

describe('SecretEMS SEI SSE', () => {
  it('parses fragmented CRLF events and joins multiple data fields', () => {
    const parser = new BoundedSseParser()
    expect(parser.push(bytes('id: 7\r\nevent: sei\r\nda'))).toEqual([])
    expect(parser.push(bytes('ta: {"payloadType":5,\r\ndata: "payloadBytes":16,"codec":"H265"}\r\n\r\n'))).toEqual([
      {
        id: '7',
        event: 'sei',
        data: '{"payloadType":5,\n"payloadBytes":16,"codec":"H265"}',
      },
    ])
  })

  it('maps diagnostic snapshots, messages, issues and device events', () => {
    const snapshot = parseSecretEmsSeiEvent({
      event: 'snapshot',
      data: JSON.stringify({
        stats: {
          active: true,
          codec: 'H264',
          videoFrames: 42,
          seiNalUnits: 3,
          seiMessages: 4,
          parseIssues: 1,
        },
        recentEvents: [{
          id: 9,
          kind: 'sei',
          time: '2026-08-28T10:00:00Z',
          codec: 'H264',
          payloadType: 5,
          payloadBytes: 21,
          uuid: '00112233-4455-6677-8899-aabbccddeeff',
          hex: '00 11',
          text: 'hello',
          payloadBase64: 'ABEiM0RVZneImaq7zN3u/2hlbGxv',
        }],
      }),
    })
    expect(snapshot).toMatchObject({
      active: true,
      codec: 'h264',
      videoFrames: 42,
      seiNalUnits: 3,
      seiMessages: 4,
      parseIssues: 1,
      recentMessages: [{ payloadType: 5, payloadSize: 21, textPreview: 'hello' }],
      recentPayloads: [{ id: '9', payload: Buffer.from('00112233445566778899aabbccddeeff68656c6c6f', 'hex') }],
    })

    expect(parseSecretEmsSeiEvent({
      event: 'sei',
      id: '10',
      data: JSON.stringify({
        parsedAt: '2026-08-28T10:00:01Z',
        codec: 'HEVC',
        payloadType: 137,
        payloadBytes: 2,
        data: 'device payload',
        payloadBase64: 'wyg=',
      }),
    })).toMatchObject({
      active: true,
      codec: 'h265',
      message: {
        id: '10',
        payloadType: 137,
        payloadSize: 2,
        textPreview: 'device payload',
        hexPreview: 'c3 28',
      },
      messagePayload: Buffer.from([0xc3, 0x28]),
    })
    expect(parseSecretEmsSeiEvent({ event: 'issue', data: '{}' })).toEqual({ active: true, issue: true })
  })

  it('rejects an unterminated event that exceeds the bounded buffer', () => {
    const parser = new BoundedSseParser()
    expect(() => parser.push(bytes(`data:${'x'.repeat(1024 * 1024)}`))).toThrow('缓冲区超过大小限制')
  })
})
