import type { WorkItem } from '@remember/shared'

export function pollConversationProcessing(refreshDays: () => Promise<void>) {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  async function poll() {
    try {
      await refreshDays()
    } catch {
      // A transient read failure must not end the polling loop either.
    }
    if (!stopped) timer = setTimeout(() => void poll(), 10_000)
  }

  void poll()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

export function coalesceRefresh(refresh: () => Promise<void>) {
  let pending: Promise<void> | null = null
  let requested = false

  return () => {
    requested = true
    if (!pending) {
      pending = Promise.resolve().then(async () => {
        try {
          while (requested) {
            requested = false
            await refresh()
          }
        } finally {
          pending = null
        }
      })
    }
    return pending
  }
}

export function reconcileWorkItems(current: WorkItem[], incoming: WorkItem[], updatedSinceRead: Set<string>) {
  const currentById = new Map(current.map((item) => [item.id, item]))
  const incomingIds = new Set(incoming.map((item) => item.id))
  const next = incoming.map((item) => {
    const existing = currentById.get(item.id)
    return existing && existing.updatedAt > item.updatedAt ? existing : item
  })
  return [...current.filter((item) => updatedSinceRead.has(item.id) && !incomingIds.has(item.id)), ...next]
}
