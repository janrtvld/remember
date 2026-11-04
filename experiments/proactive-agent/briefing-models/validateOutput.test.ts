import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { validateBriefingOutput } from './validateOutput.mjs'

const text = 'The current figure is 18%. The threshold is 10%.'
const revision = createHash('sha256').update(text).digest('hex')
const input = { sources: [{ sourceId: 's:1', revision, text }] }
const line = () => ({ text: 'Check the gap.', quotes: [{ sourceId: 's:1', quote: 'The current figure is 18%.' }] })
const positive = () => ({
  version: 1,
  kind: 'private-briefing',
  reason: line(),
  briefing: {
    title: 'Review',
    decision: line(),
    facts: [line(), line()],
    openPoints: [line()],
    questions: [line(), line(), line()],
  },
})
const check = (value: unknown) => validateBriefingOutput(JSON.stringify(value), input)

test('exact positive structure projects input-owned revision without semantic claims', () => {
  const result = check(positive())
  assert.equal(result.valid, true)
  assert.deepEqual(result.sourceRefs, [{ sourceId: 's:1', revision }])
})
test('silent requires null body and retains only a diagnostic grounded reason', () => {
  assert.equal(check({ version: 1, kind: 'silent', reason: line(), briefing: null }).valid, true)
  assert.equal(check({ ...positive(), kind: 'silent' }).valid, false)
})
test('malformed JSON and code fences fail without repair', () => {
  assert.equal(validateBriefingOutput('{', input).valid, false)
  assert.equal(validateBriefingOutput('```json\n{}\n```', input).valid, false)
})
test('missing and additional nested/root keys reject', () => {
  assert.equal(check({ ...positive(), grant: 'anything' }).valid, false)
  const value = positive()
  Object.assign(value.briefing.facts[0]!, { revision })
  assert.equal(check(value).valid, false)
  assert.equal(check({ version: 1, kind: 'silent', briefing: null }).valid, false)
})
test('wrong types, unknown kind and body mismatch reject', () => {
  assert.equal(check({ ...positive(), version: '1' }).valid, false)
  assert.equal(check({ ...positive(), kind: 'prepare' }).valid, false)
  assert.equal(check({ ...positive(), briefing: null }).valid, false)
  assert.equal(check([]).valid, false)
})
test('quotes must be exact substrings of their own source, not normalized or cross-bound', () => {
  const value = positive()
  value.reason.quotes[0]!.quote = 'The current figure is 19%.'
  assert.equal(check(value).valid, false)
  value.reason.quotes[0]!.quote = 'The current figure is 18%.'
  value.reason.quotes[0]!.sourceId = 's:2'
  assert.equal(check(value).valid, false)
})
test('duplicate quote within one line rejects but reuse across different claims is allowed', () => {
  const value = positive()
  value.reason.quotes.push({ ...value.reason.quotes[0]! })
  assert.equal(check(value).valid, false)
  assert.equal(check(positive()).valid, true)
})
test('quote and line bounds reject including whitespace and unicode codepoint length', () => {
  const value = positive()
  value.reason.text = ' '
  assert.equal(check(value).valid, false)
  value.reason.text = 'x'.repeat(281)
  assert.equal(check(value).valid, false)
  value.reason.text = '🟢'.repeat(280)
  assert.equal(check(value).valid, true)
  value.reason.quotes = []
  assert.equal(check(value).valid, false)
})
test('facts/open points/questions cardinality is exact', () => {
  const value = positive()
  value.briefing.questions.pop()
  assert.equal(check(value).valid, false)
  value.briefing.questions.push(line())
  value.briefing.facts = [line()]
  assert.equal(check(value).valid, false)
  value.briefing.facts = [line(), line()]
  value.briefing.openPoints = []
  assert.equal(check(value).valid, false)
})
test('UTF8 output byte bound rejects before parsing even whitespace padding', () => {
  assert.equal(validateBriefingOutput(JSON.stringify(positive()) + ' '.repeat(16_384), input).valid, false)
})
test('invalid input duplicate IDs or content hash refuses canonical ref projection', () => {
  assert.equal(
    validateBriefingOutput(JSON.stringify(positive()), { sources: [...input.sources, ...input.sources] }).valid,
    false
  )
  assert.equal(
    validateBriefingOutput(JSON.stringify(positive()), { sources: [{ ...input.sources[0]!, revision: 'wrong' }] })
      .valid,
    false
  )
})
test('an exact quote does not certify entailment or semantic correctness', () => {
  const value = positive()
  value.reason.text = 'Unmeasured invented claim, deliberately structurally valid.'
  assert.equal(check(value).valid, true)
})
