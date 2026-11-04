import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { DailyReviewSession } from '@remember/shared'
import { memoryWithManualMeetingConversation } from '../dailyReview/manualMeetingLifecycle'
import type { ImportedRevinoteMeeting } from '../revinoteIntegration'
import { mergeRevinoteMeetings, suppressLocalConversationsCoveredByRevinote } from '../revinoteMeetings'

const meeting = (overrides: Partial<ImportedRevinoteMeeting> = {}): ImportedRevinoteMeeting => ({
  id: 'meeting-1',
  title: 'Mobiele klantmeeting',
  status: 'finished',
  date: '2026-08-22T12:30:00.000Z',
  updatedAt: '2026-08-22T12:35:00.000Z',
  participants: ['Ada'],
  summary: 'We kozen voor de lokale integratie.',
  actionItems: [{ label: 'Werk de integratie uit', done: false }],
  durationSeconds: 1800,
  transcript: 'Ada: Laten we dit koppelen.\nJan: Ik werk de integratie uit.',
  ...overrides,
})

describe('Revinote meeting merge', () => {
  it('keeps a removed completed Revinote recording hidden through local recovery and repeated sync', () => {
    const [day] = mergeRevinoteMeetings([], [meeting()])
    assert(day?.memory)
    const recorded = {
      id: 'manual-recording',
      workdayId: day.id,
      episodeId: 'local-episode',
      title: 'Original recording',
      notes: 'Retained notes',
      startedAt: day.startedAt + 60_000,
      endedAt: day.startedAt + 120_000,
      pausedAt: null,
      pausedMs: 0,
      status: 'completed' as const,
      automaticRevinoteProcessingBlocked: false,
    }
    day.memory = memoryWithManualMeetingConversation(day, recorded)
    const windows = new Map([
      [
        'meeting-1',
        {
          workdayId: day.id,
          episodeId: recorded.episodeId,
          startedAt: recorded.startedAt,
          endedAt: recorded.endedAt,
          settledAt: recorded.endedAt + 60_000,
        },
      ],
    ])
    const [removed] = mergeRevinoteMeetings([day], [], windows)
    assert(removed?.memory)
    assert.deepEqual(removed.memory.conversations, [])
    assert.equal(removed.moments.length, 0)
    const restarted = JSON.parse(JSON.stringify(removed))
    restarted.memory = memoryWithManualMeetingConversation(restarted, recorded)
    assert.deepEqual(restarted.memory.conversations, [])
    const [synced] = mergeRevinoteMeetings([restarted], [meeting()], windows)
    assert.deepEqual(synced?.memory?.conversations, [])
    assert.deepEqual(synced?.moments, [])
  })

  it('retains a local recording while its first Revinote result is pending', () => {
    const [day] = mergeRevinoteMeetings([], [meeting()])
    assert(day?.memory)
    day.id = 'local-day'
    day.memory.conversations = [
      {
        startTime: '10:00',
        endTime: '10:01',
        title: 'Pending',
        description: '',
        summary: '',
        actionPoints: [],
        episodeId: 'pending-episode',
      },
    ]
    const [pending] = mergeRevinoteMeetings(
      [day],
      [],
      new Map([
        [
          'meeting-1',
          {
            workdayId: day.id,
            episodeId: 'pending-episode',
            startedAt: day.startedAt,
            endedAt: day.startedAt + 60_000,
          },
        ],
      ])
    )
    assert.equal(pending?.memory?.conversations.length, 1)
    assert.deepEqual(pending?.memory?.deletedConversationWindows, [])
  })

  it('retains unchanged days during repeated syncs while applying updates and removals', () => {
    const first = meeting()
    const second = meeting({ id: 'meeting-2', date: '2026-08-23T12:30:00.000Z' })
    const initial = mergeRevinoteMeetings([], [first, second])
    const repeated = mergeRevinoteMeetings(initial, [first, second])
    for (const day of repeated)
      assert.equal(
        day,
        initial.find((previous) => previous.id === day.id)
      )

    const updated = mergeRevinoteMeetings(repeated, [
      { ...first, title: 'Changed title', actionItems: [{ label: 'Updated action', done: true }] },
      second,
    ])
    const changedDay = updated.find((day) => day.memory?.conversations.some((item) => item.externalId === first.id))
    const unchangedDay = updated.find((day) => day.memory?.conversations.some((item) => item.externalId === second.id))
    assert.ok(changedDay)
    assert.notEqual(
      changedDay,
      repeated.find((day) => day.id === changedDay.id)
    )
    assert.equal(changedDay.memory?.conversations[0]?.title, 'Changed title')
    assert.equal(changedDay.memory?.conversations[0]?.actionPointItems?.[0]?.completed, true)
    assert.equal(
      unchangedDay,
      repeated.find((day) => day.id === unchangedDay?.id)
    )

    const removed = mergeRevinoteMeetings(updated, [second])
    assert.deepEqual(removed, [unchangedDay])
    assert.equal(removed[0], unchangedDay)
  })

  it('keeps an imported meeting on its original Day with unchanged timestamps after travel', () => {
    const previousTimezone = process.env.TZ
    try {
      process.env.TZ = 'Europe/Amsterdam'
      const imported = meeting({ date: '2026-09-24T05:00:00Z' })
      const first = mergeRevinoteMeetings([], [imported])
      const original = first[0]
      assert.ok(original)
      process.env.TZ = 'America/Los_Angeles'
      const second = mergeRevinoteMeetings(first, [imported])
      assert.equal(second.length, 1)
      assert.equal(second[0]?.id, original.id)
      assert.equal(second[0]?.localDay, '2026-09-24')
      assert.deepEqual(second[0]?.moments, original.moments)
      assert.deepEqual(second[0]?.memory?.conversations, original.memory?.conversations)
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ
      else process.env.TZ = previousTimezone
    }
  })

  it('keeps a post-processed meeting with its source workday after travel', () => {
    const previousTimezone = process.env.TZ
    try {
      process.env.TZ = 'Europe/Amsterdam'
      const imported = meeting({ date: '2026-09-24T05:00:00Z' })
      const first = mergeRevinoteMeetings([], [imported])
      const original = first[0]
      assert.ok(original)
      process.env.TZ = 'America/Los_Angeles'
      const second = mergeRevinoteMeetings(
        first,
        [imported],
        new Map([
          [
            imported.id,
            {
              workdayId: original.id,
              episodeId: 'recorded-episode',
              startedAt: Date.parse('2026-09-24T04:30:00Z'),
              endedAt: Date.parse('2026-09-24T05:00:00Z'),
            },
          ],
        ])
      )
      assert.equal(second.length, 1)
      assert.equal(second[0]?.id, original.id)
      assert.equal(second[0]?.memory?.conversations[0]?.episodeId, 'recorded-episode')
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ
      else process.env.TZ = previousTimezone
    }
  })

  it('creates a Day for a meeting recorded while the Mac was away', () => {
    const [day] = mergeRevinoteMeetings([], [meeting()])

    assert.ok(day)
    assert.equal(day.id.startsWith('revinote:'), true)
    assert.equal(day.memory?.conversations[0]?.source, 'revinote')
    assert.equal(day.memory?.conversations[0]?.externalId, 'meeting-1')
    assert.equal(day.moments[0]?.source, 'revinote')
    assert.match(day.moments[0]?.transcript ?? '', /Ada:/)
  })

  it('removes a server-deleted meeting from the authoritative local snapshot', () => {
    const imported = mergeRevinoteMeetings([], [meeting()])

    assert.deepEqual(mergeRevinoteMeetings(imported, []), [])
  })

  it('updates an imported meeting idempotently', () => {
    const first = mergeRevinoteMeetings([], [meeting()])
    const conversation = first[0]?.memory?.conversations[0]
    assert.ok(conversation)

    const second = mergeRevinoteMeetings(first, [meeting({ summary: 'De bijgewerkte samenvatting.' })])
    const imported = second[0]?.memory?.conversations.filter((candidate) => candidate.externalId === 'meeting-1') ?? []

    assert.equal(imported.length, 1)
    assert.equal(imported[0]?.summary, 'De bijgewerkte samenvatting.')
    assert.equal(second[0]?.moments.filter((moment) => moment.source === 'revinote').length, 1)
  })

  it('uses and reapplies the exact local source window for a meeting sent from Remember', () => {
    const startedAt = new Date(2026, 7, 27, 11, 40, 40).getTime()
    const endedAt = new Date(2026, 7, 27, 13, 15, 56).getTime()
    const imported = meeting({
      id: 'post-processed-meeting',
      date: new Date(startedAt).toISOString(),
      durationSeconds: (endedAt - startedAt) / 1_000,
    })
    const stale = mergeRevinoteMeetings([], [imported])
    assert.equal(stale[0]?.memory?.conversations[0]?.startTime, '10:05')
    assert.equal(stale[0]?.memory?.conversations[0]?.endTime, '11:40')

    const corrected = mergeRevinoteMeetings(
      stale,
      [imported],
      new Map([['post-processed-meeting', { startedAt, endedAt }]])
    )
    assert.equal(corrected[0]?.memory?.conversations[0]?.startTime, '11:40')
    assert.equal(corrected[0]?.memory?.conversations[0]?.endTime, '13:15')
  })

  it('keeps Revinote action identity and completion on the imported conversation', () => {
    const [day] = mergeRevinoteMeetings(
      [],
      [meeting({ actionItems: [{ label: 'Werk de integratie uit', done: true }] })],
      new Map([
        [
          'meeting-1',
          {
            episodeId: 'source-episode',
            startedAt: new Date(2026, 7, 22, 12).getTime(),
            endedAt: new Date(2026, 7, 22, 12, 30).getTime(),
          },
        ],
      ])
    )
    const conversation = day?.memory?.conversations[0]

    assert.equal(conversation?.episodeId, 'source-episode')
    assert.deepEqual(conversation?.actionPointItems, [
      { id: 'revinote:meeting-1:action:0', text: 'Werk de integratie uit', completed: true },
    ])

    const [restarted] = mergeRevinoteMeetings([day], [meeting()])
    assert.equal(restarted?.memory?.conversations[0]?.episodeId, 'source-episode')
  })

  it('keeps the manual recording link when Revinote replaces it and syncs again after restart', () => {
    const imported = meeting()
    const [local] = mergeRevinoteMeetings([], [imported])
    assert.ok(local?.memory)
    const original = local.memory.conversations[0]
    local.memory.conversations = [
      {
        startTime: original.startTime,
        endTime: original.endTime,
        title: 'Local recording',
        description: '',
        episodeId: 'recorded-episode',
        manualMeetingId: 'manual-recording',
        notes: 'Final recording notes',
        recordingSource: { startedAt: 1000, endedAt: 2000, segments: [] },
      },
      {
        startTime: original.startTime,
        endTime: original.endTime,
        title: 'Another recording at the same time',
        description: '',
        episodeId: 'other-episode',
        manualMeetingId: 'other-recording',
      },
    ]
    const sourceWindows = new Map([
      [
        imported.id,
        {
          workdayId: local.id,
          episodeId: 'recorded-episode',
          startedAt: Date.parse(imported.date) - 30 * 60_000,
          endedAt: Date.parse(imported.date),
        },
      ],
    ])

    const first = mergeRevinoteMeetings([local], [imported], sourceWindows)
    const refreshed = mergeRevinoteMeetings(first, [meeting({ summary: 'Updated remotely.' })], sourceWindows)
    const restarted = mergeRevinoteMeetings(JSON.parse(JSON.stringify(refreshed)), [imported])

    for (const snapshot of [first, refreshed, restarted]) {
      const conversations = snapshot[0]?.memory?.conversations ?? []
      const linked = conversations.filter((conversation) => conversation.manualMeetingId === 'manual-recording')
      assert.equal(linked.length, 1)
      assert.equal(linked[0]?.episodeId, 'recorded-episode')
      assert.equal(linked[0]?.externalId, imported.id)
      assert.equal(linked[0]?.source, 'revinote')
      assert.equal(linked[0]?.notes, 'Final recording notes')
      assert.deepEqual(linked[0]?.recordingSource, { startedAt: 1000, endedAt: 2000, segments: [] })
      assert.equal(
        conversations.find((conversation) => conversation.manualMeetingId === 'other-recording')?.episodeId,
        'other-episode'
      )
    }
    assert.equal(
      refreshed[0]?.memory?.conversations.find((conversation) => conversation.externalId === imported.id)?.summary,
      'Updated remotely.'
    )
  })

  it('keeps a deleted post-processed conversation hidden after its Revinote alias is imported', () => {
    const startedAt = new Date(2026, 7, 27, 11, 40).getTime()
    const endedAt = new Date(2026, 7, 27, 13, 15).getTime()
    const sourceEpisodeId = 'local-episode'
    const existing: DailyReviewSession = {
      id: 'local-day',
      startedAt,
      endedAt,
      activeDurationMs: endedAt - startedAt,
      moments: [],
      appActivity: [],
      contextMoments: [],
      memory: {
        summary: '',
        currentFocus: null,
        outcomes: [],
        decisions: [],
        openLoops: [],
        conversations: [],
        deletedConversationWindows: [{ episodeId: sourceEpisodeId, startTime: '11:40', endTime: '13:15' }],
        timeline: [],
        knowledgeSuggestions: [],
        refreshedAt: endedAt,
        coveredThrough: endedAt,
      },
      refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
    }
    const imported = meeting({ id: 'post-processed-meeting' })
    const linked = mergeRevinoteMeetings(
      [existing],
      [imported],
      new Map([['post-processed-meeting', { episodeId: sourceEpisodeId, startedAt, endedAt }]])
    )

    assert.deepEqual(linked[0]?.memory?.conversations, [])
    assert.equal(linked[0]?.memory?.deletedConversationWindows?.[0]?.externalId, 'post-processed-meeting')

    const restarted = mergeRevinoteMeetings(linked, [imported])
    assert.deepEqual(restarted[0]?.memory?.conversations, [])
  })

  it('merges into an existing local Day without replacing captured conversations', () => {
    const startedAt = new Date('2026-08-22T08:00:00.000Z').getTime()
    const existing: DailyReviewSession = {
      id: 'local-day',
      startedAt,
      endedAt: startedAt + 60_000,
      activeDurationMs: 60_000,
      moments: [],
      appActivity: [],
      contextMoments: [],
      memory: {
        summary: 'Lokale dag',
        currentFocus: null,
        outcomes: [],
        decisions: [],
        openLoops: [],
        conversations: [{ startTime: '10:00', endTime: '10:30', title: 'Lokaal', description: 'Lokaal' }],
        timeline: [],
        knowledgeSuggestions: [],
        refreshedAt: startedAt,
        coveredThrough: startedAt,
      },
      refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
    }

    const [day] = mergeRevinoteMeetings([existing], [meeting()])

    assert.equal(day?.id, 'local-day')
    assert.equal(
      day?.memory?.conversations.some((conversation) => conversation.title === 'Lokaal'),
      true
    )
    assert.equal(
      day?.memory?.conversations.some((conversation) => conversation.source === 'revinote'),
      true
    )
  })

  it('replaces overlapping local fragments with the canonical Revinote meeting', () => {
    const startedAt = new Date(2026, 7, 22, 8).getTime()
    const meetingEndedAt = new Date(2026, 7, 22, 14, 30).getTime()
    const existing: DailyReviewSession = {
      id: 'local-day',
      startedAt,
      endedAt: meetingEndedAt,
      activeDurationMs: 60_000,
      moments: [],
      appActivity: [],
      contextMoments: [],
      memory: {
        summary: 'Lokale dag',
        currentFocus: null,
        outcomes: [],
        decisions: [],
        openLoops: [],
        conversations: [
          { startTime: '13:00', endTime: '13:30', title: 'Eerder gesprek', description: 'Blijft staan' },
          { startTime: '14:00', endTime: '14:10', title: 'Fragment een', description: 'Dubbel' },
          { startTime: '14:09', endTime: '14:25', title: 'Fragment twee', description: 'Dubbel' },
        ],
        timeline: [],
        knowledgeSuggestions: [],
        refreshedAt: startedAt,
        coveredThrough: meetingEndedAt,
      },
      refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
    }

    const [day] = mergeRevinoteMeetings(
      [existing],
      [meeting({ date: new Date(meetingEndedAt).toISOString(), durationSeconds: 30 * 60 })]
    )

    assert.deepEqual(
      day?.memory?.conversations.map((conversation) => conversation.title),
      ['Eerder gesprek', 'Mobiele klantmeeting']
    )
  })

  it('also suppresses overlapping episode summaries on a later Day refresh', () => {
    const dayStartedAt = new Date(2026, 7, 22, 8).getTime()
    const conversations = suppressLocalConversationsCoveredByRevinote(dayStartedAt, [
      {
        startTime: '14:00',
        endTime: '15:30',
        title: 'Hele meeting',
        description: 'Revinote',
        source: 'revinote',
        externalId: 'meeting-1',
      },
      { startTime: '14:20', endTime: '14:35', title: 'Lokaal fragment', description: 'Dubbel' },
      { startTime: '15:40', endTime: '15:50', title: 'Later gesprek', description: 'Blijft staan' },
    ])

    assert.deepEqual(
      conversations.map((conversation) => conversation.title),
      ['Hele meeting', 'Later gesprek']
    )
  })

  it('replaces only the submitted episode when another explicit selection overlaps it', () => {
    const local = {
      episodeId: 'first',
      startTime: '10:20',
      endTime: '10:33',
      title: 'First',
      description: '',
    }
    const imported = { ...local, source: 'revinote' as const, externalId: 'meeting-first' }
    for (const processing of ['processing', undefined] as const) {
      const second = { ...local, episodeId: 'second', startTime: '10:19', endTime: '12:27', processing }
      assert.deepEqual(
        suppressLocalConversationsCoveredByRevinote(new Date(2026, 8, 10, 8).getTime(), [local, second, imported]),
        [second, imported]
      )
    }
  })

  it('absorbs a rounded fragment chain at the edges of a long imported meeting', () => {
    const dayStartedAt = new Date(2026, 7, 22, 8).getTime()
    const conversations = suppressLocalConversationsCoveredByRevinote(dayStartedAt, [
      { startTime: '14:56', endTime: '15:03', title: 'Fragment 1', description: 'Dubbel' },
      { startTime: '15:03', endTime: '15:05', title: 'Fragment 2', description: 'Dubbel' },
      { startTime: '15:05', endTime: '15:08', title: 'Fragment 3', description: 'Dubbel' },
      {
        startTime: '15:08',
        endTime: '16:26',
        title: 'Hele meeting',
        description: 'Revinote',
        source: 'revinote',
        externalId: 'meeting-1',
      },
      { startTime: '16:24', endTime: '16:28', title: 'Fragment 4', description: 'Dubbel' },
      { startTime: '16:28', endTime: '16:30', title: 'Fragment 5', description: 'Dubbel' },
    ])

    assert.deepEqual(
      conversations.map((conversation) => conversation.title),
      ['Hele meeting']
    )
  })
})
