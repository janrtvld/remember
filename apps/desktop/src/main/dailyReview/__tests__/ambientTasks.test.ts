import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import type { DailyReviewSession, SpeechSegment } from '@remember/shared'
import { selectAgentTasks } from '../../residentAgentPrivacy'
import { ResidentAgentStore } from '../../residentAgentStore'
import { DEFAULT_SETTINGS } from '../../settingsStore'
import { parseAmbientTaskPlan } from '../ambientTaskPolicy'
import { createAmbientTaskAuthority, createAmbientTaskWorker } from '../ambientTaskWorker'
import { EvidenceStore } from '../evidenceStore'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})
const text = 'Jan, stuur morgen de offerte naar de klant.'

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'remember-ambient-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'evidence.sqlite')
  let store = new EvidenceStore(path)
  cleanups.push(() => store.close())
  const day: DailyReviewSession = {
    id: 'day',
    startedAt: Date.now() - 60_000,
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
      store = new EvidenceStore(path)
    },
  }
}
function context(store: EvidenceStore, id = 'screen', content = text, workdayId = 'day', timestamp = Date.now()) {
  store.appendContextMoment(
    workdayId,
    {
      id,
      timestamp,
      text: content,
      appName: 'Mail',
      windowTitle: 'Offerte',
      textSource: 'accessibility',
      trigger: 'content-change',
      monitorName: '',
      screenshotPath: '',
    },
    null
  )
}
function speech(
  store: EvidenceStore,
  id = 'segment',
  content = text,
  rejectionReason: SpeechSegment['rejectionReason'] = null
) {
  store.appendAudioMoment(
    {
      id: `audio-${id}`,
      sessionId: 'day',
      source: 'microphone',
      startedAt: Date.now() - 10_000,
      durationMs: 10_000,
      status: 'ready',
      transcript: content,
    },
    0.4
  )
  store.appendSpeechSegments([
    {
      id,
      workdayId: 'day',
      chunkId: `audio-${id}`,
      source: 'microphone',
      startedAt: Date.now() - 9_000,
      endedAt: Date.now() - 1_000,
      text: content,
      detectedLanguage: 'nl',
      acceptedLanguage: 'nl',
      rejectionReason,
    },
  ])
}
function output(evidenceId = 'screen', quote = text) {
  return {
    consideredEvidenceIds: [evidenceId],
    proposed: [
      {
        id: null,
        title: 'Stuur de offerte',
        description: 'Stuur de offerte naar de klant.',
        prompt: '',
        aiSuggestion: null,
        context: quote,
        returnPoint: { lastMove: '', unresolved: '', nextMove: 'Stuur de offerte.' },
        source: {
          kind: 'task',
          evidenceId,
          label: 'Offerte',
          detail: 'Toegezegd in gesprek',
          conversationStartTime: null,
        },
        evidenceQuote: quote,
        ownership: 'user',
        notify: true,
      },
    ],
    changes: [],
  }
}
function apply(store: EvidenceStore, evidence: ReturnType<EvidenceStore['ambientTasks']['batch']>, result = output()) {
  const plan = parseAmbientTaskPlan(result, evidence, 'Jan', store.listWorkItems())
  store.applyAnalyzedWorkItems({
    workdayId: evidence[0]?.workdayId ?? 'day',
    plan,
    conversations: [],
    analysisStartedAt: Date.now(),
    observedAt: Date.now(),
    ambientBatch: {
      evidence: evidence.filter((entry) => plan.consideredEvidenceIds.includes(entry.evidenceId)),
      notifyTitles: plan.notifyTitles,
    },
  })
}
const allow = () => true

test('repeated commitment frames reuse durable identity after title edits and never recreate closed work', () => {
  const f = fixture()
  context(f.store)
  apply(f.store, f.store.ambientTasks.batch(Date.now() + 31_000, allow, allow))
  const item = f.store.listWorkItems()[0]
  assert(item)
  f.store.updateWorkItem(item.id, 'Mijn eigen titel', item.description)
  f.reopen()
  context(f.store, 'second-frame', `${text} Nieuw gelezen bericht.`)
  apply(f.store, f.store.ambientTasks.batch(Date.now() + 31_000, allow, allow), output('second-frame'))
  assert.equal(f.store.listWorkItems().length, 1)
  assert.equal(f.store.getWorkItem(item.id)?.title, 'Mijn eigen titel')
  assert.equal(f.store.ambientTasks.taskSourceIds(item.id).length, 2)
  f.store.setWorkItemLifecycle(item.id, 'completed')
  f.reopen()
  context(f.store, 'third-frame', `${text} Nog een gelezen bericht.`)
  apply(f.store, f.store.ambientTasks.batch(Date.now() + 31_000, allow, allow), output('third-frame'))
  assert.equal(f.store.listWorkItems().length, 1)
  assert.equal(f.store.getWorkItem(item.id)?.lifecycle, 'completed')
})

test('old task-derived content is withheld after source exclusion or deletion and deletion persists across restart', () => {
  const f = fixture()
  context(f.store)
  apply(f.store, f.store.ambientTasks.batch(Date.now() + 31_000, allow, allow))
  const select = (settings = DEFAULT_SETTINGS) =>
    selectAgentTasks(f.store.listWorkItems(), {
      days: f.store.readSessions(),
      settings,
      provenance: f.store.ambientTasks,
    })
  assert.equal(select().length, 1)
  assert.equal(
    select({ ...DEFAULT_SETTINGS, appCaptureMode: 'include', includedAppBundleIds: ['different.app'] }).length,
    0
  )
  let emitted = 0
  f.store.subscribeEvidenceDeletion(() => {
    emitted++
  })
  const revision = f.store.deletionRevision()
  f.store.deleteEvidenceSince(Date.now() - 1_000)
  assert.equal(emitted, 1)
  assert.equal(f.store.deletionRevision(), revision + 1)
  f.reopen()
  assert.equal(f.store.deletionRevision(), revision + 1)
  assert.equal(select().length, 0)
  context(f.store, 'new-public', 'Jan, werk de openbare planning bij voor vrijdag.')
  assert.equal(select().length, 0, 'a fresh allowed input must not re-admit the old derived task')
})

test('a new next-day occurrence may create work after completion while open commitments continue across days', () => {
  for (const complete of [false, true]) {
    const f = fixture()
    context(f.store)
    apply(f.store, f.store.ambientTasks.batch(Date.now() + 31_000, allow, allow))
    const item = f.store.listWorkItems()[0]
    const day = f.store.readSessions()[0]
    assert(item && day)
    if (complete) f.store.setWorkItemLifecycle(item.id, 'completed')
    f.store.upsertSession({
      ...day,
      id: 'tomorrow',
      localDay: undefined,
      startedAt: day.startedAt + 24 * 60 * 60_000,
      contextMoments: [],
    })
    context(f.store, 'next-day', `${text} Nieuwe expliciete opdracht vandaag.`, 'tomorrow')
    apply(f.store, f.store.ambientTasks.batch(Date.now() + 31_000, allow, allow), output('next-day'))
    f.reopen()
    assert.equal(f.store.listWorkItems().length, complete ? 2 : 1)
    assert.equal(f.store.listWorkItems().filter((entry) => entry.lifecycle === 'open').length, 1)
  }
})

test('a Day analysis started before live processing cannot mutate tasks after enablement or a quick disable', () => {
  const f = fixture()
  context(f.store)
  const authority = createAmbientTaskAuthority()
  const oldDayToken = authority.dayAnalysisToken()
  const evidence = f.store.ambientTasks.batch(Date.now() + 31_000, allow, allow)
  const oldDayPlan = parseAmbientTaskPlan(output(), evidence, 'Jan', [])
  authority.update(true)
  apply(f.store, evidence)
  const item = f.store.listWorkItems()[0]
  assert(item)
  f.store.setWorkItemLifecycle(item.id, 'completed')
  assert.equal(authority.canApplyDayAnalysis(oldDayToken), false)
  assert.equal(authority.dayAnalysisToken(), null)
  authority.update(false)
  if (authority.canApplyDayAnalysis(oldDayToken)) {
    f.store.applyAnalyzedWorkItems({
      workdayId: 'day',
      plan: oldDayPlan,
      conversations: [],
      analysisStartedAt: Date.now(),
      observedAt: Date.now(),
    })
  }
  assert.equal(f.store.listWorkItems().length, 1)
  assert.equal(f.store.getWorkItem(item.id)?.lifecycle, 'completed')
  assert.equal(authority.canApplyDayAnalysis(authority.dayAnalysisToken()), true)
})

test('a model budget deferral acknowledges only fully considered sources and preserves the next batch', () => {
  const f = fixture()
  context(f.store)
  context(f.store, 'second', 'Jan, stuur vrijdag ook de aangepaste planning naar de klant.')
  const evidence = f.store.ambientTasks.batch(Date.now() + 31_000, allow, allow)
  assert.equal(evidence.length, 2)
  apply(f.store, evidence)
  f.reopen()
  assert.deepEqual(
    f.store.ambientTasks.batch(Date.now() + 31_000, allow, allow).map((entry) => entry.evidenceId),
    ['second']
  )
  assert.throws(
    () => parseAmbientTaskPlan({ ...output(), consideredEvidenceIds: [] }, evidence, 'Jan', []),
    /ambient-analysis-deferred/
  )
})

test('deleted or revised task sources fail closed for downstream chat and notifications', () => {
  const f = fixture()
  speech(f.store)
  apply(f.store, f.store.ambientTasks.batch(Date.now() + 3_000, allow, allow), output('speech:segment'))
  const item = f.store.listWorkItems()[0]
  assert(item)
  assert.equal(f.store.ambientTasks.taskEvidence(item.id).length, 1)
  speech(f.store, 'segment', 'Een gewijzigde context zonder de originele toezegging.')
  assert.equal(f.store.ambientTasks.hasTaskSources(item.id), true)
  assert.deepEqual(f.store.ambientTasks.taskEvidence(item.id), [])
  f.store.deleteEvidenceSince(Date.now() - 20_000)
  assert.equal(f.store.ambientTasks.hasTaskSources(item.id), true)
  assert.deepEqual(f.store.ambientTasks.taskEvidence(item.id), [])
})

test('source acknowledgments and task mutation commit together and survive replay/restart', () => {
  const f = fixture()
  context(f.store)
  const evidence = f.store.ambientTasks.batch(Date.now() + 31_000, allow, allow)
  assert.equal(evidence.length, 1)
  apply(f.store, evidence)
  f.reopen()
  assert.equal(f.store.ambientTasks.batch(Date.now() + 31_000, allow, allow).length, 0)
  context(f.store)
  assert.equal(f.store.ambientTasks.batch(Date.now() + 31_000, allow, allow).length, 0)
  assert.equal(f.store.listWorkItems().length, 1)
  const id = f.store.listWorkItems()[0]?.id
  assert.equal(f.store.ambientTasks.takeNotification(Date.now()), id)
  f.reopen()
  assert.equal(f.store.ambientTasks.takeNotification(Date.now() + 61_000), null)
})

test('notification delivery rechecks current source privacy and remains deduplicated across worker restarts', async () => {
  for (const revoked of [false, true]) {
    const f = fixture()
    context(f.store)
    apply(f.store, f.store.ambientTasks.batch(Date.now() + 31_000, allow, allow))
    let delivered = 0
    let suggested = 0
    const makeWorker = (accept: () => boolean) =>
      createAmbientTaskWorker({
        store: f.store.ambientTasks,
        policy: () => 'enabled',
        allowed: allow,
        accept,
        items: () => f.store.listWorkItems(),
        analyze: async () => {
          throw new Error('no pending evidence expected')
        },
        apply: () => assert.fail('already committed'),
        changed: () => {},
        notify: () => {
          delivered++
        },
        suggest: () => {
          suggested++
          return true
        },
        notificationsSupported: () => true,
        error: (error) => assert.fail(String(error)),
        now: () => Date.now() + 31_000,
      })
    const first = makeWorker(() => !revoked)
    await first.tick()
    await first.stop()
    assert.equal(delivered, revoked ? 0 : 1)
    assert.equal(suggested, revoked ? 0 : 1)
    f.reopen()
    const restarted = makeWorker(allow)
    await restarted.tick()
    await restarted.stop()
    assert.equal(delivered, revoked ? 0 : 1)
    assert.equal(suggested, revoked ? 0 : 1)
  }
})

test('late analysis may recover an old task without presenting the old evidence as a timely alert', () => {
  const f = fixture()
  context(f.store, 'old-frame', text, 'day', Date.now() - 3 * 60 * 60_000)
  apply(f.store, f.store.ambientTasks.batch(Date.now() + 31_000, allow, allow), output('old-frame'))
  assert.equal(f.store.listWorkItems().length, 1)
  assert.equal(f.store.ambientTasks.takeNotification(Date.now()), null)
  assert.equal(f.store.ambientTasks.nextSuggestion(Date.now()), null)
  f.reopen()
  assert.equal(f.store.ambientTasks.takeNotification(Date.now()), null)
  assert.equal(f.store.ambientTasks.nextSuggestion(Date.now()), null)
})

test('proactive chat offers are durable across a crash between chat commit and outbox acknowledgement', async () => {
  const f = fixture()
  const directory = mkdtempSync(join(tmpdir(), 'remember-ambient-chat-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'assistant.sqlite')
  let chat = new ResidentAgentStore(path)
  cleanups.push(() => chat.close())
  context(f.store)
  apply(f.store, f.store.ambientTasks.batch(Date.now() + 31_000, allow, allow))
  let acknowledged = false
  let writes = 0
  const makeWorker = () =>
    createAmbientTaskWorker({
      store: f.store.ambientTasks,
      policy: () => 'enabled',
      allowed: allow,
      accept: allow,
      items: () => f.store.listWorkItems(),
      analyze: async () => assert.fail('already analyzed'),
      apply: () => assert.fail('already committed'),
      changed: () => {},
      notify: () => assert.fail('native notifications are independent'),
      notificationsSupported: () => false,
      suggest: (item, sources) => {
        writes++
        const accepted = chat.appendTaskSuggestion({
          eventId: `ambient-task:${item.id}`,
          taskId: item.id,
          evidenceIds: sources.map((source) => source.evidenceId),
          text: `Nieuwe taak: [${item.title}](/inbox/?item=${item.id})`,
          provider: 'codex',
          createdAt: item.createdAt,
        })
        return accepted && acknowledged
      },
      error: (error) => assert.fail(String(error)),
      now: () => Date.now() + 31_000,
    })
  const first = makeWorker()
  await first.tick()
  await first.stop()
  assert.equal(chat.conversation(null).messages.length, 1)
  assert.deepEqual(chat.history(), [])
  assert(f.store.ambientTasks.nextSuggestion(Date.now()))
  chat.close()
  chat = new ResidentAgentStore(path)
  f.reopen()
  acknowledged = true
  const restarted = makeWorker()
  await restarted.tick()
  await restarted.tick()
  await restarted.stop()
  assert.equal(writes, 2)
  assert.equal(chat.conversation(null).messages.length, 1)
  assert.deepEqual(chat.history(), [], 'archived source text must never be recycled as provider chat history')
  assert.equal(f.store.ambientTasks.nextSuggestion(Date.now()), null)
})

test('live speech supports a task before any conversation exists, but invented/unscoped speech ids do not', () => {
  const f = fixture()
  speech(f.store)
  assert.equal(f.store.listConversationEpisodes('day').length, 0)
  const evidence = f.store.ambientTasks.batch(Date.now() + 3_000, allow, allow)
  const plan = parseAmbientTaskPlan(output('speech:segment'), evidence, 'Jan', [])
  f.store.applyAnalyzedWorkItems({
    workdayId: 'day',
    plan,
    conversations: [],
    analysisStartedAt: Date.now(),
    observedAt: Date.now(),
  })
  assert.equal(f.store.listWorkItems().length, 0, 'speech source needs the verified ambient batch')
  apply(f.store, evidence, output('speech:segment'))
  assert.equal(f.store.listWorkItems().length, 1)
})

test('microphone first-person speech and unknown ownership never impersonate the enrolled user', () => {
  const f = fixture()
  speech(f.store, 'unknown', 'Ik stuur morgen de offerte naar de klant.')
  const evidence = f.store.ambientTasks.batch(Date.now() + 3_000, allow, allow)
  const first = evidence[0]
  assert(first)
  assert.equal(parseAmbientTaskPlan(output('speech:unknown', first.text), evidence, 'Jan', []).proposed.length, 0)
  assert.equal(parseAmbientTaskPlan(output('speech:unknown', first.text), evidence, null, []).proposed.length, 0)
  const candidate = output('speech:unknown', first.text)
  const task = candidate.proposed[0]
  assert(task)
  task.ownership = 'unknown'
  assert.equal(parseAmbientTaskPlan(candidate, evidence, 'Jan', []).proposed.length, 0)
})

test('unmatched quotes, quarantined speech and offline speech do not become tasks', () => {
  const f = fixture()
  context(f.store)
  const evidence = f.store.ambientTasks.batch(Date.now() + 31_000, allow, allow)
  assert.equal(
    parseAmbientTaskPlan(output('screen', 'Jan heeft iets anders afgesproken.'), evidence, 'Jan', []).proposed.length,
    0
  )
  speech(f.store, 'rejected', text, 'cross-language-short')
  assert.equal(
    f.store.ambientTasks.pending(Date.now() + 31_000, allow).some((ref) => ref.sourceId === 'rejected'),
    false
  )
  f.store.beginOfflinePeriod(Date.now() - 20_000)
  speech(f.store, 'offline')
  f.store.endOfflinePeriod(Date.now())
  assert.equal(
    f.store.ambientTasks.batch(Date.now() + 31_000, allow, allow).some((ref) => ref.sourceId === 'offline'),
    false
  )
})

test('exact source lookup returns current accepted evidence and cannot borrow a matching timestamp', () => {
  const f = fixture()
  context(f.store, 'wiki-context')
  speech(f.store, 'wiki-speech')
  speech(f.store, 'rejected', text, 'cross-language-short')
  assert.equal(f.store.ambientTasks.resolveSource('wiki-context')?.evidenceId, 'wiki-context')
  assert.equal(f.store.ambientTasks.resolveSource('speech:wiki-speech')?.evidenceId, 'speech:wiki-speech')
  assert.equal(f.store.ambientTasks.resolveSource('speech:rejected'), null)
  assert.equal(f.store.ambientTasks.resolveSource('different-context-at-same-time'), null)
  f.store.beginOfflinePeriod(Date.now() - 20_000)
  assert.equal(f.store.ambientTasks.resolveSource('speech:wiki-speech'), null)
  assert.equal(f.store.ambientTasks.resolveSource('wiki-context'), null)
  f.store.endOfflinePeriod(Date.now())
  f.store.deleteEvidenceSince(Date.now() - 20_000)
  assert.equal(f.store.ambientTasks.resolveSource('speech:wiki-speech'), null)
  assert.equal(f.store.ambientTasks.resolveSource('wiki-context'), null)
})

test('batches stay bounded without dropping later sources or late transcript arrivals', () => {
  const f = fixture()
  for (let i = 0; i < 16; i++) context(f.store, `context-${i}`, `${i} ${'a'.repeat(5_000)}`)
  const first = f.store.ambientTasks.batch(Date.now() + 31_000, allow, allow)
  assert.equal(first.length, 9)
  assert(first.reduce((total, entry) => total + entry.text.length, 0) <= 48_000)
  f.store.ambientTasks.acknowledge(first, Date.now())
  speech(f.store, 'late')
  const second = f.store.ambientTasks.batch(Date.now() + 31_000, allow, allow)
  assert.equal(second.length, 8)
  assert(second.some((entry) => entry.sourceId === 'late'))
})

test('failed inference retains evidence; pause during inference prevents commit and restart can retry', async () => {
  const f = fixture()
  context(f.store)
  let now = Date.now() + 31_000
  let policy: string | null = 'enabled'
  let attempts = 0
  let errors = 0
  let release: (() => void) | undefined
  const worker = createAmbientTaskWorker({
    store: f.store.ambientTasks,
    policy: () => policy,
    allowed: allow,
    accept: allow,
    items: () => f.store.listWorkItems(),
    analyze: async (evidence) => {
      attempts++
      if (attempts === 1) throw new Error('transient-provider-failure')
      if (attempts === 2)
        await new Promise<void>((resolve) => {
          release = resolve
        })
      return parseAmbientTaskPlan(output(), evidence, 'Jan', [])
    },
    apply: (evidence) => apply(f.store, evidence),
    changed: () => {},
    notify: () => {},
    notificationsSupported: () => false,
    error: () => {
      errors++
    },
    now: () => now,
  })
  await worker.tick()
  assert.equal(errors, 1)
  assert.equal(f.store.listWorkItems().length, 0)
  now += 31_000
  const running = worker.tick()
  policy = null
  const paused = worker.tick()
  release?.()
  await Promise.all([running, paused])
  assert.equal(f.store.listWorkItems().length, 0)
  policy = 'enabled'
  await worker.tick()
  assert.equal(f.store.listWorkItems().length, 1)
  await worker.stop()
})

test('deleting a source during inference cannot recreate a task or advance another source revision', () => {
  const f = fixture()
  context(f.store)
  const evidence = f.store.ambientTasks.batch(Date.now() + 31_000, allow, allow)
  f.store.deleteEvidenceSince(Date.now() - 1_000)
  assert.throws(() => apply(f.store, evidence), /ambient-evidence-changed/)
  assert.equal(f.store.listWorkItems().length, 0)
})

test('revoked source privacy during inference prevents a task and notification even without a policy-token change', async () => {
  const f = fixture()
  context(f.store)
  let accept = true
  const worker = createAmbientTaskWorker({
    store: f.store.ambientTasks,
    policy: () => 'enabled',
    allowed: allow,
    accept: () => accept,
    items: () => f.store.listWorkItems(),
    analyze: async (evidence) => {
      accept = false
      return parseAmbientTaskPlan(output(), evidence, 'Jan', [])
    },
    apply: (evidence) => apply(f.store, evidence),
    changed: () => {},
    notify: () => assert.fail('must not notify'),
    notificationsSupported: () => true,
    error: (error) => {
      throw error
    },
    now: () => Date.now() + 31_000,
  })
  await worker.tick()
  assert.equal(f.store.listWorkItems().length, 0)
  assert.equal(f.store.ambientTasks.takeNotification(Date.now() + 31_000), null)
  await worker.stop()
})

test('late accepted revisions invalidate the old batch and only the exact new revision can be acknowledged', () => {
  const f = fixture()
  speech(f.store)
  const old = f.store.ambientTasks.batch(Date.now() + 3_000, allow, allow)
  speech(f.store, 'segment', 'Jan, stuur morgen de gewijzigde offerte naar de klant.')
  assert.throws(() => apply(f.store, old, output('speech:segment')), /ambient-evidence-changed/)
  f.store.ambientTasks.acknowledge(old, Date.now())
  assert.equal(f.store.ambientTasks.batch(Date.now() + 3_000, allow, allow).length, 1)
})

test('ambient completion requires exact evidence and cannot overwrite a newer user lifecycle decision', () => {
  const f = fixture()
  const item = f.store.createWorkItem('Stuur de offerte', 'Stuur de offerte naar de klant.')
  const completed = 'Jan heeft de offerte naar de klant verstuurd.'
  context(f.store, 'completion', completed)
  const evidence = f.store.ambientTasks.batch(Date.now() + 31_000, allow, allow)
  const value = {
    consideredEvidenceIds: ['completion'],
    proposed: [],
    changes: [
      {
        id: item.id,
        title: item.title,
        type: 'completed',
        reason: 'Offerte is verstuurd.',
        replacementTitle: null,
        evidenceId: 'completion',
        evidenceQuote: completed,
        ownership: 'user',
      },
    ],
  }
  const plan = parseAmbientTaskPlan(value, evidence, 'Jan', [item])
  assert.equal(plan.changes.length, 1)
  f.store.setWorkItemLifecycle(item.id, 'completed')
  f.store.setWorkItemLifecycle(item.id, 'open')
  f.store.applyAnalyzedWorkItems({
    workdayId: 'day',
    plan,
    conversations: [],
    analysisStartedAt: item.updatedAt - 1,
    observedAt: Date.now(),
    ambientBatch: { evidence, notifyTitles: [] },
  })
  assert.equal(f.store.getWorkItem(item.id)?.lifecycle, 'open')
  assert.equal(f.store.ambientTasks.batch(Date.now() + 31_000, allow, allow).length, 0)
})
