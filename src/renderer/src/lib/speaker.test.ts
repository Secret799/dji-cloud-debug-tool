import { describe, expect, it } from 'vitest'
import {
  SPEAKER_TEXT_MAX_LENGTH,
  SPEAKER_SERVICE_METHODS,
  buildSpeakerAudioData,
  buildSpeakerStopData,
  buildSpeakerTtsData,
  buildSpeakerVolumeData,
} from './speaker'

describe('speaker PSDK commands', () => {
  it('builds TTS data for the selected PSDK index', () => {
    expect(buildSpeakerTtsData(2, '  hello  ', 1_700_000_000_000)).toEqual({
      psdk_index: 2,
      tts: {
        name: 'tts-2-1700000000000',
        text: 'hello',
        md5: '5d41402abc4b2a76b9719d911017c592',
      },
    })
    expect(SPEAKER_SERVICE_METHODS).toEqual({
      tts: 'speaker_tts_play_start',
      audio: 'speaker_audio_play_start',
      volume: 'speaker_play_volume_set',
      stop: 'speaker_play_stop',
    })
  })

  it('validates TTS content and volume limits', () => {
    expect(() => buildSpeakerTtsData(1, '   ')).toThrow('请输入喊话内容')
    expect(() => buildSpeakerTtsData(1, 'x'.repeat(SPEAKER_TEXT_MAX_LENGTH + 1))).toThrow('1024')
    expect(buildSpeakerVolumeData(1, 70)).toEqual({ psdk_index: 1, play_volume: 70 })
    expect(() => buildSpeakerVolumeData(1, 101)).toThrow('0 至 100')
    expect(buildSpeakerStopData(3)).toEqual({ psdk_index: 3 })
  })

  it('builds audio playback data from an uploaded artifact', () => {
    expect(buildSpeakerAudioData(3, {
      name: 'notice.mp3',
      url: 'https://storage.example.com/speaker/notice.mp3?signature=abc',
      md5: '5D41402ABC4B2A76B9719D911017C592',
    })).toEqual({
      psdk_index: 3,
      audio: {
        name: 'notice.mp3',
        url: 'https://storage.example.com/speaker/notice.mp3?signature=abc',
        md5: '5d41402abc4b2a76b9719d911017c592',
      },
    })
    expect(() => buildSpeakerAudioData(3, { name: 'x.mp3', url: 'file:///tmp/x.mp3', md5: 'x' })).toThrow()
  })
})
