import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type ProactiveContextInput, parseProactivePlan, projectProactiveContext } from '../proactivePolicy'
import type { ProactiveSource } from '../proactiveStore'

const now = Date.parse('2026-10-23T13:50:00Z')
const text = 'Atlas: voorbereiding overleg; de uitrolbeslissing staat nog open.'
const source: ProactiveSource = {
  evidenceId: 'screen',
  sourceId: 'screen',
  kind: 'context',
  workdayId: 'day',
  revision: 'revision',
  eventId: 'event',
  eventRevision: 'event-revision',
  contentKey: 'content',
  observedAt: now - 1_000,
  acceptedAt: now,
  sequence: 1,
  text,
  source: 'screen',
  appName: 'Editor',
  bundleId: 'test.editor',
  windowTitle: 'Atlas',
  url: '',
  provenance: { speaker: 'unknown', mediaPlayback: 'unknown', inputRoute: 'screen' },
}
const input = (extra: Record<string, unknown> = {}): ProactiveContextInput => ({
  evidence: [source],
  items: [],
  locale: 'nl',
  now,
  timeZone: 'Europe/Amsterdam',
  ...extra,
})
const output = (kind = 'private-briefing') => ({
  consideredEvidenceIds: ['screen'],
  proposed: [],
  changes: [],
  initiative: {
    kind,
    text: 'Een briefing kan de open uitrolbeslissing voorbereiden.',
    topicKey: 'atlas-review',
    sourceIds: ['screen'],
    supportingQuotes: [{ sourceId: 'screen', quote: text }],
  },
})

test('a private briefing is only a typed candidate for an explicitly supplied source', () => {
  const context = input({ briefingCandidateSourceIds: ['screen'] })
  const plan = parseProactivePlan(output(), context)
  assert.equal(plan.initiative.kind, 'prepare')
  assert.deepEqual(plan.taskPlan.proposed, [])
  assert.deepEqual(projectProactiveContext(context).briefingCandidateSourceIds, ['screen'])
  assert.equal('grant' in plan.initiative, false)
})

test('no candidate scope, empty scope or another source cannot nominate a briefing', () => {
  for (const extra of [{}, { briefingCandidateSourceIds: [] }, { briefingCandidateSourceIds: ['other'] }]) {
    assert.throws(() => parseProactivePlan(output(), input(extra)), /proactive-invalid/)
  }
})

test('candidate scope is exact, bounded and code supplied', () => {
  for (const scope of [['screen', 'screen'], [42], 'screen', ['unknown']]) {
    assert.throws(
      () => projectProactiveContext(input({ briefingCandidateSourceIds: scope })),
      /proactive-invalid-input/
    )
  }
})

test('ordinary parser compatibility keeps an old prepare response an offer', () => {
  assert.equal(parseProactivePlan(output('prepare'), input()).initiative.kind, 'offer')
  assert.equal('briefingCandidateSourceIds' in projectProactiveContext(input()), false)
})

test('freshness and recorded-media suppression also apply to briefing nominations', () => {
  for (const changed of [
    { ...source, observedAt: now - 120_001 },
    { ...source, provenance: { ...source.provenance, mediaPlayback: 'recorded' } },
  ]) {
    assert.equal(
      parseProactivePlan(output(), input({ evidence: [changed], briefingCandidateSourceIds: ['screen'] })).initiative
        .kind,
      'silent'
    )
  }
})

test('candidate never accepts model supplied authority', () => {
  const value = output()
  assert.throws(
    () =>
      parseProactivePlan(
        { ...value, initiative: { ...value.initiative, grantId: 'invented' } },
        input({ briefingCandidateSourceIds: ['screen'] })
      ),
    /proactive-invalid-response/
  )
})
