import type { CaptureStatus } from '@remember/shared'

export type CaptureScheduleAction = 'pause' | 'resume' | 'start' | 'none'

export function captureScheduleAction({
  status,
  isAllowed,
  isManuallyPaused,
}: {
  status: CaptureStatus
  isAllowed: boolean
  isManuallyPaused: boolean
}): CaptureScheduleAction {
  if (!isAllowed) return status === 'recording' ? 'pause' : 'none'
  if (isManuallyPaused) return 'none'
  if (status === 'paused') return 'resume'
  if (status === 'idle') return 'start'
  return 'none'
}
