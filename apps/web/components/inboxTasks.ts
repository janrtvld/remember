import type {
  AgentProvider,
  AgentTurnStep,
  WorkItem,
  WorkItemAgentSessionStatus,
  WorkItemFact,
  WorkItemObservation,
} from '@remember/shared'

export type InboxTaskItem = {
  workItem: WorkItem
  taskKey: string
}

export type InboxAgentTurn = {
  id: string
  provider: AgentProvider
  at: number
  status: 'working' | 'complete' | 'cancelled' | 'error'
  message: string
  response: string
  durationMs: number
  steps: AgentTurnStep[]
}

type InboxActivityEventType =
  | 'created'
  | 'completed'
  | 'reopened'
  | 'dismissed'
  | 'revised'
  | 'superseded'
  | 'delegated'

export type InboxActivityEvent = {
  id: string
  type: InboxActivityEventType
  at: number
  reason: string
  actor: WorkItemFact['actor']
  provider?: AgentProvider
  observation?: WorkItemObservation
}

export type InboxTaskDraft = Pick<WorkItem, 'title' | 'description'>

export function sameInboxTaskDraft(first: InboxTaskDraft, second: InboxTaskDraft) {
  return first.title === second.title && first.description === second.description
}

export function reconcileInboxTaskDraft(
  currentDraft: InboxTaskDraft,
  previouslySaved: InboxTaskDraft,
  incomingSaved: InboxTaskDraft
) {
  return sameInboxTaskDraft(currentDraft, previouslySaved) ? incomingSaved : currentDraft
}

export function applyPendingInboxLifecycles(
  workItems: WorkItem[],
  pending: ReadonlyMap<string, WorkItem['lifecycle']>
) {
  if (!pending.size) return workItems
  return workItems.map((item) => {
    const lifecycle = pending.get(item.id)
    return lifecycle ? { ...item, lifecycle, attention: 'idle' as const } : item
  })
}

export function inboxTasks(workItems: WorkItem[], includeCompleted = false): InboxTaskItem[] {
  return workItems
    .filter((item) => item.lifecycle === 'open' || includeCompleted)
    .sort((left, right) => {
      const lifecyclePriority = (item: WorkItem) =>
        item.lifecycle === 'open' ? 0 : item.lifecycle === 'completed' ? 1 : 2
      return lifecyclePriority(left) - lifecyclePriority(right) || right.updatedAt - left.updatedAt
    })
    .map((workItem) => ({ workItem, taskKey: workItem.id }))
}

export function inboxTaskHref(item: Pick<InboxTaskItem, 'taskKey'>) {
  return `/inbox/?${new URLSearchParams({ item: item.taskKey }).toString()}`
}

export function formatInboxRelativeTime(timestamp: number, now = Date.now()) {
  const minutes = Math.max(1, Math.floor(Math.max(0, now - timestamp) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`
  return `${Math.floor(days / 365)}y`
}

export function selectedInboxTask(items: InboxTaskItem[], itemId: string | null) {
  return itemId ? (items.find((item) => item.taskKey === itemId) ?? null) : null
}

export function inboxSelectionAfterRemoval(
  items: InboxTaskItem[],
  selected: InboxTaskItem,
  removedKeys: ReadonlySet<string>
) {
  if (!removedKeys.has(selected.taskKey)) return selected
  const index = items.findIndex((item) => item.taskKey === selected.taskKey)
  const remaining = (item: InboxTaskItem) => !removedKeys.has(item.taskKey) && item.workItem.lifecycle === 'open'
  return items.slice(index + 1).find(remaining) ?? items.slice(0, index).findLast(remaining) ?? null
}

export function isInboxTaskUnread(item: InboxTaskItem, seenUpdatedAt?: number, manuallyUnread = false) {
  if (manuallyUnread) return true
  if (item.workItem.sources.at(-1)?.kind === 'manual') return false
  return seenUpdatedAt == null || item.workItem.updatedAt > seenUpdatedAt
}

export function composerAgent(value: string, fallback: AgentProvider): AgentProvider {
  const mention = value.match(/(?:^|\s)@(codex|claude)\b/i)?.[1]?.toLocaleLowerCase('en-US')
  return mention === 'codex' || mention === 'claude' ? mention : fallback
}

export function capitalizeAgentMentions(value: string) {
  return value.replace(/@(codex|claude)\b/gi, (_mention, provider: string) => {
    const normalized = provider.toLocaleLowerCase('en-US')
    return `@${normalized[0]?.toLocaleUpperCase('en-US')}${normalized.slice(1)}`
  })
}

export function composerAgentMention(value: string) {
  const match = value.match(/(?:^|\s)@([a-z]*)$/i)
  if (!match) return null
  const query = match[1] ?? ''
  return { start: value.length - query.length - 1, query: query.toLocaleLowerCase('en-US') }
}

export function replaceComposerAgentMention(value: string, provider: AgentProvider) {
  const mention = composerAgentMention(value)
  if (!mention) return value
  return `${value.slice(0, mention.start)}@${provider === 'claude' ? 'Claude' : 'Codex'} `
}

export function composerInstruction(value: string) {
  return value
    .replace(/(?:^|\s)@(codex|claude)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function buildInboxAgentPrompt(
  workItem: Pick<WorkItem, 'title' | 'description' | 'prompt' | 'aiSuggestion' | 'context' | 'returnPoint'>,
  composerValue: string
) {
  const instruction = composerInstruction(composerValue)
  const context = [workItem.description.trim(), workItem.context.trim()].filter(Boolean).join('\n')
  const { returnPoint } = workItem
  const handoff = [
    returnPoint?.lastMove.trim() ? `Waar het bleef: ${returnPoint.lastMove.trim()}` : '',
    returnPoint?.unresolved.trim() ? `Nog open: ${returnPoint.unresolved.trim()}` : '',
    returnPoint?.nextMove.trim() ? `Logische volgende stap: ${returnPoint.nextMove.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  const preparedInstruction = workItem.prompt.trim()
  return [
    `Werk aan dit werkitem: ${workItem.title.trim()}`,
    'Je bent de worker bij dit Inbox-item. Onderzoek ontbrekende informatie voordat je conclusies trekt. Lever het afgesproken resultaat met controleerbaar bewijs, bronnen of bestandslinks en benoem wat nog openstaat. Dit antwoord wordt het blijvende resultaat op het Inbox-item.',
    'Voer alleen het aangeboden AI-werk en de instructies van de gebruiker uit. Verzin geen voorbereiding, agenda of opties voor een menselijke taak. Claim niet dat je een fysieke handeling, afspraak, gesprek of persoonlijke beslissing voor de gebruiker hebt uitgevoerd. Als vervolgwerk op een antwoord of monitoring wacht, benoem de trigger en stopvoorwaarde. Claim alleen een actieve automation als een beschikbare tool die daadwerkelijk heeft aangemaakt; anders benoem de ontbrekende mogelijkheid.',
    'Schrijf het resultaat als een zelfstandig, actueel document voor de gebruiker, niet als een chatantwoord of werklog. Begin direct met het geleverde resultaat of de conclusie in één of twee zinnen; herhaal de taaktitel niet. Gebruik daarna alleen nuttige korte Markdown-secties: wat is opgeleverd, waarom deze aanpak, bewijs of bronnen, en wat nog openstaat. Schrijf concreet en rustig in de taal van de gebruiker. Laat lege secties en ceremonie weg.',
    'Pas het document aan het werk aan. Code: leg het veranderde gedrag en de afweging uit; geef echte verificatie, relevante screenshot- of opnameverwijzingen en alleen nuttige bestand- of PR-links. Onderzoek: geef bevindingen, afwegingen, bronlinks en onzekerheid. Voorbereiding: lever de briefing of agenda zelf, beslispunten en open vragen, met de onderbouwing. Een tekst, plan of ander document: lever het bruikbare werk zelf, met alleen de uitleg die helpt. Forceer nooit branches, impactlabels, diffs of technische testsecties bij niet-technisch werk.',
    'Bewijs moet ondersteunen wat je claimt: beschrijf wat een screenshot, opname, bron of controle daadwerkelijk aantoont en wat niet is gecontroleerd. Gebruik alleen bestaande, geverifieerde media- en bronverwijzingen; verzin geen links, tests of bewijs. Embed beschikbare lokale screenshots met Markdown; link naar andere bestanden of opnames. Publiceer niets voor deze documentatie. Bij vervolgwerk herschrijf je het complete resultaat tot één samenhangende huidige versie; eerdere antwoorden blijven als versies beschikbaar.',
    'Sluit je antwoord af met een fenced codeblock met taal remember-task-update en JSON: {"summary":"wat je daadwerkelijk hebt gedaan","remaining":"wat nog openstaat, of leeg","nextStep":"concrete volgende stap, of leeg","needsUser":false}. Zet needsUser op true als input, toestemming of een menselijke actie nodig is. Het antwoord boven dit blok is het zelfstandige artifact: resultaat, bewijs en beperkingen. Verzin geen verificatie of actieve monitoring.',
    context ? `Context:\n${context}` : '',
    handoff ? `Terugkeerpunt:\n${handoff}` : '',
    workItem.aiSuggestion?.trim() ? `Geaccepteerd AI-voorstel:\n${workItem.aiSuggestion.trim()}` : '',
    preparedInstruction ? `Voorbereide opdracht:\n${preparedInstruction}` : '',
    instruction ? `Bericht van de gebruiker:\n${instruction}` : 'Pak dit zelfstandig op en rapporteer het resultaat.',
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function inboxOriginSource(item: InboxTaskItem) {
  return item.workItem.sources.reduce<WorkItem['sources'][number] | undefined>(
    (origin, source) => (!origin || source.observedAt < origin.observedAt ? source : origin),
    undefined
  )
}

export function inboxSourceHref(item: InboxTaskItem) {
  const source = inboxOriginSource(item)
  if (!source?.workdayId) return null
  const conversation = source.conversationReference ?? source.conversationStartTime
  if (source.kind === 'meeting' && conversation) {
    return `/day/conversation/?${new URLSearchParams({
      id: source.workdayId,
      conversation,
    }).toString()}`
  }
  if (source.kind === 'observed') {
    return `/day/timeline/?${new URLSearchParams({
      id: source.workdayId,
      timelineAt: String(source.observedAt),
    }).toString()}`
  }
  return `/day/?${new URLSearchParams({ id: source.workdayId }).toString()}`
}

export function inboxReturnPoint(item: InboxTaskItem) {
  const { returnPoint } = item.workItem
  const latestObservation = item.workItem.observations
    .filter((observation) => observation.dismissedAt === null)
    .toSorted((left, right) => right.observedAt - left.observedAt)[0]
  const unresolved =
    returnPoint.unresolved.trim() && returnPoint.unresolved.trim() !== item.workItem.description.trim()
      ? returnPoint.unresolved.trim()
      : ''
  return {
    lastMove: returnPoint.lastMove.trim() || latestObservation?.summary.trim() || item.workItem.context.trim(),
    unresolved,
    nextMove: returnPoint.nextMove.trim() || item.workItem.prompt.trim(),
  }
}

function factEvent(fact: WorkItemFact): InboxActivityEvent {
  const type: InboxActivityEventType =
    fact.type === 'edited'
      ? 'revised'
      : fact.type === 'abandoned'
        ? 'dismissed'
        : fact.type === 'agent_started' || fact.type === 'agent_completed' || fact.type === 'agent_failed'
          ? 'delegated'
          : fact.type
  return { id: fact.id, type, at: fact.at, reason: fact.summary, actor: fact.actor }
}

export function inboxTaskEvents(item: InboxTaskItem): InboxActivityEvent[] {
  const facts = item.workItem.facts
    .filter((fact) => fact.type !== 'agent_started' && fact.type !== 'agent_completed')
    .map(factEvent)
  const observations = item.workItem.observations
    .filter((observation) => observation.dismissedAt === null)
    .map<InboxActivityEvent>((observation) => ({
      id: observation.id,
      type: 'revised',
      at: observation.observedAt,
      reason: observation.summary,
      actor: 'agent',
      observation,
    }))
  return [...facts, ...observations].sort((left, right) => left.at - right.at)
}

const INBOX_AGENT_TURN_STATUSES = {
  running: 'working',
  waiting_on_user: 'working',
  completed: 'complete',
  failed: 'error',
  cancelled: 'cancelled',
  stale: 'error',
} satisfies Record<WorkItemAgentSessionStatus, InboxAgentTurn['status']>

export function inboxAgentTurns(item: InboxTaskItem): InboxAgentTurn[] {
  return item.workItem.agentSessions.map((session) => ({
    id: session.id,
    provider: session.provider,
    at: session.startedAt,
    status: INBOX_AGENT_TURN_STATUSES[session.status],
    message: session.message || composerInstruction(session.instruction),
    response: session.response.trim(),
    durationMs: Math.max(0, session.durationMs ?? 0),
    steps: session.steps,
  }))
}
