import type { CalendarBlock, ContextMoment, Day, TimelineEvidenceReference } from './index'

export type TimelineSource = {
  key: string
  kind: TimelineEvidenceReference['kind']
  time: number
  label: string
  detail: string
  text: string
}

function timestampForDayTime(dayStartedAt: number, time: string) {
  const [hours, minutes] = time.split(':').map(Number)
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null
  const timestamp = new Date(dayStartedAt)
  timestamp.setHours(hours === 24 ? 0 : hours, minutes, 0, 0)
  if (hours === 24) timestamp.setDate(timestamp.getDate() + 1)
  return timestamp.getTime()
}

export function timelineInterval(day: Pick<Day, 'startedAt'>, block: Pick<CalendarBlock, 'startTime' | 'endTime'>) {
  const startedAt = timestampForDayTime(day.startedAt, block.startTime)
  let endedAt = timestampForDayTime(day.startedAt, block.endTime)
  if (startedAt == null || endedAt == null) return null
  if (endedAt <= startedAt) endedAt += 24 * 60 * 60_000
  return { startedAt, endedAt }
}

/** Returns every local evidence record in the activity interval, not the sampled provenance stored on the block. */
export function timelineSources(day: Day, block: CalendarBlock): TimelineSource[] {
  const interval = timelineInterval(day, block)
  if (!interval) return []

  const context: TimelineSource[] = day.contextMoments
    .filter((moment): moment is ContextMoment => 'text' in moment)
    .filter((moment) => moment.timestamp >= interval.startedAt && moment.timestamp < interval.endedAt)
    .map((moment) => {
      const focused = moment.focusedElement
      return {
        key: `context:${moment.id}`,
        kind: 'context',
        time: moment.timestamp,
        label: moment.appName,
        detail: [moment.windowTitle, moment.url, focused?.title, focused?.description].filter(Boolean).join(' · '),
        text: [focused?.value, moment.text].filter(Boolean).join('\n').trim(),
      }
    })
  const audio: TimelineSource[] = day.moments
    .filter(
      (moment) =>
        moment.status === 'ready' &&
        Boolean(moment.transcript.trim()) &&
        moment.startedAt < interval.endedAt &&
        moment.startedAt + moment.durationMs > interval.startedAt
    )
    .map((moment) => ({
      key: `audio:${moment.id}`,
      kind: 'audio',
      time: moment.startedAt,
      label: moment.source === 'microphone' ? 'Microfoon' : 'Systeemaudio',
      detail: '',
      text: moment.transcript.trim(),
    }))
  const apps: TimelineSource[] = day.appActivity
    .filter(
      (activity) =>
        activity.startedAt < interval.endedAt &&
        (activity.endedAt ?? day.endedAt ?? Number.MAX_SAFE_INTEGER) > interval.startedAt
    )
    .map((activity) => ({
      key: `app:${activity.id}`,
      kind: 'app',
      time: activity.startedAt,
      label: activity.appName,
      detail: '',
      text: '',
    }))

  return [...context, ...audio, ...apps].sort(
    (first, second) => first.time - second.time || first.key.localeCompare(second.key)
  )
}
