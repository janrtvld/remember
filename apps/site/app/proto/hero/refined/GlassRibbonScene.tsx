'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { createGlassRibbonRenderer } from './glass-ribbon-renderer'
import './glass-ribbon.css'

export function GlassRibbonScene({ locale = 'nl' }: { locale?: 'nl' | 'en' }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const renderer = useRef<ReturnType<typeof createGlassRibbonRenderer>>(null)
  const gesture = useRef<{ pointerId: number; x: number; y: number; start: number; active: boolean } | null>(null)
  const [ready, setReady] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const gradient = useId().replaceAll(':', '')
  const folded = 'M92 214C220 70 380 62 520 92C682 124 686 268 538 268C390 268 342 186 454 144'
  const open = 'M80 210C200 320 270 20 400 130S600 280 720 100'

  useEffect(() => {
    if (!canvas.current) return

    renderer.current = createGlassRibbonRenderer(canvas.current, setReady)

    return () => {
      renderer.current?.dispose()
      renderer.current = null
    }
  }, [])

  const finishGesture = (pointerId: number) => {
    if (gesture.current?.pointerId !== pointerId) return
    if (gesture.current.active) setExpanded(renderer.current?.release() ?? expanded)
    gesture.current = null
    surface.current?.removeAttribute('data-dragging')
  }

  return (
    <div className="glass-ribbon-scene" data-ready={ready}>
      <div
        ref={surface}
        className="glass-ribbon-surface"
        onPointerDown={(event) => {
          if (event.button !== 0 || !ready) return
          gesture.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            start: expanded ? 1 : 0,
            active: false,
          }
        }}
        onPointerMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect()
          renderer.current?.point(
            ((event.clientX - bounds.left) / bounds.width - 0.5) * 2,
            ((event.clientY - bounds.top) / bounds.height - 0.5) * -2
          )

          const drag = gesture.current
          if (!drag || drag.pointerId !== event.pointerId) return

          const distance = event.clientX - drag.x

          if (!drag.active) {
            if (Math.abs(distance) < 5 || Math.abs(distance) < Math.abs(event.clientY - drag.y)) return
            drag.start = renderer.current?.begin() ?? drag.start
            drag.active = true
            event.currentTarget.setPointerCapture(event.pointerId)
            event.currentTarget.setAttribute('data-dragging', '')
          }

          renderer.current?.drag(drag.start + distance / Math.min(bounds.width * 0.46, 380))
        }}
        onPointerUp={(event) => finishGesture(event.pointerId)}
        onPointerCancel={(event) => finishGesture(event.pointerId)}
        onLostPointerCapture={(event) => finishGesture(event.pointerId)}
        onPointerLeave={() => {
          if (!gesture.current?.active) {
            gesture.current = null
            renderer.current?.point(0, 0)
          }
        }}
      >
        <svg className="glass-ribbon-fallback" data-hidden={ready} viewBox="0 0 800 320" aria-hidden="true">
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="0.7">
              <stop offset="0" stopColor="#f8fafc" />
              <stop offset="0.25" stopColor="#94a3b8" />
              <stop offset="0.48" stopColor="#e2e8f0" />
              <stop offset="0.66" stopColor="#f8fafc" />
              <stop offset="0.86" stopColor="#64748b" />
              <stop offset="1" stopColor="#bfdbfe" />
            </linearGradient>
          </defs>
          <path d={expanded ? open : folded} fill="none" stroke="#94a3b8" strokeWidth="47" opacity="0.25" />
          <path d={expanded ? open : folded} fill="none" stroke={`url(#${gradient})`} strokeWidth="44" opacity="0.65" />
          <path d={expanded ? open : folded} fill="none" stroke="#fff" strokeWidth="1" opacity="0.8" />
        </svg>
        <canvas
          ref={canvas}
          className="glass-ribbon-canvas"
          data-ready={ready}
          role="img"
          aria-label={
            locale === 'nl'
              ? 'Een doorlopend glazen lint dat zich ontvouwt. Gebruik de knop om het lint te openen of te sluiten.'
              : 'One continuous glass ribbon. Use the button to unfold or fold the ribbon.'
          }
        />
      </div>

      <div className="glass-ribbon-controls">
        <span className="glass-ribbon-hint" aria-hidden="true">
          {locale === 'nl' ? 'Sleep om te ontdekken' : 'Drag to explore'}
        </span>
        <button
          type="button"
          className="glass-ribbon-toggle"
          aria-pressed={expanded}
          onClick={() => setExpanded(renderer.current?.toggle() ?? !expanded)}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d={
                expanded
                  ? 'M2 8h4m0 0L3.5 5.5M6 8l-2.5 2.5M14 8h-4m0 0 2.5-2.5M10 8l2.5 2.5'
                  : 'M6 8H2m0 0 2.5-2.5M2 8l2.5 2.5M10 8h4m0 0-2.5-2.5M14 8l-2.5 2.5'
              }
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {locale === 'nl' ? (expanded ? 'Vouw samen' : 'Vouw open') : expanded ? 'Fold' : 'Unfold'}
        </button>
      </div>
    </div>
  )
}
