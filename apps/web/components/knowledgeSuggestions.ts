import type { KnowledgeSuggestion, WikiChangeLogEntry, WikiSpace } from '@remember/shared'

export interface PersonalWikiChangeGroup {
  slug: string
  title: string
  updates: Array<{
    id: string
    timestamp: number
  }>
}

export function presentedKnowledgeSuggestions(
  dayId: string,
  spaces: WikiSpace[],
  storedSuggestions: KnowledgeSuggestion[]
) {
  return storedSuggestions.flatMap((suggestion) => {
    if (suggestion.dayId !== dayId || suggestion.status !== 'pending') return []
    const destinationSpace = spaces.find((space) => space.id === suggestion.suggestedSpaceId)
    if (!destinationSpace) return []
    return [{ suggestion, destinationSpace }]
  })
}

export function personalWikiChangesForDay(dayId: string, changes: WikiChangeLogEntry[]) {
  return changes.filter((entry) => entry.dayId === dayId)
}

export function groupedPersonalWikiChangesForDay(
  dayId: string,
  changes: WikiChangeLogEntry[]
): PersonalWikiChangeGroup[] {
  const groups = new Map<string, PersonalWikiChangeGroup>()

  for (const entry of personalWikiChangesForDay(dayId, changes)) {
    entry.changes.forEach((change, index) => {
      const group = groups.get(change.slug) ?? {
        slug: change.slug,
        title: change.title,
        updates: [],
      }
      const latestTimestamp = Math.max(...group.updates.map((update) => update.timestamp), Number.NEGATIVE_INFINITY)

      group.updates.push({ id: `${entry.id}:${index}`, timestamp: entry.timestamp })
      if (entry.timestamp >= latestTimestamp) {
        group.title = change.title
      }
      groups.set(change.slug, group)
    })
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      updates: group.updates.toSorted((a, b) => b.timestamp - a.timestamp),
    }))
    .toSorted((a, b) => (b.updates[0]?.timestamp ?? 0) - (a.updates[0]?.timestamp ?? 0))
}
