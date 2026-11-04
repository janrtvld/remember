export function formatConversationDate(timestamp: number, locale: 'en-US' | 'nl-NL', currentDate = new Date()) {
  const date = new Date(timestamp)
  const includeYear = date.getFullYear() !== currentDate.getFullYear()
  const parts = new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: includeYear ? 'numeric' : undefined,
  }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value.replace(/\.$/, '') ?? ''
  const weekday = part('weekday')
  const capitalizedWeekday = weekday.charAt(0).toLocaleUpperCase(locale) + weekday.slice(1)
  const year = part('year')

  return `${capitalizedWeekday}, ${part('day')} ${part('month')}${year ? ` ${year}` : ''}`
}

export function formatConversationTimeRange(startTime: string, endTime: string) {
  return `${startTime} → ${endTime}`
}
