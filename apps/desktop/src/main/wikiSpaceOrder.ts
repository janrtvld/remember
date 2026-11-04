export function applyWikiSpaceOrder<T extends { id: string }>(spaces: T[], orderedIds: string[]) {
  const spacesById = new Map(spaces.map((space) => [space.id, space]))
  const orderedSpaces = orderedIds.flatMap((spaceId) => {
    const space = spacesById.get(spaceId)
    if (!space) return []
    spacesById.delete(spaceId)
    return [space]
  })
  return [...orderedSpaces, ...spaces.filter((space) => spacesById.has(space.id))]
}

export function isCompleteWikiSpaceOrder(spaceIds: unknown, spaces: Array<{ id: string }>) {
  if (!Array.isArray(spaceIds) || spaceIds.some((spaceId) => typeof spaceId !== 'string')) return false
  if (spaceIds.length !== spaces.length || new Set(spaceIds).size !== spaceIds.length) return false
  const currentIds = new Set(spaces.map((space) => space.id))
  return spaceIds.every((spaceId) => currentIds.has(spaceId))
}
