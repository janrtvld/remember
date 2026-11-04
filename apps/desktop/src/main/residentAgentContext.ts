import { type CaptureState, type Day, redactSensitiveCaptureText, type WorkItem } from '@remember/shared'
import type { AnalysisEvidenceEntry } from './dailyReview/analysisContext'
import {
  type AgentEvidence,
  type AgentTaskProvenance,
  selectAgentEvidence,
  selectAgentTasks,
} from './residentAgentPrivacy'
import type { ResidentTaskSuggestion } from './residentAgentSuggestions'

export function residentAgentContext(input: {
  capture: Pick<
    CaptureState,
    | 'activeSessionId'
    | 'status'
    | 'pausedSources'
    | 'contextCaptureHealth'
    | 'contextCaptureLastEventAt'
    | 'microphoneLastChunkAt'
  >
  days: Pick<Day, 'id' | 'startedAt' | 'memory' | 'contextMoments' | 'appActivity'>[]
  tasks: Pick<
    WorkItem,
    | 'id'
    | 'title'
    | 'description'
    | 'lifecycle'
    | 'status'
    | 'dueAt'
    | 'priority'
    | 'updatedAt'
    | 'returnPoint'
    | 'sources'
  >[]
  evidence: AnalysisEvidenceEntry[]
  settings: Parameters<typeof selectAgentEvidence>[1]
  provenance?: AgentTaskProvenance
  suggestions?: ResidentTaskSuggestion[]
  resolveSuggestionEvidence?: (id: string) => AgentEvidence | null
  execution?: 'local' | 'remote'
  now?: number
}) {
  const now = input.now ?? Date.now()
  const day = input.days.find((entry) => entry.id === input.capture.activeSessionId) ?? input.days[0]
  const permittedTasks = selectAgentTasks(input.tasks, input)
  const recentTaskSuggestions = (input.suggestions ?? [])
    .filter((suggestion) => {
      if (!permittedTasks.some((task) => task.id === suggestion.taskId && task.lifecycle === 'open')) return false
      if (!suggestion.evidenceIds.length || !input.resolveSuggestionEvidence) return false
      return suggestion.evidenceIds.every((id) => {
        const evidence = input.resolveSuggestionEvidence?.(id)
        return evidence != null && selectAgentEvidence([evidence], input.settings).omittedCount === 0
      })
    })
    .slice(0, 3)
    .map(({ eventId, taskId, createdAt, text }) => ({ eventId, taskId, createdAt, text: text.slice(0, 1200) }))
  const tasks = [...permittedTasks]
    .sort((a, b) => Number(b.lifecycle === 'open') - Number(a.lifecycle === 'open') || b.updatedAt - a.updatedAt)
    .slice(0, 20)
  const recent = input.evidence
    .filter((entry) => ['screen-context', 'transcript'].includes(entry.kind) && entry.timestamp >= now - 30 * 60_000)
    .slice(-12)
    .map((entry) => ({
      kind: entry.kind === 'transcript' ? ('speech' as const) : ('context' as const),
      evidenceId: entry.evidenceId,
      timestamp: entry.timestamp,
      appName: entry.app,
      bundleId: day?.contextMoments.find((moment) => moment.id === entry.evidenceId)?.bundleId,
      windowTitle: entry.window,
      url: entry.url,
      text: entry.text,
      source: entry.source,
    }))
  const selected = selectAgentEvidence(recent, input.settings)
  const payload = {
    observedAt: now,
    execution:
      input.execution === 'remote' ? 'worker on the configured remote computer' : 'local worker on this computer',
    capture: {
      status: input.capture.status,
      pausedSources: input.capture.pausedSources,
      screenHealth: input.capture.contextCaptureHealth,
      screenLastEventAt: input.capture.contextCaptureLastEventAt,
      microphoneLastChunkAt: input.capture.microphoneLastChunkAt,
    },
    recentEvidence: selected.evidence.map((entry) => ({ ...entry, text: entry.text.slice(0, 1000) })),
    evidenceOmittedByPrivacy: selected.omittedCount,
    recentTaskSuggestions,
    tasks: tasks.map(({ id, title, description, lifecycle, status, dueAt, priority, updatedAt, returnPoint }) => ({
      id,
      title: title.slice(0, 300),
      description: description.slice(0, 700),
      lifecycle,
      status,
      dueAt,
      priority,
      updatedAt,
      nextStep: returnPoint.nextMove.slice(0, 500),
    })),
    day: day
      ? {
          id: day.id,
          startedAt: day.startedAt,
          summaryThrough: day.memory?.coveredThrough ?? null,
        }
      : null,
    limits: {
      taskCount: input.tasks.length,
      includedTaskCount: tasks.length,
      tasksOmittedWithoutPermittedProvenance: input.tasks.length - permittedTasks.length,
      rawAudioAndScreenshotsIncluded: false,
    },
  }
  while (JSON.stringify(payload).length > 38_000) {
    if (payload.recentEvidence.length) payload.recentEvidence.shift()
    else if (payload.tasks.length) payload.tasks.pop()
    else if (payload.recentTaskSuggestions.length) payload.recentTaskSuggestions.pop()
    else break
  }
  payload.limits.includedTaskCount = payload.tasks.length
  return redactSensitiveCaptureText(JSON.stringify(payload))
}
