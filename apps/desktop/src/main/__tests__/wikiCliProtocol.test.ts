import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { WikiPage, WikiSpace } from '@remember/shared'
import { createWikiCliRequestHandler, type WikiCliDependencies } from '../wikiCliProtocol'

it('returns no automatic context to legacy hooks without reading Wiki data', async () => {
  const unexpected = async () => {
    assert.fail('A retired hook must not read or write Wiki data')
  }
  const handle = createWikiCliRequestHandler({
    getSpaces: unexpected,
    listPages: unexpected,
    createPage: unexpected,
    savePage: unexpected,
    deletePage: unexpected,
    proposePage: unexpected,
  })
  for (const provider of ['codex', 'claude']) {
    for (const event of ['SessionStart', 'UserPromptSubmit']) {
      assert.deepEqual(
        await handle({
          id: 'old-hook',
          action: 'agent.context',
          provider,
          event,
          sessionId: 'existing',
          cwd: '/work/app',
        }),
        {
          id: 'old-hook',
          ok: true,
          result: { packetId: '', context: '', pages: [], removed: [], freshness: [], changed: false },
        }
      )
    }
  }
  assert.deepEqual(await handle({ id: 'old-ack', action: 'agent.context.ack', packetId: 'existing-packet' }), {
    id: 'old-ack',
    ok: true,
    result: { acknowledged: false },
  })
})

function space(id: string, maintenanceMode: WikiSpace['maintenanceMode'] = 'auto'): WikiSpace {
  return {
    id,
    name: id === 'personal' ? 'Personal' : id,
    description: '',
    icon: 'folder',
    color: 'slate',
    maintenanceMode,
  }
}

function page(slug: string, title: string, content: string): WikiPage {
  return { slug, title, content, excerpt: content, updatedAt: 1, sourceCount: 0, revision: 'revision-1' }
}

function fixture() {
  const proposals: Array<Extract<Parameters<WikiCliDependencies['proposePage']>[0], { action: 'wiki.write' }>> = []
  const pages = new Map<string, WikiPage[]>([
    ['personal', [page('projects/remember', 'Remember', 'Old state')]],
    ['private-notes', []],
    ['team', []],
  ])
  const dependencies: WikiCliDependencies = {
    getSpaces: () => [space('personal'), space('private-notes'), space('team', 'suggest')],
    listPages: async (spaceId) => pages.get(spaceId) ?? [],
    createPage: async (input) => {
      const next = [
        ...(pages.get(input.spaceId) ?? []),
        page(
          `${input.parentSlug ?? input.category}/${input.title.toLowerCase().replaceAll(' ', '-')}`,
          input.title,
          input.content ?? ''
        ),
      ]
      pages.set(input.spaceId, next)
      return next
    },
    savePage: async (input) => {
      const next = (pages.get(input.spaceId) ?? []).map((candidate) =>
        candidate.slug === input.slug ? page(input.slug, input.title, input.content) : candidate
      )
      pages.set(input.spaceId, next)
      return next
    },
    deletePage: async (spaceId, slug) => {
      const next = (pages.get(spaceId) ?? []).filter((candidate) => candidate.slug !== slug)
      pages.set(spaceId, next)
      return next
    },
    proposePage: async (request) => {
      proposals.push(request)
      return { status: 'pending', content: request.content }
    },
  }
  return { pages, proposals, dependencies, handle: createWikiCliRequestHandler(dependencies) }
}

describe('Wiki CLI protocol', () => {
  it('serves the brief only where the host provides it', async () => {
    const { dependencies, handle } = fixture()

    const scoped = await handle({ id: '1', action: 'brief.read' })
    const local = await createWikiCliRequestHandler({
      ...dependencies,
      readBrief: async () => ({ profile: null, activity: null }),
    })({ id: '2', action: 'brief.read' })

    assert.equal(scoped.ok, false)
    assert.deepEqual(local, { id: '2', ok: true, result: { profile: null, activity: null } })
  })

  it('lists spaces without exposing Wiki page contents', async () => {
    const { handle } = fixture()

    const response = await handle({ id: '1', action: 'wiki.spaces' })

    assert.equal(response.ok, true)
    if (!response.ok) return
    assert.deepEqual(
      (response.result as WikiSpace[]).map(({ id }) => id),
      ['personal', 'private-notes', 'team']
    )
  })

  it('updates only an existing page when a slug is provided', async () => {
    const { handle, pages } = fixture()

    const response = await handle({
      id: '2',
      action: 'wiki.write',
      spaceId: 'personal',
      slug: 'projects/remember',
      title: 'Remember',
      content: 'Current state',
      expectedRevision: 'revision-1',
    })

    assert.equal(response.ok, true)
    assert.equal(pages.get('personal')?.[0]?.content, 'Current state')

    const missing = await handle({
      id: '3',
      action: 'wiki.write',
      spaceId: 'personal',
      slug: 'projects/missing',
      title: 'Missing',
      content: 'Do not create this',
    })
    assert.deepEqual(missing, { id: '3', ok: false, error: 'wiki-page-not-found' })
    assert.equal(pages.get('personal')?.length, 1)
  })

  it('queues the exact payload instead of writing into a Suggest-mode Wiki', async () => {
    const { handle, pages, proposals } = fixture()

    const response = await handle({
      id: '4',
      action: 'wiki.write',
      spaceId: 'team',
      category: 'decisions',
      title: 'Release approval',
      content: 'A human approves production releases.',
    })

    assert.equal(response.ok, true)
    assert.deepEqual(pages.get('team'), [])
    assert.equal(proposals[0]?.content, 'A human approves production releases.')
    assert.equal(proposals[0]?.spaceId, 'team')
  })

  it('writes directly into an Auto-mode Wiki', async () => {
    const { handle, pages, proposals } = fixture()
    const response = await handle({
      id: '4b',
      action: 'wiki.write',
      spaceId: 'private-notes',
      category: 'decisions',
      title: 'Release approval',
      content: 'A human approves production releases.',
    })

    assert.equal(response.ok, true)
    assert.equal(pages.get('private-notes')?.[0]?.content, 'A human approves production releases.')
    assert.equal(proposals.length, 0)
  })

  it('creates a project and child with their initial content in one mutation each', async () => {
    const { handle, pages, dependencies } = fixture()
    dependencies.savePage = async () => assert.fail('New documents must never be created empty and saved later')
    dependencies.deletePage = async () => assert.fail('Creation must never roll back by deleting another edit')
    const project = await handle({
      id: 'trip',
      action: 'wiki.write',
      spaceId: 'personal',
      category: 'projects',
      title: 'China trip',
      content: 'Plan a two-week trip to China. Dates are still open.',
    })
    assert.equal(project.ok && (project.result as WikiPage).slug, 'projects/china-trip')
    const document = await handle({
      id: 'itinerary',
      action: 'wiki.write',
      spaceId: 'personal',
      category: 'projects',
      parentSlug: 'projects/china-trip',
      title: 'Itinerary',
      content: '## Beijing\n\nLeave room for the Forbidden City and a Great Wall day trip.',
    })
    assert.equal(document.ok && (document.result as WikiPage).slug, 'projects/china-trip/itinerary')
    assert.deepEqual(
      pages
        .get('personal')
        ?.slice(1)
        .map(({ slug, content }) => ({ slug, content })),
      [
        { slug: 'projects/china-trip', content: 'Plan a two-week trip to China. Dates are still open.' },
        {
          slug: 'projects/china-trip/itinerary',
          content: '## Beijing\n\nLeave room for the Forbidden City and a Great Wall day trip.',
        },
      ]
    )
  })

  it('never attributes another concurrent creation to the requested document or deletes either page', async () => {
    const { handle, dependencies } = fixture()
    const create = dependencies.createPage
    dependencies.createPage = async (input) => {
      await create({ spaceId: input.spaceId, category: 'projects', title: 'Other project', content: 'Other work' })
      return create(input)
    }
    dependencies.deletePage = async () => assert.fail('An ambiguous creation must preserve both documents')
    assert.deepEqual(
      await handle({
        id: 'concurrent',
        action: 'wiki.write',
        spaceId: 'personal',
        title: 'Trip',
        content: 'My itinerary',
      }),
      { id: 'concurrent', ok: false, error: 'wiki-page-creation-unverified' }
    )
  })

  it('recognizes the first document even when creation also generates the Wiki index', async () => {
    const { handle, dependencies } = fixture()
    const create = dependencies.createPage
    dependencies.createPage = async (input) => [...(await create(input)), page('index', 'Index', 'Generated index')]
    const result = await handle({
      id: 'first',
      action: 'wiki.write',
      spaceId: 'private-notes',
      category: 'projects',
      title: 'China trip',
      content: 'Plan the first trip.',
    })
    assert.equal(result.ok && (result.result as WikiPage).slug, 'projects/china-trip')
    assert.equal(result.ok && (result.result as WikiPage).content, 'Plan the first trip.')
  })

  it('searches only inside the selected space', async () => {
    const { handle } = fixture()

    const personal = await handle({ id: '5', action: 'wiki.search', spaceId: 'personal', query: 'old' })
    const team = await handle({ id: '6', action: 'wiki.search', spaceId: 'team', query: 'old' })

    assert.equal(personal.ok && (personal.result as unknown[]).length, 1)
    assert.equal(team.ok && (team.result as unknown[]).length, 0)
  })
})
