import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DayAnalysisProvenance } from '@remember/shared'
import { withDayAnalysisValidation } from '../dayAnalysisValidation'

const settings = {
  excludePasswordManagers: true,
  excludePrivateBrowsing: true,
  appCaptureMode: 'exclude' as const,
  excludedAppBundleIds: [],
  includedAppBundleIds: [],
  websiteCaptureMode: 'exclude' as const,
  excludedWebsites: [],
  includedWebsites: [],
}

function fixture() {
  const state = { raw: true, task: true, wiki: true, rawReads: 0, taskReads: 0, wikiReads: 0 }
  const provenance: DayAnalysisProvenance = {
    version: 1,
    workdayId: 'day',
    startedAt: 1,
    coveredThrough: 2,
    rawEvidenceIds: [],
    rawSources: [],
    taskIds: ['task'],
    wikiPages: [{ spaceId: 'personal', slug: 'page', pageId: 'page', revisionId: 'revision' }],
    agentMessages: [],
  }
  const store = {
    proactive: {
      dayAnalysisSourcesPermitted() {
        state.rawReads++
        return state.raw
      },
    },
    listWorkItems() {
      state.taskReads++
      return state.task ? [{ id: 'task', sources: [{ kind: 'manual' }] }] : []
    },
    readTaskContextEvidence: () => [],
  } as unknown as Parameters<typeof withDayAnalysisValidation>[0]
  const checks = {
    wikiPage: (page: DayAnalysisProvenance['wikiPages'][number]) => {
      state.wikiReads++
      return state.wiki && page.revisionId === 'revision'
    },
    agentMessages: () => true,
  }
  const run = <T>(operation: Parameters<typeof withDayAnalysisValidation<T>>[3]) =>
    withDayAnalysisValidation(store, settings, checks, operation)
  return { state, provenance, run }
}

test('one synchronous validation reuses exact raw and Wiki inputs and permitted Task identities', () => {
  const f = fixture()
  f.run((validation) => {
    assert(validation.summaryPermitted(f.provenance))
    assert(validation.summaryPermitted(structuredClone(f.provenance)))
    assert(validation.permittedTaskIds().has('task'))
    assert.deepEqual(
      validation.permittedTasks().map((task) => task.id),
      ['task']
    )
    assert.deepEqual([f.state.rawReads, f.state.taskReads, f.state.wikiReads], [1, 1, 1])
    assert.equal(
      validation.summaryPermitted({
        ...f.provenance,
        wikiPages: [{ ...f.provenance.wikiPages[0], revisionId: 'unretained-revision' }],
      }),
      false
    )
    assert.equal(f.state.wikiReads, 2)
  })
})

test('raw deletion, revoked Wiki access and removed Tasks are rechecked on every invocation', () => {
  for (const revocation of ['raw', 'wiki', 'task'] as const) {
    const f = fixture()
    assert(f.run(({ summaryPermitted }) => summaryPermitted(f.provenance)))
    f.state[revocation] = false
    assert.equal(
      f.run(({ summaryPermitted }) => summaryPermitted(f.provenance)),
      false
    )
    assert.equal(f.state.rawReads, 2)
  }
})

test('shared Task context is read once per validation and revoked context is rechecked next time', () => {
  let reads = 0
  let available = true
  const store = {
    listWorkItems: () =>
      ['first', 'second'].map((id) => ({
        id,
        sources: [{ kind: 'observed', workdayId: 'day', observedAt: 1 }],
      })),
    readTaskContextEvidence: () => {
      reads++
      return available ? [{ kind: 'context', text: '', appName: 'Editor', bundleId: 'com.example.editor' }] : []
    },
  } as unknown as Parameters<typeof withDayAnalysisValidation>[0]
  const run = () =>
    withDayAnalysisValidation(
      store,
      settings,
      {
        wikiPage: () => true,
        agentMessages: () => true,
      },
      ({ permittedTaskIds }) => [...permittedTaskIds()]
    )
  assert.deepEqual(run(), ['first', 'second'])
  assert.equal(reads, 1)
  available = false
  assert.deepEqual(run(), [])
  assert.equal(reads, 2)
})

test('validation callbacks cannot outlive their operation or cross an await', () => {
  const f = fixture()
  const escaped = f.run((validation) => validation)
  assert.throws(() => escaped.summaryPermitted(f.provenance), /scope-closed/)
  assert.throws(() => escaped.permittedTaskIds(), /scope-closed/)
  assert.throws(() => escaped.permittedTasks(), /scope-closed/)
  assert.throws(() => escaped.evidencePermitted([]), /scope-closed/)
  assert.throws(() => escaped.daySourcePermitted({ kind: 'day', sourceId: 'day' }), /scope-closed/)
  assert.throws(() => f.run(() => Promise.resolve()), /must-be-synchronous/)
  assert.throws(
    () =>
      f.run(() => {
        throw new Error('failed')
      }),
    /failed/
  )
  f.state.wiki = false
  assert.equal(
    f.run(({ summaryPermitted }) => summaryPermitted(f.provenance)),
    false
  )
})

test('source metadata exclusion is fresh even when the same object is passed on the next invocation', () => {
  const f = fixture()
  const evidence = { kind: 'context' as const, text: '', windowTitle: 'Proposal', appName: 'Editor' }
  assert(f.run(({ evidencePermitted }) => evidencePermitted([evidence])))
  evidence.windowTitle = 'Password'
  assert.equal(
    f.run(({ evidencePermitted }) => evidencePermitted([evidence])),
    false
  )
})
