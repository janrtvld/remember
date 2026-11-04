import type { WorkItem } from '@remember/shared'

export type InboxPreviewTask = {
  workItem: WorkItem
  taskKey: string
}

export function inboxTasks(workItems: WorkItem[], includeCompleted = false): InboxPreviewTask[] {
  return workItems
    .filter((item) => item.lifecycle === 'open' || includeCompleted)
    .sort((left, right) => {
      const lifecyclePriority = (item: WorkItem) =>
        item.lifecycle === 'open' ? 0 : item.lifecycle === 'completed' ? 1 : 2
      return lifecyclePriority(left) - lifecyclePriority(right) || right.updatedAt - left.updatedAt
    })
    .map((workItem) => ({ workItem, taskKey: workItem.id }))
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

export function selectedInboxTask(items: InboxPreviewTask[], itemId: string | null) {
  return itemId ? (items.find((item) => item.taskKey === itemId) ?? null) : null
}

export function inboxReturnPoint(item: InboxPreviewTask) {
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
