import type { WikiPage } from '@remember/shared'

export function wikiParentSlug(slug: string) {
  const segments = slug.split('/')
  return segments.length > 2 ? segments.slice(0, -1).join('/') : null
}

export function wikiDirectChildren(pages: WikiPage[], parentSlug: string) {
  return pages
    .filter((page) => wikiParentSlug(page.slug) === parentSlug)
    .sort((first, second) => second.updatedAt - first.updatedAt)
}

export function wikiRootPages(pages: WikiPage[], category: string) {
  return pages
    .filter((page) => page.slug.startsWith(`${category}/`) && wikiParentSlug(page.slug) === null)
    .sort((first, second) => second.updatedAt - first.updatedAt)
}

export function wikiCategoryCount(pages: WikiPage[], category: string) {
  return wikiRootPages(pages, category).length
}

export function wikiAncestors(page: WikiPage, pages: WikiPage[]) {
  const bySlug = new Map(pages.map((candidate) => [candidate.slug, candidate]))
  const ancestors: WikiPage[] = []
  let parentSlug = wikiParentSlug(page.slug)
  while (parentSlug) {
    const parent = bySlug.get(parentSlug)
    if (!parent) break
    ancestors.unshift(parent)
    parentSlug = wikiParentSlug(parent.slug)
  }
  return ancestors
}
