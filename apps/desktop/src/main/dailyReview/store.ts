import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DailyReviewSession } from '@remember/shared'
import { getEvidenceStore, temporaryCaptureDirectory } from './evidenceRepository'
import { isAudioRecoveryCandidate, recoverInterruptedSession } from './sessionRecovery'
import { hydrateTimelineItems } from './timelineItems'

export function readSessions() {
  return getEvidenceStore().readSessions().map(hydrateTimelineItems)
}

export function writeSessions(sessions: DailyReviewSession[]) {
  for (const session of sessions) getEvidenceStore().upsertSession(session)
}

export function writeSession(session: DailyReviewSession) {
  getEvidenceStore().upsertSession(session)
}

export function removeStoredSession(sessionId: string) {
  getEvidenceStore().deleteSession(sessionId)
}

export function saveAudioChunk(sessionId: string, momentId: string, wav: Buffer) {
  const target = join(audioDirectory(sessionId), `${momentId}.wav`)
  writeFileSync(target, wav)
  return target
}

export function audioDirectory(sessionId: string) {
  return temporaryCaptureDirectory(sessionId, 'audio')
}

export function contextDirectory(sessionId: string) {
  return temporaryCaptureDirectory(sessionId, 'context')
}

export function recoverInterruptedSessions(sessions: DailyReviewSession[]) {
  const recovered = sessions.map((session) => {
    const speechSegments = session.moments.some(isAudioRecoveryCandidate)
      ? getEvidenceStore().listSpeechSegments(session.id)
      : []
    return recoverInterruptedSession(session, speechSegments)
  })
  const store = getEvidenceStore()
  for (const [index, session] of recovered.entries()) {
    const original = sessions[index]
    if (session === original) continue
    store.upsertSession(session)
    for (const [momentIndex, moment] of session.moments.entries()) {
      if (moment !== original?.moments[momentIndex]) store.updateAudioMoment(session.id, moment.id, moment)
    }
    for (const activity of session.appActivity) {
      store.upsertAppActivity(session.id, activity)
    }
  }
  return recovered
}
