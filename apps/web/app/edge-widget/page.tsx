'use client'

import { EdgeWidget } from '@internal/components/EdgeWidget'
import { getDictationBridge } from '@internal/lib/dictationBridge'
import { getRememberBridge } from '@internal/lib/rememberBridge'
import {
  type EdgeWidgetAction,
  type EdgeWidgetEdge,
  type EdgeWidgetState,
  edgeWidgetDropTarget,
  resolveInterfaceLocale,
} from '@remember/shared'
import { useEffect, useRef, useState } from 'react'

export default function EdgeWidgetPage() {
  const [state, setState] = useState<EdgeWidgetState | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => {
    const widget = window.rememberWidget
    if (widget) {
      const unsubscribe = widget.onState(setState)
      void widget.getState().then(setState)
      return unsubscribe
    }
    if (process.env.NODE_ENV !== 'development') return
    const bridge = getRememberBridge()
    if (!bridge) return
    let active = true
    const dictation = getDictationBridge()
    const refresh = async () => {
      const [settings, capture, dictationState] = await Promise.all([
        bridge.getSettings(),
        bridge.getState(),
        dictation?.getState(),
      ])
      if (!active) return
      setState((current) => ({
        edge: settings.edgeWidgetEdge ?? 'right',
        docking: current?.docking ?? null,
        locale: resolveInterfaceLocale(settings.interfaceLanguage, navigator.language),
        alwaysOn: settings.audioCaptureEnabled,
        recording: capture.manualMeeting?.status === 'recording',
        dictation: dictationState ?? null,
      }))
    }
    void refresh()
    const unsubscribe = bridge.onState(() => void refresh())
    const unsubscribeDictation = dictation?.onState((dictation) =>
      setState((current) => current && { ...current, dictation })
    )
    return () => {
      active = false
      unsubscribe()
      unsubscribeDictation?.()
    }
  }, [])

  async function open(action: EdgeWidgetAction) {
    if (window.rememberWidget) return window.rememberWidget.open(action)
    if (process.env.NODE_ENV === 'development') {
      const dictation = getDictationBridge()
      if (action === 'assistant') return window.location.assign('/assistant/')
      if (action === 'privacy') return window.location.assign('/exclusions/')
      if (action === 'dictation') {
        if (stateRef.current?.dictation?.status === 'recording') return dictation?.toggle()
        return window.location.assign('/assistant/')
      }
      if (action === 'dictation-cancel') return dictation?.cancel()
      if (action === 'dictation-retry') return dictation?.retry()
      if (action === 'dictation-copy') return dictation?.copy()
      if (action === 'dictation-settings') {
        window.location.assign('/notes/?preferences=1')
        return
      }
      window.location.assign(
        stateRef.current?.recording
          ? '/conversations/'
          : stateRef.current?.alwaysOn
            ? '/exclusions/?pause=1&source=audio'
            : '/conversations/?start=1'
      )
    }
  }

  async function beginDrag(point: { x: number; y: number }) {
    if (window.rememberWidget) return window.rememberWidget.beginDrag()
    setState(
      (current) =>
        current && {
          ...current,
          docking: { cursor: point, target: edgeWidgetDropTarget(point, { width: innerWidth, height: innerHeight }) },
        }
    )
  }

  function moveDrag(point: { x: number; y: number }) {
    if (window.rememberWidget) return
    setState((current) =>
      current?.docking
        ? {
            ...current,
            docking: { cursor: point, target: edgeWidgetDropTarget(point, { width: innerWidth, height: innerHeight }) },
          }
        : current
    )
  }

  async function finishDrag(edge?: EdgeWidgetEdge | null) {
    if (window.rememberWidget) return window.rememberWidget.finishDrag(edge)
    const current = stateRef.current
    const destination = edge === undefined ? current?.docking?.target : edge
    if (destination) await getRememberBridge()?.updateSettings({ edgeWidgetEdge: destination })
    setState((current) => current && { ...current, edge: destination ?? current.edge, docking: null })
  }

  return (
    <EdgeWidget
      state={state}
      onOpen={open}
      onInteractive={setInteractive}
      onContextMenu={(point) => window.rememberWidget?.showContextMenu(point)}
      onDragStart={beginDrag}
      onDragMove={moveDrag}
      onDragEnd={finishDrag}
    />
  )
}

function setInteractive(interactive: boolean) {
  window.rememberWidget?.setInteractive(interactive)
}
