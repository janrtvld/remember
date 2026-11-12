import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { WikiPageForAnalysis, WikiPageUpdate } from '@remember/shared'
import {
  filterWikiUpdatesToSafePromptPages,
  filterWikiUpdatesToSafePromptSelection,
  wikiPagesForPrompt,
} from './wikiPromptSafety'

function page(
  slug: string,
  content: string,
  options: { updatedAt?: number; lastRememberContent?: string } = {}
): WikiPageForAnalysis {
  const edited = options.lastRememberContent !== undefined
  return {
    slug,
    title: slug.split('/').at(-1) ?? slug,
    content,
    excerpt: '',
    updatedAt: options.updatedAt ?? 1,
    sourceCount: 0,
    revision: `revision-${slug}`,
    spaceId: 'personal',
    spaceName: 'Personal',
    maintenanceMode: 'auto',
    editContext: {
      currentRevision: {
        id: `current-${slug}`,
        createdAt: options.updatedAt ?? 1,
        actor: edited ? 'user' : 'remember',
        sourceId: edited ? 'editor' : 'daily-review://day-1',
        summary: null,
      },
      lastRememberRevision: options.lastRememberContent
        ? {
            id: `remember-${slug}`,
            createdAt: 0,
            title: slug,
            content: options.lastRememberContent,
          }
        : null,
      changesSinceRemember: edited
        ? [
            {
              id: `current-${slug}`,
              createdAt: options.updatedAt ?? 1,
              actor: 'user',
              operation: 'updated',
              sourceId: 'editor',
              summary: null,
            },
          ]
        : [],
    },
  }
}

function update(slug: string): WikiPageUpdate {
  return {
    slug,
    title: slug,
    content: 'Replacement body.',
    summary: 'Updated the page.',
    changeType: 'updated',
    suggestedSpaceId: null,
  }
}

describe('Wiki prompt safety', () => {
  it('provides the complete current and Remember revisions instead of clipping a human edit', () => {
    const current = `Current start\n${'c'.repeat(9_000)}\nHuman ending.`
    const previous = `Previous start\n${'p'.repeat(9_000)}\nRemember ending.`
    const [selected] = wikiPagesForPrompt(
      [page('projects/remember/wiki', current, { lastRememberContent: previous })],
      80,
      24_000
    )

    assert.equal(selected?.rewriteAllowed, true)
    assert.equal(selected?.content, current)
    assert.equal(selected?.editContext?.lastRememberRevision?.content, previous)
  })

  it('prioritizes pages with human edits before newer untouched pages', () => {
    const edited = page('projects/remember/wiki', 'Human edit.', {
      updatedAt: 1,
      lastRememberContent: 'Remember version.',
    })
    const untouched = page('projects/newer', 'Newer generated page.', { updatedAt: 100 })

    assert.equal(wikiPagesForPrompt([untouched, edited], 1, 10_000)[0]?.slug, edited.slug)
    assert.equal(wikiPagesForPrompt([untouched, edited], 1, 10_000, { preserveOrder: true })[0]?.slug, untouched.slug)
  })

  it('gives the self profile and pages named by the current work whole-page room first', () => {
    const profile = page('people/me', 'Role and working style.', { updatedAt: 1 })
    const named = page('projects/harbor', 'Harbor state.', { updatedAt: 2 })
    const recent = page('projects/atlas', 'Atlas state.', { updatedAt: 9 })
    const selected = wikiPagesForPrompt([recent, named, profile], Number.POSITIVE_INFINITY, 1_200, {
      relevantTo: 'Reviewed the Harbor rollout plan',
    })
    assert.deepEqual(
      selected.map((entry) => [entry.slug, entry.rewriteAllowed]),
      [
        ['people/me', true],
        ['projects/harbor', true],
        ['projects/atlas', false],
      ]
    )
  })

  it('hard-blocks updates when a complete existing page did not fit the prompt', () => {
    const oversized = page('projects/oversized', 'x'.repeat(20_000), { updatedAt: 2 })
    const omitted = page('projects/omitted', 'Small but beyond the page limit.', { updatedAt: 1 })
    const selected = wikiPagesForPrompt([oversized, omitted], 1, 10_000)

    assert.equal(selected[0]?.rewriteAllowed, false)
    assert.equal(selected[0]?.content, null)
    assert.deepEqual(
      filterWikiUpdatesToSafePromptPages(
        [update(oversized.slug), update(omitted.slug), { ...update('projects/new-page'), changeType: 'created' }],
        [oversized, omitted],
        1,
        10_000
      ).map((candidate) => candidate.slug),
      ['projects/new-page']
    )
  })

  it('blocks an update to an existing page that was not in a focused prompt selection', () => {
    const selected = page('projects/selected', 'Complete selected page.')
    const unselected = page('projects/unselected', 'Complete but irrelevant page.')

    assert.deepEqual(
      filterWikiUpdatesToSafePromptSelection(
        [update(selected.slug), update(unselected.slug), { ...update('projects/new-page'), changeType: 'created' }],
        [selected, unselected],
        wikiPagesForPrompt([selected], 1, 10_000, { preserveOrder: true })
      ).map((candidate) => candidate.slug),
      [selected.slug, 'projects/new-page']
    )
  })

  it('blocks a new slug when reconciliation would retarget it onto a read-only existing page', () => {
    const durableContent = `Release coordination ownership handoff checklist ${'context '.repeat(2_000)}`
    const oversized = page('projects/release-coordination', durableContent)
    const duplicate = {
      ...update('projects/release-coordination-notes'),
      title: 'release-coordination',
      content: durableContent,
      changeType: 'created' as const,
    }

    assert.deepEqual(filterWikiUpdatesToSafePromptPages([duplicate], [oversized], 1, 1_000), [])
  })

  it('keeps an unsynced Shared page identifiable but read-only for the run', () => {
    const shared = {
      ...page('projects/company-brain', 'Last known cloud content.'),
      spaceId: 'company-brain',
      analysisReadOnlyReason: 'wiki-space-sync-failed',
    }
    const [selected] = wikiPagesForPrompt([shared], 1, 10_000)

    assert.equal(selected?.rewriteAllowed, false)
    assert.equal(selected?.content, null)
    assert.equal(selected?.contentUnavailable, 'wiki-space-sync-failed')
    assert.deepEqual(filterWikiUpdatesToSafePromptPages([update(shared.slug)], [shared], 1, 10_000), [])
  })
})
