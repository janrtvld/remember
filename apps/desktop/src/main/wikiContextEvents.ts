const listeners = new Set<() => void>()

export function subscribeWikiContextInvalidation(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function invalidateWikiContext() {
  for (const listener of listeners) listener()
}

const contentListeners = new Set<() => void>()

export function subscribeWikiContentChanges(listener: () => void) {
  contentListeners.add(listener)
  return () => {
    contentListeners.delete(listener)
  }
}

export function emitWikiContentChanged() {
  for (const listener of contentListeners) {
    try {
      listener()
    } catch (error) {
      console.error('[wiki] content change listener failed', error)
    }
  }
}
