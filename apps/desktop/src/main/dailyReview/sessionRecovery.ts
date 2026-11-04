import type { DailyReviewMoment, DailyReviewSession, SpeechSegment } from '@remember/shared'
import { resolvedAudioMoment } from './audioTranscription'

export function isAudioRecoveryCandidate(moment: DailyReviewMoment) {
  return (
    (moment.source === 'microphone' || moment.source === 'system') &&
    (moment.status === 'transcribing' || (moment.status === 'failed' && !moment.transcript.trim()))
  )
}

export function recoverInterruptedSession(
  session: DailyReviewSession,
  speechSegments: SpeechSegment[],
  now = Date.now()
): DailyReviewSession {
  const refreshing = session.refresh.status === 'refreshing'
  const moments = session.moments.map((moment) => {
    if (!isAudioRecoveryCandidate(moment)) return moment
    const resolved = resolvedAudioMoment(moment, speechSegments, true)
    return moment.status === 'transcribing' || resolved.status === 'ready' ? resolved : moment
  })
  const recoveredAudio = moments.some((moment, index) => moment !== session.moments[index])
  if (session.endedAt != null && !refreshing && !recoveredAudio) return session

  const latestEvidenceAt = Math.max(
    session.moments.reduce(
      (latest, moment) => Math.max(latest, moment.startedAt + moment.durationMs),
      session.startedAt
    ),
    session.contextMoments.reduce((latest, moment) => Math.max(latest, moment.timestamp), session.startedAt),
    session.appActivity.reduce(
      (latest, activity) => Math.max(latest, activity.endedAt ?? activity.startedAt),
      session.startedAt
    )
  )
  return {
    ...session,
    endedAt: session.endedAt ?? latestEvidenceAt,
    appActivity: session.appActivity.map((activity) =>
      activity.endedAt == null ? { ...activity, endedAt: session.endedAt ?? latestEvidenceAt } : activity
    ),
    moments,
    refresh: refreshing
      ? {
          ...session.refresh,
          status: 'failed',
          error: 'agent-interrupted',
          progress: null,
          run: session.refresh.run
            ? {
                ...session.refresh.run,
                completedAt: now,
                durationMs: Math.max(0, now - session.refresh.run.startedAt),
                status: 'failed',
                error: 'agent-interrupted',
              }
            : null,
        }
      : session.refresh,
  }
}
