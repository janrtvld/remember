import type { ConversationSummary, Day } from '@remember/shared'

export interface ConversationHistoryItem {
  day: Day
  conversation: ConversationSummary
  startedAt: number
}

export interface ConversationHistoryGroup {
  date: number
  items: ConversationHistoryItem[]
}

function startOfLocalDay(timestamp: number) {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function conversationTimestamp(dayStartedAt: number, time: string) {
  const [hours = 0, minutes = 0] = time.split(':').map(Number)
  const timestamp = new Date(dayStartedAt)
  timestamp.setHours(hours, minutes, 0, 0)
  return timestamp.getTime()
}

export function conversationHistory(days: Day[]): ConversationHistoryGroup[] {
  const byDate = new Map<number, ConversationHistoryItem[]>()

  for (const day of days) {
    const date = startOfLocalDay(day.startedAt)
    const items = byDate.get(date) ?? []
    for (const conversation of day.memory?.conversations ?? []) {
      items.push({
        day,
        conversation,
        startedAt: conversationTimestamp(day.startedAt, conversation.startTime),
      })
    }
    if (items.length) byDate.set(date, items)
  }

  return [...byDate.entries()]
    .map(([date, items]) => ({ date, items: items.sort((left, right) => right.startedAt - left.startedAt) }))
    .sort((left, right) => right.date - left.date)
}

export function limitConversationHistory(
  groups: ConversationHistoryGroup[],
  limit: number
): ConversationHistoryGroup[] {
  let remaining = Math.max(0, limit)

  return groups.flatMap((group) => {
    if (!remaining) return []
    const items = group.items.slice(0, remaining)
    remaining -= items.length
    return items.length ? [{ ...group, items }] : []
  })
}

export function mergeableConversationHistory(groups: ConversationHistoryGroup[]) {
  return groups.flatMap((group) => {
    const items = group.items.filter(
      ({ conversation }) => conversation.episodeId && conversation.source !== 'revinote' && !conversation.processing
    )
    return items.length ? [{ ...group, items }] : []
  })
}

export function canMergeConversationHistory(groups: ConversationHistoryGroup[]) {
  for (const group of mergeableConversationHistory(groups)) {
    const countsByDay = new Map<string, number>()
    for (const { day } of group.items) {
      const count = (countsByDay.get(day.id) ?? 0) + 1
      if (count >= 2) return true
      countsByDay.set(day.id, count)
    }
  }
  return false
}
