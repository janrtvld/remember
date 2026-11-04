'use client'

import { type MouseEvent, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { contextListSelection, LIST_SHORTCUT_EXCLUSION, selectListRange, toggleAllListSelection } from './listSelection'

export function useListSelection(ids: string[], region: RefObject<HTMLElement | null>, enabled = true) {
  const [selection, setSelection] = useState<string[]>([])
  const anchor = useRef<string | null>(null)
  const availableIds = useMemo(() => new Set(ids), [ids])
  const selectedIds = useMemo(() => selection.filter((id) => availableIds.has(id)), [availableIds, selection])
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const clear = useCallback(() => {
    setSelection([])
    anchor.current = null
  }, [])

  useEffect(() => {
    if (!enabled) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || !region.current?.getClientRects().length) return
      if (event.target instanceof Element && event.target.closest(LIST_SHORTCUT_EXCLUSION)) return
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        if (event.repeat) return
        setSelection((current) => toggleAllListSelection(ids, current))
        anchor.current ??= ids[0] ?? null
      } else if (event.key === 'Escape') {
        clear()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [clear, enabled, ids, region])

  function click(event: MouseEvent, id: string, fallbackAnchor?: string) {
    if (!enabled) return false
    if (event.shiftKey) {
      event.preventDefault()
      const range = selectListRange(ids, anchor.current ?? fallbackAnchor ?? null, id)
      setSelection(event.metaKey || event.ctrlKey ? [...new Set([...selectedIds, ...range])] : range)
      anchor.current ??= fallbackAnchor ?? id
      return true
    }
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault()
      setSelection(selectedSet.has(id) ? selectedIds.filter((selected) => selected !== id) : [...selectedIds, id])
      anchor.current = id
      return true
    }
    setSelection([])
    anchor.current = id
    return false
  }

  function selectForContext(id: string) {
    setSelection(contextListSelection(selectedIds, id))
    anchor.current = id
  }

  function toggle(id: string) {
    setSelection(selectedSet.has(id) ? selectedIds.filter((selected) => selected !== id) : [...selectedIds, id])
    anchor.current = id
  }

  return { selectedIds, selectedSet, clear, click, selectForContext, toggle }
}
