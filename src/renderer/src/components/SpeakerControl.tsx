import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  CircleAlert,
  CircleCheck,
  FileAudio,
  MessageSquareText,
  Mic,
  Play,
  RadioTower,
  Send,
  Settings,
  Square,
  Upload,
  Volume2,
  X,
} from 'lucide-react'
import type {
  ConnectionStatus,
  FirmwareUploadProgress,
  ObjectStorageProfile,
  SpeakerAudioArtifact,
  SpeakerAudioSelection,
} from '../../../shared/contracts'
import type { ServiceCaller } from '../lib/dji'
import { lookupServiceError } from '../lib/dji-error-codes'
import { objectStorageProfileIssues } from '../lib/object-storage'
import {
  SPEAKER_RECORDING_MAX_MS,
  formatRecordingDuration,
  startSpeakerMicrophoneRecording,
  type SpeakerMicrophoneRecorder,
} from '../lib/speaker-recorder'
import {
  SPEAKER_TEXT_MAX_LENGTH,
  SPEAKER_SERVICE_METHODS,
  buildSpeakerAudioData,
  buildSpeakerStopData,
  buildSpeakerTtsData,
  buildSpeakerVolumeData,
} from '../lib/speaker'

interface SpeakerControlProps {
  gatewaySn: string
  psdkIndex: number
  status: ConnectionStatus
  busy: boolean
  onService?: ServiceCaller
  onNotify?: (text: string, tone?: 'info' | 'success' | 'error') => void
  objectStorageProfiles?: ObjectStorageProfile[]
  activeObjectStorageId?: string
  onSelectObjectStorage?: (profileId: string) => void
  onOpenOssManager?: () => void
}

type SpeakerAction = 'tts' | 'audio' | 'volume' | 'stop'
type SpeakerMode = 'tts' | 'audio'
type SpeakerAudioSource = 'recording' | 'file'

interface SpeakerFeedback {
  ok: boolean
  text: string
}

const commandError = (result: Awaited<ReturnType<ServiceCaller>>, fallback: string): string => {
  if (result.result !== undefined) {
    const guidance = lookupServiceError(result.result)
    return `${fallback}（${result.result}：${guidance.message ?? '设备拒绝了指令'}）`
  }
  return result.error ?? fallback
}

const formatBytes = (value: number): string => value < 1_024
  ? `${value} B`
  : value < 1_024 * 1_024
    ? `${(value / 1_024).toFixed(1)} KiB`
    : `${(value / (1_024 * 1_024)).toFixed(1)} MiB`

const microphoneError = (error: unknown): string => {
  if (error instanceof DOMException && error.name === 'NotAllowedError') return '麦克风权限未授予，请在系统设置中允许本应用使用麦克风'
  if (error instanceof DOMException && error.name === 'NotFoundError') return '未找到可用的麦克风'
  return error instanceof Error ? error.message : String(error)
}

const audioObjectKey = (gatewaySn: string, fileName: string): string => {
  const safeName = fileName.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'speaker-audio'
  return `speaker/${gatewaySn}/${Date.now()}-${safeName}`
}

export function SpeakerControl({
  gatewaySn,
  psdkIndex,
  status,
  busy,
  onService,
  onNotify,
  objectStorageProfiles = [],
  activeObjectStorageId = '',
  onSelectObjectStorage,
  onOpenOssManager,
}: SpeakerControlProps) {
  const [mode, setMode] = useState<SpeakerMode>('tts')
  const [audioSource, setAudioSource] = useState<SpeakerAudioSource>('recording')
  const [text, setText] = useState('')
  const [volume, setVolume] = useState(70)
  const [sending, setSending] = useState<SpeakerAction>()
  const [feedback, setFeedback] = useState<SpeakerFeedback>()
  const [selection, setSelection] = useState<SpeakerAudioSelection>()
  const [artifact, setArtifact] = useState<SpeakerAudioArtifact>()
  const [objectKey, setObjectKey] = useState('')
  const [picking, setPicking] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<FirmwareUploadProgress>()
  const [requestingMicrophone, setRequestingMicrophone] = useState(false)
  const [recording, setRecording] = useState(false)
  const [processingRecording, setProcessingRecording] = useState(false)
  const [recordingElapsed, setRecordingElapsed] = useState(0)
  const [recordingPreviewUrl, setRecordingPreviewUrl] = useState('')
  const recorderRef = useRef<SpeakerMicrophoneRecorder>()
  const recordingTimerRef = useRef<number>()
  const recordingStartedAtRef = useRef(0)
  const recordingStopRequestedRef = useRef(false)
  const recordingPreviewUrlRef = useRef('')
  const channelReady = status === 'connected' && !busy && Boolean(onService)
  const selectedStorage = objectStorageProfiles.find((profile) => profile.id === activeObjectStorageId)
    ?? objectStorageProfiles[0]
  const storageReady = Boolean(selectedStorage && !objectStorageProfileIssues(selectedStorage).length)
  const artifactReady = Boolean(artifact && artifact.urlExpiresAt > Date.now() + 60_000)

  useEffect(() => window.djiApi.speakerAudio.onUploadProgress((progress) => {
    if (progress.selectionToken === selection?.token) setUploadProgress(progress)
  }), [selection?.token])

  useEffect(() => {
    if (activeObjectStorageId || !objectStorageProfiles[0] || !onSelectObjectStorage) return
    onSelectObjectStorage(objectStorageProfiles[0].id)
  }, [activeObjectStorageId, objectStorageProfiles, onSelectObjectStorage])

  useEffect(() => () => {
    recorderRef.current?.cancel()
    if (recordingTimerRef.current !== undefined) window.clearInterval(recordingTimerRef.current)
    if (recordingPreviewUrlRef.current) URL.revokeObjectURL(recordingPreviewUrlRef.current)
  }, [])

  const replaceRecordingPreview = (url: string): void => {
    if (recordingPreviewUrlRef.current) URL.revokeObjectURL(recordingPreviewUrlRef.current)
    recordingPreviewUrlRef.current = url
    setRecordingPreviewUrl(url)
  }

  const execute = async (
    action: SpeakerAction,
    method: string,
    data: Record<string, unknown>,
    successText: string,
  ): Promise<void> => {
    if (!onService) {
      onNotify?.('当前工作台未提供 services_reply 控制通道', 'error')
      return
    }
    if (status !== 'connected' || busy) {
      onNotify?.(status !== 'connected' ? 'MQTT 连接尚未就绪' : '连接配置正在同步，请稍候', 'error')
      return
    }

    setSending(action)
    setFeedback(undefined)
    try {
      const result = await onService(gatewaySn, method, data)
      const message = result.ok ? successText : commandError(result, `${successText}失败`)
      setFeedback({ ok: result.ok, text: message })
      onNotify?.(message, result.ok ? 'success' : 'error')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setFeedback({ ok: false, text: message })
      onNotify?.(message, 'error')
    } finally {
      setSending(undefined)
    }
  }

  const playTts = async (): Promise<void> => {
    try {
      await execute('tts', SPEAKER_SERVICE_METHODS.tts, buildSpeakerTtsData(psdkIndex, text), '设备已确认开始 TTS 喊话')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setFeedback({ ok: false, text: message })
      onNotify?.(message, 'error')
    }
  }

  const pickAudio = async (): Promise<void> => {
    setPicking(true)
    try {
      const result = await window.djiApi.speakerAudio.pick()
      if (result.error) {
        onNotify?.(result.error, 'error')
        return
      }
      if (!result.package) return
      setSelection(result.package)
      setArtifact(undefined)
      setUploadProgress(undefined)
      setObjectKey(audioObjectKey(gatewaySn, result.package.fileName))
      setFeedback(undefined)
    } catch (error) {
      onNotify?.(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setPicking(false)
    }
  }

  const uploadAndPlaySelection = async (
    audioSelection: SpeakerAudioSelection,
    audioObjectKeyValue: string,
  ): Promise<void> => {
    if (!selectedStorage || !storageReady) {
      onNotify?.('请先配置可用的对象存储', 'error')
      return
    }
    setUploading(true)
    setUploadProgress(undefined)
    setFeedback(undefined)
    try {
      const result = await window.djiApi.speakerAudio.upload({
        selectionToken: audioSelection.token,
        objectStorageProfileId: selectedStorage.id,
        objectKey: audioObjectKeyValue,
      })
      if (!result.ok || !result.artifact) {
        const message = result.error ?? '音频上传失败'
        setFeedback({ ok: false, text: message })
        onNotify?.(message, 'error')
        return
      }
      setArtifact(result.artifact)
      await playAudioArtifact(result.artifact)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setFeedback({ ok: false, text: message })
      onNotify?.(message, 'error')
    } finally {
      setUploading(false)
    }
  }

  const finishRecording = async (limitReached = false): Promise<void> => {
    if (recordingStopRequestedRef.current || !recorderRef.current) return
    recordingStopRequestedRef.current = true
    const recorder = recorderRef.current
    recorderRef.current = undefined
    if (recordingTimerRef.current !== undefined) window.clearInterval(recordingTimerRef.current)
    recordingTimerRef.current = undefined
    setRecording(false)
    setProcessingRecording(true)
    try {
      const recorded = await recorder.stop()
      const fileName = `voice-${Date.now()}.wav`
      const result = await window.djiApi.speakerAudio.registerRecording({ fileName, data: recorded.data })
      if (result.error || !result.package) throw new Error(result.error ?? '录音登记失败')
      const nextObjectKey = audioObjectKey(gatewaySn, fileName)
      setSelection(result.package)
      setArtifact(undefined)
      setUploadProgress(undefined)
      setObjectKey(nextObjectKey)
      setRecordingElapsed(recorded.durationMs)
      replaceRecordingPreview(URL.createObjectURL(new Blob([recorded.data.slice().buffer], { type: 'audio/wav' })))
      if (limitReached) onNotify?.('录音已达 60 秒上限，正在上传并喊话', 'info')
      await uploadAndPlaySelection(result.package, nextObjectKey)
    } catch (error) {
      const message = microphoneError(error)
      setFeedback({ ok: false, text: message })
      onNotify?.(message, 'error')
    } finally {
      setProcessingRecording(false)
      recordingStopRequestedRef.current = false
    }
  }

  const startRecording = async (): Promise<void> => {
    if (!channelReady || !storageReady) {
      onNotify?.(!channelReady ? '喊话控制通道尚未就绪' : '请先配置可用的对象存储', 'error')
      return
    }
    setRequestingMicrophone(true)
    setFeedback(undefined)
    try {
      recorderRef.current = await startSpeakerMicrophoneRecording()
      recordingStartedAtRef.current = Date.now()
      recordingStopRequestedRef.current = false
      setRecordingElapsed(0)
      setRecording(true)
      recordingTimerRef.current = window.setInterval(() => {
        const elapsed = Date.now() - recordingStartedAtRef.current
        setRecordingElapsed(Math.min(elapsed, SPEAKER_RECORDING_MAX_MS))
        if (elapsed >= SPEAKER_RECORDING_MAX_MS) void finishRecording(true)
      }, 250)
    } catch (error) {
      const message = microphoneError(error)
      setFeedback({ ok: false, text: message })
      onNotify?.(message, 'error')
    } finally {
      setRequestingMicrophone(false)
    }
  }

  const cancelRecording = (): void => {
    recorderRef.current?.cancel()
    recorderRef.current = undefined
    if (recordingTimerRef.current !== undefined) window.clearInterval(recordingTimerRef.current)
    recordingTimerRef.current = undefined
    recordingStopRequestedRef.current = false
    setRecording(false)
    setRecordingElapsed(0)
  }

  const playAudioArtifact = async (audioArtifact: SpeakerAudioArtifact): Promise<void> => {
    try {
      await execute('audio', SPEAKER_SERVICE_METHODS.audio, buildSpeakerAudioData(psdkIndex, {
        name: audioArtifact.fileName,
        url: audioArtifact.fileUrl,
        md5: audioArtifact.md5,
      }), '设备已确认开始播放音频')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setFeedback({ ok: false, text: message })
      onNotify?.(message, 'error')
    }
  }

  const uploadAndPlayAudio = async (): Promise<void> => {
    if (artifactReady && artifact) {
      await playAudioArtifact(artifact)
      return
    }
    if (!selection) {
      onNotify?.('请先选择 MP3 或 WAV 音频', 'error')
      return
    }
    await uploadAndPlaySelection(selection, objectKey)
  }

  return (
    <section className="speaker-control" aria-label={`PSDK ${psdkIndex} 喊话器控制`}>
      <header>
        <div><RadioTower size={16} /><h4>PSDK 控制通道</h4></div>
        <span className={channelReady ? 'ready' : ''}>{channelReady ? '通道就绪' : status === 'connected' ? '通道不可用' : 'MQTT 未连接'}</span>
      </header>
      <code className="speaker-control-topic">thing/product/{gatewaySn}/services · PSDK {psdkIndex}</code>

      <div className="speaker-mode-selector segmented" role="group" aria-label="喊话方式">
        <button type="button" disabled={recording || processingRecording} className={mode === 'tts' ? 'active' : ''} aria-pressed={mode === 'tts'} onClick={() => setMode('tts')}>
          <MessageSquareText size={14} />文字方式
        </button>
        <button type="button" disabled={recording || processingRecording} className={mode === 'audio' ? 'active' : ''} aria-pressed={mode === 'audio'} onClick={() => setMode('audio')}>
          <FileAudio size={14} />语音方式
        </button>
      </div>

      {mode === 'tts' ? <form className="speaker-tts-control" onSubmit={(event) => { event.preventDefault(); void playTts() }}>
        <label htmlFor={`speaker-tts-${psdkIndex}`}>
          <span><MessageSquareText size={14} />TTS 喊话</span>
          <small>{text.length}/{SPEAKER_TEXT_MAX_LENGTH}</small>
        </label>
        <textarea
          id={`speaker-tts-${psdkIndex}`}
          value={text}
          maxLength={SPEAKER_TEXT_MAX_LENGTH}
          disabled={Boolean(sending)}
          placeholder="输入喊话内容"
          onChange={(event) => setText(event.target.value)}
        />
        <button className="button primary" type="submit" disabled={!channelReady || Boolean(sending) || !text.trim()}>
          <Send size={15} />{sending === 'tts' ? '发送中' : '开始喊话'}
        </button>
      </form> : (
        <section className="speaker-audio-control">
          <div className="speaker-audio-source-selector segmented" role="group" aria-label="语音来源">
            <button type="button" disabled={recording || processingRecording || uploading} className={audioSource === 'recording' ? 'active' : ''} aria-pressed={audioSource === 'recording'} onClick={() => setAudioSource('recording')}><Mic size={14} />麦克风</button>
            <button type="button" disabled={recording || processingRecording || uploading} className={audioSource === 'file' ? 'active' : ''} aria-pressed={audioSource === 'file'} onClick={() => setAudioSource('file')}><FileAudio size={14} />本地文件</button>
          </div>
          {audioSource === 'recording' ? (
            <section className={`speaker-recorder ${recording ? 'recording' : ''}`} aria-label="实时语音录制">
              <div className="speaker-recorder-status">
                <span className="speaker-recorder-indicator"><Mic size={18} /></span>
                <span><strong>{recording ? '录音中' : processingRecording ? '正在处理录音' : selection?.fileName ?? '麦克风就绪'}</strong><small>{formatRecordingDuration(recordingElapsed)} / 01:00{selection && !recording ? ` · ${formatBytes(selection.fileSize)}` : ''}</small></span>
              </div>
              <div className="speaker-recorder-actions">
                <button className={`button ${recording ? 'danger' : 'primary'}`} type="button" disabled={requestingMicrophone || processingRecording || uploading || Boolean(sending) || (!recording && (!channelReady || !storageReady))} onClick={() => recording ? void finishRecording() : void startRecording()}>
                  {recording ? <Square size={14} /> : <Mic size={15} />}
                  {recording ? '停止并喊话' : requestingMicrophone ? '请求麦克风' : processingRecording ? '处理中' : '开始录音'}
                </button>
                {recording && <button className="icon-button small" type="button" aria-label="取消录音" onClick={cancelRecording}><X size={14} /></button>}
              </div>
              {recordingPreviewUrl && !recording && <audio className="speaker-recording-preview" controls preload="metadata" src={recordingPreviewUrl} />}
            </section>
          ) : (
            <button className={`speaker-audio-picker ${selection ? 'selected' : ''}`} type="button" disabled={picking || uploading || Boolean(sending)} onClick={() => void pickAudio()}>
              <FileAudio size={20} />
              <span>
                <strong>{selection?.fileName ?? '选择 MP3 / WAV 音频'}</strong>
                <small>{selection ? `${formatBytes(selection.fileSize)} · MD5 ${selection.md5}` : '本地音频将上传后由设备下载'}</small>
              </span>
            </button>
          )}
          <div className="speaker-audio-storage">
            <label>
              <span>对象存储</span>
              <span className="speaker-audio-storage-select">
                <select
                  aria-label="语音文件对象存储"
                  value={selectedStorage?.id ?? ''}
                  disabled={recording || processingRecording || uploading || Boolean(sending)}
                  onChange={(event) => onSelectObjectStorage?.(event.target.value)}
                >
                  {!objectStorageProfiles.length && <option value="">尚未配置</option>}
                  {objectStorageProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.bucket}</option>)}
                </select>
                <ChevronDown size={13} />
              </span>
            </label>
            {onOpenOssManager && <button className="icon-button small" type="button" aria-label="管理对象存储" onClick={onOpenOssManager}><Settings size={14} /></button>}
          </div>
          {uploading && <div className="speaker-audio-progress"><span style={{ width: `${uploadProgress?.percent ?? 0}%` }} /><small>{uploadProgress?.percent ?? 0}%</small></div>}
          <button
            className="button primary speaker-audio-play"
            type="button"
            disabled={!channelReady || !selection || !storageReady || recording || processingRecording || uploading || Boolean(sending)}
            onClick={() => void uploadAndPlayAudio()}
          >
            {uploading ? <Upload size={15} /> : <Play size={15} />}
            {uploading ? '上传中' : sending === 'audio' ? '播放中' : artifactReady ? '再次喊话' : '上传并喊话'}
          </button>
        </section>
      )}

      <div className="speaker-playback-controls">
        <label htmlFor={`speaker-volume-${psdkIndex}`}>
          <span><Volume2 size={15} />音量</span>
          <output>{volume}%</output>
        </label>
        <input
          id={`speaker-volume-${psdkIndex}`}
          type="range"
          min="0"
          max="100"
          step="1"
          value={volume}
          disabled={Boolean(sending)}
          onChange={(event) => setVolume(Number(event.target.value))}
        />
        <button
          className="button secondary"
          type="button"
          disabled={!channelReady || Boolean(sending)}
          onClick={() => void execute('volume', SPEAKER_SERVICE_METHODS.volume, buildSpeakerVolumeData(psdkIndex, volume), `音量已设为 ${volume}%`)}
        >
          <Volume2 size={15} />{sending === 'volume' ? '设置中' : '设置音量'}
        </button>
        <button
          className="button secondary speaker-stop-button"
          type="button"
          disabled={!channelReady || Boolean(sending)}
          onClick={() => void execute('stop', SPEAKER_SERVICE_METHODS.stop, buildSpeakerStopData(psdkIndex), '设备已确认停止播放')}
        >
          <Square size={14} />{sending === 'stop' ? '停止中' : '停止播放'}
        </button>
      </div>

      {feedback && (
        <div className={`speaker-feedback ${feedback.ok ? 'success' : 'error'}`} role="status" aria-live="polite">
          {feedback.ok ? <CircleCheck size={14} /> : <CircleAlert size={14} />}
          <span>{feedback.text}</span>
        </div>
      )}
    </section>
  )
}
