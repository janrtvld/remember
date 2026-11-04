export function createTranscriptionLifecycle<Worker>() {
  const unresolvedChunks = new Map<Worker, Set<string>>()
  const listeners = new Set<(chunkIds: string[]) => void>()

  function track(worker: Worker, chunkId: string) {
    const chunks = unresolvedChunks.get(worker) ?? new Set<string>()
    chunks.add(chunkId)
    unresolvedChunks.set(worker, chunks)
  }

  function resolve(worker: Worker, chunkIds: string[]) {
    const chunks = unresolvedChunks.get(worker)
    if (!chunks) return
    for (const chunkId of chunkIds) chunks.delete(chunkId)
    if (chunks.size === 0) unresolvedChunks.delete(worker)
  }

  function interrupt(worker: Worker) {
    const chunks = unresolvedChunks.get(worker)
    unresolvedChunks.delete(worker)
    if (!chunks?.size) return
    const chunkIds = [...chunks]
    for (const listener of listeners) {
      try {
        listener(chunkIds)
      } catch (error) {
        console.error('[transcription] interruption listener failed', error)
      }
    }
  }

  function subscribe(listener: (chunkIds: string[]) => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  return { track, resolve, interrupt, subscribe }
}
