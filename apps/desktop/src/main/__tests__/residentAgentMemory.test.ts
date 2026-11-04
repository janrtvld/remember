import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { AgentInteraction, AppLocale, WikiPage, WikiPageHistory, WikiSpace } from '@remember/shared'
import { callCodexClientTool } from '../codexClientTools'
import { readResidentMemory, readResidentSelfProfile } from '../residentAgentMemory'
import { createResidentMemoryTool } from '../residentAgentMemoryTool'
import { createResidentAgentService, type ResidentAgentDriver } from '../residentAgentService'
import { ResidentAgentStore } from '../residentAgentStore'
import { residentWikiPagePermitted } from '../residentWikiPrivacy'
import { DEFAULT_SETTINGS } from '../settingsStore'

const space = (id: string): WikiSpace => ({
  id,
  name: id === 'personal' ? 'Persoonlijk' : id,
  description: '',
  icon: 'book',
  color: 'slate',
  maintenanceMode: 'auto',
})
const page = (slug: string, revision = 'r1'): WikiPage => ({
  slug,
  title: slug,
  content: `Maintained ${slug} decisions.`,
  excerpt: `About ${slug}`,
  revision,
  sourceCount: 0,
  updatedAt: 1,
})
function storeFor(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(path.join(tmpdir(), 'remember-memory-test-'))
  const store = new ResidentAgentStore(path.join(directory, 'chat.sqlite'))
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return store
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

test('automatic retrieval is relevant, bounded, source-linked and only visits personal plus explicitly named Spaces', async () => {
  const visited: string[] = []
  const memory = await readResidentMemory('Woub release decisions', {
    spaces: () => [space('personal'), space('Woub'), space('Unrelated')],
    read: async (id) => {
      visited.push(id)
      return {
        state: 'fresh',
        checkedAt: 42,
        pages: Array.from({ length: 30 }, (_, i) => ({
          ...page(`release-${i}`),
          content: 'Release decisions\n\n'.repeat(1000),
        })),
      }
    },
    pagePermitted: () => true,
    assertAvailable: () => {},
  })
  assert.deepEqual(visited, ['personal', 'Woub'])
  assert.ok(memory.sources.length > 0 && memory.sources.length <= 6)
  assert.ok(JSON.stringify(memory.sources).length <= 10_000)
  assert.match(memory.sources[0]?.url ?? '', /^\/wiki\/page\/\?space=/)
  assert.equal(memory.sources[0]?.revision, 'r1')
  assert.equal(memory.sources[0]?.checkedAt, 42)
})

test('standing profile retrieval is fresh, private, bounded, and revalidates earlier revisions', async () => {
  const visited: string[] = []
  const me = { ...page('people/me'), content: 'Supported identity and roles.\n\n'.repeat(500) }
  let fresh = true
  let permitted = true
  const dependencies = {
    spaces: () => [space('personal'), space('team')],
    read: async (id: string) => {
      visited.push(id)
      return {
        state: fresh ? ('fresh' as const) : ('cached' as const),
        checkedAt: 42,
        pages: [me, page('people/work-profile'), page('projects/other')],
      }
    },
    pagePermitted: () => permitted,
    assertAvailable: () => {},
  }
  const profile = await readResidentSelfProfile(dependencies)
  assert.deepEqual(visited, ['personal'])
  assert.deepEqual(
    profile.sources.map(({ spaceId, slug }) => [spaceId, slug]),
    [['personal', 'people/me']]
  )
  assert.ok(profile.sources[0].content.length < 3100)
  assert.equal(profile.sources[0].revision, 'r1')
  assert.equal(profile.sources[0].freshness, 'fresh')
  permitted = false
  const excluded = await readResidentSelfProfile(dependencies, profile.sources)
  assert.deepEqual(excluded.sources, [])
  assert.equal(excluded.invalidated, true)
  permitted = true
  fresh = false
  assert.deepEqual((await readResidentSelfProfile(dependencies)).sources, [])
})

test('a self profile without a history revision is omitted without blocking ordinary chat', async (t) => {
  const store = storeFor(t)
  const calls: Parameters<ResidentAgentDriver['run']>[0][] = []
  const service = createResidentAgentService({
    store,
    context: async () => {
      const memory = await readResidentSelfProfile({
        spaces: () => [space('personal')],
        read: async () => ({ state: 'fresh', checkedAt: 1, pages: [{ ...page('people/me'), revision: undefined }] }),
        pagePermitted: () => true,
        assertAvailable: () => {},
      })
      assert.deepEqual(memory.sources, [])
      assert.equal(memory.invalidated, false)
      return { text: JSON.stringify({ profile: memory.sources }), memory }
    },
    assertAvailable: () => {},
    changed: () => {},
    driver: {
      cancel: () => {},
      run: async (input) => {
        calls.push(input)
        return { provider: 'codex', response: 'Hello', durationMs: 1, steps: [] }
      },
    },
  })
  service.send({ text: 'Hello', provider: 'codex' })
  await tick()
  assert.equal(calls.length, 1)
  assert.equal(service.snapshot().messages.at(-1)?.status, 'completed')
  assert.deepEqual(store.memorySources(), [])
})

test('a Space deleted during retrieval cannot supply stale results; source revision changes invalidate earlier context', async () => {
  let current = [space('personal'), space('Woub')]
  const memory = await readResidentMemory(
    'Woub release',
    {
      spaces: () => current,
      read: async (id) => {
        if (id === 'Woub') current = [space('personal')]
        return { state: 'fresh', checkedAt: 1, pages: [page('release')] }
      },
      pagePermitted: () => true,
      assertAvailable: () => {},
    },
    [{ spaceId: 'Woub', slug: 'release', revision: 'r1' }]
  )
  assert.equal(
    memory.sources.some((source) => source.spaceId === 'Woub'),
    false
  )
  assert.equal(memory.invalidated, true)
  const changed = await readResidentMemory(
    'other topic',
    {
      spaces: () => [space('personal')],
      read: async () => ({ state: 'fresh', checkedAt: 1, pages: [page('release', 'r2')] }),
      pagePermitted: () => true,
      assertAvailable: () => {},
    },
    [{ spaceId: 'personal', slug: 'release', revision: 'r1' }]
  )
  assert.equal(changed.invalidated, true)
})

test('different relevant pages preserve the chat decision/thread; changing a previously used page resets stale model context', async (t) => {
  const store = storeFor(t)
  let revision = 'r1'
  const calls: Parameters<ResidentAgentDriver['run']>[0][] = []
  const service = createResidentAgentService({
    store,
    context: async (query) => {
      const memory = await readResidentMemory(
        query,
        {
          spaces: () => [space('personal')],
          read: async () => ({ state: 'fresh', checkedAt: 1, pages: [page('alpha', revision), page('beta')] }),
          pagePermitted: () => true,
          assertAvailable: () => {},
        },
        store.memorySources()
      )
      return { text: JSON.stringify(memory), memory }
    },
    assertAvailable: () => {},
    changed: () => {},
    driver: {
      cancel: () => {},
      run: async (input) => {
        calls.push(input)
        input.onThread('stable-thread')
        return { provider: 'codex', response: 'Noted', durationMs: 1, steps: [] }
      },
    },
  })
  service.send({ text: 'alpha: choose blue', provider: 'codex' })
  await tick()
  service.send({ text: 'beta next', provider: 'codex' })
  await tick()
  assert.equal(calls[1]?.threadId, 'stable-thread')
  assert.match(calls[1]?.prompt ?? '', /choose blue/)
  revision = 'r2'
  service.send({ text: 'beta again', provider: 'codex' })
  await tick()
  assert.equal(calls[2]?.threadId, null)
  assert.doesNotMatch(calls[2]?.prompt ?? '', /choose blue/)
})

test('managed memory requires current permitted provenance while explicitly user-maintained knowledge remains readable', () => {
  const revision = {
    id: 'head',
    parentRevisionId: null,
    createdAt: 1,
    actor: 'remember' as const,
    operation: 'updated' as const,
    sourceId: null,
    summary: null,
    title: 'Release',
    content: 'Derived',
    contentHash: 'hash',
    evidence: [{ sourceId: 'context-1', observedAt: 1, quote: 'exact source' }],
  }
  const history: WikiPageHistory = {
    pageId: 'p',
    spaceId: 'personal',
    slug: 'release',
    headRevisionId: 'head',
    revisions: [revision],
  }
  assert.equal(
    residentWikiPagePermitted(
      history,
      () => ({ kind: 'context', text: 'exact source', appName: 'Private', bundleId: 'com.private' }),
      { ...DEFAULT_SETTINGS, excludedAppBundleIds: ['com.private'] }
    ),
    false
  )
  assert.equal(
    residentWikiPagePermitted(history, () => null, DEFAULT_SETTINGS),
    false
  )
  assert.equal(
    residentWikiPagePermitted(history, () => ({ kind: 'speech', text: 'exact source' }), DEFAULT_SETTINGS),
    true
  )
  assert.equal(
    residentWikiPagePermitted(
      { ...history, revisions: [{ ...revision, actor: 'user' }] },
      () => null,
      DEFAULT_SETTINGS
    ),
    true
  )
})

function toolFixture(t: { after: (fn: () => void) => void }, query = 'Lees de Woub Space, pagina release') {
  const store = storeFor(t)
  const message = store.start(query, 'codex')
  let pages = [page('release')]
  let pagePermitted = (_page: WikiPage) => false
  let writes = 0
  let proposals = 0
  let savedPagePatch: Partial<WikiPage> = {}
  let resultChanges = 0
  let maintenanceMode: WikiSpace['maintenanceMode'] = 'auto'
  let proposalResult: unknown = { id: 'proposal-1', slug: 'release', title: 'release' }
  const spaces = () => [space('personal'), { ...space('Woub'), maintenanceMode }]
  const abort = new AbortController()
  let allowed = true
  let approve = true
  let beforeApproval: (() => void) | null = null
  let locale: AppLocale = 'nl'
  const reviews: Pick<AgentInteraction, 'title' | 'detail' | 'fields' | 'actions' | 'url'>[] = []
  const tool = createResidentMemoryTool(query, {
    messageId: message.id,
    locale: () => locale,
    resultChanged: () => {
      resultChanges += 1
    },
    spaces,
    read: async () => ({ state: 'fresh', checkedAt: 1, pages }),
    pagePermitted: (_spaceId, current) => pagePermitted(current),
    store,
    assertAvailable: () => {
      if (!allowed) throw new Error('consent-revoked')
    },
    ask: async (request) => {
      reviews.push(request)
      beforeApproval?.()
      return { id: 'approval', action: approve ? 'accept' : 'decline', values: {} }
    },
    wiki: {
      getSpaces: spaces,
      listPages: async () => pages,
      createPage: async (input) => {
        if (input.parentSlug && !pages.some((page) => page.slug === input.parentSlug))
          throw new Error('wiki-parent-not-found')
        writes += 1
        const slug = `${input.parentSlug ?? input.category}/${input.title.toLowerCase().replaceAll(' ', '-')}`
        pages = [...pages, { ...page(slug), title: input.title, content: input.content ?? '', ...savedPagePatch }]
        return pages
      },
      deletePage: async () => [],
      proposePage: async () => {
        proposals += 1
        return proposalResult
      },
      savePage: async (input) => {
        writes += 1
        pages = [{ ...(pages[0] as WikiPage), content: input.content, revision: 'r2', ...savedPagePatch }]
        return pages
      },
    },
  })
  const call = (input: unknown, callId = 'call-1') =>
    tool.call(input, { threadId: 'thread', turnId: 'turn', callId, signal: abort.signal })
  return {
    call,
    tool,
    store,
    messageId: message.id,
    writes: () => writes,
    proposals: () => proposals,
    resultChanges: () => resultChanges,
    reviews: () => reviews,
    setLocale: (value: AppLocale) => {
      locale = value
    },
    setSavedPage: (patch: Partial<WikiPage>) => {
      savedPagePatch = patch
    },
    setMode: (mode: WikiSpace['maintenanceMode']) => {
      maintenanceMode = mode
    },
    setProposalResult: (value: unknown) => {
      proposalResult = value
    },
    cancel: () => abort.abort(),
    decline: () => {
      approve = false
    },
    revoke: () => {
      allowed = false
    },
    beforeApproval: (fn: () => void) => {
      beforeApproval = fn
    },
    edit: () => {
      pages = [page('release', 'changed')]
    },
    setPages: (value: WikiPage[]) => {
      pages = value
    },
    setPagePermitted: (value: (page: WikiPage) => boolean) => {
      pagePermitted = value
    },
  }
}

test('memory search finds a person and one linked project using only permitted page revisions', async (t) => {
  const fixture = toolFixture(t, 'Who is Tom?')
  fixture.setPages([
    { ...page('people/tom'), content: 'Collaborates on [App](projects/app).' },
    { ...page('projects/app'), content: 'Contact [Alice](people/alice).' },
    { ...page('people/alice'), content: 'Works in design.' },
    { ...page('people/secret'), content: 'Tom mentioned confidential material.' },
  ])
  fixture.setPagePermitted((page) => page.slug !== 'people/secret')
  const result = (await fixture.call({ action: 'search', spaceId: 'Woub', query: 'Tom' })) as { pages: WikiPage[] }
  assert.deepEqual(
    result.pages.map(({ slug }) => slug),
    ['people/tom', 'projects/app']
  )
  assert.deepEqual(
    fixture.store.memorySources().map(({ slug }) => slug),
    ['people/tom', 'projects/app']
  )
  await assert.rejects(
    fixture.call({ action: 'read', spaceId: 'Woub', slug: 'people/secret' }),
    /unavailable-or-excluded/
  )
})

test('memory read preserves its object content and revision in the Codex JSON-text response', async (t) => {
  const fixture = toolFixture(t)
  const input = { action: 'read', spaceId: 'Woub', slug: 'release' }
  const direct = (await fixture.call(input)) as Record<string, unknown>
  const response = await callCodexClientTool(fixture.tool, input, {
    threadId: 'thread',
    turnId: 'turn',
    callId: 'serialized-read',
    signal: new AbortController().signal,
  })

  assert.equal(typeof direct, 'object')
  assert.equal(direct.revision, 'r1')
  assert.equal(direct.content, 'Maintained release decisions.')
  assert.equal(response.success, true)
  assert.equal(response.contentItems.length, 1)
  const item = response.contentItems[0]
  assert.ok(item)
  assert.equal(item.type, 'inputText')
  assert.equal(typeof item.text, 'string')
  assert.deepEqual(JSON.parse(item.text), direct)
})

test('explicit scoped read can read a maintained page excluded from automatic recall, with a source revision and no unrelated Space', async (t) => {
  const fixture = toolFixture(t)
  const result = (await fixture.call({ action: 'read', spaceId: 'Woub', slug: 'release' })) as Record<string, unknown>
  assert.equal(result.revision, 'r1')
  assert.equal(result.content, 'Maintained release decisions.')
  assert.equal(fixture.store.memorySources()[0]?.explicit, true)
  await assert.rejects(
    fixture.call({ action: 'read', spaceId: 'Unrelated', slug: 'release' }),
    /outside-current-request/
  )
  const implicit = toolFixture(t, 'Woub release')
  await assert.rejects(implicit.call({ action: 'read', spaceId: 'Woub', slug: 'release' }), /unavailable-or-excluded/)
  const ordinarySearch = toolFixture(t, 'Search for Woub release issues')
  await assert.rejects(
    ordinarySearch.call({ action: 'read', spaceId: 'Woub', slug: 'release' }),
    /unavailable-or-excluded/
  )
})

const patch = {
  action: 'patch',
  spaceId: 'Woub',
  slug: 'release',
  expectedRevision: 'r1',
  before: 'Maintained',
  after: 'Updated',
  summary: 'Update release decision',
}

const createTrip = {
  action: 'create',
  spaceId: 'Woub',
  category: 'projects',
  title: 'China trip',
  content: 'Plan a two-week trip. Dates and budget are still open.',
}

test('reviewed creation saves a populated project and nested document with persistent chat links', async (t) => {
  const fixture = toolFixture(t, 'Maak een project voor mijn reis naar China')
  fixture.setPagePermitted(() => true)
  const project = await fixture.call(createTrip)
  assert.deepEqual(project, {
    kind: 'saved-page',
    saved: true,
    proposed: false,
    spaceId: 'Woub',
    slug: 'projects/china-trip',
    revision: 'r1',
    title: 'China trip',
  })
  assert.deepEqual(await fixture.call(createTrip), project)
  assert.equal(fixture.writes(), 1, 'A repeated call must reuse its saved receipt')
  const child = await fixture.call(
    {
      ...createTrip,
      parentSlug: 'projects/china-trip',
      title: 'Itinerary',
      content: '## Beijing\n\nStart with four nights; keep the dates flexible.',
    },
    'child'
  )
  assert.equal((child as { slug: string }).slug, 'projects/china-trip/itinerary')
  assert.equal(
    fixture.reviews()[1]?.detail,
    'Woub\nItinerary\n\nMap: projects/china-trip\n\n## Beijing\n\nStart with four nights; keep the dates flexible.\n\nDit wordt opgeslagen in deze Space.'
  )
  const read = (await fixture.call({ action: 'read', spaceId: 'Woub', slug: 'projects/china-trip/itinerary' })) as {
    content: string
    url: string
  }
  assert.equal(read.content, '## Beijing\n\nStart with four nights; keep the dates flexible.')
  assert.equal(read.url, '/wiki/page/?space=Woub&slug=projects%2Fchina-trip%2Fitinerary')
  assert.deepEqual(
    fixture.store.get(fixture.messageId)?.results?.map(({ slug }) => slug),
    ['projects/china-trip', 'projects/china-trip/itinerary']
  )
  assert.equal(fixture.resultChanges(), 2)
})

test('creation preserves Suggest policy and cannot turn an existing slug into a replacement', async (t) => {
  const fixture = toolFixture(t)
  fixture.setMode('suggest')
  fixture.setProposalResult({ id: 'trip-proposal', slug: 'projects/china-trip', title: 'China trip' })
  assert.deepEqual(await fixture.call(createTrip), {
    saved: false,
    proposed: true,
    spaceId: 'Woub',
    slug: 'projects/china-trip',
    title: 'China trip',
    proposalId: 'trip-proposal',
  })
  assert.equal(fixture.proposals(), 1)
  assert.equal(fixture.writes(), 0)
  assert.deepEqual(fixture.store.get(fixture.messageId)?.results, [])
  const replacement = toolFixture(t)
  await assert.rejects(replacement.call({ ...createTrip, slug: 'release' }), /invalid-memory-create-target/)
  assert.deepEqual(replacement.reviews(), [])
  assert.equal(replacement.writes(), 0)
})

test('declined creation and a Space policy change during review cannot create a document', async (t) => {
  const declined = toolFixture(t)
  declined.decline()
  assert.deepEqual(await declined.call(createTrip), { saved: false, reason: 'user-declined' })
  assert.equal(declined.writes(), 0)
  const changed = toolFixture(t)
  changed.beforeApproval(() => changed.setMode('suggest'))
  await assert.rejects(changed.call(createTrip), /policy-changed-review-again/)
  assert.equal(changed.writes(), 0)
  assert.equal(changed.proposals(), 0)
})

test('memory review uses the current interface language while preserving exact source and replacement text', async (t) => {
  for (const locale of ['nl', 'en'] as const) {
    for (const mode of ['auto', 'suggest'] as const) {
      for (const action of ['patch', 'ensure'] as const) {
        if (action === 'ensure' && mode === 'suggest') continue
        const fixture = toolFixture(t)
        fixture.setLocale(locale)
        fixture.setMode(mode)
        fixture.decline()
        const english = locale === 'en'
        const before = 'Original text\nVersie: literal page content'
        const content = 'Untranslated page text\nDoor: literal content'
        await fixture.call(
          action === 'patch'
            ? { ...patch, before, after: '' }
            : {
                action,
                spaceId: 'Woub',
                source: 'https://example.test/evidence',
                title: 'Original page title',
                content,
              }
        )
        const detail =
          action === 'patch'
            ? english
              ? `Woub\nrelease\n\nRevision: r1\n\nReplace:\n${before}\n\nWith:\n`
              : `Woub\nrelease\n\nVersie: r1\n\nVervang:\n${before}\n\nDoor:\n`
            : english
              ? `Woub\nOriginal page title\n\nSource: https://example.test/evidence\n\n${content}`
              : `Woub\nOriginal page title\n\nBron: https://example.test/evidence\n\n${content}`
        const outcome =
          mode === 'auto'
            ? english
              ? 'This will be saved in this Space.'
              : 'Dit wordt opgeslagen in deze Space.'
            : english
              ? 'This will be proposed in this Space.'
              : 'Dit wordt een voorstel in deze Space.'
        assert.deepEqual(fixture.reviews(), [
          {
            title: english ? 'Save knowledge in Remember' : 'Kennis bewaren in Remember',
            detail: `${detail}\n\n${outcome}`,
            fields: [],
            actions: [
              { id: 'accept', label: english ? 'Save' : 'Bewaren' },
              { id: 'decline', label: english ? 'Cancel' : 'Annuleren' },
            ],
          },
        ])
        assert.equal(fixture.writes(), 0)
        assert.equal(fixture.proposals(), 0)
        assert.deepEqual(fixture.store.get(fixture.messageId)?.results, [])
      }
    }
  }
})

test('ensure cannot show a save review when the Space requires suggestions', async (t) => {
  const fixture = toolFixture(t)
  fixture.setMode('suggest')
  await assert.rejects(
    fixture.call({
      action: 'ensure',
      spaceId: 'Woub',
      source: 'https://example.test/evidence',
      title: 'Source page',
      content: 'Requested source content',
    }),
    /source-creation-requires-auto-mode/
  )
  assert.deepEqual(fixture.reviews(), [])
  assert.equal(fixture.writes(), 0)
  assert.equal(fixture.proposals(), 0)
})

test('a patch requires an explicit string replacement before review; an empty string removes only reviewed text', async (t) => {
  for (const after of [undefined, null, 42, false, {}, ['replacement']]) {
    const fixture = toolFixture(t)
    await assert.rejects(fixture.call({ ...patch, after }), /invalid-memory-patch-after/)
    assert.deepEqual(fixture.reviews(), [])
    assert.equal(fixture.writes(), 0)
    assert.equal(fixture.proposals(), 0)
  }
  const removal = toolFixture(t)
  const result = await removal.call({ ...patch, after: '' })
  assert.equal((result as { saved: boolean }).saved, true)
  assert.equal(removal.writes(), 1)
  assert.equal(
    removal.reviews()[0].detail,
    'Woub\nrelease\n\nVersie: r1\n\nVervang:\nMaintained\n\nDoor:\n\n\nDit wordt opgeslagen in deze Space.'
  )
  const read = (await removal.call({ action: 'read', spaceId: 'Woub', slug: 'release' })) as WikiPage
  assert.equal(read.content, ' release decisions.')
})

test('review identifies the canonical source and parsed target that the Wiki handler will actually use', async (t) => {
  const existing = toolFixture(t)
  existing.decline()
  await existing.call({ ...patch, slug: '  release  ', expectedRevision: '  r1  ' })
  assert.equal(
    existing.reviews()[0].detail,
    'Woub\nrelease\n\nVersie: r1\n\nVervang:\nMaintained\n\nDoor:\nUpdated\n\nDit wordt opgeslagen in deze Space.'
  )
  const source = toolFixture(t)
  source.decline()
  await source.call({
    action: 'ensure',
    spaceId: 'Woub',
    source: 'https://EXAMPLE.test/evidence?tracking=yes#anchor',
    title: '  Source page  ',
    slug: 'ignored-by-ensure',
    content: 'Exact initial content',
  })
  assert.equal(
    source.reviews()[0].detail,
    'Woub\nSource page\n\nBron: https://example.test/evidence\n\nExact initial content\n\nDit wordt opgeslagen in deze Space.'
  )
  assert.equal(existing.writes() + source.writes(), 0)
})

test('a Suggest patch needs a genuine proposal receipt before reporting proposed', async (t) => {
  for (const response of [null, {}, { id: '' }, { id: ' ' }, page('release')]) {
    const fixture = toolFixture(t)
    fixture.setMode('suggest')
    fixture.setProposalResult(response)
    const result = await fixture.call(patch)
    assert.deepEqual(result, { saved: false, error: 'memory-write-outcome-unverified' })
    assert.equal(fixture.proposals(), 1)
    assert.equal(fixture.writes(), 0)
    assert.deepEqual(fixture.store.get(fixture.messageId)?.results, [])
    assert.deepEqual(await fixture.call(patch), result)
    assert.equal(fixture.proposals(), 1, 'An uncertain response must not replay the operation')
  }
})

test('approved revision-aware writes execute once; declined, stale and revoked requests never write', async (t) => {
  const fixture = toolFixture(t)
  fixture.store.recordMemorySources([{ spaceId: 'Woub', slug: 'release', revision: 'r1', explicit: true }])
  const first = await fixture.call(patch)
  const duplicate = await fixture.call(patch)
  assert.deepEqual(first, duplicate)
  assert.equal(fixture.writes(), 1)
  assert.equal(fixture.resultChanges(), 1)
  assert.deepEqual(fixture.store.memorySources(), [
    { spaceId: 'Woub', slug: 'release', revision: 'r2', explicit: true },
  ])
  assert.equal((first as { saved: boolean }).saved, true)
  assert.deepEqual(fixture.store.get(fixture.messageId)?.results, [
    {
      id: '["thread","call-1"]',
      kind: 'saved-page',
      spaceId: 'Woub',
      slug: 'release',
      revision: 'r2',
      title: 'release',
    },
  ])
  assert.equal(fixture.store.get(fixture.messageId)?.text, '')
  assert.deepEqual(fixture.store.conversation(null).messages[0]?.results, [])
  const denied = toolFixture(t)
  denied.store.recordMemorySources([{ spaceId: 'Woub', slug: 'release', revision: 'r1' }])
  denied.decline()
  assert.equal(((await denied.call(patch)) as { saved: boolean }).saved, false)
  assert.equal(denied.writes(), 0)
  assert.equal(denied.store.memorySources()[0]?.revision, 'r1')
  assert.deepEqual(denied.store.get(denied.messageId)?.results, [])
  const stale = toolFixture(t)
  stale.store.recordMemorySources([{ spaceId: 'Woub', slug: 'release', revision: 'r1' }])
  stale.beforeApproval(stale.edit)
  assert.equal(((await stale.call(patch)) as { error: string }).error, 'wiki-page-conflict')
  assert.equal(stale.writes(), 0)
  assert.equal(stale.store.memorySources()[0]?.revision, 'r1')
  assert.deepEqual(stale.store.get(stale.messageId)?.results, [])
  const revoked = toolFixture(t)
  revoked.beforeApproval(revoked.revoke)
  await assert.rejects(revoked.call(patch), /consent-revoked/)
  assert.equal(revoked.writes(), 0)
  assert.deepEqual(revoked.store.get(revoked.messageId)?.results, [])
  const cancelled = toolFixture(t)
  cancelled.beforeApproval(cancelled.cancel)
  await assert.rejects(cancelled.call(patch), /agent-cancelled/)
  assert.equal(cancelled.writes(), 0)
  assert.deepEqual(cancelled.store.get(cancelled.messageId)?.results, [])
})

test('an incomplete successful Wiki response cannot claim a saved result or retry the write', async (t) => {
  for (const invalid of [{ revision: undefined }, { revision: '' }, { content: undefined }]) {
    const fixture = toolFixture(t)
    fixture.setSavedPage(invalid)
    const result = await fixture.call(patch)
    assert.deepEqual(result, { saved: false, error: 'memory-write-outcome-unverified' })
    assert.deepEqual(await fixture.call(patch), result)
    assert.equal(fixture.writes(), 1)
    assert.equal(fixture.resultChanges(), 0)
    assert.deepEqual(fixture.store.get(fixture.messageId)?.results, [])
  }
  const fallback = toolFixture(t)
  fallback.setSavedPage({ title: '' })
  await fallback.call(patch)
  assert.equal(fallback.store.get(fallback.messageId)?.results?.[0]?.title, 'release')
})

test('Suggest preserves review policy; changing that policy during approval cannot be misreported as a save', async (t) => {
  const fixture = toolFixture(t)
  fixture.store.recordMemorySources([{ spaceId: 'Woub', slug: 'release', revision: 'r1' }])
  fixture.setMode('suggest')
  const result = await fixture.call(patch)
  assert.deepEqual(result, {
    saved: false,
    proposed: true,
    spaceId: 'Woub',
    slug: 'release',
    title: 'release',
    proposalId: 'proposal-1',
  })
  assert.equal(fixture.writes(), 0)
  assert.equal(fixture.proposals(), 1)
  assert.equal(fixture.store.memorySources()[0]?.revision, 'r1')
  assert.deepEqual(fixture.store.get(fixture.messageId)?.results, [])
  const changed = toolFixture(t)
  changed.beforeApproval(() => changed.setMode('suggest'))
  await assert.rejects(changed.call(patch), /policy-changed-review-again/)
  assert.equal(changed.writes(), 0)
  assert.equal(changed.proposals(), 0)
  const interrupted = toolFixture(t)
  interrupted.beforeApproval(() => {
    throw new Error('connection-lost')
  })
  await assert.rejects(interrupted.call(patch), /connection-lost/)
  await assert.rejects(interrupted.call(patch), /outcome-unknown-read-before-retrying/)
  assert.equal(interrupted.writes(), 0)
  assert.deepEqual(interrupted.store.get(interrupted.messageId)?.results, [])
})

test('search snippets register source revisions, and pending writes survive restart without execution', async (t) => {
  const fixture = toolFixture(t)
  await fixture.call({ action: 'search', spaceId: 'Woub', query: 'release' })
  assert.deepEqual(fixture.store.memorySources(), [
    { spaceId: 'Woub', slug: 'release', revision: 'r1', explicit: true },
  ])
  const directory = mkdtempSync(path.join(tmpdir(), 'remember-tool-replay-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'chat.sqlite')
  const first = new ResidentAgentStore(file)
  first.claimToolCall('pending-call', 'hash')
  first.close()
  const restarted = new ResidentAgentStore(file)
  t.after(() => restarted.close())
  assert.deepEqual(restarted.claimToolCall('pending-call', 'hash'), { existing: true, result: null })
  assert.throws(() => restarted.claimToolCall('pending-call', 'different-hash'), /mismatch/)
})

test('cancellation while memory refresh is pending never starts the worker', async (t) => {
  const store = storeFor(t)
  let release!: (value: string) => void
  let calls = 0
  const service = createResidentAgentService({
    store,
    assertAvailable: () => {},
    changed: () => {},
    context: () =>
      new Promise<string>((resolve) => {
        release = resolve
      }),
    driver: {
      cancel: () => {},
      run: async () => {
        calls += 1
        return { provider: 'codex', response: 'Unexpected', durationMs: 1, steps: [] }
      },
    },
  })
  service.send({ text: 'Read my memory', provider: 'codex' })
  const stopped = service.cancel()
  release('Old memory')
  await stopped
  assert.equal(calls, 0)
  assert.equal(service.snapshot().messages.at(-1)?.status, 'cancelled')
})

test('the agent can discover accessible Spaces and continue an edit without repeating the Space name', async (t) => {
  const fixture = toolFixture(t, 'Pas dat maar aan.')
  const listed = (await fixture.call({ action: 'spaces' })) as { spaces: { id: string }[] }
  assert(listed.spaces.some((space) => space.id === 'Woub'))
  const result = (await fixture.call(patch)) as { saved: boolean }
  assert.equal(result.saved, true)
  assert.equal(fixture.reviews().length, 1)
})
