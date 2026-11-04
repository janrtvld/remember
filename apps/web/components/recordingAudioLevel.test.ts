import assert from 'node:assert/strict'
import test from 'node:test'
import { recordingAudioLevelAt } from './recordingAudioLevel'

test('recording meter uses the current microphone or system signal and silence stays still', () => {
  assert.equal(recordingAudioLevelAt([], 1000), 0)
  assert.equal(recordingAudioLevelAt([{ source: 'microphone', level: 0, at: 1000 }], 1000), 0)
  assert.equal(
    recordingAudioLevelAt(
      [
        { source: 'microphone', level: 0.2, at: 1000 },
        { source: 'system', level: 0.7, at: 950 },
      ],
      1000
    ),
    0.7
  )
})

test('stale, future and malformed levels cannot keep a recording waveform moving', () => {
  assert.equal(recordingAudioLevelAt([{ source: 'microphone', level: 0.8, at: 500 }], 1000), 0)
  assert.equal(recordingAudioLevelAt([{ source: 'system', level: 0.8, at: 1001 }], 1000), 0)
  assert.equal(recordingAudioLevelAt([{ source: 'microphone', level: Number.NaN, at: 1000 }], 1000), 0)
  assert.equal(recordingAudioLevelAt([{ source: 'system', level: 0.4, at: 501 }], 1000), 0.4)
})
