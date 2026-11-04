import type { KnowledgeSuggestion, WikiPageUpdate, WikiSpace } from '@remember/shared'
import { contextSourceKey } from '../contextImportChanges'
import type { AgentContextDocument } from '../contextImportSources'
import type { AnalysisWikiPage } from './wikiPromptSafety'
import { comparableWikiContent } from './wikiSuggestionPolicy'

const SOURCE_CHARACTER_BUDGET = 60_000

export function agentKnowledgePagesWithProposals(
  pages: AnalysisWikiPage[],
  proposals: KnowledgeSuggestion[],
  spaces: readonly Pick<WikiSpace, 'id' | 'name' | 'maintenanceMode'>[] = []
) {
  const result = [...pages]
  const spacesById = new Map(spaces.map((space) => [space.id, space]))
  for (const proposal of proposals) {
    if (proposal.status !== 'pending') continue
    const index = result.findIndex(
      (page) => page.slug === proposal.slug && (page.spaceId ?? 'personal') === proposal.suggestedSpaceId
    )
    const current = result[index]
    const parent = pages
      .filter((page) => page.spaceId === proposal.suggestedSpaceId && proposal.slug.startsWith(`${page.slug}/`))
      .sort((first, second) => second.slug.length - first.slug.length)[0]
    const space = spacesById.get(proposal.suggestedSpaceId)
    if (!current && !parent && !space && proposal.suggestedSpaceId !== 'personal') continue
    const pendingProposal = {
      id: proposal.id,
      content: proposal.content,
      summary: proposal.summary,
      baseRevision: proposal.baseRevision,
      evidence: proposal.evidence,
      baseMatchesCurrent: (current?.revision ?? null) === proposal.baseRevision,
      pageExists: Boolean(current),
    }
    if (current) result[index] = { ...current, pendingProposal }
    else
      result.push({
        slug: proposal.slug,
        title: proposal.title,
        content: '',
        excerpt: '',
        sourceCount: 0,
        updatedAt: proposal.dayStartedAt,
        spaceId: proposal.suggestedSpaceId,
        spaceName: parent?.spaceName ?? space?.name,
        maintenanceMode: space?.maintenanceMode ?? 'suggest',
        pendingProposal,
        analysisReadOnlyReason: parent?.analysisReadOnlyReason,
      })
  }
  return result
}

export function retainPendingProposalEvidence(update: WikiPageUpdate, pages: AnalysisWikiPage[]) {
  const pending = pages.find(
    (page) =>
      page.slug === update.slug &&
      (update.suggestedSpaceId == null || (page.spaceId ?? 'personal') === update.suggestedSpaceId)
  )?.pendingProposal
  if (
    !pending?.evidence?.length ||
    !comparableWikiContent(update.content ?? update.summary).includes(comparableWikiContent(pending.content))
  )
    return update
  const evidence = [...pending.evidence, ...(update.evidence ?? [])]
  return {
    ...update,
    evidence: evidence.filter(
      (entry, index) =>
        evidence.findIndex((candidate) => candidate.sourceId === entry.sourceId && candidate.quote === entry.quote) ===
        index
    ),
  }
}

export function selectAgentKnowledgeDocuments(documents: AgentContextDocument[], budget = SOURCE_CHARACTER_BUDGET) {
  const selected: AgentContextDocument[] = []
  const deferredSourceKeys: string[] = []
  let remaining = budget
  for (const document of documents) {
    const messages = document.messages ?? []
    const size = messages.reduce((total, message) => total + message.content.length, 0)
    // The journal is responsible for bounded complete spans. Never truncate a
    // source here and then acknowledge its unconsidered remainder.
    if (!messages.length || messages.some((message) => message.observedAt === null) || size > remaining) {
      deferredSourceKeys.push(contextSourceKey(document))
      continue
    }
    remaining -= size
    selected.push({ ...document, content: messages.map((message) => message.content).join('\n\n') })
  }
  return { documents: selected, deferredSourceKeys }
}

function terms(value: string) {
  return new Set(
    value
      .normalize('NFKD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length >= 3)
  )
}

function overlap(first: Set<string>, second: Set<string>) {
  let count = 0
  for (const term of first) if (second.has(term)) count += 1
  return count
}

/** Rank before applying the whole-page budget so old relevant knowledge stays maintainable. */
export function rankAgentKnowledgePages(documents: AgentContextDocument[], pages: AnalysisWikiPage[]) {
  const bindings = documents.flatMap((document) => (document.wikiProject ? [document.wikiProject] : []))
  const projectTerms = terms(documents.map((document) => document.project).join(' '))
  const evidenceTerms = terms(
    documents
      .map(
        (document) =>
          `${document.content} ${document.contextMessages?.map((message) => message.content).join(' ') ?? ''}`
      )
      .join(' ')
  )
  const scores = new Map<AnalysisWikiPage, number>()
  for (const page of pages) {
    const identity = terms(`${page.spaceName ?? ''} ${page.slug} ${page.title}`)
    scores.set(
      page,
      Math.max(
        0,
        ...bindings.map((binding) =>
          binding.spaceId !== page.spaceId
            ? 0
            : binding.projectSlug === page.slug
              ? 5_000
              : page.slug.startsWith(`${binding.projectSlug}/`)
                ? 2_500
                : 0
        )
      ) +
        overlap(projectTerms, identity) * 20 +
        overlap(evidenceTerms, identity) * 8 +
        Math.min(20, overlap(evidenceTerms, terms(`${page.content} ${page.pendingProposal?.content ?? ''}`)))
    )
  }
  // A project-wide correction must be able to update the root as well as the
  // older child page where that discussion happened.
  for (const page of pages) {
    if (!/^projects\/[^/]+$/.test(page.slug)) continue
    const childScore = Math.max(
      0,
      ...pages
        .filter(
          (candidate) =>
            (candidate.spaceId ?? 'personal') === (page.spaceId ?? 'personal') &&
            candidate.slug.startsWith(`${page.slug}/`)
        )
        .map((candidate) => scores.get(candidate) ?? 0)
    )
    scores.set(page, Math.max(scores.get(page) ?? 0, childScore > 0 ? childScore + 1 : 0))
  }
  return [...pages].sort(
    (first, second) => (scores.get(second) ?? 0) - (scores.get(first) ?? 0) || second.updatedAt - first.updatedAt
  )
}

export type AgentKnowledgeDisposition = {
  sourceKey: string
  disposition: 'considered' | 'deferred'
}

export function consideredAgentKnowledgeSources(value: unknown, documents: AgentContextDocument[]) {
  if (!Array.isArray(value)) return []
  const known = new Set(documents.map(contextSourceKey))
  const dispositions = new Map<string, string>()
  for (const item of value) {
    if (!item || typeof item !== 'object' || !known.has(item.sourceKey)) continue
    // Contradictory or duplicate acknowledgments are not proof of completion.
    if (dispositions.has(item.sourceKey)) dispositions.set(item.sourceKey, 'deferred')
    else dispositions.set(item.sourceKey, item.disposition)
  }
  return [...dispositions].flatMap(([key, disposition]) => (disposition === 'considered' ? [key] : []))
}
