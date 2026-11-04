'use client'

import { useEffect, useLayoutEffect, useRef } from 'react'
import './picker.css'

export function PrototypePicker({
  active,
  onSelect,
  onReplay,
  labels,
  position,
}: {
  active: number
  labels: string[]
  position?: 'top' | 'bottom'
  onSelect: (index: number) => void
  onReplay: () => void
}) {
  const picker = useRef<HTMLElement>(null)
  const highlight = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    const moveHighlight = () => {
      const selected = picker.current?.querySelectorAll<HTMLElement>('.proto-picker-item')[active]
      if (!selected || !highlight.current) return

      if (picker.current) {
        picker.current.dataset.position =
          position === 'top'
            ? window.innerWidth >= 800
              ? 'top'
              : 'bottom'
            : (position ?? (active === 2 && window.innerWidth > 700 ? 'top' : 'bottom'))
      }

      highlight.current.style.width = `${selected.offsetWidth}px`
      highlight.current.style.transform = `translateX(${selected.offsetLeft}px)`
    }

    moveHighlight()
    window.addEventListener('resize', moveHighlight)
    return () => window.removeEventListener('resize', moveHighlight)
  }, [active, position])

  useEffect(() => {
    let secondFrame = 0
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => picker.current?.setAttribute('data-ready', ''))
    })

    return () => {
      cancelAnimationFrame(firstFrame)
      cancelAnimationFrame(secondFrame)
    }
  }, [])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        (target instanceof HTMLElement &&
          (target.isContentEditable ||
            /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) ||
            target.closest('#product-preview, [data-scene-input]')))
      ) {
        return
      }

      const number = Number(event.key)
      if (number >= 1 && number <= labels.length) {
        event.preventDefault()
        onSelect(number - 1)
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault()
        onSelect((active + (event.key === 'ArrowRight' ? 1 : labels.length - 1)) % labels.length)
      } else if (event.key.toLowerCase() === 'r') {
        onReplay()
      }
    }

    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [active, labels.length, onSelect, onReplay])

  return (
    <nav className="proto-picker" data-layout={position} aria-label="Prototype variants" ref={picker}>
      <span className="proto-picker-highlight" aria-hidden="true" ref={highlight} />
      {labels.map((name, index) => (
        <button
          key={name}
          type="button"
          className="proto-picker-item"
          data-active={active === index ? '' : undefined}
          aria-current={active === index ? 'true' : undefined}
          title={`${index + 1} · ${name}`}
          onClick={() => onSelect(index)}
        >
          {name}
        </button>
      ))}
      <span className="proto-picker-divider" aria-hidden="true" />
      <button
        type="button"
        className="proto-picker-item proto-picker-replay"
        aria-label="Replay animation (R)"
        onClick={onReplay}
      >
        ↻
      </button>
    </nav>
  )
}
