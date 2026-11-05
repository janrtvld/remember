import type { AssistantConversation } from '@remember/shared'

/** IPC snapshots clone every row. Retain unchanged rows so cached Markdown stays cached. */
export function reconcileAssistantConversation(
  previous: AssistantConversation | null,
  next: AssistantConversation
): AssistantConversation {
  if (!previous) return next
  const byId = new Map(previous.messages.map((message) => [message.id, message]))
  const messages = next.messages.map((message) => {
    const existing = byId.get(message.id)
    return existing && JSON.stringify(existing) === JSON.stringify(message) ? existing : message
  })
  const overlap = previous.messages.findIndex((message) => message.id === messages[0]?.id)
  return {
    ...next,
    hasEarlier: overlap > 0 ? previous.hasEarlier : next.hasEarlier,
    messages: overlap > 0 ? [...previous.messages.slice(0, overlap), ...messages] : messages,
  }
}
