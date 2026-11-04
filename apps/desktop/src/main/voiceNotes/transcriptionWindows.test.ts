import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { splitTranscriptionSamples } from './transcriptionWindows'

const SAMPLE_RATE = 100

describe('transcription windows', () => {
  for (const durationSeconds of [31, 40, 48]) {
    it(`covers a ${durationSeconds} second span exactly once`, () => {
      const samples = Float32Array.from({ length: SAMPLE_RATE * durationSeconds }, (_, index) => index)
      const windows = splitTranscriptionSamples(samples, SAMPLE_RATE)

      assert.ok(windows.length >= 2)
      assert.equal(windows[0]?.startSample, 0)
      assert.equal(windows.at(-1)?.endSample, samples.length)
      assert.ok(windows.every((window) => window.samples.length <= SAMPLE_RATE * 26))
      for (let index = 1; index < windows.length; index += 1) {
        assert.equal(windows[index]?.startSample, windows[index - 1]?.endSample)
      }
      assert.deepEqual(
        windows.flatMap((window) => [...window.samples]),
        [...samples]
      )
    })
  }

  it('prefers the quietest safe seam', () => {
    const samples = new Float32Array(SAMPLE_RATE * 40).fill(0.8)
    samples.fill(0, SAMPLE_RATE * 23, SAMPLE_RATE * 23.2)

    const [first] = splitTranscriptionSamples(samples, SAMPLE_RATE)

    assert.ok(first)
    assert.ok(Math.abs(first.endSample - SAMPLE_RATE * 23) <= SAMPLE_RATE * 0.1)
  })
})
