export const MEETING_REMINDER_COOLDOWN_MS = 30 * 60_000

export function shouldShowMeetingReminder(input: {
  surfaceState: 'active' | 'ended'
  automaticAudioCaptureEnabled: boolean
  manualMeetingRecording: boolean
  notificationSupported: boolean
  lastShownAt?: number
  now: number
}): boolean {
  if (
    input.surfaceState !== 'active' ||
    input.automaticAudioCaptureEnabled ||
    input.manualMeetingRecording ||
    !input.notificationSupported
  ) {
    return false
  }
  return input.now - (input.lastShownAt ?? 0) >= MEETING_REMINDER_COOLDOWN_MS
}
