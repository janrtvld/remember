import type { AgentProvider, AgentTraceEvent } from '@remember/shared'
import type { AgentActivityTrackingStatus } from './agentActivityTracking'

type TracePolicy = {
  enabled: boolean
  paused: boolean
  cloudAnalysisConsent: boolean
  offlineMode: boolean
}

export function createAgentLearningStatusTrace(record: (event: AgentTraceEvent) => void, now: () => number = Date.now) {
  let previous = ''
  let sequence = 0

  return (status: AgentActivityTrackingStatus, policy: TracePolicy, provider: AgentProvider) => {
    if (!policy.enabled) {
      previous = ''
      return
    }

    const messages: string[] = []
    if (policy.paused) messages.push('Leren van agents is gepauzeerd met je privacy-instellingen.')
    else if (!policy.cloudAnalysisConsent) messages.push('Leren van agents wacht op toestemming voor AI-verwerking.')
    else if (policy.offlineMode) messages.push('Leren van agents wacht tot de offline-modus uitstaat.')

    const errors = policy.paused
      ? []
      : [...new Set(status.errors.map(({ provider, error }) => `${provider}: ${error}`))].sort()
    if (!policy.paused && status.error && !status.errors.some(({ error }) => error === status.error))
      errors.push(status.error)
    if (errors.length) {
      messages.push('Leren van agents wordt automatisch opnieuw geprobeerd. Je berichten blijven bewaard.')
      messages.push(...errors)
    }

    const current = JSON.stringify(messages)
    if (current === previous || (!messages.length && !previous)) return
    previous = current
    if (!messages.length) messages.push('Leren van agents is automatisch hervat.')

    const timestamp = now()
    record({
      id: `agent-learning:status:${timestamp}:${sequence++}`,
      action: 'agent-learning',
      provider,
      status: errors.length ? 'failed' : 'completed',
      startedAt: timestamp,
      completedAt: timestamp,
      dayId: null,
      reason: null,
      error: errors.length ? errors.join('; ') : null,
      logs: messages.map((message) => ({ timestamp, message })),
    })
  }
}
