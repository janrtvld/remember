import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Day } from '@remember/shared'
import { EvidenceStore } from '../../src/main/dailyReview/evidenceStore'

export function seedStartupTravel(profile: string) {
  const store = new EvidenceStore(join(profile, 'daily-review/evidence.sqlite'))
  try {
    store.upsertSession({
      id: 'qa-travel-day',
      localDay: '2020-09-24',
      startedAt: Date.parse('2020-09-23T22:00:00Z'),
      endedAt: Date.parse('2020-09-24T16:00:00Z'),
      activeDurationMs: 60_000,
      moments: [],
      appActivity: [],
      contextMoments: [],
      memory: null,
      refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
    })
  } finally {
    store.close()
  }
  const integration = join(profile, 'integrations/revinote')
  mkdirSync(integration, { recursive: true })
  writeFileSync(
    join(integration, 'meetings.json'),
    JSON.stringify({
      version: 1,
      meetings: {
        'qa-travel-meeting': {
          id: 'qa-travel-meeting',
          title: 'Synthetic travel meeting',
          status: 'finished',
          date: '2020-09-24T15:00:00Z',
          updatedAt: '2020-09-24T15:01:00Z',
          participants: [],
          summary: 'Synthetic startup fixture',
          actionItems: [],
          durationSeconds: 60,
          transcript: 'Synthetic meeting; no real recording.',
        },
      },
    }),
    { mode: 0o600 }
  )
  const lock = join(profile, '.runtime-lock')
  mkdirSync(lock, { mode: 0o700 })
  // The QA runner is alive, but this legacy lock predates that process, like a reused PID after reboot.
  writeFileSync(
    join(lock, 'owner.json'),
    JSON.stringify({
      token: 'qa-stale-before-reboot',
      pid: process.pid,
      createdAt: 1_000,
    }),
    { mode: 0o600 }
  )
}

export function verifyStartupTravel(days: Day[]) {
  const day = days.find((candidate) => candidate.id === 'qa-travel-day')
  assert(day)
  assert.equal(day.localDay, '2020-09-24')
  assert.equal(day.startedAt, Date.parse('2020-09-23T22:00:00Z'))
  assert.equal(days.filter((candidate) => candidate.localDay === day.localDay).length, 1)
  assert.equal(day.memory?.conversations.filter((item) => item.externalId === 'qa-travel-meeting').length, 1)
  assert(!days.some((candidate) => candidate.id === 'revinote:2020-09-24'))
  return day
}
