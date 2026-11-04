import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ConversationSummary, Day } from '@remember/shared'
import { conversationsConversationHref, dayConversationHref, daySectionHref, daysForDaySwitcher } from './dayNavigation'

function day(id: string, startedAt: number): Day {
  return {
    id,
    startedAt,
    endedAt: startedAt + 60_000,
    activeDurationMs: 60_000,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  }
}

describe('day switcher navigation', () => {
  it('shows one entry per local date and keeps the currently open duplicate', () => {
    const current = day('current', new Date(2026, 7, 9, 8).getTime())
    const duplicate = day('newer duplicate', new Date(2026, 7, 9, 9).getTime())
    const previous = day('previous', new Date(2026, 7, 8, 14).getTime())

    assert.deepEqual(
      daysForDaySwitcher([previous, current, duplicate], current).map((candidate) => candidate.id),
      ['current', 'previous']
    )
  })

  it('uses the newest stored day when a duplicated date is not currently open', () => {
    const current = day('current', new Date(2026, 7, 9, 8).getTime())
    const olderDuplicate = day('older duplicate', new Date(2026, 7, 8, 8).getTime())
    const newerDuplicate = day('newer duplicate', new Date(2026, 7, 8, 9).getTime())

    assert.deepEqual(
      daysForDaySwitcher([olderDuplicate, current, newerDuplicate], current).map((candidate) => candidate.id),
      ['current', 'newer duplicate']
    )
  })
})

describe('route-owned day views', () => {
  const now = new Date(2026, 7, 6, 9).getTime()
  const today = day('today', new Date(2026, 7, 6, 8).getTime())
  const historical = day('stored / day', new Date(2026, 7, 5, 14).getTime())

  it('gives every current-day collection and detail a semantic route', () => {
    const conversation = {
      episodeId: 'episode / stable',
      startTime: '11:30',
      endTime: '12:00',
      title: 'Stable conversation',
      description: '',
    } satisfies ConversationSummary

    assert.equal(daySectionHref(today, 'day', now), '/day/')
    assert.equal(daySectionHref(today, 'conversations', now), '/day/conversations/')
    assert.equal(daySectionHref(today, 'timeline', now), '/day/timeline/')
    assert.equal(daySectionHref(today, 'knowledge', now), '/day/knowledge/')
    assert.equal(
      dayConversationHref(today, conversation, now),
      '/day/conversation/?conversation=episode%3Aepisode+%2F+stable'
    )
    assert.equal(
      conversationsConversationHref(today, conversation, now),
      '/conversations/conversation/?conversation=episode%3Aepisode+%2F+stable'
    )
  })

  it('keeps the selected historical day when crossing route boundaries', () => {
    assert.equal(daySectionHref(historical, 'conversations', now), '/day/conversations/?id=stored+%2F+day')
    assert.equal(daySectionHref(historical, 'knowledge', now), '/day/knowledge/?id=stored+%2F+day')
    assert.equal(
      dayConversationHref(historical, '14:05', now),
      '/day/conversation/?id=stored+%2F+day&conversation=14%3A05'
    )
    assert.equal(
      conversationsConversationHref(historical, '14:05', now),
      '/conversations/conversation/?id=stored+%2F+day&conversation=14%3A05'
    )
  })
})
