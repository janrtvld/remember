import type { DayAnalysisProvenance, WorkItem } from '@remember/shared'
import { type AgentEvidence, agentEvidencePermitted, selectAgentTasks } from '../residentAgentPrivacy'
import type { EvidenceStore } from './evidenceStore'
import type { ProactiveSource } from './proactiveStore'

export type DayAnalysisValidation = {
  permittedTasks(): readonly WorkItem[]
  permittedTaskIds(): ReadonlySet<string>
  evidencePermitted(evidence: readonly AgentEvidence[]): boolean
  daySourcePermitted(source: Pick<ProactiveSource, 'kind' | 'sourceId'>): boolean
  summaryPermitted(provenance: DayAnalysisProvenance): boolean
}

/** Reuse exact inputs only during one synchronous access check. */
export function withDayAnalysisValidation<T>(
  store: Pick<EvidenceStore, 'proactive' | 'listWorkItems' | 'readTaskContextEvidence' | 'ambientTasks'>,
  settings: Parameters<typeof agentEvidencePermitted>[1],
  checks: {
    wikiPage(page: DayAnalysisProvenance['wikiPages'][number]): boolean
    agentMessages(provenance: DayAnalysisProvenance): boolean
  },
  operation: (validation: DayAnalysisValidation) => T
): T {
  let active = true
  let tasks: WorkItem[] | undefined
  let taskIds: Set<string> | undefined
  const raw = new Map<string, boolean>()
  const rawKeys = new WeakMap<DayAnalysisProvenance['rawSources'], string>()
  const wiki = new Map<string, boolean>()
  const taskContexts = new Map<string, ReturnType<typeof store.readTaskContextEvidence>>()
  let evidenceAccess = new WeakMap<AgentEvidence, boolean>()
  const policy = JSON.stringify(settings)
  const assertActive = () => {
    if (!active) throw new Error('day-analysis-validation-scope-closed')
  }
  const permittedTasks = () => {
    assertActive()
    tasks ??= selectAgentTasks(store.listWorkItems(), {
      contextEvidence: (workdayId, observedAt) => {
        const key = JSON.stringify([workdayId, observedAt])
        let evidence = taskContexts.get(key)
        if (!evidence) {
          evidence = store.readTaskContextEvidence(workdayId, observedAt)
          taskContexts.set(key, evidence)
        }
        return evidence
      },
      settings,
      provenance: store.ambientTasks,
    })
    return tasks
  }
  const permittedTaskIds = () => {
    assertActive()
    taskIds ??= new Set(permittedTasks().map((item) => item.id))
    return taskIds
  }
  const evidencePermitted = (evidence: readonly AgentEvidence[]) => {
    assertActive()
    return evidence.every((entry) => {
      if (!evidenceAccess.has(entry)) evidenceAccess.set(entry, agentEvidencePermitted(entry, settings))
      return evidenceAccess.get(entry) === true
    })
  }
  const summaryPermitted = (provenance: DayAnalysisProvenance) => {
    assertActive()
    if (provenance.version !== 1) return false
    let key = rawKeys.get(provenance.rawSources)
    if (key === undefined) {
      key = JSON.stringify(provenance.rawSources)
      rawKeys.set(provenance.rawSources, key)
    }
    if (!raw.has(key)) {
      raw.set(
        key,
        store.proactive.dayAnalysisSourcesPermitted(provenance.rawSources, policy, (entry) =>
          agentEvidencePermitted(entry, settings)
        )
      )
    }
    if (!raw.get(key) || provenance.taskIds.some((id) => !permittedTaskIds().has(id))) return false
    for (const page of provenance.wikiPages) {
      const key = JSON.stringify(page)
      if (!wiki.has(key)) wiki.set(key, checks.wikiPage(page))
      if (!wiki.get(key)) return false
    }
    return !provenance.agentMessages.length || checks.agentMessages(provenance)
  }
  const daySourcePermitted = (source: Pick<ProactiveSource, 'kind' | 'sourceId'>) => {
    assertActive()
    return store.proactive.daySourceLineagePermitted(source, policy, (entry) => agentEvidencePermitted(entry, settings))
  }
  try {
    const result = operation({
      permittedTasks,
      permittedTaskIds,
      evidencePermitted,
      daySourcePermitted,
      summaryPermitted,
    })
    if (result && typeof (result as { then?: unknown }).then === 'function')
      throw new Error('day-analysis-validation-must-be-synchronous')
    return result
  } finally {
    active = false
    tasks = undefined
    taskIds = undefined
    evidenceAccess = new WeakMap()
    raw.clear()
    wiki.clear()
    taskContexts.clear()
  }
}
