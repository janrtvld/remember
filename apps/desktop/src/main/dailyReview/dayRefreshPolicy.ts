import type { DailyReviewMoment, Day, DayMemory } from '@remember/shared'
import { normalizeFrequentDayRefreshIntervalMinutes } from '@remember/shared'

type DowntimeRefreshInput = {
  isRecording: boolean
  isRefreshing: boolean
  hasPendingTranscription: boolean
  userIdleSeconds: number
  lastMeaningfulSpeechAt: number
  now: number
  lastRefreshAt: number
  refreshIntervalMs: number
  latestEvidenceAt: number
  coveredThrough: number
  requiredIdleSeconds: number
  requiredSpeechSilenceMs: number
  requiredNewEvidenceMs: number
}

type FrequentIntervalRefreshInput = {
  isRefreshing: boolean
  now: number
  lastRefreshAt: number
  refreshIntervalMs: number
  latestEvidenceAt: number
  coveredThrough: number
  requiredNewEvidenceMs: number
}

type PendingWikiRefreshDay = Pick<Day, 'startedAt' | 'endedAt'> & {
  memory: Pick<DayMemory, 'coveredThrough' | 'wikiCoveredThrough' | 'refreshedAt'> | null
  moments: Pick<DailyReviewMoment, 'status'>[]
  refresh: {
    status: Day['refresh']['status']
    run: { startedAt: number; completedAt: number | null } | null
  }
}

export function hasPendingDayWikiReview(memory: Pick<DayMemory, 'coveredThrough' | 'wikiCoveredThrough'> | null) {
  // Missing coverage belongs to legacy Days. Revisit those only when another
  // refresh is requested, rather than automatically backfilling all history.
  return memory?.wikiCoveredThrough !== undefined && memory.wikiCoveredThrough < memory.coveredThrough
}

export function lastRefreshAttemptAt(day: Pick<PendingWikiRefreshDay, 'startedAt' | 'memory' | 'refresh'>) {
  return Math.max(
    day.memory?.refreshedAt ?? day.startedAt,
    day.refresh.run?.startedAt ?? day.startedAt,
    day.refresh.run?.completedAt ?? day.startedAt
  )
}

export function nextDayWithPendingWikiReview<T extends PendingWikiRefreshDay>(
  days: readonly T[],
  now: number,
  refreshIntervalMs: number
): T | null {
  if (days.some((day) => day.refresh.status === 'refreshing')) return null
  return days.reduce<T | null>((next, day) => {
    if (!hasPendingDayWikiReview(day.memory)) return next
    if (day.endedAt !== null && day.moments.some((moment) => moment.status === 'transcribing')) return next
    // A refresh that completed and still deferred the Wiki defers it again on
    // the same evidence, and each attempt re-analyzes the Day. Retained Wiki
    // evidence therefore waits for a refresh started by new evidence or the
    // user; only an attempt that failed is retried here.
    if (day.refresh.status !== 'failed') return next
    // Each failure since the last successful refresh doubles the wait, so a
    // provider outage or exhausted quota is not retried every interval.
    const attemptAt = lastRefreshAttemptAt(day)
    const retryDelayMs = Math.max(refreshIntervalMs, attemptAt - (day.memory?.refreshedAt ?? day.startedAt))
    if (now - attemptAt < retryDelayMs) return next
    return !next || lastRefreshAttemptAt(day) < lastRefreshAttemptAt(next) ? day : next
  }, null)
}

export function frequentRefreshIntervalMs(intervalMinutes: number) {
  return normalizeFrequentDayRefreshIntervalMinutes(intervalMinutes) * 60_000
}

export function shouldRefreshDuringDowntime(input: DowntimeRefreshInput) {
  if (!input.isRecording || input.isRefreshing || input.hasPendingTranscription) return false
  // Coverage does not advance when a refresh fails, so the evidence check alone
  // would start another attempt on every idle check.
  if (input.now - input.lastRefreshAt < input.refreshIntervalMs) return false
  if (input.userIdleSeconds < input.requiredIdleSeconds) return false
  if (input.lastMeaningfulSpeechAt && input.now - input.lastMeaningfulSpeechAt < input.requiredSpeechSilenceMs) {
    return false
  }
  return input.latestEvidenceAt - input.coveredThrough >= input.requiredNewEvidenceMs
}

export function shouldRefreshDuringFrequentInterval(input: FrequentIntervalRefreshInput) {
  if (input.isRefreshing) return false
  if (input.now - input.lastRefreshAt < input.refreshIntervalMs) return false
  return input.latestEvidenceAt - input.coveredThrough >= input.requiredNewEvidenceMs
}

// Keep unfinished audio outside the incremental coverage cursor so its eventual
// transcript is still eligible for the next analysis.
export function completedEvidenceThrough(now: number, moments: Pick<DailyReviewMoment, 'status' | 'startedAt'>[]) {
  return moments.reduce(
    (through, moment) => (moment.status === 'transcribing' ? Math.min(through, moment.startedAt - 1) : through),
    now
  )
}
