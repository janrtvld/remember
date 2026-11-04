import {
  type CalendarBlock,
  type ConversationSummary,
  type Day,
  matchPreparedSearchDocument,
  prepareSearchDocument,
  searchTerms,
  type WikiPage,
  type WikiSpace,
} from '@remember/shared'
import { dayConversationHref, dayHref, dayTimelineItemHref } from './dayNavigation'
import { isEditableWikiPage } from './wikiPages'

export {
  type ConversationSearchResult,
  conversationTranscript,
  type DaySearchResult,
  type RememberSearchResults,
  searchRemember,
  searchTerms,
  type TimelineSearchResult,
} from '@remember/shared'

export type WikiSearchResult = {
  kind: 'wiki'
  space: WikiSpace
  page: WikiPage
  title: string
  snippet: string
  score: number
}

const wikiDocuments = new WeakMap<WikiPage, { spaceName: string; document: ReturnType<typeof prepareSearchDocument> }>()

export function searchWikiPages(
  spaces: WikiSpace[],
  pagesBySpace: Record<string, WikiPage[]>,
  query: string,
  limit = 12
): WikiSearchResult[] {
  const terms = searchTerms(query)
  if (!terms.length) return []
  const results: WikiSearchResult[] = []
  for (const space of spaces) {
    for (const page of pagesBySpace[space.id] ?? []) {
      if (!isEditableWikiPage(page)) continue
      let cached = wikiDocuments.get(page)
      if (!cached || cached.spaceName !== space.name) {
        cached = {
          spaceName: space.name,
          document: prepareSearchDocument({
            title: page.title,
            fields: [page.slug, page.content, page.excerpt, space.name],
          }),
        }
        wikiDocuments.set(page, cached)
      }
      const match = matchPreparedSearchDocument(cached.document, terms)
      if (match) results.push({ kind: 'wiki', space, page, title: page.title, ...match })
    }
  }
  return results
    .sort((left, right) => right.score - left.score || right.page.updatedAt - left.page.updatedAt)
    .slice(0, limit)
}

export function daySearchHref(day: Pick<Day, 'id' | 'startedAt'>, now = Date.now()) {
  return dayHref(day, now)
}

export function conversationSearchHref(
  day: Pick<Day, 'id' | 'startedAt'>,
  conversation: ConversationSummary,
  now = Date.now()
) {
  return dayConversationHref(day, conversation, now)
}

export function timelineSearchHref(day: Pick<Day, 'id' | 'startedAt'>, block: CalendarBlock, now = Date.now()) {
  return dayTimelineItemHref(day, block.id, now)
}
