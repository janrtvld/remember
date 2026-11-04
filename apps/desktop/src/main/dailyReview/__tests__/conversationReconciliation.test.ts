import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  type ConversationSummary,
  conversationReference,
  type DailyReviewMoment,
  resolveConversationReference,
} from '@remember/shared'
import {
  conversationSummaryFromAnalysis,
  conversationWindowForTimestamps,
  deleteDayMemoryConversation,
  reconcileAdjacentConversations,
  reconcileEpisodeConversationSummaries,
  reconcileLivingConversations,
} from '../conversationReconciliation'

const dayStartedAt = new Date(2026, 7, 11, 7).getTime()

function at(time: string) {
  const [hours, minutes, seconds = 0] = time.split(':').map(Number)
  const date = new Date(dayStartedAt)
  date.setHours(hours, minutes, seconds, 0)
  return date.getTime()
}

function conversation(startTime: string, endTime: string, title: string): ConversationSummary {
  return {
    startTime,
    endTime,
    title,
    description: `${title} preview.`,
    summary: `${title} summary.`,
    actionPoints: [`Follow up ${title}`],
  }
}

function speech(startedAt: number, durationMs: number, transcript = 'Continuous room discussion.'): DailyReviewMoment {
  return {
    id: String(startedAt),
    sessionId: 'day',
    source: 'microphone',
    startedAt,
    durationMs,
    status: 'ready',
    transcript,
  }
}

describe('conversation reconciliation', () => {
  for (const processingProvider of ['revinote', undefined] as const) {
    it(`retains a ${processingProvider ? 'retryable' : 'terminal'} Revinote failure across Day refresh`, () => {
      const failed: ConversationSummary = {
        ...conversation('10:00', '10:37', 'Recorded conversation'),
        episodeId: 'failed-episode',
        processingProvider,
        processingError: 'revinote',
      }
      const later = { ...conversation('11:00', '11:30', 'Later conversation'), episodeId: 'later-episode' }

      assert.deepEqual(reconcileEpisodeConversationSummaries(dayStartedAt, [failed], [later]), [failed, later])
      assert.deepEqual(
        reconcileLivingConversations(dayStartedAt, [failed], [], [], [], at('12:00'), [
          { startTime: '10:00', endTime: '10:37' },
        ]),
        [failed]
      )

      const refreshed = {
        ...failed,
        title: 'New local summary',
        processing: 'processing' as const,
        processingProvider: 'revinote' as const,
        processingError: undefined,
      }
      const expected = [{ ...refreshed, processing: undefined, processingProvider, processingError: 'revinote' }]
      assert.deepEqual(reconcileEpisodeConversationSummaries(dayStartedAt, [failed], [refreshed]), expected)
      assert.deepEqual(reconcileLivingConversations(dayStartedAt, [failed], [refreshed], []), expected)

      const deleted = [{ episodeId: failed.episodeId, startTime: failed.startTime, endTime: failed.endTime }]
      assert.deepEqual(reconcileEpisodeConversationSummaries(dayStartedAt, [failed], [later], deleted), [later])
      assert.deepEqual(reconcileLivingConversations(dayStartedAt, [failed], [], [], deleted), [])
    })
  }

  it('replaces failed local processing with a completed Revinote import without retaining the error', () => {
    const failed: ConversationSummary = {
      ...conversation('10:00', '10:37', 'Recorded conversation'),
      episodeId: 'failed-episode',
      processingProvider: 'revinote',
      processingError: 'revinote',
    }
    const imported: ConversationSummary = {
      ...conversation('10:00', '10:37', 'Processed conversation'),
      episodeId: 'failed-episode',
      externalId: 'remote-meeting',
      source: 'revinote',
    }

    assert.deepEqual(reconcileEpisodeConversationSummaries(dayStartedAt, [failed], [imported]), [imported])
    assert.deepEqual(reconcileLivingConversations(dayStartedAt, [failed], [imported], []), [imported])
  })

  it('keeps a successful upload when a Day refresh started before its retry completed', () => {
    const uploaded: ConversationSummary = {
      ...conversation('10:00', '10:37', 'Recorded conversation'),
      episodeId: 'retried-episode',
      externalId: 'remote-meeting',
      processing: 'processing',
      processingProvider: 'revinote',
    }
    const staleFailure: ConversationSummary = {
      ...uploaded,
      externalId: undefined,
      processing: undefined,
      processingError: 'revinote',
    }
    const expected = [{ ...uploaded, processingError: undefined }]

    assert.deepEqual(reconcileEpisodeConversationSummaries(dayStartedAt, [uploaded], [staleFailure]), expected)
    assert.deepEqual(reconcileLivingConversations(dayStartedAt, [uploaded], [staleFailure], []), expected)
  })

  it('retains failed analysis until a successful summary for the same episode arrives', () => {
    const failed: ConversationSummary = {
      ...conversation('10:00', '10:37', 'Recorded conversation'),
      episodeId: 'failed-episode',
      processingError: 'analysis',
    }
    const otherEpisode = { ...conversation('10:00', '10:37', 'Another recording'), episodeId: 'other-episode' }
    const completed = { ...conversation('10:00', '10:37', 'Processed conversation'), episodeId: failed.episodeId }

    assert.deepEqual(reconcileEpisodeConversationSummaries(dayStartedAt, [failed], [otherEpisode]), [
      failed,
      otherEpisode,
    ])
    assert.deepEqual(reconcileLivingConversations(dayStartedAt, [failed], [otherEpisode], []), [failed, otherEpisode])
    assert.deepEqual(reconcileEpisodeConversationSummaries(dayStartedAt, [failed], [completed]), [completed])
    assert.deepEqual(reconcileLivingConversations(dayStartedAt, [failed], [completed], []), [completed])
  })

  it('keeps a pending selection when an older refresh has no episode summaries and rejects its time window', () => {
    const pending: ConversationSummary = {
      ...conversation('10:19', '12:27', 'Selection'),
      episodeId: 'selection',
      processing: 'processing',
    }
    assert.deepEqual(
      reconcileLivingConversations(dayStartedAt, [pending], [], [], [], at('13:20'), [
        { startTime: '10:19', endTime: '12:27' },
      ]),
      [pending]
    )
    assert.deepEqual(
      reconcileLivingConversations(
        dayStartedAt,
        [pending],
        [],
        [],
        [{ episodeId: 'selection', startTime: '10:19', endTime: '12:27' }]
      ),
      []
    )
  })

  it('turns a qualified episode analysis into a Day conversation without reinterpretation', () => {
    assert.deepEqual(
      conversationSummaryFromAnalysis(dayStartedAt, {
        id: 'analysis-1',
        episodeId: 'episode-1',
        workdayId: 'day-1',
        startedAt: at('14:54:29'),
        endedAt: at('14:58:29'),
        title: 'Trip planning',
        description: 'Discussed the trip dates.',
        summary: 'The trip runs from September 25 through October 11.',
        actionPoints: ['Confirm the hotel.'],
        sourceHash: 'hash',
        provider: 'codex',
        model: 'gpt-5.6-terra',
        promptVersion: 3,
        schemaVersion: 1,
        generatedAt: at('15:00:00'),
        classification: 'conversation',
        confidence: 'high',
        reason: 'Reciprocal exchange.',
      }),
      {
        episodeId: 'episode-1',
        id: 'analysis-1',
        startTime: '14:54',
        endTime: '14:59',
        title: 'Trip planning',
        description: 'Discussed the trip dates.',
        summary: 'The trip runs from September 25 through October 11.',
        actionPoints: ['Confirm the hotel.'],
        actionPointItems: [{ id: 'episode:episode-1:action:0', text: 'Confirm the hotel.' }],
      }
    )
  })

  it('merges adjacent model segments when transcript evidence bridges the gap', () => {
    const merged = reconcileAdjacentConversations(
      dayStartedAt,
      [
        conversation('12:37', '12:42', 'Bouw- en woonplan'),
        conversation('12:44', '12:49', 'Mogelijke woningplaatsing op G 331'),
      ],
      [speech(at('12:41:30'), 45_000), speech(at('12:42:30'), 45_000), speech(at('12:43:30'), 45_000)]
    )

    assert.equal(merged.length, 1)
    assert.equal(merged[0]?.startTime, '12:37')
    assert.equal(merged[0]?.endTime, '12:49')
    assert.equal(merged[0]?.title, 'Mogelijke woningplaatsing op G 331')
    assert.deepEqual(merged[0]?.actionPoints, [
      'Follow up Bouw- en woonplan',
      'Follow up Mogelijke woningplaatsing op G 331',
    ])
  })

  it('keeps nearby conversations separate without speech across the gap', () => {
    const conversations = [conversation('10:00', '10:15', 'Stand-up'), conversation('10:17', '10:30', 'Customer call')]
    assert.deepEqual(reconcileAdjacentConversations(dayStartedAt, conversations, []), conversations)
  })

  it('keeps conversations separate when the gap is longer than two minutes', () => {
    const conversations = [conversation('10:00', '10:15', 'Stand-up'), conversation('10:18', '10:30', 'Customer call')]
    assert.equal(
      reconcileAdjacentConversations(dayStartedAt, conversations, [speech(at('10:14:30'), 4 * 60_000)]).length,
      2
    )
  })

  it('keeps nearby conversations separate when speech does not continue across the pause', () => {
    const conversations = [conversation('10:00', '10:15', 'Stand-up'), conversation('10:17', '10:30', 'Customer call')]
    assert.equal(
      reconcileAdjacentConversations(dayStartedAt, conversations, [
        speech(at('10:14:30'), 20_000),
        speech(at('10:16:50'), 20_000),
      ]).length,
      2
    )
  })

  it('does not merge conversations across a rejected media window', () => {
    const conversations = [conversation('10:00', '10:15', 'Stand-up'), conversation('10:17', '10:30', 'Customer call')]
    const moments = [speech(at('10:14:30'), 3 * 60_000)]

    assert.equal(
      reconcileAdjacentConversations(dayStartedAt, conversations, moments, [{ startTime: '10:15', endTime: '10:17' }])
        .length,
      2
    )
  })

  it('preserves an earlier recognized conversation when a later refresh omits conversations', () => {
    const previous = [conversation('10:00', '10:30', 'Woub-teammeeting')]

    assert.deepEqual(reconcileLivingConversations(dayStartedAt, previous, [], []), previous)
  })

  it('removes a previous generated conversation when episode classification rejects its window', () => {
    const previous = [conversation('10:00', '10:30', 'Television dialogue')]
    const rejected = [{ startTime: '09:59', endTime: '10:31' }]

    assert.deepEqual(
      reconcileLivingConversations(
        dayStartedAt,
        previous,
        [conversation('10:00', '10:30', 'Still looks substantive')],
        [],
        [],
        Number.POSITIVE_INFINITY,
        rejected
      ),
      []
    )
  })

  it('keeps conversations outside an authoritative rejection window', () => {
    const previous = [
      conversation('09:30', '10:00', 'Real call'),
      conversation('10:00', '10:30', 'Television dialogue'),
    ]
    const rejected = [{ startTime: '10:00', endTime: '10:30' }]

    assert.deepEqual(
      reconcileLivingConversations(dayStartedAt, previous, [], [], [], Number.POSITIVE_INFINITY, rejected),
      [previous[0]]
    )
  })

  it('keeps a real conversation when a rejected media window only touches its rounded edge', () => {
    const previous = [conversation('09:30', '10:00', 'Real call')]
    const rejected = [{ startTime: '09:59', endTime: '10:30' }]

    assert.deepEqual(
      reconcileLivingConversations(dayStartedAt, previous, [], [], [], Number.POSITIVE_INFINITY, rejected),
      previous
    )
  })

  it('rounds rejected timestamp evidence outward to a usable conversation window', () => {
    assert.deepEqual(
      conversationWindowForTimestamps(dayStartedAt, {
        startedAt: at('10:00:45'),
        endedAt: at('10:01:10'),
      }),
      { startTime: '10:00', endTime: '10:02' }
    )
  })

  it('extends an omitted incremental continuation through uninterrupted transcript evidence', () => {
    const previous = [conversation('14:01', '14:15', 'Persoonlijk gesprek')]
    const moments = Array.from({ length: 14 }, (_, index) =>
      speech(at(`14:${String(14 + index).padStart(2, '0')}:27`), 60_000)
    )

    const reconciled = reconcileLivingConversations(dayStartedAt, previous, [], moments, [], at('14:28:30'))

    assert.equal(reconciled[0]?.startTime, '14:01')
    assert.equal(reconciled[0]?.endTime, '14:28')
    assert.equal(reconciled[0]?.summary, previous[0]?.summary)
  })

  it('does not extend a recognized conversation across a real transcript gap', () => {
    const previous = [conversation('10:00', '10:15', 'Stand-up')]
    const moments = [speech(at('10:14:30'), 60_000), speech(at('10:17:00'), 60_000)]

    assert.deepEqual(reconcileLivingConversations(dayStartedAt, previous, [], moments, [], at('10:18:00')), previous)
  })

  it('caps transcript-based extension at the next recognized conversation', () => {
    const previous = [conversation('10:00', '10:15', 'Stand-up'), conversation('10:20', '10:25', 'Customer call')]
    const moments = Array.from({ length: 16 }, (_, index) =>
      speech(at(`10:${String(14 + index).padStart(2, '0')}:30`), 60_000)
    )

    const reconciled = reconcileLivingConversations(dayStartedAt, previous, [], moments, [], at('10:30:30'))

    assert.equal(reconciled[0]?.endTime, '10:20')
    assert.equal(reconciled[1]?.endTime, '10:30')
  })

  it('caps transcript-based extension at a rejected media window', () => {
    const previous = [conversation('10:00', '10:15', 'Stand-up')]
    const moments = Array.from({ length: 12 }, (_, index) =>
      speech(at(`10:${String(14 + index).padStart(2, '0')}:30`), 60_000)
    )

    const reconciled = reconcileLivingConversations(dayStartedAt, previous, [], moments, [], at('10:26:00'), [
      { startTime: '10:18', endTime: '10:26' },
    ])

    assert.equal(reconciled[0]?.endTime, '10:18')
  })

  it('does not extend through a rejected window that overlaps the rounded conversation edge', () => {
    const previous = [conversation('10:00', '10:15', 'Stand-up')]
    const moments = Array.from({ length: 12 }, (_, index) =>
      speech(at(`10:${String(14 + index).padStart(2, '0')}:30`), 60_000)
    )

    const reconciled = reconcileLivingConversations(dayStartedAt, previous, [], moments, [], at('10:26:00'), [
      { startTime: '10:14', endTime: '10:26' },
    ])

    assert.equal(reconciled[0]?.endTime, '10:15')
  })

  it('uses a refreshed summary for the same time window without duplicating it', () => {
    const previous = [conversation('10:00', '10:30', 'Woub-teammeeting')]
    const refreshed = [conversation('09:59', '10:31', 'Woub-stand-up')]

    assert.deepEqual(reconcileLivingConversations(dayStartedAt, previous, refreshed, []), refreshed)
  })

  it('keeps an omitted earlier conversation alongside a newly recognized later conversation', () => {
    const previous = [conversation('10:00', '10:30', 'Woub-teammeeting')]
    const refreshed = [conversation('10:30', '11:59', 'Amerikareis met Tom')]

    assert.deepEqual(reconcileLivingConversations(dayStartedAt, previous, refreshed, []), [...previous, ...refreshed])
  })

  it('keeps a user-deleted conversation excluded after an overlapping refresh', () => {
    const deleted = conversation('10:00', '10:30', 'Woub-teammeeting')
    const memory = {
      summary: '',
      currentFocus: null,
      outcomes: [],
      decisions: [],
      openLoops: [],
      conversations: [deleted, conversation('11:00', '11:30', 'Planning')],
      timeline: [],
      knowledgeSuggestions: [],
      refreshedAt: dayStartedAt,
      coveredThrough: dayStartedAt,
    }
    const updated = deleteDayMemoryConversation(memory, deleted.startTime)
    const refreshed = [conversation('09:59', '10:31', 'Woub stand-up')]

    assert.deepEqual(
      updated.conversations.map((item) => item.title),
      ['Planning']
    )
    assert.deepEqual(updated.deletedConversationWindows, [{ startTime: '10:00', endTime: '10:30' }])
    assert.deepEqual(
      reconcileLivingConversations(
        dayStartedAt,
        updated.conversations,
        refreshed,
        [],
        updated.deletedConversationWindows
      ),
      updated.conversations
    )
  })

  it('mutates one colliding conversation by stable reference and rejects an ambiguous legacy time', () => {
    const first = { ...conversation('10:00', '10:30', 'First call'), episodeId: 'episode-first' }
    const second = { ...conversation('10:00', '10:30', 'Second call'), episodeId: 'episode-second' }
    const memory = {
      summary: '',
      currentFocus: null,
      outcomes: [],
      decisions: [],
      openLoops: [],
      conversations: [first, second],
      timeline: [],
      knowledgeSuggestions: [],
      refreshedAt: dayStartedAt,
      coveredThrough: dayStartedAt,
    }

    assert.throws(() => resolveConversationReference(memory.conversations, '10:00'), /ambiguous-conversation-reference/)

    const updated = deleteDayMemoryConversation(memory, conversationReference(second))
    assert.deepEqual(updated.conversations, [first])
    assert.deepEqual(updated.deletedConversationWindows, [
      { startTime: '10:00', endTime: '10:30', episodeId: 'episode-second' },
    ])
    assert.deepEqual(
      reconcileLivingConversations(
        dayStartedAt,
        updated.conversations,
        [first, second],
        [],
        updated.deletedConversationWindows
      ),
      [first]
    )
  })

  it('does not reinsert an episode deleted while its refresh was in flight', () => {
    const deleted = { ...conversation('10:00', '10:30', 'Deleted call'), episodeId: 'episode-deleted' }
    const retained = { ...conversation('11:00', '11:30', 'Retained call'), episodeId: 'episode-retained' }
    const memory = {
      summary: '',
      currentFocus: null,
      outcomes: [],
      decisions: [],
      openLoops: [],
      conversations: [deleted],
      timeline: [],
      knowledgeSuggestions: [],
      refreshedAt: dayStartedAt,
      coveredThrough: dayStartedAt,
    }
    const afterDeletion = deleteDayMemoryConversation(memory, conversationReference(deleted))

    assert.deepEqual(
      reconcileEpisodeConversationSummaries(
        dayStartedAt,
        afterDeletion.conversations,
        [deleted, retained],
        afterDeletion.deletedConversationWindows
      ),
      [retained]
    )
  })
})
