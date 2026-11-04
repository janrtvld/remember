import { PERSONAL_WIKI_SPACE_ID } from '@remember/shared'

export function wikiSpaceId(value?: string | string[] | null) {
  const candidate = Array.isArray(value) ? value[0] : value
  return candidate?.trim() || PERSONAL_WIKI_SPACE_ID
}

function wikiHref(pathname: string, spaceId: string, detail?: { key: string; value: string }) {
  const searchParams = new URLSearchParams({ space: spaceId })
  if (detail) searchParams.set(detail.key, detail.value)
  return `${pathname}?${searchParams.toString()}`
}

export function wikiHomeHref(spaceId: string) {
  return wikiHref('/wiki/', spaceId)
}

export function wikiSuggestionsHref(spaceId: string) {
  return wikiHref('/wiki/suggestions/', spaceId)
}

export function wikiCategoryHref(spaceId: string, category: string) {
  return wikiHref('/wiki/category/', spaceId, { key: 'category', value: category })
}

export function wikiPageHref(spaceId: string, slug: string) {
  return wikiHref('/wiki/page/', spaceId, { key: 'slug', value: slug })
}

export function wikiMarkdownHref(spaceId: string, href: string) {
  const match =
    /^(?:\.\/)?((?:projects|people|decisions|research|processes|concepts)\/[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?(?:\/[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?)*)(?:\.md)?$/.exec(
      href
    )
  return match ? wikiPageHref(spaceId, match[1]) : href
}

export function wikiNewSpaceHref(spaceId: string) {
  return wikiHref('/wiki/new/', spaceId)
}
