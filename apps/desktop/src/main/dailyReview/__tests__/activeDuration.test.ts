import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { activeUntil, checkpointActiveDuration, creditActiveInterval, currentActiveDuration } from '../activeDuration'

describe('active duration', () => {
  it('accrues ordinary active checkpoints', () => {
    const clock = checkpointActiveDuration({ accumulatedMs: 0, trackingSince: 1_000 }, 61_000, 0)
    assert.deepEqual(clock, { accumulatedMs: 60_000, trackingSince: 61_000 })
  })

  it('caps a long idle span at the idle allowance and stops tracking', () => {
    const clock = checkpointActiveDuration({ accumulatedMs: 10_000, trackingSince: 0 }, 60 * 60_000, 60 * 60)
    assert.deepEqual(clock, { accumulatedMs: 10_000 + 5 * 60_000, trackingSince: null })
    assert.equal(activeUntil(60 * 60_000, 60 * 60), 5 * 60_000)
  })

  it('does not backfill sleep time when activity resumes', () => {
    const sleeping = checkpointActiveDuration({ accumulatedMs: 120_000, trackingSince: null }, 3_600_000, 3_600)
    const resumed = checkpointActiveDuration(sleeping, 3_660_000, 0)
    const next = checkpointActiveDuration(resumed, 3_720_000, 0)

    assert.deepEqual(resumed, { accumulatedMs: 120_000, trackingSince: 3_660_000 })
    assert.deepEqual(next, { accumulatedMs: 180_000, trackingSince: 3_720_000 })
  })

  it('previews in-flight time without mutating the clock', () => {
    const clock = { accumulatedMs: 30_000, trackingSince: 100_000 }
    assert.equal(currentActiveDuration(clock, 160_000, 0), 90_000)
    assert.deepEqual(clock, { accumulatedMs: 30_000, trackingSince: 100_000 })
  })

  it('credits overlapping microphone and system speech only once', () => {
    const microphone = creditActiveInterval([], { startedAt: 100_000, endedAt: 160_000 })
    const system = creditActiveInterval(microphone.intervals, { startedAt: 120_000, endedAt: 180_000 })

    assert.equal(microphone.addedMs, 60_000)
    assert.equal(system.addedMs, 20_000)
    assert.deepEqual(system.intervals, [{ startedAt: 100_000, endedAt: 180_000 }])
  })
})
