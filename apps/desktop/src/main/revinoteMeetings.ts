import { isDeepStrictEqual } from 'node:util'
import {
  type ConversationSummary,
  conversationsShareStableIdentity,
  type DailyReviewMoment,
  type DailyReviewSession,
  type DayMemory,
} from '@remember/shared'
import { localDayKey, sessionLocalDay } from './dailyReview/dayLifecycle'
import type { ImportedRevinoteMeeting } from './revinoteIntegration'

const LONG_IMPORTED_MEETING_MS = 10 * 60_000
const MAX_FRAGMENT_CHAIN_EXTENSION_MS = 15 * 60_000
const CONVERSATION_ROUNDING_TOLERANCE_MS = 60_000

export type RevinoteSourceWindow = {
  workdayId?: string
  startedAt: number
  endedAt: number
  episodeId?: string
  settledAt?: number
}

function localDayStart(timestamp: number) {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function timeForTimestamp(timestamp: number) {
  const date = new Date(timestamp)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function timestampForTime(dayStartedAt: number, time: string) {
  const [hours, minutes] = time.split(':').map(Number)
  const timestamp = new Date(dayStartedAt)
  timestamp.setHours(hours === 24 ? 0 : hours, minutes, 0, 0)
  if (hours === 24) timestamp.setDate(timestamp.getDate() + 1)
  return timestamp.getTime()
}

function substantiallyOverlaps(
  dayStartedAt: number,
  conversation: Pick<ConversationSummary, 'startTime' | 'endTime'>,
  imported: Pick<ConversationSummary, 'startTime' | 'endTime'>
) {
  const conversationStartedAt = timestampForTime(dayStartedAt, conversation.startTime)
  const conversationEndedAt = timestampForTime(dayStartedAt, conversation.endTime)
  const importedStartedAt = timestampForTime(dayStartedAt, imported.startTime)
  const importedEndedAt = timestampForTime(dayStartedAt, imported.endTime)
  const overlap = Math.max(
    0,
    Math.min(conversationEndedAt, importedEndedAt) - Math.max(conversationStartedAt, importedStartedAt)
  )
  const duration = conversationEndedAt - conversationStartedAt
  return duration > 0 && overlap >= Math.min(2 * 60_000, duration / 2)
}

/** Revinote supplies the canonical record for a recorded meeting. */
export function suppressLocalConversationsCoveredByRevinote(
  dayStartedAt: number,
  conversations: ConversationSummary[]
) {
  const imported = conversations.filter((conversation) => conversation.source === 'revinote')
  if (imported.length === 0) return conversations
  const local = conversations.filter((conversation) => conversation.source !== 'revinote')
  const suppressed = new Set<ConversationSummary>()

  for (const canonical of imported) {
    const canonicalStartedAt = timestampForTime(dayStartedAt, canonical.startTime)
    const canonicalEndedAt = timestampForTime(dayStartedAt, canonical.endTime)
    const mayAbsorbRoundedFragments = canonicalEndedAt - canonicalStartedAt >= LONG_IMPORTED_MEETING_MS
    let coveredStartedAt = canonicalStartedAt
    let coveredEndedAt = canonicalEndedAt
    let changed = true

    while (changed) {
      changed = false
      for (const conversation of local) {
        if (suppressed.has(conversation)) continue
        if (canonical.episodeId && conversation.episodeId && !conversationsShareStableIdentity(canonical, conversation))
          continue
        const startedAt = timestampForTime(dayStartedAt, conversation.startTime)
        const endedAt = timestampForTime(dayStartedAt, conversation.endTime)
        const withinExtension =
          endedAt >= canonicalStartedAt - MAX_FRAGMENT_CHAIN_EXTENSION_MS &&
          startedAt <= canonicalEndedAt + MAX_FRAGMENT_CHAIN_EXTENSION_MS
        const joinsCoveredCluster =
          mayAbsorbRoundedFragments &&
          withinExtension &&
          startedAt <= coveredEndedAt + CONVERSATION_ROUNDING_TOLERANCE_MS &&
          endedAt >= coveredStartedAt - CONVERSATION_ROUNDING_TOLERANCE_MS
        if (!substantiallyOverlaps(dayStartedAt, conversation, canonical) && !joinsCoveredCluster) continue

        suppressed.add(conversation)
        coveredStartedAt = Math.min(coveredStartedAt, startedAt)
        coveredEndedAt = Math.max(coveredEndedAt, endedAt)
        changed = true
      }
    }
  }

  return conversations.filter((conversation) => !suppressed.has(conversation))
}

function blankMemory(coveredThrough: number): DayMemory {
  return {
    summary: '',
    currentFocus: null,
    outcomes: [],
    decisions: [],
    openLoops: [],
    projectAttention: [],
    conversations: [],
    classifiedNonConversationWindows: [],
    deletedConversationWindows: [],
    timeline: [],
    timelineOverrides: [],
    hiddenTimelineItemIds: [],
    knowledgeSuggestions: [],
    refreshedAt: coveredThrough,
    coveredThrough,
  }
}

function descriptionFor(meeting: ImportedRevinoteMeeting) {
  const summary = meeting.summary?.trim().replace(/\s+/g, ' ')
  if (summary) return summary.length > 180 ? `${summary.slice(0, 177).trimEnd()}…` : summary
  if (meeting.participants.length) return `Gesprek met ${meeting.participants.join(', ')}`
  return 'Opgenomen met Revinote'
}

function sourceWindow(meeting: ImportedRevinoteMeeting, knownSourceWindow?: RevinoteSourceWindow) {
  if (knownSourceWindow) return knownSourceWindow
  const endedAt = Date.parse(meeting.date)
  const durationMs = Math.max(60_000, Math.round((meeting.durationSeconds ?? 60) * 1_000))
  return { startedAt: Math.max(localDayStart(endedAt), endedAt - durationMs), endedAt }
}

function nextAvailableWindow(
  dayStartedAt: number,
  preferred: { startedAt: number; endedAt: number },
  usedStartTimes: Set<string>,
  existing?: ConversationSummary,
  existingMoment?: DailyReviewMoment
) {
  if (existing) {
    usedStartTimes.add(existing.startTime)
    return {
      startedAt: existingMoment?.startedAt ?? timestampForTime(dayStartedAt, existing.startTime),
      endedAt: existingMoment
        ? existingMoment.startedAt + existingMoment.durationMs
        : timestampForTime(dayStartedAt, existing.endTime),
      startTime: existing.startTime,
      endTime: existing.endTime,
    }
  }

  const durationMs = Math.max(60_000, preferred.endedAt - preferred.startedAt)
  let startedAt = preferred.startedAt
  let startTime = timeForTimestamp(startedAt)
  while (usedStartTimes.has(startTime) && startedAt < localDayStart(preferred.startedAt) + 24 * 60 * 60_000 - 60_000) {
    startedAt += 60_000
    startTime = timeForTimestamp(startedAt)
  }
  usedStartTimes.add(startTime)
  const endedAt = Math.min(localDayStart(startedAt) + 24 * 60 * 60_000, startedAt + durationMs)
  return {
    startedAt,
    endedAt,
    startTime,
    endTime: endedAt === localDayStart(startedAt) + 24 * 60 * 60_000 ? '24:00' : timeForTimestamp(endedAt),
  }
}

function createSyntheticSession(dayKey: string, startedAt: number): DailyReviewSession {
  return {
    id: `revinote:${dayKey}`,
    localDay: dayKey,
    startedAt: localDayStart(startedAt),
    endedAt: startedAt,
    activeDurationMs: 0,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory: blankMemory(startedAt),
    refresh: {
      status: 'idle',
      reason: null,
      targetThrough: null,
      error: null,
      progress: null,
      run: null,
    },
  }
}

/** Merge Revinote's processed meeting records into Remember's local Day model. */
export function mergeRevinoteMeetings(
  inputSessions: DailyReviewSession[],
  meetings: ImportedRevinoteMeeting[],
  knownSourceWindows: ReadonlyMap<string, RevinoteSourceWindow> = new Map()
): DailyReviewSession[] {
  const importedIds = new Set(meetings.map((meeting) => meeting.id))
  inputSessions = inputSessions.map((session) => {
    let memory = session.memory
    if (!memory) return session
    for (const [externalId, window] of knownSourceWindows) {
      // A completed remote record disappearing must not revive its original recording.
      // Pending uploads have no imported record yet and must remain visible locally.
      if (
        window.workdayId !== session.id ||
        !window.episodeId ||
        window.settledAt == null ||
        importedIds.has(externalId)
      )
        continue
      const removed = {
        episodeId: window.episodeId,
        externalId,
        startTime: timeForTimestamp(window.startedAt),
        endTime: timeForTimestamp(window.endedAt),
      }
      if (!memory.deletedConversationWindows?.some((deleted) => conversationsShareStableIdentity(deleted, removed))) {
        memory = { ...memory, deletedConversationWindows: [...(memory.deletedConversationWindows ?? []), removed] }
      }
    }
    const conversations = memory.conversations.filter(
      (conversation) =>
        !memory.deletedConversationWindows?.some((deleted) =>
          deleted.episodeId || deleted.externalId || deleted.id
            ? conversationsShareStableIdentity(deleted, conversation)
            : deleted.startTime === conversation.startTime && deleted.endTime === conversation.endTime
        )
    )
    if (memory === session.memory && conversations.length === memory.conversations.length) return session
    return { ...session, memory: { ...memory, conversations } }
  })
  const previousImported = new Map(
    inputSessions.flatMap((session) =>
      (session.memory?.conversations ?? []).flatMap((conversation) =>
        conversation.source === 'revinote' && conversation.externalId
          ? [
              [
                conversation.externalId,
                {
                  conversation,
                  sessionId: session.id,
                  moment: session.moments.find((moment) => moment.id === `revinote:${conversation.externalId}`),
                },
              ] as const,
            ]
          : []
      )
    )
  )
  const previousDays = new Map(
    inputSessions.flatMap((session) =>
      [...(session.memory?.conversations ?? []), ...(session.memory?.deletedConversationWindows ?? [])].flatMap(
        (conversation) => (conversation.externalId ? [[conversation.externalId, session.id] as const] : [])
      )
    )
  )
  const sessions = inputSessions.map((session) => ({
    ...session,
    moments: session.moments.filter((moment) => moment.source !== 'revinote'),
    ...(session.memory
      ? {
          memory: {
            ...session.memory,
            conversations: session.memory.conversations.filter((conversation) => conversation.source !== 'revinote'),
          },
        }
      : {}),
  }))

  for (const meeting of meetings) {
    const knownSourceWindow = knownSourceWindows.get(meeting.id)
    const preferredWindow = sourceWindow(meeting, knownSourceWindow)
    const dayKey = localDayKey(preferredWindow.startedAt)
    const previous = previousImported.get(meeting.id)
    const workdayId = knownSourceWindow?.workdayId ?? (!knownSourceWindow ? previousDays.get(meeting.id) : undefined)
    let index = workdayId ? sessions.findIndex((session) => session.id === workdayId) : -1
    if (index < 0) index = sessions.findIndex((session) => sessionLocalDay(session) === dayKey)
    if (index < 0) {
      sessions.push(createSyntheticSession(dayKey, preferredWindow.endedAt))
      index = sessions.length - 1
    }

    const session = sessions[index]
    if (!session) continue
    const memory = session.memory ?? blankMemory(preferredWindow.endedAt)
    const existing = previous?.sessionId === session.id ? previous.conversation : undefined
    const usedStartTimes = new Set(
      memory.conversations
        .filter((conversation) => conversation.externalId !== meeting.id)
        .map((conversation) => conversation.startTime)
    )
    const window = nextAvailableWindow(
      session.startedAt,
      preferredWindow,
      usedStartTimes,
      knownSourceWindow ? undefined : existing,
      knownSourceWindow ? undefined : previous?.moment
    )
    const actionPointItems = meeting.actionItems.flatMap((item, actionIndex) => {
      const text = item.label.trim()
      return text ? [{ id: `revinote:${meeting.id}:action:${actionIndex}`, text, completed: item.done }] : []
    })
    const actionPoints = actionPointItems.map((item) => item.text)
    const sourceEpisodeId = knownSourceWindow?.episodeId ?? existing?.episodeId
    const sourceConversation = sourceEpisodeId
      ? memory.conversations.find((candidate) => candidate.episodeId === sourceEpisodeId)
      : undefined
    const manualMeetingId =
      sourceConversation?.manualMeetingId ??
      (existing?.episodeId === sourceEpisodeId ? existing?.manualMeetingId : undefined)
    const notes = sourceConversation?.notes ?? existing?.notes
    const recordingSource = sourceConversation?.recordingSource ?? existing?.recordingSource
    const conversation: ConversationSummary = {
      ...(sourceEpisodeId ? { episodeId: sourceEpisodeId } : {}),
      ...(manualMeetingId ? { manualMeetingId } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(recordingSource ? { recordingSource } : {}),
      startTime: window.startTime,
      endTime: window.endTime,
      title: meeting.title?.trim() || 'Revinote-gesprek',
      description: descriptionFor(meeting),
      summary: meeting.summary?.trim() || descriptionFor(meeting),
      actionPoints,
      actionPointItems,
      ...(meeting.participants.length === 1 ? { otherParticipantName: meeting.participants[0] } : {}),
      source: 'revinote',
      externalId: meeting.id,
    }
    const deletedConversationWindows = memory.deletedConversationWindows?.map((candidate) =>
      knownSourceWindow?.episodeId === candidate.episodeId && candidate.externalId !== meeting.id
        ? { ...candidate, externalId: meeting.id }
        : candidate
    )
    const deleted = deletedConversationWindows?.some((candidate) =>
      candidate.episodeId || candidate.externalId || candidate.id
        ? conversationsShareStableIdentity(candidate, conversation)
        : candidate.startTime === conversation.startTime && candidate.endTime === conversation.endTime
    )
    const conversations = deleted
      ? memory.conversations.filter((candidate) => candidate.externalId !== meeting.id)
      : suppressLocalConversationsCoveredByRevinote(session.startedAt, [
          ...memory.conversations.filter((candidate) => candidate.externalId !== meeting.id),
          conversation,
        ]).sort((first, second) => first.startTime.localeCompare(second.startTime))
    const transcript = meeting.transcript?.trim()
    const moments =
      transcript && !deleted
        ? [
            ...session.moments,
            {
              id: `revinote:${meeting.id}`,
              sessionId: session.id,
              source: 'revinote' as const,
              startedAt: window.startedAt,
              durationMs: Math.max(60_000, window.endedAt - window.startedAt),
              status: 'ready' as const,
              transcript,
            },
          ]
        : session.moments
    sessions[index] = {
      ...session,
      endedAt: session.endedAt == null ? null : Math.max(session.endedAt, window.endedAt),
      moments,
      memory: {
        ...memory,
        ...(deletedConversationWindows ? { deletedConversationWindows } : {}),
        conversations,
        coveredThrough: Math.max(memory.coveredThrough, window.endedAt),
        refreshedAt: Math.max(memory.refreshedAt, Date.parse(meeting.updatedAt)),
      },
    }
  }

  const originalById = new Map(inputSessions.map((session) => [session.id, session]))
  return sessions
    .filter(
      (session) =>
        !session.id.startsWith('revinote:') ||
        (session.memory?.conversations.length ?? 0) > 0 ||
        (session.memory?.deletedConversationWindows?.length ?? 0) > 0 ||
        session.moments.length > 0
    )
    .sort((first, second) => second.startedAt - first.startedAt)
    .map((session) => {
      const original = originalById.get(session.id)
      return original && isDeepStrictEqual(original, session) ? original : session
    })
}
