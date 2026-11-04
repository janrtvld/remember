'use client'

import { type CSSProperties, type PointerEvent, useEffect, useRef, useState } from 'react'
import './thread-scene.css'

type Locale = 'nl' | 'en'
type FragmentKind = 'idea' | 'conversation' | 'decision'
type Spring = { position: number; velocity: number; target: number }
type ThreadInput = { move: (x: number) => void; hover: (active: boolean) => void; gather: (active: boolean) => void }

const pageCount = 56
const featuredPages = new Map<number, FragmentKind>([
  [0, 'idea'],
  [28, 'conversation'],
  [55, 'decision'],
])

const memories = {
  nl: [
    { source: 'Idee · Notities', text: 'Minder stappen, zodat de eerste stap vanzelf spreekt.' },
    { source: 'Gesprek · Productoverleg', text: '“Laten we het eenvoudiger maken.”' },
    { source: 'Besluit · Productsync', text: 'We beginnen met één heldere eerste stap.' },
  ],
  en: [
    { source: 'Idea · Notes', text: 'Fewer steps, so the first one feels obvious.' },
    { source: 'Conversation · Product sync', text: '“Let’s make it simpler.”' },
    { source: 'Decision · Product sync', text: 'We start with one clear first step.' },
  ],
}

function pageTransform(index: number, gather: number, pointer: number, presence: number) {
  const progress = index / (pageCount - 1)
  const wave = progress * Math.PI * 2 - Math.PI * 0.4
  const distance = progress - (pointer + 1) / 2
  const ripple = Math.exp(-distance * distance * 24) * presence
  const open = 1 - gather
  const center = pointer * 150 * gather
  const x = (progress - 0.5) * 900 * open + center
  const y = (Math.sin(wave) * 55 - ripple * 22) * open
  const z = (Math.cos(wave) * 42 + ripple * 46) * open
  const rotateX = 34 + (Math.cos(wave) * 25 - ripple * 16) * open
  const rotateY = -18 * gather + Math.sin(wave) * 40 * open
  const rotateZ = -12 + Math.cos(wave) * 19 * open

  return `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, ${z.toFixed(2)}px) rotateX(${rotateX.toFixed(2)}deg) rotateY(${rotateY.toFixed(2)}deg) rotateZ(${rotateZ.toFixed(2)}deg) translateZ(${(gather * index * 0.68).toFixed(2)}px) scale(${(1 + gather * 0.15).toFixed(3)})`
}

function advanceSpring(spring: Spring, delta: number, stiffness: number, damping: number) {
  spring.velocity += ((spring.target - spring.position) * stiffness - spring.velocity * damping) * delta
  spring.position += spring.velocity * delta

  if (Math.abs(spring.position - spring.target) < 0.0005 && Math.abs(spring.velocity) < 0.002) {
    spring.position = spring.target
    spring.velocity = 0
  }
}

function FragmentContents({ kind, locale }: { kind?: FragmentKind; locale: Locale }) {
  const nl = locale === 'nl'

  if (!kind) {
    return (
      <>
        <span className="thread-scene-page-bar">
          <i />
          <i />
          <i />
        </span>
        <span className="thread-scene-lines">
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
        <span className="thread-scene-page-image" />
      </>
    )
  }

  const content = {
    idea: {
      app: nl ? 'Notities' : 'Notes',
      icon: '≡',
      title: nl ? 'Het begint met een idee.' : 'It starts with an idea.',
      caption: nl ? 'Minder stappen. Meer rust.' : 'Fewer steps. More calm.',
    },
    conversation: {
      app: nl ? 'Gesprek' : 'Conversation',
      icon: '◒',
      title: nl ? '“Laten we het eenvoudiger maken.”' : '“Let’s make it simpler.”',
      caption: nl ? 'Productoverleg · 10:30' : 'Product sync · 10:30',
    },
    decision: {
      app: nl ? 'Een besluit' : 'A decision',
      icon: '↗',
      title: nl ? 'Eerst de essentie.' : 'Start with the essentials.',
      caption: nl ? 'De nieuwe richting staat.' : 'The new direction is clear.',
    },
  }[kind]

  if (!content) return null

  return (
    <>
      <span className="thread-scene-source">
        <i>{content.icon}</i>
        {content.app}
      </span>
      <strong className="thread-scene-page-title">{content.title}</strong>
      {kind === 'conversation' ? (
        <span className="thread-scene-waveform">
          {Array.from({ length: 19 }, (_, index) => (
            <i key={`wave-${index}`} style={{ height: `${(6 + Math.sin(index * 1.7) ** 2 * 20).toFixed(3)}px` }} />
          ))}
        </span>
      ) : kind === 'decision' ? (
        <span className="thread-scene-checks">
          <i>
            ✓ <b>{nl ? 'Richting gekozen' : 'Direction agreed'}</b>
          </i>
          <i>
            ✓ <b>{nl ? 'Context bewaard' : 'Context preserved'}</b>
          </i>
        </span>
      ) : (
        <span className="thread-scene-diagram">
          <i />
          <i />
          <i />
          <b />
        </span>
      )}
      <span className="thread-scene-page-caption">{content.caption}</span>
    </>
  )
}

export function ThreadScene({ locale = 'nl' }: { locale?: Locale }) {
  const surfaceRef = useRef<HTMLButtonElement>(null)
  const sculptureRef = useRef<HTMLSpanElement>(null)
  const memoryRef = useRef<HTMLSpanElement>(null)
  const floorRef = useRef<HTMLSpanElement>(null)
  const pageRefs = useRef<Array<HTMLSpanElement | null>>([])
  const inputRef = useRef<ThreadInput | null>(null)
  const pressedRef = useRef(false)
  const latchedRef = useRef(false)
  const pointerRef = useRef(0)
  const pressOriginRef = useRef({ x: 0, gathered: false })
  const [gathered, setGathered] = useState(false)
  const [selectedMemory, setSelectedMemory] = useState(1)

  useEffect(() => {
    const surface = surfaceRef.current
    const sculpture = sculptureRef.current
    if (!surface || !sculpture) return

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const gather: Spring = { position: 0, velocity: 0, target: 0 }
    const pointer: Spring = { position: 0, velocity: 0, target: 0 }
    const presence: Spring = { position: 0, velocity: 0, target: 0 }
    let frame = 0
    let lastTime = 0
    let visible = true
    let baseScale = 0.82

    const paint = () => {
      const gatheredScale = baseScale < 0.6 ? 0.72 : 0.955
      const lift = baseScale < 0.6 ? 6 : 24
      const scale = baseScale + (gatheredScale - baseScale) * gather.position
      sculpture.style.transform = `translateY(${(-lift * gather.position).toFixed(2)}px) scale(${scale}) rotateX(-7deg) rotateZ(-3deg)`

      for (let index = 0; index < pageCount; index++) {
        const page = pageRefs.current[index]
        if (page) page.style.transform = pageTransform(index, gather.position, pointer.position, presence.position)
      }

      if (memoryRef.current) {
        memoryRef.current.style.opacity = `${Math.max(0, Math.min(1, (gather.position - 0.45) / 0.4))}`
        memoryRef.current.style.transform = `translate3d(${(pointer.position * 150 * gather.position).toFixed(2)}px, 0, 0) rotateX(34deg) rotateY(-18deg) rotateZ(-12deg) translateZ(39px) scale(1.15)`
      }

      if (floorRef.current) {
        floorRef.current.style.transform = `translateX(${(pointer.position * 140 * gather.position).toFixed(2)}px) scaleX(${(1 - gather.position * 0.72).toFixed(3)})`
      }
    }

    const tick = (now: number) => {
      frame = 0
      if (!visible || document.hidden) return

      const delta = Math.min(0.032, lastTime ? (now - lastTime) / 1000 : 1 / 60)
      lastTime = now
      advanceSpring(gather, delta, 150, 19)
      advanceSpring(pointer, delta, 165, 23)
      advanceSpring(presence, delta, 150, 22)
      paint()

      if ([gather, pointer, presence].some((value) => value.position !== value.target || value.velocity !== 0)) {
        frame = requestAnimationFrame(tick)
      }
    }

    const requestPaint = () => {
      if (reducedMotion.matches) {
        for (const value of [gather, pointer, presence]) {
          value.position = value.target
          value.velocity = 0
        }
        paint()
        return
      }

      if (!frame && visible && !document.hidden) {
        lastTime = 0
        frame = requestAnimationFrame(tick)
      }
    }

    inputRef.current = {
      move: (x) => {
        pointer.target = reducedMotion.matches ? 0 : x
        requestPaint()
      },
      hover: (active) => {
        presence.target = active && !reducedMotion.matches ? 1 : 0
        requestPaint()
      },
      gather: (active) => {
        gather.target = active ? 1 : 0
        requestPaint()
      },
    }

    const resize = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? surface.clientWidth
      baseScale = Math.min(0.82, width / 1190)
      paint()
    })
    resize.observe(surface)

    const observer = new IntersectionObserver(
      (entries) => {
        visible = entries[0]?.isIntersecting ?? true
        if (visible) requestPaint()
        else {
          cancelAnimationFrame(frame)
          frame = 0
        }
      },
      { threshold: 0.01 }
    )
    observer.observe(surface)

    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(frame)
        frame = 0
      } else requestPaint()
    }

    const onMotion = () => requestPaint()
    document.addEventListener('visibilitychange', onVisibility)
    reducedMotion.addEventListener('change', onMotion)
    paint()

    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      observer.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      reducedMotion.removeEventListener('change', onMotion)
      inputRef.current = null
    }
  }, [])

  const setHolding = (holding: boolean) => {
    pressedRef.current = holding
    setGathered(holding || latchedRef.current)
    inputRef.current?.gather(holding || latchedRef.current)
  }

  const movePointer = (event: PointerEvent<HTMLButtonElement>) => {
    if (latchedRef.current && !pressedRef.current) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const position = Math.max(-1, Math.min(1, ((event.clientX - bounds.left) / bounds.width - 0.5) * 2))
    pointerRef.current = position
    inputRef.current?.move(position)
  }

  const toggleGathering = () => {
    latchedRef.current = !latchedRef.current
    setGathered(latchedRef.current)
    inputRef.current?.gather(latchedRef.current)
  }

  const selectWithKeyboard = (direction: number) => {
    const next = (selectedMemory + direction + 3) % 3
    setSelectedMemory(next)
    latchedRef.current = true
    pointerRef.current = (next - 1) * 0.7
    inputRef.current?.move(pointerRef.current)
    setHolding(false)
  }

  const nl = locale === 'nl'
  const memory = memories[locale][selectedMemory]

  return (
    <div className="thread-scene" data-gathered={gathered}>
      <button
        ref={surfaceRef}
        type="button"
        className="thread-scene-surface"
        aria-label={
          nl
            ? 'Pak de draad op. Sleep naar een gedachte en laat los om deze terug te vinden. Enter brengt samen of laat los. Pijltjestoetsen kiezen een gedachte.'
            : 'Pick up the thread. Drag to a thought and release to find it again. Enter gathers or releases. Arrow keys choose a thought.'
        }
        aria-pressed={gathered}
        onPointerEnter={(event) => {
          if (event.pointerType !== 'touch') inputRef.current?.hover(true)
        }}
        onPointerMove={movePointer}
        onPointerLeave={() => {
          inputRef.current?.hover(false)
          if (!pressedRef.current && !latchedRef.current) inputRef.current?.move(0)
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          pressOriginRef.current = { x: event.clientX, gathered: latchedRef.current }
          event.currentTarget.setPointerCapture(event.pointerId)
          pressedRef.current = true
          movePointer(event)
          inputRef.current?.hover(true)
          setHolding(true)
        }}
        onPointerUp={(event) => {
          const wasClick = Math.abs(event.clientX - pressOriginRef.current.x) < 8
          latchedRef.current = !(pressOriginRef.current.gathered && wasClick)
          setSelectedMemory(Math.min(2, Math.floor(((pointerRef.current + 1) / 2) * 3)))
          setHolding(false)
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId)
          if (event.pointerType === 'touch') inputRef.current?.hover(false)
        }}
        onPointerCancel={() => {
          setHolding(false)
          inputRef.current?.hover(false)
        }}
        onLostPointerCapture={() => setHolding(false)}
        onClick={(event) => {
          if (event.detail === 0) toggleGathering()
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault()
            selectWithKeyboard(event.key === 'ArrowRight' ? 1 : -1)
          }

          if (event.key === 'Escape') {
            latchedRef.current = false
            setHolding(false)
          }
        }}
        onBlur={() => setHolding(false)}
      >
        <span className="thread-scene-floor" ref={floorRef} aria-hidden="true" />
        <span className="thread-scene-world" aria-hidden="true">
          <span className="thread-scene-sculpture" ref={sculptureRef}>
            {Array.from({ length: pageCount }, (_, index) => {
              const kind = featuredPages.get(index)
              const isBlue = index >= 35 && index <= 41

              return (
                <span
                  key={`thread-page-${index}`}
                  ref={(node) => {
                    pageRefs.current[index] = node
                  }}
                  className={`thread-scene-page${kind ? ` thread-scene-feature thread-scene-${kind}` : ''}${isBlue ? ' thread-scene-blue' : ''}`}
                  style={
                    {
                      transform: pageTransform(index, 0, 0, 0),
                      '--thread-page-tone': `${(97 - Math.sin((index / pageCount) * Math.PI) * 7).toFixed(3)}%`,
                    } as CSSProperties
                  }
                >
                  <FragmentContents kind={kind} locale={locale} />
                </span>
              )
            })}
            <span ref={memoryRef} className="thread-scene-memory">
              <span className="thread-scene-memory-label">
                <i>r</i> Remember
              </span>
              <strong>{memory.text}</strong>
              <span className="thread-scene-memory-rule" />
              <span className="thread-scene-memory-item">{memory.source}</span>
            </span>
          </span>
        </span>
        <span className="thread-scene-invitation">
          <svg viewBox="0 0 18 18" aria-hidden="true">
            <path d="M5.5 6.5 3 9l2.5 2.5M12.5 6.5 15 9l-2.5 2.5M3 9h12" />
          </svg>
          <span>
            {gathered ? (nl ? 'Verder ontdekken' : 'Keep exploring') : nl ? 'Pak de draad op' : 'Pick up the thread'}
          </span>
        </span>
      </button>
      <div className="thread-scene-found" aria-live="polite" aria-atomic="true">
        {gathered && (
          <>
            <span>
              {memory.source} · {nl ? 'Voorbeeld' : 'Example'}
            </span>
            <p>{memory.text}</p>
          </>
        )}
      </div>
    </div>
  )
}
