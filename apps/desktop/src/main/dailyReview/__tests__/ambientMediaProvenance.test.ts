import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import type { DailyReviewSession, SpeechSegment } from '@remember/shared'
import { createAmbientTaskWorker } from '../ambientTaskWorker'
import { EvidenceStore } from '../evidenceStore'

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})
const text = 'Jan, kun jij morgen de offerte opsturen naar de klant?'
const at = Date.now()

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'remember-media-provenance-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'evidence.sqlite')
  let store = new EvidenceStore(file)
  cleanup.push(() => store.close())
  const day: DailyReviewSession = {
    id: 'day',
    startedAt: at - 60_000,
    endedAt: null,
    activeDurationMs: 0,
    moments: [],
    contextMoments: [],
    appActivity: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  }
  store.upsertSession(day)
  return {
    get store() {
      return store
    },
    reopen() {
      store.close()
      store = new EvidenceStore(file)
    },
  }
}

function chunk(
  store: EvidenceStore,
  id: string,
  playing = false,
  source: SpeechSegment['source'] = 'system',
  startedAt = at
) {
  store.appendAudioMoment({
    id,
    sessionId: 'day',
    source,
    startedAt,
    durationMs: 10_000,
    status: 'ready',
    transcript: text,
    ...(playing
      ? { mediaPlayback: { isPlaying: true, applicationName: 'Media player', bundleIdentifier: 'example.player' } }
      : {}),
  })
}

function speech(
  store: EvidenceStore,
  id: string,
  chunks: string[],
  source: SpeechSegment['source'] = 'system',
  startedAt = at + 1_000,
  endedAt = at + 9_000
) {
  store.appendSpeechSegments([
    {
      id,
      chunkId: chunks[0] as string,
      chunkIds: chunks,
      workdayId: 'day',
      source,
      startedAt,
      endedAt,
      text,
      detectedLanguage: 'nl',
      acceptedLanguage: 'nl',
      rejectionReason: null,
    },
  ])
}

test('recorded native playback blocks automatic speech tasks across restart without deleting the transcript', () => {
  const f = fixture()
  for (const source of ['system', 'microphone'] as const) {
    chunk(f.store, source, true, source)
    speech(f.store, `${source}-speech`, [source], source)
    assert.equal(f.store.ambientTasks.resolveSource(`speech:${source}-speech`), null)
  }
  assert.equal(f.store.listSpeechSegments('day').length, 2)
  f.reopen()
  assert.equal(
    f.store.ambientTasks.batch(
      at + 60_000,
      () => true,
      () => true
    ).length,
    0
  )
  assert.equal(f.store.listSpeechSegments('day').length, 2)
})

test('only exact linked and overlapping chunks provide playback provenance, including multi-chunk speech', () => {
  const f = fixture()
  chunk(f.store, 'first')
  chunk(f.store, 'unrelated', true)
  speech(f.store, 'clear', ['first'])
  assert(f.store.ambientTasks.resolveSource('speech:clear'))
  chunk(f.store, 'second', true, 'system', at + 10_000)
  speech(f.store, 'spanning', ['first', 'second'], 'system', at + 1_000, at + 17_000)
  assert.equal(f.store.ambientTasks.resolveSource('speech:spanning'), null)
  speech(f.store, 'non-overlapping', ['first', 'second'])
  assert(f.store.ambientTasks.resolveSource('speech:non-overlapping'))
})

test('an active call does not override mixed playback, while independent screen and call speech remain eligible', () => {
  const f = fixture()
  f.store.appendCallSignal({
    id: 'call',
    workdayId: 'day',
    provider: 'zoom',
    surfaceKey: 'zoom:call',
    state: 'active',
    observedAt: at - 1_000,
  })
  chunk(f.store, 'mixed', true)
  speech(f.store, 'mixed-speech', ['mixed'])
  chunk(f.store, 'call-only', false, 'microphone')
  speech(f.store, 'call-speech', ['call-only'], 'microphone')
  f.store.appendContextMoment(
    'day',
    {
      id: 'assignment',
      timestamp: at,
      text: 'Aan: Jan. Graag morgen de offerte naar de klant sturen.',
      appName: 'Mail',
      windowTitle: 'Offerte',
      textSource: 'accessibility',
      trigger: 'content-change',
      monitorName: '',
      screenshotPath: '',
    },
    null
  )
  const batch = f.store.ambientTasks.batch(
    at + 60_000,
    () => true,
    () => true
  )
  assert.deepEqual(new Set(batch.map((entry) => entry.evidenceId)), new Set(['speech:call-speech', 'assignment']))
})

test('a playback snapshot appearing during inference invalidates commit even when transcript text is unchanged', async () => {
  const f = fixture()
  chunk(f.store, 'audio')
  speech(f.store, 'speech', ['audio'])
  const originalSource = f.store.ambientTasks.resolveSource('speech:speech')
  assert(originalSource)
  let applied = false
  const worker = createAmbientTaskWorker({
    store: f.store.ambientTasks,
    policy: () => 'allowed',
    allowed: () => true,
    accept: () => true,
    items: () => [],
    analyze: async (evidence) => {
      chunk(f.store, 'audio', true)
      return {
        consideredEvidenceIds: evidence.map((entry) => entry.evidenceId),
        proposed: [],
        changes: [],
        notifyTitles: [],
      }
    },
    apply: () => {
      applied = true
    },
    changed: () => {},
    notify: () => assert.fail('No notification is permitted'),
    notificationsSupported: () => false,
    error: (error) => {
      throw error
    },
    now: () => at + 60_000,
  })
  await worker.tick()
  assert.equal(applied, false)
  assert.equal(f.store.ambientTasks.resolveSource('speech:speech'), null)
  assert.throws(
    () =>
      f.store.applyAnalyzedWorkItems({
        workdayId: 'day',
        plan: { proposed: [], changes: [] },
        conversations: [],
        analysisStartedAt: at,
        observedAt: at + 60_000,
        ambientBatch: { evidence: [originalSource], notifyTitles: [] },
      }),
    { message: 'ambient-evidence-changed' }
  )
})
