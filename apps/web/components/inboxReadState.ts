export type InboxReadState = {
  version: 1
  seenUpdatedAtByTask: Record<string, number>
  manuallyUnreadTaskKeys: string[]
}

export function parseInboxReadState(value: unknown): InboxReadState | null {
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1) return null
  if (
    !('seenUpdatedAtByTask' in value) ||
    !value.seenUpdatedAtByTask ||
    typeof value.seenUpdatedAtByTask !== 'object' ||
    Array.isArray(value.seenUpdatedAtByTask)
  )
    return null
  const manuallyUnread = 'manuallyUnreadTaskKeys' in value ? value.manuallyUnreadTaskKeys : []
  return {
    version: 1,
    seenUpdatedAtByTask: Object.fromEntries(
      Object.entries(value.seenUpdatedAtByTask).filter(
        (entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])
      )
    ),
    manuallyUnreadTaskKeys: Array.isArray(manuallyUnread)
      ? [...new Set(manuallyUnread.filter((key): key is string => typeof key === 'string' && key.length > 0))]
      : [],
  }
}

export function markInboxTasksUnread(state: InboxReadState, taskKeys: readonly string[]): InboxReadState {
  const manuallyUnreadTaskKeys = [...new Set([...state.manuallyUnreadTaskKeys, ...taskKeys])]
  return manuallyUnreadTaskKeys.length === state.manuallyUnreadTaskKeys.length
    ? state
    : { ...state, manuallyUnreadTaskKeys }
}

export function markInboxTaskRead(
  state: InboxReadState,
  taskKey: string,
  updatedAt: number,
  explicit = false
): InboxReadState {
  const manuallyUnread = state.manuallyUnreadTaskKeys.includes(taskKey)
  if (manuallyUnread && !explicit) return state
  if (!manuallyUnread && state.seenUpdatedAtByTask[taskKey] === updatedAt) return state
  return {
    ...state,
    seenUpdatedAtByTask: { ...state.seenUpdatedAtByTask, [taskKey]: updatedAt },
    manuallyUnreadTaskKeys: state.manuallyUnreadTaskKeys.filter((key) => key !== taskKey),
  }
}
