import {
  type AppActivity,
  type DayMemory,
  isMacosSystemActivity,
  redactSensitiveCaptureText,
  type WorkItem,
} from '@remember/shared'

export const USER_ACTIVITY_WINDOW_DAYS = 21
/** One or two Days describe those Days, not how someone usually works. */
const MINIMUM_OBSERVED_DAYS = 3
const MAXIMUM_SEGMENT_MS = 2 * 60 * 60_000
export const DAY_MS = 86_400_000

export interface UserActivityDay {
  localDay: string
  startedAt: number
  activeDurationMs: number
  appActivity: Pick<AppActivity, 'appName' | 'bundleId' | 'startedAt' | 'endedAt'>[]
  /** Null when the Day summary is absent or no longer permitted. */
  memory: Pick<DayMemory, 'projectAttention' | 'conversations'> | null
}

export interface UserActivityPatterns {
  basis: string
  observedDays: number
  from: string
  to: string
  usualStart: string | null
  usualEnd: string | null
  activeHoursPerDay: number
  recordedConversationsPerDay: number
  projects: { project: string; minutes: number; days: number }[]
  apps: { app: string; minutes: number; days: number }[]
  tasks: { completed: number; abandoned: number; open: number; recentlyAbandoned: string[] }
}

function median(values: number[]) {
  if (!values.length) return null
  const sorted = [...values].sort((first, second) => first - second)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? (sorted[middle] ?? null) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

function ranked(totals: Map<string, { minutes: number; days: Set<string> }>, limit: number) {
  return [...totals]
    .map(([name, { minutes, days }]) => ({ name, minutes: Math.round(minutes), days: days.size }))
    .filter((entry) => entry.minutes >= 10)
    .sort((first, second) => second.minutes - first.minutes || first.name.localeCompare(second.name))
    .slice(0, limit)
}

/**
 * Describe how the person has recently worked, using only counts and durations
 * Remember already recorded. Nothing here is model output, so it is recomputed
 * from whatever data still exists and cannot outlive a deletion.
 */
export function summarizeUserActivity(input: {
  days: UserActivityDay[]
  items: Pick<WorkItem, 'title' | 'lifecycle' | 'closedAt'>[]
  now: number
  timeZone: string
}): UserActivityPatterns | null {
  const since = input.now - USER_ACTIVITY_WINDOW_DAYS * DAY_MS
  const days = input.days
    .filter((day) => day.startedAt >= since && day.startedAt <= input.now && day.activeDurationMs > 0)
    .sort((first, second) => first.startedAt - second.startedAt)
  if (days.length < MINIMUM_OBSERVED_DAYS) return null

  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone: input.timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const minuteOfDay = (timestamp: number) => {
    const [hour, minute] = clock.format(timestamp).split(':').map(Number)
    return (hour ?? 0) * 60 + (minute ?? 0)
  }
  const clockText = (minutes: number | null) =>
    minutes === null
      ? null
      : `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(Math.round(minutes % 60)).padStart(2, '0')}`

  const starts: number[] = []
  const ends: number[] = []
  const apps = new Map<string, { minutes: number; days: Set<string> }>()
  const projects = new Map<string, { minutes: number; days: Set<string> }>()
  let conversations = 0
  let summarizedDays = 0
  for (const day of days) {
    const segments = day.appActivity.filter(
      (segment) => segment.endedAt !== null && segment.endedAt > segment.startedAt && !isMacosSystemActivity(segment)
    )
    const first = segments[0]
    const last = segments.at(-1)
    if (first && last?.endedAt) {
      starts.push(minuteOfDay(first.startedAt))
      ends.push(minuteOfDay(last.endedAt))
    }
    for (const segment of segments) {
      const name = segment.appName.trim()
      if (!name) continue
      const total = apps.get(name) ?? { minutes: 0, days: new Set<string>() }
      total.minutes += Math.min((segment.endedAt ?? segment.startedAt) - segment.startedAt, MAXIMUM_SEGMENT_MS) / 60_000
      total.days.add(day.localDay)
      apps.set(name, total)
    }
    if (!day.memory) continue
    summarizedDays += 1
    conversations += day.memory.conversations.length
    for (const attention of day.memory.projectAttention ?? []) {
      const name = attention.project.trim()
      if (!name || !(attention.durationMinutes > 0)) continue
      const total = projects.get(name) ?? { minutes: 0, days: new Set<string>() }
      total.minutes += attention.durationMinutes
      total.days.add(day.localDay)
      projects.set(name, total)
    }
  }

  const closed = input.items.filter((item) => item.closedAt !== null && item.closedAt >= since)
  const abandoned = closed
    .filter((item) => item.lifecycle === 'abandoned')
    .sort((first, second) => (second.closedAt ?? 0) - (first.closedAt ?? 0))
  const from = days[0]?.localDay ?? ''
  const to = days.at(-1)?.localDay ?? ''
  return {
    basis: `Computed by Remember from ${days.length} recorded days between ${from} and ${to}. Recording gaps make this incomplete.`,
    observedDays: days.length,
    from,
    to,
    usualStart: clockText(median(starts)),
    usualEnd: clockText(median(ends)),
    activeHoursPerDay:
      Math.round((days.reduce((sum, day) => sum + day.activeDurationMs, 0) / days.length / 3_600_000) * 10) / 10,
    recordedConversationsPerDay: summarizedDays ? Math.round((conversations / summarizedDays) * 10) / 10 : 0,
    projects: ranked(projects, 6).map(({ name, minutes, days: count }) => ({ project: name, minutes, days: count })),
    apps: ranked(apps, 6).map(({ name, minutes, days: count }) => ({ app: name, minutes, days: count })),
    tasks: {
      completed: closed.filter((item) => item.lifecycle === 'completed').length,
      abandoned: abandoned.length,
      open: input.items.filter((item) => item.lifecycle === 'open').length,
      recentlyAbandoned: abandoned.slice(0, 5).map((item) => redactSensitiveCaptureText(item.title).slice(0, 120)),
    },
  }
}
