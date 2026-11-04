import type { CalendarBlock } from '@remember/shared'

export const DEFAULT_DAY_START_MINUTE = 8 * 60
export const DEFAULT_DAY_END_MINUTE = 18 * 60
export const MIN_VISIBLE_BREAK_MINUTES = 10

export interface PositionedCalendarBlock {
  block: CalendarBlock
  sourceIndex: number
  startMinute: number
  endMinute: number
  lane: number
  laneCount: number
}

export interface DayScheduleLayout {
  startMinute: number
  endMinute: number
  blocks: PositionedCalendarBlock[]
  hourMarks: number[]
}

export interface DayScheduleBounds {
  startMinute: number
  endMinute: number
}

export type RhythmEntry =
  | { type: 'block'; item: PositionedCalendarBlock }
  | { type: 'gap'; startMinute: number; endMinute: number }

export function parseLocalTime(time: string) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (minutes > 59 || hours > 24 || (hours === 24 && minutes !== 0)) return null
  return hours * 60 + minutes
}

export function formatLocalMinute(minute: number) {
  const normalized = ((minute % 1440) + 1440) % 1440
  const hours = Math.floor(normalized / 60)
  const minutes = normalized % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

function assignLanes(blocks: Omit<PositionedCalendarBlock, 'lane' | 'laneCount'>[]) {
  const positioned: PositionedCalendarBlock[] = []
  let group: Array<PositionedCalendarBlock> = []
  let groupEnd = Number.NEGATIVE_INFINITY
  let laneEnds: number[] = []

  const finishGroup = () => {
    const laneCount = Math.max(1, laneEnds.length)
    for (const item of group) item.laneCount = laneCount
    group = []
    laneEnds = []
  }

  for (const block of blocks) {
    if (block.startMinute >= groupEnd) {
      finishGroup()
      groupEnd = block.endMinute
    } else {
      groupEnd = Math.max(groupEnd, block.endMinute)
    }

    const availableLane = laneEnds.findIndex((endMinute) => endMinute <= block.startMinute)
    const lane = availableLane === -1 ? laneEnds.length : availableLane
    laneEnds[lane] = block.endMinute
    const item = { ...block, lane, laneCount: 1 }
    group.push(item)
    positioned.push(item)
  }
  finishGroup()
  return positioned
}

export function createDayScheduleLayout(blocks: CalendarBlock[], bounds?: DayScheduleBounds): DayScheduleLayout {
  const normalized = blocks
    .map((block, sourceIndex) => {
      const startMinute = parseLocalTime(block.startTime)
      const parsedEnd = parseLocalTime(block.endTime)
      if (startMinute == null || parsedEnd == null) return null
      const endMinute = parsedEnd < startMinute ? parsedEnd + 1440 : Math.max(startMinute + 1, parsedEnd)
      return { block, sourceIndex, startMinute, endMinute }
    })
    .filter((block): block is NonNullable<typeof block> => block != null)
    .sort((left, right) => left.startMinute - right.startMinute || left.endMinute - right.endMinute)

  const earliestBlock = normalized[0]?.startMinute
  const startMinute = bounds
    ? Math.min(bounds.startMinute, earliestBlock ?? bounds.startMinute)
    : Math.floor(Math.min(DEFAULT_DAY_START_MINUTE, earliestBlock ?? DEFAULT_DAY_START_MINUTE) / 60) * 60
  const latestBlockEnd = normalized.reduce((latest, block) => Math.max(latest, block.endMinute), startMinute + 1)
  const endMinute = bounds
    ? Math.max(startMinute + 1, bounds.endMinute, latestBlockEnd)
    : Math.ceil(Math.max(DEFAULT_DAY_END_MINUTE, latestBlockEnd) / 60) * 60
  const firstHourMark = Math.ceil(startMinute / 60) * 60
  const hourMarks = Array.from(
    { length: Math.max(0, Math.floor((endMinute - firstHourMark) / 60) + 1) },
    (_, index) => firstHourMark + index * 60
  )

  return { startMinute, endMinute, blocks: assignLanes(normalized), hourMarks }
}

export function createRhythmEntries(layout: DayScheduleLayout): RhythmEntry[] {
  if (!layout.blocks.length) return []

  const entries: RhythmEntry[] = []
  // The timeline starts with the first visible activity. A broader capture or
  // calendar-day bound before that block is pre-work time, not a break.
  let coveredThrough = layout.blocks[0].startMinute

  for (const item of layout.blocks) {
    // A break can never overlap a visible activity. Generated Timeline refreshes
    // reconcile nested summaries at the data boundary; the renderer only marks
    // time that is not covered by any block.
    if (item.startMinute - coveredThrough >= MIN_VISIBLE_BREAK_MINUTES) {
      entries.push({ type: 'gap', startMinute: coveredThrough, endMinute: item.startMinute })
    }
    entries.push({ type: 'block', item })
    coveredThrough = Math.max(coveredThrough, item.endMinute)
  }

  if (layout.endMinute - coveredThrough >= MIN_VISIBLE_BREAK_MINUTES) {
    entries.push({ type: 'gap', startMinute: coveredThrough, endMinute: layout.endMinute })
  }
  return entries
}
