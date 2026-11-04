import type { AgentProvider } from '@remember/shared'

export type ResidentTaskSuggestion = {
  eventId: string
  taskId: string
  evidenceIds: string[]
  text: string
  provider: AgentProvider
  createdAt: number
}

let sink: ((input: ResidentTaskSuggestion) => boolean) | null = null

export function subscribeResidentTaskSuggestions(next: (input: ResidentTaskSuggestion) => boolean) {
  if (sink) throw new Error('resident-suggestion-sink-already-registered')
  sink = next
  return () => {
    if (sink === next) sink = null
  }
}

export function publishResidentTaskSuggestion(input: ResidentTaskSuggestion) {
  return sink?.(input) ?? false
}
