export const SPEAKER_RECORDING_MAX_MS = 60_000

export interface RecordedSpeakerAudio {
  data: Uint8Array
  durationMs: number
}

export interface SpeakerMicrophoneRecorder {
  stop: () => Promise<RecordedSpeakerAudio>
  cancel: () => void
}

const writeAscii = (view: DataView, offset: number, value: string): void => {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
}

export const encodePcm16Wave = (channels: Float32Array[], sampleRate: number): Uint8Array => {
  if (!channels.length || !channels[0]?.length) throw new Error('录音中没有可用的音频')
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error('录音采样率无效')
  const frameCount = Math.min(...channels.map((channel) => channel.length))
  const dataSize = frameCount * 2
  const output = new Uint8Array(44 + dataSize)
  const view = new DataView(output.buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, Math.round(sampleRate), true)
  view.setUint32(28, Math.round(sampleRate) * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  for (let frame = 0; frame < frameCount; frame += 1) {
    let sample = 0
    for (const channel of channels) sample += channel[frame] ?? 0
    sample = Math.max(-1, Math.min(1, sample / channels.length))
    view.setInt16(44 + frame * 2, sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff), true)
  }
  return output
}

const preferredMimeType = (): string | undefined => [
  'audio/webm;codecs=opus',
  'audio/webm',
].find((mimeType) => MediaRecorder.isTypeSupported(mimeType))

export const startSpeakerMicrophoneRecording = async (): Promise<SpeakerMicrophoneRecorder> => {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new Error('当前运行环境不支持麦克风录音')
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  })
  let recorder: MediaRecorder
  try {
    const mimeType = preferredMimeType()
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop())
    throw error
  }

  const startedAt = Date.now()
  const chunks: Blob[] = []
  let finished = false
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size) chunks.push(event.data)
  })
  recorder.start(250)

  const releaseMicrophone = (): void => stream.getTracks().forEach((track) => track.stop())

  return {
    stop: async () => {
      if (finished) throw new Error('录音已结束')
      finished = true
      const stopped = new Promise<void>((resolve, reject) => {
        recorder.addEventListener('stop', () => resolve(), { once: true })
        recorder.addEventListener('error', (event) => reject(event.error), { once: true })
      })
      recorder.stop()
      releaseMicrophone()
      await stopped
      const encoded = new Blob(chunks, { type: recorder.mimeType })
      if (!encoded.size) throw new Error('未录到可用的麦克风音频')
      const context = new AudioContext()
      try {
        const decoded = await context.decodeAudioData(await encoded.arrayBuffer())
        const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index))
        return {
          data: encodePcm16Wave(channels, decoded.sampleRate),
          durationMs: Math.max(0, Date.now() - startedAt),
        }
      } finally {
        await context.close()
      }
    },
    cancel: () => {
      if (finished) return
      finished = true
      if (recorder.state !== 'inactive') recorder.stop()
      releaseMicrophone()
    },
  }
}

export const formatRecordingDuration = (durationMs: number): string => {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}
