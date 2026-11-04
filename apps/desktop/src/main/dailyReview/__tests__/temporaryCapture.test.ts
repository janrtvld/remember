import assert from 'node:assert/strict'
import { test } from 'node:test'
import { consumeTemporaryCaptureFile } from '../temporaryCapture'

test('deletes a temporary audio chunk after successful processing', async () => {
  const removed: string[] = []

  const result = await consumeTemporaryCaptureFile(
    '/temporary/audio.wav',
    (path) => removed.push(path),
    async () => {
      return 'transcribed'
    }
  )

  assert.equal(result, 'transcribed')
  assert.deepEqual(removed, ['/temporary/audio.wav'])
})

test('deletes a temporary audio chunk when processing fails', async () => {
  const removed: string[] = []

  await assert.rejects(
    consumeTemporaryCaptureFile(
      '/temporary/audio.wav',
      (path) => removed.push(path),
      async () => {
        throw new Error('transcription-failed')
      }
    ),
    /transcription-failed/
  )

  assert.deepEqual(removed, ['/temporary/audio.wav'])
})
