import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ConversationSummary, Day } from '@remember/shared'
import { revinoteTranscriptTurns, transcriptForConversation } from '../conversationTranscript'

describe('manual recording transcript boundaries', () => {
  const startedAt = new Date(2026, 9, 21, 14, 0, 10).getTime()
  const conversation: ConversationSummary = {
    manualMeetingId: 'short-recording',
    title: 'Short recording',
    description: '',
    startTime: '14:00',
    endTime: '14:00',
    recordingSource: {
      startedAt,
      endedAt: startedAt + 20_000,
      segments: [
        {
          id: 'exact-speech',
          source: 'system',
          startedAt: startedAt + 2_000,
          endedAt: startedAt + 5_000,
          text: 'Alleen dit gesprek.',
        },
      ],
    },
  }
  const day: Pick<Day, 'startedAt' | 'moments'> = {
    startedAt,
    moments: [
      {
        id: 'whole-minute-chunk',
        sessionId: 'day-1',
        source: 'system',
        startedAt: startedAt - 10_000,
        durationMs: 60_000,
        status: 'ready',
        transcript: 'Vorig gesprek. Alleen dit gesprek. Volgend gesprek.',
      },
    ],
  }

  it('shows speech from a sub-minute recording without including neighboring chunk text', () => {
    assert.deepEqual(transcriptForConversation(day, conversation), [
      { id: 'exact-speech', label: 'Systeemaudio', text: 'Alleen dit gesprek.' },
    ])
  })

  it('does not substitute another conversation when a recording contains no accepted speech', () => {
    assert.deepEqual(
      transcriptForConversation(day, {
        ...conversation,
        recordingSource: { startedAt, endedAt: startedAt + 20_000, segments: [] },
      }),
      []
    )
  })

  it('retains the exact transcript after session serialization and restart', () => {
    assert.deepEqual(
      transcriptForConversation(JSON.parse(JSON.stringify(day)), JSON.parse(JSON.stringify(conversation))),
      transcriptForConversation(day, conversation)
    )
  })
})

describe('Revinote transcript presentation', () => {
  it('uses the imported conversation identity instead of neighboring audio in the same minute', () => {
    const startedAt = new Date(2026, 9, 21, 14, 0, 10).getTime()
    const moment = {
      sessionId: 'day-1',
      source: 'revinote' as const,
      startedAt,
      durationMs: 60_000,
      status: 'ready' as const,
    }
    assert.deepEqual(
      transcriptForConversation(
        {
          startedAt,
          moments: [
            { ...moment, id: 'revinote:other', transcript: 'Unrelated conversation.' },
            { ...moment, id: 'revinote:requested', transcript: '[Jan]: Dit gesprek.' },
          ],
        },
        {
          title: 'Imported',
          description: '',
          source: 'revinote',
          externalId: 'requested',
          startTime: '14:00',
          endTime: '14:00',
        }
      ),
      [{ id: 'revinote:requested:0', label: 'Jan', text: 'Dit gesprek.' }]
    )
  })

  it('turns bracketed speakers into regular transcript labels', () => {
    assert.deepEqual(revinoteTranscriptTurns('[Ada]: Laten we dit koppelen.\n\n[Jan]: Ik werk het uit.'), [
      { label: 'Ada', text: 'Laten we dit koppelen.' },
      { label: 'Jan', text: 'Ik werk het uit.' },
    ])
  })

  it('keeps text before the first speaker and multiline turns', () => {
    assert.deepEqual(revinoteTranscriptTurns('Introductie\n\n[Ada]: Eerste regel.\nTweede regel.'), [
      { label: null, text: 'Introductie' },
      { label: 'Ada', text: 'Eerste regel.\nTweede regel.' },
    ])
  })

  it('leaves an unstructured transcript as one unlabeled block', () => {
    assert.deepEqual(revinoteTranscriptTurns('Een transcript zonder sprekerlabels.'), [
      { label: null, text: 'Een transcript zonder sprekerlabels.' },
    ])
  })
})
