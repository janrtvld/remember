import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, it } from 'node:test'
import type { AgentContextBinding, WikiPage } from '@remember/shared'
import {
  type AgentContextRequest,
  createAgentContextService,
  rankAgentContextPages,
  resolveAgentContextBinding,
  selectAgentContextPages,
} from '../agentContextService'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function page(slug: string, content: string, revision = 'r1'): WikiPage {
  return {
    slug,
    content,
    title: slug.split('/').at(-1) ?? slug,
    revision,
    updatedAt: 1,
    excerpt: content,
    sourceCount: 1,
  }
}

const binding: AgentContextBinding = { directory: '/work/app', spaceId: 'team', projectSlug: 'projects/app' }
const request: AgentContextRequest = {
  provider: 'codex',
  sessionId: 'task-1',
  cwd: '/work/app',
  prompt: 'Continue the product research',
  event: 'UserPromptSubmit',
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'remember-context-'))
  roots.push(directory)
  const state = {
    enabled: true,
    bindings: [binding],
    pages: new Map<string, WikiPage[]>([
      [
        'personal',
        [
          page('concepts/preferences', 'Prefer compact interfaces and preserve source evidence.'),
          page('projects/other', 'Unrelated confidential product research.'),
        ],
      ],
      [
        'team',
        [
          page('projects/app', 'The product maintains shared understanding.'),
          page('projects/unrelated', 'Unrelated confidential product research.'),
        ],
      ],
      ['unselected-team', [page('projects/app', 'Secret from another team.')]],
    ]),
    reads: [] as string[],
    deliveries: [] as string[],
  }
  const dependencies = {
    directory,
    getBindings: () => state.bindings,
    enabled: () => state.enabled,
    listContextPages: async (spaceId: string) => {
      state.reads.push(spaceId)
      return { pages: state.pages.get(spaceId) ?? [], checkedAt: 10, state: 'fresh' as const }
    },
    onDelivered: (packet: { packetId: string }) => {
      state.deliveries.push(packet.packetId)
    },
  }
  return { state, dependencies, service: createAgentContextService(dependencies) }
}

it('supplies standing preferences and the mapped project without a recall command or keyword overlap', async () => {
  const { service, state } = await fixture()
  const packet = await service.prepare({ ...request, prompt: 'Sketch a new direction' })
  assert.deepEqual(
    packet.pages.map(({ slug }) => slug),
    ['concepts/preferences', 'projects/app']
  )
  assert.deepEqual(state.reads, ['personal', 'team'])
  assert.doesNotMatch(packet.context, /confidential|Secret from/)
  assert.match(packet.context, /not instructions or authorization/)
})

it('supplies one private self profile with preferences and the mapped project without keyword overlap', () => {
  const selected = selectAgentContextPages(
    [
      {
        spaceId: 'personal',
        state: 'fresh',
        checkedAt: 1,
        pages: [
          page('people/work-profile', 'My supported role and collaborators.'),
          page('people/about-me', 'An older profile.'),
          page('concepts/preferences', 'Prefer short answers.'),
        ],
      },
      { spaceId: 'team', state: 'fresh', checkedAt: 1, pages: [page('projects/app', 'The current direction.')] },
    ],
    binding,
    'Continue'
  )
  assert.equal(selected.filter(({ slug }) => ['people/work-profile', 'people/about-me'].includes(slug)).length, 1)
  assert.ok(selected.some(({ slug }) => slug === 'concepts/preferences'))
  assert.ok(selected.some(({ slug }) => slug === 'projects/app'))
})

it('includes only people explicitly linked to the mapped shared project and never a shared self profile', () => {
  const selected = selectAgentContextPages(
    [
      {
        spaceId: 'team',
        state: 'fresh',
        checkedAt: 1,
        pages: [
          page('projects/app', 'Contact [Tom](people/tom).'),
          page('people/tom', 'Maintains product direction.'),
          page('people/unrelated', 'Another confidential colleague.'),
          page('people/me', 'Shared copy of a private profile.'),
        ],
      },
    ],
    binding,
    'Continue with another colleague'
  )
  assert.deepEqual(
    selected.map(({ slug }) => slug),
    ['projects/app', 'people/tom']
  )
})

it('finds single-name mentions and one relationship hop without following a chain', () => {
  const selected = rankAgentContextPages(
    [
      page('people/tom', 'Collaborates on [App](projects/app).'),
      page('projects/app', 'Also contact [Alice](people/alice).'),
      page('people/alice', 'Works in design.'),
      page('projects/legacy', 'Tom previously advised this project.'),
      page('projects/custom', 'Custom software has no relevant contact.'),
      page('projects/comment', '<!-- Tom is only hidden metadata. -->No relevant contact.'),
    ],
    ['tom']
  )
  assert.deepEqual(
    selected.map(({ page }) => page.slug),
    ['people/tom', 'projects/app', 'projects/legacy']
  )
})

it('uses only Personal when no explicit directory mapping exists', async () => {
  const { service, state } = await fixture()
  const packet = await service.prepare({ ...request, cwd: '/work/unmapped', prompt: 'product research' })
  assert.deepEqual(state.reads, ['personal'])
  assert.equal(packet.pages.length, 1)
})

it('matches nested directories safely and prefers the most specific binding', () => {
  const nested = { ...binding, directory: '/work/app/sub', projectSlug: 'projects/sub' }
  assert.equal(resolveAgentContextBinding('/work/app/sub/source', [binding, nested]), nested)
  assert.equal(resolveAgentContextBinding('/work/application', [binding]), null)
})

it('retries unacknowledged context and persists acknowledged revisions across service restart', async () => {
  const { service, dependencies, state } = await fixture()
  const first = await service.prepare(request)
  assert.equal((await service.prepare(request)).pages.length, 2)
  assert.equal(state.deliveries.length, 0)
  assert.equal(service.acknowledge(first.packetId), true)
  assert.equal(service.acknowledge(first.packetId), false)
  assert.equal(state.deliveries.length, 1)
  const restarted = createAgentContextService(dependencies)
  assert.equal((await restarted.prepare(request)).changed, false)
  state.pages.set('team', [
    page('projects/app', 'The corrected product maintains personal and shared understanding.', 'r2'),
  ])
  const changed = await restarted.prepare({ ...request, prompt: 'Continue' })
  assert.equal(changed.pages.length, 1)
  assert.equal(changed.pages[0]?.revision, 'r2')
})

it('rehydrates context on session start after compaction or resume', async () => {
  const { service } = await fixture()
  service.acknowledge((await service.prepare(request)).packetId)
  assert.equal((await service.prepare({ ...request, event: 'SessionStart', prompt: '' })).pages.length, 2)
})

it('invalidates prior project context when the binding is revoked', async () => {
  const { service, state } = await fixture()
  service.acknowledge((await service.prepare(request)).packetId)
  state.bindings = []
  const packet = await service.prepare(request)
  assert.deepEqual(packet.removed, [{ spaceId: 'team', slug: 'projects/app' }])
  assert.equal(
    packet.pages.some(({ spaceId }) => spaceId === 'team'),
    false
  )
})

it('stays quiet and reads no data when delivery is disabled', async () => {
  const { service, state } = await fixture()
  state.enabled = false
  assert.equal((await service.prepare(request)).context, '')
  assert.deepEqual(state.reads, [])
})

it('includes relevant older pages beyond forty and keeps context bounded', () => {
  const pages = Array.from({ length: 50 }, (_, index) =>
    page(
      `projects/app/topic-${index}`,
      index === 44 ? 'We researched async synchronization and its tradeoffs.' : 'Unrelated material.'
    )
  )
  const selected = selectAgentContextPages(
    [{ spaceId: 'team', pages, state: 'fresh', checkedAt: 1 }],
    binding,
    'async synchronization'
  )
  assert.deepEqual(
    selected.map(({ slug }) => slug),
    ['projects/app/topic-44']
  )
  const large = selectAgentContextPages(
    [
      {
        spaceId: 'team',
        pages: [page('projects/app', 'long paragraph '.repeat(10_000))],
        state: 'fresh',
        checkedAt: 1,
      },
    ],
    binding,
    ''
  )
  assert.ok(JSON.stringify(large).length < 10_000)
})

it('isolates provider task receipts and never treats a fork as already supplied', async () => {
  const { service } = await fixture()
  service.acknowledge((await service.prepare(request)).packetId)
  assert.equal((await service.prepare({ ...request, provider: 'claude' })).pages.length, 2)
  assert.equal((await service.prepare({ ...request, sessionId: 'forked-task' })).pages.length, 2)
})

it('keeps the mapped project baseline when many personal preference pages exist', () => {
  const snapshots = [
    {
      spaceId: 'personal',
      state: 'fresh' as const,
      checkedAt: 1,
      pages: Array.from({ length: 8 }, (_, index) => page(`concepts/preferences-${index}`, 'A standing preference.')),
    },
    {
      spaceId: 'team',
      state: 'fresh' as const,
      checkedAt: 1,
      pages: [page('projects/app', 'The current project direction.')],
    },
  ]
  const selected = selectAgentContextPages(snapshots, binding, 'Start something new')
  assert.equal(selected.filter(({ reason }) => reason === 'personal-default').length, 2)
  assert.ok(selected.some(({ slug }) => slug === 'projects/app'))
})

it('retains only bounded query terms and migrates old prompts while preserving continuation relevance after restart', async () => {
  const { service, state, dependencies } = await fixture()
  state.pages.get('team')?.push(page('projects/app/synchronization', 'Asynchronous synchronization research.'))
  const prompt = 'Please research asynchronous synchronization, and explain the findings to me.'
  const first = await service.prepare({ ...request, prompt })
  service.acknowledge(first.packetId)
  const filename = `${createHash('sha256').update(`${request.provider}:${request.sessionId}`).digest('hex')}.json`
  const path = join(dependencies.directory, filename)
  const stored = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  assert.equal(Object.hasOwn(stored, 'query'), false)
  assert.ok(Array.isArray(stored.queryTerms))
  assert.ok((stored.queryTerms as string[]).includes('synchronization'))
  assert.doesNotMatch(await readFile(path, 'utf8'), /Please research asynchronous synchronization/)

  const legacy = { ...stored, query: prompt, queryTerms: undefined }
  await writeFile(path, JSON.stringify(legacy))
  const restarted = createAgentContextService(dependencies)
  restarted.prune()
  const migrated = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  assert.equal(Object.hasOwn(migrated, 'query'), false)
  assert.deepEqual(migrated.queryTerms, stored.queryTerms)
  assert.equal((await restarted.prepare({ ...request, prompt: 'Continue' })).changed, false)
  state.pages
    .get('team')
    ?.splice(2, 1, page('projects/app/synchronization', 'Asynchronous synchronization corrected.', 'r2'))
  assert.deepEqual(
    (await restarted.prepare({ ...request, prompt: 'Continue' })).pages.map(({ slug, revision }) => ({
      slug,
      revision,
    })),
    [{ slug: 'projects/app/synchronization', revision: 'r2' }]
  )
})

it('physically removes expired session and provider receipts after restart even when delivery is disabled', async () => {
  const { dependencies, state } = await fixture()
  let now = 100 * 24 * 60 * 60_000
  const service = createAgentContextService({ ...dependencies, now: () => now })
  service.acknowledge((await service.prepare(request)).packetId)
  assert.equal((await readdir(dependencies.directory)).length, 2)
  await writeFile(join(dependencies.directory, 'unrelated.json'), '{"at":0}')
  now += 31 * 24 * 60 * 60_000
  state.enabled = false
  const restarted = createAgentContextService({ ...dependencies, now: () => now })
  restarted.prune()
  assert.deepEqual(await readdir(dependencies.directory), ['unrelated.json'])
  assert.equal(restarted.lastProvided('codex'), null)
  assert.equal(restarted.hasReceipt(request), false)
})

it('prunes owned files in bounded batches without skipping the next batch', async () => {
  const { dependencies } = await fixture()
  const now = 100 * 24 * 60 * 60_000
  await Promise.all(
    Array.from({ length: 260 }, (_, index) =>
      writeFile(
        join(dependencies.directory, `${index.toString(16).padStart(64, '0')}.json`),
        JSON.stringify({ scope: '', at: 0, pages: {}, queryTerms: [] })
      )
    )
  )
  const service = createAgentContextService({ ...dependencies, now: () => now })
  assert.equal(service.prune(), true)
  assert.equal((await readdir(dependencies.directory)).length, 132)
  assert.equal(service.prune(), true)
  assert.equal((await readdir(dependencies.directory)).length, 4)
  assert.equal(service.prune(), false)
  assert.deepEqual(await readdir(dependencies.directory), [])
})

it('rechecks consent and project mapping after retrieval completes', async () => {
  for (const change of ['disable', 'revoke', 'replace'] as const) {
    const { dependencies, state } = await fixture()
    let release: (() => void) | undefined
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const service = createAgentContextService({
      ...dependencies,
      listContextPages: async (spaceId) => {
        const snapshot = await dependencies.listContextPages(spaceId)
        await wait
        return snapshot
      },
    })
    const pending = service.prepare(request)
    if (change === 'disable') state.enabled = false
    else state.bindings = change === 'revoke' ? [] : [{ ...binding, spaceId: 'unselected-team' }]
    release?.()
    const packet = await pending
    assert.equal(
      packet.pages.some(({ spaceId }) => spaceId === 'team'),
      false
    )
    assert.doesNotMatch(packet.context, /The product maintains shared understanding/)
    if (change === 'disable') assert.equal(packet.context, '')
    if (change === 'replace') {
      assert.deepEqual(
        packet.freshness.find(({ spaceId }) => spaceId === 'unselected-team'),
        {
          spaceId: 'unselected-team',
          checkedAt: null,
          state: 'error',
        }
      )
    }
  }
})
