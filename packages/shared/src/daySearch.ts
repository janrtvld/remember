import {
  type CalendarBlock,
  type ConversationSummary,
  type Day,
  type DayMemory,
  redactSensitiveCaptureText,
} from './index'
import { timelineSources } from './timelineEvidence'

export type DaySearchResult = {
  kind: 'day'
  day: Pick<Day, 'id' | 'startedAt'>
  title: string
  snippet: string
  score: number
}

export type ConversationSearchResult = {
  kind: 'conversation'
  day: Pick<Day, 'id' | 'startedAt'>
  conversation: ConversationSummary
  title: string
  snippet: string
  score: number
  transcriptMatch: boolean
}

export type TimelineSearchResult = {
  kind: 'timeline'
  day: Pick<Day, 'id' | 'startedAt'>
  block: CalendarBlock
  title: string
  snippet: string
  score: number
}

export type RememberSearchResults = {
  days: DaySearchResult[]
  conversations: ConversationSearchResult[]
  timeline: TimelineSearchResult[]
}

type SearchDocument = {
  title: string
  fields: string[]
}

function normalize(value: string) {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('nl-NL')
}

export function searchTerms(query: string) {
  return normalize(query).split(/\s+/).filter(Boolean)
}

export function prepareSearchDocument(document: SearchDocument) {
  const safeTitle = redactSensitiveCaptureText(document.title)
  const safeFields = document.fields.map(redactSensitiveCaptureText)
  const normalizedTitle = normalize(safeTitle)
  const normalizedFields = safeFields.map(normalize)
  const searchable = [normalizedTitle, ...normalizedFields].join('\n')
  return { safeTitle, safeFields, normalizedTitle, normalizedFields, searchable }
}

export function matchPreparedSearchDocument(document: ReturnType<typeof prepareSearchDocument>, terms: string[]) {
  const { safeTitle, safeFields, normalizedTitle, normalizedFields, searchable } = document
  if (!terms.every((term) => searchable.includes(term))) return null

  let score = 0
  for (const term of terms) {
    if (normalizedTitle === term) score += 12
    else if (normalizedTitle.startsWith(term)) score += 8
    else if (normalizedTitle.includes(term)) score += 5
    if (normalizedFields.some((field) => field.includes(term))) score += 2
  }

  const matchingFieldIndex = normalizedFields.findIndex((field) => terms.some((term) => field.includes(term)))
  return {
    score,
    snippet: snippetAroundMatch(safeFields[matchingFieldIndex] ?? safeFields[0] ?? safeTitle, terms),
  }
}

export function matchSearchDocument(document: SearchDocument, terms: string[]) {
  return matchPreparedSearchDocument(prepareSearchDocument(document), terms)
}

function snippetAroundMatch(value: string, terms: string[], maxLength = 180) {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (compact.length <= maxLength) return compact

  const normalizedValue = normalize(compact)
  const matchIndex = terms.reduce((earliest, term) => {
    const index = normalizedValue.indexOf(term)
    return index === -1 ? earliest : Math.min(earliest, index)
  }, Number.POSITIVE_INFINITY)
  const center = Number.isFinite(matchIndex) ? matchIndex : 0
  const start = Math.max(0, Math.min(compact.length - maxLength, center - Math.floor(maxLength / 3)))
  const end = Math.min(compact.length, start + maxLength)
  return `${start > 0 ? '…' : ''}${compact.slice(start, end).trim()}${end < compact.length ? '…' : ''}`
}

function timestampForDayTime(dayStartedAt: number, time: string) {
  const [hours, minutes] = time.split(':').map(Number)
  const timestamp = new Date(dayStartedAt)
  timestamp.setHours(hours === 24 ? 0 : hours, minutes, 0, 0)
  if (hours === 24) timestamp.setDate(timestamp.getDate() + 1)
  return timestamp.getTime()
}

export function conversationTranscript(day: Day, conversation: ConversationSummary) {
  const startedAt = timestampForDayTime(day.startedAt, conversation.startTime)
  const endedAt = timestampForDayTime(day.startedAt, conversation.endTime)

  return day.moments
    .filter((moment) => {
      if (moment.status !== 'ready' || !moment.transcript.trim()) return false
      const momentEndedAt = moment.startedAt + moment.durationMs
      return moment.startedAt < endedAt && momentEndedAt > startedAt
    })
    .sort((first, second) => first.startedAt - second.startedAt || first.source.localeCompare(second.source))
    .map((moment) => moment.transcript.trim())
    .join('\n')
}

function dayFields(memory: DayMemory) {
  const hiddenTimelineIds = new Set(memory.hiddenTimelineItemIds ?? [])
  return [
    memory.summary,
    memory.currentFocus ?? '',
    ...memory.outcomes,
    ...memory.decisions,
    ...memory.openLoops,
    ...(memory.openTasks ?? []).flatMap((task) => [task.title, task.description, task.context ?? '']),
    ...(memory.projectAttention ?? []).flatMap((project) => [project.project, project.description]),
    ...memory.timeline
      .filter((block) => !block.id || !hiddenTimelineIds.has(block.id))
      .flatMap((block) => [block.title, block.description, ...(block.details ?? []).map((detail) => detail.text)]),
    ...memory.knowledgeSuggestions.flatMap((suggestion) => [suggestion.title, suggestion.summary]),
  ].filter(Boolean)
}

function dayTitle(timestamp: number, locale: 'en-US' | 'nl-NL') {
  const label = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(timestamp)
  return label.charAt(0).toLocaleUpperCase(locale) + label.slice(1)
}

function recognizedConversationIntervals(day: Day) {
  return (day.memory?.conversations ?? []).map((conversation) => ({
    startedAt: timestampForDayTime(day.startedAt, conversation.startTime),
    endedAt: timestampForDayTime(day.startedAt, conversation.endTime),
  }))
}

function searchableTimelineSources(day: Day, block: CalendarBlock) {
  const conversationIntervals = recognizedConversationIntervals(day)
  return timelineSources(day, block).filter((source) => {
    if (source.kind !== 'audio') return true
    const momentId = source.key.slice('audio:'.length)
    const moment = day.moments.find((candidate) => candidate.id === momentId)
    if (!moment) return false
    const momentEndedAt = moment.startedAt + moment.durationMs
    return conversationIntervals.some(
      (interval) => moment.startedAt < interval.endedAt && momentEndedAt > interval.startedAt
    )
  })
}

type IndexedResult =
  | Omit<DaySearchResult, 'score' | 'snippet'>
  | Omit<ConversationSearchResult, 'score' | 'snippet' | 'transcriptMatch'>
  | Omit<TimelineSearchResult, 'score' | 'snippet'>
type SearchEntry = {
  result: IndexedResult
  document: ReturnType<typeof prepareSearchDocument>
  summary?: ReturnType<typeof prepareSearchDocument>
  transcript?: string
}
const dayIndexes = new WeakMap<Day, Map<string, SearchEntry[]>>()

function* daySearchEntries(day: Day, locale: 'en-US' | 'nl-NL'): Generator<SearchEntry> {
  if (!day.memory) return

  const title = dayTitle(day.startedAt, locale)
  yield {
    result: { kind: 'day', day: { id: day.id, startedAt: day.startedAt }, title },
    document: prepareSearchDocument({ title, fields: dayFields(day.memory) }),
  }

  const hiddenTimelineIds = new Set(day.memory.hiddenTimelineItemIds ?? [])
  for (const block of day.memory.timeline) {
    if (block.id && hiddenTimelineIds.has(block.id)) continue
    const summary = prepareSearchDocument({
      title: block.title,
      fields: [block.description, ...(block.details ?? []).map((detail) => detail.text)].filter(Boolean),
    })
    const evidence = prepareSearchDocument({
      title: block.title,
      fields: searchableTimelineSources(day, block)
        .flatMap((source) => [source.label, source.detail, source.text])
        .filter(Boolean),
    })
    yield {
      document: evidence,
      summary,
      result: {
        kind: 'timeline',
        day: { id: day.id, startedAt: day.startedAt },
        block,
        title: block.title,
      },
    }
  }

  for (const conversation of day.memory.conversations) {
    const transcript = conversationTranscript(day, conversation)
    const document = prepareSearchDocument({
      title: conversation.title,
      fields: [
        conversation.description,
        conversation.summary ?? '',
        ...(conversation.actionPoints ?? []),
        transcript,
      ].filter(Boolean),
    })
    yield {
      document,
      transcript: normalize(transcript),
      result: {
        kind: 'conversation',
        day: { id: day.id, startedAt: day.startedAt },
        conversation,
        title: conversation.title,
      },
    }
  }
}

function daySearchIndex(day: Day, locale: 'en-US' | 'nl-NL') {
  let byLocale = dayIndexes.get(day)
  if (!byLocale) {
    byLocale = new Map()
    dayIndexes.set(day, byLocale)
  }
  let entries = byLocale.get(locale)
  if (!entries) {
    entries = [...daySearchEntries(day, locale)]
    byLocale.set(locale, entries)
  }
  return entries
}

export async function prepareRememberSearch(day: Day, locale: 'en-US' | 'nl-NL', yieldControl: () => Promise<void>) {
  if (dayIndexes.get(day)?.has(locale)) return
  const entries: SearchEntry[] = []
  for (const entry of daySearchEntries(day, locale)) {
    entries.push(entry)
    await yieldControl()
  }
  let byLocale = dayIndexes.get(day)
  if (!byLocale) {
    byLocale = new Map()
    dayIndexes.set(day, byLocale)
  }
  byLocale.set(locale, entries)
}

export function searchRemember(
  days: Day[],
  query: string,
  locale: 'en-US' | 'nl-NL' = 'nl-NL',
  limitPerSection = 8
): RememberSearchResults {
  const terms = searchTerms(query)
  const result: RememberSearchResults = { days: [], conversations: [], timeline: [] }
  if (!terms.length) return result
  for (const day of days) {
    for (const entry of daySearchIndex(day, locale)) {
      const summaryMatch = entry.summary && matchPreparedSearchDocument(entry.summary, terms)
      const match = summaryMatch
        ? { ...summaryMatch, score: summaryMatch.score + 6 }
        : matchPreparedSearchDocument(entry.document, terms)
      if (!match) continue
      const found = entry.result
      if (found.kind === 'day') result.days.push({ ...found, ...match })
      else if (found.kind === 'timeline') result.timeline.push({ ...found, ...match })
      else
        result.conversations.push({
          ...found,
          ...match,
          transcriptMatch: terms.some((term) => entry.transcript?.includes(term)),
        })
    }
  }
  for (const key of ['days', 'conversations', 'timeline'] as const) {
    result[key].sort((a, b) => b.score - a.score || b.day.startedAt - a.day.startedAt)
    result[key].splice(limitPerSection)
  }
  return result
}
