export function createTranscriptionQueue() {
  const waiting: Array<{ priority: number; run: () => Promise<void> }> = []
  let running = false

  async function drain() {
    if (running) return
    running = true
    try {
      while (waiting.length) {
        waiting.sort((first, second) => second.priority - first.priority)
        await waiting.shift()?.run()
      }
    } finally {
      running = false
    }
  }

  return function enqueueTranscription<T>(run: () => Promise<T>, priority: 'background' | 'dictation' = 'background') {
    return new Promise<T>((resolve, reject) => {
      waiting.push({
        priority: priority === 'dictation' ? 1 : 0,
        run: async () => {
          try {
            resolve(await run())
          } catch (error) {
            reject(error)
          }
        },
      })
      void drain()
    })
  }
}

export const queueTranscription = createTranscriptionQueue()
