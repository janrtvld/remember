import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { capturePauseDurationMs, localDateTimeValue } from './capturePause'

describe('capture pause duration', () => {
  it('keeps the quick durations exact', () => {
    assert.equal(capturePauseDurationMs('15-minutes', '', 1_000), 15 * 60_000)
    assert.equal(capturePauseDurationMs('1-hour', '', 1_000), 60 * 60_000)
    assert.equal(capturePauseDurationMs('until-resumed', '', 1_000), null)
  })

  it('ends a today pause at the next local midnight', () => {
    const now = new Date(2026, 7, 25, 22, 30).getTime()
    assert.equal(capturePauseDurationMs('today', '', now), 90 * 60_000)
  })

  it('accepts only custom times in the future', () => {
    const now = new Date(2026, 7, 25, 12, 0).getTime()
    assert.equal(capturePauseDurationMs('custom', '2026-08-25T12:30', now), 30 * 60_000)
    assert.equal(capturePauseDurationMs('custom', '2026-08-25T11:59', now), undefined)
  })

  it('formats timestamps for a datetime-local input', () => {
    const timestamp = new Date(2026, 7, 25, 14, 5).getTime()
    assert.equal(localDateTimeValue(timestamp), '2026-08-25T14:05')
  })
})
