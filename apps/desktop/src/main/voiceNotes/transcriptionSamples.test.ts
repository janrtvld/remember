import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { copyTranscriptionSamples } from './transcriptionSamples'

describe('transcription samples', () => {
  it('copies IPC samples into independently owned memory', () => {
    const source = new Float32Array([0.25, -0.5, 0.75])
    const copy = copyTranscriptionSamples(source)

    assert.deepEqual([...copy], [...source])
    assert.notEqual(copy.buffer, source.buffer)

    source[0] = 1
    assert.equal(copy[0], 0.25)
  })
})
