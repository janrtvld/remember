import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MEETING_REMINDER_COOLDOWN_MS, shouldShowMeetingReminder } from './meetingReminder'

const eligible = {
  surfaceState: 'active' as const,
  automaticAudioCaptureEnabled: false,
  manualMeetingRecording: false,
  notificationSupported: true,
  now: 2 * MEETING_REMINDER_COOLDOWN_MS,
}

describe('shouldShowMeetingReminder', () => {
  it('offers manual recording when a call is detected and always-on audio is disabled', () => {
    assert.equal(shouldShowMeetingReminder(eligible), true)
  })

  it('does not interrupt automatic or already-manual recording', () => {
    assert.equal(shouldShowMeetingReminder({ ...eligible, automaticAudioCaptureEnabled: true }), false)
    assert.equal(shouldShowMeetingReminder({ ...eligible, manualMeetingRecording: true }), false)
  })

  it('suppresses repeats for the same call surface during the cooldown', () => {
    assert.equal(shouldShowMeetingReminder({ ...eligible, lastShownAt: eligible.now - 1_000 }), false)
    assert.equal(
      shouldShowMeetingReminder({ ...eligible, lastShownAt: eligible.now - MEETING_REMINDER_COOLDOWN_MS }),
      true
    )
  })
})
