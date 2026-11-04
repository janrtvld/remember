import type { WikiPageHistory, WikiSuggestionEvidence } from '@remember/shared'
import { type AgentEvidence, agentEvidencePermitted } from './residentAgentPrivacy'

export function residentWikiPagePermitted(
  history: WikiPageHistory,
  resolve: (source: WikiSuggestionEvidence) => AgentEvidence | null,
  settings: Parameters<typeof agentEvidencePermitted>[1]
) {
  const head = history.revisions.findIndex((revision) => revision.id === history.headRevisionId)
  if (head < 0) return false
  for (const revision of history.revisions.slice(head)) {
    if (revision.actor === 'user' || revision.actor === 'external') return true
    if (revision.actor !== 'remember' || !revision.evidence?.length) return false
    for (const source of revision.evidence) {
      const current = resolve(source)
      if (!current || !source.quote.trim() || !current.text.includes(source.quote)) return false
      if (!agentEvidencePermitted(current, settings)) return false
    }
  }
  return true
}
