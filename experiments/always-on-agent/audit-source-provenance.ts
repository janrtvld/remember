import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import type { AmbientEvidenceRef } from '../../apps/desktop/src/main/dailyReview/ambientTaskStore'
import type { EvidenceStore } from '../../apps/desktop/src/main/dailyReview/evidenceStore'
import type {
  CallSignal,
  DailyReviewContextMoment,
  DailyReviewMoment,
  DailyReviewSession,
  SpeechSegment,
} from '../../packages/shared/src/index'

type Row = Record<string, unknown>
type AudioKey = 'primary' | 'secondary'
type Expected = {
  resolveSource: 'present' | 'null'
  resolveSavedRef: 'present' | 'null'
  projectionEqualsBefore: boolean
  savedResolutionEqualsBefore: boolean
  latestObservedAtMatchesStoredEnd: boolean | null
  savedObservedAtMatchesStoredEnd: boolean | null
}
type Step = {
  name: string
  expected?: Partial<Expected>
  expectedStoredSpeechPatch?: Row
} & (
  | { kind: 'upsert-speech'; patch: Partial<SpeechSegment> }
  | { kind: 'upsert-audio'; audioKey: AudioKey; patch: Partial<DailyReviewMoment> }
  | { kind: 'adversarial-sql-times'; startedAt: number; endedAt: number; scope: string }
)
type Case = {
  id: string
  title: string
  setup: {
    audio: Partial<Record<AudioKey, Partial<DailyReviewMoment>>>
    speechPatch?: Partial<SpeechSegment>
    calls?: CallSignal[]
    context?: Array<{ moment: DailyReviewContextMoment; bundleId: string }>
  }
  expectedBefore?: Partial<Expected>
  steps?: Step[]
  reachability: string
  interpretation: string
}
type Fixture = {
  version: string
  authoredBeforeExecution: boolean
  scope: string
  common: {
    session: DailyReviewSession
    audio: Record<AudioKey, DailyReviewMoment>
    speech: SpeechSegment
    expected: Expected
  }
  cases: Case[]
  crossCaseProjectionEquality: { reference: string; beforeEqual: string[]; afterEqual: string[] }
  syntheticTruth: Row
  limits: string[]
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const fixturePath = path.join(root, 'tests/fixtures/always-on-benchmarks/source-provenance.v1.json')
const runParent = '/private/tmp/remember-source-provenance/runs'
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const save = (file: string, value: unknown) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)

function readRows(file: string, day: string) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return {
      workday: db.prepare('SELECT * FROM workday WHERE id = ?').all(day),
      speech: db.prepare('SELECT * FROM speech_segment WHERE workday_id = ? ORDER BY id').all(day),
      audio: db.prepare('SELECT * FROM audio_evidence WHERE workday_id = ? ORDER BY id').all(day),
      calls: db.prepare('SELECT * FROM call_signal WHERE workday_id = ? ORDER BY id').all(day),
      context: db
        .prepare(`SELECT c.*, a.display_name AS app_name, a.bundle_id FROM context_evidence c
          JOIN application a ON a.id = c.application_id WHERE c.workday_id = ? ORDER BY c.id`)
        .all(day),
      queue: db.prepare('SELECT * FROM ambient_task_evidence WHERE workday_id = ? ORDER BY kind, source_id').all(day),
      offline: db.prepare('SELECT * FROM offline_period ORDER BY id').all(),
      effectCounts: {
        workItems: Number(db.prepare('SELECT count(*) AS count FROM work_item').get()?.count),
        notifications: Number(db.prepare('SELECT count(*) AS count FROM ambient_task_notification').get()?.count),
      },
    }
  } finally {
    db.close()
  }
}

type Tables = ReturnType<typeof readRows>

function speechRow(segment: SpeechSegment): Row {
  return {
    id: segment.id,
    workday_id: segment.workdayId,
    chunk_id: segment.chunkId,
    chunk_ids_json: JSON.stringify(segment.chunkIds ?? [segment.chunkId]),
    source: segment.source,
    started_at: segment.startedAt,
    ended_at: segment.endedAt,
    text: segment.text,
    detected_language: segment.detectedLanguage,
    accepted_language: segment.acceptedLanguage,
    rejection_reason: segment.rejectionReason,
    transcription_outcome: segment.transcriptionOutcome ?? 'transcribed',
  }
}

function audioRow(moment: DailyReviewMoment): Row {
  return {
    id: moment.id,
    workday_id: moment.sessionId,
    source: moment.source,
    started_at: moment.startedAt,
    duration_ms: moment.durationMs,
    status: moment.status,
    transcript: moment.transcript,
    media_playback_json: moment.mediaPlayback ? JSON.stringify(moment.mediaPlayback) : null,
    capture_epoch_id: moment.captureEpochId ?? null,
    capture_sequence: moment.captureSequence ?? null,
    captured_sample_count: moment.capturedSampleCount ?? null,
    capture_sample_time: moment.captureSampleTime ?? null,
    capture_outcome: moment.captureOutcome ?? 'pending',
  }
}

function snapshot(store: EvidenceStore, file: string, ref: AmbientEvidenceRef) {
  const tables = readRows(file, ref.workdayId)
  const latest = store.ambientTasks.resolveSource(`speech:${ref.sourceId}`)
  const saved = store.ambientTasks.resolve(ref)
  const row = tables.speech.find((entry) => entry.id === ref.sourceId)
  assert(row, 'Own synthetic speech row must exist')
  return {
    tables,
    latest,
    saved,
    currentStoredTextRevision: hash(String(row.text)),
    currentRevisionEqualsSavedRef: hash(String(row.text)) === ref.revision,
    latestObservedAtMatchesStoredEnd: latest ? latest.observedAt === row.ended_at : null,
    savedObservedAtMatchesStoredEnd: saved ? saved.observedAt === row.ended_at : null,
  }
}

type Snapshot = ReturnType<typeof snapshot>
type Check = { name: string; matched: boolean; expected: unknown; actual: unknown }

function recordCheck(checks: Check[], name: string, actual: unknown, expected: unknown) {
  checks.push({ name, matched: isDeepStrictEqual(actual, expected), expected, actual })
}

function checkRows(checks: Check[], label: string, rows: Row[], expected: Row[]) {
  recordCheck(
    checks,
    `${label}: exact own row IDs`,
    rows.map((row) => row.id).sort(),
    expected.map((row) => row.id).sort()
  )
  for (const wanted of expected) {
    const found = rows.find((row) => row.id === wanted.id)
    const subset = Object.fromEntries(Object.keys(wanted).map((key) => [key, found?.[key]]))
    recordCheck(checks, `${label}: ${wanted.id}`, subset, wanted)
  }
}

async function auditCase(run: string, entry: Case, fixture: Fixture) {
  const directory = path.join(run, entry.id)
  mkdirSync(directory)
  const file = path.join(directory, 'evidence.sqlite')
  assert(!existsSync(file), 'Never reuse a database')
  const audio = new Map<AudioKey, DailyReviewMoment>(
    (Object.entries(entry.setup.audio) as Array<[AudioKey, Partial<DailyReviewMoment>]>).map(([key, patch]) => [
      key,
      { ...fixture.common.audio[key], ...patch },
    ])
  )
  const speech = { ...fixture.common.speech, ...entry.setup.speechPatch }
  const calls = entry.setup.calls ?? []
  const context = entry.setup.context ?? []
  const expandedInput = { session: fixture.common.session, audio: [...audio.values()], speech, calls, context }
  save(path.join(directory, 'expanded-input.json'), expandedInput)
  save(path.join(directory, 'case.json'), entry)

  const checks: Check[] = []
  const stages: Array<{ name: string; snapshot: Snapshot }> = []
  const operations: Row[] = []
  let store: EvidenceStore | undefined
  let error: string | null = null
  let savedRef: AmbientEvidenceRef | null = null
  let referenceOrigin: string | null = null
  let finalReadback: Tables | null = null
  let expectedSpeech = speechRow(speech)
  const expectedAudio = new Map([...audio].map(([key, moment]) => [key, audioRow(moment)]))
  let expected = { ...fixture.common.expected, ...entry.expectedBefore }

  try {
    const { EvidenceStore: Store } = await import('../../apps/desktop/src/main/dailyReview/evidenceStore')
    store = new Store(file)
    store.upsertSession(fixture.common.session)
    for (const moment of audio.values()) store.appendAudioMoment(moment)
    store.appendSpeechSegments([speech])
    for (const signal of calls) store.appendCallSignal(signal)
    for (const item of context) store.appendContextMoment(speech.workdayId, item.moment, null, item.bundleId)

    const initialProjection = store.ambientTasks.resolveSource(`speech:${speech.id}`)
    savedRef = initialProjection ?? {
      kind: 'speech',
      sourceId: speech.id,
      workdayId: speech.workdayId,
      observedAt: speech.endedAt,
      revision: hash(speech.text),
    }
    referenceOrigin = initialProjection
      ? 'Actual initial resolver projection; presence is not live provenance or authorization.'
      : 'Synthetic attempted reference from fixture input; initial projection was blocked, never accepted or offered.'
    save(path.join(directory, 'saved-reference.json'), { reference: savedRef, origin: referenceOrigin })
    const currentRef = savedRef
    const capture = (name: string) => {
      assert(store)
      const current = snapshot(store, file, currentRef)
      const first = stages[0]?.snapshot ?? current
      const observations: Expected = {
        resolveSource: current.latest ? 'present' : 'null',
        resolveSavedRef: current.saved ? 'present' : 'null',
        projectionEqualsBefore: isDeepStrictEqual(current.latest, first.latest),
        savedResolutionEqualsBefore: isDeepStrictEqual(current.saved, first.saved),
        latestObservedAtMatchesStoredEnd: current.latestObservedAtMatchesStoredEnd,
        savedObservedAtMatchesStoredEnd: current.savedObservedAtMatchesStoredEnd,
      }
      recordCheck(checks, `${name}: resolver observations`, observations, expected)
      checkRows(checks, `${name}: speech`, current.tables.speech, [expectedSpeech])
      checkRows(checks, `${name}: audio`, current.tables.audio, [...expectedAudio.values()])
      checkRows(
        checks,
        `${name}: call signals`,
        current.tables.calls,
        calls.map((signal) => ({
          id: signal.id,
          workday_id: signal.workdayId,
          provider: signal.provider,
          surface_key: signal.surfaceKey,
          state: signal.state,
          observed_at: signal.observedAt,
        }))
      )
      checkRows(
        checks,
        `${name}: context`,
        current.tables.context,
        context.map(({ moment, bundleId }) => ({
          id: moment.id,
          workday_id: speech.workdayId,
          timestamp: moment.timestamp,
          text: moment.text,
          window_title: moment.windowTitle,
          app_name: moment.appName,
          bundle_id: bundleId,
          url: moment.url ?? '',
          text_source: moment.textSource,
          trigger: moment.trigger,
        }))
      )
      recordCheck(checks, `${name}: no offline confound`, current.tables.offline, [])
      recordCheck(checks, `${name}: no task or notification effects`, current.tables.effectCounts, {
        workItems: 0,
        notifications: 0,
      })
      stages.push({ name, snapshot: current })
      save(path.join(directory, `${name}.json`), { observations, expected, snapshot: current })
    }

    capture('before')
    for (const step of entry.steps ?? []) {
      if (step.kind === 'upsert-speech') {
        const segment = { ...speech, ...step.patch }
        operations.push({ name: step.name, method: 'EvidenceStore.appendSpeechSegments', input: [segment] })
        store.appendSpeechSegments([segment])
      } else if (step.kind === 'upsert-audio') {
        const moment = { ...fixture.common.audio[step.audioKey], ...step.patch }
        operations.push({ name: step.name, method: 'EvidenceStore.appendAudioMoment', input: moment })
        store.appendAudioMoment(moment)
        expectedAudio.set(step.audioKey, audioRow(moment))
      } else {
        assert.equal(entry.id, 'SP-10-time-freshness', 'Raw SQL is reserved for the explicit adversarial case')
        operations.push({ name: step.name, method: 'raw SQLite UPDATE; not a native/store API', input: step })
        const db = new DatabaseSync(file)
        try {
          const result = db
            .prepare('UPDATE speech_segment SET started_at = ?, ended_at = ? WHERE id = ? AND workday_id = ?')
            .run(step.startedAt, step.endedAt, speech.id, speech.workdayId)
          assert.equal(result.changes, 1, 'Only the exact own speech row may change')
        } finally {
          db.close()
        }
      }
      save(path.join(directory, 'operations.json'), operations)
      expectedSpeech = { ...expectedSpeech, ...step.expectedStoredSpeechPatch }
      expected = { ...fixture.common.expected, ...step.expected }
      capture(step.name)
    }
    capture('after')
    store.close()
    store = undefined
    store = new Store(file)
    capture('reopened')
  } catch (caught) {
    error = caught instanceof Error ? (caught.stack ?? caught.message) : String(caught)
  } finally {
    try {
      store?.close()
    } catch (caught) {
      error = [error, `Close failed: ${String(caught)}`].filter(Boolean).join('\n')
    }
    if (existsSync(file)) {
      try {
        finalReadback = readRows(file, speech.workdayId)
        save(path.join(directory, 'after-close-readonly-tables.json'), finalReadback)
        const last = stages.at(-1)
        if (last) recordCheck(checks, 'closed DB exact readback', finalReadback, last.snapshot.tables)
      } catch (caught) {
        error = [error, `Read-only final readback failed: ${String(caught)}`].filter(Boolean).join('\n')
      }
    }
  }

  const result = {
    id: entry.id,
    title: entry.title,
    status: error
      ? 'audit_error'
      : checks.every((check) => check.matched)
        ? 'observations_match'
        : 'observation_mismatch',
    database: file,
    databaseRetained: existsSync(file),
    databaseSHA256AfterClose: existsSync(file) ? hash(readFileSync(file)) : null,
    error,
    checks,
    savedRef,
    referenceOrigin,
    stages,
    operations,
    finalReadback,
    syntheticTruth: fixture.syntheticTruth,
    reachability: entry.reachability,
    interpretation: entry.interpretation,
    semanticAssessment: 'not_assessed',
    authorizesAutomaticAction: false,
  }
  save(path.join(directory, 'result.json'), result)
  return result
}

async function main() {
  assert.deepEqual(process.argv.slice(2), ['--run'], 'Use exactly --run. No probe or output is created without it.')
  const fixtureText = readFileSync(fixturePath, 'utf8')
  const fixture: Fixture = JSON.parse(fixtureText)
  assert.equal(fixture.version, 'source-provenance.v1')
  assert.equal(fixture.authoredBeforeExecution, true)
  assert.equal(fixture.cases.length, 12)
  assert.equal(new Set(fixture.cases.map((entry) => entry.id)).size, 12)
  for (const entry of fixture.cases) assert.match(entry.id, /^SP-\d{2}-[a-z-]+$/)

  mkdirSync(runParent, { recursive: true })
  const run = mkdtempSync(path.join(runParent, `${new Date().toISOString().replaceAll(':', '-')}-`))
  const receipt = {
    experiment: 'E03.7-source-provenance',
    startedAt: new Date().toISOString(),
    pid: process.pid,
    run,
    fixtureSHA256: hash(fixtureText),
    scriptSHA256: hash(readFileSync(fileURLToPath(import.meta.url))),
    storageSourcesSHA256: Object.fromEntries(
      ['evidenceStore.ts', 'ambientTaskStore.ts'].map((file) => [
        file,
        hash(readFileSync(path.join(root, 'apps/desktop/src/main/dailyReview', file))),
      ])
    ),
    status: 'running',
    limits: fixture.limits,
  }
  save(path.join(run, 'manifest.json'), receipt)
  writeFileSync(path.join(run, 'fixture.json'), fixtureText)
  console.log(run)

  const results: Awaited<ReturnType<typeof auditCase>>[] = []
  for (const entry of fixture.cases) results.push(await auditCase(run, entry, fixture))
  const checks: Check[] = []
  const reference = results.find((result) => result.id === fixture.crossCaseProjectionEquality.reference)
  assert(reference)
  for (const phase of ['before', 'after'] as const) {
    const base: Snapshot['latest'] | undefined = reference.stages.find((stage) => stage.name === phase)?.snapshot.latest
    recordCheck(checks, `${phase}: reference projection exists`, base !== undefined && base !== null, true)
    for (const id of fixture.crossCaseProjectionEquality[`${phase}Equal`]) {
      const actual = results.find((result) => result.id === id)?.stages.find((stage) => stage.name === phase)
        ?.snapshot.latest
      recordCheck(checks, `${phase}: ${id} equals missing-metadata projection`, actual, base)
    }
  }
  const matched =
    results.every((result) => result.status === 'observations_match') && checks.every((check) => check.matched)
  save(path.join(run, 'report.json'), {
    ...receipt,
    completedAt: new Date().toISOString(),
    status: matched ? 'completed_observations_match' : 'completed_with_mismatch',
    results,
    crossCaseChecks: checks,
    semanticAssessment: 'not_assessed',
    nativeOrigin: 'unknown',
    authorization: 'not_established_by_this_audit',
    restartBoundary: 'EvidenceStore close/reopen in one runner; no app/process restart claim.',
  })
  save(path.join(run, 'manifest.json'), {
    ...receipt,
    completedAt: new Date().toISOString(),
    status: matched ? 'completed_observations_match' : 'completed_with_mismatch',
  })
  if (!matched) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
