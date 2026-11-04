const PUBLIC_AGENT_ERROR_CODES = new Set([
  'analysis-context-too-large',
  'agent-auth-required',
  'agent-cancelled',
  'agent-cli-missing',
  'agent-empty-response',
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
  'claude-output-too-large',
  'claude-timeout',
])

const RETRYABLE_AGENT_RESPONSE_CODES = new Set(['agent-invalid-response', 'claude-structured-output-failed'])
const AGENT_CANCELLATION_CODES = new Set(['agent-cancelled', 'agent-interrupted', 'network-request-cancelled'])

export function isAgentCancellation(error: unknown) {
  let current = error
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (AGENT_CANCELLATION_CODES.has(current.message)) return true
    // A provider timeout can retain an AbortError cause without being a user cancellation.
    if (PUBLIC_AGENT_ERROR_CODES.has(current.message)) return false
    if (current.name === 'AbortError' || ('code' in current && current.code === 'ABORT_ERR')) return true
    current = current.cause
  }
  return false
}

export function createAgentError(code: string, detail?: string) {
  const normalizedDetail = normalizeAgentErrorMessage(detail)
  return new Error(code, { cause: normalizedDetail ? new Error(normalizedDetail) : undefined })
}

export function agentErrorText(error: unknown) {
  return agentErrorMessages(error).join('\n')
}

export function agentErrorDetail(error: unknown, publicCode: string) {
  return (
    agentErrorMessages(error)
      .find(
        (message) =>
          message !== publicCode && message !== 'agent-failed' && !/^(?:agent|claude|codex)-[a-z0-9-]+$/.test(message)
      )
      ?.slice(0, 500) ?? null
  )
}

export function classifyAgentError(error: unknown) {
  if (!(error instanceof Error)) return 'agent-failed'
  if (PUBLIC_AGENT_ERROR_CODES.has(error.message)) return error.message
  if (isAgentCancellation(error)) return 'agent-cancelled'

  const errorText = agentErrorText(error)
  if (/requires a newer version of Codex|upgrade to the latest app or CLI/i.test(errorText)) {
    return 'codex-update-required'
  }
  if (/authenticate|authentication|not logged in|oauth session expired|unauthorized/i.test(errorText)) {
    return 'agent-auth-required'
  }
  if (/rate.?limit|quota|usage limit|too many requests/i.test(errorText)) return 'agent-rate-limited'
  if (/network|connection|connect|dns|timed? out|socket/i.test(errorText)) return 'agent-network-error'
  return 'agent-failed'
}

export function isRecoverableCodexResponseError(detail: string) {
  return /(?:response|output).*(?:schema|valid json)|schema.*(?:response|output)|failed to parse.*(?:response|output)/i.test(
    detail
  )
}

export function isRetryableAgentResponseError(error: unknown) {
  return error instanceof Error && RETRYABLE_AGENT_RESPONSE_CODES.has(error.message)
}

export function redactAgentCredentials(value: string) {
  return value
    .replaceAll(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replaceAll(/\b(?:access|refresh|id)[_-]?token\s*[:=]\s*["']?[^\s,"'}]+["']?/gi, '[token]=[redacted]')
    .replaceAll(/\b(?:sk|sess)-[a-z0-9_-]{8,}\b/gi, '[credential redacted]')
}

function agentErrorMessages(error: unknown) {
  const messages: string[] = []
  let current = error
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const message = normalizeAgentErrorMessage(current.message)
    if (message && !messages.includes(message)) messages.push(message)
    current = current.cause
  }
  return messages
}

function normalizeAgentErrorMessage(message: unknown) {
  if (typeof message !== 'string') return ''
  return redactAgentCredentials(message).replaceAll(/\s+/g, ' ').trim()
}
