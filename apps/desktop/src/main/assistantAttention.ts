import type { AssistantAttention } from '@remember/shared'

let current: AssistantAttention = { unread: false, needsInput: false }
const listeners = new Set<(state: AssistantAttention) => void>()

export function getAssistantAttention() {
  return current
}

export function publishAssistantAttention(state: AssistantAttention) {
  if (state.unread === current.unread && state.needsInput === current.needsInput) return
  current = state
  for (const listener of listeners) listener(state)
}

export function subscribeAssistantAttention(listener: (state: AssistantAttention) => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
