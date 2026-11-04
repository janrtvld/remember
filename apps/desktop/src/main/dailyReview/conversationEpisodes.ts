import { createHash } from 'node:crypto'
import type {
  AudioMoment,
  CallSignal,
  ConversationEpisode,
  ConversationEpisodeBoundaryReason,
  SpeechSegment,
} from '@remember/shared'

const MAX_UNATTRIBUTED_SPEECH_GAP_MS = 90_000
const MAX_CALL_SPEECH_GAP_MS = 5 * 60_000
const CALL_OBSERVATION_FRESHNESS_MS = 5 * 60_000

export function audioCaptureGaps(moments: AudioMoment[]) {
  const windows = moments
    .filter((moment) => moment.source !== 'revinote' && moment.durationMs > 0)
    .map((moment) => ({ startedAt: moment.startedAt, endedAt: moment.startedAt + moment.durationMs }))
    .sort((first, second) => first.startedAt - second.startedAt)
  const gaps: Array<{ startedAt: number; endedAt: number }> = []
  let coveredThrough: number | null = null
  for (const window of windows) {
    if (coveredThrough != null && window.startedAt - coveredThrough > MAX_UNATTRIBUTED_SPEECH_GAP_MS) {
      gaps.push({ startedAt: coveredThrough, endedAt: window.startedAt })
    }
    coveredThrough = Math.max(coveredThrough ?? window.endedAt, window.endedAt)
  }
  return gaps
}

export function conversationEpisodeCompletedAt(
  episode: ConversationEpisode,
  signals: CallSignal[],
  observedThrough: number
) {
  if (episode.state !== 'final') return null
  if (episode.boundaryReason === 'speech-gap' || episode.boundaryReason === 'call-surface-changed') {
    return episode.endedAt
  }
  if (episode.boundaryReason === 'call-ended' && episode.surfaceKey) {
    return (
      signals.find(
        (signal) =>
          signal.surfaceKey === episode.surfaceKey &&
          signal.state === 'ended' &&
          signal.observedAt >= episode.endedAt &&
          signal.observedAt <= observedThrough
      )?.observedAt ?? episode.endedAt
    )
  }
  return observedThrough
}

function episodeId(workdayId: string, firstSegmentId: string, surfaceKey: string | null) {
  return `episode-${createHash('sha256')
    .update(`${workdayId}\u0000${firstSegmentId}\u0000${surfaceKey ?? 'in-person'}`)
    .digest('hex')
    .slice(0, 24)}`
}

type ActiveSurface = Pick<CallSignal, 'provider' | 'surfaceKey'> & {
  activationId: string
  observedAt: number
}

function surfaceAt(signals: CallSignal[], timestamp: number) {
  const active = new Map<string, ActiveSurface>()
  for (const signal of signals) {
    if (signal.observedAt > timestamp) break
    if (signal.state === 'active') {
      const existing = active.get(signal.surfaceKey)
      active.set(signal.surfaceKey, {
        provider: signal.provider,
        surfaceKey: signal.surfaceKey,
        activationId: existing?.activationId ?? signal.id,
        observedAt: signal.observedAt,
      })
    } else {
      active.delete(signal.surfaceKey)
    }
  }
  return [...active.values()].sort((first, second) => second.observedAt - first.observedAt)[0] ?? null
}

function surfaceEndedAt(signals: CallSignal[], surfaceKey: string, after: number) {
  return signals.find(
    (signal) => signal.surfaceKey === surfaceKey && signal.state === 'ended' && signal.observedAt >= after
  )?.observedAt
}

type MutableEpisode = ConversationEpisode & { lastSpeechAt: number; surfaceActivationId: string | null }

export function deriveConversationEpisodes(input: {
  workdayId: string
  segments: SpeechSegment[]
  moments?: AudioMoment[]
  signals: CallSignal[]
  existing?: ConversationEpisode[]
  coveredThrough: number
  finalizeAll?: boolean
  finalBoundaryReason?: Extract<ConversationEpisodeBoundaryReason, 'capture-paused' | 'day-ended'>
}) {
  const finalEpisodes = (input.existing ?? [])
    .filter((episode) => episode.state === 'final')
    .sort((first, second) => first.startedAt - second.startedAt)
  const lockedSegmentIds = new Set(finalEpisodes.flatMap((episode) => episode.segmentIds))
  const segments = input.segments
    .filter(
      (segment) =>
        !segment.rejectionReason &&
        segment.text.trim() &&
        !lockedSegmentIds.has(segment.id) &&
        segment.endedAt <= input.coveredThrough
    )
    .sort((first, second) => first.startedAt - second.startedAt)
  const signals = [...input.signals].sort((first, second) => first.observedAt - second.observedAt)
  const captureGaps = audioCaptureGaps(input.moments ?? [])
  const built: MutableEpisode[] = []

  for (const segment of segments) {
    const current = built.at(-1)
    const observedSurface = surfaceAt(signals, segment.startedAt)
    const speechGap = current ? segment.startedAt - current.lastSpeechAt : 0
    const surface =
      observedSurface &&
      (segment.startedAt - observedSurface.observedAt <= CALL_OBSERVATION_FRESHNESS_MS ||
        (current?.surfaceKey === observedSurface.surfaceKey && speechGap <= MAX_CALL_SPEECH_GAP_MS))
        ? observedSurface
        : null
    if (
      current &&
      !current.surfaceKey &&
      surface &&
      segment.startedAt - current.lastSpeechAt <= MAX_UNATTRIBUTED_SPEECH_GAP_MS
    ) {
      current.surfaceKey = surface.surfaceKey
      current.provider = surface.provider
      current.surfaceActivationId = surface.activationId
    }
    const changedSurface = current && current.surfaceKey !== (surface?.surfaceKey ?? null)
    const changedActivation =
      current &&
      current.surfaceKey === (surface?.surfaceKey ?? null) &&
      current.surfaceActivationId !== (surface?.activationId ?? null)
    const sustainedSpeechGap =
      current && speechGap > (current.surfaceKey ? MAX_CALL_SPEECH_GAP_MS : MAX_UNATTRIBUTED_SPEECH_GAP_MS)
    const captureGap =
      current && captureGaps.some((gap) => gap.startedAt >= current.lastSpeechAt && gap.endedAt <= segment.startedAt)
    const callEndedAt = current?.surfaceKey ? surfaceEndedAt(signals, current.surfaceKey, current.lastSpeechAt) : null
    const callEnded = callEndedAt != null && callEndedAt <= segment.startedAt
    const changedSurfaceAfterSpeechGap =
      current && changedSurface && segment.startedAt - current.lastSpeechAt > MAX_UNATTRIBUTED_SPEECH_GAP_MS
    if (
      !current ||
      changedSurfaceAfterSpeechGap ||
      changedActivation ||
      sustainedSpeechGap ||
      captureGap ||
      callEnded
    ) {
      if (current) {
        current.state = 'final'
        current.boundaryReason = captureGap
          ? 'capture-paused'
          : callEnded || changedActivation
            ? 'call-ended'
            : changedSurfaceAfterSpeechGap && surface
              ? 'call-surface-changed'
              : 'speech-gap'
      }
      built.push({
        id: episodeId(input.workdayId, segment.id, surface?.surfaceKey ?? null),
        workdayId: input.workdayId,
        startedAt: segment.startedAt,
        endedAt: segment.endedAt,
        state: 'provisional',
        surfaceKey: surface?.surfaceKey ?? null,
        provider: surface?.provider ?? null,
        boundaryReason: 'open',
        segmentIds: [segment.id],
        deletedAt: null,
        automaticRevinoteProcessingBlocked: false,
        lastSpeechAt: segment.endedAt,
        surfaceActivationId: surface?.activationId ?? null,
      })
      continue
    }
    current.endedAt = Math.max(current.endedAt, segment.endedAt)
    current.lastSpeechAt = Math.max(current.lastSpeechAt, segment.endedAt)
    current.segmentIds.push(segment.id)
  }

  const last = built.at(-1)
  if (last) {
    const endedAt = last.surfaceKey ? surfaceEndedAt(signals, last.surfaceKey, last.lastSpeechAt) : null
    const shouldFinalize =
      input.finalizeAll ||
      (endedAt != null && endedAt <= input.coveredThrough) ||
      input.coveredThrough - last.lastSpeechAt >=
        (last.surfaceKey ? MAX_CALL_SPEECH_GAP_MS : MAX_UNATTRIBUTED_SPEECH_GAP_MS)
    if (shouldFinalize) {
      last.state = 'final'
      last.boundaryReason = input.finalizeAll
        ? (input.finalBoundaryReason ?? 'day-ended')
        : endedAt != null
          ? 'call-ended'
          : 'speech-gap'
    }
  }

  return [
    ...finalEpisodes,
    ...built.map(({ lastSpeechAt: _lastSpeechAt, surfaceActivationId: _surfaceActivationId, ...episode }) => episode),
  ].sort((first, second) => first.startedAt - second.startedAt)
}
