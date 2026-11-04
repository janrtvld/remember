import type { WikiOverview, WikiPage } from '@remember/shared'

function accessKey(overview: WikiOverview) {
  return JSON.stringify(overview.spaces.map((space) => space.id).sort())
}

export function retainWikiPageCache(pages: Record<string, WikiPage[]>, overview: WikiOverview) {
  const allowed = new Set(overview.spaces.map((space) => space.id))
  return Object.fromEntries(Object.entries(pages).filter(([spaceId]) => allowed.has(spaceId)))
}

export function createWikiCacheAccess() {
  let revision = 0
  let overview: WikiOverview | null = null
  return {
    revision: () => revision,
    overview: () => overview,
    acceptOverview(next: WikiOverview, expectedRevision = revision) {
      if (expectedRevision !== revision) return null
      const ids = new Set(next.spaces.map((space) => space.id))
      next = {
        ...next,
        suggestions: next.suggestions.filter((suggestion) =>
          ids.has(suggestion.destinationSpaceId ?? suggestion.suggestedSpaceId)
        ),
        projectAssignments: next.projectAssignments.filter((assignment) => ids.has(assignment.spaceId)),
      }
      if (overview && accessKey(overview) !== accessKey(next)) revision += 1
      overview = next
      return next
    },
    acceptsPages(spaceId: string, expectedRevision: number) {
      return expectedRevision === revision && overview?.spaces.some((space) => space.id === spaceId) === true
    },
  }
}
