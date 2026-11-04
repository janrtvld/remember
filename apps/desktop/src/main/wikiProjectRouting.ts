import {
  PERSONAL_WIKI_SPACE_ID,
  type WikiPage,
  type WikiPageUpdate,
  type WikiProjectAssignment,
  type WikiSpace,
} from '@remember/shared'

export function isWikiProjectPage(slug: string, projectSlug: string) {
  return slug === projectSlug || slug.startsWith(`${projectSlug}/`)
}

export function hasWikiProjectNamespaceConflict(projectSlug: string, destinationSlugs: string[]) {
  return destinationSlugs.some((slug) => isWikiProjectPage(slug, projectSlug))
}

export function orderWikiProjectPagesForDeletion<T extends Pick<WikiPage, 'slug'>>(pages: T[]) {
  return [...pages].sort((first, second) => {
    const depth = second.slug.split('/').length - first.slug.split('/').length
    return depth || first.slug.localeCompare(second.slug)
  })
}

export function routeWikiProjectUpdates(
  assignments: WikiProjectAssignment[],
  spaces: WikiSpace[],
  updates: WikiPageUpdate[],
  pageSpaceIdsBySlug: ReadonlyMap<string, string[]> = new Map(),
  options?: { explicitDestinations?: boolean }
) {
  const spacesById = new Map(spaces.map((space) => [space.id, space]))
  const automaticBySpace = new Map<string, WikiPageUpdate[]>()
  const proposalsBySpace = new Map<string, WikiPageUpdate[]>()

  for (const update of updates) {
    if (options?.explicitDestinations) {
      const destination = update.suggestedSpaceId ? spacesById.get(update.suggestedSpaceId) : undefined
      if (!destination) throw new Error('wiki-space-unavailable')
      const target = destination.maintenanceMode === 'suggest' ? proposalsBySpace : automaticBySpace
      target.set(destination.id, [...(target.get(destination.id) ?? []), { ...update, suggestedSpaceId: null }])
      continue
    }
    const assignment = assignments
      .filter((candidate) => spacesById.has(candidate.spaceId) && isWikiProjectPage(update.slug, candidate.projectSlug))
      .sort((first, second) => second.projectSlug.length - first.projectSlug.length)[0]
    const exactLocations = pageSpaceIdsBySlug.get(update.slug) ?? []
    const uniqueExistingSpaceId = exactLocations.length === 1 ? exactLocations[0] : null
    const inheritedSpaceId =
      !assignment && exactLocations.length === 0 ? nearestProjectSpace(update.slug, pageSpaceIdsBySlug) : null
    const destinationSpaceId =
      assignment?.spaceId ?? uniqueExistingSpaceId ?? inheritedSpaceId ?? PERSONAL_WIKI_SPACE_ID
    const maintenanceMode = spacesById.get(destinationSpaceId)?.maintenanceMode ?? 'auto'
    const target = maintenanceMode === 'suggest' ? proposalsBySpace : automaticBySpace
    target.set(destinationSpaceId, [...(target.get(destinationSpaceId) ?? []), { ...update, suggestedSpaceId: null }])
  }

  return { automaticBySpace, proposalsBySpace }
}

export function wikiProjectUpdateRoutingMatches(
  first: ReturnType<typeof routeWikiProjectUpdates>,
  second: ReturnType<typeof routeWikiProjectUpdates>
) {
  const destinations = ({ automaticBySpace, proposalsBySpace }: ReturnType<typeof routeWikiProjectUpdates>) =>
    [
      ...[...automaticBySpace].flatMap(([spaceId, updates]) => updates.map(({ slug }) => ['auto', spaceId, slug])),
      ...[...proposalsBySpace].flatMap(([spaceId, updates]) => updates.map(({ slug }) => ['suggest', spaceId, slug])),
    ]
      .map((destination) => JSON.stringify(destination))
      .sort()
  return JSON.stringify(destinations(first)) === JSON.stringify(destinations(second))
}

function nearestProjectSpace(slug: string, pageSpaceIdsBySlug: ReadonlyMap<string, string[]>) {
  const parts = slug.split('/')
  if (parts[0] !== 'projects' || parts.length < 3) return null
  for (let length = parts.length - 1; length >= 2; length -= 1) {
    const locations = pageSpaceIdsBySlug.get(parts.slice(0, length).join('/'))
    // An ambiguous nearest parent must not fall through to a more distant match.
    if (locations?.length) return locations.length === 1 ? locations[0] : null
  }
  return null
}
