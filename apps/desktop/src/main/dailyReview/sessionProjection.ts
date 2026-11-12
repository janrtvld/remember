import { existsSync } from 'node:fs'
import type { ConversationEpisode, DailyReviewSession, DayMemory } from '@remember/shared'
import { conversationAudioChunkPathAt, conversationAudioPathAt } from './conversationAudio'
import type { EvidenceStore } from './evidenceStore'

export const CONVERSATION_RECOVERY_RETENTION_MS = 24 * 60 * 60_000

// Analysis provenance lists every source a Day's analysis read. It runs to megabytes per Day and only the main
// process uses it, so the renderer's copy of a memory leaves it out. The copy is kept per memory object because Day
// changes are detected by identity.
const rendererMemories = new WeakMap<DayMemory, DayMemory>()

function rendererMemory(memory: DayMemory | null) {
  if (!memory?.analysisProvenance) return memory
  let projected = rendererMemories.get(memory)
  if (!projected) {
    const { analysisProvenance: _provenance, ...visible } = memory
    projected = visible
    rendererMemories.set(memory, projected)
  }
  return projected
}

export function projectDailyReviewSessions(
  sessions: DailyReviewSession[],
  store: Pick<EvidenceStore, 'listConversationEpisodes' | 'listSpeechSegments' | 'listEpisodeAnalyses'>,
  directory: string,
  now = Date.now()
): DailyReviewSession[] {
  return sessions.map((session) => {
    const episodes = store.listConversationEpisodes(session.id, {
      recoverableAfter: now - CONVERSATION_RECOVERY_RETENTION_MS,
    })
    const recognizedEpisodeIds = new Set(
      (session.memory?.conversations ?? []).flatMap((conversation) =>
        conversation.episodeId ? [conversation.episodeId] : []
      )
    )
    const unresolvedEpisodes = episodes.filter(
      (episode) => episode.deletedAt == null && !recognizedEpisodeIds.has(episode.id)
    )
    const recoverableEpisodes = unresolvedEpisodes.filter(
      (episode) =>
        episode.state === 'final' &&
        episode.userDecision !== 'confirmed' &&
        episode.endedAt + CONVERSATION_RECOVERY_RETENTION_MS > now
    )
    // Historic sessions and active calls need no transcript hydration for their list projection.
    const segments = recoverableEpisodes.length ? store.listSpeechSegments(session.id) : []
    const segmentsById = new Map(segments.map((segment) => [segment.id, segment]))
    const latestAnalysisByEpisodeId = new Map(
      (recoverableEpisodes.length ? store.listEpisodeAnalyses(session.id) : [])
        .sort((first, second) => first.generatedAt - second.generatedAt)
        .map((analysis) => [analysis.episodeId, analysis])
    )
    const previewFor = (episode: ConversationEpisode) =>
      episode.segmentIds
        .flatMap((segmentId) => {
          const text = segmentsById.get(segmentId)?.text.trim()
          return text ? [text] : []
        })
        .join(' ')
        .slice(0, 180)
    const hasRecoverableAudio = (episode: ConversationEpisode) => {
      if (existsSync(conversationAudioPathAt(directory, episode))) return true
      const chunkIds = [
        ...new Set(
          episode.segmentIds.flatMap((segmentId) => {
            const segment = segmentsById.get(segmentId)
            return segment ? (segment.chunkIds ?? [segment.chunkId]) : []
          })
        ),
      ]
      return (
        chunkIds.length > 0 &&
        chunkIds.every((chunkId) => existsSync(conversationAudioChunkPathAt(directory, session.id, chunkId)))
      )
    }

    const ongoingConversations = unresolvedEpisodes.flatMap((episode) =>
      episode.state === 'provisional' &&
      episode.userDecision !== 'dismissed' &&
      episode.surfaceKey &&
      episode.provider !== 'manual'
        ? [
            {
              episodeId: episode.id,
              startedAt: episode.startedAt,
              lastSpeechAt: episode.endedAt,
              provider: episode.provider ?? 'call',
              surfaceKey: episode.surfaceKey,
            },
          ]
        : []
    )
    const recoverable = recoverableEpisodes.filter(hasRecoverableAudio)
    const conversationCandidates = recoverable.flatMap((episode) => {
      if (episode.userDecision === 'dismissed') return []
      const analysis = latestAnalysisByEpisodeId.get(episode.id)
      if (!analysis) return []
      const durationMs = episode.endedAt - episode.startedAt
      const plausibleConversation =
        (analysis.classification === 'conversation' && (analysis.confidence !== 'low' || durationMs >= 5 * 60_000)) ||
        (analysis.classification !== 'media' && durationMs >= 20 * 60_000)
      if (!plausibleConversation) return []
      return [
        {
          episodeId: episode.id,
          startedAt: episode.startedAt,
          endedAt: episode.endedAt,
          provider: episode.provider,
          confidence: analysis.confidence,
          title: analysis.title,
          description: analysis.description,
          preview: previewFor(episode),
          expiresAt: episode.endedAt + CONVERSATION_RECOVERY_RETENTION_MS,
        },
      ]
    })
    const recoverableConversationBlocks = recoverable.map((episode) => {
      const momentIds = [
        ...new Set(
          episode.segmentIds.flatMap((segmentId) => {
            const segment = segmentsById.get(segmentId)
            return segment ? (segment.chunkIds ?? [segment.chunkId]) : []
          })
        ),
      ]
      const sources = [
        ...new Set(
          episode.segmentIds.flatMap((segmentId) => {
            const source = segmentsById.get(segmentId)?.source
            return source ? [source] : []
          })
        ),
      ]
      return {
        episodeId: episode.id,
        startedAt: episode.startedAt,
        endedAt: episode.endedAt,
        provider: episode.provider,
        source: sources.length === 1 ? (sources[0] as 'microphone' | 'system') : ('mixed' as const),
        preview: previewFor(episode),
        momentIds,
      }
    })
    return {
      ...session,
      memory: rendererMemory(session.memory),
      ongoingConversations,
      conversationCandidates,
      recoverableConversationBlocks,
      retainedAudioMomentIds: session.moments
        .filter(
          (moment) =>
            moment.source !== 'revinote' &&
            moment.startedAt + moment.durationMs + CONVERSATION_RECOVERY_RETENTION_MS > now &&
            existsSync(conversationAudioChunkPathAt(directory, session.id, moment.id))
        )
        .map((moment) => moment.id),
    }
  })
}
