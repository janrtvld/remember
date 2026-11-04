export type CaptureWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

export interface CaptureSchedule {
  enabled: boolean
  weekdays: CaptureWeekday[]
  startTime: string
  endTime: string
}

export interface CaptureScheduleStatus {
  isAllowed: boolean
  nextTransitionAt: number | null
}

export const DEFAULT_CAPTURE_SCHEDULE: CaptureSchedule = {
  enabled: false,
  weekdays: [1, 2, 3, 4, 5],
  startTime: '09:00',
  endTime: '19:00',
}

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const SEARCH_DAY_COUNT = 15

export function isCaptureTime(value: unknown): value is string {
  return typeof value === 'string' && TIME_PATTERN.test(value)
}

export function normalizeCaptureSchedule(value: unknown): CaptureSchedule {
  if (!value || typeof value !== 'object') return { ...DEFAULT_CAPTURE_SCHEDULE }
  const schedule = value as Partial<CaptureSchedule>
  const weekdays = Array.isArray(schedule.weekdays)
    ? Array.from(
        new Set(
          schedule.weekdays.filter(
            (weekday): weekday is CaptureWeekday => Number.isInteger(weekday) && weekday >= 0 && weekday <= 6
          )
        )
      ).sort((first, second) => first - second)
    : DEFAULT_CAPTURE_SCHEDULE.weekdays

  return {
    enabled: schedule.enabled === true,
    weekdays,
    startTime: isCaptureTime(schedule.startTime) ? schedule.startTime : DEFAULT_CAPTURE_SCHEDULE.startTime,
    endTime: isCaptureTime(schedule.endTime) ? schedule.endTime : DEFAULT_CAPTURE_SCHEDULE.endTime,
  }
}

export function isCaptureAllowed(schedule: CaptureSchedule, timestamp = Date.now()) {
  if (!schedule.enabled) return true
  if (schedule.weekdays.length === 0) return false

  const date = new Date(timestamp)
  const minuteOfDay = date.getHours() * 60 + date.getMinutes()
  const startMinute = timeToMinute(schedule.startTime)
  const endMinute = timeToMinute(schedule.endTime)
  const currentWeekday = date.getDay() as CaptureWeekday

  // Equal times are invalid, not an implicit 24-hour privacy grant.
  if (startMinute === endMinute) return false
  if (startMinute < endMinute) {
    return schedule.weekdays.includes(currentWeekday) && minuteOfDay >= startMinute && minuteOfDay < endMinute
  }

  if (schedule.weekdays.includes(currentWeekday) && minuteOfDay >= startMinute) return true
  const previousWeekday = ((currentWeekday + 6) % 7) as CaptureWeekday
  return schedule.weekdays.includes(previousWeekday) && minuteOfDay < endMinute
}

export function getCaptureScheduleStatus(schedule: CaptureSchedule, timestamp = Date.now()): CaptureScheduleStatus {
  const isAllowed = isCaptureAllowed(schedule, timestamp)
  if (!schedule.enabled) return { isAllowed, nextTransitionAt: null }

  const candidates = new Set<number>()
  const startMinute = timeToMinute(schedule.startTime)
  const endMinute = timeToMinute(schedule.endTime)
  for (let dayOffset = -1; dayOffset <= SEARCH_DAY_COUNT; dayOffset += 1) {
    candidates.add(localTimeOnDay(timestamp, dayOffset, startMinute))
    candidates.add(localTimeOnDay(timestamp, dayOffset, endMinute))
    candidates.add(localTimeOnDay(timestamp, dayOffset, 0))
  }

  const nextTransitionAt = Array.from(candidates)
    .filter((candidate) => candidate > timestamp)
    .sort((first, second) => first - second)
    .find(
      (candidate) => isCaptureAllowed(schedule, candidate - 1_000) !== isCaptureAllowed(schedule, candidate + 1_000)
    )

  return { isAllowed, nextTransitionAt: nextTransitionAt ?? null }
}

function timeToMinute(time: string) {
  const [hour, minute] = time.split(':').map(Number)
  return hour * 60 + minute
}

function localTimeOnDay(timestamp: number, dayOffset: number, minuteOfDay: number) {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() + dayOffset)
  date.setHours(Math.floor(minuteOfDay / 60), minuteOfDay % 60, 0, 0)
  return date.getTime()
}
