import type { WikiPage, WikiPageForAnalysis, WikiPageUpdate } from '@remember/shared'

export function assertWikiAnalysisRevisions(
  spaceId: string,
  updates: Pick<WikiPageUpdate, 'slug'>[],
  expectedPages: Pick<WikiPageForAnalysis, 'spaceId' | 'slug' | 'revision'>[],
  currentPages: Pick<WikiPage, 'slug' | 'revision'>[]
) {
  for (const update of updates) {
    const expected = expectedPages.find((page) => page.spaceId === spaceId && page.slug === update.slug)
    const current = currentPages.find((page) => page.slug === update.slug)
    if (Boolean(current) !== Boolean(expected) || (current?.revision ?? null) !== (expected?.revision ?? null))
      throw new Error('wiki-page-conflict')
  }
}
