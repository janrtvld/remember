type ShutdownOptions = {
  stopProcesses: () => Promise<void>
  stopCapture?: Array<() => void | Promise<void>>
  cleanup: Array<() => void | Promise<void>>
  exit: () => void
  reportError: (message: string, error: unknown) => void
}

export function createAppExitStrategy({ exit }: { exit: () => void }) {
  let installUpdate: (() => void) | null = null
  let updateQuitReleased = false

  return {
    prepareForUpdate: (install: () => void) => {
      installUpdate = install
    },
    shouldPreventQuit: () => !installUpdate || !updateQuitReleased,
    finishShutdown: () => {
      if (!installUpdate) {
        exit()
        return
      }
      if (updateQuitReleased) return
      updateQuitReleased = true
      installUpdate()
    },
  }
}

export function createAppShutdown({ stopProcesses, stopCapture = [], cleanup, exit, reportError }: ShutdownOptions) {
  let shutdownPromise: Promise<void> | null = null

  return () => {
    shutdownPromise ??= (async () => {
      try {
        // Start capture teardown immediately, before waiting for agent termination.
        // Every owner marks itself disposed synchronously, preventing recovery on quit.
        await Promise.all([
          ...stopCapture.map(async (stop) => {
            try {
              await stop()
            } catch (error) {
              reportError('could not stop capture', error)
            }
          }),
          (async () => {
            try {
              await stopProcesses()
            } catch (error) {
              reportError('could not stop agent processes', error)
            }
          })(),
        ])

        for (const task of cleanup) {
          try {
            await task()
          } catch (error) {
            reportError('cleanup failed', error)
          }
        }
      } finally {
        exit()
      }
    })()

    return shutdownPromise
  }
}
