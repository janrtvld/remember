import type { CaptureState } from '@remember/shared'

export type MicrophoneHeaderStatus = 'active' | 'connecting' | 'paused' | 'permission-denied' | 'stale' | 'inactive'

export function microphoneHeaderStatus(
  state: Pick<
    CaptureState,
    'status' | 'microphoneName' | 'microphoneLastChunkAt' | 'microphonePermission' | 'pausedSources'
  >,
  now = Date.now()
): MicrophoneHeaderStatus {
  if (state.pausedSources.includes('audio')) return 'paused'
  if (state.microphonePermission === 'denied' || state.microphonePermission === 'restricted') {
    return 'permission-denied'
  }
  if (state.status === 'recording') {
    if (!state.microphoneName || state.microphoneLastChunkAt == null) return 'connecting'
    return now - state.microphoneLastChunkAt <= 150_000 ? 'active' : 'stale'
  }
  if (state.status === 'paused') return 'paused'
  return 'inactive'
}
