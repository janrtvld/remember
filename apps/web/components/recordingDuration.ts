import type { ManualMeeting } from '@remember/shared'

export function recordingElapsedSeconds(
  meeting: Pick<ManualMeeting, 'startedAt' | 'endedAt' | 'pausedAt' | 'pausedMs'> | null,
  now: number,
  stopRequestedAt: number | null = null
) {
  if (!meeting) return 0
  const end = meeting.endedAt ?? meeting.pausedAt ?? stopRequestedAt ?? now
  return Math.max(0, Math.floor((end - meeting.startedAt - meeting.pausedMs) / 1000))
}
