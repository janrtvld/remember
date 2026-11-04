import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseAmbientTaskPlan } from '../ambientTaskPolicy'
import type { AmbientEvidence } from '../ambientTaskStore'

function parseSpeech(
  text: string,
  title = 'Stuur de offerte',
  quote = text,
  userName: string | null = 'Jan',
  offer?: { aiSuggestion: string; prompt: string }
) {
  const evidence: AmbientEvidence = {
    kind: 'speech',
    evidenceId: 'speech:assignment',
    sourceId: 'assignment',
    revision: 'revision',
    workdayId: 'day',
    observedAt: 1,
    text,
    source: 'microphone',
    appName: '',
    bundleId: '',
    windowTitle: '',
    url: '',
  }
  return parseAmbientTaskPlan(
    {
      consideredEvidenceIds: [evidence.evidenceId],
      proposed: [
        {
          id: null,
          title,
          description: 'Stuur de offerte naar de klant.',
          prompt: offer?.prompt ?? '',
          aiSuggestion: offer?.aiSuggestion ?? null,
          context: quote,
          returnPoint: { lastMove: '', unresolved: '', nextMove: title },
          source: {
            kind: 'task',
            evidenceId: evidence.evidenceId,
            label: 'Offerte',
            detail: 'Directe toewijzing',
            conversationStartTime: null,
          },
          evidenceQuote: quote,
          ownership: 'user',
          notify: true,
        },
      ],
      changes: [],
    },
    [evidence],
    userName,
    []
  ).proposed
}

test('only direct named speech assignments matching the proposed action are admitted', () => {
  assert.equal(parseSpeech('Jan, stuur morgen de offerte naar de klant.').length, 1)
  assert.equal(parseSpeech('Jan, stuur de offerte naar mij.').length, 1)
  assert.equal(parseSpeech('Jan, could you please send the quote tomorrow?', 'Send the quote').length, 1)
  assert.equal(parseSpeech('Jan, stuur morgen de offerte naar de klant.', 'Bel de klant').length, 0)
  assert.equal(parseSpeech('Jan, stuur morgen de offerte naar de klant.', undefined, undefined, null).length, 0)
})

test('a named recipient, third person or first-person speaker does not impersonate the user', () => {
  for (const text of [
    'Jan, ik stuur de offerte morgen zelf. Groeten, Piet.',
    'Jan, Piet stuurt de offerte morgen naar de klant.',
    'Ik stuur de offerte morgen naar Jan.',
    'Jan vertelt dat iemand anders de offerte stuurt.',
    'Jan: ik stuur morgen de offerte.',
    'Jan, de offerte moet morgen naar de klant.',
    'Jan, stuur de offerte niet naar de klant.',
    'Jan, misschien stuur ik de offerte morgen.',
  ]) {
    assert.equal(parseSpeech(text).length, 0, text)
  }
  assert.equal(parseSpeech('Jan, ik stuur morgen de offerte.', 'Ik stuur offerte').length, 0)
})

test('direct second-person requests support natural Dutch and English task titles', () => {
  const assignments = [
    ['Jan, wil jij morgen een mail sturen?', 'Stuur een mail'],
    ['Jan, kun jij het voorstel opsturen?', 'Voorstel opsturen'],
    ['Jan, kun je morgen de klant bellen?', 'Bel de klant'],
    ['Jan, zou jij de planning bijwerken voor vrijdag?', 'Planning bijwerken'],
    ['Jan, could you please send the proposal tomorrow?', 'Send proposal'],
    ['Jan, can you update the schedule for Friday?', 'Update schedule'],
  ]
  for (const [text, title] of assignments) {
    assert(text && title)
    assert.equal(parseSpeech(text, title).length, 1, text)
  }
})

test('nested modal requests and negated requests do not assign another person’s action to the user', () => {
  for (const text of [
    'Jan, kun jij zien of Piet de offerte al heeft gestuurd?',
    'Jan, wil jij dat Piet de offerte stuurt?',
    'Jan, kun jij Piet vragen de offerte te sturen?',
    'Jan, wil jij morgen geen mail sturen?',
    'Jan, could you check whether Piet has sent the quote?',
    'Jan, can you have Piet send the quote?',
    'Jan, would you ask Piet to send the quote?',
    'Jan, can you send the quote? I will do it myself.',
    'Jan, kun jij de offerte sturen? Laat maar, Piet doet het.',
    'Jan, kun jij de offerte sturen? Dat hoeft niet meer.',
    'Jan, could you send the quote? Never mind, Piet will handle it.',
    'Jan, kun jij de offerte sturen? Hij stuurt hem zelf.',
    'Jan, wil jij morgen geen mail sturen? Zij wacht erop.',
  ]) {
    assert.equal(parseSpeech(text).length, 0, text)
  }
})

test('explanations after a direct request do not become ownership or negation clauses', () => {
  const assignments = [
    ['Jan, kun jij de link naar Noor sturen? Anders kan ze nu niet verder.', 'Link naar Noor sturen'],
    ['Jan, kun jij vandaag het overzicht naar Noor sturen? Zij wacht erop voor het overleg.', 'Overzicht sturen'],
    ['Jan, can you send Noor the overview? She needs it before the meeting.', 'Send overview'],
    ['Jan, could you send the link today? Otherwise she cannot continue.', 'Send link'],
    ['Jan, stuur de offerte vandaag. Hij heeft nog geen offerte ontvangen.', 'Stuur de offerte'],
  ]
  for (const [text, title] of assignments) {
    assert(text && title)
    assert.equal(parseSpeech(text, title).length, 1, text)
  }
})

test('a bounded optional draft remains attached to the supported human task and cannot establish ownership', () => {
  const offer = {
    aiSuggestion: 'Ik kan een conceptbericht over de offerte maken.',
    prompt: 'Maak alleen een concept voor controle; verstuur niets.',
  }
  const request = 'Jan, wil jij de offerte naar de klant sturen?'
  const [task] = parseSpeech(request, 'Stuur de offerte', request, 'Jan', offer)
  assert(task)
  assert.equal(task.title, 'Stuur de offerte')
  assert.equal(task.aiSuggestion, offer.aiSuggestion)
  assert.equal(task.prompt, offer.prompt)
  assert.equal(task.source?.evidenceId, 'speech:assignment')
  const ambiguous = 'Ik stuur morgen de offerte naar de klant.'
  assert.equal(parseSpeech(ambiguous, 'Stuur de offerte', ambiguous, 'Jan', offer).length, 0)
})

test('extracting a named request from reported or visibly quoted speech does not create a task', () => {
  const quote = 'Jan, stuur morgen de offerte naar de klant.'
  assert.equal(parseSpeech(`Piet zei: ${quote}`, undefined, quote).length, 0)
  assert.equal(parseSpeech(`In de video hoor je “${quote}”`, undefined, quote).length, 0)
  assert.equal(parseSpeech(`In de podcast: "${quote}"`, undefined, quote).length, 0)
})
