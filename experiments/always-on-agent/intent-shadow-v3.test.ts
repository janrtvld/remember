import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { AmbientEvidence } from '../../apps/desktop/src/main/dailyReview/ambientTaskStore'
import { INTENT_SHADOW_SCHEMA, type IntentShadowReference } from './intent-shadow-v2'
import {
  INTENT_SHADOW_V3_SCHEMA,
  type IntentShadowV3Claim,
  type IntentShadowV3Snapshot,
  type IntentShadowV3Validation,
  prepareIntentShadowV3,
} from './intent-shadow-v3'

const keys = [
  'speechAct',
  'claimedOwner',
  'actionStatus',
  'addresseeQuote',
  'actionQuote',
  'payloadQuote',
  'reversalQuotes',
]
const recordedFailures = JSON.parse(
  readFileSync(new URL('../../tests/fixtures/always-on-benchmarks/source-binding.v3.json', import.meta.url), 'utf8')
)
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const copy = <T>(value: T): T => structuredClone(value)
function source(id: string, text: string, kind: 'speech' | 'context' = 'speech'): AmbientEvidence {
  return {
    kind,
    evidenceId: `${kind}:${id}`,
    sourceId: id,
    revision: hash(text),
    text,
    workdayId: 'synthetic-day',
    observedAt: 100,
    source: kind === 'speech' ? 'system' : 'screen',
    appName: '',
    bundleId: '',
    windowTitle: '',
    url: '',
  }
}
const speech = source('target', 'Jan, mail Lotte dat het rooster klaarstaat.')
const surrounding = source('surrounding', 'Planning preview', 'context')
const ref = (s: AmbientEvidence): IntentShadowReference => ({
  evidenceId: s.evidenceId,
  sourceId: s.sourceId,
  revision: s.revision,
})
function snapshot(): IntentShadowV3Snapshot {
  return {
    sources: copy([surrounding, speech]),
    userName: 'Jan',
    language: 'nl',
    policyEpoch: 'policy-1',
    allowed: true,
  }
}
const claim: IntentShadowV3Claim = {
  speechAct: 'direct_request',
  claimedOwner: 'user',
  actionStatus: 'active',
  addresseeQuote: 'Jan',
  actionQuote: 'mail Lotte',
  payloadQuote: 'dat het rooster klaarstaat',
  reversalQuotes: [],
}
function rejected(result: IntentShadowV3Validation) {
  assert.equal(result.status, 'invalid')
  assert.equal(result.reference, null)
  assert(result.issues.length > 0)
  neutral(result)
}
function neutral(result: IntentShadowV3Validation) {
  assert.equal(result.semanticAssessment, 'not_assessed')
  assert.equal(result.automaticAssignment, 'not_authorized')
  assert.equal(result.sourceSuitability, 'unknown')
  assert.deepEqual(result.provenance, { state: 'unknown', refs: [] })
  assert(!Object.hasOwn(result, 'actionSummary'))
  assert(!result.claim || !Object.hasOwn(result.claim, 'actionSummary'))
}
function semantic(raw: Record<string, unknown>): IntentShadowV3Claim {
  return Object.fromEntries(keys.map((key) => [key, raw[key]])) as IntentShadowV3Claim
}

test('wire contract is one semantic object with no identity, summary, provenance or records envelope', () => {
  assert.equal(INTENT_SHADOW_V3_SCHEMA.type, 'object')
  assert.equal(INTENT_SHADOW_V3_SCHEMA.additionalProperties, false)
  assert.deepEqual(Object.keys(INTENT_SHADOW_V3_SCHEMA.properties).sort(), [...keys].sort())
  assert.deepEqual([...INTENT_SHADOW_V3_SCHEMA.required].sort(), [...keys].sort())
})

test('the explicit target is bound by caller and output carries only that immutable reference', () => {
  const current = snapshot()
  const request = prepareIntentShadowV3(ref(speech), current)
  assert.equal(request.input.speech.text, speech.text)
  assert.equal(request.input.context.length, 1)
  for (const offered of [request.input.speech, ...request.input.context]) {
    for (const key of ['evidenceId', 'sourceId', 'revision']) assert(!Object.hasOwn(offered, key))
  }
  const result = request.accept(claim, current)
  assert.equal(result.status, 'valid')
  assert.deepEqual(result.reference, ref(speech))
  assert.deepEqual(result.claim, claim)
  neutral(result)
})

test('actual v2 missing-revision output is still rejected; only a distinct metadata-free record uses caller binding', () => {
  const { input, raw } = copy(recordedFailures.missingRevision)
  const old = raw.records[0]
  const original = copy(old)
  assert.equal(old.revision.length, 62)
  const current = { ...snapshot(), sources: input.evidence }
  const target = ref(current.sources[0])
  rejected(prepareIntentShadowV3(target, current).accept(old, current))
  const result = prepareIntentShadowV3(target, current).accept(semantic(old), current)
  assert.equal(result.status, 'valid')
  assert.equal(result.reference?.revision.length, 64)
  assert.deepEqual(old, original)
  neutral(result)
})

test('actual v2 ungrounded video summary is rejected rather than silently stripped', () => {
  const { input, raw } = copy(recordedFailures.mediaAttribution)
  const old = raw.records[0]
  assert.match(old.actionSummary, /^In de video/)
  const current = { ...snapshot(), sources: input.evidence }
  const target = ref(current.sources.find((s: AmbientEvidence) => s.kind === 'speech'))
  rejected(
    prepareIntentShadowV3(target, current).accept({ ...semantic(old), actionSummary: old.actionSummary }, current)
  )
  const result = prepareIntentShadowV3(target, current).accept(semantic(old), current)
  assert.equal(result.status, 'valid')
  assert(!JSON.stringify(result).includes('In de video'))
  neutral(result)
})

const changes: Array<[string, (s: IntentShadowV3Snapshot) => void]> = [
  [
    'missing target',
    (s) => {
      s.sources = [copy(surrounding)]
    },
  ],
  [
    'identical text with replacement identity',
    (s) => {
      s.sources = [copy(surrounding), source('replacement', speech.text)]
    },
  ],
  [
    'new transcript revision',
    (s) => {
      s.sources = [copy(surrounding), source('target', `${speech.text} Wacht, stuur niets.`)]
    },
  ],
  [
    'altered text with stale declared revision',
    (s) => {
      s.sources = [copy(surrounding), { ...copy(speech), text: `${speech.text} Wacht.` }]
    },
  ],
  [
    'context title with unchanged text hash',
    (s) => {
      s.sources = [{ ...copy(surrounding), windowTitle: 'Different window' }, copy(speech)]
    },
  ],
  [
    'context URL with unchanged text hash',
    (s) => {
      s.sources = [{ ...copy(surrounding), url: 'https://example.invalid/changed' }, copy(speech)]
    },
  ],
  [
    'source origin with unchanged transcript',
    (s) => {
      s.sources = [copy(surrounding), { ...copy(speech), source: 'microphone' }]
    },
  ],
  [
    'workday changed',
    (s) => {
      s.sources = [copy(surrounding), { ...copy(speech), workdayId: 'new-day' }]
    },
  ],
  [
    'observation time changed',
    (s) => {
      s.sources = [copy(surrounding), { ...copy(speech), observedAt: 101 }]
    },
  ],
  [
    'context omitted',
    (s) => {
      s.sources = [copy(speech)]
    },
  ],
  [
    'new possible withdrawal context',
    (s) => {
      s.sources = [...s.sources, source('later', 'Laat maar, ik neem het over.')]
    },
  ],
  [
    'context order changed',
    (s) => {
      s.sources = [...s.sources].reverse()
    },
  ],
  [
    'duplicate evidence',
    (s) => {
      s.sources = [...s.sources, copy(speech)]
    },
  ],
  [
    'permission revoked',
    (s) => {
      s.allowed = false
    },
  ],
  [
    'policy epoch changed',
    (s) => {
      s.policyEpoch = 'policy-2'
    },
  ],
  [
    'different current user',
    (s) => {
      s.userName = 'Lena'
    },
  ],
  [
    'language changed',
    (s) => {
      s.language = 'en'
    },
  ],
]
for (const [name, mutate] of changes)
  test(`an old answer cannot bind after ${name}`, () => {
    const offered = snapshot()
    const request = prepareIntentShadowV3(ref(speech), offered)
    const current = copy(offered)
    mutate(current)
    rejected(request.accept(claim, current))
    rejected(request.accept(claim, offered))
  })

test('invalid or ambiguous offered snapshots never create a usable request', () => {
  for (const change of [
    (s: IntentShadowV3Snapshot) => {
      s.allowed = false
    },
    (s: IntentShadowV3Snapshot) => {
      s.sources = [...s.sources, copy(speech)]
    },
    (s: IntentShadowV3Snapshot) => {
      s.sources = [copy(surrounding)]
    },
    (s: IntentShadowV3Snapshot) => {
      s.policyEpoch = ''
    },
    (s: IntentShadowV3Snapshot) => {
      s.sources = [copy(surrounding), { ...copy(speech), revision: 'bad-hash' }]
    },
  ]) {
    const current = snapshot()
    change(current)
    assert.throws(() => prepareIntentShadowV3(ref(speech), current), /snapshot|source|target|policy|revision|context/)
  }
  assert.throws(() => prepareIntentShadowV3(ref(surrounding), snapshot()), /source|target|speech/)
})

test('extra caller metadata and unsupported native flags cannot be silently dropped', () => {
  const offered = snapshot()
  assert.throws(
    () => prepareIntentShadowV3(ref(speech), { ...offered, playback: 'live' } as IntentShadowV3Snapshot),
    /snapshot/
  )
  assert.throws(
    () =>
      prepareIntentShadowV3(ref(speech), {
        ...offered,
        sources: [{ ...surrounding, playback: 'live' } as AmbientEvidence, speech],
      }),
    /source|snapshot|context/
  )
  const request = prepareIntentShadowV3(ref(speech), offered)
  rejected(request.accept(claim, { ...offered, playback: 'live' } as IntentShadowV3Snapshot))
})

test('multiple/wrapped records, unknown metadata and malformed semantic fields fail closed', () => {
  const rawValues: unknown[] = [
    [claim],
    { records: [claim] },
    { records: [claim, claim] },
    null,
    { ...claim, evidenceId: speech.evidenceId },
    { ...claim, revision: speech.revision },
    { ...claim, sourceId: speech.sourceId },
    { ...claim, provenance: 'live' },
    { ...claim, confidence: 1 },
    { ...claim, actionSummary: 'In the video...' },
    { ...claim, actionStatus: 'done' },
    { ...claim, actionQuote: null },
    { ...claim, speechAct: 'unclear', actionQuote: null },
    { ...claim, speechAct: 'reported', actionQuote: null },
    { ...claim, reversalQuotes: ['Invented reversal'] },
  ]
  for (const raw of rawValues) {
    const current = snapshot()
    rejected(prepareIntentShadowV3(ref(speech), current).accept(raw, current))
  }
})

test('quotes may only come from the explicitly bound speech, not a matching surrounding source', () => {
  const other = source('other-speech', 'Jan, bel Piet morgen.')
  const current = { ...snapshot(), sources: [other, copy(speech)] }
  rejected(
    prepareIntentShadowV3(ref(speech), current).accept(
      { ...claim, actionQuote: 'bel Piet morgen', payloadQuote: null },
      current
    )
  )
  rejected(
    prepareIntentShadowV3(ref(speech), snapshot()).accept(
      { ...claim, actionQuote: 'Planning preview', payloadQuote: null },
      snapshot()
    )
  )
})

test('mutation cannot change an already offered context or frozen model input', () => {
  const offered = snapshot()
  const original = copy(offered)
  const target = ref(speech)
  const request = prepareIntentShadowV3(target, offered)
  target.sourceId = 'replacement'
  const mutableSource = offered.sources[1]
  assert(mutableSource)
  mutableSource.text = 'changed'
  assert.equal(request.input.speech.text, speech.text)
  assert(
    Object.isFrozen(request.input) && Object.isFrozen(request.input.speech) && Object.isFrozen(request.input.context)
  )
  assert.equal(Reflect.set(request.input.speech, 'text', 'changed'), false)
  assert.equal(request.input.speech.text, speech.text)
  assert.equal(request.accept(claim, original).status, 'valid')
})

test('each handle consumes exactly one result and returned values cannot corrupt another handle', () => {
  const current = snapshot()
  const first = prepareIntentShadowV3(ref(speech), current)
  const second = prepareIntentShadowV3(ref(speech), current)
  const raw = copy(claim)
  const result = first.accept(raw, current)
  assert.equal(result.status, 'valid')
  raw.actionQuote = 'changed'
  assert.equal(result.claim?.actionQuote, claim.actionQuote)
  if (result.reference) result.reference.revision = 'changed'
  if (result.claim) result.claim.reversalQuotes.push('changed')
  rejected(first.accept(claim, current))
  const other = second.accept(claim, current)
  assert.equal(other.status, 'valid')
  assert.deepEqual(other.reference, ref(speech))
  assert.deepEqual(other.claim, claim)
  rejected(first.accept(claim, current))
})

test('out-of-order identical replies remain associated with the caller closures, not the latest source', async () => {
  const a = snapshot()
  const secondSpeech = source('second-target', speech.text)
  const b = { ...snapshot(), sources: [copy(surrounding), secondSpeech] }
  const first = prepareIntentShadowV3(ref(speech), a)
  const second = prepareIntentShadowV3(ref(secondSpeech), b)
  let releaseA!: (raw: unknown) => void
  let releaseB!: (raw: unknown) => void
  const answerA = new Promise<unknown>((resolve) => {
    releaseA = resolve
  }).then((raw) => first.accept(raw, a))
  const answerB = new Promise<unknown>((resolve) => {
    releaseB = resolve
  }).then((raw) => second.accept(raw, b))
  releaseB(copy(claim))
  const resultB = await answerB
  releaseA(copy(claim))
  const resultA = await answerA
  assert.equal(resultA.status, 'valid')
  assert.equal(resultB.status, 'valid')
  assert.deepEqual(resultA.reference, ref(speech))
  assert.deepEqual(resultB.reference, ref(secondSpeech))
})

test('a late accepted-looking answer is rejected after the caller snapshot changes', async () => {
  const current = snapshot()
  const request = prepareIntentShadowV3(ref(speech), current)
  let release!: (raw: unknown) => void
  const result = new Promise<unknown>((resolve) => {
    release = resolve
  }).then((raw) => request.accept(raw, current))
  current.policyEpoch = 'revoked-generation'
  release(claim)
  rejected(await result)
})

test('a serialized request is not a restart receipt or restored acceptance capability', () => {
  const request = prepareIntentShadowV3(ref(speech), snapshot())
  const serialized = JSON.parse(JSON.stringify(request))
  assert.equal(serialized.accept, undefined)
  assert(!JSON.stringify(serialized).includes('policy-1'))
})

test('natural-order corpus is retained: fixed lexical order still rejects correct postposed addressees', () => {
  const corpus = readFileSync(
    new URL('../../tests/fixtures/always-on-benchmarks/ownership-natural-order.v3.jsonl', import.meta.url),
    'utf8'
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const expectedQuotes: Record<string, IntentShadowV3Claim> = {
    'NO-01': { ...claim, actionQuote: 'wil je Lena mailen', payloadQuote: 'dat de offerte klaarstaat' },
    'NO-02': { ...claim, actionQuote: 'Wil je Lena mailen', payloadQuote: 'dat de offerte klaarstaat' },
    'NO-03': {
      ...claim,
      claimedOwner: 'other',
      addresseeQuote: 'Lena',
      actionQuote: 'Wil je Jan mailen',
      payloadQuote: 'dat de offerte klaarstaat',
    },
    'NO-04': {
      ...claim,
      speechAct: 'reported',
      claimedOwner: 'unknown',
      actionStatus: 'unclear',
      addresseeQuote: null,
      actionQuote: 'Wil je Lena mailen',
      payloadQuote: 'dat de offerte klaarstaat',
    },
  }
  for (const entry of corpus) {
    const current = { ...snapshot(), sources: entry.input.evidence }
    const target = current.sources[0]
    assert(target)
    const result = prepareIntentShadowV3(ref(target), current).accept(expectedQuotes[entry.id], current)
    if (entry.id === 'NO-02' || entry.id === 'NO-03') {
      rejected(result)
      assert(result.issues.some((issue) => issue.code === 'quote-order'))
    } else assert.equal(result.status, 'valid', entry.id)
    neutral(result)
  }
})

test('the caller target must match every reference field and reject extra metadata', () => {
  for (const target of [
    { ...ref(speech), sourceId: 'wrong-source' },
    { ...ref(speech), revision: hash('different revision') },
    { ...ref(speech), evidenceId: 'missing-evidence' },
    { ...ref(speech), playback: 'live' },
  ])
    assert.throws(() => prepareIntentShadowV3(target, snapshot()), /target|source|reference/)
})

test('every offered context element is frozen independently of the caller copy', () => {
  const original = snapshot()
  const request = prepareIntentShadowV3(ref(speech), original)
  const offered = request.input.context[0]
  assert(offered)
  assert(Object.isFrozen(offered))
  assert.equal(Reflect.set(offered, 'text', 'New instruction'), false)
  assert.equal(offered.text, surrounding.text)
  assert.equal(Reflect.set(offered, 'windowTitle', 'Other title'), false)
  assert.equal(offered.windowTitle, surrounding.windowTitle)
  assert.equal(request.accept(claim, original).status, 'valid')
})

test('ambiguity in surrounding context and reused identities prevents preparing a binding', () => {
  for (const extra of [
    copy(surrounding),
    { ...source('different', 'Other text', 'context'), evidenceId: surrounding.evidenceId },
    { ...copy(surrounding), evidenceId: 'different-evidence-id' },
    { ...copy(speech), evidenceId: 'different-speech-evidence-id' },
  ]) {
    const current = snapshot()
    current.sources = [...current.sources, extra]
    assert.throws(() => prepareIntentShadowV3(ref(speech), current), /source|context|snapshot|ambiguous/)
  }
})

test('schema and quote failures consume their handle without a repaired automatic retry', () => {
  for (const invalid of [{ records: [claim] }, { ...claim, actionQuote: 'mail Piet' }]) {
    const current = snapshot()
    const request = prepareIntentShadowV3(ref(speech), current)
    rejected(request.accept(invalid, current))
    rejected(request.accept(claim, current))
  }
})

for (const field of ['actionSummary', 'evidenceId', 'revision']) {
  test(`public schema mutation cannot authorize extra ${field} after preparation`, () => {
    const current = snapshot()
    const request = prepareIntentShadowV3(ref(speech), current)
    const required = INTENT_SHADOW_V3_SCHEMA.required
    const originalLength = required.length
    try {
      Reflect.set(required, originalLength, field)
      rejected(request.accept({ ...claim, [field]: 'untrusted metadata' }, current))
    } finally {
      if (required.length !== originalLength) Reflect.set(required, 'length', originalLength)
    }
  })
}

for (const field of ['speechAct', 'claimedOwner', 'actionStatus'] as const) {
  test(`v2 ${field} enum mutation cannot expand the private v3 contract`, () => {
    const current = snapshot()
    const request = prepareIntentShadowV3(ref(speech), current)
    const values = INTENT_SHADOW_SCHEMA.properties.records.items.properties[field].enum
    const originalLength = values.length
    try {
      Reflect.set(values, originalLength, 'unexpected-value')
      rejected(request.accept({ ...claim, [field]: 'unexpected-value' }, current))
    } finally {
      if (values.length !== originalLength) Reflect.set(values, 'length', originalLength)
    }
    assert.equal(prepareIntentShadowV3(ref(speech), current).accept(claim, current).status, 'valid')
  })
}

test('all exported schema levels are frozen without silently widening validation', () => {
  function frozen(value: unknown) {
    if (value === null || typeof value !== 'object') return
    assert(Object.isFrozen(value))
    for (const nested of Object.values(value)) frozen(nested)
  }
  frozen(INTENT_SHADOW_V3_SCHEMA)
})

test('semantic wire fields reject non-JSON accessors, oversized quotes and sparse reversals', () => {
  let accessed = false
  const accessor = { ...claim }
  Object.defineProperty(accessor, 'actionQuote', {
    enumerable: true,
    get() {
      accessed = true
      return claim.actionQuote
    },
  })
  const values: unknown[] = [
    accessor,
    { ...claim, actionQuote: 'x'.repeat(601) },
    { ...claim, payloadQuote: '' },
    { ...claim, addresseeQuote: '   ' },
    { ...claim, reversalQuotes: Array(1) },
    { ...claim, reversalQuotes: Array(9).fill('Jan') },
    { ...claim, reversalQuotes: [null] },
    { ...claim, reversalQuotes: [123] },
    { ...claim, reversalQuotes: ['x'.repeat(601)] },
  ]
  for (const raw of values) {
    const current = snapshot()
    rejected(prepareIntentShadowV3(ref(speech), current).accept(raw, current))
  }
  assert.equal(accessed, false)
})
