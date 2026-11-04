export type DayTab = 'day' | 'conversations' | 'timeline' | 'knowledge'

export const dayTabs: Array<{ id: DayTab; label: string }> = [
  { id: 'day', label: 'Overzicht' },
  { id: 'conversations', label: 'Gesprekken' },
  { id: 'timeline', label: 'Tijdlijn' },
]
