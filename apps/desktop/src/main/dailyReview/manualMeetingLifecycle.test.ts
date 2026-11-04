import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ConversationEpisode, Day, ManualMeeting, SpeechSegment } from '@remember/shared'
import { conversationReference } from '@remember/shared'
import { deleteDayMemoryConversation } from './conversationReconciliation'
import {
  MANUAL_MEETING_AUDIO_READY_TIMEOUT_MS,
  manualMeetingAudioReadinessError,
  manualMeetingAudioStreamsReady,
  manualMeetingAvailableFromAt,
  manualMeetingEpisode,
  manualMeetingForConversation,
  manualMeetingRecordingSource,
  manualMeetingStillProcessing,
  manualMeetingTitle,
  memoryWithFinishedManualMeetingConversation,
  memoryWithManualMeetingConversation,
  preserveManualMeetingConversations,
  selectManualMeetingProcessingProvider,
  waitForManualMeetingAudioReadiness,
} from './manualMeetingLifecycle'

function meeting(patch: Partial<ManualMeeting> = {}): ManualMeeting {
  return {
    id: 'meeting-1',
    workdayId: 'day-1',
    title: 'Design review',
    notes: 'Ship the local fallback.',
    startedAt: new Date(2026, 7, 31, 10, 2).getTime(),
    endedAt: new Date(2026, 7, 31, 10, 18).getTime(),
    pausedAt: null,
    pausedMs: 0,
    status: 'processing',
    automaticRevinoteProcessingBlocked: false,
    ...patch,
  }
}

function day(): Day {
  return {
    id: 'day-1',
    startedAt: new Date(2026, 7, 31, 9).getTime(),
    endedAt: null,
    activeDurationMs: 0,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  }
}

describe('manual meeting lifecycle', () => {
  for (const episodeId of [undefined, 'deleted-episode']) {
    it(`does not restore a deleted manual meeting, including after serialization (${episodeId})`, () => {
      const recorded = meeting({ episodeId })
      const original = memoryWithManualMeetingConversation(day(), recorded)
      const conversation = original.conversations[0]
      assert(conversation)
      const deleted = deleteDayMemoryConversation(original, conversationReference(conversation))
      const persisted = JSON.parse(JSON.stringify(deleted))
      const restored = memoryWithManualMeetingConversation({ ...day(), memory: persisted }, recorded)
      assert.deepEqual(restored, persisted)
      const other = meeting({ id: 'other', episodeId: 'other-episode', startedAt: recorded.startedAt + 60 * 60_000 })
      assert.equal(memoryWithManualMeetingConversation({ ...day(), memory: restored }, other).conversations.length, 1)
    })
  }

  it('starts a new recording at confirmation after the previous recording paused capture', () => {
    const previous = meeting({
      startedAt: 1792588274504,
      endedAt: 1792588364593,
      status: 'completed',
    })
    const confirmedAt = 1792588381917
    const startedAt = manualMeetingAvailableFromAt({
      confirmedAt,
      episodes: [manualMeetingEpisode(previous, [])],
      audioWasRunning: false,
    })
    assert.equal(startedAt, confirmedAt)
    const next = meeting({ id: 'meeting-next', startedAt, endedAt: 1792588393710 })
    const episode = manualMeetingEpisode(next, [manualMeetingEpisode(previous, [])])
    assert.equal(episode.startedAt, confirmedAt)
    assert.equal(episode.endedAt - episode.startedAt, 11_793)
  })

  it('never takes preroll from a previous manual recording while automatic capture continues', () => {
    const previous = meeting({ status: 'completed', endedAt: meeting().startedAt + 20_000 })
    const confirmedAt = (previous.endedAt ?? 0) + 10_000
    const manualEpisode = manualMeetingEpisode(previous, [])
    const olderAmbientEpisode: ConversationEpisode = {
      ...manualEpisode,
      id: 'older-ambient',
      startedAt: previous.startedAt - 5_000,
      endedAt: previous.startedAt,
      provider: null,
      surfaceKey: null,
    }
    assert.equal(
      manualMeetingAvailableFromAt({
        confirmedAt,
        episodes: [olderAmbientEpisode, manualEpisode],
        audioWasRunning: true,
      }),
      confirmedAt
    )
  })

  it('only retains recent ambient speech preroll when audio was already running', () => {
    const confirmedAt = new Date(2026, 9, 21, 14, 5).getTime()
    const ambient: ConversationEpisode = {
      id: 'ambient',
      workdayId: 'day-1',
      startedAt: confirmedAt - 120_000,
      endedAt: confirmedAt - 5_000,
      state: 'provisional',
      provider: null,
      surfaceKey: null,
      boundaryReason: 'open',
      segmentIds: ['speech-1'],
      deletedAt: null,
      automaticRevinoteProcessingBlocked: false,
    }
    assert.equal(
      manualMeetingAvailableFromAt({ confirmedAt, episodes: [ambient], audioWasRunning: true }),
      ambient.startedAt
    )
    assert.equal(
      manualMeetingAvailableFromAt({ confirmedAt, episodes: [ambient], audioWasRunning: false }),
      confirmedAt
    )
    assert.equal(
      manualMeetingAvailableFromAt({
        confirmedAt,
        episodes: [{ ...ambient, startedAt: confirmedAt - 120 * 60_000 }],
        audioWasRunning: true,
      }),
      confirmedAt - 60 * 60_000
    )
    for (const episode of [
      { ...ambient, endedAt: confirmedAt - 90_001 },
      { ...ambient, deletedAt: confirmedAt },
      { ...ambient, userDecision: 'dismissed' as const },
    ]) {
      assert.equal(
        manualMeetingAvailableFromAt({ confirmedAt, episodes: [episode], audioWasRunning: true }),
        confirmedAt
      )
    }
  })

  it('keeps the recording title through processing and supplies a dated fallback for older blank recordings', () => {
    const startedAt = new Date(2026, 9, 21, 14, 2, 10).getTime()
    const title = manualMeetingTitle(startedAt, 'en')
    const memory = memoryWithManualMeetingConversation(day(), meeting({ startedAt, title }))
    assert.equal(title, '21 October, 14:02')
    assert.equal(memory.conversations[0]?.title, title)
    assert.equal(memoryWithFinishedManualMeetingConversation(memory, 'meeting-1').conversations[0]?.title, title)
    assert.equal(
      memoryWithManualMeetingConversation(day(), meeting({ startedAt, title: ' ' })).conversations[0]?.title,
      manualMeetingTitle(startedAt)
    )
  })

  it('selects the exact recording identity when two recordings share a display minute', () => {
    const first = meeting({ id: 'first', episodeId: 'first-episode' })
    const second = meeting({ id: 'second', episodeId: 'second-episode', startedAt: first.startedAt + 10_000 })
    const conversation = memoryWithManualMeetingConversation(day(), second).conversations[0]
    assert.ok(conversation)
    assert.equal(manualMeetingForConversation(conversation, [first, second], []), second)
    assert.equal(
      manualMeetingForConversation({ ...conversation, manualMeetingId: undefined }, [first, second], []),
      second
    )
    assert.equal(
      manualMeetingForConversation({ ...conversation, manualMeetingId: 'deleted' }, [first, second], []),
      undefined
    )
    assert.equal(
      manualMeetingForConversation(
        { ...conversation, manualMeetingId: undefined, episodeId: undefined },
        [first, second],
        []
      ),
      undefined
    )
  })

  it('persists only accepted source segments fully inside the exact recording window', () => {
    const startedAt = new Date(2026, 9, 21, 14, 0, 10).getTime()
    const captured = meeting({ startedAt, endedAt: startedAt + 20_000, episodeId: 'manual-meeting-meeting-1' })
    const segment = (
      id: string,
      startOffset: number,
      endOffset: number,
      patch: Partial<SpeechSegment> = {}
    ): SpeechSegment => ({
      id,
      workdayId: 'day-1',
      chunkId: 'shared-minute-chunk',
      source: 'system',
      startedAt: startedAt + startOffset,
      endedAt: startedAt + endOffset,
      text: id,
      detectedLanguage: 'nl',
      acceptedLanguage: 'nl',
      rejectionReason: null,
      ...patch,
    })
    const segments = [
      segment('previous', -5_000, -1_000),
      segment('crosses-start', -1_000, 2_000),
      segment('inside', 2_000, 5_000),
      segment('another-episode', 6_000, 7_000),
      segment('empty', 8_000, 9_000, { text: '' }),
      segment('other-day', 10_000, 11_000, { workdayId: 'other' }),
      segment('crosses-end', 19_000, 22_000),
      segment('next', 23_000, 25_000),
    ]
    const episode = {
      ...manualMeetingEpisode(captured, []),
      segmentIds: segments.filter(({ id }) => id !== 'another-episode').map(({ id }) => id),
    }
    const source = manualMeetingRecordingSource(captured, episode, segments)
    assert.deepEqual(
      source.segments.map(({ id }) => id),
      ['inside']
    )
    assert.equal(source.startedAt, startedAt)
    assert.equal(source.endedAt, startedAt + 20_000)
    const memory = memoryWithManualMeetingConversation(day(), captured, 'remember', source)
    assert.deepEqual(JSON.parse(JSON.stringify(memory)).conversations[0].recordingSource, source)
    assert.deepEqual(manualMeetingRecordingSource(captured, undefined, segments).segments, [])
    const lateEpisode = manualMeetingEpisode(captured, [], false, [
      ...segments,
      segment('rejected', 12_000, 13_000, { rejectionReason: 'unsupported-language' }),
    ])
    assert.deepEqual(lateEpisode.segmentIds, ['inside', 'another-episode'])
    assert.deepEqual(
      manualMeetingEpisode(
        { ...captured, id: 'next', startedAt: startedAt + 22_000, endedAt: startedAt + 30_000 },
        [lateEpisode],
        false,
        segments
      ).segmentIds,
      ['next']
    )
  })

  it('finishes with an explicit audio or analysis failure while retaining notes and source evidence', () => {
    for (const error of ['audio', 'analysis'] as const) {
      const processing = memoryWithManualMeetingConversation(day(), meeting())
      const finished = memoryWithFinishedManualMeetingConversation(processing, 'meeting-1', error)
      assert.equal(finished.conversations[0]?.processingError, error)
      assert.equal(finished.conversations[0]?.processing, undefined)
      assert.equal(finished.conversations[0]?.notes, meeting().notes)
      assert.deepEqual(finished.conversations[0]?.recordingSource, processing.conversations[0]?.recordingSource)
      assert.equal(
        memoryWithFinishedManualMeetingConversation(finished, 'meeting-1').conversations[0]?.processingError,
        error
      )
    }
  })

  it('finishes recordings locally offline even when Revinote processing was selected', () => {
    assert.equal(
      selectManualMeetingProcessingProvider({
        automaticRevinoteProcessing: true,
        existing: 'revinote',
        offlineMode: true,
        automaticRevinoteProcessingBlocked: false,
      }),
      'remember'
    )
  })

  it('does not automatically send a meeting that finished offline after reconnecting', () => {
    assert.equal(
      selectManualMeetingProcessingProvider({
        automaticRevinoteProcessing: true,
        existing: undefined,
        offlineMode: false,
        automaticRevinoteProcessingBlocked: true,
      }),
      'remember'
    )
  })

  it('starts when the microphone stream reports ready', () => {
    assert.equal(manualMeetingAudioStreamsReady(null, false), false)
    assert.equal(manualMeetingAudioStreamsReady('MacBook Microphone', false), true)
    assert.equal(manualMeetingAudioStreamsReady(null, true), false)
    assert.equal(manualMeetingAudioStreamsReady('MacBook Microphone', true), true)
  })

  it('requires the microphone while treating system audio as additive', () => {
    assert.equal(manualMeetingAudioReadinessError(null, false), 'manual-meeting-microphone-not-ready')
    assert.equal(manualMeetingAudioReadinessError('MacBook Microphone', false), null)
    assert.equal(manualMeetingAudioReadinessError(null, true), 'manual-meeting-microphone-not-ready')
  })

  it('allows a complete helper restart generation to become ready', async () => {
    let currentTime = 0
    let ready = false
    const result = await waitForManualMeetingAudioReadiness({
      ready: () => ready,
      cancelled: () => false,
      now: () => currentTime,
      delay: async (durationMs) => {
        currentTime += durationMs
        if (currentTime >= 21_100) ready = true
      },
    })

    assert.equal(result, 'ready')
    assert.ok(currentTime < MANUAL_MEETING_AUDIO_READY_TIMEOUT_MS)
  })

  it('cancels the readiness wait as soon as shutdown begins', async () => {
    let currentTime = 0
    let cancelled = false
    const result = await waitForManualMeetingAudioReadiness({
      ready: () => false,
      cancelled: () => cancelled,
      now: () => currentTime,
      delay: async (durationMs) => {
        currentTime += durationMs
        cancelled = true
      },
    })

    assert.equal(result, 'cancelled')
    assert.equal(currentTime, 100)
  })

  it('stops waiting at the bounded startup deadline', async () => {
    let currentTime = 0
    const result = await waitForManualMeetingAudioReadiness({
      ready: () => false,
      cancelled: () => false,
      now: () => currentTime,
      delay: async (durationMs) => {
        currentTime += durationMs
      },
    })

    assert.equal(result, 'timed-out')
    assert.equal(currentTime, MANUAL_MEETING_AUDIO_READY_TIMEOUT_MS)
  })

  it('keeps another queued recording processable when one recording is discarded', () => {
    const first = meeting({ id: 'meeting-a' })
    const discarded = meeting({ id: 'meeting-b' })
    const persisted = [first]

    assert.equal(
      manualMeetingStillProcessing(
        first.id,
        persisted.find((candidate) => candidate.id === first.id)
      ),
      true
    )
    assert.equal(
      manualMeetingStillProcessing(
        discarded.id,
        persisted.find((candidate) => candidate.id === discarded.id)
      ),
      false
    )
  })

  it('keeps a durable manual conversation when a later analysis omits it', () => {
    const manual = memoryWithFinishedManualMeetingConversation(
      memoryWithManualMeetingConversation(day(), meeting({ episodeId: 'manual-meeting-meeting-1' })),
      meeting().id
    ).conversations[0]

    assert.ok(manual)
    assert.deepEqual(preserveManualMeetingConversations([manual], []), [manual])
  })

  it('creates a full recording episode even when transcription produced no speech segments', () => {
    const result = manualMeetingEpisode(meeting(), [])

    assert.equal(result.id, 'manual-meeting-meeting-1')
    assert.equal(result.startedAt, meeting().startedAt)
    assert.equal(result.endedAt, meeting().endedAt)
    assert.deepEqual(result.segmentIds, [])
    assert.equal(result.state, 'final')
  })

  it('collapses speech-derived episode segments into the authoritative recording episode', () => {
    const speechEpisode: ConversationEpisode = {
      id: 'speech-episode',
      workdayId: 'day-1',
      startedAt: meeting().startedAt + 5_000,
      endedAt: (meeting().endedAt ?? 0) - 5_000,
      state: 'final',
      surfaceKey: 'manual:meeting-1',
      provider: 'manual',
      boundaryReason: 'call-ended',
      segmentIds: ['segment-1'],
      deletedAt: null,
      automaticRevinoteProcessingBlocked: false,
    }

    assert.deepEqual(manualMeetingEpisode(meeting(), [speechEpisode]).segmentIds, ['segment-1'])
  })

  it('publishes audio and notes before analysis and reaches a terminal fallback afterward', () => {
    const processingMeeting = meeting({ episodeId: 'manual-meeting-meeting-1' })
    const processing = memoryWithManualMeetingConversation(day(), processingMeeting)
    const conversation = processing.conversations[0]

    assert.equal(conversation?.episodeId, 'manual-meeting-meeting-1')
    assert.equal(conversation?.processing, 'processing')
    assert.equal(conversation?.processingProvider, 'remember')
    assert.equal(conversation?.notes, 'Ship the local fallback.')

    const finished = memoryWithFinishedManualMeetingConversation(processing, processingMeeting.id)
    assert.equal(finished.conversations[0]?.processing, undefined)
    assert.equal(finished.conversations[0]?.processingProvider, undefined)
    assert.equal(finished.conversations[0]?.episodeId, 'manual-meeting-meeting-1')
  })

  it('routes a manual recording directly to Revinote when requested', () => {
    const processing = memoryWithManualMeetingConversation(
      day(),
      meeting({ episodeId: 'manual-meeting-meeting-1' }),
      'revinote'
    )

    assert.equal(processing.conversations[0]?.processing, 'processing')
    assert.equal(processing.conversations[0]?.processingProvider, 'revinote')
  })

  it('still publishes a terminal notes-only conversation when no audible chunk was captured', () => {
    const processing = memoryWithManualMeetingConversation(day(), meeting())
    assert.equal(processing.conversations[0]?.episodeId, undefined)
    assert.equal(processing.conversations[0]?.processing, 'processing')

    const finished = memoryWithFinishedManualMeetingConversation(processing, meeting().id)
    assert.equal(finished.conversations[0]?.processing, undefined)
    assert.equal(finished.conversations[0]?.title, 'Design review')
  })

  it('does not replace an unrelated conversation when no episode was captured', () => {
    const existingDay = day()
    existingDay.memory = {
      summary: '',
      currentFocus: null,
      outcomes: [],
      decisions: [],
      openLoops: [],
      conversations: [
        {
          startTime: '09:30',
          endTime: '09:45',
          title: 'Existing conversation',
          description: 'Keep me.',
        },
      ],
      timeline: [],
      knowledgeSuggestions: [],
      refreshedAt: existingDay.startedAt,
      coveredThrough: existingDay.startedAt,
    }

    const result = memoryWithManualMeetingConversation(existingDay, meeting({ episodeId: undefined }))

    assert.equal(result.conversations.length, 2)
    assert.equal(result.conversations[0]?.manualMeetingId, 'meeting-1')
    assert.equal(result.conversations[1]?.title, 'Existing conversation')
  })

  it('keeps two manual recordings that stop within the same minute distinct', () => {
    const first = meeting({ id: 'meeting-1', title: 'First recording' })
    const second = meeting({ id: 'meeting-2', title: 'Second recording', startedAt: first.startedAt + 10_000 })
    const withFirst = memoryWithManualMeetingConversation(day(), first)
    const withBoth = memoryWithManualMeetingConversation({ ...day(), memory: withFirst }, second)

    assert.deepEqual(
      withBoth.conversations.map((conversation) => conversation.manualMeetingId),
      ['meeting-2', 'meeting-1']
    )
  })
})
