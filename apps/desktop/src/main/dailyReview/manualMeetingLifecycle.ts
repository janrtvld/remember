import type {
  ConversationEpisode,
  ConversationRecordingSource,
  ConversationSummary,
  Day,
  DayMemory,
  ManualMeeting,
  SpeechSegment,
} from '@remember/shared'
import { manualMeetingTitle } from '@remember/shared'
import { matchesDeletedConversation } from './conversationReconciliation'

export { manualMeetingTitle } from '@remember/shared'

// Covers one 10-second helper attempt, its restart backoff, a second attempt, and startup margin.
export const MANUAL_MEETING_AUDIO_READY_TIMEOUT_MS = 25_000
const MANUAL_MEETING_MAX_PREROLL_MS = 60 * 60_000
const RECENT_SPEECH_WINDOW_MS = 90_000

export function manualMeetingAvailableFromAt({
  confirmedAt,
  episodes,
  audioWasRunning,
}: {
  confirmedAt: number
  episodes: ConversationEpisode[]
  audioWasRunning: boolean
}) {
  if (!audioWasRunning) return confirmedAt
  const recentEpisode = episodes
    .filter(
      (episode) =>
        episode.deletedAt == null &&
        episode.userDecision !== 'dismissed' &&
        episode.endedAt >= confirmedAt - RECENT_SPEECH_WINDOW_MS
    )
    .at(-1)
  if (!recentEpisode || recentEpisode.provider === 'manual') return confirmedAt
  return Math.max(recentEpisode.startedAt, confirmedAt - MANUAL_MEETING_MAX_PREROLL_MS)
}

export async function waitForManualMeetingAudioReadiness({
  ready,
  cancelled,
  now = Date.now,
  delay = (durationMs: number) => new Promise<void>((resolve) => setTimeout(resolve, durationMs)),
}: {
  ready: () => boolean
  cancelled: () => boolean
  now?: () => number
  delay?: (durationMs: number) => Promise<void>
}): Promise<'ready' | 'cancelled' | 'timed-out'> {
  const deadline = now() + MANUAL_MEETING_AUDIO_READY_TIMEOUT_MS
  while (true) {
    if (cancelled()) return 'cancelled'
    if (ready()) return 'ready'
    const remaining = deadline - now()
    if (remaining <= 0) return 'timed-out'
    await delay(Math.min(100, remaining))
  }
}

function clockTime(timestamp: number) {
  const date = new Date(timestamp)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function manualMeetingRecordingSource(
  meeting: ManualMeeting,
  episode?: ConversationEpisode,
  speechSegments: SpeechSegment[] = []
): ConversationRecordingSource {
  const endedAt = meeting.endedAt ?? meeting.startedAt
  const segmentIds = new Set(episode?.deletedAt == null && episode?.id === meeting.episodeId ? episode?.segmentIds : [])
  return {
    startedAt: meeting.startedAt,
    endedAt,
    segments: speechSegments
      .filter(
        (segment) =>
          segmentIds.has(segment.id) &&
          segment.workdayId === meeting.workdayId &&
          !segment.rejectionReason &&
          segment.text.trim() &&
          segment.startedAt >= meeting.startedAt &&
          segment.endedAt <= endedAt
      )
      .sort((first, second) => first.startedAt - second.startedAt || first.source.localeCompare(second.source))
      .map(({ id, source, startedAt, endedAt, text }) => ({ id, source, startedAt, endedAt, text })),
  }
}

export function manualMeetingForConversation(
  conversation: ConversationSummary,
  meetings: ManualMeeting[],
  episodes: ConversationEpisode[]
) {
  if (conversation.manualMeetingId) return meetings.find((meeting) => meeting.id === conversation.manualMeetingId)
  if (!conversation.episodeId) return undefined
  const episode = episodes.find((candidate) => candidate.id === conversation.episodeId && candidate.deletedAt == null)
  return meetings.find(
    (meeting) => meeting.episodeId === conversation.episodeId || episode?.surfaceKey === `manual:${meeting.id}`
  )
}

export function manualMeetingAudioStreamsReady(microphoneName: string | null, _systemAudioReady: boolean) {
  return Boolean(microphoneName)
}

export function manualMeetingAudioReadinessError(microphoneName: string | null, _systemAudioReady: boolean) {
  return microphoneName ? null : 'manual-meeting-microphone-not-ready'
}

export function manualMeetingStillProcessing(meetingId: string, persisted: ManualMeeting | undefined) {
  return persisted?.id === meetingId && persisted.status === 'processing'
}

export function selectManualMeetingProcessingProvider(input: {
  automaticRevinoteProcessing: boolean
  existing: ConversationSummary['processingProvider']
  offlineMode: boolean
  automaticRevinoteProcessingBlocked: boolean
}) {
  if (input.offlineMode || input.automaticRevinoteProcessingBlocked) return 'remember' as const
  return input.existing ?? (input.automaticRevinoteProcessing ? ('revinote' as const) : ('remember' as const))
}

export function preserveManualMeetingConversations(
  previous: ConversationSummary[],
  reconciled: ConversationSummary[]
): ConversationSummary[] {
  const retainedMeetingIds = new Set(
    reconciled.flatMap((conversation) => (conversation.manualMeetingId ? [conversation.manualMeetingId] : []))
  )
  return [
    ...reconciled,
    ...previous.filter(
      (conversation) => conversation.manualMeetingId && !retainedMeetingIds.has(conversation.manualMeetingId)
    ),
  ].sort((first, second) => first.startTime.localeCompare(second.startTime))
}

export function manualMeetingEpisode(
  meeting: ManualMeeting,
  episodes: ConversationEpisode[],
  automaticRevinoteProcessingBlocked = false,
  speechSegments: SpeechSegment[] = []
) {
  if (meeting.endedAt == null) throw new Error('manual-meeting-not-finished')
  const endedAt = meeting.endedAt
  const surfaceKey = `manual:${meeting.id}`
  const retainedSegmentIds = new Set(
    speechSegments
      .filter(
        (segment) =>
          segment.workdayId === meeting.workdayId &&
          !segment.rejectionReason &&
          segment.text.trim() &&
          segment.startedAt >= meeting.startedAt &&
          segment.endedAt <= endedAt
      )
      .map((segment) => segment.id)
  )
  const segmentIds = Array.from(
    new Set([
      ...retainedSegmentIds,
      ...episodes
        .filter(
          (episode) =>
            episode.workdayId === meeting.workdayId &&
            episode.deletedAt == null &&
            episode.startedAt < endedAt &&
            episode.endedAt > meeting.startedAt
        )
        .flatMap((episode) => episode.segmentIds)
        .filter((segmentId) => speechSegments.length === 0 || retainedSegmentIds.has(segmentId)),
    ])
  )
  return {
    id: `manual-meeting-${meeting.id}`,
    workdayId: meeting.workdayId,
    startedAt: meeting.startedAt,
    endedAt: Math.max(meeting.startedAt, endedAt),
    state: 'final' as const,
    surfaceKey,
    provider: 'manual',
    boundaryReason: 'call-ended' as const,
    segmentIds,
    deletedAt: null,
    automaticRevinoteProcessingBlocked:
      automaticRevinoteProcessingBlocked ||
      meeting.automaticRevinoteProcessingBlocked ||
      episodes.some(
        (episode) =>
          episode.surfaceKey === surfaceKey && episode.deletedAt == null && episode.automaticRevinoteProcessingBlocked
      ),
  }
}

export function memoryWithManualMeetingConversation(
  day: Day,
  meeting: ManualMeeting,
  processingProvider: NonNullable<ConversationSummary['processingProvider']> = 'remember',
  recordingSource = manualMeetingRecordingSource(meeting)
): DayMemory {
  if (meeting.endedAt == null) throw new Error('manual-meeting-not-finished')
  const memory = day.memory ?? emptyDayMemory(day)
  const conversation = conversationFromManualMeeting(meeting, processingProvider, recordingSource)
  if (
    memory.deletedConversationWindows?.some((deleted) =>
      matchesDeletedConversation(day.startedAt, deleted, conversation)
    )
  ) {
    return memory
  }
  const existingIndex = memory.conversations.findIndex(
    (candidate) =>
      candidate.manualMeetingId === meeting.id ||
      (meeting.episodeId != null && candidate.episodeId === meeting.episodeId)
  )
  const conversations =
    existingIndex >= 0
      ? memory.conversations.map((candidate, index) =>
          index === existingIndex
            ? {
                ...candidate,
                ...conversation,
                summary: candidate.summary,
                actionPoints: candidate.actionPoints,
                actionPointItems: candidate.actionPointItems,
              }
            : candidate
        )
      : [conversation, ...memory.conversations]
  return { ...memory, conversations }
}

export function memoryWithFinishedManualMeetingConversation(
  memory: DayMemory,
  meetingId: string,
  processingError?: ConversationSummary['processingError']
): DayMemory {
  return {
    ...memory,
    conversations: memory.conversations.map((conversation) =>
      conversation.manualMeetingId === meetingId
        ? {
            ...conversation,
            processing: undefined,
            processingProvider: undefined,
            processingError: processingError ?? conversation.processingError,
          }
        : conversation
    ),
  }
}

function conversationFromManualMeeting(
  meeting: ManualMeeting,
  processingProvider: NonNullable<ConversationSummary['processingProvider']>,
  recordingSource: ConversationRecordingSource
): ConversationSummary {
  return {
    ...(meeting.episodeId ? { episodeId: meeting.episodeId } : {}),
    startTime: clockTime(meeting.startedAt),
    endTime: clockTime(meeting.endedAt ?? meeting.startedAt),
    title: meeting.title.trim() || manualMeetingTitle(meeting.startedAt),
    description: meeting.notes,
    notes: meeting.notes,
    manualMeetingId: meeting.id,
    processing: 'processing',
    processingProvider,
    processingError: undefined,
    recordingSource,
  }
}

function emptyDayMemory(day: Day): DayMemory {
  return {
    summary: '',
    currentFocus: null,
    outcomes: [],
    decisions: [],
    openLoops: [],
    conversations: [],
    timeline: [],
    knowledgeSuggestions: [],
    refreshedAt: day.startedAt,
    coveredThrough: day.startedAt,
  }
}
