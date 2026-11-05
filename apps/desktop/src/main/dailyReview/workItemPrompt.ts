import type { WorkItem } from '@remember/shared'

export const GENERATED_TASK_DESCRIPTION_CHARACTER_LIMIT = 600

export const WORK_ITEM_PROMPT_CHARACTER_BUDGET = 48_000
const WORK_ITEM_PROMPT_TOKEN_BUDGET = 12_000
const ESTIMATED_CHARACTERS_PER_TOKEN = 4
const RECENT_TERMINAL_ITEM_LIMIT = 24

export type PromptWorkItem = Pick<
  WorkItem,
  | 'id'
  | 'title'
  | 'description'
  | 'lifecycle'
  | 'status'
  | 'attention'
  | 'closedAt'
  | 'updatedAt'
  | 'userEditedTitle'
  | 'userEditedDescription'
> &
  Partial<Pick<WorkItem, 'prompt' | 'aiSuggestion' | 'context' | 'returnPoint'>> & {
    observations?: Pick<WorkItem['observations'][number], 'kind' | 'summary' | 'confidence' | 'observedAt'>[]
    agentSessions?: Pick<WorkItem['agentSessions'][number], 'status' | 'instruction' | 'updatedAt'>[]
    userFacts?: Pick<WorkItem['facts'][number], 'type' | 'summary' | 'at'>[]
  }

function bounded(value: string, limit: number) {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}

function taskState(item: WorkItem, detailLimit: number) {
  if (item.lifecycle !== 'open') return {}
  const observations = [
    ...new Map(
      item.observations
        .filter((entry) => entry.dismissedAt === null)
        .sort((first, second) => first.observedAt - second.observedAt)
        .map((entry) => [entry.kind, entry])
    ).values(),
  ]
    .sort((first, second) => second.observedAt - first.observedAt)
    .map(({ kind, summary, confidence, observedAt }) => ({
      kind,
      summary: bounded(summary, detailLimit),
      confidence,
      observedAt,
    }))
  const agentSessions = item.agentSessions
    .filter((session) => session.status === 'running' || session.status === 'waiting_on_user')
    .sort((first, second) => second.updatedAt - first.updatedAt)
    .slice(0, 2)
    .map(({ status, instruction, updatedAt }) => ({
      status,
      instruction: bounded(instruction, detailLimit),
      updatedAt,
    }))
  const userFacts = item.facts
    .filter((fact) => fact.actor === 'user' && ['created', 'edited', 'reopened'].includes(fact.type))
    .sort((first, second) => second.at - first.at)
    .slice(0, 1)
    .map(({ type, summary, at }) => ({ type, summary: bounded(summary, detailLimit), at }))
  return {
    ...(observations.length ? { observations } : {}),
    ...(agentSessions.length ? { agentSessions } : {}),
    ...(userFacts.length ? { userFacts } : {}),
  }
}

function actionableProjection(item: WorkItem): PromptWorkItem {
  return {
    id: item.id,
    title: bounded(item.title, 240),
    description: bounded(item.description, GENERATED_TASK_DESCRIPTION_CHARACTER_LIMIT),
    prompt: bounded(item.prompt, 1_200),
    aiSuggestion: item.aiSuggestion ? bounded(item.aiSuggestion, 240) : null,
    context: bounded(item.context, 2_400),
    returnPoint: {
      lastMove: bounded(item.returnPoint.lastMove, 600),
      unresolved: bounded(item.returnPoint.unresolved, 600),
      nextMove: bounded(item.returnPoint.nextMove, 600),
    },
    lifecycle: item.lifecycle,
    status: item.status,
    attention: item.attention,
    closedAt: item.closedAt,
    updatedAt: item.updatedAt,
    userEditedTitle: item.userEditedTitle,
    userEditedDescription: item.userEditedDescription,
    ...taskState(item, 320),
  }
}

function identityProjection(item: WorkItem): PromptWorkItem {
  return {
    id: item.id,
    title: bounded(item.title, 240),
    description: bounded(
      item.description,
      item.lifecycle === 'open' ? GENERATED_TASK_DESCRIPTION_CHARACTER_LIMIT : 320
    ),
    lifecycle: item.lifecycle,
    status: item.status,
    attention: item.attention,
    closedAt: item.closedAt,
    updatedAt: item.updatedAt,
    userEditedTitle: item.userEditedTitle,
    userEditedDescription: item.userEditedDescription,
  }
}

export function workItemsForPrompt(items: WorkItem[]) {
  const open = items
    .filter((item) => item.lifecycle === 'open')
    .sort(
      (first, second) =>
        Number(second.attention !== 'idle') - Number(first.attention !== 'idle') ||
        Number(second.status === 'in_progress') - Number(first.status === 'in_progress') ||
        second.updatedAt - first.updatedAt
    )
  const terminal = items
    .filter((item) => item.lifecycle !== 'open')
    .sort((first, second) => (second.closedAt ?? second.updatedAt) - (first.closedAt ?? first.updatedAt))
    .slice(0, RECENT_TERMINAL_ITEM_LIMIT)
  const characterBudget = Math.min(
    WORK_ITEM_PROMPT_CHARACTER_BUDGET,
    WORK_ITEM_PROMPT_TOKEN_BUDGET * ESTIMATED_CHARACTERS_PER_TOKEN
  )
  const projected: PromptWorkItem[] = []
  let usedCharacters = 2

  const append = (candidate: PromptWorkItem) => {
    const serialized = JSON.stringify(candidate)
    const nextSize = usedCharacters + (projected.length ? 1 : 0) + serialized.length
    if (nextSize > characterBudget) return false
    projected.push(candidate)
    usedCharacters = nextSize
    return true
  }

  const openIdentities = open.map(identityProjection)
  for (const [index, item] of open.entries()) {
    const identity = openIdentities[index]
    if (!identity) break
    const actionable = actionableProjection(item)
    const remainingIdentities = openIdentities.slice(index + 1)
    if (JSON.stringify([...projected, actionable, ...remainingIdentities]).length <= characterBudget) {
      append(actionable)
    } else {
      const compact = { ...identity, ...taskState(item, 160) }
      append(
        JSON.stringify([...projected, compact, ...remainingIdentities]).length <= characterBudget ? compact : identity
      )
    }
  }
  for (const item of terminal) append(identityProjection(item))
  return projected
}
