import {
  type ConversationSummary,
  conversationActionPointItems,
  conversationsShareStableIdentity,
  type DailyReviewMoment,
  type DayMemory,
  type DeletedConversationReference,
  type PersistedEpisodeAnalysis,
  resolveConversationReference,
} from '@remember/shared'
import { suppressLocalConversationsCoveredByRevinote } from '../revinoteMeetings'

const MAX_CONTINUOUS_CONVERSATION_GAP_MS = 2 * 60_000
const CONVERSATION_TIME_ROUNDING_TOLERANCE_MS = 60_000
const MAX_SPEECH_INTERVAL_GAP_MS = 45_000
type ConversationWindow = Pick<ConversationSummary, 'startTime' | 'endTime'>

export function conversationWindowForTimestamps(
  dayStartedAt: number,
  window: { startedAt: number; endedAt: number }
): ConversationWindow {
  const minimumEndedAt = window.startedAt + 60_000
  const endedAt = Math.ceil(Math.max(window.endedAt, minimumEndedAt) / 60_000) * 60_000
  return {
    startTime: timeForDayTimestamp(dayStartedAt, window.startedAt),
    endTime: timeForDayTimestamp(dayStartedAt, endedAt),
  }
}

export function conversationSummaryFromAnalysis(
  dayStartedAt: number,
  summary: PersistedEpisodeAnalysis
): ConversationSummary {
  const conversation: ConversationSummary = {
    ...(summary.episodeId ? { episodeId: summary.episodeId } : {}),
    id: summary.id,
    ...conversationWindowForTimestamps(dayStartedAt, summary),
    title: summary.title,
    description: summary.description,
    summary: summary.summary,
    actionPoints: summary.actionPoints,
  }
  return { ...conversation, actionPointItems: conversationActionPointItems(conversation) }
}

function timestampForDayTime(dayStartedAt: number, time: string) {
  const [hours, minutes] = time.split(':').map(Number)
  const timestamp = new Date(dayStartedAt)
  timestamp.setHours(hours === 24 ? 0 : hours, minutes, 0, 0)
  if (hours === 24) timestamp.setDate(timestamp.getDate() + 1)
  return timestamp.getTime()
}

function timeForDayTimestamp(dayStartedAt: number, timestamp: number) {
  const dayStart = new Date(dayStartedAt)
  dayStart.setHours(0, 0, 0, 0)
  const nextDay = new Date(dayStart)
  nextDay.setDate(nextDay.getDate() + 1)
  if (timestamp >= nextDay.getTime()) return '24:00'

  const date = new Date(timestamp)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function uniqueStrings(values: string[]) {
  const seen = new Set<string>()
  return values.filter((value) => {
    const key = value.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function joinedSentences(values: Array<string | undefined>) {
  return uniqueStrings(values.flatMap((value) => (value?.trim() ? [value.trim()] : []))).join(' ')
}

function mergeConversation(first: ConversationSummary, second: ConversationSummary): ConversationSummary {
  const title = second.title.length > first.title.length ? second.title : first.title
  const actionPoints = uniqueStrings([...(first.actionPoints ?? []), ...(second.actionPoints ?? [])])
  const actionPointItems = [...conversationActionPointItems(first), ...conversationActionPointItems(second)].filter(
    (item, index, items) =>
      items.findIndex(
        (candidate) =>
          candidate.text.trim().replace(/\s+/g, ' ').toLocaleLowerCase() ===
          item.text.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
      ) === index
  )

  return {
    startTime: first.startTime,
    endTime: second.endTime,
    title,
    description: joinedSentences([first.description, second.description]),
    summary: joinedSentences([first.summary ?? first.description, second.summary ?? second.description]),
    actionPoints,
    actionPointItems,
    ...(first.otherParticipantName && first.otherParticipantName === second.otherParticipantName
      ? { otherParticipantName: first.otherParticipantName }
      : {}),
  }
}

function hasBridgingSpeech(
  dayStartedAt: number,
  first: ConversationSummary,
  second: ConversationSummary,
  moments: DailyReviewMoment[],
  blockedWindows: ConversationWindow[]
) {
  const firstEnd = timestampForDayTime(dayStartedAt, first.endTime)
  const secondStart = timestampForDayTime(dayStartedAt, second.startTime)
  if (secondStart < firstEnd || secondStart - firstEnd > MAX_CONTINUOUS_CONVERSATION_GAP_MS) return false
  if (
    blockedWindows.some((window) => {
      const bounds = conversationBounds(dayStartedAt, window)
      return bounds.startedAt < secondStart && bounds.endedAt > firstEnd
    })
  ) {
    return false
  }

  const intervals = moments
    .filter((moment) => moment.source !== 'revinote' && moment.status === 'ready' && moment.transcript.trim())
    .map((moment) => ({ startedAt: moment.startedAt, endedAt: moment.startedAt + moment.durationMs }))
    .filter(
      (interval) =>
        interval.endedAt >= firstEnd - CONVERSATION_TIME_ROUNDING_TOLERANCE_MS &&
        interval.startedAt <= secondStart + CONVERSATION_TIME_ROUNDING_TOLERANCE_MS
    )
    .sort((firstInterval, secondInterval) => firstInterval.startedAt - secondInterval.startedAt)

  let speechThrough: number | null = null
  for (const interval of intervals) {
    if (speechThrough == null) {
      if (
        interval.startedAt <= firstEnd + CONVERSATION_TIME_ROUNDING_TOLERANCE_MS &&
        interval.endedAt >= firstEnd - CONVERSATION_TIME_ROUNDING_TOLERANCE_MS
      ) {
        speechThrough = interval.endedAt
      }
    } else if (interval.startedAt <= speechThrough + MAX_SPEECH_INTERVAL_GAP_MS) {
      speechThrough = Math.max(speechThrough, interval.endedAt)
    }

    if (speechThrough != null && speechThrough >= secondStart - CONVERSATION_TIME_ROUNDING_TOLERANCE_MS) {
      return true
    }
  }
  return false
}

/**
 * Model synthesis can split one uninterrupted exchange at a shard boundary.
 * Merge only when ready local transcript evidence actually bridges the gap;
 * nearby but silent conversations remain separate.
 */
export function reconcileAdjacentConversations(
  dayStartedAt: number,
  conversations: ConversationSummary[],
  moments: DailyReviewMoment[],
  blockedWindows: ConversationWindow[] = []
) {
  const sorted = [...conversations].sort(
    (first, second) =>
      timestampForDayTime(dayStartedAt, first.startTime) - timestampForDayTime(dayStartedAt, second.startTime)
  )
  const reconciled: ConversationSummary[] = []

  for (const conversation of sorted) {
    const previous = reconciled.at(-1)
    if (!previous || !hasBridgingSpeech(dayStartedAt, previous, conversation, moments, blockedWindows)) {
      reconciled.push(conversation)
      continue
    }
    reconciled[reconciled.length - 1] = mergeConversation(previous, conversation)
  }

  return reconciled
}

/**
 * Incremental analysis can recognize a substantive conversation once, then
 * omit later casual fragments from subsequent refreshes. Keep the model's
 * meaning and summary, but let ready local transcripts extend its time window
 * while speech remains uninterrupted. Never extend beyond the refresh boundary
 * or into the next model-recognized conversation.
 */
function extendConversationEndsThroughContinuousSpeech(
  dayStartedAt: number,
  conversations: ConversationSummary[],
  moments: DailyReviewMoment[],
  coveredThrough: number,
  blockedWindows: ConversationWindow[]
) {
  const intervals = moments
    .filter((moment) => moment.source !== 'revinote' && moment.status === 'ready' && moment.transcript.trim())
    .map((moment) => ({ startedAt: moment.startedAt, endedAt: moment.startedAt + moment.durationMs }))
    .sort((first, second) => first.startedAt - second.startedAt)

  return conversations.map((conversation, index) => {
    const conversationEnd = timestampForDayTime(dayStartedAt, conversation.endTime)
    const nextConversation = conversations[index + 1]
    const nextConversationStart = nextConversation
      ? timestampForDayTime(dayStartedAt, nextConversation.startTime)
      : Number.POSITIVE_INFINITY
    const nextBlockedStart = blockedWindows.reduce((earliest, window) => {
      const bounds = conversationBounds(dayStartedAt, window)
      if (bounds.endedAt <= conversationEnd) return earliest
      return Math.min(earliest, Math.max(conversationEnd, bounds.startedAt))
    }, Number.POSITIVE_INFINITY)
    const extensionLimit = Math.min(coveredThrough, nextConversationStart, nextBlockedStart)
    if (extensionLimit <= conversationEnd) return conversation

    let speechThrough: number | null = null
    for (const interval of intervals) {
      if (interval.startedAt >= extensionLimit) break
      const endedAt = Math.min(interval.endedAt, extensionLimit)

      if (speechThrough == null) {
        if (
          interval.startedAt <= conversationEnd + CONVERSATION_TIME_ROUNDING_TOLERANCE_MS &&
          endedAt >= conversationEnd - CONVERSATION_TIME_ROUNDING_TOLERANCE_MS
        ) {
          speechThrough = Math.max(conversationEnd, endedAt)
        }
        continue
      }

      if (interval.startedAt <= speechThrough + MAX_SPEECH_INTERVAL_GAP_MS) {
        speechThrough = Math.max(speechThrough, endedAt)
        continue
      }
      if (interval.startedAt > speechThrough + MAX_SPEECH_INTERVAL_GAP_MS) break
    }

    if (speechThrough == null || speechThrough <= conversationEnd) return conversation
    const endTime = timeForDayTimestamp(dayStartedAt, speechThrough)
    return timestampForDayTime(dayStartedAt, endTime) > conversationEnd ? { ...conversation, endTime } : conversation
  })
}

function conversationBounds(dayStartedAt: number, conversation: ConversationWindow) {
  return {
    startedAt: timestampForDayTime(dayStartedAt, conversation.startTime),
    endedAt: timestampForDayTime(dayStartedAt, conversation.endTime),
  }
}

function describesSameConversationWindow(
  dayStartedAt: number,
  previous: ConversationWindow,
  refreshed: ConversationWindow
) {
  const previousBounds = conversationBounds(dayStartedAt, previous)
  const refreshedBounds = conversationBounds(dayStartedAt, refreshed)
  return refreshedBounds.startedAt < previousBounds.endedAt && refreshedBounds.endedAt > previousBounds.startedAt
}

function isSubstantiallyRejected(dayStartedAt: number, conversation: ConversationWindow, rejected: ConversationWindow) {
  const existingBounds = conversationBounds(dayStartedAt, conversation)
  const rejectedBounds = conversationBounds(dayStartedAt, rejected)
  const overlap = Math.max(
    0,
    Math.min(existingBounds.endedAt, rejectedBounds.endedAt) -
      Math.max(existingBounds.startedAt, rejectedBounds.startedAt)
  )
  const conversationDuration = existingBounds.endedAt - existingBounds.startedAt
  return overlap >= Math.min(2 * 60_000, conversationDuration / 2)
}

function hasStableIdentity(conversation: Partial<ConversationSummary>) {
  return Boolean(conversation.episodeId || conversation.externalId || conversation.id)
}

export function matchesDeletedConversation(
  dayStartedAt: number,
  deleted: DeletedConversationReference,
  conversation: ConversationSummary
) {
  return hasStableIdentity(deleted)
    ? conversationsShareStableIdentity(deleted, conversation)
    : describesSameConversationWindow(dayStartedAt, deleted, conversation)
}

function preserveRevinoteProcessingState(previous: ConversationSummary[], conversation: ConversationSummary) {
  if (conversation.source === 'revinote' || !conversation.episodeId) return conversation
  const current = previous.find(
    (candidate) =>
      candidate.episodeId === conversation.episodeId &&
      (candidate.processingProvider === 'revinote' || candidate.processingError === 'revinote')
  )
  return current
    ? {
        ...conversation,
        ...(current.externalId ? { externalId: current.externalId } : {}),
        processing: current.processing,
        processingProvider: current.processingProvider,
        processingError: current.processingError,
      }
    : conversation
}

export function reconcileEpisodeConversationSummaries(
  dayStartedAt: number,
  previous: ConversationSummary[],
  generated: ConversationSummary[],
  deletedConversationWindows: DayMemory['deletedConversationWindows'] = []
) {
  const episodeSummaries = generated.filter((conversation) => conversation.episodeId)
  if (episodeSummaries.length === 0) return null
  const overlapsEpisode = (conversation: ConversationSummary) => {
    const startedAt = timestampForDayTime(dayStartedAt, conversation.startTime)
    const endedAt = timestampForDayTime(dayStartedAt, conversation.endTime)
    return episodeSummaries.some((episode) => {
      const episodeStartedAt = timestampForDayTime(dayStartedAt, episode.startTime)
      const episodeEndedAt = timestampForDayTime(dayStartedAt, episode.endTime)
      return startedAt < episodeEndedAt && endedAt > episodeStartedAt
    })
  }
  const retained = previous.filter(
    (conversation) =>
      conversation.source === 'revinote' ||
      ((conversation.processing || conversation.processingError) &&
        conversation.episodeId &&
        !episodeSummaries.some((summary) => summary.episodeId === conversation.episodeId)) ||
      (!conversation.episodeId && !overlapsEpisode(conversation))
  )
  return suppressLocalConversationsCoveredByRevinote(dayStartedAt, [
    ...retained,
    ...generated.map((conversation) => preserveRevinoteProcessingState(previous, conversation)),
  ])
    .filter(
      (conversation) =>
        !deletedConversationWindows.some((deleted) => matchesDeletedConversation(dayStartedAt, deleted, conversation))
    )
    .sort((first, second) => first.startTime.localeCompare(second.startTime))
}

/**
 * A living-day refresh is allowed to revise a recognized conversation, but a
 * later model response must not erase an earlier conversation merely by
 * omitting it. Raw audio remains in the Day, so unmatched previous summaries
 * stay visible until a refreshed summary for the same time window replaces
 * them.
 */
export function reconcileLivingConversations(
  dayStartedAt: number,
  previousConversations: ConversationSummary[],
  refreshedConversations: ConversationSummary[],
  moments: DailyReviewMoment[],
  deletedConversationWindows: DayMemory['deletedConversationWindows'] = [],
  coveredThrough = Number.POSITIVE_INFINITY,
  classifiedNonConversationWindows: DayMemory['classifiedNonConversationWindows'] = []
) {
  const refreshed = reconcileAdjacentConversations(
    dayStartedAt,
    refreshedConversations.map((conversation) => preserveRevinoteProcessingState(previousConversations, conversation)),
    moments,
    classifiedNonConversationWindows
  )
  const preserved = previousConversations.filter(
    (previous) =>
      !refreshed.some((conversation) =>
        (previous.processing || previous.processingError) && previous.episodeId
          ? conversationsShareStableIdentity(previous, conversation)
          : describesSameConversationWindow(dayStartedAt, previous, conversation)
      )
  )

  const visible = [...preserved, ...refreshed]
    .filter(
      (conversation) =>
        !deletedConversationWindows.some((deleted) =>
          matchesDeletedConversation(dayStartedAt, deleted, conversation)
        ) &&
        (Boolean(conversation.processing || conversation.processingError) ||
          !classifiedNonConversationWindows.some((rejected) =>
            isSubstantiallyRejected(dayStartedAt, conversation, rejected)
          ))
    )
    .sort(
      (first, second) =>
        timestampForDayTime(dayStartedAt, first.startTime) - timestampForDayTime(dayStartedAt, second.startTime)
    )

  return extendConversationEndsThroughContinuousSpeech(
    dayStartedAt,
    visible,
    moments,
    coveredThrough,
    classifiedNonConversationWindows
  )
}

export function deleteDayMemoryConversation(memory: DayMemory, reference: string): DayMemory {
  const conversation = resolveConversationReference(memory.conversations, reference)
  if (!conversation) return memory

  const deletedConversationWindows = memory.deletedConversationWindows ?? []
  const alreadyDeleted = deletedConversationWindows.some((candidate) =>
    hasStableIdentity(candidate)
      ? conversationsShareStableIdentity(candidate, conversation)
      : candidate.startTime === conversation.startTime && candidate.endTime === conversation.endTime
  )
  const deletedConversation: DeletedConversationReference = {
    startTime: conversation.startTime,
    endTime: conversation.endTime,
    ...(conversation.episodeId ? { episodeId: conversation.episodeId } : {}),
    ...(conversation.externalId ? { externalId: conversation.externalId } : {}),
    ...(conversation.id ? { id: conversation.id } : {}),
  }

  return {
    ...memory,
    conversations: memory.conversations.filter((candidate) => candidate !== conversation),
    deletedConversationWindows: alreadyDeleted
      ? deletedConversationWindows
      : [...deletedConversationWindows, deletedConversation],
  }
}
