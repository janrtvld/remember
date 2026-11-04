'use client'

import { EDGE_WIDGET_EDGES, type EdgeWidgetAction, type EdgeWidgetEdge, type EdgeWidgetState } from '@remember/shared'
import {
  RotateCw as IconArrowRotateClockwise,
  MessagesSquare as IconBubbles,
  CheckCheck as IconCheckmark2Medium,
  X as IconCrossSmall,
  LoaderCircle as IconLoadingCircle,
  Mic as IconMicrophone,
  Settings as IconSettingsGear2,
} from 'lucide-react'
import { type CSSProperties, useEffect, useRef, useState } from 'react'
import './edgeWidget.css'

export function EdgeWidget({
  state,
  onOpen,
  onInteractive,
  onContextMenu,
  onDragStart,
  onDragMove,
  onDragEnd,
}: {
  state: EdgeWidgetState | null
  onOpen: (action: EdgeWidgetAction) => Promise<void>
  onInteractive?: (interactive: boolean) => void
  onContextMenu?: (point: { x: number; y: number }) => void
  onDragStart?: (point: { x: number; y: number }) => Promise<void>
  onDragMove?: (point: { x: number; y: number }) => void
  onDragEnd?: (edge?: EdgeWidgetEdge | null) => Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)
  const [pending, setPending] = useState<EdgeWidgetAction | null>(null)
  const [error, setError] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const interactive = useRef(false)
  const keyboardInteraction = useRef(false)
  const cancelDictation = useRef<HTMLButtonElement>(null)
  const dictationTrigger = useRef<HTMLButtonElement>(null)
  const drag = useRef<{ x: number; y: number; started: boolean } | null>(null)
  const suppressClick = useRef(false)
  const text = (dutch: string, english: string) => (state?.locale === 'nl' ? dutch : english)
  const isDocking = !!state?.docking
  const conversationMenu = state?.alwaysOn && !state.recording
  const dictation = state?.dictation
  const dictating = dictation?.status === 'recording'
  const microphoneLevel = dictating ? Math.sqrt(Math.max(0, Math.min(1, dictation.level))) : 0
  const dictationBusy = dictation?.status === 'starting' || dictation?.status === 'transcribing'
  const dictationActive = dictating || dictationBusy
  const dictationError = dictation?.status === 'error'
  const dictationVisible = dictationActive || dictationError
  const isExpanded = expanded || dictationVisible
  const noteLabel = text('Spraaknotitie', 'Voice note')
  const agentNotice = state?.agentAttention?.needsInput
    ? text('Wacht op je antwoord', 'Waiting for your answer')
    : state?.agentAttention?.unread
      ? text('Ongelezen bericht', 'Unread message')
      : null
  const conversationLabel = conversationMenu
    ? text('Meeluisteren · altijd aan', 'Audio capture · always on')
    : state?.recording
      ? text('Open opname', 'Open recording')
      : text('Start gesprek', 'Start conversation')

  useEffect(() => {
    if (dictationActive && keyboardInteraction.current) cancelDictation.current?.focus()
  }, [dictationActive])

  useEffect(() => {
    if (!isDocking) return
    function cancelPlacement(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      drag.current = null
      void onDragEnd?.(null)
    }
    window.addEventListener('keydown', cancelPlacement, true)
    return () => window.removeEventListener('keydown', cancelPlacement, true)
  }, [isDocking, onDragEnd])

  useEffect(() => {
    function setInteractive(next: boolean) {
      if (interactive.current === next) return
      interactive.current = next
      onInteractive?.(next)
    }
    function trackPointer(event: MouseEvent) {
      const target = event.target
      setInteractive(target instanceof Element && !!target.closest('[data-widget-hit]'))
    }
    function leave() {
      setInteractive(false)
    }
    function blur() {
      leave()
      setExpanded(false)
      setError(false)
    }
    document.addEventListener('mousemove', trackPointer)
    document.addEventListener('mouseleave', leave)
    window.addEventListener('blur', blur)
    return () => {
      document.removeEventListener('mousemove', trackPointer)
      document.removeEventListener('mouseleave', leave)
      window.removeEventListener('blur', blur)
      if (closeTimer.current) clearTimeout(closeTimer.current)
      onInteractive?.(false)
    }
  }, [onInteractive])

  function expand() {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    setExpanded(true)
  }

  function collapseLater() {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => {
      if (!keyboardInteraction.current || !document.hasFocus() || !root.current?.contains(document.activeElement)) {
        setExpanded(false)
        setError(false)
      }
    }, 180)
  }

  async function open(action: EdgeWidgetAction) {
    if ((pending && action !== 'dictation-cancel') || !state) return
    setPending(action)
    setError(false)
    try {
      await onOpen(action)
      const returnToDictation =
        keyboardInteraction.current && (action === 'dictation-cancel' || (action === 'dictation' && dictationActive))
      setExpanded(returnToDictation)
      if (returnToDictation) requestAnimationFrame(() => dictationTrigger.current?.focus())
      if (!keyboardInteraction.current && document.activeElement instanceof HTMLElement) document.activeElement.blur()
      onInteractive?.(false)
      interactive.current = false
    } catch {
      setError(true)
    } finally {
      setPending(null)
    }
  }

  return (
    <main
      className="edge-widget-root"
      aria-label="Remember"
      data-docking={!!state?.docking}
      onPointerUp={(event) => {
        if (drag.current?.started) {
          event.preventDefault()
          void onDragEnd?.().catch(() => setError(true))
        }
        drag.current = null
        if (event.target instanceof Element && event.target.hasPointerCapture(event.pointerId))
          event.target.releasePointerCapture(event.pointerId)
      }}
    >
      <div
        ref={root}
        className="edge-widget"
        data-expanded={isExpanded}
        data-error={error}
        data-dictating={dictationActive}
        data-edge={state?.edge ?? 'right'}
        data-widget-hit
        onMouseEnter={expand}
        onMouseLeave={collapseLater}
        onFocus={expand}
        onBlur={collapseLater}
        onContextMenu={(event) => {
          if (!onContextMenu) return
          event.preventDefault()
          if (isDocking) return
          setExpanded(false)
          onContextMenu({ x: event.clientX, y: event.clientY })
        }}
        onPointerDown={() => {
          keyboardInteraction.current = false
        }}
        onKeyDown={(event) => {
          keyboardInteraction.current = true
          if (event.key !== 'Escape') return
          if (state?.docking) {
            void onDragEnd?.(null)
            return
          }
          keyboardInteraction.current = false
          if (dictationVisible) void open('dictation-cancel')
          setExpanded(false)
          setError(false)
          onInteractive?.(false)
          interactive.current = false
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        }}
      >
        <div id="edge-widget-actions" className="edge-widget-actions">
          <button
            type="button"
            className="edge-widget-action edge-widget-secondary"
            inert={!isExpanded || dictationActive || isDocking}
            aria-label={noteLabel}
            aria-busy={pending === 'dictation'}
            disabled={!state || pending !== null}
            onClick={() => void open('dictation')}
          >
            {pending === 'dictation' ? <IconLoadingCircle className="edge-widget-spinner" /> : <IconMicrophone />}
            {dictationError ? <span className="edge-widget-dot edge-widget-error-dot" aria-hidden="true" /> : null}
            <span className="edge-widget-label" aria-hidden="true">
              {noteLabel}
            </span>
          </button>
          <div className="edge-widget-dictation">
            <div className="edge-widget-capsule-surface" aria-hidden="true">
              <span className="edge-widget-capsule-top" />
              <span className="edge-widget-capsule-body" />
              <span className="edge-widget-capsule-bottom" />
            </div>
            <button
              ref={dictationTrigger}
              type="button"
              className="edge-widget-action edge-widget-dictation-trigger edge-widget-handle"
              inert={dictationActive}
              aria-label={`${text('Open Remember-agent', 'Open Remember agent')}${agentNotice ? `: ${agentNotice}` : ''}`}
              aria-expanded={isExpanded}
              aria-controls="edge-widget-actions"
              tabIndex={isDocking ? -1 : 0}
              disabled={!state || pending !== null}
              onClick={() => {
                if (!suppressClick.current) void open('assistant')
              }}
              onPointerDown={(event) => {
                if (event.button !== 0 || !onDragStart) return
                suppressClick.current = false
                drag.current = { x: event.clientX, y: event.clientY, started: false }
                event.currentTarget.setPointerCapture(event.pointerId)
              }}
              onPointerMove={(event) => {
                const current = drag.current
                if (!current) return
                const point = { x: event.clientX, y: event.clientY }
                if (!current.started && Math.hypot(point.x - current.x, point.y - current.y) >= 6) {
                  current.started = true
                  suppressClick.current = true
                  if (closeTimer.current) clearTimeout(closeTimer.current)
                  setExpanded(false)
                  void onDragStart?.(point).catch(() => setError(true))
                }
                if (current.started) onDragMove?.(point)
              }}
              onPointerCancel={() => {
                if (drag.current?.started) void onDragEnd?.(null)
                drag.current = null
              }}
            >
              <IconBubbles />
              {agentNotice && isExpanded ? <span className="edge-widget-dot" aria-hidden="true" /> : null}
              {!dictationError ? (
                <span className="edge-widget-label" aria-hidden="true">
                  {text('Agent', 'Agent')}
                </span>
              ) : null}
            </button>
            <div className="edge-widget-capsule-controls" inert={!dictationActive}>
              <button
                ref={cancelDictation}
                type="button"
                className="edge-widget-capsule-cancel"
                aria-label={text('Dictatie annuleren', 'Cancel dictation')}
                onClick={() => void open('dictation-cancel')}
              >
                <IconCrossSmall />
              </button>
              <div className="edge-widget-capsule-activity" role="status">
                <span className="edge-widget-sr-only">
                  {dictating
                    ? text('Luisteren', 'Listening')
                    : dictation?.status === 'starting'
                      ? text('Microfoon openen…', 'Opening microphone…')
                      : text('Tekst maken…', 'Transcribing…')}
                </span>
                <div
                  className="edge-widget-waveform"
                  aria-hidden="true"
                  data-visible={dictationActive}
                  data-processing={dictationBusy}
                >
                  {METER_PROFILE.map((weight, index) => (
                    <span
                      key={index}
                      className="edge-widget-waveform-mark"
                      style={
                        {
                          '--meter-expansion': dictationBusy ? 0.25 + weight * 0.5 : microphoneLevel * weight,
                          '--meter-delay': `${Math.abs(index - (METER_PROFILE.length - 1) / 2) * 10}ms`,
                          '--wave-peak': 0.35 + weight * 0.65,
                          '--wave-delay': `${index * -65}ms`,
                          opacity: 0.45 + weight * 0.55,
                        } as CSSProperties
                      }
                    >
                      <span className="edge-widget-waveform-fill" />
                    </span>
                  ))}
                </div>
              </div>
              <button
                type="button"
                className="edge-widget-capsule-finish"
                aria-label={text('Stop dictatie', 'Stop dictation')}
                disabled={!dictating || pending !== null}
                onClick={() => void open('dictation')}
              >
                <IconCheckmark2Medium />
              </button>
            </div>
            {dictationError ? (
              <div className="edge-widget-dictation-status" data-widget-hit>
                <div className="edge-widget-sr-only" role="status">
                  {dictation.error === 'model-required'
                    ? text('Spraakmodel nodig', 'Speech model needed')
                    : dictation.error === 'microphone'
                      ? text('Geen microfoontoegang', 'Microphone unavailable')
                      : dictation.error === 'no-speech'
                        ? text('Geen spraak gehoord', 'No speech heard')
                        : text('Dictatie mislukt', 'Dictation failed')}
                </div>
                <div className="edge-widget-dictation-controls">
                  {dictation.error !== 'no-speech' && dictation.canRetry ? (
                    <button
                      type="button"
                      className="edge-widget-action"
                      aria-label={text('Opnieuw', 'Retry')}
                      onClick={() => void open('dictation-retry')}
                    >
                      <IconArrowRotateClockwise />
                    </button>
                  ) : null}
                  {dictation.error === 'model-required' || dictation.error === 'microphone' ? (
                    <button
                      type="button"
                      className="edge-widget-action"
                      aria-label={text('Instellingen', 'Settings')}
                      onClick={() => void open('dictation-settings')}
                    >
                      <IconSettingsGear2 />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="edge-widget-action"
                    aria-label={text('Sluiten', 'Dismiss')}
                    onClick={() => void open('dictation-cancel')}
                  >
                    <IconCrossSmall />
                  </button>
                </div>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="edge-widget-action edge-widget-conversation edge-widget-secondary"
            inert={!isExpanded || dictationActive || isDocking}
            data-recording={state?.recording}
            aria-label={conversationLabel}
            aria-haspopup={conversationMenu ? 'menu' : undefined}
            aria-busy={pending === 'conversation'}
            disabled={!state || pending !== null}
            onClick={() => void open('conversation')}
          >
            {pending === 'conversation' ? <IconLoadingCircle className="edge-widget-spinner" /> : <IconMicrophone />}
            {state?.recording ? (
              <span className="edge-widget-dot edge-widget-recording-dot" aria-hidden="true" />
            ) : null}
            <span className="edge-widget-label" aria-hidden="true">
              {conversationLabel}
            </span>
          </button>
        </div>
        {error ? (
          <p className="edge-widget-sr-only" role="alert">
            {text('Openen mislukt. Probeer opnieuw.', 'Could not open. Try again.')}
          </p>
        ) : null}
      </div>
      <div
        className="edge-widget-placement"
        data-visible={!!state?.docking}
        inert={!state?.docking}
        aria-label={text('Widget verplaatsen', 'Move widget')}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            void onDragEnd?.(null)
          }
        }}
      >
        {EDGE_WIDGET_EDGES.map((edge) => (
          <button
            key={edge}
            type="button"
            className="edge-widget-drop-target"
            data-edge={edge}
            data-selected={state?.docking?.target === edge}
            data-widget-hit
            aria-label={
              edge === 'left'
                ? text('Links plaatsen', 'Dock left')
                : edge === 'right'
                  ? text('Rechts plaatsen', 'Dock right')
                  : text('Onderaan plaatsen', 'Dock bottom')
            }
            onClick={() => void onDragEnd?.(edge)}
          />
        ))}
      </div>
      {state?.docking ? (
        <div
          className="edge-widget-drag-ghost"
          data-edge={state.edge}
          aria-hidden="true"
          style={{
            transform: `translate3d(${state.docking.cursor.x}px, ${state.docking.cursor.y}px, 0)`,
          }}
        >
          <span className="edge-widget-drag-bar" />
          <span className="edge-widget-drag-icon" />
        </div>
      ) : null}
    </main>
  )
}

const METER_PROFILE = [0.22, 0.35, 0.5, 0.65, 0.82, 1, 0.82, 0.65, 0.5, 0.35, 0.22]
