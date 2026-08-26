import { describe, expect, it, vi } from 'vitest'
import { extractWhepSdp, negotiateWhep } from './whep-client'

const request = {
  url: 'https://media.example.com/whep?app=live&stream=main',
  sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0',
}

describe('WHEP client', () => {
  it('extracts raw and JSON-wrapped SDP answers', () => {
    expect(extractWhepSdp('v=0\r\no=answer')).toBe('v=0\r\no=answer')
    expect(extractWhepSdp(JSON.stringify({ data: { sdp: 'v=0\r\no=wrapped' } }))).toBe('v=0\r\no=wrapped')
    expect(extractWhepSdp('{"ok":true}')).toBeUndefined()
  })

  it('posts an SDP offer and returns the SDP answer', async () => {
    const fetcher = vi.fn(async () => new Response('v=0\r\no=answer', {
      status: 201,
      headers: { 'Content-Type': 'application/sdp' },
    }))
    await expect(negotiateWhep(request, fetcher)).resolves.toEqual({ ok: true, sdp: 'v=0\r\no=answer' })
    expect(fetcher).toHaveBeenCalledWith(request.url, expect.objectContaining({
      method: 'POST',
      body: request.sdp,
      headers: { Accept: 'application/sdp', 'Content-Type': 'application/sdp' },
    }))
  })

  it('surfaces the SecretEMS error code and message', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      code: 'WEBRTC_STREAM_NOT_FOUND',
      message: 'stream is not online',
    }), { status: 404 }))
    await expect(negotiateWhep(request, fetcher)).resolves.toEqual({
      ok: false,
      error: 'WHEP HTTP 404：WEBRTC_STREAM_NOT_FOUND: stream is not online',
    })
  })
})
