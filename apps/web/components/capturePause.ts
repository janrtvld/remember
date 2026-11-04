export type CapturePauseDuration = '15-minutes' | '1-hour' | 'today' | 'until-resumed' | 'custom'

export function localDateTimeValue(timestamp: number) {
  const date = new Date(timestamp)
  const localTimestamp = timestamp - date.getTimezoneOffset() * 60_000
  return new Date(localTimestamp).toISOString().slice(0, 16)
}

export function capturePauseDurationMs(
  choice: CapturePauseDuration,
  customUntil: string,
  now = Date.now()
): number | null | undefined {
  if (choice === '15-minutes') return 15 * 60_000
  if (choice === '1-hour') return 60 * 60_000
  if (choice === 'until-resumed') return null
  if (choice === 'today') {
    const tomorrow = new Date(now)
    tomorrow.setDate(tomorrow.getDate() + 1)
    tomorrow.setHours(0, 0, 0, 0)
    return Math.max(1, tomorrow.getTime() - now)
  }

  const timestamp = new Date(customUntil).getTime()
  if (!Number.isFinite(timestamp) || timestamp <= now) return undefined
  return timestamp - now
}
