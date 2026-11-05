import type { AgentTurnStep } from '@remember/shared'

const statusLabels: Record<string, string> = {
  'Agent starten': 'Even kijken…',
  'Opdracht uitdenken': 'Even nadenken…',
  'Antwoord schrijven': 'Antwoord schrijven…',
  'Opdracht uitvoeren': 'Opdracht uitvoeren…',
  'Bestanden wijzigen': 'Bestanden bijwerken…',
  'Zoeken op het web': 'Zoeken op het web…',
  'Bestaande opdracht op de agentcomputer hervatten': 'Verbinding herstellen…',
}

export function progressStepText(step: AgentTurnStep): string {
  if (step.kind === 'reasoning') return step.text.trim()
  // Status events can contain shell commands or connector identifiers.
  if (step.text.startsWith('Uitvoeren:')) return 'Opdracht uitvoeren…'
  return statusLabels[step.text.trim()] ?? 'Opdracht uitvoeren…'
}

export function progressSummary(text: string): string {
  const line = text
    .split('\n')
    .map((value) => value.trim())
    .find(Boolean)
  return (line ?? '').replace(/^#{1,6}\s+/, '').replace(/\*\*([^*]+)\*\*/g, '$1')
}

export function visibleProgressSteps(steps: AgentTurnStep[]): AgentTurnStep[] {
  return steps.reduce<AgentTurnStep[]>((visible, step) => {
    if (!step.text.trim()) return visible
    const text = progressStepText(step)
    if (visible.at(-1)?.text === text) return visible
    visible.push({ ...step, text })
    return visible
  }, [])
}
