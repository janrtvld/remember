import assert from 'node:assert/strict'
import { test } from 'node:test'
import { callCodexClientTool } from '../codexClientTools'
import { createResidentArchiveSession } from '../residentArchiveSession'

const date = '2026-09-29'
const context = { signal: new AbortController().signal, threadId: 'thread', turnId: 'turn', callId: 'call' }
const checkedQuote = 'We bespreken alleen de planning voor volgende week.'

function fixture(
  options: { instruction?: string; recovery?: boolean; transcript?: string; locale?: 'nl' | 'en' } = {}
) {
  let entries = [
    {
      id: 'episode-synthetic',
      dayId: 'day-synthetic',
      date,
      startedAt: Date.parse('2026-09-29T10:00:00Z'),
      endedAt: Date.parse('2026-09-29T10:02:00Z'),
      acceptance: 'classified',
      revision: 'revision-1',
      text: options.transcript ?? checkedQuote,
    },
  ]
  let error: Error | null = null
  let current = true
  const calls: string[][] = []
  const session = createResidentArchiveSession({
    instruction: options.instruction ?? 'Welk gesprek had ik op 29 september?',
    recovery: options.recovery ?? false,
    locale: options.locale ?? 'nl',
    assertCurrent: () => {
      if (!current) throw new Error('source-revoked')
    },
    run: async (args) => {
      calls.push(args)
      if (error) throw error
      return {
        schemaVersion: 1,
        availability: 'available',
        sourceKind: 'local-audio-episodes',
        selector: date,
        timezone: 'Europe/Amsterdam',
        count: entries.length,
        offset: 0,
        nextOffset: null,
        items: structuredClone(entries),
      }
    },
  })
  const archive = session.tools.find((tool) => tool.name === 'remember_archive')
  assert.ok(archive)
  return {
    session,
    archive,
    calls,
    read: () => archive.call({ action: 'conversations', date }, context),
    remove: () => {
      entries = []
    },
    fail: () => {
      error = new Error('archive-offline')
    },
    revoke: () => {
      current = false
    },
  }
}

test('a conversation answer cannot bypass archive retrieval by returning confident prose', async () => {
  const f = fixture()
  const response = await f.session.finalize('Je sprak met Sam over de Northstar-pilot.', context.signal)
  assert.match(response, /niet betrouwbaar/)
  assert.doesNotMatch(response, /Sam|Northstar/)
  assert.equal(f.calls.length, 0)
})

test('one archive tool read supports natural synthesis without a second publishing tool', async () => {
  const f = fixture()
  assert.deepEqual(
    f.session.tools.map((tool) => tool.name),
    ['remember_archive']
  )
  await f.read()
  const response = 'Het opgeslagen gesprek ging over de planning voor volgende week.'
  assert.equal(await f.session.finalize(response, context.signal), response)
  assert.equal(f.calls.length, 2, 'retrieval plus one freshness check')
})

test('deletion after retrieval withholds the answer before publication', async () => {
  const f = fixture()
  await f.read()
  f.remove()
  assert.match(await f.session.finalize(checkedQuote, context.signal), /niet betrouwbaar/)
})

test('a failed source read cannot fall back to an invented empty or historical answer', async () => {
  const f = fixture()
  f.fail()
  await assert.rejects(f.read(), /archive-offline/)
  const response = await f.session.finalize('Er waren geen gesprekken die dag.', context.signal)
  assert.match(response, /niet betrouwbaar/)
  assert.doesNotMatch(response, /geen gesprekken/)
})

test('recovered remote prose without a fresh ledger is withheld even for a generic instruction', async () => {
  const f = fixture({ recovery: true, instruction: 'Vertel meer.' })
  const response = await f.session.finalize('Je afspraak met Sam was om 13:05.', context.signal)
  assert.match(response, /niet opnieuw.*getoetst/)
  assert.doesNotMatch(response, /Sam|13:05/)
  assert.equal(f.calls.length, 0)
})

test('an ordinary greeting remains conversational without fabricated archive access', async () => {
  const f = fixture({ instruction: 'Hoi, alles goed?' })
  assert.equal(
    await f.session.finalize('Hoi! Waar kan ik je mee helpen?', context.signal),
    'Hoi! Waar kan ik je mee helpen?'
  )
  assert.equal(f.calls.length, 0)
})

test('revocation after retrieval is propagated rather than softened into a source answer', async () => {
  const f = fixture()
  await f.read()
  f.revoke()
  await assert.rejects(f.session.finalize(checkedQuote, context.signal), /source-revoked/)
})

test('an oversized archive result is denied before recording a usable source read', async () => {
  const f = fixture({ transcript: `${checkedQuote} ${'lang transcript '.repeat(3000)}` })
  const delivered = await callCodexClientTool(f.archive, { action: 'conversations', date }, context)
  assert.equal(delivered.success, false)
  assert.match(delivered.contentItems[0].text, /too-large/)
  assert.match(await f.session.finalize('Unverified prose', context.signal), /niet betrouwbaar/)
})

test('personal questions and conversation paraphrases require fresh source reads', async () => {
  for (const instruction of [
    'Met wie heb ik gisteren gepraat?',
    'Welke gesprekken gisteren?',
    'Which meetings yesterday?',
    'Waarover hadden Rob en ik het?',
    'Wat heb ik vandaag gedaan?',
  ]) {
    const f = fixture({ instruction })
    const result = await f.session.finalize('Je sprak met Sam over Northstar.', context.signal)
    assert.match(result, /niet betrouwbaar/)
    assert.doesNotMatch(result, /Sam|Northstar/)
  }
})

test('a valid quote from the wrong requested date cannot be published', async () => {
  const f = fixture({ instruction: 'Welk gesprek had ik op 28 september 2026?' })
  await assert.rejects(f.read(), /request-date-mismatch/)
  assert.match(await f.session.finalize(checkedQuote, context.signal), /niet betrouwbaar/)
})

test('personal non-conversation answers revalidate recorded reads immediately before publishing', async () => {
  const f = fixture({ instruction: 'Wat heb ik vandaag gedaan?' })
  let data = { activity: ['Eigen project bekeken'] }
  f.session.recordOtherRead('activity', data, async () => structuredClone(data))
  assert.equal(await f.session.finalize('Je bekeek je eigen project.', context.signal), 'Je bekeek je eigen project.')
  data = { activity: [] }
  const withheld = await f.session.finalize('Je bekeek je eigen project.', context.signal)
  assert.match(withheld, /niet betrouwbaar/)
  assert.doesNotMatch(withheld, /eigen project/)
})

test('a changed repeated read remains withheld even if its latest version validates', async () => {
  const f = fixture({ instruction: 'Wat heb ik vandaag gedaan?' })
  const earlier = { activity: ['Oud'] }
  const current = { activity: ['Nieuw'] }
  f.session.recordOtherRead('same-query', earlier, async () => earlier)
  f.session.recordOtherRead('same-query', current, async () => current)
  assert.match(await f.session.finalize('Oud', context.signal), /niet betrouwbaar/)
})

test('an approved Task change rebases only that row and permits a verified save confirmation', async () => {
  const f = fixture({ instruction: 'Werk mijn taak bij.' })
  const before = { id: 'task-A', title: 'Oud', lifecycle: 'open', status: 'todo', dueAt: null, updatedAt: 10 }
  const after = { ...before, title: 'Nieuw', updatedAt: 11 }
  const other = { ...before, id: 'task-B', title: 'Andere taak' }
  let task = { task: before }
  let list = { action: 'tasks', entries: [{ ...before, description: 'Bestaande uitleg' }, other], total: 2 }
  const day = { action: 'day_state', entries: [{ text: 'Historische dagupdate' }] }
  f.session.recordOtherRead('task:task-A', task, async () => task)
  f.session.recordOtherRead('{"action":"tasks"}', list, async () => list)
  f.session.recordOtherRead('{"action":"day_state"}', day, async () => day)
  task = { task: after }
  list = { ...list, entries: [other, { ...after, description: 'Bestaande uitleg' }] }
  await f.session.refreshTaskReads('task-A', { task: before }, { saved: true, task: after }, context.signal)
  f.session.recordOtherRead('task:task-A', task, async () => task)
  assert.equal(await f.session.finalize('De titel is aangepast.', context.signal), 'De titel is aangepast.')
})

test('approved Task rebasing cannot bless unrelated changes, loss of a historical Day, or page membership changes', async () => {
  for (const change of ['other-task', 'description', 'day', 'page'] as const) {
    const f = fixture({ instruction: 'Werk mijn taak bij.' })
    const before = { id: 'task-A', title: 'Oud', status: 'todo', updatedAt: 10 }
    const after = { ...before, title: 'Nieuw', updatedAt: 11 }
    const other = { ...before, id: 'task-B', title: 'Andere taak' }
    let list = { action: 'tasks', entries: [{ ...before, description: 'Bestaande uitleg' }, other], total: 2 }
    let day = { action: 'day_state', entries: [{ text: 'Dagupdate' }] }
    f.session.recordOtherRead('{"action":"tasks"}', list, async () => list)
    f.session.recordOtherRead('{"action":"day_state"}', day, async () => day)
    list = { ...list, entries: [{ ...after, description: 'Bestaande uitleg' }, other] }
    if (change === 'other-task') list.entries[1] = { ...other, title: 'Anders', updatedAt: 12 }
    if (change === 'description') list.entries[0] = { ...after, description: 'Onverwachte uitleg' }
    if (change === 'page') list.entries[1] = { ...other, id: 'task-C' }
    if (change === 'day') day = { ...day, entries: [] }
    await f.session.refreshTaskReads('task-A', { task: before }, { saved: true, task: after }, context.signal)
    assert.match(await f.session.finalize('Oud antwoord', context.signal), /niet betrouwbaar/, change)
  }
})

test('Task rebase rejects an unverified receipt and never clears a prior changed-read latch', async () => {
  const f = fixture({ instruction: 'Werk mijn taak bij.' })
  const before = { id: 'task-A', title: 'Oud', updatedAt: 10 }
  const after = { ...before, title: 'Nieuw', updatedAt: 11 }
  await assert.rejects(
    f.session.refreshTaskReads('task-A', { task: before }, { saved: false, task: after }, context.signal),
    /rebase-invalid/
  )
  f.session.recordOtherRead('task:task-A', { task: { ...before, title: 'Nog ouder' } }, async () => ({ task: before }))
  f.session.recordOtherRead('task:task-A', { task: before }, async () => ({ task: after }))
  await f.session.refreshTaskReads('task-A', { task: before }, { saved: true, task: after }, context.signal)
  assert.match(await f.session.finalize('Antwoord', context.signal), /niet betrouwbaar/)
})

test('conversational preferences and ideas can be answered without a source read', async () => {
  for (const instruction of [
    'Ik wil hier gewoon met je kunnen praten. Denk met me mee over ideeën en laat af en toe uit jezelf weten wat je voor me zou kunnen doen. Maak er niet steeds een takenlijst van.',
    'Ik wil vandaag wat rustiger werken',
    'Hoe werkt Remember?',
    'Wat als we notities voor meetings zouden gebruiken?',
    'Could notes make meetings more useful?',
  ]) {
    const f = fixture({ instruction })
    const response = 'Daar kunnen we samen over nadenken.'
    assert.equal(await f.session.finalize(response, context.signal), response, instruction)
    assert.equal(f.calls.length, 0)
  }
})

test('casual wording does not weaken validation when a source was actually read', async () => {
  const f = fixture({ instruction: 'Ik wil vandaag wat rustiger werken' })
  let current = { text: 'Een bestaande notitie.' }
  f.session.recordOtherRead('note', current, async () => current)
  current = { text: 'Gewijzigd.' }
  assert.match(await f.session.finalize('Een bestaande notitie.', context.signal), /niet betrouwbaar/)
})

test('ordinary corrections have no source validation work or source progress', async () => {
  const f = fixture({ instruction: 'Mitchel is picking that up.' })
  assert.equal(f.session.requiresValidation(), false)
  assert.equal(f.session.hasSourceReads(), false)
  assert.equal(
    await f.session.finalize('Mitchel handles the store publication.', context.signal),
    'Mitchel handles the store publication.'
  )
  assert.equal(f.calls.length, 0)
})

test('a verified Space patch rebases its own reads without hiding concurrent changes', async () => {
  const f = fixture({ instruction: 'Werk de Space bij.' })
  const before = {
    spaceId: 'woub',
    slug: 'release',
    revision: 'r1',
    title: 'Release',
    content: 'Mitchel checks the build.',
    truncated: false,
  }
  const after = { ...before, revision: 'r2', content: 'Mitchel checks the publication.' }
  let current = structuredClone(before)
  const key = `memory:${JSON.stringify({ action: 'read', spaceId: 'woub', slug: 'release' })}`
  f.session.recordOtherRead(key, before, async () => current)
  current = after
  const change = {
    spaceId: 'woub',
    slug: 'release',
    expectedRevision: 'r1',
    revision: 'r2',
    before: 'build',
    after: 'publication',
  }
  await f.session.refreshMemoryReads(change, context.signal)
  assert.equal(await f.session.finalize('Saved.', context.signal), 'Saved.')
  current = { ...after, title: 'Concurrently edited title' }
  assert.match(await f.session.finalize('Saved.', context.signal), /niet betrouwbaar/)
})

test('Space patch read rebasing checks the receipt revision and unaffected search results', async () => {
  for (const mode of ['wrong-revision', 'other-page-changed'] as const) {
    const f = fixture({ instruction: 'Werk de Space bij.' })
    const before = {
      spaceId: 'woub',
      freshness: 'fresh',
      pages: [
        { slug: 'release', revision: 'r1', excerpt: 'Build' },
        { slug: 'other', revision: 'r1', excerpt: 'Other' },
      ],
    }
    const after = {
      ...before,
      pages: [
        { slug: 'release', revision: mode === 'wrong-revision' ? 'r3' : 'r2', excerpt: 'Publication' },
        { slug: 'other', revision: mode === 'other-page-changed' ? 'r3' : 'r1', excerpt: 'Other' },
      ],
    }
    const key = `memory:${JSON.stringify({ action: 'search', spaceId: 'woub', query: 'release' })}`
    f.session.recordOtherRead(key, before, async () => after)
    await f.session.refreshMemoryReads(
      {
        spaceId: 'woub',
        slug: 'release',
        expectedRevision: 'r1',
        revision: 'r2',
        before: 'Build',
        after: 'Publication',
      },
      context.signal
    )
    assert.match(await f.session.finalize('Saved.', context.signal), /niet betrouwbaar/)
  }
})

test('conversation synthesis requires complete, consistent pages and checks their revisions again', async () => {
  let changed = false
  const session = createResidentArchiveSession({
    instruction: 'Welke gesprekken had ik op 2026-09-29?',
    locale: 'nl',
    recovery: false,
    assertCurrent() {},
    run: async (args) => {
      const offset = Number(args[args.indexOf('--offset') + 1])
      return {
        schemaVersion: 1,
        availability: 'available',
        sourceKind: 'remember-conversations',
        selector: date,
        timezone: 'Europe/Amsterdam',
        count: 2,
        offset,
        nextOffset: offset === 0 ? 1 : null,
        items: [
          {
            id: `source-${offset}`,
            revision: changed ? 'r2' : 'r1',
            text: `Transcript ${offset}`,
            startedAt: 1,
            endedAt: 2,
          },
        ],
      }
    },
  })
  const tool = session.tools[0]
  await tool.call({ action: 'conversations', date }, context)
  assert.match(await session.finalize('Twee gesprekken.', context.signal), /niet betrouwbaar/)
  await tool.call({ action: 'conversations', date, offset: 1 }, context)
  assert.equal(await session.finalize('Twee gesprekken.', context.signal), 'Twee gesprekken.')
  changed = true
  assert.match(await session.finalize('Twee gesprekken.', context.signal), /niet betrouwbaar/)
})

test('malformed conversation records and pagination never become admitted source material', async () => {
  for (const patch of [
    { offset: 2 },
    { nextOffset: 0 },
    { items: [{ id: 'x' }] },
    { count: -1 },
    { selector: '2026-09-28' },
  ]) {
    const session = createResidentArchiveSession({
      instruction: 'Welke gesprekken had ik op 2026-09-29?',
      locale: 'nl',
      recovery: false,
      assertCurrent() {},
      run: async () => ({
        schemaVersion: 1,
        availability: 'available',
        sourceKind: 'remember-conversations',
        selector: date,
        timezone: 'Europe/Amsterdam',
        count: 0,
        offset: 0,
        nextOffset: null,
        items: [],
        ...patch,
      }),
    })
    await assert.rejects(session.tools[0].call({ action: 'conversations', date }, context), /invalid-page/)
    assert.match(await session.finalize('Er waren geen gesprekken.', context.signal), /niet betrouwbaar/)
  }
})
