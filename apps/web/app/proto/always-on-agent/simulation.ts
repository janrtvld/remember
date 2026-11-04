export type Scenario = {
  id: string
  title: string
  events: { id: string; kind: string; text?: string; at_ms: number; observed_end_ms?: number }[]
  expected: {
    tasks_created: { key: string; result: string; source_refs: string[]; requires_current_relevance_check?: boolean }[]
    attention: { max_proactive_chat_entries: number; reason: string; offer_deliverable?: string }
  }
}

export type Phase = 'idle' | 'offered' | 'dismissed' | 'running' | 'stopped' | 'done'

export function canOffer(scenario: Scenario) {
  return scenario.expected.attention.max_proactive_chat_entries > 0 && scenario.expected.tasks_created.length > 0
}

export function offerTitle(scenario: Scenario) {
  return scenario.id === 'AO-020'
    ? 'Een conceptbericht voor Noor voorbereiden?'
    : 'Een conceptbevestiging voor Noor maken?'
}

export function draftFor(scenario: Scenario) {
  return scenario.id === 'AO-020'
    ? 'Hoi Noor,\n\nHierbij het overzicht voor het overleg.\n\n[Voeg het overzicht toe.]\n\nGroet,\nJan'
    : 'Hoi Noor,\n\nHierbij bevestig ik de levering voor dinsdag.\n\nGroet,\nJan'
}

export function applyAction(phase: Phase, action: 'dismiss' | 'start' | 'stop' | 'finish', eligible: boolean): Phase {
  if (action === 'dismiss' && phase === 'offered') return 'dismissed'
  if (action === 'start' && eligible && ['offered', 'dismissed', 'stopped'].includes(phase)) return 'running'
  if (action === 'stop' && phase === 'running') return 'stopped'
  if (action === 'finish' && phase === 'running') return 'done'
  return phase
}
