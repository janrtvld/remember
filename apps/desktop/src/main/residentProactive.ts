import type { ProactiveDecision, ProactiveSource } from './dailyReview/proactiveStore'

export type ProactiveConversationState = {
  generation: number
  available: boolean
  recentMessages: { id: string; role: 'user' | 'assistant'; text: string; createdAt: number }[]
  recentInitiatives: { decisionId: string; topicKey: string; createdAt: number }[]
  dismissedTopics: { topicKey: string; dismissedAt: number; expiresAt: number | null }[]
}

export type ProactiveConversationAttention = Pick<ProactiveConversationState, 'generation' | 'available'>

type Owner = {
  state(): ProactiveConversationState
  attention?(): ProactiveConversationAttention
  deliver(decision: ProactiveDecision): string | null
  delivered(id: string, inputHash: string): string | null
  briefingCandidateSourceIds?(sources?: ProactiveSource[]): string[]
}

let owner: Owner | null = null
const listeners = new Set<() => void>()

export function getProactiveConversationAttention(): ProactiveConversationAttention {
  return owner?.attention?.() ?? owner?.state() ?? { generation: 0, available: false }
}

export function getProactiveConversationState(): ProactiveConversationState {
  return (
    owner?.state() ?? {
      generation: 0,
      available: false,
      recentMessages: [],
      recentInitiatives: [],
      dismissedTopics: [],
    }
  )
}

export function deliverProactiveInitiative(decision: ProactiveDecision) {
  return owner?.deliver(decision) ?? null
}

export function getDeliveredProactiveInitiative(id: string, inputHash: string) {
  return owner?.delivered(id, inputHash) ?? null
}

export function getProactiveBriefingCandidateSourceIds(sources?: ProactiveSource[]) {
  return owner?.briefingCandidateSourceIds?.(sources) ?? []
}

export function subscribeProactiveConversationChanges(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emitProactiveConversationChanged() {
  for (const listener of listeners) listener()
}

export function registerProactiveConversation(next: Owner) {
  if (owner) throw new Error('proactive-conversation-already-registered')
  owner = next
  emitProactiveConversationChanged()
  return () => {
    if (owner !== next) return
    owner = null
    emitProactiveConversationChanged()
  }
}
