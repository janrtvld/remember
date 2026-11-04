import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { DailyReviewSession } from '@remember/shared'
import { canReuseForToday, localDayStart, nextLocalDayBoundary, sessionForCaptureStart } from '../dayLifecycle'

function session(patch: Partial<DailyReviewSession> = {}): DailyReviewSession {
  return {
    id: 'day',
    startedAt: new Date(2026, 6, 29, 9).getTime(),
    endedAt: new Date(2026, 6, 29, 10).getTime(),
    activeDurationMs: 60 * 60_000,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
    ...patch,
  }
}

describe('local day lifecycle', () => {
  it('reuses the captured calendar day after timezone travel instead of creating a duplicate', () => {
    const previousTimezone = process.env.TZ
    try {
      process.env.TZ = 'America/Los_Angeles'
      const day = session({
        localDay: '2026-09-24',
        startedAt: Date.parse('2026-09-23T22:00:00Z'),
        endedAt: Date.parse('2026-09-24T12:00:00Z'),
      })
      assert.equal(sessionForCaptureStart([day], null, Date.parse('2026-09-24T18:00:00Z')), day)
      assert.equal(canReuseForToday(day, Date.parse('2026-09-23T23:00:00Z')), false)
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ
      else process.env.TZ = previousTimezone
    }
  })

  it('uses local midnight as the day cutoff', () => {
    const duringDay = new Date(2026, 6, 29, 16, 45).getTime()
    assert.equal(localDayStart(duringDay), new Date(2026, 6, 29, 0, 0, 0, 0).getTime())
    assert.equal(nextLocalDayBoundary(duringDay), new Date(2026, 6, 30, 0, 0, 0, 0).getTime())
  })

  it('reopens one unfinished logical day after an app relaunch', () => {
    const now = new Date(2026, 6, 29, 12).getTime()
    assert.equal(canReuseForToday(session(), now), true)
  })

  it('never merges a previous day and can reopen a refreshed current day', () => {
    const now = new Date(2026, 6, 30, 9).getTime()
    assert.equal(canReuseForToday(session(), now), false)
    assert.equal(
      canReuseForToday(
        session({
          startedAt: new Date(2026, 6, 30, 8).getTime(),
          memory: {
            summary: '',
            currentFocus: null,
            outcomes: [],
            decisions: [],
            openLoops: [],
            conversations: [],
            timeline: [],
            knowledgeSuggestions: [],
            refreshedAt: now,
            coveredThrough: now,
          },
        }),
        now
      ),
      true
    )
    assert.equal(canReuseForToday(session({ startedAt: new Date(2026, 6, 31, 8).getTime() }), now), false)
  })

  it('resumes the active workday when a setup transition temporarily reports idle', () => {
    const active = session({ id: 'active-day', endedAt: null })
    const closed = session({ id: 'closed-day' })

    assert.equal(sessionForCaptureStart([closed, active], active.id)?.id, active.id)
  })
})
