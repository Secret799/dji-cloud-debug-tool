import { describe, expect, it, vi } from 'vitest'
import { AnnexBSeiStreamParser, parseAnnexBSei } from './sei-parser'

const bytes = (...values: number[]): Buffer => Buffer.from(values)
const annexB4 = (nal: Uint8Array): Buffer => Buffer.concat([bytes(0, 0, 0, 1), nal])
const annexB3 = (nal: Uint8Array): Buffer => Buffer.concat([bytes(0, 0, 1), nal])
const escapeRbsp = (rbsp: Uint8Array): Buffer => {
  const escaped: number[] = []
  let zeroCount = 0
  for (const value of rbsp) {
    if (zeroCount >= 2 && value <= 3) {
      escaped.push(3)
      zeroCount = 0
    }
    escaped.push(value)
    zeroCount = value === 0 ? zeroCount + 1 : 0
  }
  return Buffer.from(escaped)
}
const seiRbsp = (payloadType: number, payload: Uint8Array): Buffer =>
  escapeRbsp(Buffer.concat([bytes(payloadType, payload.length), payload, bytes(0x80)]))

describe('H.26x SEI parser', () => {
  it('parses H.264 user_data_unregistered and formats its UUID', () => {
    const payload = Buffer.concat([bytes(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15), Buffer.from('dji-test')])
    const result = parseAnnexBSei(annexB4(Buffer.concat([bytes(0x06), seiRbsp(5, payload)])))

    expect(result.codec).toBe('h264')
    expect(result.seiNalUnitCount).toBe(1)
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].uuid).toBe('00010203-0405-0607-0809-0a0b0c0d0e0f')
    expect(result.issues).toEqual([])
  })

  it('parses H.265 prefix and suffix SEI NAL units', () => {
    const frame = Buffer.concat([
      annexB3(Buffer.concat([bytes(39 << 1, 1), seiRbsp(4, bytes(1, 2, 3))])),
      annexB3(Buffer.concat([bytes(40 << 1, 1), seiRbsp(5, Buffer.alloc(16))])),
    ])
    const result = parseAnnexBSei(frame)

    expect(result.codec).toBe('h265')
    expect(result.seiNalUnitCount).toBe(2)
    expect(result.messages.map((message) => message.payloadType)).toEqual([4, 5])
  })

  it('removes emulation-prevention bytes and reports bounded malformed payloads', () => {
    const valid = parseAnnexBSei(annexB4(bytes(0x06, 5, 4, 0, 0, 3, 1, 2, 0x80)))
    const truncated = parseAnnexBSei(annexB4(bytes(0x06, 5, 10, 1, 2, 0x80)))
    const oversized = parseAnnexBSei(
      annexB4(bytes(0x06, 5, 4, 1, 2, 3, 4, 0x80)),
      { maxFrameBytes: 1024, maxPayloadBytes: 3, maxSeiMessages: 4, maxIssues: 4 },
    )

    expect([...valid.messages[0].payload]).toEqual([0, 0, 1, 2])
    expect(truncated.issues[0]?.code).toBe('TRUNCATED_PAYLOAD')
    expect(oversized.issues[0]?.code).toBe('PAYLOAD_TOO_LARGE')
  })

  it('reassembles start codes split across stream chunks', () => {
    const listener = vi.fn()
    const parser = new AnnexBSeiStreamParser(listener)
    const first = annexB4(Buffer.concat([bytes(0x06), seiRbsp(5, Buffer.alloc(16))]))
    const next = annexB4(bytes(0x65, 1, 2, 3))

    parser.push(first.subarray(0, 2))
    parser.push(Buffer.concat([first.subarray(2), next.subarray(0, 1)]))
    parser.push(next.subarray(1))

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0].messages).toHaveLength(1)
  })

  it('uses the detected codec to avoid H.265 NAL headers that resemble H.264 SEI', () => {
    const h265IdrWithLowFiveBitsSix = annexB4(bytes(0x26, 0x01, 5, 1, 1, 0x80))
    expect(parseAnnexBSei(h265IdrWithLowFiveBitsSix).seiNalUnitCount).toBe(1)
    expect(parseAnnexBSei(h265IdrWithLowFiveBitsSix, undefined, 'h265').seiNalUnitCount).toBe(0)
  })
})
