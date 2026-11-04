import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  cancelableRevinoteAudioResponse,
  resolveRevinoteAudioResponse,
  revinoteAudioRequestHeaders,
} from './revinoteAudio'

const unexpectedFetch = async () => {
  throw new Error('Unexpected external audio request')
}

describe('Revinote audio playback', () => {
  it('stops an active remote stream when offline mode is enabled and releases the listener', async () => {
    let cancel: (() => void) | undefined
    let sourceCancelled = false
    let unsubscribed = false
    const response = cancelableRevinoteAudioResponse(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]))
          },
          cancel() {
            sourceCancelled = true
          },
        })
      ),
      (listener) => {
        cancel = listener
        return () => {
          unsubscribed = true
        }
      }
    )
    assert(response.body)
    const reader = response.body.getReader()
    assert.deepEqual((await reader.read()).value, new Uint8Array([1]))
    cancel?.()
    await assert.rejects(reader.read(), /offline-mode-enabled/)
    await new Promise((resolve) => setImmediate(resolve))
    assert(sourceCancelled)
    assert(unsubscribed)
  })

  it('forwards seeking headers without renderer credentials', () => {
    assert.deepEqual(
      revinoteAudioRequestHeaders(new Headers({ Range: 'bytes=2-5', 'If-Range': 'etag', Authorization: 'secret' })),
      { range: 'bytes=2-5', 'if-range': 'etag' }
    )
  })

  it('streams signed storage audio without forwarding connector credentials or allowing another redirect', async () => {
    const body = new Uint8Array([1, 2, 3, 4])
    const response = await resolveRevinoteAudioResponse(
      new Response(null, { status: 302, headers: { Location: 'https://audio.example.test/recording?signature=test' } }),
      new Headers({ Range: 'bytes=0-3', Authorization: 'connector-secret', Cookie: 'session=secret' }),
      async (url, init) => {
        assert.equal(url, 'https://audio.example.test/recording?signature=test')
        assert.deepEqual(init, { headers: { range: 'bytes=0-3' }, redirect: 'error', credentials: 'omit' })
        return new Response(body, {
          status: 206,
          headers: {
            'Content-Type': 'audio/wav',
            'Content-Length': '4',
            'Content-Range': 'bytes 0-3/10',
            'Accept-Ranges': 'bytes',
            'Set-Cookie': 'storage-secret',
          },
        })
      }
    )
    assert.equal(response?.status, 206)
    assert.equal(response.headers.get('content-range'), 'bytes 0-3/10')
    assert.equal(response.headers.get('set-cookie'), null)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), body)
  })

  it('passes streamed authenticated audio and range errors without another request', async () => {
    const audio = await resolveRevinoteAudioResponse(
      new Response('audio', { headers: { 'Content-Type': 'audio/mpeg' } }),
      new Headers(),
      unexpectedFetch
    )
    assert.equal(await audio?.text(), 'audio')
    const rangeError = await resolveRevinoteAudioResponse(
      new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */100' } }),
      new Headers(),
      unexpectedFetch
    )
    assert.equal(rangeError?.status, 416)
    assert.equal(rangeError.headers.get('content-range'), 'bytes */100')
  })

  it('allows unavailable or expired audio to fall back locally', async () => {
    for (const status of [404, 410]) {
      assert.equal(
        await resolveRevinoteAudioResponse(new Response('Unavailable', { status }), new Headers(), unexpectedFetch),
        null
      )
    }
  })

  it('rejects insecure and credential-bearing storage redirects', async () => {
    for (const location of ['http://audio.example.test/file', 'file:///tmp/audio.wav', 'https://secret@example.test']) {
      await assert.rejects(
        resolveRevinoteAudioResponse(
          new Response(null, { status: 302, headers: { location } }),
          new Headers(),
          unexpectedFetch
        ),
        /revinote-audio-redirect-invalid/
      )
    }
  })

  it('allows loopback storage only on the explicit development origin', async () => {
    const source = () => new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1:4321/audio' } })
    await assert.rejects(resolveRevinoteAudioResponse(source(), new Headers(), unexpectedFetch), /redirect-invalid/)
    const audio = await resolveRevinoteAudioResponse(
      source(),
      new Headers(),
      async () => new Response('fixture'),
      'http://127.0.0.1:4321'
    )
    assert.equal(await audio?.text(), 'fixture')
  })
})
