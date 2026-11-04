import type { ConversationEpisode, ConversationSummary } from '@remember/shared'

const AUTOMATIC_REVINOTE_ERROR_CODES = new Set([
  'conversation-audio-not-found',
  'revinote-permission-required',
  'revinote-authentication-failed',
  'revinote-automatic-processing-unavailable',
  'revinote-minutes-required',
  'revinote-plan-required',
  'revinote-post-process-upload-failed',
  'revinote-post-process-response-invalid',
  'revinote-post-process-state-unknown',
])

export function automaticRevinoteFailureReport(
  error: unknown,
  input: { retryAutomatically: boolean; elapsedMs: number; interrupted: boolean }
) {
  if (input.interrupted) return null
  const message = error instanceof Error ? error.message : ''
  if (
    message === 'offline-mode-enabled' ||
    message === 'network-request-cancelled' ||
    // Disconnecting Revinote aborts its in-flight requests with this code.
    message === 'revinote-not-connected' ||
    (error instanceof Error && (error.name === 'AbortError' || ('code' in error && error.code === 'ABORT_ERR')))
  ) {
    return null
  }
  const code =
    message === 'network-request-timeout'
      ? 'revinote-post-process-timeout'
      : AUTOMATIC_REVINOTE_ERROR_CODES.has(message)
        ? message
        : 'revinote-post-process-failed'
  return {
    area: 'revinote-post-process',
    code,
    tags: {
      provider: 'revinote',
      phase: 'automatic',
      reason: input.retryAutomatically ? 'retryable' : 'terminal',
    },
    diagnostics: { elapsed_ms: Math.max(0, input.elapsedMs) },
  }
}

function revinotePlaceholder(conversation: ConversationSummary): ConversationSummary {
  return {
    ...conversation,
    processing: conversation.processingError ? undefined : 'processing',
    processingProvider: 'revinote',
  }
}

export function failedAutomaticRevinoteConversation(
  conversation: ConversationSummary,
  retryAutomatically: boolean
): ConversationSummary {
  return {
    ...conversation,
    processing: undefined,
    processingProvider: retryAutomatically ? 'revinote' : undefined,
    processingError: 'revinote',
  }
}

export function isTerminalAutomaticRevinoteError(error: unknown) {
  if (!(error instanceof Error)) return false
  return [
    'conversation-audio-not-found',
    'revinote-permission-required',
    'revinote-minutes-required',
    'revinote-plan-required',
    'revinote-post-process-state-unknown',
    'offline-mode-enabled',
  ].includes(error.message)
}

function isAutomaticRevinoteCandidateEpisode(episode: ConversationEpisode, manualMeetingId?: string) {
  return (
    episode.state === 'final' &&
    episode.deletedAt == null &&
    (episode.userDecision === 'confirmed' ||
      (manualMeetingId != null && episode.surfaceKey === `manual:${manualMeetingId}`)) &&
    !episode.automaticRevinoteProcessingBlocked
  )
}

export function preserveAutomaticRevinoteExclusions(
  episodes: ConversationEpisode[],
  previous: ConversationEpisode[],
  finalizedOfflineEpisodeIds: ReadonlySet<string> = new Set()
) {
  const previousById = new Map(previous.map((episode) => [episode.id, episode]))
  return episodes.map((episode) => {
    const previousEpisode = previousById.get(episode.id)
    return {
      ...episode,
      automaticRevinoteProcessingBlocked:
        episode.automaticRevinoteProcessingBlocked ||
        previousEpisode?.automaticRevinoteProcessingBlocked === true ||
        finalizedOfflineEpisodeIds.has(episode.id),
    }
  })
}

export function automaticRevinoteSummarySkipEpisodeIds(
  episodes: ConversationEpisode[],
  previousEpisodeIds: ReadonlySet<string>
) {
  return new Set(
    episodes
      .filter((episode) => isAutomaticRevinoteCandidateEpisode(episode) && !previousEpisodeIds.has(episode.id))
      .map((episode) => episode.id)
  )
}

export function routeNewFinishedConversationsToRevinote(input: {
  enabled: boolean
  previous: ConversationSummary[]
  generated: ConversationSummary[]
  episodes: ConversationEpisode[]
}) {
  const finalEpisodeIds = new Set(
    input.episodes.filter((episode) => isAutomaticRevinoteCandidateEpisode(episode)).map((episode) => episode.id)
  )
  const previousByEpisodeId = new Map(
    input.previous.flatMap((conversation) =>
      conversation.episodeId ? ([[conversation.episodeId, conversation]] as const) : []
    )
  )

  return input.generated.map((conversation) => {
    if (!conversation.episodeId || conversation.source === 'revinote' || !finalEpisodeIds.has(conversation.episodeId)) {
      return conversation
    }
    const previous = previousByEpisodeId.get(conversation.episodeId)
    if (previous?.processingError === 'revinote') {
      return {
        ...conversation,
        processing: undefined,
        processingProvider: previous.processingProvider,
        processingError: previous.processingError,
      }
    }
    if (previous?.processingProvider === 'revinote') {
      return revinotePlaceholder({ ...conversation, processingError: previous.processingError })
    }
    if (!input.enabled || previous) return conversation
    return revinotePlaceholder(conversation)
  })
}

export function automaticRevinoteCandidates(conversations: ConversationSummary[], episodes: ConversationEpisode[]) {
  const episodesById = new Map(episodes.map((episode) => [episode.id, episode]))
  return conversations.flatMap((conversation) => {
    if (
      !conversation.episodeId ||
      conversation.source === 'revinote' ||
      conversation.processingProvider !== 'revinote'
    ) {
      return []
    }
    const episode = episodesById.get(conversation.episodeId)
    return episode && isAutomaticRevinoteCandidateEpisode(episode, conversation.manualMeetingId)
      ? [{ conversation, episode }]
      : []
  })
}
