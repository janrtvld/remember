import type {
  ConversationSummary,
  DailyReviewCalendarBlock,
  DayMemory,
  GeneratedDayTaskChange,
  OpenTask,
  ProjectAttention,
  WikiPageUpdate,
} from '@remember/shared'
import { createAgentError } from './agentErrors'
import { normalizeResponseValue, parseClaudeResponse, parseJsonResponse, responseShape } from './agentResponse'

const WIKI_PAGE_SLUG_PATTERN =
  /^(?:projects|decisions|research|people|processes|concepts)\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/

export type ShardAnalysis = {
  range: string
  facts: string[]
  activities: string[]
  audioConversations: string[]
  outcomes: string[]
  decisions: string[]
  actionPoints: string[]
  openLoops: string[]
}

function timeInMinutes(value: string, allowEndOfDay = false) {
  if (allowEndOfDay && value === '24:00') return 24 * 60
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value)
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

function isCalendarBlock(value: unknown): value is DailyReviewCalendarBlock {
  if (!value || typeof value !== 'object') return false
  const block = value as Partial<DailyReviewCalendarBlock>
  if (
    typeof block.startTime !== 'string' ||
    typeof block.endTime !== 'string' ||
    typeof block.title !== 'string' ||
    typeof block.description !== 'string'
  ) {
    return false
  }
  const start = timeInMinutes(block.startTime)
  const end = timeInMinutes(block.endTime, true)
  return start != null && end != null && end > start
}

function normalizedTimelineDetails(block: DailyReviewCalendarBlock) {
  const start = timeInMinutes(block.startTime) ?? 0
  const end = timeInMinutes(block.endTime, true) ?? start
  return normalizeCollection(block.details)
    .flatMap((value) => {
      if (!value || typeof value !== 'object') return []
      const detail = value as { at?: unknown; text?: unknown }
      if (typeof detail.at !== 'string' || typeof detail.text !== 'string') return []
      const at = timeInMinutes(detail.at)
      const text = detail.text.trim()
      if (at == null || at < start || at > end || !text) return []
      return [{ at: detail.at, text }]
    })
    .sort((first, second) => (timeInMinutes(first.at) ?? 0) - (timeInMinutes(second.at) ?? 0))
    .slice(0, 6)
}

function isConversationSummary(value: unknown): value is ConversationSummary {
  if (!value || typeof value !== 'object') return false
  const conversation = value as Partial<ConversationSummary>
  return (
    typeof conversation.startTime === 'string' &&
    typeof conversation.endTime === 'string' &&
    timeInMinutes(conversation.startTime) != null &&
    timeInMinutes(conversation.endTime, true) != null &&
    (timeInMinutes(conversation.endTime, true) ?? 0) > (timeInMinutes(conversation.startTime) ?? 0) &&
    typeof conversation.title === 'string' &&
    typeof conversation.description === 'string'
  )
}

function isProjectAttention(value: unknown): value is ProjectAttention {
  if (!value || typeof value !== 'object') return false
  const attention = value as Partial<ProjectAttention>
  return (
    typeof attention.project === 'string' &&
    typeof attention.durationMinutes === 'number' &&
    Number.isFinite(attention.durationMinutes) &&
    attention.durationMinutes > 0 &&
    (attention.description == null || typeof attention.description === 'string')
  )
}

function isOpenTask(value: unknown): value is OpenTask {
  if (!value || typeof value !== 'object') return false
  const task = value as Partial<OpenTask>
  const source = task.source
  if (
    typeof task.title !== 'string' ||
    typeof task.description !== 'string' ||
    !source ||
    typeof source.label !== 'string' ||
    !source.label.trim() ||
    typeof source.detail !== 'string' ||
    !source.detail.trim()
  ) {
    return false
  }
  if (source.kind === 'conversation') {
    return (
      typeof source.conversationStartTime === 'string' && timeInMinutes(source.conversationStartTime.trim()) != null
    )
  }
  return source.kind === 'task' && typeof source.evidenceId === 'string' && Boolean(source.evidenceId.trim())
}

function isGeneratedTaskChange(value: unknown): value is GeneratedDayTaskChange {
  if (!value || typeof value !== 'object') return false
  const change = value as Partial<GeneratedDayTaskChange>
  return (
    typeof change.id === 'string' &&
    Boolean(change.id.trim()) &&
    typeof change.title === 'string' &&
    (change.type === 'completed' || change.type === 'removed' || change.type === 'superseded') &&
    typeof change.reason === 'string' &&
    (change.replacementTitle == null || typeof change.replacementTitle === 'string')
  )
}

function normalizeOpenTask(task: OpenTask) {
  const title = task.title.trim()
  const description = task.description.trim()
  const prompt = typeof task.prompt === 'string' ? task.prompt.trim() : ''
  const context = typeof task.context === 'string' ? task.context.trim() : ''
  const returnPoint = task.returnPoint
  const normalizedReturnPoint =
    returnPoint &&
    typeof returnPoint.lastMove === 'string' &&
    typeof returnPoint.unresolved === 'string' &&
    typeof returnPoint.nextMove === 'string'
      ? {
          lastMove: returnPoint.lastMove.trim(),
          unresolved: returnPoint.unresolved.trim(),
          nextMove: returnPoint.nextMove.trim(),
        }
      : undefined
  const source = task.source
  const normalizedSource =
    source?.kind === 'conversation'
      ? {
          kind: source.kind,
          label: source.label.trim(),
          detail: source.detail.trim(),
          conversationStartTime: source.conversationStartTime?.trim(),
        }
      : source?.kind === 'task'
        ? {
            kind: source.kind,
            label: source.label.trim(),
            detail: source.detail.trim(),
            evidenceId: source.evidenceId?.trim(),
          }
        : undefined

  return {
    ...(typeof task.id === 'string' && task.id.trim() ? { id: task.id.trim() } : {}),
    title,
    ...(task.titleChangeReason === 'outcome' ? { titleChangeReason: 'outcome' as const } : {}),
    description,
    ...(prompt ? { prompt } : {}),
    ...(task.aiSuggestion !== undefined
      ? { aiSuggestion: typeof task.aiSuggestion === 'string' ? task.aiSuggestion.trim() || null : null }
      : {}),
    ...(context ? { context } : {}),
    ...(normalizedReturnPoint ? { returnPoint: normalizedReturnPoint } : {}),
    ...(normalizedSource ? { source: normalizedSource } : {}),
    ...(task.completed === true ? { completed: true } : {}),
  }
}

function isWikiPageUpdate(value: unknown): value is WikiPageUpdate {
  if (!value || typeof value !== 'object') return false
  const update = value as {
    slug?: unknown
    title?: unknown
    content?: unknown
    summary?: unknown
    changeType?: unknown
    suggestedSpaceId?: unknown
  }
  return (
    typeof update.slug === 'string' &&
    WIKI_PAGE_SLUG_PATTERN.test(update.slug) &&
    typeof update.title === 'string' &&
    (update.content == null || typeof update.content === 'string') &&
    typeof update.summary === 'string' &&
    (update.changeType === 'created' || update.changeType === 'updated') &&
    (update.suggestedSpaceId == null || typeof update.suggestedSpaceId === 'string')
  )
}

function normalizeDayMemory(value: unknown): Omit<DayMemory, 'refreshedAt' | 'coveredThrough'> {
  if (!value || typeof value !== 'object') {
    throw createAgentError(
      'agent-invalid-response',
      `Final response root was ${responseShape(value)}; expected object.`
    )
  }
  const memory = value as Partial<DayMemory>
  if (typeof memory.summary !== 'string') {
    throw createAgentError(
      'agent-invalid-response',
      `Final response was ${responseShape(value)}; summary was ${responseShape(memory.summary)}.`
    )
  }
  const outcomes = normalizeStringList(memory.outcomes)
  const openTasks = normalizeCollection(memory.openTasks)
  const taskChanges = normalizeCollection(memory.taskChanges)
  const projectAttention = normalizeCollection(memory.projectAttention)
  const knowledgeSuggestions = normalizeCollection(memory.knowledgeSuggestions)
  const conversations = normalizeCollection(memory.conversations)
  const timeline = normalizeCollection(memory.timeline)
  const validOpenTasks = openTasks.filter(isOpenTask)
  const normalizedOpenTasks = validOpenTasks.map(normalizeOpenTask).filter((task) => task.title)
  return {
    summary: memory.summary.trim(),
    currentFocus:
      typeof memory.currentFocus === 'string' &&
      normalizedOpenTasks.some(
        (task) => task.title.toLocaleLowerCase() === memory.currentFocus?.trim().toLocaleLowerCase()
      )
        ? memory.currentFocus.trim()
        : null,
    outcomes: outcomes
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 4),
    decisions: [],
    openLoops: normalizedOpenTasks.map((task) => task.title),
    openTasks: normalizedOpenTasks,
    taskChanges: taskChanges
      .filter(isGeneratedTaskChange)
      .map((change) => ({
        id: change.id.trim(),
        title: change.title.trim(),
        type: change.type,
        reason: change.reason.trim(),
        ...(change.replacementTitle?.trim() ? { replacementTitle: change.replacementTitle.trim() } : {}),
      }))
      .filter((change) => change.id && change.title && change.reason),
    projectAttention: projectAttention
      .filter(isProjectAttention)
      .map((attention) => ({
        project: attention.project.trim(),
        durationMinutes: Math.round(attention.durationMinutes),
        description: attention.description?.trim() ?? '',
      }))
      .filter((attention) => attention.project && attention.durationMinutes > 0)
      .sort((first, second) => second.durationMinutes - first.durationMinutes)
      .slice(0, 5),
    conversations: conversations
      .filter(isConversationSummary)
      .map((conversation) => ({
        startTime: conversation.startTime,
        endTime: conversation.endTime,
        title: conversation.title.trim(),
        description: conversation.description.trim(),
        summary:
          (typeof conversation.summary === 'string' ? conversation.summary.trim() : '') ||
          conversation.description.trim(),
        actionPoints: normalizeStringList(conversation.actionPoints).slice(0, 5),
      }))
      .filter((conversation) => conversation.title && conversation.description)
      .sort((first, second) => (timeInMinutes(first.startTime) ?? 0) - (timeInMinutes(second.startTime) ?? 0))
      .slice(0, 6),
    knowledgeSuggestions: normalizeWikiPageUpdates(knowledgeSuggestions, 4),
    timeline: timeline
      .filter(isCalendarBlock)
      .map((block) => ({
        startTime: block.startTime,
        endTime: block.endTime,
        title: block.title.trim(),
        description: block.description.trim(),
        details: normalizedTimelineDetails(block),
      }))
      .filter((block) => block.title)
      .sort((first, second) => (timeInMinutes(first.startTime) ?? 0) - (timeInMinutes(second.startTime) ?? 0))
      .slice(0, 12),
  }
}

export function normalizeWikiPageUpdates(value: unknown, limit: number) {
  return normalizeCollection(value)
    .filter(isWikiPageUpdate)
    .map((update) => ({
      slug: update.slug,
      title: update.title.trim(),
      ...(typeof update.content === 'string' && update.content.trim() ? { content: update.content.trim() } : {}),
      summary: update.summary.trim(),
      changeType: update.changeType,
      suggestedSpaceId:
        typeof update.suggestedSpaceId === 'string' && update.suggestedSpaceId.trim()
          ? update.suggestedSpaceId.trim()
          : null,
    }))
    .filter((update) => update.title && update.summary)
    .slice(0, limit)
}

export function parseDayMemory(output: string) {
  return normalizeDayMemory(parseJsonResponse(output))
}

export function parseClaudeDayMemory(output: string) {
  return normalizeDayMemory(parseClaudeResponse(output))
}

export function parseShardAnalysis(output: string) {
  return normalizeShardAnalysis(parseJsonResponse(output))
}

export function parseClaudeShardAnalysis(output: string) {
  return normalizeShardAnalysis(parseClaudeResponse(output))
}

function normalizeShardAnalysis(value: unknown): ShardAnalysis {
  if (!value || typeof value !== 'object') {
    throw createAgentError(
      'agent-invalid-response',
      `Shard response root was ${responseShape(value)}; expected object.`
    )
  }
  const analysis = value as Partial<ShardAnalysis>
  const invalidFields = [
    ...(typeof analysis.range === 'string' ? [] : ['range']),
    ...(['facts', 'activities', 'audioConversations', 'outcomes', 'decisions', 'actionPoints', 'openLoops'] as const)
      .filter((field) => typeof analysis[field] !== 'string' && !Array.isArray(analysis[field]))
      .map((field) => field),
  ]
  if (invalidFields.length) {
    throw createAgentError(
      'agent-invalid-response',
      `Shard response was ${responseShape(value)}; invalid or missing fields: ${invalidFields.join(',')}.`
    )
  }
  return {
    range: typeof analysis.range === 'string' ? analysis.range.trim() : '',
    facts: normalizeStringList(analysis.facts),
    activities: normalizeStringList(analysis.activities),
    audioConversations: normalizeStringList(analysis.audioConversations),
    outcomes: normalizeStringList(analysis.outcomes),
    decisions: normalizeStringList(analysis.decisions),
    actionPoints: normalizeStringList(analysis.actionPoints),
    openLoops: normalizeStringList(analysis.openLoops),
  }
}

function normalizeStringList(value: unknown): string[] {
  const normalized = normalizeResponseValue(value)
  if (typeof normalized === 'string') return normalized.trim() ? [normalized.trim()] : []
  if (!Array.isArray(normalized)) return []
  return normalized
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
}

function normalizeCollection(value: unknown): unknown[] {
  const normalized = normalizeResponseValue(value)
  if (Array.isArray(normalized)) return normalized
  return normalized && typeof normalized === 'object' ? [normalized] : []
}
