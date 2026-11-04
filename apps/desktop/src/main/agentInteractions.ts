import { randomUUID } from 'node:crypto'
import type { AgentInteraction, AgentInteractionAnswer } from '@remember/shared'

export function createAgentInteractions(onChange: () => void) {
  const listeners = new Set<() => void>()
  const changed = () => {
    onChange()
    for (const listener of listeners) listener()
  }
  const pending = new Map<
    string,
    { request: AgentInteraction; resolve: (answer: AgentInteractionAnswer) => void; cleanup: () => void }
  >()
  return {
    list: () => [...pending.values()].map((entry) => entry.request),
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    ask(request: Omit<AgentInteraction, 'id'>, signal: AbortSignal): Promise<AgentInteractionAnswer> {
      if (signal.aborted) return Promise.reject(new Error('agent-cancelled'))
      const id = randomUUID()
      return new Promise((resolve, reject) => {
        const abort = () => {
          pending.delete(id)
          signal.removeEventListener('abort', abort)
          changed()
          reject(new Error('agent-cancelled'))
        }
        pending.set(id, {
          request: { ...request, id },
          resolve,
          cleanup: () => signal.removeEventListener('abort', abort),
        })
        signal.addEventListener('abort', abort, { once: true })
        changed()
      })
    },
    answer(raw: unknown) {
      if (!raw || typeof raw !== 'object') throw new Error('invalid-agent-answer')
      const answer = raw as AgentInteractionAnswer
      const entry = pending.get(answer.id)
      if (!entry?.request.actions.some((action) => action.id === answer.action))
        throw new Error('agent-request-expired')
      if (!answer.values || typeof answer.values !== 'object' || Array.isArray(answer.values))
        throw new Error('invalid-agent-answer')
      if (answer.action === 'accept') {
        for (const field of entry.request.fields) {
          const value = answer.values[field.id]
          if (field.required && (value === undefined || value === '')) throw new Error('agent-answer-required')
          if (value !== undefined && (typeof value !== 'string' || value.length > 10_000))
            throw new Error('invalid-agent-answer')
        }
      }
      pending.delete(answer.id)
      entry.cleanup()
      entry.resolve(answer)
      changed()
    },
  }
}
