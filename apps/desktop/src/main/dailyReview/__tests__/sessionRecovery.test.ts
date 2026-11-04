import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { DailyReviewMoment, DailyReviewSession, SpeechSegment } from '@remember/shared'
import { resolvedAudioMoment } from '../audioTranscription'
import { EvidenceStore } from '../evidenceStore'
import { recoverInterruptedSession } from '../sessionRecovery'

function moment(id: string): DailyReviewMoment {
  return {
    id,
    sessionId: 'day',
    source: 'microphone',
    startedAt: 1_000,
    durationMs: 60_000,
    status: 'transcribing',
    transcript: '',
    captureOutcome: 'pending',
  }
}

function session(endedAt: number | null): DailyReviewSession {
  return {
    id: 'day',
    startedAt: 1_000,
    endedAt,
    activeDurationMs: 0,
    moments: [moment('decoded'), moment('unfinished')],
    appActivity: [],
    contextMoments: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  }
}

function segment(id: string, startedAt = 1_000, text = 'Saved speech.'): SpeechSegment {
  return {
    id,
    chunkId: 'decoded',
    workdayId: 'day',
    source: 'microphone',
    startedAt,
    endedAt: startedAt + 1_000,
    text,
    detectedLanguage: null,
    acceptedLanguage: null,
    rejectionReason: null,
  }
}

for (const endedAt of [null, 90_000]) {
  test(`recovers saved speech and terminates undecoded pending audio on ${endedAt == null ? 'open' : 'ended'} days`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'remember-audio-recovery-'))
    const store = new EvidenceStore(join(directory, 'evidence.sqlite'))
    try {
      const original = session(endedAt)
      store.upsertSession(original)
      for (const moment of original.moments) store.appendAudioMoment(moment, 0.01)
      store.appendSpeechSegments([segment('later', 3_000, 'Second.'), segment('earlier', 1_000, 'First.')])
      const before = store.readSessions()[0]
      assert.ok(before)
      const speech = store.listSpeechSegments('day')
      const recovered = recoverInterruptedSession(before, speech)
      assert.equal(recovered.endedAt, endedAt ?? 61_000)
      assert.deepEqual(
        recovered.moments.map(({ status, transcript, captureOutcome }) => ({ status, transcript, captureOutcome })),
        [
          { status: 'ready', transcript: 'First. Second.', captureOutcome: 'transcribed' },
          { status: 'failed', transcript: '', captureOutcome: 'failed' },
        ]
      )
      store.upsertSession(recovered)
      for (const moment of recovered.moments) store.updateAudioMoment('day', moment.id, moment)
      const restarted = store.readSessions()[0]
      assert.ok(restarted)
      assert.strictEqual(recoverInterruptedSession(restarted, speech), restarted)
      assert.deepEqual(store.listSpeechSegments('day'), speech)
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
}

test('interrupted audio retains explicit empty and quarantined outcomes without exposing rejected speech', () => {
  const empty = resolvedAudioMoment(
    moment('decoded'),
    [{ ...segment('empty'), text: '', transcriptionOutcome: 'asr-empty' }],
    true
  )
  assert.equal(empty.status, 'empty')
  assert.equal(empty.captureOutcome, 'asr-empty')
  const quarantined = resolvedAudioMoment(
    moment('decoded'),
    [{ ...segment('rejected'), rejectionReason: 'likely-hallucination' }],
    true
  )
  assert.equal(quarantined.status, 'empty')
  assert.equal(quarantined.captureOutcome, 'quarantined')
  assert.equal(quarantined.transcript, '')
})

test('recovery preserves older saved moment transcripts and does not claim undecoded audio is silence', () => {
  const saved = resolvedAudioMoment({ ...moment('legacy'), transcript: 'Already saved.' }, [], true)
  assert.equal(saved.status, 'ready')
  assert.equal(saved.transcript, 'Already saved.')
  assert.equal(resolvedAudioMoment(moment('unknown'), [], true).status, 'failed')
  assert.equal(resolvedAudioMoment(moment('silent'), []).captureOutcome, 'vad-empty')
})

test('recovering interrupted agent work preserves completed audio and the existing day end', () => {
  const day = session(90_000)
  day.moments = [{ ...moment('complete'), status: 'ready', transcript: 'Completed.', captureOutcome: 'transcribed' }]
  day.refresh.status = 'refreshing'
  const result = recoverInterruptedSession(day, [], 100_000)
  assert.equal(result.refresh.status, 'failed')
  assert.equal(result.refresh.error, 'agent-interrupted')
  assert.equal(result.endedAt, 90_000)
  assert.strictEqual(result.moments[0], day.moments[0])
})

test('recovers saved local speech after legacy quit marks decoded chunks failed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'remember-legacy-audio-recovery-'))
  const store = new EvidenceStore(join(directory, 'evidence.sqlite'))
  try {
    const original = session(90_000)
    original.moments = [
      moment('decoded'),
      { ...moment('decoded-system'), source: 'system' },
      moment('unfinished'),
      moment('rejected'),
      moment('asr-empty'),
      moment('secondary'),
      { ...moment('complete'), status: 'ready', transcript: 'Completed.', captureOutcome: 'transcribed' },
      { ...moment('classified-empty'), status: 'empty', captureOutcome: 'quarantined' },
      { ...moment('failed-with-transcript'), status: 'failed', transcript: 'Saved failure.', captureOutcome: 'failed' },
    ]
    store.upsertSession(original)
    for (const moment of original.moments) store.appendAudioMoment(moment, 0.01)
    store.appendSpeechSegments([
      segment('later', 3_000, 'Second.'),
      segment('earlier', 1_000, 'First.'),
      { ...segment('system'), chunkId: 'decoded-system', source: 'system', text: 'Saved system speech.' },
      { ...segment('rejected'), chunkId: 'rejected', rejectionReason: 'unsupported-language' },
      { ...segment('empty'), chunkId: 'asr-empty', text: '', transcriptionOutcome: 'asr-empty' },
      { ...segment('secondary'), chunkId: 'complete', chunkIds: ['complete', 'secondary'] },
      { ...segment('classified-empty'), chunkId: 'classified-empty' },
      { ...segment('failed-with-transcript'), chunkId: 'failed-with-transcript' },
    ])

    // Old failPendingAudioMoments ran during quit even when decoded speech was saved.
    for (const moment of original.moments) {
      if (moment.status === 'transcribing' && moment.source !== 'revinote') {
        store.updateAudioMoment('day', moment.id, { status: 'failed', captureOutcome: 'failed' })
      }
    }
    const before = store.readSessions()[0]
    assert.ok(before)
    assert(before.moments.every((moment) => moment.status !== 'transcribing'))
    const speech = store.listSpeechSegments('day')
    const recovered = recoverInterruptedSession(before, speech)
    assert.equal(recovered.endedAt, 90_000)
    assert.deepEqual(
      recovered.moments
        .slice(0, 2)
        .map(({ status, transcript, captureOutcome }) => ({ status, transcript, captureOutcome })),
      [
        { status: 'ready', transcript: 'First. Second.', captureOutcome: 'transcribed' },
        { status: 'ready', transcript: 'Saved system speech.', captureOutcome: 'transcribed' },
      ]
    )
    for (const [index, moment] of recovered.moments.entries()) {
      if (index >= 2) assert.strictEqual(moment, before.moments[index])
    }
    store.upsertSession(recovered)
    for (const [index, moment] of recovered.moments.entries()) {
      if (moment !== before.moments[index]) store.updateAudioMoment('day', moment.id, moment)
    }
    const restarted = store.readSessions()[0]
    assert.ok(restarted)
    assert.deepEqual(restarted.moments, recovered.moments)
    assert.strictEqual(recoverInterruptedSession(restarted, speech), restarted)
    assert.deepEqual(store.listSpeechSegments('day'), speech)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('ended legacy failures without accepted primary speech do not trigger recovery writes', () => {
  const day = session(90_000)
  day.moments = [{ ...moment('decoded'), status: 'failed', captureOutcome: 'failed' }]
  for (const speech of [
    [],
    [{ ...segment('empty'), text: '', transcriptionOutcome: 'asr-empty' as const }],
    [{ ...segment('rejected'), rejectionReason: 'likely-hallucination' as const }],
    [{ ...segment('secondary'), chunkId: 'primary-owner', chunkIds: ['primary-owner', 'decoded'] }],
  ]) {
    assert.strictEqual(recoverInterruptedSession(day, speech), day)
  }
})

test('local audio recovery leaves remote Revinote moments unchanged', () => {
  const day = session(90_000)
  day.moments = [{ ...moment('remote'), source: 'revinote', status: 'failed', captureOutcome: 'failed' }]
  assert.strictEqual(recoverInterruptedSession(day, [{ ...segment('remote'), chunkId: 'remote' }]), day)
  day.moments[0] = { ...day.moments[0], status: 'transcribing', captureOutcome: 'pending' }
  assert.strictEqual(recoverInterruptedSession(day, []), day)
})
