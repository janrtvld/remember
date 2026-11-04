import type { WikiPage } from '@remember/shared'

const SYSTEM_WIKI_SLUGS = new Set(['index', 'log'])

export function isEditableWikiPage(page: WikiPage) {
  return !SYSTEM_WIKI_SLUGS.has(page.slug)
}

export function editableWikiPages(pages: WikiPage[]) {
  return pages.filter(isEditableWikiPage)
}

export function findCreatedWikiPage(
  previousPages: WikiPage[],
  nextPages: WikiPage[],
  options: { category: string; parentSlug?: string }
) {
  const previousSlugs = new Set(editableWikiPages(previousPages).map((page) => page.slug))
  const expectedParent = options.parentSlug ?? options.category
  return editableWikiPages(nextPages).find((page) => {
    const segments = page.slug.split('/')
    return segments.slice(0, -1).join('/') === expectedParent && !previousSlugs.has(page.slug)
  })
}
