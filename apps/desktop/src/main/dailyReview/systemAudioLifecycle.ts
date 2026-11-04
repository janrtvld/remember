export type SystemAudioVerificationResult = {
  ok: boolean
  error: string | null
}

export function createAudioHelperStartupGuard({ timeoutMs, onTimeout }: { timeoutMs: number; onTimeout: () => void }) {
  let state: 'starting' | 'ready' | 'failed' = 'starting'
  const timeout = setTimeout(() => {
    if (state !== 'starting') return
    state = 'failed'
    onTimeout()
  }, timeoutMs)

  const settle = (nextState: 'ready' | 'failed') => {
    if (state !== 'starting') return false
    state = nextState
    clearTimeout(timeout)
    return true
  }

  return {
    markFailed: () => settle('failed'),
    markReady: () => settle('ready'),
  }
}

export function createSystemAudioVerificationCompletion({
  cleanup,
  resolve,
}: {
  cleanup: () => void
  resolve: (result: SystemAudioVerificationResult) => void
}) {
  let result: SystemAudioVerificationResult | null = null
  let isClosed = false
  let isComplete = false

  const complete = () => {
    if (isComplete || !isClosed || !result) return
    isComplete = true
    cleanup()
    resolve(result)
  }

  return {
    close: () => {
      if (isClosed) return
      isClosed = true
      complete()
    },
    settle: (nextResult: SystemAudioVerificationResult) => {
      if (result) return false
      result = nextResult
      complete()
      return true
    },
  }
}
