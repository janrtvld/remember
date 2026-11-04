import type { DayMemory, DayRefreshReason, WikiPageUpdate } from '@remember/shared'
import { classifyAgentError, createAgentError } from './agentErrors'

type WikiUpdateStage = 'generation' | 'review'

export function ensureDayWikiReviewTarget(candidate: WikiPageUpdate, reviewed: WikiPageUpdate[]) {
  if (reviewed.some((update) => update.slug !== candidate.slug)) {
    throw createAgentError('agent-invalid-response', 'Wiki review changed the materialized page target')
  }
  return reviewed
}

export function hasUnacceptedDayWikiEdit(materialized: WikiPageUpdate | null, reviewed: WikiPageUpdate[]) {
  // A rejected replacement can be an incorrect edit of a real new fact.
  // Only a genuine no-op establishes that there was no edit left to review.
  return materialized !== null && reviewed.length === 0
}

export function dayWikiAnalysisWindow(
  startedAt: number,
  previousMemory: Pick<DayMemory, 'coveredThrough' | 'wikiCoveredThrough'> | null,
  reason: DayRefreshReason
) {
  // Older Days have no Wiki coverage. Revisit their evidence once rather than
  // assuming a successful Day summary also maintained the Wiki.
  const previousWikiThrough = previousMemory?.wikiCoveredThrough ?? startedAt - 1
  const after =
    reason === 'manual' || reason === 'end-of-day' || !previousMemory
      ? null
      : Math.min(previousMemory.coveredThrough, previousWikiThrough)
  return { after, wikiAfter: after ?? startedAt - 1, previousWikiThrough }
}

const OPTIONAL_WIKI_FAILURE_CODES = new Set([
  'analysis-context-too-large',
  'agent-auth-required',
  'agent-cli-missing',
  'agent-empty-response',
  'agent-failed',
  'agent-invalid-response',
  'agent-network-error',
  'agent-output-too-large',
  'agent-rate-limited',
  'agent-timeout',
  'codex-update-required',
  'claude-auth-required',
  'claude-cli-missing',
  'claude-config-invalid',
  'claude-empty-response',
  'claude-failed',
  'claude-output-too-large',
  'claude-structured-output-failed',
  'claude-timeout',
])

export async function generateOptionalDayWikiUpdates(input: {
  suggestions: WikiPageUpdate[]
  generate?: () => Promise<WikiPageUpdate[]>
  review: (suggestions: WikiPageUpdate[]) => Promise<WikiPageUpdate[]>
  onDeferred: (stage: WikiUpdateStage, errorCode: string) => void
}) {
  let suggestions = input.suggestions
  if (input.generate) {
    try {
      const contextUpdates = await input.generate()
      suggestions = [...suggestions, ...contextUpdates].slice(0, 16)
    } catch (error) {
      if (!isOptionalWikiProviderFailure(error)) throw error
      input.onDeferred('generation', classifyAgentError(error))
    }
  }

  try {
    return await input.review(suggestions)
  } catch (error) {
    if (!isOptionalWikiProviderFailure(error)) throw error
    input.onDeferred('review', classifyAgentError(error))
    // Unreviewed suggestions must never reach the Wiki write path.
    return []
  }
}

function isOptionalWikiProviderFailure(error: unknown) {
  if (!(error instanceof Error)) return false
  const seen = new Set<Error>()
  for (let current: unknown = error; current instanceof Error && !seen.has(current); current = current.cause) {
    seen.add(current)
    if (
      current.name === 'AbortError' ||
      ('code' in current && current.code === 'ABORT_ERR') ||
      current.message === 'agent-learning-invalid-review-evidence' ||
      /\b(?:cancel(?:led|ed)?|abort(?:ed)?|interrupt(?:ed)?|invalidat\w*|consent|offline[ -]mode|policy)\b/i.test(
        current.message
      ) ||
      current instanceof TypeError ||
      current instanceof ReferenceError ||
      current instanceof RangeError ||
      current instanceof SyntaxError
    ) {
      return false
    }
  }
  if (OPTIONAL_WIKI_FAILURE_CODES.has(error.message)) return true
  if (/^Claude Code process exited with code \d+$/.test(error.message)) return true
  if (/^Codex Exec exited with code \d+:/.test(error.message)) return true
  if (error.message === 'Selected model is at capacity. Please try a different model.') return true
  return false
}
