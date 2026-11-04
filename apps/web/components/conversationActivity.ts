import type { AudioMoment, Day } from '@remember/shared'

export interface ConversationActivityItem {
  dayId: string
  moment: AudioMoment
  retained: boolean
}

export function conversationActivityItems(days: Day[]): ConversationActivityItem[] {
  return days
    .flatMap((day) => {
      const retained = new Set(day.retainedAudioMomentIds ?? [])
      return day.moments
        .filter(
          (moment) =>
            moment.source !== 'revinote' &&
            (moment.status !== 'empty' ||
              (moment.captureOutcome && moment.captureOutcome !== 'vad-empty' && moment.captureOutcome !== 'too-short'))
        )
        .map((moment) => ({ dayId: day.id, moment, retained: retained.has(moment.id) }))
    })
    .sort(
      (left, right) => right.moment.startedAt - left.moment.startedAt || left.moment.id.localeCompare(right.moment.id)
    )
}

export function toggleConversationActivitySelection(current: string[], momentId: string) {
  return current.includes(momentId) ? current.filter((id) => id !== momentId) : [...current, momentId]
}
