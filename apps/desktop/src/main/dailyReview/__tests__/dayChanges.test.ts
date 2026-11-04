import assert from 'node:assert/strict'
import { test } from 'node:test'
import { serialize } from 'node:v8'
import { applyDayChanges, buildDayChanges, type Day, type DayChanges, type DaySnapshot } from '@remember/shared'
import { createDaySnapshotPublisher } from '../daySnapshotPublisher'

function day(id: string): Day {
  return {
    id,
    startedAt: 1_000,
    endedAt: null,
    activeDurationMs: 0,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
    ongoingConversations: [],
    conversationCandidates: [],
    recoverableConversationBlocks: [],
    retainedAudioMomentIds: [],
  }
}

function context(id: string): Day['contextMoments'][number] {
  return {
    id,
    timestamp: 1_000,
    appName: 'Editor',
    windowTitle: 'Synthetic local work',
    text: `Evidence ${id}`,
    textSource: 'accessibility',
    trigger: 'window-change',
    monitorName: 'Built-in',
    screenshotPath: '',
  }
}

test('capture deltas preserve historical days and transfer only appended or edited evidence suffixes', () => {
  const previous: DaySnapshot = {
    revision: 3,
    days: [
      {
        ...day('today'),
        moments: [
          {
            id: 'audio',
            sessionId: 'today',
            source: 'microphone',
            startedAt: 1_000,
            durationMs: 5_000,
            status: 'transcribing',
            transcript: '',
          },
        ],
        contextMoments: [context('first'), context('second')],
        appActivity: [
          { id: 'activity', appName: 'Editor', bundleId: 'example.editor', startedAt: 1_000, endedAt: null },
        ],
      },
      { ...day('yesterday'), contextMoments: [context('historic')] },
    ],
  }
  const current = previous.days[0]
  const next: Day = {
    ...current,
    activeDurationMs: 5_000,
    moments: [{ ...current.moments[0], status: 'ready', transcript: 'Ready transcript' }],
    contextMoments: [...current.contextMoments, context('third')],
    appActivity: [{ ...current.appActivity[0], endedAt: 6_000 }],
  }
  const update = buildDayChanges(previous, [next, previous.days[1]])
  assert.ok(update)
  assert.equal(update.changes.length, 1)
  assert.deepEqual(update.changes[0].contextMoments, { start: 2, items: [context('third')] })
  assert.equal(update.changes[0].moments?.start, 0)
  assert.equal(update.changes[0].appActivity?.start, 0)
  assert.equal('contextMoments' in update.changes[0].day, false)
  const renderer = structuredClone(previous)
  const result = applyDayChanges(renderer, structuredClone(update))
  assert.ok(result)
  assert.deepEqual(result.days, [next, previous.days[1]])
  assert.equal(result.days[1], renderer.days[1])
  assert.equal(result.days[0].contextMoments[0], renderer.days[0].contextMoments[0])
})

test('new days, removed evidence, reordering, deletion, and reset replay without retaining removed data', () => {
  let snapshot: DaySnapshot = { revision: 0, days: [] }
  const today = { ...day('today'), contextMoments: [context('keep'), context('remove')] }
  const historical = day('history')
  for (const next of [
    [today, historical],
    [historical, { ...today, contextMoments: [today.contextMoments[0]] }],
    [historical],
    [],
  ]) {
    const update = buildDayChanges(snapshot, next)
    assert.ok(update)
    const applied = applyDayChanges(snapshot, update)
    assert.ok(applied)
    assert.deepEqual(applied.days, next)
    snapshot = applied
  }
  assert.deepEqual(snapshot, { revision: 4, days: [] })
})

test('fresh equivalent runtime projections do not retransmit unchanged history or large memory', () => {
  const original = day('today')
  const snapshot = { revision: 5, days: [original] }
  assert.equal(
    buildDayChanges(snapshot, [
      {
        ...original,
        moments: [...original.moments],
        contextMoments: [...original.contextMoments],
        appActivity: [...original.appActivity],
        ongoingConversations: [],
        conversationCandidates: [],
        recoverableConversationBlocks: [],
        retainedAudioMomentIds: [],
      },
    ]),
    null
  )
  const update = buildDayChanges(snapshot, [{ ...original, endedAt: 2_000 }])
  assert.ok(update)
  assert.deepEqual(Object.keys(update.changes[0]), ['day'])
})

test('old events are harmless and missing revisions or invalid suffixes require a fresh snapshot', () => {
  const snapshot: DaySnapshot = { revision: 7, days: [day('today')] }
  const update = buildDayChanges(snapshot, [{ ...snapshot.days[0], endedAt: 5_000 }])
  assert.ok(update)
  const applied = applyDayChanges(snapshot, update)
  assert.ok(applied)
  assert.equal(applyDayChanges(applied, update), applied)
  assert.equal(applyDayChanges({ ...snapshot, revision: 6 }, update), null)
  assert.equal(
    applyDayChanges(snapshot, {
      ...update,
      changes: [{ ...update.changes[0], contextMoments: { start: 1, items: [] } }],
    }),
    null
  )
  assert.equal(applyDayChanges(snapshot, { ...update, order: ['missing'] }), null)
  assert.equal(applyDayChanges(snapshot, { ...update, order: ['today', 'today'] }), null)
  assert.equal(applyDayChanges({ revision: 7, days: [] }, update), null)
})

test('publisher announces its new revision before serving snapshots and supports a restarted renderer', () => {
  const events: DayChanges[] = []
  const publisher = createDaySnapshotPublisher((event) => {
    assert.equal(publisher.snapshot().revision, event.revision)
    events.push(event)
  })
  const original = day('today')
  const initial = publisher.update([original])
  assert.equal(initial.revision, 1)
  const latest = publisher.update([{ ...original, contextMoments: [context('captured')] }])
  assert.equal(latest.revision, 2)
  assert.deepEqual(applyDayChanges(structuredClone(initial), events[1]), latest)
  assert.equal(publisher.update(latest.days), latest)
  assert.equal(events.length, 2)
  const restarted = structuredClone(publisher.snapshot())
  assert.equal(applyDayChanges(restarted, events[0]), restarted)
  const reset = publisher.update([])
  assert.deepEqual(applyDayChanges(restarted, events[2]), reset)
})

test('one new capture has a bounded transport payload regardless of retained context size', () => {
  const retained = Array.from({ length: 10_000 }, (_, index) => ({
    ...context(String(index)),
    text: 'Synthetic evidence. '.repeat(50),
  }))
  const original = { ...day('large-day'), contextMoments: retained }
  const snapshot = { revision: 1, days: [original] }
  const update = buildDayChanges(snapshot, [{ ...original, contextMoments: [...retained, context('new')] }])
  assert.ok(update)
  assert.ok(serialize(snapshot.days).length > 9_000_000)
  assert.ok(serialize(update).length < 2_000)
  assert.equal(update.changes[0].contextMoments?.start, 10_000)
  assert.equal(update.changes[0].contextMoments?.items.length, 1)
})
