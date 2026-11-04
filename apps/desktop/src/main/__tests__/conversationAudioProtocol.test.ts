import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { conversationAudioResponse, parseByteRange } from '../conversationAudioProtocol'

describe('conversation audio protocol', () => {
  it('parses bounded and suffix byte ranges', () => {
    assert.deepEqual(parseByteRange('bytes=10-19', 100), { start: 10, end: 19 })
    assert.deepEqual(parseByteRange('bytes=90-', 100), { start: 90, end: 99 })
    assert.deepEqual(parseByteRange('bytes=-10', 100), { start: 90, end: 99 })
    assert.equal(parseByteRange('bytes=100-101', 100), 'invalid')
  })

  it('streams only the requested bytes with media range headers', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'remember-audio-protocol-'))
    try {
      const file = join(directory, 'conversation.wav')
      writeFileSync(file, Buffer.from('0123456789'))
      const response = conversationAudioResponse(
        file,
        new Request('remember-audio://conversation', { headers: { Range: 'bytes=2-5' } })
      )

      assert.equal(response.status, 206)
      assert.equal(response.headers.get('accept-ranges'), 'bytes')
      assert.equal(response.headers.get('content-range'), 'bytes 2-5/10')
      assert.equal(response.headers.get('content-length'), '4')
      assert.equal(Buffer.from(await response.arrayBuffer()).toString('utf8'), '2345')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('returns not found when retained audio disappeared before playback', () => {
    const response = conversationAudioResponse(
      join(tmpdir(), 'missing-remember-conversation.wav'),
      new Request('remember-audio://conversation')
    )

    assert.equal(response.status, 404)
  })
})
