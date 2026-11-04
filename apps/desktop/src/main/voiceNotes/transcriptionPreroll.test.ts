import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type TranscriptionSampleChunk, withSpeechPreroll } from './transcriptionPreroll'

function chunk(id: string, startSample: number, samples: number[]): TranscriptionSampleChunk {
  return {
    id,
    startSample,
    endSample: startSample + samples.length,
    startedAt: startSample * 100,
    samples: Float32Array.from(samples),
  }
}

test('recovers at most 500ms before VAD onset, across transport chunks, without altering the detected waveform', () => {
  const detected = { start: 8, samples: Float32Array.from([8, 9, 10]) }
  const result = withSpeechPreroll(
    detected,
    [chunk('a', 0, [0, 1, 2, 3, 4]), chunk('b', 5, [5, 6, 7, 8, 9, 10])],
    0,
    10
  )
  assert.equal(result.start, 3)
  assert.deepEqual([...result.samples], [3, 4, 5, 6, 7, 8, 9, 10])
  assert.deepEqual([...detected.samples], [8, 9, 10])
})

test('never includes already completed speech or unavailable samples from an earlier capture epoch', () => {
  const detected = { start: 8, samples: Float32Array.from([8, 9, 10]) }
  const chunks = [chunk('current', 5, [5, 6, 7, 8, 9, 10])]
  assert.deepEqual([...withSpeechPreroll(detected, chunks, 7, 10).samples], [7, 8, 9, 10])
  assert.deepEqual([...withSpeechPreroll(detected, chunks, 8, 10).samples], [8, 9, 10])
  assert.deepEqual([...withSpeechPreroll(detected, chunks, 0, 10).samples], [5, 6, 7, 8, 9, 10])
  assert.equal(
    withSpeechPreroll({ start: 2, samples: Float32Array.from([2, 3]) }, [chunk('new-epoch', 0, [0, 1, 2, 3])], 0, 10)
      .start,
    0
  )
})
