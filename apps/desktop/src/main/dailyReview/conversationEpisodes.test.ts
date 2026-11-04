import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CallSignal, ConversationEpisode, SpeechSegment } from '@remember/shared'
import { conversationEpisodeCompletedAt, deriveConversationEpisodes } from './conversationEpisodes'

function speech(id: string, minute: number): SpeechSegment {
  return {
    id,
    workdayId: 'day',
    chunkId: `chunk-${id}`,
    source: 'microphone',
    startedAt: minute * 60_000,
    endedAt: minute * 60_000 + 10_000,
    text: `speech ${id}`,
    detectedLanguage: 'en',
    acceptedLanguage: 'en',
    rejectionReason: null,
  }
}

function signal(
  id: string,
  minute: number,
  provider: string,
  surfaceKey: string,
  state: CallSignal['state']
): CallSignal {
  return { id, workdayId: 'day', provider, surfaceKey, state, observedAt: minute * 60_000 }
}

describe('conversation episode derivation', () => {
  it('makes Tom, Woub, then Tom three stable episodes', () => {
    const result = deriveConversationEpisodes({
      workdayId: 'day',
      segments: [speech('tom-before', 1), speech('sprint', 12), speech('tom-after', 31)],
      signals: [
        signal('discord-start', 0, 'discord', 'discord:tom', 'active'),
        signal('woub-start', 10, 'woub', 'woub:sprint-review', 'active'),
        signal('woub-end', 30, 'woub', 'woub:sprint-review', 'ended'),
      ],
      coveredThrough: 32 * 60_000,
    })

    assert.deepEqual(
      result.map((episode) => episode.surfaceKey),
      ['discord:tom', 'woub:sprint-review', null]
    )
    assert.deepEqual(
      result.map((episode) => episode.state),
      ['final', 'final', 'provisional']
    )
    assert.equal(new Set(result.map((episode) => episode.id)).size, 3)
  })

  it('keeps a finalized prefix immutable as later speech arrives', () => {
    const first = deriveConversationEpisodes({
      workdayId: 'day',
      segments: [speech('first', 0)],
      signals: [],
      coveredThrough: 3 * 60_000,
    })
    const finalized = first[0] as ConversationEpisode
    assert.equal(finalized.state, 'final')

    const second = deriveConversationEpisodes({
      workdayId: 'day',
      segments: [speech('first', 0), speech('later', 4)],
      signals: [],
      existing: first,
      coveredThrough: 7 * 60_000,
    })
    assert.deepEqual(second[0], finalized)
    assert.equal(second.length, 2)
  })

  it('splits unscoped speech after a real gap', () => {
    const result = deriveConversationEpisodes({
      workdayId: 'day',
      segments: [speech('first', 1), speech('later', 4)],
      signals: [],
      coveredThrough: 5 * 60_000,
    })

    assert.equal(result.length, 2)
    assert.equal(result[0]?.boundaryReason, 'speech-gap')
    assert.equal(conversationEpisodeCompletedAt(result[0] as ConversationEpisode, [], 5 * 60_000), 70_000)
  })

  it('ends a chapter after sustained silence even while a call remains connected', () => {
    const result = deriveConversationEpisodes({
      workdayId: 'day',
      segments: [speech('before', 1), speech('after', 20)],
      signals: [signal('active', 0, 'woub', 'woub:review', 'active')],
      coveredThrough: 21 * 60_000,
    })
    assert.equal(result.length, 2)
    assert.deepEqual(
      result.map((episode) => episode.segmentIds),
      [['before'], ['after']]
    )
    assert.equal(result[1]?.surfaceKey, null)
  })

  it('does not attribute new speech to an old unclosed call observation', () => {
    const result = deriveConversationEpisodes({
      workdayId: 'day',
      segments: [speech('video', 70), speech('visit', 240)],
      signals: [signal('old-call', 0, 'woub', 'woub:woub', 'active')],
      coveredThrough: 245 * 60_000,
    })
    assert.deepEqual(
      result.map((episode) => episode.surfaceKey),
      [null, null]
    )
    assert.equal(result.length, 2)
  })

  it('keeps continuous speech attributed when the call leaves the foreground', () => {
    const result = deriveConversationEpisodes({
      workdayId: 'day',
      segments: Array.from({ length: 20 }, (_, index) => speech(`speech-${index}`, index + 1)),
      signals: [signal('call', 0, 'discord', 'discord:call', 'active')],
      coveredThrough: 21 * 60_000,
    })
    assert.equal(result.length, 1)
    assert.equal(result[0]?.surfaceKey, 'discord:call')
  })

  it('closes a call episode across an interruption in both capture streams', () => {
    const result = deriveConversationEpisodes({
      workdayId: 'day',
      segments: [speech('before', 1), speech('after', 4)],
      signals: [signal('call', 0, 'discord', 'discord:call', 'active')],
      moments: [1, 4].map((minute) => ({
        id: `chunk-${minute}`,
        sessionId: 'day',
        source: 'microphone',
        startedAt: minute * 60_000,
        durationMs: 60_000,
        status: 'ready',
        transcript: 'Speech',
      })),
      coveredThrough: 5 * 60_000,
    })
    assert.equal(result.length, 2)
    assert.equal(result[0]?.boundaryReason, 'capture-paused')
  })

  it('does not confuse a microphone interruption with a gap in ongoing system capture', () => {
    const result = deriveConversationEpisodes({
      workdayId: 'day',
      segments: [speech('before', 1), speech('after', 4)],
      signals: [signal('call', 0, 'discord', 'discord:call', 'active')],
      moments: [
        {
          id: 'system',
          sessionId: 'day',
          source: 'system',
          startedAt: 0,
          durationMs: 5 * 60_000,
          status: 'ready',
          transcript: 'Presentation',
        },
      ],
      coveredThrough: 5 * 60_000,
    })
    assert.equal(result.length, 1)
  })

  it('adopts a call surface that appears just after speech begins', () => {
    const result = deriveConversationEpisodes({
      workdayId: 'day',
      segments: [speech('opening', 1), speech('continued', 2)],
      signals: [signal('woub-start', 1.5, 'woub', 'woub:review', 'active')],
      coveredThrough: 3 * 60_000,
    })

    assert.equal(result.length, 1)
    assert.equal(result[0]?.surfaceKey, 'woub:review')
    assert.equal(result[0]?.provider, 'woub')
    assert.deepEqual(result[0]?.segmentIds, ['opening', 'continued'])
  })

  it('keeps continuous meeting speech together while the foreground call surface changes', () => {
    const result = deriveConversationEpisodes({
      workdayId: 'day',
      segments: [speech('first', 1), speech('second', 2), speech('third', 3), speech('fourth', 4)],
      signals: [
        signal('discord-general', 0, 'discord', 'discord:general', 'active'),
        signal('woub', 1.5, 'woub', 'woub:woub', 'active'),
        signal('discord-project', 2.5, 'discord', 'discord:project', 'active'),
        signal('woub-again', 3.5, 'woub', 'woub:woub', 'active'),
      ],
      coveredThrough: 5 * 60_000,
    })

    assert.equal(result.length, 1)
    assert.deepEqual(result[0]?.segmentIds, ['first', 'second', 'third', 'fourth'])
  })

  it('splits when the same call surface ends and is joined again', () => {
    const signals = [
      signal('first-active', 0, 'discord', 'discord:tom', 'active'),
      signal('first-ended', 5, 'discord', 'discord:tom', 'ended'),
      signal('second-active', 10, 'discord', 'discord:tom', 'active'),
    ]
    const result = deriveConversationEpisodes({
      workdayId: 'day',
      segments: [speech('first-call', 1), speech('second-call', 11)],
      signals,
      coveredThrough: 12 * 60_000,
    })

    assert.equal(result.length, 2)
    assert.equal(result[0]?.boundaryReason, 'call-ended')
    assert.equal(conversationEpisodeCompletedAt(result[0] as ConversationEpisode, signals, 12 * 60_000), 300_000)
    assert.notEqual(result[0]?.id, result[1]?.id)
  })
})
