import type { DailyReviewSession } from '@remember/shared'

export function localDayKey(timestamp: number) {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function sessionLocalDay(session: Pick<DailyReviewSession, 'localDay' | 'startedAt'>) {
  return session.localDay ?? localDayKey(session.startedAt)
}

export function localDayStart(timestamp: number) {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

export function nextLocalDayBoundary(timestamp = Date.now()) {
  const boundary = new Date(timestamp)
  boundary.setHours(24, 0, 0, 0)
  return boundary.getTime()
}

export function canReuseForToday(session: DailyReviewSession, timestamp = Date.now()) {
  return sessionLocalDay(session) === localDayKey(timestamp) && session.endedAt != null
}

export function sessionForCaptureStart(
  sessions: DailyReviewSession[],
  activeSessionId: string | null,
  timestamp = Date.now()
) {
  if (activeSessionId) {
    const activeSession = sessions.find((session) => session.id === activeSessionId)
    if (activeSession) return activeSession
  }
  return sessions.find((session) => canReuseForToday(session, timestamp))
}
