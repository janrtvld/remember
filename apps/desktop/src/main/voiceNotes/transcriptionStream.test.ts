import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  chunkAtSample,
  chunkIdsForSampleRange,
  isContinuousCapture,
  resolveCompletedChunks,
  resolveIdleChunks,
  timestampAtSample,
} from './transcriptionStream'

const chunks = [
  { id: 'chunk-1', startSample: 0, endSample: 6_000, startedAt: 1_000 },
  { id: 'chunk-2', startSample: 6_000, endSample: 12_000, startedAt: 61_000 },
]

describe('transcription stream continuity', () => {
  it('maps one speech span across two transport chunks', () => {
    assert.equal(chunkAtSample(chunks, 5_500)?.id, 'chunk-1')
    assert.deepEqual(chunkIdsForSampleRange(chunks, 5_500, 6_500), ['chunk-1', 'chunk-2'])
    assert.equal(timestampAtSample(chunks, 5_500, 12_000, 100), 56_000)
    assert.equal(timestampAtSample(chunks, 6_500, 12_000, 100), 66_000)
    assert.equal(timestampAtSample(chunks, 1, 12_000, 16_000), 1_000)
  })

  it('treats epoch changes and sequence gaps as discontinuities', () => {
    const current = { captureEpochId: 'epoch-1', expectedSequence: 4 }
    assert.equal(isContinuousCapture(current, { captureEpochId: 'epoch-1', sequence: 4 }), true)
    assert.equal(isContinuousCapture(current, { captureEpochId: 'epoch-1', sequence: 5 }), false)
    assert.equal(isContinuousCapture(current, { captureEpochId: 'epoch-2', sequence: 4 }), false)
  })

  it('keeps the newest idle chunk as boundary context', () => {
    assert.deepEqual(resolveIdleChunks(chunks), {
      resolvedChunkIds: ['chunk-1'],
      retainedChunks: [chunks[1]],
    })
  })

  it('resolves completed chunks while a newer utterance is still pending', () => {
    assert.deepEqual(resolveCompletedChunks(chunks, 6_000), {
      resolvedChunkIds: ['chunk-1'],
      retainedChunks: [chunks[1]],
    })
  })

  it('keeps a chunk touched by the undecoded tail even if it already has decoded speech', () => {
    assert.deepEqual(resolveCompletedChunks(chunks, 5_500), {
      resolvedChunkIds: [],
      retainedChunks: chunks,
    })
    const completed = resolveCompletedChunks(chunks, 6_500)
    assert.deepEqual(completed.resolvedChunkIds, ['chunk-1'])
    assert.equal(timestampAtSample(completed.retainedChunks, 6_500, 12_000, 100), 66_000)
  })

  it('prevents a growing pending backlog when every transport chunk ends during speech', () => {
    const chunkSamples = 60 * 16_000
    let retainedChunks: typeof chunks = []
    const resolvedChunkIds: string[] = []
    for (let index = 0; index < 10; index++) {
      retainedChunks.push({
        id: `chunk-${index + 1}`,
        startSample: index * chunkSamples,
        endSample: (index + 1) * chunkSamples,
        startedAt: index * 60_000,
      })
      const resolved = resolveCompletedChunks(retainedChunks, (index + 1) * chunkSamples - 16_000)
      resolvedChunkIds.push(...resolved.resolvedChunkIds)
      retainedChunks = resolved.retainedChunks
      assert.equal(retainedChunks.length, 1)
    }
    assert.deepEqual(
      resolvedChunkIds,
      Array.from({ length: 9 }, (_, index) => `chunk-${index + 1}`)
    )
    assert.equal(retainedChunks[0]?.id, 'chunk-10')
  })

  it('keeps the newest chunk for boundary context even when all its speech has completed', () => {
    assert.deepEqual(resolveCompletedChunks(chunks, 12_000), {
      resolvedChunkIds: ['chunk-1'],
      retainedChunks: [chunks[1]],
    })
  })
})
