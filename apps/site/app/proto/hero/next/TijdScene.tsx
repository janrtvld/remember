'use client'

import { type PointerEvent, useEffect, useRef, useState } from 'react'
import { createTijdRenderer, type TijdFrame, type TijdRenderer } from './tijd-renderer'
import { workMoments } from './work-moments'
import './tijd-scene.css'

function paintFragments(fragments: Array<HTMLDivElement | null>, progress: number) {
  for (const [index, fragment] of fragments.entries()) {
    if (!fragment) continue
    const offset = ((((index - progress + 1.5) % 3) + 3) % 3) - 1.5
    fragment.style.transform = `translateY(${offset * 112}%) rotate(${offset * -8}deg)`
    fragment.style.opacity = String(Math.max(0, 1 - Math.abs(offset) * 0.68))
  }
}

export function TijdScene({ locale = 'nl' }: { locale?: 'nl' | 'en' }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const fragmentsRef = useRef<Array<HTMLDivElement | null>>([])
  const rendererRef = useRef<TijdRenderer | null>(null)
  const readyRef = useRef(false)
  const draggingRef = useRef(false)
  const selectedRef = useRef(2)
  const pointerRef = useRef({ angle: 0, travel: 0, selected: 2, usingRenderer: false })
  const [ready, setReady] = useState(false)
  const [selected, setSelected] = useState(2)
  const moments = workMoments[locale]
  const moment = moments[selected]
  const nl = locale === 'nl'

  useEffect(() => {
    if (!canvasRef.current) return
    readyRef.current = false
    setReady(false)
    const paintFrame = (frame: TijdFrame) => {
      const stage = stageRef.current
      if (!stage) return
      stage.style.setProperty('--tijd-face-x', `${frame.x}px`)
      stage.style.setProperty('--tijd-face-y', `${frame.y}px`)
      stage.style.setProperty('--tijd-face-width', `${frame.width}px`)
      stage.style.setProperty('--tijd-face-height', `${frame.height}px`)
      stage.style.setProperty('--tijd-dial-width', `${frame.dialWidth}px`)
      stage.style.setProperty('--tijd-dial-height', `${frame.dialHeight}px`)
      paintFragments(fragmentsRef.current, frame.progress)
    }

    const renderer = createTijdRenderer(
      canvasRef.current,
      (index) => {
        selectedRef.current = index
        setSelected(index)
      },
      (value) => {
        readyRef.current = value
        setReady(value)
      },
      selectedRef.current,
      (frame) => paintFrame(frame)
    )
    rendererRef.current = renderer

    return () => {
      renderer?.dispose()
      rendererRef.current = null
      readyRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!ready) paintFragments(fragmentsRef.current, selected)
  }, [ready, selected])

  const angleFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return Math.atan2(
      (event.clientY - bounds.top - bounds.height / 2) / (bounds.height / 2),
      (event.clientX - bounds.left - bounds.width / 2) / (bounds.width / 2)
    )
  }

  const select = (index: number) => {
    const next = ((index % 3) + 3) % 3
    if (readyRef.current && rendererRef.current) rendererRef.current.select(next)
    else {
      selectedRef.current = next
      setSelected(next)
    }
  }

  const recordPointerAngle = (angle: number) => {
    const difference = angle - pointerRef.current.angle
    pointerRef.current.travel += Math.atan2(Math.sin(difference), Math.cos(difference))
    pointerRef.current.angle = angle
  }

  const release = (commit = true) => {
    if (!draggingRef.current) return
    draggingRef.current = false
    const pointer = pointerRef.current
    const useFallback = !pointer.usingRenderer || !readyRef.current || !rendererRef.current

    if (!commit) {
      select(pointer.selected)
      return
    }

    rendererRef.current?.release()

    if (useFallback && Math.abs(pointer.travel) >= 0.25) {
      const steps = Math.max(1, Math.round(Math.abs(pointer.travel) / ((Math.PI * 2) / 3)))
      const next = pointer.selected - Math.sign(pointer.travel) * steps
      selectedRef.current = ((next % 3) + 3) % 3
      setSelected(selectedRef.current)
    }
  }

  return (
    <div className="tijd-scene" data-ready={ready}>
      <div ref={stageRef} className="tijd-stage">
        <canvas ref={canvasRef} className="tijd-canvas" aria-hidden="true" tabIndex={-1} />
        {!ready && <div className="tijd-fallback" aria-hidden="true" />}
        <div className="tijd-memory-window" aria-hidden="true">
          <div className="tijd-memory-reel">
            {moments.map((entry, index) => (
              <div
                key={entry.time}
                ref={(element) => {
                  fragmentsRef.current[index] = element
                }}
                className="tijd-memory"
                style={{ transform: `translateY(${(index - selected) * 112}%)` }}
              >
                <div className="tijd-memory-content">
                  <div className="tijd-memory-source">
                    <time>{entry.time}</time>
                    <span>{entry.shortTitle}</span>
                    <span>{nl ? 'Voorbeeld' : 'Example'}</span>
                  </div>
                  <p className="tijd-memory-result">
                    {entry.lines[0]}
                    <br />
                    {entry.lines[1]}
                  </p>
                  <div className="tijd-memory-action">
                    <span>{nl ? 'Hier ga je verder' : 'Pick up here'}</span>
                    <p>{entry.action}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div
          className="tijd-dial-target"
          role="slider"
          tabIndex={0}
          aria-label={nl ? 'Draai terug naar een moment uit je werkdag' : 'Turn back to a moment in your workday'}
          aria-valuemin={0}
          aria-valuemax={2}
          aria-valuenow={selected}
          aria-valuetext={`${moment.time}, ${moment.sourceLabel}: ${moment.summary} ${moment.action}`}
          aria-describedby="tijd-work-example"
          aria-orientation="horizontal"
          onPointerDown={(event) => {
            if (event.button !== 0) return
            draggingRef.current = true
            event.currentTarget.setPointerCapture(event.pointerId)
            const angle = angleFromPointer(event)
            const usingRenderer = readyRef.current && rendererRef.current !== null
            pointerRef.current = { angle, travel: 0, selected, usingRenderer }
            if (usingRenderer) rendererRef.current?.begin(angle)
          }}
          onPointerMove={(event) => {
            if (!draggingRef.current) return
            const angle = angleFromPointer(event)
            recordPointerAngle(angle)
            if (pointerRef.current.usingRenderer && readyRef.current) rendererRef.current?.drag(angle)
          }}
          onPointerUp={(event) => {
            if (draggingRef.current && !readyRef.current) recordPointerAngle(angleFromPointer(event))
            release()
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId)
          }}
          onPointerCancel={() => release(false)}
          onLostPointerCapture={() => release(false)}
          onBlur={() => release(false)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
              event.preventDefault()
              select(selected + 1)
            } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
              event.preventDefault()
              select(selected - 1)
            } else if (event.key === 'Home' || event.key === 'End') {
              event.preventDefault()
              select(event.key === 'Home' ? 0 : 2)
            }
          }}
        >
          <span className="tijd-dial-focus" />
        </div>
      </div>
      <div className="tijd-controls">
        <span className="tijd-invitation" aria-hidden="true">
          <svg viewBox="0 0 18 18">
            <path d="M4 7a5.2 5.2 0 0 1 9.3-1M4 3.5V7h3.5M14 11a5.2 5.2 0 0 1-9.3 1M14 14.5V11h-3.5" />
          </svg>
          {nl ? 'Draai terug' : 'Turn back'}
        </span>
        <div className="tijd-moments" aria-label={nl ? 'Momenten uit je werkdag' : 'Moments from your workday'}>
          {moments.map((entry, index) => (
            <button
              key={entry.time}
              type="button"
              aria-pressed={selected === index}
              aria-label={`${entry.time}: ${entry.shortTitle}`}
              onClick={() => select(index)}
            >
              {entry.time}
            </button>
          ))}
        </div>
      </div>
      <p id="tijd-work-example" className="tijd-sr-only" aria-live="polite">
        {nl ? 'Voorbeeldwerkdag.' : 'Example workday.'} {moment.time}. {moment.title}. {moment.summary}{' '}
        {nl ? 'Volgende stap:' : 'Next step:'} {moment.action} {moment.sourceLabel}.
      </p>
    </div>
  )
}
