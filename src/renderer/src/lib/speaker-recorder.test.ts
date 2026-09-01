import { describe, expect, it } from 'vitest'
import { encodePcm16Wave, formatRecordingDuration } from './speaker-recorder'

describe('speaker microphone recording', () => {
  it('encodes multi-channel samples as mono PCM16 WAV', () => {
    const wave = encodePcm16Wave([
      new Float32Array([1, -1, 0.5]),
      new Float32Array([1, -1, -0.5]),
    ], 48_000)
    const view = new DataView(wave.buffer)

    expect(new TextDecoder().decode(wave.subarray(0, 4))).toBe('RIFF')
    expect(new TextDecoder().decode(wave.subarray(8, 12))).toBe('WAVE')
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(48_000)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getUint32(40, true)).toBe(6)
    expect(view.getInt16(44, true)).toBe(32_767)
    expect(view.getInt16(46, true)).toBe(-32_768)
    expect(view.getInt16(48, true)).toBe(0)
  })

  it('formats elapsed recording time', () => {
    expect(formatRecordingDuration(0)).toBe('00:00')
    expect(formatRecordingDuration(65_900)).toBe('01:05')
  })
})
