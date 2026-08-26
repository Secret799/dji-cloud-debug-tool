export interface ExtractedIceCandidate {
  candidate: string
  sdpMid: string | null
  sdpMLineIndex: number
}

export interface SdpWithoutIceCandidates {
  sdp: string
  candidates: ExtractedIceCandidate[]
}

export const extractIceCandidatesFromSdp = (sdp: string): SdpWithoutIceCandidates => {
  const lines = sdp.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const sections: string[][] = [[]]
  for (const line of lines) {
    if (line.startsWith('m=')) sections.push([])
    sections[sections.length - 1].push(line)
  }

  const candidates: ExtractedIceCandidate[] = []
  const sanitizedSections = sections.map((section, sectionIndex) => {
    if (sectionIndex === 0) return section
    const sdpMLineIndex = sectionIndex - 1
    const midLine = section.find((line) => line.startsWith('a=mid:'))
    const sdpMid = midLine?.slice('a=mid:'.length) || null
    return section.filter((line) => {
      if (line.startsWith('a=candidate:')) {
        candidates.push({ candidate: line.slice(2), sdpMid, sdpMLineIndex })
        return false
      }
      return line !== 'a=end-of-candidates'
    })
  })

  const normalized = sanitizedSections.flat().filter((line, index, all) => line || index < all.length - 1).join('\r\n')
  return { sdp: `${normalized.replace(/(?:\r\n)+$/, '')}\r\n`, candidates }
}

export const setRemoteAnswerWithIceFallback = async (
  connection: RTCPeerConnection,
  sdp: string,
): Promise<void> => {
  try {
    await connection.setRemoteDescription({ type: 'answer', sdp })
    return
  } catch (error) {
    const extracted = extractIceCandidatesFromSdp(sdp)
    if (!extracted.candidates.length) throw error
    await connection.setRemoteDescription({ type: 'answer', sdp: extracted.sdp })
    for (const candidate of extracted.candidates) {
      await connection.addIceCandidate(candidate)
    }
    await connection.addIceCandidate(null)
  }
}
