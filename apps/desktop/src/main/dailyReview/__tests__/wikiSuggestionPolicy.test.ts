import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WikiPageUpdate } from '@remember/shared'
import {
  collectWikiSuggestionSources,
  comparableWikiContent,
  reviewedWikiSuggestions,
  selectDayWikiSuggestionSources,
  wikiSuggestionSources,
} from '../wikiSuggestionPolicy'

const candidate: WikiPageUpdate = {
  slug: 'projects/usa',
  title: 'USA',
  content: 'Checkout September 30.',
  summary: 'Confirmed checkout.',
  changeType: 'updated',
}
const source = {
  id: 'new-message',
  kind: 'agent-session',
  observedAt: 200,
  text: 'Our hotel checkout is now confirmed for September 30.',
}

test('Day Wiki review retrieves an earlier decision behind a full newer-screen budget', () => {
  const earlier = { kind: 'screen-context' as const, evidenceId: 'earlier-decision', timestamp: 200, text: source.text }
  const entries = [
    earlier,
    ...Array.from({ length: 5 }, (_, index) => ({
      kind: 'screen-context' as const,
      evidenceId: `later-screen-${index}`,
      timestamp: 300 + index,
      text: `Screen ${index}: ${'x'.repeat(11_989)}`,
    })),
  ]
  assert.equal(
    wikiSuggestionSources(entries, [], 100, 400).some((item) => item.id === earlier.evidenceId),
    false
  )
  const all = collectWikiSuggestionSources(entries, [], 100, 400)
  const selected = selectDayWikiSuggestionSources(candidate, { content: 'Checkout unconfirmed.' }, all)
  assert.equal(selected.sources[0]?.id, earlier.evidenceId)
  assert.equal(selected.sources[0]?.text, earlier.text)
  assert.ok(selected.sources.reduce((sum, item) => sum + item.text.length, 0) <= 60_000)
  assert.deepEqual(selected.deferredSourceIds, [])
  const accepted = reviewedWikiSuggestions(
    { accepted: [{ index: 0, sourceId: earlier.evidenceId, quote: earlier.text }] },
    [candidate],
    selected.sources
  )
  assert.equal(accepted[0]?.evidence?.[0]?.sourceId, earlier.evidenceId)
})

test('unchanged long page content does not crowd the actual correction out of Day review', () => {
  const unchanged = `${'Release build signed deployment pipeline architecture.\n'.repeat(400)}\n`
  const correction = 'Hotel checkout confirmed for September 30.'
  const update = { ...candidate, content: `${unchanged}${correction}` }
  const sources = [
    { ...source, id: 'newer-build', observedAt: 300, text: 'Release build signed deployment pipeline architecture.' },
    { ...source, id: 'older-correction', observedAt: 200, text: correction },
  ]
  const selected = selectDayWikiSuggestionSources(update, { content: unchanged }, sources, 60)
  assert.deepEqual(
    selected.sources.map((item) => item.id),
    ['older-correction']
  )
  assert.deepEqual(selected.deferredSourceIds, [])
})

test('a focused proposal does not treat omitted existing sections as requested deletions', () => {
  const correction = 'Hotel checkout confirmed for September 30.'
  const unrelated = 'Release build signed deployment pipeline architecture.'
  const selected = selectDayWikiSuggestionSources(
    { ...candidate, content: correction },
    { content: `## Travel\n\nCheckout unconfirmed.\n\n## Deployment\n\n${unrelated}` },
    [
      { ...source, id: 'unrelated-newer', observedAt: 300, text: unrelated },
      { ...source, id: 'actual-correction', observedAt: 200, text: correction },
    ],
    correction.length
  )
  assert.deepEqual(
    selected.sources.map((item) => item.id),
    ['actual-correction']
  )
  assert.deepEqual(selected.deferredSourceIds, [])
})

test('Day source ranking preserves complete context and prefers newer equally relevant evidence', () => {
  const text = 'Hotel checkout September 30 was proposed, but remains unconfirmed. Do not book it yet.'
  const older = { ...source, id: 'older-proposal', observedAt: 200, text }
  const newer = { ...source, id: 'newer-correction', observedAt: 300, text }
  const selected = selectDayWikiSuggestionSources(candidate, undefined, [older, newer], text.length)
  assert.deepEqual(selected.sources, [newer])
  assert.equal(selected.sources[0], newer)
  assert.deepEqual(selected.deferredSourceIds, [])
  assert.deepEqual(selected.newerDeferredSourceIds, [])
})

test('Day review reserves the newest source for each change before repeated captures fill its budget', () => {
  const checkout = 'Hotel checkout September 30 confirmed.'
  const car = 'Rental car return October 11 at 10:00.'
  const update = { ...candidate, content: `${checkout}\n${car}`, summary: 'Reconciled travel arrangements.' }
  const sources = [
    ...Array.from({ length: 10 }, (_, index) => ({
      ...source,
      id: `checkout-${index}`,
      observedAt: 300 + index,
      text: checkout,
    })),
    { ...source, id: 'car-return', observedAt: 200, text: car },
  ]
  const selected = selectDayWikiSuggestionSources(update, undefined, sources, checkout.length + car.length)
  assert.deepEqual(
    selected.sources.map((item) => item.id),
    ['checkout-9', 'car-return']
  )
  assert.deepEqual(selected.deferredSourceIds, [])
})

test('an omitted newer correction remains unsafe even when an older source can support the candidate', () => {
  const newer = {
    ...source,
    id: 'newer-correction',
    observedAt: 300,
    text: `Hotel checkout September 30 is no longer confirmed.\n${'Complete original context. '.repeat(30)}`,
  }
  const selected = selectDayWikiSuggestionSources(candidate, undefined, [source, newer], 100)
  assert.deepEqual(selected.sources, [source])
  assert.deepEqual(selected.newerDeferredSourceIds, ['newer-correction'])
  assert.equal(
    reviewedWikiSuggestions(
      { accepted: [{ index: 0, sourceId: source.id, quote: source.text }] },
      [candidate],
      selected.sources
    ).length,
    1,
    'A successful quote check alone cannot establish that the omitted newer context was considered'
  )
})

test('an oversized relevant source is deferred whole, while omitted unrelated sources are not', () => {
  const relevant = {
    ...source,
    id: 'large-correction',
    text: `${source.text}\n${'Full original context. '.repeat(30)}`,
  }
  const unrelated = { ...source, id: 'large-unrelated', text: 'Build deployment diagnostics. '.repeat(30) }
  const selected = selectDayWikiSuggestionSources(candidate, undefined, [relevant, unrelated], 100)
  assert.deepEqual(selected.sources, [])
  assert.deepEqual(selected.deferredSourceIds, ['large-correction'])
  assert.deepEqual(selected.newerDeferredSourceIds, ['large-correction'])
  assert.deepEqual(selectDayWikiSuggestionSources(candidate, undefined, [unrelated], 100).deferredSourceIds, [])
})

test('a shared project name alone does not make an omitted source relevant to the correction', () => {
  const unrelated = { ...source, id: 'project-only', text: 'USA guide browser navigation '.repeat(30) }
  const selected = selectDayWikiSuggestionSources(candidate, undefined, [unrelated], 100)
  assert.deepEqual(selected.deferredSourceIds, [])
})

test('uncapped Day collection keeps capture boundaries and never imports agent messages', () => {
  const sources = collectWikiSuggestionSources(
    [
      { kind: 'screen-context', evidenceId: 'before', timestamp: 100, text: 'Before the analysis window.' },
      { kind: 'screen-context', evidenceId: 'eligible', timestamp: 200, text: source.text },
      { kind: 'agent-message', evidenceId: 'direct-import', timestamp: 210, text: 'Original agent message.' },
      { kind: 'screen-context', evidenceId: 'after', timestamp: 400, text: 'After the analysis window.' },
    ],
    [],
    100,
    300
  )
  assert.deepEqual(
    sources.map((item) => item.id),
    ['eligible']
  )
})

test('captured Codex and Claude screens remain eligible without importing original agent conversations', () => {
  for (const app of ['Codex', 'Claude']) {
    const text = 'User decision: move the Yosemite hiking day to October 4.'
    const sources = wikiSuggestionSources(
      [
        { kind: 'screen-context', app, evidenceId: 'visible-screen', timestamp: 200, text },
        { kind: 'agent-message', app, evidenceId: 'imported-message', timestamp: 200, text },
      ],
      [],
      100,
      300
    )
    assert.deepEqual(
      sources.map((entry) => entry.id),
      ['visible-screen']
    )
    const accepted = reviewedWikiSuggestions(
      { accepted: [{ index: 0, sourceId: 'visible-screen', quote: text }] },
      [candidate],
      sources
    )
    assert.equal(accepted[0]?.evidence?.[0]?.kind, 'screen-context')
  }
})

test('only accepts a candidate supported by an exact known source passage', () => {
  const decisions = {
    accepted: [
      { index: 0, sourceId: source.id, quote: source.text },
      { index: 0, sourceId: source.id, quote: source.text },
      { index: 1, sourceId: 'invented', quote: source.text },
      { index: 2, sourceId: source.id, quote: 'A plausible but fabricated quote about the hotel.' },
      { index: 3, sourceId: source.id, quote: 'hotel' },
      { index: 4, sourceId: source.id, quote: source.text },
    ],
  }
  const accepted = reviewedWikiSuggestions(decisions, [candidate, candidate, candidate, candidate], [source])
  assert.equal(accepted.length, 1)
  assert.deepEqual(accepted[0]?.evidence, [
    { sourceId: source.id, kind: source.kind, observedAt: 200, quote: source.text },
  ])
  assert.deepEqual(reviewedWikiSuggestions({ accepted: [] }, [candidate], [source]), [])
  assert.deepEqual(reviewedWikiSuggestions({ accepted: 'bad-output' }, [candidate], [source]), [])
  assert.deepEqual(
    reviewedWikiSuggestions(
      { accepted: [{ index: 0, sourceId: source.id, quote: source.text }] },
      [candidate],
      [source],
      [{ slug: candidate.slug, content: `## Booking\n\n${source.text}` }]
    ),
    []
  )
})

test('a short complete user instruction passes while a short excerpt of longer evidence does not', () => {
  const instruction = {
    id: 'preference',
    kind: 'agent-session',
    role: 'user' as const,
    observedAt: 200,
    text: 'Use pnpm.',
  }
  const verdict = { accepted: [{ index: 0, sourceId: instruction.id, quote: instruction.text }] }
  const accepted = reviewedWikiSuggestions(verdict, [candidate], [instruction])
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0]?.evidence?.[0]?.role, 'user')
  assert.deepEqual(
    reviewedWikiSuggestions(
      verdict,
      [candidate],
      [{ ...instruction, eventId: 'long-message', partIndex: 5, partCount: 6 }]
    ),
    [],
    'The last short fragment of a split message is not a complete short source'
  )
  assert.deepEqual(
    reviewedWikiSuggestions(
      verdict,
      [candidate],
      [{ ...instruction, text: 'Use pnpm. Only for this project; the other project uses npm.' }]
    ),
    []
  )
})

test('evidence retains the original agent and user roles, task and project for local review', () => {
  const sources = wikiSuggestionSources(
    [],
    [
      {
        provider: 'codex',
        kind: 'session',
        sourceId: 'original-task',
        project: 'Remember',
        updatedAt: 200,
        content: 'Use pnpm.',
        messages: [
          { role: 'user', content: 'Use pnpm.', observedAt: 100 },
          { role: 'assistant', content: 'Use pnpm.', observedAt: 200 },
        ],
      },
    ],
    0,
    300
  )
  assert.equal(sources.length, 2)
  const userSource = sources.find((entry) => entry.role === 'user')
  assert.ok(userSource)
  const accepted = reviewedWikiSuggestions(
    { accepted: [{ index: 0, sourceId: userSource.id, quote: userSource.text }] },
    [candidate],
    sources
  )
  assert.equal(accepted[0]?.evidence?.[0]?.documentSourceId, 'original-task')
  assert.equal(accepted[0]?.evidence?.[0]?.provider, 'codex')
  assert.equal(accepted[0]?.evidence?.[0]?.project, 'Remember')
  assert.equal(accepted[0]?.evidence?.[0]?.role, 'user')
})

test('end-of-day replay cannot make old captured evidence fresh again', () => {
  const sources = wikiSuggestionSources(
    [
      { timestamp: 99, kind: 'screen-context', text: 'Old itinerary opened in the browser.' },
      { timestamp: 100, kind: 'transcript', text: 'Already processed at the boundary.' },
      { timestamp: 110, kind: 'app-period', text: 'Browser usage is not a new fact.' },
      { timestamp: 200, kind: 'transcript', text: source.text },
      { timestamp: 201, kind: 'screen-context', text: source.text },
      { timestamp: 400, kind: 'transcript', text: 'Beyond this refresh boundary.' },
    ],
    [],
    100,
    300
  )
  assert.equal(sources.length, 1)
  assert.equal(sources[0]?.text, source.text)
})

test('separate original user events retain separate evidence identity even when the person repeats a preference', () => {
  const sources = wikiSuggestionSources(
    [],
    [
      {
        provider: 'codex',
        kind: 'session',
        sourceId: 'task',
        project: 'Remember',
        updatedAt: 300,
        content: 'Use pnpm.',
        messages: [
          { role: 'user', eventId: 'first', content: 'Use pnpm.', observedAt: 100 },
          { role: 'user', eventId: 'later-correction', content: 'Use pnpm.', observedAt: 300 },
        ],
      },
    ],
    0,
    300
  )
  assert.equal(sources.length, 2)
  assert.notEqual(sources[0]?.id, sources[1]?.id)
})

test('managed-source metadata and incidental whitespace cannot manufacture a content change', () => {
  const stored =
    'Human notes.\n<!-- remember-managed:start -->\nCheckout is September 30.\n<!-- remember-managed:end -->\n<!-- remember-source:old -->'
  assert.equal(comparableWikiContent(stored), comparableWikiContent('Checkout is  September 30.\n'))
  assert.notEqual(comparableWikiContent(stored), comparableWikiContent('Checkout is October 1.'))
})
