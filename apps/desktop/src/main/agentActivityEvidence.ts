import path from 'node:path'
import type { AgentActivityEvent } from './agentActivityStore'
import type { AnalysisEvidenceEntry } from './dailyReview/analysisContext'

export function agentActivityEvidence(
  events: AgentActivityEvent[],
  options: { after: number; through: number; recordedThrough?: number; maxCharactersPerEntry?: number }
): AnalysisEvidenceEntry[] {
  const maxCharacters = Math.min(20_000, Math.max(256, options.maxCharactersPerEntry ?? 8_000))
  const seen = new Set<string>()
  return [...events]
    .sort((left, right) => left.observedAt - right.observedAt || left.sourceOffset - right.sourceOffset)
    .flatMap((event) => {
      if (
        seen.has(event.id) ||
        !event.text.trim() ||
        event.observedAt <= options.after ||
        event.observedAt > options.through ||
        event.recordedAt > (options.recordedThrough ?? Number.MAX_SAFE_INTEGER)
      )
        return []
      seen.add(event.id)
      const parts = messageParts(event.text, maxCharacters)
      return parts.map((text, partIndex) => ({
        evidenceId: `agent-message:${event.id}:${partIndex}`,
        timestamp: event.observedAt,
        kind: 'agent-message' as const,
        app: event.provider === 'codex' ? 'Codex' : 'Claude',
        ...(event.projectPath ? { window: path.basename(event.projectPath) } : {}),
        source:
          event.role === 'user'
            ? 'Original user message'
            : 'Original assistant response; claims are not verified actions',
        agentMessage: {
          provider: event.provider,
          sessionId: event.sessionId,
          eventId: event.id,
          recordedAt: event.recordedAt,
          role: event.role,
          projectPath: event.projectPath,
          partIndex,
          partCount: parts.length,
        },
        text,
      }))
    })
}

function messageParts(text: string, limit: number) {
  const parts: string[] = []
  for (let offset = 0; offset < text.length; ) {
    let end = Math.min(text.length, offset + limit)
    const previous = text.charCodeAt(end - 1)
    const next = text.charCodeAt(end)
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--
    parts.push(text.slice(offset, end))
    offset = end
  }
  return parts
}
