import type { WhepOfferRequest, WhepOfferResult } from '../shared/contracts'

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const responseMessage = (body: string): string => {
  try {
    const parsed = JSON.parse(body) as { code?: unknown; message?: unknown; error?: unknown }
    const message = typeof parsed.message === 'string'
      ? parsed.message
      : typeof parsed.error === 'string' ? parsed.error : ''
    const code = typeof parsed.code === 'string' ? parsed.code : ''
    return [code, message].filter(Boolean).join(': ')
  } catch {
    return body.trim().slice(0, 500)
  }
}

export const extractWhepSdp = (body: string): string | undefined => {
  const trimmed = body.trim()
  if (trimmed.startsWith('v=')) return trimmed
  try {
    const parsed = JSON.parse(trimmed) as {
      sdp?: unknown
      answer?: unknown
      data?: { sdp?: unknown; answer?: unknown }
    }
    const candidates = [parsed.sdp, parsed.answer, parsed.data?.sdp, parsed.data?.answer]
    return candidates.find((value): value is string => typeof value === 'string' && value.trim().startsWith('v='))?.trim()
  } catch {
    return undefined
  }
}

export const negotiateWhep = async (
  request: WhepOfferRequest,
  fetcher: Fetcher = fetch,
): Promise<WhepOfferResult> => {
  try {
    const response = await fetcher(request.url, {
      method: 'POST',
      headers: { Accept: 'application/sdp', 'Content-Type': 'application/sdp' },
      body: request.sdp,
      signal: AbortSignal.timeout(12_000),
    })
    const body = await response.text()
    if (!response.ok) {
      const detail = responseMessage(body)
      return { ok: false, error: `WHEP HTTP ${response.status}${detail ? `：${detail}` : ''}` }
    }
    const sdp = extractWhepSdp(body)
    return sdp
      ? { ok: true, sdp }
      : { ok: false, error: 'WHEP 服务返回成功，但响应中没有有效 SDP answer' }
  } catch (error) {
    return { ok: false, error: `WHEP 请求失败：${error instanceof Error ? error.message : String(error)}` }
  }
}
