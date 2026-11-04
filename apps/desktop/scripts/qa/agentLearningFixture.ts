import type { AgentProvider, WikiPageUpdate } from '@remember/shared'
import { contextSourceKey } from '../../src/main/contextImportChanges'
import type { AgentContextDocument } from '../../src/main/contextImportSources'
import type { AnalysisWikiPage } from '../../src/main/dailyReview/wikiPromptSafety'
import { reviewedWikiSuggestions, wikiSuggestionSources } from '../../src/main/dailyReview/wikiSuggestionPolicy'

// Only the QA runner's private source snapshot imports this module. Production
// startup always uses the real analyzer; no fixture environment flag is shipped.
export async function generateAgentKnowledgeUpdates(
  documents: AgentContextDocument[],
  pages: AnalysisWikiPage[],
  _language: 'en' | 'nl',
  _provider: AgentProvider
) {
  const sources = wikiSuggestionSources([], documents, 0, Number.POSITIVE_INFINITY)
  const updates: WikiPageUpdate[] = []
  for (const source of sources) {
    if (source.role !== 'user') continue
    const personal = source.text.includes('Use pnpm for my projects.')
    const project = source.text.includes('Keep transcription sources so colleagues can inspect a finding.')
    if (!personal && !project) continue
    const candidate: WikiPageUpdate = personal
      ? {
          slug: 'processes/qa-work-preferences',
          title: 'QA work preferences',
          content: 'Use pnpm for my projects.',
          summary: 'Saved the package-manager preference.',
          changeType: 'created',
          suggestedSpaceId: 'personal',
        }
      : {
          slug: pages.find((page) => page.slug === 'research/qa-team')?.slug ?? 'projects/qa-team',
          title: 'QA team',
          content: 'Keep transcription sources so colleagues can inspect a finding.',
          summary: 'Keep inspectable sources with research findings.',
          changeType: 'updated',
          suggestedSpaceId: pages.find((page) => ['research/qa-team', 'projects/qa-team'].includes(page.slug))?.spaceId,
        }
    updates.push(
      ...reviewedWikiSuggestions(
        { accepted: [{ index: 0, sourceId: source.id, quote: source.text }] },
        [candidate],
        [source]
      )
    )
  }
  return { updates, processedSourceKeys: documents.map(contextSourceKey), deferredSourceKeys: [], reviewNotes: [] }
}

export async function generateKnowledgeOrganizationUpdates() {
  return []
}
