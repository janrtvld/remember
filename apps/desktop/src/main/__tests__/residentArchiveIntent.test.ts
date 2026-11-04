import assert from 'node:assert/strict'
import { test } from 'node:test'
import { conversationQuestion, needsRememberEvidence, requestedArchiveDates } from '../residentArchiveIntent'

const now = new Date(2026, 9, 24, 12)

test('conversation routing recognizes the reported Dutch question and missed paraphrases', () => {
  for (const text of [
    'Welk gesprek had ik op 29 sep?',
    'Welke gesprekken gisteren?',
    'Which meetings yesterday?',
    'Met wie heb ik gisteren gepraat?',
    'Waarover hadden Rob en ik het?',
    'Wat hebben wij besproken?',
    'Wat zei Rob tegen mij?',
    'Kun je de opname van gisteren terugvinden?',
    'Show the transcript from September 29.',
    'Who did I speak to yesterday?',
    'What did we discuss yesterday?',
  ])
    assert.equal(conversationQuestion(text), true, text)
  for (const text of ['Wat heb ik vandaag gedaan?', 'Hoi, alles goed?', 'What is the capital of France?'])
    assert.equal(conversationQuestion(text), false, text)
})

test('explicit day and year remain bound instead of being replaced by the current year', () => {
  assert.deepEqual(requestedArchiveDates('Welk gesprek had ik op 29 sep?', now), ['2026-09-29'])
  assert.deepEqual(requestedArchiveDates('Welk gesprek had ik op 29 september 2025?', now), ['2025-09-29'])
  assert.deepEqual(requestedArchiveDates('Conversation on 2024-02-29', now), ['2024-02-29'])
  assert.deepEqual(requestedArchiveDates('Conversation on September 29, 2025', now), ['2025-09-29'])
  assert.deepEqual(requestedArchiveDates('Meeting on 29th Sept. 2025', now), ['2025-09-29'])
  assert.deepEqual(requestedArchiveDates('Gesprek van 29 sep 2025, dus 2025-09-29', now), ['2025-09-29'])
  assert.deepEqual(requestedArchiveDates('Gesprekken van 29 sep 2025 en 30 september 2026', now), [
    '2025-09-29',
    '2026-09-30',
  ])
})

test('relative dates are local calendar dates and only bind conversation requests', () => {
  assert.deepEqual(requestedArchiveDates('Met wie heb ik vandaag gepraat?', now), ['2026-10-24'])
  assert.deepEqual(requestedArchiveDates('Waarover hadden Rob en ik het gisteren?', now), ['2026-10-23'])
  assert.deepEqual(requestedArchiveDates('What did we discuss yesterday?', new Date(2026, 0, 1, 12)), ['2025-12-31'])
  assert.deepEqual(requestedArchiveDates('Wat heb ik vandaag gedaan?', now), [])
  assert.deepEqual(requestedArchiveDates('Gesprek van afgelopen maandag', now), [])
})

test('recognized impossible dates fail rather than silently removing a date constraint', () => {
  for (const text of ['Gesprek op 2026-02-29', 'Gesprek van 31 februari 2026', 'Meeting on February 31, 2026'])
    assert.throws(() => requestedArchiveDates(text, now), /invalid-request-date/, text)
  assert.throws(() => requestedArchiveDates('Gesprek vandaag', Number.NaN), /invalid-clock/)
})

test('personal day, activity, task and note questions require evidence, simple conversation does not', () => {
  for (const text of [
    'Wat heb ik vandaag gedaan?',
    'Hoe ziet mijn dag eruit?',
    'Waar ben ik gisteren mee bezig geweest?',
    'What did I do today?',
    'Laat mijn taken zien.',
    'Welke notes heb ik?',
    'Zoek dit in Remember.',
    'Toon de activity van gisteren.',
    'Met wie heb ik gisteren gepraat?',
  ])
    assert.equal(needsRememberEvidence(text), true, text)
  for (const text of ['Hoi, alles goed?', 'Thanks!', 'What is the capital of France?', 'Schrijf een kort gedicht.'])
    assert.equal(needsRememberEvidence(text), false, text)
})

test('explicit prior-answer followups do not require new evidence, but fresh personal questions still do', () => {
  assert.equal(
    needsRememberEvidence(
      'Kun je uit je vorige antwoord afleiden hoeveel uur ik aan Woub heb gewerkt? Gebruik geen nieuwe bronnen.'
    ),
    false
  )
  assert.equal(needsRememberEvidence('Hoeveel uur heb ik aan Woub gewerkt?'), true)
  assert.equal(conversationQuestion('Vat je vorige antwoord over gesprekken samen zonder nieuwe bronnen.'), false)
  assert.equal(conversationQuestion('Welke gesprekken had ik gisteren?'), true)
})

test('preferences, product questions and hypothetical ideas do not request stored facts', () => {
  for (const text of [
    'Ik wil hier gewoon met je kunnen praten. Denk met me mee over ideeën en laat af en toe uit jezelf weten wat je voor me zou kunnen doen. Maak er niet steeds een takenlijst van.',
    'Ik wil vandaag wat rustiger werken',
    'Hoe werkt Remember?',
    'Ik denk aan een app voor notities en meetings.',
    'Wat als we notities voor meetings zouden gebruiken?',
    'Welke meetings zouden nuttig zijn voor een nieuw team?',
    'Hoe zou mijn week eruitzien met minder vergaderingen?',
    'Could notes make meetings more useful?',
    'What if we built an app for recordings?',
    'I want fewer tasks and more room for ideas today.',
    'Hoe organiseer ik mijn notities?',
  ]) {
    assert.equal(conversationQuestion(text), false, text)
    assert.equal(needsRememberEvidence(text), false, text)
  }
})

test('explicit retrieval and current or past factual queries still require sources', () => {
  for (const text of [
    'Welke taken staan nog open?',
    'Welke gesprekken gisteren?',
    'Which meetings yesterday?',
    'Heb ik vandaag aan Woub gewerkt?',
    'Waar staan mijn notities?',
    'Welke gesprekken had ik gisteren?',
    'Kun je mijn notes lezen?',
    'Could you show my tasks?',
    'Hoe zag mijn week eruit?',
    'What notes do I have?',
    'Did I finish my tasks yesterday?',
    'Zoek dit in Remember.',
  ])
    assert.equal(needsRememberEvidence(text), true, text)
})
