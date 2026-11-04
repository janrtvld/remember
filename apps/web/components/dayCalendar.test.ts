import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  calendarMonthDays,
  calendarWeekdayLabels,
  isSameCalendarMonth,
  shiftCalendarMonth,
  startOfCalendarMonth,
} from './dayCalendar'

describe('day calendar', () => {
  it('uses locale-specific week starts', () => {
    assert.deepEqual(calendarWeekdayLabels('en-US'), ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])
    assert.deepEqual(calendarWeekdayLabels('nl-NL'), ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'])
  })

  it('renders a stable six-week month grid', () => {
    const june = new Date(2026, 5, 8, 12).getTime()
    const englishDays = calendarMonthDays(june, 'en-US')
    const dutchDays = calendarMonthDays(june, 'nl-NL')

    assert.equal(englishDays.length, 42)
    assert.equal(new Date(englishDays[0]).getDate(), 31)
    assert.equal(new Date(dutchDays[0]).getDate(), 1)
  })

  it('moves between months without drifting the selected date', () => {
    const december = new Date(2026, 11, 18, 12).getTime()
    const january = shiftCalendarMonth(december, 1)

    assert.equal(new Date(january).getFullYear(), 2027)
    assert.equal(new Date(january).getMonth(), 0)
    assert.equal(startOfCalendarMonth(december), new Date(2026, 11, 1, 12).getTime())
    assert.equal(isSameCalendarMonth(december, january), false)
  })
})
