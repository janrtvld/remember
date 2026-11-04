import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import type { WikiPage, WikiSpace } from '@remember/shared'
import {
  createKnowledgePageAt,
  getKnowledgePageHistoryAt,
  initializeKnowledgeStore,
  listKnowledgePagesAt,
  saveKnowledgePageAt,
} from '../dailyReview/knowledgeStore'
import { createWikiCliRequestHandler } from '../wikiCliProtocol'
import { closeWikiHistoryStore } from '../wikiHistoryStore'

it('source deduplication, precise concurrent writes, contributions, access and restart use the real store', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'living-spaces-'))
  const directory = join(profile, 'daily-review/wiki')
  initializeKnowledgeStore(profile)
  const space = { id: 'personal', maintenanceMode: 'auto' } as WikiSpace
  const dependencies = {
    getSpaces: () => [space],
    getHistory: (_spaceId: string, slug: string) => getKnowledgePageHistoryAt(directory, slug),
    listPages: async () => listKnowledgePagesAt(directory),
    createPage: async (input: Parameters<typeof createKnowledgePageAt>[1]) => createKnowledgePageAt(directory, input),
    savePage: async (input: Parameters<typeof saveKnowledgePageAt>[1]) => saveKnowledgePageAt(directory, input),
    deletePage: async () => [],
    proposePage: async () => {
      throw new Error('unexpected-proposal')
    },
  }
  const handle = createWikiCliRequestHandler(dependencies)
  const request = {
    id: 'test',
    action: 'wiki.ensure',
    spaceId: 'personal',
    source: 'https://woub.sentry.io/issues/123/?query=test#event',
    title: 'Push onderzoek',
    content: 'Hypothese: provider.',
    client: 'codex',
    summary: 'Onderzoek gestart',
  }
  try {
    const results = await Promise.all([handle(request), handle({ ...request, client: 'claude' })])
    for (const result of results) assert(result.ok)
    const first = results[0].ok ? (results[0].result as WikiPage) : assert.fail()
    assert.equal(listKnowledgePagesAt(directory).filter((page) => page.slug === first.slug).length, 1)
    assert.equal((await handle({ ...request, source: 'https://woub.sentry.io/issues/123' })).ok, true)
    const baseline = await handle({ id: 'baseline', action: 'wiki.changes', spaceId: 'personal' })
    assert(baseline.ok)
    const cursor = (baseline.result as { cursor: string }).cursor
    const patch = {
      id: 'patch',
      action: 'wiki.patch',
      spaceId: 'personal',
      slug: first.slug,
      expectedRevision: first.revision,
      before: 'Hypothese: provider.',
      after: 'Uitgesloten: provider. Vraag: targeting?',
      client: 'claude',
      summary: 'Provider uitgesloten',
    }
    const updated = await handle(patch)
    assert(updated.ok)
    assert.deepEqual(await handle(patch), { id: 'patch', ok: false, error: 'wiki-page-conflict' })
    const history = getKnowledgePageHistoryAt(directory, first.slug)
    assert.equal(history.revisions[0].sourceId, 'client:claude')
    assert.equal(history.revisions[0].parentRevisionId, first.revision)
    assert.deepEqual(await handle({ ...request, spaceId: 'forbidden' }), {
      id: 'test',
      ok: false,
      error: 'wiki-space-not-found',
    })
    closeWikiHistoryStore()
    initializeKnowledgeStore(profile)
    const resumed = await createWikiCliRequestHandler(dependencies)({
      id: 'resumed',
      action: 'wiki.changes',
      spaceId: 'personal',
      cursor,
    })
    assert(resumed.ok)
    const changed = (resumed.result as { pages: WikiPage[] }).pages
    assert(changed.some((page) => page.slug === first.slug && page.content.includes('targeting?')))
    const concurrent = await Promise.all(
      ['codex', 'claude'].map((client) =>
        handle({
          ...patch,
          client,
          expectedRevision: (updated.result as WikiPage).revision,
          before: 'targeting?',
          after: `targeting gecontroleerd door ${client}`,
        })
      )
    )
    assert.equal(concurrent.filter((result) => result.ok).length, 1)
    assert(concurrent.some((result) => !result.ok && result.error === 'wiki-page-conflict'))

    assert.deepEqual(
      await handle({
        ...patch,
        expectedRevision: listKnowledgePagesAt(directory).find((page) => page.slug === first.slug)?.revision,
        before: 'absent',
      }),
      { id: 'patch', ok: false, error: 'patch-target-not-unique' }
    )
  } finally {
    closeWikiHistoryStore()
    rmSync(profile, { recursive: true, force: true })
  }
})
