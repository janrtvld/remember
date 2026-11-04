import type { GeneratedDayTaskChange, OpenTask } from '@remember/shared'

/** Ephemeral Inbox output from a Day analysis. WorkItem is the only persisted lifecycle. */
export interface AnalyzedWorkItemPlan {
  proposed: OpenTask[]
  changes: GeneratedDayTaskChange[]
}
