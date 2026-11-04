export type CalendarLocale = 'en-US' | 'nl-NL'

export function startOfCalendarMonth(timestamp: number) {
  const date = new Date(timestamp)
  return new Date(date.getFullYear(), date.getMonth(), 1, 12).getTime()
}

export function shiftCalendarMonth(timestamp: number, offset: number) {
  const date = new Date(timestamp)
  return new Date(date.getFullYear(), date.getMonth() + offset, 1, 12).getTime()
}

export function isSameCalendarMonth(timestamp: number, monthTimestamp: number) {
  const date = new Date(timestamp)
  const month = new Date(monthTimestamp)
  return date.getFullYear() === month.getFullYear() && date.getMonth() === month.getMonth()
}

export function calendarMonthDays(monthTimestamp: number, locale: CalendarLocale) {
  const month = new Date(monthTimestamp)
  const firstWeekday = new Date(month.getFullYear(), month.getMonth(), 1, 12).getDay()
  const weekStartsOn = locale === 'en-US' ? 0 : 1
  const leadingDays = (firstWeekday - weekStartsOn + 7) % 7

  return Array.from({ length: 42 }, (_, index) =>
    new Date(month.getFullYear(), month.getMonth(), 1 - leadingDays + index, 12).getTime()
  )
}

export function calendarWeekdayLabels(locale: CalendarLocale) {
  const sunday = new Date(2026, 7, 2, 12)
  const weekStartsOn = locale === 'en-US' ? 0 : 1

  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(sunday)
    date.setDate(sunday.getDate() + ((weekStartsOn + index) % 7))
    return new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(date).replace(/\.$/, '')
  })
}
