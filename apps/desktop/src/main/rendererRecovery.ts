import type { RenderProcessGoneDetails } from 'electron'

const RECOVERY_DELAY_MS = 250
const RECOVERY_INTERVAL_MS = 5 * 60_000

export function createRendererRecovery({
  canRecover,
  reload,
  onError,
}: {
  canRecover: () => boolean
  reload: () => Promise<void>
  onError: (error: unknown) => void
}) {
  let pending: ReturnType<typeof setTimeout> | null = null
  let lastAttemptAt: number | null = null
  let disposed = false

  return {
    recover(reason: RenderProcessGoneDetails['reason']) {
      if (!['crashed', 'oom', 'abnormal-exit', 'killed', 'memory-eviction'].includes(reason)) return false
      if (disposed || pending || !canRecover()) return false
      if (lastAttemptAt !== null && Date.now() - lastAttemptAt < RECOVERY_INTERVAL_MS) return false

      // Leave Electron's renderer teardown before starting another renderer.
      pending = setTimeout(async () => {
        pending = null
        if (disposed || !canRecover()) return
        lastAttemptAt = Date.now()
        try {
          await reload()
        } catch (error) {
          onError(error)
        }
      }, RECOVERY_DELAY_MS)
      return true
    },
    dispose() {
      disposed = true
      if (pending) clearTimeout(pending)
      pending = null
    },
  }
}
