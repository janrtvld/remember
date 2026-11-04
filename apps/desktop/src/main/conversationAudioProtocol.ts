import { createReadStream, statSync } from 'node:fs'
import { Readable } from 'node:stream'

type ByteRange = { start: number; end: number }

export function parseByteRange(value: string | null, size: number): ByteRange | null | 'invalid' {
  if (!value) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!match || size <= 0) return 'invalid'

  const [, rawStart = '', rawEnd = ''] = match
  if (!rawStart && !rawEnd) return 'invalid'
  if (!rawStart) {
    const suffixLength = Number(rawEnd)
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'invalid'
    return { start: Math.max(0, size - suffixLength), end: size - 1 }
  }

  const start = Number(rawStart)
  const requestedEnd = rawEnd ? Number(rawEnd) : size - 1
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= size
  ) {
    return 'invalid'
  }
  return { start, end: Math.min(requestedEnd, size - 1) }
}

export function conversationAudioResponse(file: string, request: Request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } })
  }

  let size: number
  try {
    size = statSync(file).size
  } catch {
    return new Response(null, { status: 404 })
  }
  const range = parseByteRange(request.headers.get('range'), size)
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'Content-Type': 'audio/wav',
  })
  if (range === 'invalid') {
    headers.set('Content-Range', `bytes */${size}`)
    return new Response(null, { status: 416, headers })
  }

  const start = range?.start ?? 0
  const end = range?.end ?? Math.max(0, size - 1)
  const contentLength = size === 0 ? 0 : end - start + 1
  headers.set('Content-Length', String(contentLength))
  if (range) headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
  if (request.method === 'HEAD' || size === 0) {
    return new Response(null, { status: range ? 206 : 200, headers })
  }

  const stream = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>
  return new Response(stream, { status: range ? 206 : 200, headers })
}
