import { selectAgentTasks } from '../residentAgentPrivacy'
import { getSettings } from '../settings'
import { dayAnalysisProvenancePermitted } from './dayAnalysisProvenance'
import type { EvidenceStore } from './evidenceStore'
import { DAY_MS, summarizeUserActivity, USER_ACTIVITY_WINDOW_DAYS, type UserActivityPatterns } from './userActivity'

/** Read the patterns from the local store, leaving out Day summaries and Tasks the agent may no longer use. */
export function readUserActivity(store: EvidenceStore, now = Date.now()): UserActivityPatterns | null {
  const settings = getSettings()
  const days = store.readActivityDays(now - USER_ACTIVITY_WINDOW_DAYS * DAY_MS).map((day) => ({
    ...day,
    memory:
      day.memory?.analysisProvenance && dayAnalysisProvenancePermitted(day.memory.analysisProvenance, store, settings)
        ? day.memory
        : null,
  }))
  const items = selectAgentTasks(store.listWorkItems(), {
    contextEvidence: (workdayId, observedAt) => store.readTaskContextEvidence(workdayId, observedAt),
    settings,
    provenance: store.ambientTasks,
  })
  return summarizeUserActivity({
    days,
    items,
    now,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  })
}
