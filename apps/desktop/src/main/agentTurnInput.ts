import type { RunAgentTurnInput } from '@remember/shared'

const MAX_PROMPT_LENGTH = 100_000

export function normalizeAgentTurnInput(input: unknown): RunAgentTurnInput | null {
  if (!input || typeof input !== 'object') return null
  const turnId = 'turnId' in input && typeof input.turnId === 'string' ? input.turnId.trim() : ''
  const workItemId = 'workItemId' in input && typeof input.workItemId === 'string' ? input.workItemId.trim() : ''
  const provider = 'provider' in input ? input.provider : null
  const prompt = 'prompt' in input && typeof input.prompt === 'string' ? input.prompt.trim() : ''
  if (
    !turnId ||
    turnId.length > 200 ||
    workItemId.length > 200 ||
    (provider !== 'codex' && provider !== 'claude') ||
    !prompt ||
    prompt.length > MAX_PROMPT_LENGTH
  ) {
    return null
  }
  return { turnId, ...(workItemId ? { workItemId } : {}), provider, prompt }
}

export function codexInfrastructureFailure(text: string) {
  const normalized = text.toLocaleLowerCase()
  return (
    normalized.includes('codex-code-mode-host') &&
    (normalized.includes('no such file') ||
      normalized.includes('failed to spawn') ||
      normalized.includes('unavailable') ||
      normalized.includes('not found'))
  )
}
