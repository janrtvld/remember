import assert from 'node:assert/strict'
import { join } from 'node:path'
import type { AudioMoment, Day, SpeechSegment } from '@remember/shared'
import { saveConversationAudioChunkAt } from '../../src/main/dailyReview/conversationAudio'
import { EvidenceStore } from '../../src/main/dailyReview/evidenceStore'
import { createQaAudioFixture } from '../../src/main/dailyReview/qaAudioFixture'

const outcomes = [
  'transcribed',
  'failed',
  'asr-empty',
  'quarantined',
  'legacy-failed',
  'legacy-failed-no-speech',
  'legacy-failed-quarantined',
] as const

function speechText(name: string, outcome: (typeof outcomes)[number]) {
  return `Synthetic ${name}${outcome === 'legacy-failed' ? ' legacy' : ''} speech retained.`
}

export function seedAudioProcessingRecovery(profile: string) {
  const root = join(profile, 'daily-review')
  const store = new EvidenceStore(join(root, 'evidence.sqlite'))
  try {
    const template = store.readSessions().find((day) => day.id === 'qa-day')
    assert(template)
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    const openStartedAt = Math.max(midnight.getTime(), Date.now() - 60_000)
    const days = [
      template,
      {
        ...template,
        id: 'qa-audio-open-day',
        localDay: undefined,
        startedAt: openStartedAt,
        endedAt: null,
        moments: [],
        appActivity: [],
        contextMoments: [],
        memory: null,
      },
    ] satisfies Day[]
    const expected = days.map((day) => {
      const name = day.endedAt == null ? 'open' : 'ended'
      const moments = outcomes.map(
        (captureOutcome, index): AudioMoment => ({
          id: `qa-${name}-${captureOutcome}`,
          sessionId: day.id,
          source: index % 2 === 0 ? 'microphone' : 'system',
          startedAt: day.startedAt + 5_000 + index * 5_000,
          durationMs: 2_000,
          status: captureOutcome.startsWith('legacy-') ? 'failed' : 'transcribing',
          transcript: '',
          captureOutcome: captureOutcome.startsWith('legacy-') ? 'failed' : 'pending',
        })
      )
      const segments = moments.flatMap((moment, index): SpeechSegment[] => {
        const outcome = outcomes[index]
        if (outcome === 'failed' || outcome === 'legacy-failed-no-speech') return []
        const quarantined = outcome === 'quarantined' || outcome === 'legacy-failed-quarantined'
        const segment: SpeechSegment = {
          id: `${moment.id}-speech`,
          workdayId: day.id,
          chunkId: moment.id,
          chunkIds: [moment.id],
          source: moment.source as SpeechSegment['source'],
          startedAt: moment.startedAt,
          endedAt: moment.startedAt + 1_000,
          text: outcome === 'asr-empty' ? '' : speechText(name, outcome),
          transcriptionOutcome: outcome === 'asr-empty' ? 'asr-empty' : 'transcribed',
          detectedLanguage: quarantined ? 'de' : 'en',
          acceptedLanguage: quarantined ? null : 'en',
          rejectionReason: quarantined ? 'unsupported-language' : null,
        }
        if (outcome !== 'transcribed' && outcome !== 'legacy-failed') return [segment]
        // Insert out of chronological order to verify reconstruction uses speech time.
        return [
          {
            ...segment,
            id: `${moment.id}-speech-last`,
            startedAt: moment.startedAt + 1_000,
            endedAt: moment.startedAt + 2_000,
            text: 'Startup must keep every word.',
          },
          segment,
        ]
      })
      store.upsertSession({ ...day, moments: [...day.moments, ...moments] })
      for (const moment of moments) {
        store.appendAudioMoment(moment, 0.01)
        saveConversationAudioChunkAt(root, day.id, moment.id, createQaAudioFixture(moment.durationMs))
      }
      store.appendSpeechSegments(segments)
      return {
        id: day.id,
        wasOpen: day.endedAt == null,
        endedAt: day.endedAt ?? Math.max(...moments.map((moment) => moment.startedAt + moment.durationMs)),
        moments: moments.map((moment, index): AudioMoment => {
          const outcome = outcomes[index]
          const captureOutcome =
            outcome === 'legacy-failed'
              ? 'transcribed'
              : outcome === 'legacy-failed-no-speech' || outcome === 'legacy-failed-quarantined'
                ? 'failed'
                : outcome
          return {
            ...moment,
            status: captureOutcome === 'transcribed' ? 'ready' : captureOutcome === 'failed' ? 'failed' : 'empty',
            captureOutcome,
            transcript:
              captureOutcome === 'transcribed' ? `${speechText(name, outcome)} Startup must keep every word.` : '',
          }
        }),
        segments: store.listSpeechSegments(day.id),
        existingMoments: day.moments,
      }
    })
    return expected
  } finally {
    store.close()
  }
}

export function verifyAudioProcessingRecovery(
  profile: string,
  days: Day[],
  expected: ReturnType<typeof seedAudioProcessingRecovery>
) {
  const store = new EvidenceStore(join(profile, 'daily-review/evidence.sqlite'))
  try {
    const persisted = store.readSessions()
    return expected.map((fixture) => {
      const visible = days.find((day) => day.id === fixture.id)
      const stored = persisted.find((day) => day.id === fixture.id)
      assert(visible && stored, 'Recovered days must cross real preload/IPC and remain persisted')
      for (const day of [visible, stored]) {
        assert.equal(day.endedAt, fixture.endedAt)
        for (const moment of [...fixture.existingMoments, ...fixture.moments]) {
          assert.deepEqual(
            day.moments.find((candidate) => candidate.id === moment.id),
            moment
          )
        }
        assert(day.moments.every((moment) => moment.status !== 'transcribing'))
      }
      assert.deepEqual(store.listSpeechSegments(fixture.id), fixture.segments, 'Decoded speech must remain intact')
      if (fixture.wasOpen) {
        for (const moment of fixture.moments) {
          assert(
            visible.retainedAudioMomentIds?.includes(moment.id),
            'Recovery must preserve recent local audio availability'
          )
        }
      }
      return { id: fixture.id, endedAt: visible.endedAt, moments: fixture.moments, segments: fixture.segments }
    })
  } finally {
    store.close()
  }
}
