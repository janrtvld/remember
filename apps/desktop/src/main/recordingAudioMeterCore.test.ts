import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RecordingAudioLevel } from '@remember/shared'
import { createRecordingAudioMeter, pcmRms } from './recordingAudioMeterCore'

test('PCM meter follows actual sample energy without changing audio samples', () => {
  const samples = new Float32Array([0.25, -0.25, 0.5, -0.5])
  const original = samples.slice()

  assert.equal(pcmRms(samples), Math.sqrt(0.15625))
  assert.deepEqual(samples, original)
  assert.equal(pcmRms(new Float32Array(128)), 0)
  assert.equal(pcmRms(new Float32Array()), 0)
  assert.equal(pcmRms(new Float32Array([2, -2])), 1)
  assert.equal(pcmRms(new Float32Array([0.25, Number.NaN])), 0)
  assert.equal(pcmRms(new Float32Array([Number.POSITIVE_INFINITY])), 0)
})

test('audio meter bounds display levels, emits silence and throttles each source independently', () => {
  const events: RecordingAudioLevel[] = []
  let at = 1_000
  const publish = createRecordingAudioMeter(
    (sample) => events.push(sample),
    () => at
  )

  publish('microphone', 0.04)
  publish('system', 0)
  assert.deepEqual(events, [
    { source: 'microphone', level: 0.5, at: 1_000 },
    { source: 'system', level: 0, at: 1_000 },
  ])

  at += 199
  publish('microphone', 1)
  assert.equal(events.length, 2)
  at += 1
  publish('microphone', 4)
  assert.deepEqual(events.at(-1), { source: 'microphone', level: 1, at: 1_200 })

  at += 200
  publish('microphone', 0)
  assert.deepEqual(events.at(-1), { source: 'microphone', level: 0, at: 1_400 })

  at += 200
  publish('system', Number.NaN)
  publish('system', Number.POSITIVE_INFINITY)
  publish('system', -0.1)
  assert.equal(events.length, 4)
})

test('audio meter recovers if the system clock moves backwards', () => {
  const events: RecordingAudioLevel[] = []
  let at = 10_000
  const publish = createRecordingAudioMeter(
    (sample) => events.push(sample),
    () => at
  )
  publish('system', 0.16)

  at = 500
  publish('system', 0)
  assert.equal(events.length, 2)
  assert.deepEqual(events[1], { source: 'system', level: 0, at: 500 })
})
