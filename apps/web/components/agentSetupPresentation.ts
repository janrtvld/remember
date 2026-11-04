import type { AgentProvider, AgentStatus, AppLocale } from '@remember/shared'

export function agentSetupPresentation(
  provider: AgentProvider,
  status: AgentStatus | null,
  busy: boolean,
  locale: AppLocale = 'nl'
) {
  const text = (dutch: string, english: string) => (locale === 'nl' ? dutch : english)
  if (busy || status == null || status === 'checking') {
    return { actionLabel: text('Controleren…', 'Checking…'), disabled: true }
  }
  if (provider === 'codex') {
    if (status === 'ready') return { actionLabel: text('Gebruik ChatGPT', 'Use ChatGPT'), disabled: false }
    if (status === 'signed-out') return { actionLabel: text('Koppel ChatGPT', 'Connect ChatGPT'), disabled: false }
    if (status === 'missing')
      return { actionLabel: text('ChatGPT niet beschikbaar', 'ChatGPT unavailable'), disabled: true }
    return { actionLabel: text('Controleer opnieuw', 'Check again'), disabled: false }
  }
  if (status === 'ready') return { actionLabel: text('Gebruik Claude', 'Use Claude'), disabled: false }
  if (status === 'missing')
    return { actionLabel: text('Claude niet beschikbaar', 'Claude unavailable'), disabled: true }
  if (status === 'signed-out') return { actionLabel: text('Koppel Claude', 'Connect Claude'), disabled: false }
  return { actionLabel: text('Controleer opnieuw', 'Check again'), disabled: false }
}
