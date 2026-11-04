import type { Day } from './index'

export type DaySnapshot = { revision: number; days: Day[] }
export type DayArrayPatch<T> = { start: number; items: T[] }
export type DayChange = {
  day: Omit<Day, 'moments' | 'appActivity' | 'contextMoments'>
  moments?: DayArrayPatch<Day['moments'][number]>
  appActivity?: DayArrayPatch<Day['appActivity'][number]>
  contextMoments?: DayArrayPatch<Day['contextMoments'][number]>
}
export type DayChanges = {
  baseRevision: number
  revision: number
  order: string[]
  changes: DayChange[]
}

const projectionKeys = new Set<keyof Day>([
  'ongoingConversations',
  'conversationCandidates',
  'recoverableConversationBlocks',
  'retainedAudioMomentIds',
])

function arrayPatch<T>(previous: T[] | undefined, next: T[]): DayArrayPatch<T> | undefined {
  if (previous === next) return undefined
  let start = 0
  while (previous && start < previous.length && start < next.length && previous[start] === next[start]) start++
  if (previous && start === previous.length && start === next.length) return undefined
  return { start, items: next.slice(start) }
}

function sameMetadata(previous: Day, next: DayChange['day']) {
  const { moments: _moments, appActivity: _activity, contextMoments: _contexts, ...metadata } = previous
  const keys = Object.keys(metadata) as Array<keyof DayChange['day']>
  return (
    keys.length === Object.keys(next).length &&
    keys.every(
      (key) =>
        metadata[key] === next[key] ||
        (projectionKeys.has(key) && JSON.stringify(metadata[key]) === JSON.stringify(next[key]))
    )
  )
}

// Captured arrays and their entries are immutable. Only their changed suffix crosses IPC.
export function buildDayChanges(previous: DaySnapshot, nextDays: Day[]): DayChanges | null {
  const byId = new Map(previous.days.map((day) => [day.id, day]))
  const changes: DayChange[] = []
  for (const next of nextDays) {
    const existing = byId.get(next.id)
    if (existing === next) continue
    const { moments, appActivity, contextMoments, ...day } = next
    const momentPatch = arrayPatch(existing?.moments, moments)
    const activityPatch = arrayPatch(existing?.appActivity, appActivity)
    const contextPatch = arrayPatch(existing?.contextMoments, contextMoments)
    if (!momentPatch && !activityPatch && !contextPatch && existing && sameMetadata(existing, day)) continue
    changes.push({
      day,
      ...(momentPatch ? { moments: momentPatch } : {}),
      ...(activityPatch ? { appActivity: activityPatch } : {}),
      ...(contextPatch ? { contextMoments: contextPatch } : {}),
    })
  }
  const order = nextDays.map((day) => day.id)
  if (
    !changes.length &&
    order.length === previous.days.length &&
    order.every((id, index) => previous.days[index]?.id === id)
  )
    return null
  return { baseRevision: previous.revision, revision: previous.revision + 1, order, changes }
}

function applyArrayPatch<T>(previous: T[] | undefined, patch: DayArrayPatch<T> | undefined): T[] | null {
  if (!patch) return previous ?? null
  if (!Number.isInteger(patch.start) || patch.start < 0 || patch.start > (previous?.length ?? 0)) return null
  return [...(previous?.slice(0, patch.start) ?? []), ...patch.items]
}

export function applyDayChanges(snapshot: DaySnapshot, update: DayChanges): DaySnapshot | null {
  if (update.revision <= snapshot.revision) return snapshot
  if (update.baseRevision !== snapshot.revision || update.revision !== update.baseRevision + 1) return null
  const order = new Set(update.order)
  if (order.size !== update.order.length) return null
  const byId = new Map(snapshot.days.map((day) => [day.id, day]))
  const changed = new Set<string>()
  for (const change of update.changes) {
    const id = change.day.id
    if (!order.has(id) || changed.has(id)) return null
    changed.add(id)
    const previous = byId.get(id)
    const moments = applyArrayPatch(previous?.moments, change.moments)
    const appActivity = applyArrayPatch(previous?.appActivity, change.appActivity)
    const contextMoments = applyArrayPatch(previous?.contextMoments, change.contextMoments)
    if (!moments || !appActivity || !contextMoments) return null
    byId.set(id, { ...change.day, moments, appActivity, contextMoments })
  }
  const days: Day[] = []
  for (const id of update.order) {
    const day = byId.get(id)
    if (!day) return null
    days.push(day)
  }
  return { revision: update.revision, days }
}
