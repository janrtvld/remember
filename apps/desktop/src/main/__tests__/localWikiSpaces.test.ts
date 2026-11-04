import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { WikiPageUpdate } from '@remember/shared'

const profile = mkdtempSync(join(tmpdir(), 'remember-local-spaces-'))
const electronKey = '__rememberLocalSpacesElectron'
Object.assign(globalThis, {
  [electronKey]: {
    app: { isPackaged: false, getPath: () => profile, getLocale: () => 'en-US' },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString(),
    },
    shell: {},
    nativeImage: {},
    nativeTheme: {},
  },
})
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? { url: 'remember-test:local-electron', shortCircuit: true }
      : next(specifier, context)
  },
  load(url, context, next) {
    return url === 'remember-test:local-electron'
      ? {
          format: 'module',
          source: `export const { app, safeStorage, shell, nativeImage, nativeTheme } = globalThis.${electronKey}`,
          shortCircuit: true,
        }
      : next(url, context)
  },
})
const store = await import('../wikiSpaceStore')
const { initializeKnowledgeStore } = await import('../dailyReview/knowledgeStore')
const { closeWikiHistoryStore } = await import('../wikiHistoryStore')
hooks.deregister()
Reflect.deleteProperty(globalThis, electronKey)

after(() => {
  closeWikiHistoryStore()
  rmSync(profile, { force: true, recursive: true })
})

test('local Spaces preserve AI memory, project history and revision protection across restart without network access', async (t) => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Local Spaces must not use a network service'))
  initializeKnowledgeStore(profile)
  assert.deepEqual(
    store.getWikiOverview([]).spaces.map((space) => space.id),
    ['personal']
  )

  const created = store.createLocalWikiSpace({ name: 'Research', description: '' }, [])
  const research = created.spaces.find((space) => space.name === 'Research')
  assert(research)
  const review = store
    .createLocalWikiSpace({ name: 'Reviewed memory', description: '' }, [])
    .spaces.find((space) => space.name === 'Reviewed memory')
  assert(review)
  await store.updateWikiSpace({ spaceId: review.id, maintenanceMode: 'suggest' }, [])

  const personal = await store.createWikiPage({
    spaceId: 'personal',
    category: 'projects',
    title: 'Robot research',
    content: 'Compare commercial machine jobs.',
  })
  const project = personal.find((page) => page.slug === 'projects/robot-research')
  assert(project?.revision)
  await store.createWikiPage({
    spaceId: 'personal',
    category: 'projects',
    parentSlug: project.slug,
    title: 'Candidates',
    content: 'Cleaning robots.',
  })
  await store.moveWikiProject(
    {
      projectSlug: project.slug,
      sourceSpaceId: 'personal',
      destinationSpaceId: research.id,
    },
    []
  )
  assert(!(await store.listWikiPages('personal')).some((page) => page.slug === project.slug))
  assert.equal(
    store.getWikiPageHistoryForSpace({ spaceId: research.id, slug: project.slug }).headRevisionId,
    project.revision
  )

  const updates: WikiPageUpdate[] = [
    {
      slug: 'projects/robot-research/costs',
      title: 'Costs',
      content: 'Compare maintenance costs alongside purchase price.',
      summary: 'Added the cost comparison.',
      changeType: 'created',
      suggestedSpaceId: null,
    },
  ]
  await store.applyKnowledgeUpdatesByProject('day-1', Date.now(), updates)
  assert((await store.listWikiPages(research.id)).some((page) => page.slug === updates[0].slug))
  assert(!(await store.listWikiPages('personal')).some((page) => page.slug === updates[0].slug))

  const reviewedUpdate = { ...updates[0], slug: 'documents/budget', title: 'Budget', suggestedSpaceId: review.id }
  await store.applyKnowledgeUpdatesByProject('day-1', Date.now(), [reviewedUpdate], {
    sourceId: 'test://reviewed-memory',
    expectedPages: [],
    explicitDestinations: true,
  })
  const proposal = store.getWikiOverview([]).suggestions.find((suggestion) => suggestion.suggestedSpaceId === review.id)
  assert(proposal)
  assert(!(await store.listWikiPages(review.id)).some((page) => page.slug === reviewedUpdate.slug))
  await store.applyKnowledgeSuggestion({ suggestionId: proposal.id }, [])
  assert((await store.listWikiPages(review.id)).some((page) => page.slug === reviewedUpdate.slug))

  const analyzed = await store.wikiPagesForAnalysis()
  await store.saveWikiPage({
    spaceId: research.id,
    slug: project.slug,
    title: project.title,
    content: 'Human correction.',
    expectedRevision: project.revision,
    strictRevision: true,
  })
  await assert.rejects(
    store.applyKnowledgeUpdatesByProject(
      'day-2',
      Date.now(),
      [
        {
          ...updates[0],
          slug: project.slug,
          title: project.title,
          content: 'Stale model result.',
          changeType: 'updated',
          suggestedSpaceId: research.id,
        },
      ],
      { sourceId: 'test://stale-memory', expectedPages: analyzed, explicitDestinations: true }
    ),
    /wiki-page-conflict/
  )

  closeWikiHistoryStore()
  initializeKnowledgeStore(profile)
  assert.equal(store.getWikiOverview([]).spaces.length, 3)
  const snapshot = await store.readWikiContextSnapshot(research.id)
  assert.equal(snapshot.state, 'fresh')
  assert.equal(snapshot.pages.find((page) => page.slug === project.slug)?.content, 'Human correction.')
  assert(snapshot.pages.some((page) => page.slug === updates[0].slug))
  assert.equal(store.getWikiPageHistoryForSpace({ spaceId: research.id, slug: project.slug }).revisions.length, 2)

  store.removeLocalWikiSpace({ spaceId: review.id }, [])
  assert.equal(store.getWikiOverview([]).spaces.length, 2)
  await assert.rejects(store.listWikiPages(review.id), /wiki-space-not-found/)
  assert.throws(() => store.removeLocalWikiSpace({ spaceId: 'personal' }, []), /invalid-wiki-space-removal/)
  assert((await store.listWikiPages(research.id)).some((page) => page.slug === project.slug))
})

test('an edit during asynchronous AI preparation rejects the whole local batch before any write', async () => {
  initializeKnowledgeStore(profile)
  const pages = await store.createWikiPage({
    spaceId: 'personal',
    category: 'documents',
    title: 'Plan',
    content: 'Original.',
  })
  const plan = pages.find((page) => page.slug === 'documents/plan')
  assert(plan?.revision)
  const expectedPages = await store.wikiPagesForAnalysis()
  await assert.rejects(
    store.applyKnowledgeUpdatesByProject(
      'day-3',
      Date.now(),
      [
        {
          slug: 'documents/new-finding',
          title: 'Finding',
          content: 'Must remain unwritten.',
          summary: 'Added a finding.',
          changeType: 'created',
          suggestedSpaceId: 'personal',
        },
        {
          slug: plan.slug,
          title: plan.title,
          content: 'AI result.',
          summary: 'Updated plan.',
          changeType: 'updated',
          suggestedSpaceId: 'personal',
        },
      ],
      {
        sourceId: 'test://concurrent-memory',
        expectedPages,
        explicitDestinations: true,
        assertCurrent: async () => {
          await store.saveWikiPage({
            spaceId: 'personal',
            slug: plan.slug,
            title: plan.title,
            content: 'New human decision.',
            expectedRevision: plan.revision,
            strictRevision: true,
          })
          return true
        },
      }
    ),
    /wiki-page-conflict/
  )
  const current = await store.listWikiPages('personal')
  assert.equal(current.find((page) => page.slug === plan.slug)?.content, 'New human decision.')
  assert(!current.some((page) => page.slug === 'documents/new-finding'))
})
