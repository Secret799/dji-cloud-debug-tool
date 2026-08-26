import { describe, expect, it, vi } from 'vitest'
import { extractIceCandidatesFromSdp, setRemoteAnswerWithIceFallback } from './webrtc'

const answer = [
  'v=0',
  'o=- 1 1 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=mid:0',
  'a=ice-ufrag:test',
  'a=ice-pwd:test-password',
  'a=candidate:6a06ae0b 1 tcp 105 1.95.135.125 8000 typ host tcptype passive',
  'a=end-of-candidates',
  'a=recvonly',
  '',
].join('\r\n')

describe('WebRTC SDP compatibility', () => {
  it('extracts candidates with their media section and normalizes line endings', () => {
    const result = extractIceCandidatesFromSdp(answer.replace(/\r\n/g, '\n'))
    expect(result.candidates).toEqual([{
      candidate: 'candidate:6a06ae0b 1 tcp 105 1.95.135.125 8000 typ host tcptype passive',
      sdpMid: '0',
      sdpMLineIndex: 0,
    }])
    expect(result.sdp).not.toContain('a=candidate:')
    expect(result.sdp).not.toContain('a=end-of-candidates')
    expect(result.sdp).toContain('a=mid:0\r\n')
  })

  it('falls back to trickled ICE candidates when the embedded answer is rejected', async () => {
    const connection = {
      setRemoteDescription: vi.fn()
        .mockRejectedValueOnce(new Error('Invalid SDP line'))
        .mockResolvedValueOnce(undefined),
      addIceCandidate: vi.fn().mockResolvedValue(undefined),
    } as unknown as RTCPeerConnection

    await expect(setRemoteAnswerWithIceFallback(connection, answer)).resolves.toBeUndefined()
    expect(connection.setRemoteDescription).toHaveBeenCalledTimes(2)
    expect(connection.addIceCandidate).toHaveBeenNthCalledWith(1, {
      candidate: 'candidate:6a06ae0b 1 tcp 105 1.95.135.125 8000 typ host tcptype passive',
      sdpMid: '0',
      sdpMLineIndex: 0,
    })
    expect(connection.addIceCandidate).toHaveBeenLastCalledWith(null)
  })
})
