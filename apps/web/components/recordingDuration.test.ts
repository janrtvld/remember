import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recordingElapsedSeconds } from './recordingDuration'

const recording = { startedAt: 1000, endedAt: null, pausedAt: null, pausedMs: 2000 }

test('recording clock excludes pauses and uses the confirmed end during processing', () => {
  assert.equal(recordingElapsedSeconds(recording, 10_000), 7)
  assert.equal(recordingElapsedSeconds({ ...recording, endedAt: 9000 }, 60_000), 6)
})

test('stop request freezes display until confirmed; a failed stop can resume the clock', () => {
  assert.equal(recordingElapsedSeconds(recording, 60_000, 10_000), 7)
  assert.equal(recordingElapsedSeconds({ ...recording, endedAt: 11_000 }, 60_000, 10_000), 8)
  assert.equal(recordingElapsedSeconds(recording, 60_000, null), 57)
})

test('stopping while paused does not count time spent in the current pause', () => {
  assert.equal(recordingElapsedSeconds({ ...recording, pausedAt: 8000 }, 60_000, 30_000), 5)
  assert.equal(recordingElapsedSeconds({ ...recording, endedAt: 30_000, pausedMs: 24_000 }, 60_000), 5)
})

test('missing sessions and clocks behind start never show negative durations', () => {
  assert.equal(recordingElapsedSeconds(null, 60_000), 0)
  assert.equal(recordingElapsedSeconds(recording, 0), 0)
})
