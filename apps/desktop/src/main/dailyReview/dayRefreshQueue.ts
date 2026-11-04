import type { DayRefreshReason } from '@remember/shared'

export function createDayRefreshQueue<T>(
  refresh: (sessionId: string, reason: DayRefreshReason, language: 'en' | 'nl') => Promise<T>
) {
  const pending = new Map<string, Promise<T>>()
  return {
    has: (sessionId: string) => pending.has(sessionId),
    async drain() {
      while (pending.size) await Promise.allSettled([...pending.values()])
    },
    refresh(sessionId: string, reason: DayRefreshReason, language: 'en' | 'nl') {
      const previous = pending.get(sessionId)
      if (previous && (reason === 'active-interval' || reason === 'downtime')) return previous
      const operation = (previous ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => refresh(sessionId, reason, language))
        .finally(() => {
          if (pending.get(sessionId) === operation) pending.delete(sessionId)
        })
      pending.set(sessionId, operation)
      return operation
    },
  }
}
