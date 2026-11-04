import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { validateIntentQuoteLayout } from './intent-quote-layout-v4'

const base = {
  addresseeQuote: 'Jan',
  actionQuote: 'mail Lotte',
  payloadQuote: 'dat Sam de betaling niet heeft ontvangen',
  reversalQuotes: ['Wacht, ik neem het over.'],
}
const text = 'Jan, mail Lotte dat Sam de betaling niet heeft ontvangen. Wacht, ik neem het over.'
const corpus = readFileSync(
  new URL('../../tests/fixtures/always-on-benchmarks/ownership-natural-order.v3.jsonl', import.meta.url),
  'utf8'
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))

function neutral(result: ReturnType<typeof validateIntentQuoteLayout>) {
  assert.equal(result.semanticAssessment, 'not_assessed')
  assert.equal(result.automaticAssignment, 'not_authorized')
  for (const field of ['ownerVerified', 'provenance', 'reference', 'sourceSuitability'])
    assert(!Object.hasOwn(result, field))
}
function valid(sourceText: string, quotes: unknown) {
  const result = validateIntentQuoteLayout(sourceText, quotes)
  assert.equal(result.status, 'valid', JSON.stringify(result.issues))
  assert.deepEqual(result.issues, [])
  neutral(result)
  return result
}
function invalid(sourceText: string, quotes: unknown, code: string) {
  const result = validateIntentQuoteLayout(sourceText, quotes)
  assert.equal(result.status, 'invalid')
  assert(
    result.issues.some((issue) => issue.code === code),
    JSON.stringify(result.issues)
  )
  neutral(result)
  return result
}

for (const id of ['NO-01', 'NO-02', 'NO-03', 'NO-04']) {
  test(`frozen ${id} supports its exact natural-order layout without changing its semantic oracle`, () => {
    const item = corpus.find((entry) => entry.id === id)
    assert(item)
    const before = structuredClone(item)
    const result = valid(item.input.evidence[0].text, {
      addresseeQuote: id === 'NO-04' ? null : id === 'NO-03' ? 'Lena' : 'Jan',
      actionQuote: id === 'NO-01' ? 'wil je Lena mailen' : id === 'NO-03' ? 'Wil je Jan mailen' : 'Wil je Lena mailen',
      payloadQuote: 'dat de offerte klaarstaat',
      reversalQuotes: [],
    })
    assert.equal(result.spans.length, id === 'NO-04' ? 2 : 3)
    assert.deepEqual(item, before)
  })
}

test('a disjoint vocative between action and payload has no order edge', () => {
  valid('Mail Lena, Jan, dat de offerte klaarstaat.', {
    addresseeQuote: 'Jan',
    actionQuote: 'Mail Lena',
    payloadQuote: 'dat de offerte klaarstaat',
    reversalQuotes: [],
  })
})

test('a disjoint vocative after a later reversal has no order edge', () => {
  valid('Mail Lena dat de offerte klaarstaat. Wacht, stuur niets, Jan.', {
    addresseeQuote: 'Jan',
    actionQuote: 'Mail Lena',
    payloadQuote: 'dat de offerte klaarstaat',
    reversalQuotes: ['Wacht, stuur niets'],
  })
})

test('action and payload cannot exchange chronological positions', () => {
  invalid(text, { ...base, actionQuote: base.payloadQuote, payloadQuote: base.actionQuote }, 'quote-order')
})

test('a reversal before the action or payload is still rejected', () => {
  invalid(
    text,
    { ...base, actionQuote: 'Wacht, ik neem het over.', payloadQuote: null, reversalQuotes: ['mail Lotte'] },
    'quote-order'
  )
  invalid(
    text,
    { ...base, reversalQuotes: [base.payloadQuote], payloadQuote: 'Wacht, ik neem het over.' },
    'quote-order'
  )
})

test('multiple reversals retain their supplied chronology and are never silently sorted', () => {
  const sourceText = `${text} Stuur nog niets.`
  valid(sourceText, { ...base, reversalQuotes: ['Wacht, ik neem het over.', 'Stuur nog niets.'] })
  invalid(sourceText, { ...base, reversalQuotes: ['Stuur nog niets.', 'Wacht, ik neem het over.'] }, 'quote-order')
})

test('every field including addressee participates in overlap checks', () => {
  invalid(text, { ...base, actionQuote: 'Jan, mail Lotte' }, 'quote-overlap')
  invalid(text, { ...base, payloadQuote: 'mail Lotte dat Sam de betaling niet heeft ontvangen' }, 'quote-overlap')
  invalid(text, { ...base, reversalQuotes: [base.reversalQuotes[0], base.reversalQuotes[0]] }, 'quote-overlap')
})

test('repeated and overlapping occurrences cannot select an arbitrary first match', () => {
  invalid(`${text} Jan vraagt iets anders.`, base, 'quote-ambiguous')
  invalid('Jan, aaa.', { ...base, actionQuote: 'aa', payloadQuote: null, reversalQuotes: [] }, 'quote-ambiguous')
})

test('case, whitespace, quotes and Unicode composition are not normalized', () => {
  for (const actionQuote of ['Mail Lotte', 'mail  Lotte', 'mail\nLotte', '“mail Lotte”'])
    invalid(text, { ...base, actionQuote }, 'quote-not-found')
  invalid(
    'Jan, stuur Zoë de cafébon.',
    { ...base, actionQuote: 'stuur Zoë de cafébon', payloadQuote: null, reversalQuotes: [] },
    'quote-not-found'
  )
})

test('UTF-16 offsets and full unquoted complement stay exact with a postposed addressee', () => {
  const sourceText = '😀 Mail Zoë de cafébon, Jan.'
  const quotes = { addresseeQuote: 'Jan', actionQuote: 'Mail Zoë de cafébon', payloadQuote: null, reversalQuotes: [] }
  const result = valid(sourceText, quotes)
  assert.equal(result.spans.find((span) => span.field === 'actionQuote')?.start, 3)
  const covered = Array(sourceText.length).fill(0)
  for (const span of result.spans) {
    assert.equal(sourceText.slice(span.start, span.end), quotes[span.field as 'addresseeQuote' | 'actionQuote'])
    for (let i = span.start; i < span.end; i++) covered[i]++
  }
  for (const span of result.unquotedRanges) for (let i = span.start; i < span.end; i++) covered[i]++
  assert(covered.every((count) => count === 1))
})

test('a surrounding-context quote does not exist in the supplied target speech', () => {
  invalid(text, { ...base, actionQuote: 'Planning preview' }, 'quote-not-found')
})

test('required-quote semantics stay outside this layout helper', () => {
  const result = valid(text, { addresseeQuote: null, actionQuote: null, payloadQuote: null, reversalQuotes: [] })
  assert.deepEqual(result.spans, [])
  assert.deepEqual(result.unquotedRanges, [{ start: 0, end: text.length }])
})

test('a wrong recipient-as-addressee claim may be layout-valid but is not semantically assessed', () => {
  const item = corpus.find((entry) => entry.id === 'NO-03')
  assert(item)
  valid(item.input.evidence[0].text, {
    addresseeQuote: 'Jan',
    actionQuote: 'mailen',
    payloadQuote: 'dat de offerte klaarstaat',
    reversalQuotes: [],
  })
})

test('message contents falsely labeled as a reversal remain a semantic counterexample', () => {
  valid('Jan, mail Lena: “Wacht, ik neem het over.”', {
    addresseeQuote: 'Jan',
    actionQuote: 'mail Lena',
    payloadQuote: null,
    reversalQuotes: ['Wacht, ik neem het over.'],
  })
})

test('omitting a real reversal can be layout-valid and must leave its full text inspectable', () => {
  const result = valid(text, { ...base, reversalQuotes: [] })
  const reversal = base.reversalQuotes[0]
  assert(reversal)
  assert(result.unquotedRanges.some((range) => text.slice(range.start, range.end).includes(reversal)))
})

test('schema bounds and exact data keys reject malformed fields without invoking getters', () => {
  let read = false
  const accessor = { ...base }
  Object.defineProperty(accessor, 'actionQuote', {
    enumerable: true,
    get() {
      read = true
      return base.actionQuote
    },
  })
  for (const bad of [
    null,
    [],
    { ...base, owner: 'user' },
    { ...base, actionQuote: '' },
    { ...base, actionQuote: 'x'.repeat(601) },
    { ...base, reversalQuotes: Array(1) },
    { ...base, reversalQuotes: Array(9).fill('Wacht') },
    { ...base, reversalQuotes: [123] },
    accessor,
  ])
    invalid(text, bad, 'invalid-quotes')
  assert.equal(read, false)
})

test('input values and independent results remain unchanged by returned-array mutation', () => {
  const input = structuredClone(base)
  const before = structuredClone(input)
  const result = valid(text, input)
  const span = result.spans[0]
  assert(span)
  span.start = 999
  result.unquotedRanges.length = 0
  assert.deepEqual(input, before)
  assert.notEqual(valid(text, input).spans[0]?.start, 999)
})

test('postposed addressee freedom never permits overlap with payload or reversal', () => {
  invalid(
    'Mail Lena dat de offerte klaarstaat, Jan.',
    {
      addresseeQuote: 'Jan',
      actionQuote: 'Mail Lena',
      payloadQuote: 'dat de offerte klaarstaat, Jan',
      reversalQuotes: [],
    },
    'quote-overlap'
  )
  invalid(
    'Mail Lena. Wacht, stuur niets, Jan.',
    {
      addresseeQuote: 'Jan',
      actionQuote: 'Mail Lena',
      payloadQuote: null,
      reversalQuotes: ['Wacht, stuur niets, Jan'],
    },
    'quote-overlap'
  )
})
