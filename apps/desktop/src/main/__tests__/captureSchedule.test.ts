import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  type CaptureSchedule,
  DEFAULT_CAPTURE_SCHEDULE,
  getCaptureScheduleStatus,
  isCaptureAllowed,
  normalizeCaptureSchedule,
} from '@remember/shared'
import { captureScheduleAction } from '../captureSchedulePolicy'

process.env.TZ = 'Europe/Amsterdam'

function schedule(patch: Partial<CaptureSchedule> = {}): CaptureSchedule {
  return { ...DEFAULT_CAPTURE_SCHEDULE, enabled: true, ...patch }
}

describe('capture schedule', () => {
  it('defaults to 24/7 while retaining the weekday schedule preset', () => {
    assert.deepEqual(normalizeCaptureSchedule(undefined), DEFAULT_CAPTURE_SCHEDULE)
    assert.equal(DEFAULT_CAPTURE_SCHEDULE.enabled, false)
    assert.deepEqual(DEFAULT_CAPTURE_SCHEDULE.weekdays, [1, 2, 3, 4, 5])
    assert.equal(DEFAULT_CAPTURE_SCHEDULE.startTime, '09:00')
    assert.equal(DEFAULT_CAPTURE_SCHEDULE.endTime, '19:00')
    assert.equal(isCaptureAllowed(DEFAULT_CAPTURE_SCHEDULE, new Date(2026, 7, 3, 9).getTime()), true)
    assert.equal(isCaptureAllowed(DEFAULT_CAPTURE_SCHEDULE, new Date(2026, 7, 3, 23, 59).getTime()), true)
    assert.equal(isCaptureAllowed(DEFAULT_CAPTURE_SCHEDULE, new Date(2026, 7, 2, 12).getTime()), true)
  })

  it('sanitizes persisted values without losing intentional empty weekdays', () => {
    assert.deepEqual(normalizeCaptureSchedule({ enabled: false, weekdays: [], startTime: '08:30', endTime: '17:45' }), {
      enabled: false,
      weekdays: [],
      startTime: '08:30',
      endTime: '17:45',
    })
    assert.deepEqual(
      normalizeCaptureSchedule({ enabled: true, weekdays: [5, 1, 5, 12], startTime: '25:00', endTime: 'x' }),
      { enabled: true, weekdays: [1, 5], startTime: '09:00', endTime: '19:00' }
    )
  })

  it('attributes an overnight window to the weekday on which it starts', () => {
    const overnight = schedule({ weekdays: [5], startTime: '22:00', endTime: '02:00' })
    assert.equal(isCaptureAllowed(overnight, new Date(2026, 7, 7, 23).getTime()), true)
    assert.equal(isCaptureAllowed(overnight, new Date(2026, 7, 8, 1, 59).getTime()), true)
    assert.equal(isCaptureAllowed(overnight, new Date(2026, 7, 8, 2).getTime()), false)
    assert.equal(isCaptureAllowed(overnight, new Date(2026, 7, 9, 1).getTime()), false)
  })

  it('fails closed when matching times make the schedule ambiguous', () => {
    const ambiguous = schedule({ weekdays: [1], startTime: '09:00', endTime: '09:00' })
    assert.equal(isCaptureAllowed(ambiguous, new Date(2026, 7, 3, 0).getTime()), false)
    assert.equal(isCaptureAllowed(ambiguous, new Date(2026, 7, 3, 23, 59).getTime()), false)
    assert.equal(getCaptureScheduleStatus(ambiguous, new Date(2026, 7, 3, 12).getTime()).nextTransitionAt, null)
  })

  it('finds the next local boundary across a weekend', () => {
    const fridayEvening = new Date(2026, 7, 7, 20).getTime()
    const status = getCaptureScheduleStatus(schedule({ enabled: true }), fridayEvening)
    assert.equal(status.isAllowed, false)
    assert.equal(status.nextTransitionAt, new Date(2026, 7, 10, 9).getTime())
  })

  it('uses calendar-local boundaries across daylight-saving changes', () => {
    const sunday = schedule({ weekdays: [0], startTime: '01:00', endTime: '04:00' })
    const duringSpringForward = new Date(2026, 2, 29, 1, 30).getTime()
    const status = getCaptureScheduleStatus(sunday, duringSpringForward)
    const expectedEnd = new Date(2026, 2, 29, 4).getTime()
    assert.equal(status.isAllowed, true)
    assert.equal(status.nextTransitionAt, expectedEnd)
    assert.equal(expectedEnd - duringSpringForward, 90 * 60_000)
  })

  it('disables scheduling without introducing a future transition', () => {
    const status = getCaptureScheduleStatus(schedule({ enabled: false }), new Date(2026, 7, 9, 2).getTime())
    assert.deepEqual(status, { isAllowed: true, nextTransitionAt: null })
  })
})

describe('capture schedule policy', () => {
  it('pauses active capture outside the window and resumes only a scheduler pause', () => {
    assert.equal(captureScheduleAction({ status: 'recording', isAllowed: false, isManuallyPaused: false }), 'pause')
    assert.equal(captureScheduleAction({ status: 'paused', isAllowed: true, isManuallyPaused: false }), 'resume')
  })

  it('never undoes an indefinite or timed manual pause at a schedule boundary', () => {
    assert.equal(captureScheduleAction({ status: 'paused', isAllowed: true, isManuallyPaused: true }), 'none')
    assert.equal(captureScheduleAction({ status: 'paused', isAllowed: false, isManuallyPaused: true }), 'none')
  })

  it('starts an idle app only inside the allowed window', () => {
    assert.equal(captureScheduleAction({ status: 'idle', isAllowed: true, isManuallyPaused: false }), 'start')
    assert.equal(captureScheduleAction({ status: 'idle', isAllowed: false, isManuallyPaused: false }), 'none')
  })
})
