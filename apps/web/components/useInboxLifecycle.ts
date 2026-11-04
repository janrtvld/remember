'use client'

import type { WorkItem } from '@remember/shared'
import { useCallback, useMemo, useRef, useState } from 'react'
import { applyPendingInboxLifecycles, type InboxTaskItem } from './inboxTasks'

export function useInboxLifecycle(workItems: WorkItem[], upsertWorkItem: (item: WorkItem) => void) {
  const [pending, setPending] = useState<ReadonlyMap<string, WorkItem['lifecycle']>>(new Map())
  const pendingRef = useRef(new Set<string>())
  const [failed, setFailed] = useState(false)
  const items = useMemo(() => applyPendingInboxLifecycles(workItems, pending), [workItems, pending])

  const setLifecycle = useCallback(
    async (targets: InboxTaskItem[], lifecycle: WorkItem['lifecycle']) => {
      const changed = targets.filter(
        (item) => item.workItem.lifecycle !== lifecycle && !pendingRef.current.has(item.taskKey)
      )
      if (!changed.length) return []
      for (const item of changed) pendingRef.current.add(item.taskKey)
      setFailed(false)
      setPending((current) => new Map([...current, ...changed.map((item) => [item.taskKey, lifecycle] as const)]))

      const results = await Promise.all(
        changed.map(async (item) => {
          try {
            const saved = await window.remember.setWorkItemLifecycle(item.taskKey, lifecycle)
            upsertWorkItem(saved)
            return null
          } catch {
            setFailed(true)
            return item.taskKey
          } finally {
            pendingRef.current.delete(item.taskKey)
            setPending((current) => {
              const next = new Map(current)
              next.delete(item.taskKey)
              return next
            })
          }
        })
      )
      return results.filter((id): id is string => id !== null)
    },
    [upsertWorkItem]
  )

  return { items, pending, failed, setLifecycle }
}
