'use client'

import { type PointerEvent, useEffect, useId, useMemo, useRef, useState } from 'react'
import { type AfdrukRecord, createAfdrukRenderer } from './afdruk-renderer'
import { workMoments } from './work-moments'
import './afdruk.css'

type Drag = { id: number; x: number; y: number; index: number; step: number }

const decisions: Record<'nl' | 'en', [string, string][]> = {
  nl: [
    ['DONDERDAG', 'LIVE'],
    ['TERUGKNOP', 'BLIJFT'],
    ['KLAAR OM', 'TE DELEN'],
  ],
  en: [
    ['LIVE', 'THURSDAY'],
    ['BACK', 'STAYS'],
    ['READY TO', 'SHARE'],
  ],
}

export function AfdrukScene({ locale }: { locale: 'nl' | 'en' }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const fallback = useRef<HTMLCanvasElement>(null)
  const engraving = useRef<HTMLCanvasElement>(null)
  const renderer = useRef<ReturnType<typeof createAfdrukRenderer>>(null)
  const pointer = useRef<Drag | null>(null)
  const selected = useRef(0)
  const [mode, setMode] = useState('canvas')
  const [dragging, setDragging] = useState(false)
  const [index, setIndex] = useState(0)
  const hintId = useId()
  const nl = locale === 'nl'
  const moments = workMoments[locale]
  const moment = moments[index]
  const records = useMemo<AfdrukRecord[]>(
    () =>
      workMoments[locale].map((item, itemIndex) => ({
        lines: decisions[locale][itemIndex],
        source: `${item.time} · ${item.shortTitle}`,
        detail: item.lines[itemIndex === 2 ? 0 : 1],
      })),
    [locale]
  )

  useEffect(() => {
    if (!canvas.current || !fallback.current || !engraving.current) return

    renderer.current = createAfdrukRenderer(canvas.current, fallback.current, engraving.current, records, setMode)
    renderer.current.select(selected.current, true)

    return () => {
      renderer.current?.dispose()
      renderer.current = null
    }
  }, [records])

  function select(next: number, animate: boolean) {
    const nextIndex = Math.max(0, Math.min(moments.length - 1, next))
    if (selected.current !== nextIndex) {
      selected.current = nextIndex
      setIndex(nextIndex)
    }
    renderer.current?.select(nextIndex, !animate)
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    const drag = pointer.current
    if (!drag || drag.id !== event.pointerId) return

    const horizontal = drag.x - event.clientX
    const vertical = drag.y - event.clientY
    if (Math.abs(horizontal) < Math.abs(vertical)) return

    const progress = Math.max(0, Math.min(moments.length - 1, drag.index + horizontal / drag.step))
    const next = Math.round(progress)
    renderer.current?.scrub(progress)
    if (selected.current !== next) {
      selected.current = next
      setIndex(next)
    }
  }

  function finish(cancelled = false) {
    const drag = pointer.current
    if (!drag) return

    pointer.current = null
    setDragging(false)
    select(cancelled ? drag.index : selected.current, !cancelled)
  }

  return (
    <figure className="afdruk-scene" data-mode={mode} data-dragging={dragging}>
      <div
        className="afdruk-surface"
        onPointerDown={(event) => {
          if (event.button !== 0 || pointer.current) return

          pointer.current = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            index: selected.current,
            step: Math.max(72, event.currentTarget.clientWidth * 0.26),
          }
          event.currentTarget.setPointerCapture(event.pointerId)
          setDragging(true)
        }}
        onPointerMove={move}
        onPointerUp={(event) => {
          if (pointer.current?.id !== event.pointerId) return

          move(event)
          finish()
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
        }}
        onPointerCancel={() => finish(true)}
        onLostPointerCapture={() => finish(true)}
      >
        <canvas
          ref={canvas}
          className="afdruk-canvas"
          role="img"
          aria-label={`${records[index].lines.join(' ')}. ${records[index].source}. ${moment.summary}`}
          aria-describedby={hintId}
        />
        <div aria-hidden="true">
          <canvas ref={fallback} className="afdruk-fallback" />
          <canvas ref={engraving} className="afdruk-engraving" />
        </div>
      </div>
      <figcaption className="afdruk-caption">
        <div className="afdruk-moments" role="group" aria-label={nl ? 'Werkmoment terughalen' : 'Recall a work moment'}>
          {moments.map((item, momentIndex) => (
            <button
              key={item.time}
              type="button"
              aria-pressed={index === momentIndex}
              onClick={(event) => select(momentIndex, event.detail > 0)}
            >
              <time>{item.time}</time>
              <span>{item.shortTitle}</span>
            </button>
          ))}
        </div>
        <div className="afdruk-footnote">
          <span id={hintId}>{nl ? 'Sleep om terug te halen' : 'Drag to recall'}</span>
          <span aria-hidden="true">·</span>
          <span>{nl ? 'Remember · voorbeelddag' : 'Remember · example day'}</span>
        </div>
        <span className="afdruk-status" aria-live="polite" aria-atomic="true">
          {moment.time}. {moment.title}. {moment.summary}
        </span>
      </figcaption>
    </figure>
  )
}
