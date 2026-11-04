import { type ConversationSummary, conversationReference, type Day } from '@remember/shared'
import type { DayTab } from './dayTabs'

export function localDateKey(timestamp: number) {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

export function daysForDaySwitcher(days: Day[], currentDay: Day) {
  const currentDateKey = localDateKey(currentDay.startedAt)
  const daysByDate = new Map<string, Day>()

  for (const day of [...days].sort((left, right) => right.startedAt - left.startedAt)) {
    const dateKey = localDateKey(day.startedAt)

    if (!daysByDate.has(dateKey) || (dateKey === currentDateKey && day.id === currentDay.id)) {
      daysByDate.set(dateKey, day)
    }
  }

  return [...daysByDate.values()]
}

export function isLocalToday(timestamp: number, now = Date.now()) {
  return localDateKey(timestamp) === localDateKey(now)
}

export function dayHref(day: Pick<Day, 'id' | 'startedAt'>, now = Date.now()) {
  return daySectionHref(day, 'day', now)
}

const daySectionPaths: Record<DayTab, string> = {
  day: '/day/',
  conversations: '/day/conversations/',
  timeline: '/day/timeline/',
  knowledge: '/day/knowledge/',
}

function withDayId(
  pathname: string,
  day: Pick<Day, 'id' | 'startedAt'>,
  now: number,
  detail?: { key: string; value: string }
) {
  const searchParams = new URLSearchParams()
  if (!isLocalToday(day.startedAt, now)) searchParams.set('id', day.id)
  if (detail) searchParams.set(detail.key, detail.value)
  const query = searchParams.toString()
  return query ? `${pathname}?${query}` : pathname
}

export function daySectionHref(day: Pick<Day, 'id' | 'startedAt'>, section: DayTab, now = Date.now()) {
  return withDayId(daySectionPaths[section], day, now)
}

export function dayConversationHref(
  day: Pick<Day, 'id' | 'startedAt'>,
  conversation: ConversationSummary | string,
  now = Date.now()
) {
  const reference = typeof conversation === 'string' ? conversation : conversationReference(conversation)
  return withDayId('/day/conversation/', day, now, { key: 'conversation', value: reference })
}

export function conversationsConversationHref(
  day: Pick<Day, 'id' | 'startedAt'>,
  conversation: ConversationSummary | string,
  now = Date.now()
) {
  const reference = typeof conversation === 'string' ? conversation : conversationReference(conversation)
  return withDayId('/conversations/conversation/', day, now, { key: 'conversation', value: reference })
}

export function dayTimelineItemHref(day: Pick<Day, 'id' | 'startedAt'>, itemId: string | undefined, now = Date.now()) {
  return withDayId('/day/timeline/', day, now, itemId ? { key: 'timelineItem', value: itemId } : undefined)
}
