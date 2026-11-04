import { createHash } from 'node:crypto'
import type {
  CalendarBlock,
  DailyReviewSession,
  DayMemory,
  TimelineEvidenceReference,
  TimelineItemOverride,
  UpdateTimelineItemInput,
} from '@remember/shared'

const MAX_SOURCE_REFERENCES = 32
const MAX_CONTEXT_REFERENCES = 16
const MAX_AUDIO_REFERENCES = 8
const MAX_APP_REFERENCES = MAX_SOURCE_REFERENCES - MAX_CONTEXT_REFERENCES - MAX_AUDIO_REFERENCES

function minuteOfDay(value: string) {
  if (value === '24:00') return 24 * 60
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (minutes > 59 || hours > 24 || (hours === 24 && minutes !== 0)) return null
  return hours * 60 + minutes
}

function timestampForDayMinute(dayStartedAt: number, minute: number) {
  const timestamp = new Date(dayStartedAt)
  timestamp.setHours(0, 0, 0, 0)
  timestamp.setMinutes(minute)
  return timestamp.getTime()
}

function blockInterval(dayStartedAt: number, block: CalendarBlock) {
  const startMinute = minuteOfDay(block.startTime)
  let endMinute = minuteOfDay(block.endTime)
  if (startMinute == null || endMinute == null || endMinute === startMinute) return null
  if (endMinute < startMinute) endMinute += 24 * 60
  return {
    startedAt: timestampForDayMinute(dayStartedAt, startMinute),
    endedAt: timestampForDayMinute(dayStartedAt, endMinute),
  }
}

function evenlySampleReferences(references: TimelineEvidenceReference[], limit: number) {
  if (references.length <= limit) return references
  return Array.from({ length: limit }, (_, index) => {
    const sourceIndex = Math.round((index * (references.length - 1)) / (limit - 1))
    return references[sourceIndex] as TimelineEvidenceReference
  })
}

function intervalsOverlap(
  first: { startedAt: number; endedAt: number },
  second: { startedAt: number; endedAt: number }
) {
  return first.startedAt < second.endedAt && first.endedAt > second.startedAt
}

type ReferenceTimestamps = Record<TimelineEvidenceReference['kind'], Map<string, number>>

function referenceTimestamps(session: DailyReviewSession): ReferenceTimestamps {
  const timestamps: ReferenceTimestamps = { context: new Map(), audio: new Map(), app: new Map() }
  const first = (kind: TimelineEvidenceReference['kind'], id: string, at: number) => {
    if (!timestamps[kind].has(id)) timestamps[kind].set(id, at)
  }
  for (const moment of session.contextMoments) first('context', moment.id, moment.timestamp)
  for (const moment of session.moments) first('audio', moment.id, moment.startedAt)
  for (const activity of session.appActivity) first('app', activity.id, activity.startedAt)
  return timestamps
}

function referenceTimestamp(timestamps: ReferenceTimestamps, reference: TimelineEvidenceReference) {
  return timestamps[reference.kind].get(reference.id) ?? Number.MAX_SAFE_INTEGER
}

function evidenceReferences(session: DailyReviewSession, block: CalendarBlock, timestamps: ReferenceTimestamps) {
  const interval = blockInterval(session.startedAt, block)
  if (!interval) return []

  const contextReferences = session.contextMoments
    .filter((moment) => moment.timestamp >= interval.startedAt && moment.timestamp < interval.endedAt)
    .map((moment) => ({ kind: 'context' as const, id: moment.id }))
  const audioReferences = session.moments
    .filter(
      (moment) =>
        moment.status === 'ready' &&
        Boolean(moment.transcript.trim()) &&
        intervalsOverlap(interval, {
          startedAt: moment.startedAt,
          endedAt: moment.startedAt + moment.durationMs,
        })
    )
    .map((moment) => ({ kind: 'audio' as const, id: moment.id }))
  const appReferences = session.appActivity
    .filter((activity) =>
      intervalsOverlap(interval, {
        startedAt: activity.startedAt,
        endedAt: activity.endedAt ?? session.endedAt ?? Number.MAX_SAFE_INTEGER,
      })
    )
    .map((activity) => ({ kind: 'app' as const, id: activity.id }))

  return [...contextReferences, ...audioReferences, ...appReferences].sort(
    (first, second) => referenceTimestamp(timestamps, first) - referenceTimestamp(timestamps, second)
  )
}

export function timelineEvidenceReferences(session: DailyReviewSession, block: CalendarBlock) {
  return evidenceReferences(session, block, referenceTimestamps(session))
}

function sourceReferences(session: DailyReviewSession, block: CalendarBlock, timestamps: ReferenceTimestamps) {
  const references = evidenceReferences(session, block, timestamps)
  const contextReferences = references.filter((reference) => reference.kind === 'context')
  const audioReferences = references.filter((reference) => reference.kind === 'audio')
  const appReferences = references.filter((reference) => reference.kind === 'app')
  const sampled: TimelineEvidenceReference[] = [
    ...evenlySampleReferences(contextReferences, MAX_CONTEXT_REFERENCES),
    ...evenlySampleReferences(audioReferences, MAX_AUDIO_REFERENCES),
    ...evenlySampleReferences(appReferences, MAX_APP_REFERENCES),
  ]

  return sampled.sort((first, second) => referenceTimestamp(timestamps, first) - referenceTimestamp(timestamps, second))
}

export function timelineSourceReferences(session: DailyReviewSession, block: CalendarBlock) {
  return sourceReferences(session, block, referenceTimestamps(session))
}

function normalizedTitle(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

function fallbackItemId(sessionId: string, block: CalendarBlock, references: TimelineEvidenceReference[]) {
  const anchor = references.find((reference) => reference.kind !== 'app') ?? references[0]
  const fingerprint = createHash('sha256')
    .update(
      [
        anchor ? `${anchor.kind}:${anchor.id}` : 'no-source',
        block.startTime,
        block.endTime,
        normalizedTitle(block.title),
      ].join('\n')
    )
    .digest('hex')
    .slice(0, 16)
  return `timeline:${sessionId}:${fingerprint}`
}

function temporalOverlapScore(first: CalendarBlock, second: CalendarBlock) {
  const firstStart = minuteOfDay(first.startTime)
  let firstEnd = minuteOfDay(first.endTime)
  const secondStart = minuteOfDay(second.startTime)
  let secondEnd = minuteOfDay(second.endTime)
  if (firstStart == null || firstEnd == null || secondStart == null || secondEnd == null) return 0
  if (firstEnd < firstStart) firstEnd += 24 * 60
  if (secondEnd < secondStart) secondEnd += 24 * 60
  const overlap = Math.max(0, Math.min(firstEnd, secondEnd) - Math.max(firstStart, secondStart))
  const union = Math.max(firstEnd, secondEnd) - Math.min(firstStart, secondStart)
  if (!overlap || !union) return 0
  return overlap / union
}

function overlapScore(first: CalendarBlock, second: CalendarBlock) {
  const temporalScore = temporalOverlapScore(first, second)
  if (!temporalScore) return 0
  const titleBonus = normalizedTitle(first.title) === normalizedTitle(second.title) ? 0.4 : 0
  return temporalScore + titleBonus
}

function withProvenance(session: DailyReviewSession, block: CalendarBlock, timestamps: ReferenceTimestamps) {
  const sourceRefs = sourceReferences(session, block, timestamps)
  return {
    ...block,
    id: block.id ?? fallbackItemId(session.id, block, sourceRefs),
    sourceRefs,
  }
}

function normalizedOverrides(overrides: TimelineItemOverride[] | undefined) {
  return new Map(
    (overrides ?? [])
      .filter((override) => override.id && override.title.trim())
      .map((override) => [
        override.id,
        { ...override, title: override.title.trim(), description: override.description.trim() },
      ])
  )
}

/** Adds deterministic provenance to legacy memories without changing their generated wording. */
export function hydrateTimelineItems(session: DailyReviewSession): DailyReviewSession {
  if (!session.memory) return session
  return hydrateTimelineWithTimestamps(session, referenceTimestamps(session))
}

function hydrateTimelineWithTimestamps(
  session: DailyReviewSession,
  timestamps: ReferenceTimestamps
): DailyReviewSession {
  if (!session.memory) return session
  const overrides = normalizedOverrides(session.memory.timelineOverrides)
  const timeline = session.memory.timeline.map((block) => {
    const hydrated = withProvenance(session, block, timestamps)
    const override = overrides.get(hydrated.id)
    return override ? { ...hydrated, title: override.title, description: override.description } : hydrated
  })
  return { ...session, memory: { ...session.memory, timeline } }
}

/**
 * Reconciles newly generated blocks against the previous Timeline. Temporal overlap keeps
 * identity stable; local user wording remains authoritative after every generated refresh.
 */
export function reconcileTimelineItems(
  session: DailyReviewSession,
  generatedBlocks: CalendarBlock[],
  previousMemory: DayMemory | null
) {
  const timestamps = referenceTimestamps(session)
  const previousSession = hydrateTimelineWithTimestamps({ ...session, memory: previousMemory }, timestamps)
  const previousBlocks = previousSession.memory?.timeline ?? []
  const usedPreviousIds = new Set<string>()
  const overrides = normalizedOverrides(previousMemory?.timelineOverrides)

  const reconciled = generatedBlocks.map((generated) => {
    const candidate = withProvenance(session, generated, timestamps)
    const match = previousBlocks
      .filter((previous) => previous.id && !usedPreviousIds.has(previous.id))
      .map((previous) => ({ previous, score: overlapScore(previous, candidate) }))
      .filter(({ score }) => score >= 0.45)
      .sort((first, second) => second.score - first.score)[0]?.previous
    const id = match?.id ?? candidate.id
    if (match?.id) usedPreviousIds.add(match.id)
    const override = id ? overrides.get(id) : undefined
    return {
      ...candidate,
      id,
      ...(override ? { title: override.title, description: override.description } : {}),
    }
  })
  const retained = previousBlocks.filter(
    (previous) =>
      previous.id &&
      !usedPreviousIds.has(previous.id) &&
      // The generated Timeline is the canonical replacement for every interval it
      // covers. Retaining a broad previous block around a smaller replacement
      // accumulates nested summaries on every refresh and eventually turns one
      // work session into an event log.
      !generatedBlocks.some((generated) => temporalOverlapScore(previous, generated) > 0)
  )

  return [...reconciled, ...retained].sort((first, second) => {
    const firstStart = minuteOfDay(first.startTime) ?? Number.MAX_SAFE_INTEGER
    const secondStart = minuteOfDay(second.startTime) ?? Number.MAX_SAFE_INTEGER
    return firstStart - secondStart || first.endTime.localeCompare(second.endTime)
  })
}

export function updateTimelineMemoryItem(memory: DayMemory, itemId: string, input: UpdateTimelineItemInput) {
  const title = input.title.trim()
  const description = input.description.trim()
  if (!itemId || !title || title.length > 120 || description.length > 600) throw new Error('invalid-timeline-item')
  if (!memory.timeline.some((block) => block.id === itemId)) throw new Error('timeline-item-not-found')

  const override = { id: itemId, title, description }
  return {
    ...memory,
    timeline: memory.timeline.map((block) => (block.id === itemId ? { ...block, title, description } : block)),
    timelineOverrides: [...(memory.timelineOverrides ?? []).filter((candidate) => candidate.id !== itemId), override],
  }
}

export function hideTimelineMemoryItem(memory: DayMemory, itemId: string) {
  if (!itemId || !memory.timeline.some((block) => block.id === itemId)) throw new Error('timeline-item-not-found')
  return {
    ...memory,
    hiddenTimelineItemIds: Array.from(new Set([...(memory.hiddenTimelineItemIds ?? []), itemId])),
  }
}

export function showHiddenTimelineMemoryItems(memory: DayMemory) {
  return { ...memory, hiddenTimelineItemIds: [] }
}
