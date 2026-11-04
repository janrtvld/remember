export const ACTIVE_DURATION_IDLE_LIMIT_MS = 5 * 60_000

export type ActiveDurationClock = {
  accumulatedMs: number
  trackingSince: number | null
}

export type ActiveInterval = {
  startedAt: number
  endedAt: number
}

function normalizedIdleMs(idleSeconds: number) {
  if (!Number.isFinite(idleSeconds) || idleSeconds <= 0) return 0
  return idleSeconds * 1_000
}

export function activeUntil(timestamp: number, idleSeconds: number, idleLimitMs = ACTIVE_DURATION_IDLE_LIMIT_MS) {
  const idleMs = normalizedIdleMs(idleSeconds)
  return idleMs >= idleLimitMs ? Math.max(0, timestamp - idleMs + idleLimitMs) : timestamp
}

/**
 * Settles active time without charging long idle, locked, or suspended spans.
 * Once the idle limit is reached, tracking stays stopped until a later active
 * checkpoint proves the person is back.
 */
export function checkpointActiveDuration(
  clock: ActiveDurationClock,
  timestamp: number,
  idleSeconds: number,
  idleLimitMs = ACTIVE_DURATION_IDLE_LIMIT_MS
): ActiveDurationClock {
  const idleMs = normalizedIdleMs(idleSeconds)
  if (clock.trackingSince == null) {
    return {
      accumulatedMs: clock.accumulatedMs,
      trackingSince: idleMs < idleLimitMs ? timestamp : null,
    }
  }

  const settledThrough = activeUntil(timestamp, idleSeconds, idleLimitMs)
  return {
    accumulatedMs: clock.accumulatedMs + Math.max(0, settledThrough - clock.trackingSince),
    trackingSince: idleMs < idleLimitMs ? timestamp : null,
  }
}

export function currentActiveDuration(
  clock: ActiveDurationClock,
  timestamp: number,
  idleSeconds: number,
  idleLimitMs = ACTIVE_DURATION_IDLE_LIMIT_MS
) {
  return checkpointActiveDuration(clock, timestamp, idleSeconds, idleLimitMs).accumulatedMs
}

function totalIntervalDuration(intervals: ActiveInterval[]) {
  return intervals.reduce((total, interval) => total + interval.endedAt - interval.startedAt, 0)
}

/** Adds an evidence-backed active interval and returns only its new, non-overlapping duration. */
export function creditActiveInterval(intervals: ActiveInterval[], interval: ActiveInterval) {
  if (interval.endedAt <= interval.startedAt) return { intervals, addedMs: 0 }
  const previousDuration = totalIntervalDuration(intervals)
  const merged: ActiveInterval[] = []

  for (const candidate of [...intervals, interval].sort((first, second) => first.startedAt - second.startedAt)) {
    const previous = merged.at(-1)
    if (!previous || candidate.startedAt > previous.endedAt) {
      merged.push({ ...candidate })
      continue
    }
    previous.endedAt = Math.max(previous.endedAt, candidate.endedAt)
  }

  return {
    intervals: merged,
    addedMs: totalIntervalDuration(merged) - previousDuration,
  }
}
