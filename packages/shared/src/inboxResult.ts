export interface InboxResultUpdate {
  summary: string
  remaining: string
  nextStep: string
  needsUser: boolean
}

/** Optional worker metadata. Invalid output remains visible rather than silently losing evidence. */
export function parseInboxResult(response: string): { response: string; update: InboxResultUpdate | null } {
  const match = response.match(/\n*```remember-task-update\s*\n([\s\S]*?)\n```\s*$/)
  if (!match) return { response, update: null }
  try {
    const value: unknown = JSON.parse(match[1] ?? '')
    if (!value || typeof value !== 'object') return { response, update: null }
    const update = value as Record<string, unknown>
    if (
      typeof update.summary !== 'string' ||
      !update.summary.trim() ||
      update.summary.length > 1200 ||
      typeof update.remaining !== 'string' ||
      update.remaining.length > 1200 ||
      typeof update.nextStep !== 'string' ||
      update.nextStep.length > 1200 ||
      typeof update.needsUser !== 'boolean'
    )
      return { response, update: null }
    const artifact = response.slice(0, match.index).trim()
    if (!artifact) return { response, update: null }
    return {
      response: artifact,
      update: {
        summary: update.summary.trim(),
        remaining: update.remaining.trim(),
        nextStep: update.nextStep.trim(),
        needsUser: update.needsUser,
      },
    }
  } catch {
    return { response, update: null }
  }
}
