const AUDIO_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
] as const

export function revinoteAudioRequestHeaders(headers: Headers) {
  const forwarded: Record<string, string> = {}
  for (const name of ['range', 'if-range']) {
    const value = headers.get(name)
    if (value) forwarded[name] = value
  }
  return forwarded
}

export function cancelableRevinoteAudioResponse(
  response: Response,
  subscribeCancellation: (cancel: () => void) => () => void
) {
  if (!response.body) return response
  const controller = new AbortController()
  const stream = new TransformStream<Uint8Array, Uint8Array>()
  const unsubscribe = subscribeCancellation(() => controller.abort(new Error('offline-mode-enabled')))
  void response.body
    .pipeTo(stream.writable, { signal: controller.signal })
    .catch(() => undefined)
    .finally(unsubscribe)
  return new Response(stream.readable, { status: response.status, headers: response.headers })
}

export async function resolveRevinoteAudioResponse(
  response: Response,
  requestHeaders: Headers,
  fetchAudio: (url: string, init: RequestInit) => Promise<Response>,
  developmentOrigin?: string
): Promise<Response | null> {
  let audio = response
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (!location) throw new Error('revinote-audio-redirect-invalid')
    const url = new URL(location)
    const localDevelopment =
      developmentOrigin === url.origin && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
    if ((url.protocol !== 'https:' && !localDevelopment) || url.username || url.password || url.hash) {
      throw new Error('revinote-audio-redirect-invalid')
    }
    audio = await fetchAudio(url.toString(), {
      headers: revinoteAudioRequestHeaders(requestHeaders),
      redirect: 'error',
      credentials: 'omit',
    })
  }
  if (audio.status === 404 || audio.status === 410) {
    await audio.body?.cancel()
    return null
  }
  const headers = new Headers({ 'Cache-Control': 'no-store' })
  for (const name of AUDIO_RESPONSE_HEADERS) {
    const value = audio.headers.get(name)
    if (value) headers.set(name, value)
  }
  return new Response(audio.body, { status: audio.status, headers })
}
