import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { summarizeUserActivity, type UserActivityDay } from './userActivity'

const DAY = 86_400_000
const now = Date.UTC(2026, 10, 12, 20)

function day(daysAgo: number, overrides: Partial<UserActivityDay> = {}): UserActivityDay {
  const midnight = Date.UTC(2026, 10, 12) - daysAgo * DAY
  return {
    localDay: new Date(midnight).toISOString().slice(0, 10),
    startedAt: midnight + 9 * 3_600_000,
    activeDurationMs: 6 * 3_600_000,
    appActivity: [
      {
        appName: 'Xcode',
        bundleId: 'com.apple.dt.Xcode',
        startedAt: midnight + 9 * 3_600_000,
        endedAt: midnight + 10 * 3_600_000,
      },
      {
        appName: 'Slack',
        bundleId: 'com.tinyspeck.slackmacgap',
        startedAt: midnight + 17 * 3_600_000,
        endedAt: midnight + 17.5 * 3_600_000,
      },
    ],
    memory: {
      projectAttention: [{ project: 'Harbor', durationMinutes: 120, description: '' }],
      conversations: [],
    },
    ...overrides,
  }
}

describe('summarizeUserActivity', () => {
  it('does not generalize from fewer than three recorded days', () => {
    assert.equal(summarizeUserActivity({ days: [day(1), day(2)], items: [], now, timeZone: 'UTC' }), null)
  })

  it('reports usual hours, projects, apps and recently abandoned tasks', () => {
    const patterns = summarizeUserActivity({
      days: [day(1), day(2), day(3), day(40)],
      items: [
        { title: 'Plan offsite', lifecycle: 'abandoned', closedAt: now - DAY },
        { title: 'Ship build', lifecycle: 'completed', closedAt: now - DAY },
        { title: 'Old idea', lifecycle: 'abandoned', closedAt: now - 60 * DAY },
        { title: 'Review spec', lifecycle: 'open', closedAt: null },
      ],
      now,
      timeZone: 'UTC',
    })
    assert.ok(patterns)
    assert.equal(patterns.observedDays, 3)
    assert.equal(patterns.usualStart, '09:00')
    assert.equal(patterns.usualEnd, '17:30')
    assert.equal(patterns.activeHoursPerDay, 6)
    assert.deepEqual(patterns.projects, [{ project: 'Harbor', minutes: 360, days: 3 }])
    assert.deepEqual(patterns.apps[0], { app: 'Xcode', minutes: 180, days: 3 })
    assert.deepEqual(patterns.tasks, { completed: 1, abandoned: 1, open: 1, recentlyAbandoned: ['Plan offsite'] })
  })

  it('keeps app activity but drops project attention when a Day summary is not permitted', () => {
    const patterns = summarizeUserActivity({
      days: [day(1, { memory: null }), day(2, { memory: null }), day(3, { memory: null })],
      items: [],
      now,
      timeZone: 'UTC',
    })
    assert.deepEqual(patterns?.projects, [])
    assert.equal(patterns?.apps.length, 2)
  })
})
