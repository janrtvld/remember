import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  INTENT_SHADOW_SCHEMA,
  type IntentShadowProvenance,
  type IntentShadowRecord,
  type IntentShadowSource,
  validateIntentShadow,
} from './intent-shadow-v2'

const unknown: IntentShadowProvenance = { state: 'unknown', refs: [] }
const source: IntentShadowSource = {
  evidenceId: 'speech:synthetic-1',
  sourceId: 'synthetic-1',
  revision: 'text-revision-1',
  kind: 'speech',
  text: 'Jan, mail Lotte dat Sam de betaling niet heeft ontvangen. Wacht, ik neem het over.',
}
const claim: IntentShadowRecord = {
  evidenceId: source.evidenceId,
  sourceId: source.sourceId,
  revision: source.revision,
  speechAct: 'direct_request',
  claimedOwner: 'user',
  actionStatus: 'withdrawn',
  actionSummary: 'Mail Lotte; het verzoek is daarna ingetrokken.',
  addresseeQuote: 'Jan',
  actionQuote: 'mail Lotte',
  payloadQuote: 'dat Sam de betaling niet heeft ontvangen',
  reversalQuotes: ['Wacht, ik neem het over.'],
}

function validate(patch: Partial<IntentShadowRecord> = {}, input = source) {
  return validateIntentShadow({ ...claim, ...patch }, [input], unknown)
}

function issue(result: ReturnType<typeof validate>, code: string) {
  assert.equal(result.structural.status, 'invalid')
  assert(
    result.structural.issues.some((entry) => entry.code === code),
    JSON.stringify(result.structural.issues)
  )
  assert.equal(result.automaticAssignment, 'not_authorized')
}

test('the model schema includes action status and excludes confidence, provenance and execution authority', () => {
  const schema = INTENT_SHADOW_SCHEMA.properties.records.items
  assert.equal(schema.additionalProperties, false)
  assert(schema.required.includes('actionStatus'))
  for (const key of ['confidence', 'provenance', 'automaticAssignment', 'sourceSuitability']) {
    assert(!Object.hasOwn(schema.properties, key))
    issue(validateIntentShadow({ ...claim, [key]: 'trusted' }, [source], unknown), 'invalid-record')
  }
})

test('frozen NL and EN holdout sources can separate the requested communication from dat or that payload', () => {
  const corpus = readFileSync(
    new URL('../../tests/fixtures/always-on-benchmarks/v1.holdout.jsonl', import.meta.url),
    'utf8'
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  for (const [id, actionQuote, payloadQuote] of [
    ['HO-001', 'zou jij Lena vandaag een bericht sturen', 'dat de testomgeving vrijdag beschikbaar komt'],
    ['HO-002', 'could you email Omar', 'that the revised schedule is ready for review'],
  ] as const) {
    const event = corpus.find((scenario) => scenario.id === id)?.events[0]
    assert(event && typeof event.text === 'string')
    const inputSource: IntentShadowSource = {
      evidenceId: `speech:${id}:${event.source_id}`,
      sourceId: `${id}:${event.source_id}`,
      revision: 'current-fixture-revision',
      kind: 'speech',
      text: event.text,
    }
    const result = validateIntentShadow(
      {
        ...claim,
        evidenceId: inputSource.evidenceId,
        sourceId: inputSource.sourceId,
        revision: inputSource.revision,
        actionQuote,
        payloadQuote,
        actionStatus: 'active',
        actionSummary: 'Een bericht sturen; inhoud staat afzonderlijk geciteerd.',
        reversalQuotes: [],
      },
      [inputSource],
      unknown
    )
    assert.equal(result.structural.status, 'valid', id)
    assert.equal(result.claim?.payloadQuote, payloadQuote)
    assert.equal(result.sourceSuitability, 'unknown')
    assert.equal(result.semanticAssessment, 'not_assessed')
    assert.equal(result.automaticAssignment, 'not_authorized')
  }
})

test('exact quotes preserve third-person and negated message payload without treating it as a separate task', () => {
  const result = validate()
  assert.equal(result.structural.status, 'valid')
  assert.deepEqual(
    result.structural.spans.map(({ field }) => field),
    ['addresseeQuote', 'actionQuote', 'payloadQuote', 'reversalQuotes[0]']
  )
  for (const span of result.structural.spans) {
    const quote = span.field === 'reversalQuotes[0]' ? claim.reversalQuotes[0] : claim[span.field as keyof typeof claim]
    assert.equal(source.text.slice(span.start, span.end), quote)
  }
  assert.equal(result.claim?.claimedOwner, 'user')
  assert.equal(result.claim?.actionStatus, 'withdrawn')
  assert.equal(result.semanticAssessment, 'not_assessed')
})

test('identity, revision and duplicate evidence are checked before using any source text', () => {
  issue(validate({ evidenceId: 'missing' }), 'source-not-found')
  issue(validate({ sourceId: 'different-source' }), 'source-identity-mismatch')
  issue(validate({ revision: 'old-revision' }), 'source-revision-mismatch')
  const ambiguous = validateIntentShadow(claim, [source, { ...source }], unknown)
  issue(ambiguous, 'source-ambiguous')
  assert.equal(ambiguous.source, null)
  assert.deepEqual(ambiguous.structural.spans, [])
  issue(validate({}, { ...source, kind: 'context' }), 'unsupported-source-kind')
})

test('matching never normalizes case, spacing, quotes or Unicode composition', () => {
  for (const actionQuote of ['Mail Lotte', 'mail  Lotte', 'mail\nLotte', '“mail Lotte”']) {
    issue(validate({ actionQuote }), 'quote-not-found')
  }
  const unicodeSource = { ...source, text: '😀 Jan, stuur Zoë de cafébon.' }
  const unicodeClaim = {
    ...claim,
    actionStatus: 'active' as const,
    actionQuote: 'stuur Zoë de cafébon',
    payloadQuote: null,
    reversalQuotes: [],
  }
  const result = validateIntentShadow(unicodeClaim, [unicodeSource], unknown)
  assert.equal(result.structural.status, 'valid')
  assert.equal(result.structural.spans[0]?.start, 3, 'Offsets use UTF-16 code units')
  issue(
    validateIntentShadow(
      { ...unicodeClaim, actionQuote: unicodeClaim.actionQuote.normalize('NFD') },
      [unicodeSource],
      unknown
    ),
    'quote-not-found'
  )
})

test('repeated or overlapping occurrences cannot be selected by guessing the first match', () => {
  issue(validate({}, { ...source, text: `${source.text} Jan vraagt iets anders.` }), 'quote-ambiguous')
  issue(validate({ actionQuote: 'Jan, mail Lotte' }), 'quote-overlap')
  issue(validate({ payloadQuote: 'mail Lotte dat Sam de betaling niet heeft ontvangen' }), 'quote-overlap')
  issue(validate({ reversalQuotes: ['Wacht, ik neem het over.', 'Wacht, ik neem het over.'] }), 'quote-overlap')
  issue(validate({ actionQuote: 'aa' }, { ...source, text: 'Jan, aaa.' }), 'quote-ambiguous')
})

test('source order is checked across all supplied addressee, action, payload and reversal spans', () => {
  issue(validate({ actionQuote: claim.payloadQuote, payloadQuote: claim.actionQuote }), 'quote-order')
  issue(
    validate({ reversalQuotes: ['mail Lotte'], actionQuote: 'Wacht, ik neem het over.', payloadQuote: null }),
    'quote-order'
  )
  const multiple = { ...source, text: `${source.text} Stuur nog niets.` }
  assert.equal(
    validate({ reversalQuotes: ['Wacht, ik neem het over.', 'Stuur nog niets.'] }, multiple).structural.status,
    'valid'
  )
  issue(validate({ reversalQuotes: ['Stuur nog niets.', 'Wacht, ik neem het over.'] }, multiple), 'quote-order')
})

test('withdrawn and direct-request records require their declared supporting quote fields', () => {
  issue(validate({ addresseeQuote: null }), 'missing-required-quote')
  issue(validate({ actionQuote: null }), 'missing-required-quote')
  issue(validate({ reversalQuotes: [] }), 'missing-required-quote')
  issue(validate({ speechAct: 'speaker_commitment', actionQuote: null }), 'missing-required-quote')
  issue(validate({ payloadQuote: '' }), 'invalid-record')
  issue(validate({ reversalQuotes: Array.from({ length: 9 }, () => 'Wacht') }), 'invalid-record')
})

test('a short accurate quote cannot hide the unreviewed remainder or prove the model ignored no reversal', () => {
  const result = validate({ actionStatus: 'active', reversalQuotes: [] })
  assert.equal(result.structural.status, 'valid', 'The text anchors alone are correct')
  assert.equal(result.claim?.actionStatus, 'active', 'Preserve the wrong claim for semantic assessment')
  assert(
    result.structural.unquotedRanges.some(({ start, end }) =>
      source.text.slice(start, end).includes('Wacht, ik neem het over.')
    )
  )
  assert.equal(result.source?.text, source.text)
  assert.equal(result.semanticAssessment, 'not_assessed')
  assert.equal(result.automaticAssignment, 'not_authorized')
})

test('reported speech, unknown first person and even an unsupported owner claim do not become authorized', () => {
  for (const [text, speechAct, actionQuote, addresseeQuote] of [
    ['Piet zei: Jan, mail Lotte.', 'reported', 'mail Lotte', 'Jan'],
    ['Ik mail Lotte morgen.', 'speaker_commitment', 'mail Lotte morgen', null],
    ['Jan, ik mail Lotte morgen zelf.', 'speaker_commitment', 'mail Lotte morgen zelf', 'Jan'],
  ] as const) {
    const result = validate(
      { speechAct, actionQuote, addresseeQuote, payloadQuote: null, reversalQuotes: [], actionStatus: 'active' },
      { ...source, text }
    )
    assert.equal(result.structural.status, 'valid')
    assert.equal(result.claim?.claimedOwner, 'user', 'Model claims remain visible, not rubber-stamped')
    assert.equal(result.semanticAssessment, 'not_assessed')
    assert.equal(result.automaticAssignment, 'not_authorized')
  }
})

test('provenance is independent, current-reference-bound and unknown never becomes eligible', () => {
  const ref = { evidenceId: source.evidenceId, sourceId: source.sourceId, revision: source.revision }
  for (const state of ['unknown', 'explicit-media', 'mixed-media-call'] as const) {
    const result = validateIntentShadow(claim, [source], { state, refs: state === 'unknown' ? [] : [ref] })
    assert.equal(result.structural.status, 'valid')
    assert.equal(result.provenance.state, state)
    assert.equal(result.sourceSuitability, state === 'unknown' ? 'unknown' : 'ineligible')
    assert.equal(result.automaticAssignment, 'not_authorized')
  }
  for (const provenance of [
    { state: 'explicit-media', refs: [] },
    { state: 'explicit-media', refs: [{ ...ref, revision: 'stale' }] },
    { state: 'verified-user-voice', refs: [ref] },
  ]) {
    const result = validateIntentShadow(claim, [source], provenance as IntentShadowProvenance)
    issue(result, 'invalid-provenance')
    assert.equal(result.provenance.state, 'unknown')
    assert.equal(result.sourceSuitability, 'unknown')
  }
})

test('validation is pure and its returned data cannot mutate source, model claim or independent provenance', () => {
  const input = structuredClone(claim)
  const sources = [structuredClone(source)]
  const provenance: IntentShadowProvenance = {
    state: 'explicit-media',
    refs: [{ evidenceId: source.evidenceId, sourceId: source.sourceId, revision: source.revision }],
  }
  const before = structuredClone({ input, sources, provenance })
  const result = validateIntentShadow(input, sources, provenance)
  assert(result.claim && result.source && result.provenance.refs[0])
  result.claim.reversalQuotes.push('Mutation')
  result.source.text = 'Mutation'
  result.provenance.refs[0].revision = 'Mutation'
  assert.deepEqual({ input, sources, provenance }, before)
})

for (const speechAct of ['direct_request', 'speaker_commitment', 'reported', 'unclear'] as const) {
  test(`an active ${speechAct} claim requires an action quote`, () => {
    const result = validate({ speechAct, actionStatus: 'active', actionQuote: null, reversalQuotes: [] })
    issue(result, 'missing-required-quote')
    assert(
      result.structural.issues.some(({ code, field }) => code === 'missing-required-quote' && field === 'actionQuote')
    )
    assert.equal(result.claim?.actionStatus, 'active')
    assert.equal(result.semanticAssessment, 'not_assessed')
    assert.equal(result.sourceSuitability, 'unknown')
  })
}

test('requiring an active action quote does not invent semantic acceptance or require an action for unclear non-active claims', () => {
  for (const speechAct of ['reported', 'unclear'] as const) {
    const active = validate({ speechAct, actionStatus: 'active', reversalQuotes: [] })
    assert.equal(active.structural.status, 'valid')
    assert.equal(active.semanticAssessment, 'not_assessed')
    assert.equal(active.automaticAssignment, 'not_authorized')

    const unclear = validate({
      speechAct,
      actionStatus: 'unclear',
      actionQuote: null,
      addresseeQuote: null,
      payloadQuote: null,
      reversalQuotes: [],
    })
    assert.equal(unclear.structural.status, 'valid')
    assert.equal(unclear.automaticAssignment, 'not_authorized')
  }
})
