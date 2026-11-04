import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type ArchiveConversationRecord,
  type ArchiveConversationSnapshot,
  createResidentArchiveAnswer,
} from '../residentArchiveAnswer'

const date = '2026-09-29'
const timeZone = 'Europe/Amsterdam'
const record: ArchiveConversationRecord = {
  id: 'episode-1',
  dayId: 'day-1',
  date,
  startedAt: Date.parse('2026-09-29T11:05:00Z'),
  endedAt: Date.parse('2026-09-29T11:11:00Z'),
  acceptance: 'classified',
  revision: 'revision-1',
  transcript: 'Could we compare the two drawings? The first drawing has a larger doorway.',
}
const signal = () => new AbortController().signal
const selection = () => ({ date, selections: [{ id: record.id, quote: 'Could we compare the two drawings?' }] })
function setup(
  entries: ArchiveConversationRecord[] = [record],
  sourceKind: ArchiveConversationSnapshot['sourceKind'] = 'local-audio-episodes',
  includeTimes = false
) {
  let current: ArchiveConversationSnapshot = {
    sourceKind,
    date,
    timeZone,
    total: entries.length,
    complete: true,
    entries,
  }
  let clock = 1000
  let permitted = true
  const ledger = createResidentArchiveAnswer({
    locale: 'nl',
    includeTimes,
    now: () => clock,
    ttlMs: 100,
    assertCurrent: () => {
      if (!permitted) throw new Error('permission-revoked')
    },
    revalidate: async () => current,
  })
  return {
    ledger,
    page: () =>
      ledger.recordPage({ sourceKind, date, timeZone, total: entries.length, offset: 0, nextOffset: null, entries }),
    setCurrent: (next: ArchiveConversationSnapshot) => {
      current = next
    },
    tick: (next: number) => {
      clock = next
    },
    revoke: () => {
      permitted = false
    },
  }
}

test('publishes only canonical time and an exact source quote, with no model prose or raw IDs', async () => {
  const { ledger, page } = setup([record], 'local-audio-episodes', true)
  page()
  const result = await ledger.answer(selection(), signal())
  assert.match(result.text, /29 september 2026/)
  assert.match(result.text, /13:05–13:11 CEST \(als gesprek herkend\)/)
  assert.ok(result.text.includes('Could we compare the two drawings?'))
  assert.ok(!result.text.includes(record.id))
  assert.deepEqual(result.receipt.sourceIds, [record.id])
  await assert.rejects(ledger.answer({ ...selection(), answer: 'Jan met Sam.' }, signal()), /invalid-selection/)
})

test('complete empty results produce truthful absence and reject invented selections', async () => {
  const { ledger, page } = setup([])
  page()
  const answer = await ledger.answer({ date, selections: [] }, signal())
  assert.match(answer.text, /lokale audioarchief geen gespreksfragmenten/)
  assert.match(answer.text, /Geïmporteerde gesprekken zijn hierin niet meegenomen/)
  assert.ok(!answer.text.includes('Sam'))
  await assert.rejects(ledger.answer(selection(), signal()), /invalid-selection/)
})

test('requires a fresh complete listing even for an empty answer', async () => {
  const { ledger, page, setCurrent } = setup([])
  await assert.rejects(ledger.answer({ date, selections: [] }, signal()), /retrieval-incomplete/)
  page()
  setCurrent({ date, timeZone, total: 1, complete: true, entries: [record] })
  await assert.rejects(ledger.answer({ date, selections: [] }, signal()), /sources-changed/)
})

test('rejects source IDs outside retrieval and paraphrases with unsupported participants', async () => {
  const { ledger, page } = setup()
  page()
  await assert.rejects(
    ledger.answer({ date, selections: [{ id: 'demo', quote: record.transcript }] }, signal()),
    /source-not-retrieved/
  )
  await assert.rejects(
    ledger.answer({ date, selections: [{ id: record.id, quote: 'Jan met Sam.' }] }, signal()),
    /quote-not-in-source/
  )
  await assert.rejects(
    ledger.answer({ date, selections: [{ id: record.id, quote: 'Could', participant: 'Sam' }] }, signal()),
    /invalid-selection/
  )
})

test('waits for all pages and keeps total distinct from the selected subset', async () => {
  const entries = Array.from({ length: 11 }, (_, i) => ({ ...record, id: `episode-${i}` }))
  const { ledger } = setup(entries)
  ledger.recordPage({ date, timeZone, total: 11, offset: 0, nextOffset: 10, entries: entries.slice(0, 10) })
  await assert.rejects(ledger.answer(selection(), signal()), /retrieval-incomplete/)
  assert.throws(
    () => ledger.recordPage({ date, timeZone, total: 11, offset: 9, nextOffset: null, entries: entries.slice(9) }),
    /page-sequence-mismatch/
  )
  ledger.recordPage({ date, timeZone, total: 11, offset: 10, nextOffset: null, entries: entries.slice(10) })
  const result = await ledger.answer(selection(), signal())
  assert.match(result.text, /11 lokale gespreksfragmenten/)
  assert.match(result.text, /Hieronder 1 daarvan/)
})

test('rejects changed revision, changed text, deletion and source reclassification on fresh read', async () => {
  for (const entries of [
    [{ ...record, revision: 'revision-2' }],
    [{ ...record, transcript: 'Other content' }],
    [],
    [{ ...record, acceptance: 'confirmed' as const }],
  ]) {
    const { ledger, page, setCurrent } = setup()
    page()
    setCurrent({ date, timeZone, total: entries.length, complete: true, entries })
    await assert.rejects(ledger.answer(selection(), signal()), /sources-changed/)
  }
})

test('rejects expired receipts and regressing clocks', async () => {
  for (const clock of [999, 1101]) {
    const { ledger, page, tick } = setup()
    page()
    tick(clock)
    await assert.rejects(ledger.answer(selection(), signal()), /expired/)
  }
})

test('checks cancellation and permission again after async readback', async () => {
  for (const mode of ['cancel', 'revoke'] as const) {
    const controller = new AbortController()
    let permitted = true
    const ledger = createResidentArchiveAnswer({
      locale: 'nl',
      assertCurrent: () => {
        if (!permitted) throw new Error('permission-revoked')
      },
      revalidate: async () => {
        if (mode === 'cancel') controller.abort()
        else permitted = false
        return { date, timeZone, total: 1, complete: true, entries: [record] }
      },
    })
    ledger.recordPage({ date, timeZone, total: 1, offset: 0, nextOffset: null, entries: [record] })
    await assert.rejects(ledger.answer(selection(), controller.signal), /cancelled|permission-revoked/)
  }
})

test('copies caller selections and source data before awaiting', async () => {
  const source = structuredClone(record)
  let resolve: ((value: ArchiveConversationSnapshot) => void) | undefined
  const ledger = createResidentArchiveAnswer({
    locale: 'en',
    assertCurrent: () => {},
    revalidate: () =>
      new Promise((done) => {
        resolve = done
      }),
  })
  ledger.recordPage({ date, timeZone, total: 1, offset: 0, nextOffset: null, entries: [source] })
  const input = selection()
  const pending = ledger.answer(input, signal())
  const firstSelection = input.selections[0]
  assert.ok(firstSelection)
  firstSelection.quote = 'Sam invented text'
  source.transcript = 'Sam invented text'
  assert.ok(resolve)
  resolve({ date, timeZone, total: 1, complete: true, entries: [record] })
  const result = await pending
  assert.match(result.text, /Could we compare/)
  assert.ok(!result.text.includes('Sam'))
})

test('bounds a never-settling read and gives its owned timeout priority over abort rejection', async () => {
  for (const cooperate of [false, true]) {
    const ledger = createResidentArchiveAnswer({
      locale: 'nl',
      assertCurrent: () => {},
      timeoutMs: 5,
      revalidate: (_date, abort) =>
        new Promise((_resolve, reject) => {
          if (cooperate) abort.addEventListener('abort', () => reject(new Error('dependency-abort')))
        }),
    })
    ledger.recordPage({ date, timeZone, total: 1, offset: 0, nextOffset: null, entries: [record] })
    await assert.rejects(ledger.answer(selection(), signal()), /remember-answer-timeout/)
  }
})

test('escapes transcript markup instead of creating links or HTML', async () => {
  const entry = {
    ...record,
    acceptance: 'confirmed' as const,
    transcript: '[Open](https://example.invalid) <script>hello</script>',
  }
  const { ledger, page } = setup([entry])
  page()
  const result = await ledger.answer({ date, selections: [{ id: entry.id, quote: entry.transcript }] }, signal())
  assert.match(result.text, /door jou bevestigd/)
  assert.ok(result.text.includes('\\[Open\\]\\(https://example.invalid\\)'))
  assert.ok(result.text.includes('&lt;script&gt;'))
})

test('rejects malformed dates, mismatched local days, duplicate IDs and dishonest pagination', () => {
  for (const page of [
    { date: '2026-02-30', timeZone, total: 0, offset: 0, nextOffset: null, entries: [] },
    {
      date,
      timeZone,
      total: 1,
      offset: 0,
      nextOffset: null,
      entries: [{ ...record, startedAt: Date.parse('2026-09-28T21:00:00Z') }],
    },
    { date, timeZone, total: 2, offset: 0, nextOffset: null, entries: [record, record] },
    { date, timeZone, total: 2, offset: 0, nextOffset: null, entries: [record] },
  ]) {
    assert.throws(() => setup().ledger.recordPage(page), /remember-answer-/)
  }
})

test('reports missing transcript text without treating records as an empty day', async () => {
  const { ledger, page } = setup([{ ...record, transcript: '' }])
  page()
  const result = await ledger.answer({ date, selections: [] }, signal())
  assert.match(result.text, /1 lokaal gespreksfragment/)
  assert.match(result.text, /transcriptie is niet beschikbaar/)
  assert.ok(!result.text.includes('geen opgeslagen gesprekken'))
})

const imported: ArchiveConversationRecord = {
  ...record,
  id: 'revinote:meeting-1',
  acceptance: 'imported',
  dateBasis: 'archive-day',
  savedTitle: 'Project discussion',
  startedAt: Date.parse('2026-09-29T22:15:00Z'),
  endedAt: Date.parse('2026-09-29T22:30:00Z'),
}
const importedSelection = () => ({ date, selections: [{ id: imported.id, quote: imported.transcript }] })

test('preserves an imported archive-day label while displaying its different actual local date', async () => {
  const { ledger, page } = setup([imported], 'remember-conversations', true)
  page()
  const result = await ledger.answer(importedSelection(), signal())
  assert.match(result.text, /onder 29 september 2026 1 opgeslagen gesprek/)
  assert.match(result.text, /30 september 2026 om 00:15–00:30 CEST/)
  assert.match(result.text, /opgeslagen titel: “Project discussion”/)
  assert.ok(!result.text.includes('door jou bevestigd'))
  assert.ok(!result.text.includes('als gesprek herkend'))
  assert.equal(result.receipt.sourceKind, 'remember-conversations')
})

test('archive-day admission does not weaken local-calendar date checks', () => {
  const { page } = setup([{ ...imported, dateBasis: 'local-calendar' }], 'remember-conversations')
  assert.throws(page, /record-date-mismatch/)
  const localOnly = setup([imported])
  assert.throws(localOnly.page, /source-kind-mismatch/)
})

test('escapes the stored imported title and does not allow a title to masquerade as transcript evidence', async () => {
  const entry = { ...imported, savedTitle: '[Meeting](https://example.invalid) <b>Test</b>' }
  const { ledger, page } = setup([entry], 'remember-conversations')
  page()
  const result = await ledger.answer(importedSelection(), signal())
  assert.ok(result.text.includes('\\[Meeting\\]\\(https://example.invalid\\) &lt;b&gt;Test&lt;/b&gt;'))
  await assert.rejects(
    ledger.answer({ date, selections: [{ id: entry.id, quote: entry.savedTitle }] }, signal()),
    /quote-not-in-source/
  )
  assert.throws(setup([{ ...record, savedTitle: 'Not an imported title' }]).page, /invalid-record/)
})

test('rejects changed imported title, date basis and archive coverage before publication', async () => {
  const sameCalendarImport = { ...imported, startedAt: record.startedAt, endedAt: record.endedAt }
  for (const changed of [
    { ...sameCalendarImport, savedTitle: 'Different stored title' },
    { ...sameCalendarImport, dateBasis: 'local-calendar' as const },
  ]) {
    const { ledger, page, setCurrent } = setup([sameCalendarImport], 'remember-conversations')
    page()
    setCurrent({ sourceKind: 'remember-conversations', date, timeZone, total: 1, complete: true, entries: [changed] })
    await assert.rejects(ledger.answer(importedSelection(), signal()), /sources-changed/)
  }
  const { ledger, page, setCurrent } = setup([], 'remember-conversations')
  page()
  setCurrent({ sourceKind: 'local-audio-episodes', date, timeZone, total: 0, complete: true, entries: [] })
  await assert.rejects(ledger.answer({ date, selections: [] }, signal()), /sources-changed/)
})

test('combined empty coverage does not claim imported meetings were excluded', async () => {
  const { ledger, page } = setup([], 'remember-conversations')
  page()
  const result = await ledger.answer({ date, selections: [] }, signal())
  assert.match(result.text, /geen opgeslagen gesprekken of gespreksfragmenten/)
  assert.ok(!result.text.includes('niet meegenomen'))
  assert.equal(result.receipt.sourceKind, 'remember-conversations')
})

test('keeps imported conversation count separate from local fragments', async () => {
  const { ledger, page } = setup([imported, record], 'remember-conversations')
  page()
  const result = await ledger.answer(
    { date, selections: [...importedSelection().selections, ...selection().selections] },
    signal()
  )
  assert.match(result.text, /1 opgeslagen gesprek en 1 lokaal gespreksfragment/)
  assert.match(result.text, /als gesprek herkend/)
  assert.ok(!result.text.includes('2 gesprekken'))
})

test('ordinary answers show the stored title and exact quote without timestamps by default', async () => {
  const snapshot: ArchiveConversationSnapshot = {
    sourceKind: 'remember-conversations',
    date,
    timeZone,
    total: 1,
    complete: true,
    entries: [imported],
  }
  const ledger = createResidentArchiveAnswer({
    locale: 'nl',
    assertCurrent: () => {},
    revalidate: async () => snapshot,
  })
  ledger.recordPage({ ...snapshot, offset: 0, nextOffset: null })
  const result = await ledger.answer(importedSelection(), signal())
  assert.match(result.text, /29 september 2026/)
  assert.match(result.text, /Voor 29 september 2026 staat één gesprek opgeslagen: \*\*Project discussion\*\*\./)
  assert.match(result.text, /Uit het transcript:/)
  assert.ok(!result.text.includes('(opgeslagen titel)'))
  assert.ok(result.text.includes(imported.transcript))
  assert.ok(!result.text.includes('00:15'))
  assert.ok(!result.text.includes('30 september'))
  assert.ok(!result.text.includes('CEST'))
})
