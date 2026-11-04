'use client'

import { useEffect, useRef, useState } from 'react'
import { createFocusRenderer, type FocusRenderer } from './focus-renderer'
import { workMoments } from './work-moments'
import './focus.css'

export function FocusScene({ locale = 'nl' }: { locale?: 'nl' | 'en' }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<FocusRenderer | null>(null)
  const activeRef = useRef(1)
  const [active, setActive] = useState(1)
  const [ready, setReady] = useState(false)
  const records = workMoments[locale]
  const isDutch = locale === 'nl'

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const renderer = createFocusRenderer(
      canvas,
      records,
      (index) => {
        activeRef.current = index
        setActive(index)
      },
      () => setReady(false),
      activeRef.current
    )
    rendererRef.current = renderer
    setReady(Boolean(renderer))

    return () => {
      renderer?.dispose()
      rendererRef.current = null
    }
  }, [records])

  const select = (index: number, animate: boolean) => {
    const next = (index + records.length) % records.length
    activeRef.current = next
    setActive(next)
    rendererRef.current?.select(next, animate)
  }

  return (
    <figure className="focus-scene" data-ready={ready}>
      <span className="focus-demo">{isDutch ? 'Voorbeelddag' : 'Example day'}</span>
      <div className="focus-surface">
        <canvas
          ref={canvasRef}
          className="focus-canvas"
          role="img"
          aria-label={
            isDutch
              ? 'Remember haalt het besluit terug uit je werksporen. Sleep de lens over een fragment of kies een moment hieronder.'
              : 'Remember brings the decision back from your work. Drag the lens over a fragment or choose a moment below.'
          }
        />
        {!ready && (
          <div className="focus-fallback">
            <span className="focus-fallback-brand">Remember.</span>
            {records[active].lines.map((line) => (
              <strong key={line}>{line}</strong>
            ))}
            <span className="focus-fallback-source">
              {records[active].shortTitle}
              <br />
              {records[active].sourceLabel}
            </span>
          </div>
        )}
        {ready && (
          <span className="focus-hint">
            {isDutch ? 'Van werkspoor naar besluit. Sleep de lens.' : 'From a work trace to a decision. Drag the lens.'}
          </span>
        )}
      </div>
      <figcaption className="focus-navigation">
        <div
          className="focus-moments"
          role="group"
          aria-label={isDutch ? 'Kies een werkmoment' : 'Choose a work moment'}
        >
          {records.map((record, index) => (
            <button
              key={record.time}
              type="button"
              aria-pressed={active === index}
              aria-label={`${record.time} ${record.title}`}
              onClick={(event) => select(index, event.detail > 0)}
            >
              <time>{record.time}</time>
              <span>{record.shortTitle}</span>
            </button>
          ))}
        </div>
      </figcaption>
      <p className="focus-accessible-result" role="status" aria-live="polite" aria-atomic="true">
        {records[active].question} {records[active].answer} {records[active].title}. {records[active].sourceLabel}.
      </p>
    </figure>
  )
}
