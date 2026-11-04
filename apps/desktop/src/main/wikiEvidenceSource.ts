import type { WikiSuggestionEvidence } from '@remember/shared'
import type { AgentActivityEvent } from './agentActivityStore'
import type { AgentEvidence } from './residentAgentPrivacy'

/** Resolve original evidence, never the saved quotation as a substitute for its source. */
export function resolveWikiEvidenceSource(
  source: WikiSuggestionEvidence,
  dependencies: {
    agentEvent: (id: string) => AgentActivityEvent | null
    captured: (id: string) => AgentEvidence | null
  }
): AgentEvidence | null {
  if (source.provider || source.eventId || source.documentSourceId) {
    if (!source.provider || !source.eventId || !source.documentSourceId || !source.role) return null
    const event = dependencies.agentEvent(source.eventId)
    if (
      !event ||
      event.provider !== source.provider ||
      event.sessionId !== source.documentSourceId ||
      event.role !== source.role ||
      event.observedAt !== source.observedAt ||
      !event.text.includes(source.quote)
    )
      return null
    return {
      kind: 'context',
      text: event.text,
      appName: event.provider === 'codex' ? 'Codex' : 'Claude',
      bundleId: event.provider === 'codex' ? 'com.openai.codex' : 'com.anthropic.claudefordesktop',
    }
  }
  return dependencies.captured(source.sourceId)
}
