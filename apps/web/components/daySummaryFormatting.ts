export function formatDay(timestamp: number, locale: 'en-US' | 'nl-NL' = 'nl-NL', now = new Date()) {
  const date = new Date(timestamp)
  const includeYear = date.getFullYear() !== now.getFullYear()
  const value = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: includeYear ? 'numeric' : undefined,
  }).format(date)
  return value.charAt(0).toLocaleUpperCase(locale) + value.slice(1)
}

export function formatDuration(milliseconds: number, locale: 'en-US' | 'nl-NL' = 'nl-NL') {
  const totalMinutes = Math.max(0, Math.round(milliseconds / 60_000))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return hours ? `${hours}${locale === 'nl-NL' ? 'u' : 'h'}\u00a0${minutes}m` : `${minutes}m`
}
