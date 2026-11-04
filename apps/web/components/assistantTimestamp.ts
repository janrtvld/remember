export function formatAssistantTimestamp(timestamp: number, locale: string, now: number) {
  const date = new Date(timestamp)
  const today = new Date(now)
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(date)
  if (date.toDateString() === today.toDateString()) return time
  if (date.toDateString() === yesterday.toDateString())
    return `${locale.startsWith('nl') ? 'Gisteren' : 'Yesterday'}, ${time}`
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' as const } : {}),
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}
