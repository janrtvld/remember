import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentTurnStep } from '@remember/shared'
import { progressStepText, progressSummary, visibleProgressSteps } from './assistantProgressPresentation'

const step = (text: string, kind: AgentTurnStep['kind'] = 'status'): AgentTurnStep => ({
  id: text,
  kind,
  text,
  at: 1,
})

test('progress never exposes command arguments or connector identifiers from status events', () => {
  assert.equal(
    progressStepText(step('Uitvoeren: curl -H "Authorization: secret" https://example.com')),
    'Opdracht uitvoeren…'
  )
  assert.equal(progressStepText(step('private-server: customer_data_tool')), 'Bezig…')
  assert.equal(progressStepText(step('unknown status containing /private/customer/path')), 'Bezig…')
})

test('progress preserves provided reasoning summaries without inventing work', () => {
  assert.equal(progressStepText(step('  De bronnen vergelijken.  ', 'reasoning')), 'De bronnen vergelijken.')
  assert.equal(progressStepText(step('Zoeken op het web')), 'Zoeken op het web…')
  assert.deepEqual(visibleProgressSteps([step('  ')]), [])
})

test('consecutive equivalent statuses collapse without discarding later distinct work', () => {
  const actual = visibleProgressSteps([
    step('Uitvoeren: first'),
    step('Uitvoeren: second'),
    step('Zoeken op het web'),
    step('Uitvoeren: third'),
  ])
  assert.deepEqual(
    actual.map((value) => value.text),
    ['Opdracht uitvoeren…', 'Zoeken op het web…', 'Opdracht uitvoeren…']
  )
})

test('compact summary uses an existing heading without markdown punctuation', () => {
  assert.equal(progressSummary('\n## **De bronnen vergelijken**\nDetails'), 'De bronnen vergelijken')
})

test('completed Claude progress retains its recorded status history after writing finishes', () => {
  const storedSteps = [step('Agent starten'), step('Opdracht uitdenken'), step('Antwoord schrijven')]
  assert.deepEqual(
    visibleProgressSteps(storedSteps).map((value) => value.text),
    ['Even kijken…', 'Even nadenken…', 'Antwoord schrijven…']
  )
  assert.equal(storedSteps[1].kind, 'status', 'Status events never become invented reasoning')
})

test('retained progress redacts command details and keeps provider-supplied summaries', () => {
  assert.deepEqual(
    visibleProgressSteps([
      step('Uitvoeren: private command'),
      step('Zoeken op het web'),
      step('De bronnen vergelijken.', 'reasoning'),
    ]).map((value) => value.text),
    ['Opdracht uitvoeren…', 'Zoeken op het web…', 'De bronnen vergelijken.']
  )
})
