import SparkMD5 from 'spark-md5'

export const SPEAKER_TEXT_MAX_LENGTH = 1_024
export const SPEAKER_SERVICE_METHODS = {
  tts: 'speaker_tts_play_start',
  audio: 'speaker_audio_play_start',
  volume: 'speaker_play_volume_set',
  stop: 'speaker_play_stop',
} as const

export interface SpeakerTtsData extends Record<string, unknown> {
  psdk_index: number
  tts: {
    name: string
    text: string
    md5: string
  }
}

export interface SpeakerVolumeData extends Record<string, unknown> {
  psdk_index: number
  play_volume: number
}

export interface SpeakerAudioData extends Record<string, unknown> {
  psdk_index: number
  audio: {
    name: string
    url: string
    md5: string
  }
}

const validPsdkIndex = (value: number): boolean => Number.isInteger(value) && value >= 0

export const buildSpeakerTtsData = (
  psdkIndex: number,
  text: string,
  timestamp = Date.now(),
): SpeakerTtsData => {
  if (!validPsdkIndex(psdkIndex)) throw new Error('PSDK 索引无效')
  const normalizedText = text.trim()
  if (!normalizedText) throw new Error('请输入喊话内容')
  if (normalizedText.length > SPEAKER_TEXT_MAX_LENGTH) {
    throw new Error(`喊话内容不能超过 ${SPEAKER_TEXT_MAX_LENGTH} 个字符`)
  }
  return {
    psdk_index: psdkIndex,
    tts: {
      name: `tts-${psdkIndex}-${timestamp}`,
      text: normalizedText,
      md5: SparkMD5.hash(normalizedText),
    },
  }
}

export const buildSpeakerVolumeData = (psdkIndex: number, volume: number): SpeakerVolumeData => {
  if (!validPsdkIndex(psdkIndex)) throw new Error('PSDK 索引无效')
  if (!Number.isInteger(volume) || volume < 0 || volume > 100) throw new Error('音量必须是 0 至 100 的整数')
  return { psdk_index: psdkIndex, play_volume: volume }
}

export const buildSpeakerAudioData = (
  psdkIndex: number,
  audio: { name: string; url: string; md5: string },
): SpeakerAudioData => {
  if (!validPsdkIndex(psdkIndex)) throw new Error('PSDK 索引无效')
  const name = audio.name.trim()
  if (!name || new TextEncoder().encode(name).byteLength > 256) throw new Error('音频文件名无效')
  const md5 = audio.md5.trim().toLowerCase()
  if (!/^[a-f0-9]{32}$/.test(md5)) throw new Error('音频 MD5 无效')
  let url: URL
  try {
    url = new URL(audio.url)
  } catch {
    throw new Error('音频 URL 无效')
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error('音频 URL 必须是不含认证信息的 HTTP 或 HTTPS 地址')
  }
  return { psdk_index: psdkIndex, audio: { name, url: url.toString(), md5 } }
}

export const buildSpeakerStopData = (psdkIndex: number): { psdk_index: number } => {
  if (!validPsdkIndex(psdkIndex)) throw new Error('PSDK 索引无效')
  return { psdk_index: psdkIndex }
}
