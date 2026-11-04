import assert from 'node:assert/strict'
import test from 'node:test'
import type { Day } from '@remember/shared'
import { conversationActivityItems, toggleConversationActivitySelection } from './conversationActivity'

function day(): Day {
  return {
    id: '2026-09-03',
    startedAt: 0,
    endedAt: null,
    activeDurationMs: 0,
    moments: [
      {
        id: 'microphone-1',
        sessionId: '2026-09-03',
        source: 'microphone',
        startedAt: 1_000,
        durationMs: 60_000,
        status: 'ready',
        transcript: 'Microphone transcript',
      },
      {
        id: 'system-1',
        sessionId: '2026-09-03',
        source: 'system',
        startedAt: 1_000,
        durationMs: 60_000,
        status: 'ready',
        transcript: 'System transcript',
      },
      {
        id: 'microphone-2',
        sessionId: '2026-09-03',
        source: 'microphone',
        startedAt: 61_000,
        durationMs: 60_000,
        status: 'ready',
        transcript: 'More microphone transcript',
      },
      {
        id: 'simultaneous-unrelated-system',
        sessionId: '2026-09-03',
        source: 'system',
        startedAt: 1_000,
        durationMs: 60_000,
        status: 'ready',
        transcript: 'Unrelated playback',
      },
    ],
    appActivity: [],
    contextMoments: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
    recoverableConversationBlocks: [
      {
        episodeId: 'episode-1',
        startedAt: 1_000,
        endedAt: 121_000,
        provider: null,
        source: 'mixed',
        preview: 'Conversation preview',
        momentIds: ['microphone-1', 'system-1', 'microphone-2'],
      },
    ],
  }
}

test('audio activity shows individual chunks without waiting for a finalized episode', () => {
  const value = day()
  value.recoverableConversationBlocks = []
  value.retainedAudioMomentIds = ['microphone-1', 'microphone-2']
  const items = conversationActivityItems([value])
  assert.equal(items.length, 4)
  assert.equal(items[0]?.moment.id, 'microphone-2')
  assert.equal(items.find((item) => item.moment.id === 'microphone-1')?.retained, true)
  assert.equal(items.find((item) => item.moment.id === 'system-1')?.retained, false)
})

test('recognition and audio expiry do not erase transcript history', () => {
  const value = day()
  value.retainedAudioMomentIds = []
  value.recoverableConversationBlocks = []
  assert.equal(conversationActivityItems([value]).length, 4)
})

test('processing, failed and uncertain speech stay visible while detected silence is hidden', () => {
  const value = day()
  const moment = value.moments[0]
  assert.ok(moment)
  value.moments = [
    { ...moment, id: 'pending', status: 'transcribing', transcript: '' },
    { ...moment, id: 'failed', status: 'failed', transcript: '' },
    { ...moment, id: 'quarantined', status: 'empty', captureOutcome: 'quarantined', transcript: '' },
    { ...moment, id: 'silence', status: 'empty', captureOutcome: 'vad-empty', transcript: '' },
    { ...moment, id: 'revinote', source: 'revinote' },
  ]
  assert.deepEqual(
    conversationActivityItems([value]).map((item) => item.moment.id),
    ['failed', 'pending', 'quarantined']
  )
})

test('one toggle changes exactly one chunk selection', () => {
  assert.deepEqual(toggleConversationActivitySelection([], 'microphone-1'), ['microphone-1'])
  assert.deepEqual(toggleConversationActivitySelection(['microphone-1', 'system-1'], 'microphone-1'), ['system-1'])
})
