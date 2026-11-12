import type { DailyReviewWikiPage, KnowledgeSuggestion, WikiPageForAnalysis, WikiPageUpdate } from '@remember/shared'
import { agentContextTerms, isPrivateSelfProfilePage } from '../agentContextService'
import { reconcileWikiPageUpdates } from './wikiReconcile'

export type AnalysisWikiPage = DailyReviewWikiPage &
  Partial<Pick<WikiPageForAnalysis, 'spaceId' | 'spaceName' | 'maintenanceMode' | 'editContext'>> & {
    analysisReadOnlyReason?: string | null
    pendingProposal?: Pick<KnowledgeSuggestion, 'id' | 'content' | 'summary' | 'baseRevision' | 'evidence'> & {
      baseMatchesCurrent: boolean
      pageExists: boolean
    }
  }

function hasEditsSinceRemember(page: AnalysisWikiPage) {
  return Boolean(page.editContext?.changesSinceRemember.length)
}

/**
 * AI maintenance must never reason from a clipped Wiki page. Give the model a
 * complete current page (and the complete previous Remember revision when a
 * person edited it), or mark that page read-only for this run.
 */
export interface WikiPromptOrder {
  preserveOrder?: boolean
  /** Text describing the current work. Pages whose title or slug it names get whole-page room first. */
  relevantTo?: string
}

function isSelfProfile(page: AnalysisWikiPage) {
  return (page.spaceId ?? 'personal') === 'personal' && isPrivateSelfProfilePage(page)
}

export function wikiPagesForPrompt(
  pages: AnalysisWikiPage[],
  pageLimit: number,
  characterBudget: number,
  options: WikiPromptOrder = {}
) {
  let remaining = characterBudget
  const candidates = pages.filter((page) => page.slug !== 'index' && page.slug !== 'log')
  if (!options.preserveOrder) {
    const named = new Set(options.relevantTo ? agentContextTerms(options.relevantTo) : [])
    const relevance = new Map(
      candidates.map((page) => [
        page,
        named.size
          ? agentContextTerms(`${page.title} ${page.slug.replaceAll('/', ' ')}`).filter(
              (term) => named.has(term) && !['people', 'projects', 'concepts', 'decisions', 'research'].includes(term)
            ).length
          : 0,
      ])
    )
    // The person's own profile frames every other page, so it never competes for room.
    candidates.sort(
      (first, second) =>
        Number(isSelfProfile(second)) - Number(isSelfProfile(first)) ||
        Number(hasEditsSinceRemember(second)) - Number(hasEditsSinceRemember(first)) ||
        (relevance.get(second) ?? 0) - (relevance.get(first) ?? 0) ||
        second.updatedAt - first.updatedAt
    )
  }
  return candidates
    .slice(0, pageLimit)
    .map(
      ({
        slug,
        title,
        content,
        updatedAt,
        spaceId,
        spaceName,
        maintenanceMode,
        editContext,
        analysisReadOnlyReason,
        pendingProposal,
      }) => {
        const editedSinceRemember = Boolean(editContext?.changesSinceRemember.length)
        const lastRememberRevision = editedSinceRemember ? (editContext?.lastRememberRevision ?? null) : null
        const requiredCharacters =
          content.length +
          (lastRememberRevision?.content.length ?? 0) +
          (pendingProposal ? JSON.stringify(pendingProposal).length : 0) +
          slug.length +
          title.length +
          512
        const rewriteAllowed = !analysisReadOnlyReason && requiredCharacters <= remaining
        if (rewriteAllowed) remaining -= requiredCharacters

        return {
          slug,
          title,
          content: rewriteAllowed ? content : null,
          contentUnavailable: rewriteAllowed ? null : (analysisReadOnlyReason ?? 'whole-page-context-budget'),
          rewriteAllowed,
          updatedAt,
          spaceId,
          spaceName,
          maintenanceMode,
          pendingProposal: rewriteAllowed ? pendingProposal : undefined,
          editContext:
            editContext && rewriteAllowed
              ? {
                  ...editContext,
                  lastRememberRevision: lastRememberRevision
                    ? {
                        ...lastRememberRevision,
                        content: rewriteAllowed ? lastRememberRevision.content : null,
                      }
                    : null,
                }
              : null,
        }
      }
    )
}

export function filterWikiUpdatesToSafePromptSelection(
  updates: WikiPageUpdate[],
  existingPages: AnalysisWikiPage[],
  promptPages: Array<{ slug: string; rewriteAllowed: boolean }>
) {
  const existingSlugs = new Set(existingPages.map((page) => page.slug))
  const writableSlugs = new Set(promptPages.filter((page) => page.rewriteAllowed).map((page) => page.slug))
  const reconciled = reconcileWikiPageUpdates(
    existingPages.map(({ slug, title, content }) => ({ slug, title, content })),
    updates
  ).updates
  return reconciled.filter((update) => !existingSlugs.has(update.slug) || writableSlugs.has(update.slug))
}

export function filterWikiUpdatesToSafePromptPages(
  updates: WikiPageUpdate[],
  pages: AnalysisWikiPage[],
  pageLimit: number,
  characterBudget: number,
  order: WikiPromptOrder = {}
) {
  return filterWikiUpdatesToSafePromptSelection(
    updates,
    pages,
    wikiPagesForPrompt(pages, pageLimit, characterBudget, order)
  )
}
