import type { Day, KnowledgeSuggestion } from '@remember/shared'
import { localDayStart } from './dailyReview/dayLifecycle'

type WikiDay = Pick<Day, 'id' | 'startedAt'>

export function wikiMutationDayId(sourceId: string, timestamp: number, days: WikiDay[] = []) {
  const sourceDayId = /^daily-review:\/\/([^/]+)/.exec(sourceId)?.[1]
  if (sourceDayId) return sourceDayId
  if (!sourceId.startsWith('agent-learning://')) return null

  // Background learning can finish outside capture hours. Show the mutation on
  // its calendar day without changing the original source or evidence dates.
  const mutationDay = localDayStart(timestamp)
  return days.find((day) => localDayStart(day.startedAt) === mutationDay)?.id ?? null
}

export function attributeAgentWikiSuggestionsToDays(suggestions: KnowledgeSuggestion[], days: WikiDay[]) {
  return suggestions.map((suggestion) => {
    if (!suggestion.sourceId.startsWith('agent-learning://')) return suggestion
    const dayId = wikiMutationDayId(suggestion.sourceId, suggestion.dayStartedAt, days)
    return dayId && dayId !== suggestion.dayId ? { ...suggestion, dayId } : suggestion
  })
}
