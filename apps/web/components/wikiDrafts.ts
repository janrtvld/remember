import { removeLocalStorageItemsWhere } from '../lib/localStorageJson'

const PREFIX = 'remember:wiki-draft:'

export function wikiDraftStorageKey(spaceId: string, slug: string) {
  return `${PREFIX}${spaceId}:${slug}`
}

export function removeWikiDrafts(spaceIds: readonly string[]) {
  const removed = new Set(spaceIds)
  removeLocalStorageItemsWhere((key) => key.startsWith(PREFIX) && removed.has(key.slice(PREFIX.length).split(':')[0]))
}
