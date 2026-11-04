export function isContextCaptureStale(input: {
  now: number
  lastEventAt: number | null
  startedAt: number | null
  staleAfterMs: number
}) {
  const lastSignalAt = input.lastEventAt ?? input.startedAt
  return lastSignalAt != null && input.now - lastSignalAt > input.staleAfterMs
}

export function shouldMonitorContextCapture(input: {
  hasActiveSession: boolean
  status: 'idle' | 'recording' | 'paused' | 'stopping' | 'error'
  capturePaused: boolean
}) {
  return input.hasActiveSession && input.status === 'recording' && !input.capturePaused
}
