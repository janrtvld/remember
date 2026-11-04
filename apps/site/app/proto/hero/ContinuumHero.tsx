'use client'

import { type CSSProperties, useState } from 'react'
import { DownloadButton } from '../../../components/DownloadButton'
import './continuum.css'

const chapters = [
  {
    label: 'A day of work',
    title: 'An idea. A conversation. A useful detour.',
    detail: 'Your work moves between places. Remember keeps the thread.',
  },
  {
    label: 'The connections',
    title: 'The small things start to add up.',
    detail: 'The decisions, context, and details become a memory you can return to.',
  },
  {
    label: 'Back in flow',
    title: 'And you’re right where you left off.',
    detail: 'Pick up the thread yourself, or bring it into Codex and Claude.',
  },
] as const

const fragmentCount = 76

function cssNumber(value: number) {
  return Number(value.toFixed(3))
}

function fragmentStyle(index: number, chapter: number): CSSProperties {
  const progress = index / (fragmentCount - 1)
  const wave = progress * Math.PI * 2 - Math.PI * 0.4
  const gathering = chapter === 1
  const collected = chapter === 2
  const x = collected ? (progress - 0.5) * 16 : (progress - 0.5) * (gathering ? 670 : 900)
  const y = collected ? (progress - 0.5) * 28 : Math.sin(wave) * (gathering ? 132 : 79)
  const z = collected ? progress * 32 : Math.cos(wave) * (gathering ? 120 : 64)
  const rotateX = collected ? 46 : 42 + Math.cos(wave) * 27
  const rotateY = collected ? -22 : Math.sin(wave) * 47
  const rotateZ = collected ? -12 : -18 + Math.cos(wave) * 20

  return {
    transform: `translate3d(${cssNumber(x)}px, ${cssNumber(y)}px, ${cssNumber(z)}px) rotateX(${cssNumber(rotateX)}deg) rotateY(${cssNumber(rotateY)}deg) rotateZ(${cssNumber(rotateZ)}deg) scale(${collected ? 1.5 : 1})`,
    '--continuum-delay': `${index * 2}ms`,
    '--continuum-page-tone': `${cssNumber(96 - Math.sin(progress * Math.PI) * 9)}%`,
    '--continuum-ink': index > 46 && index < 56 ? '#b7c8f5' : '#8190a8',
  } as CSSProperties
}

function Fragment({ index, chapter }: { index: number; chapter: number }) {
  const isBlue = index >= 48 && index <= 53
  const isCode = index >= 25 && index <= 35

  return (
    <div
      className={`continuum-fragment${isBlue ? ' continuum-fragment-blue' : ''}${isCode ? ' continuum-fragment-code' : ''}`}
      style={fragmentStyle(index, chapter)}
    >
      <div className="continuum-fragment-top">
        <span className="continuum-fragment-mark" />
        <span />
        <span />
      </div>
      <div className="continuum-fragment-body">
        <span className="continuum-fragment-heading" />
        <span />
        <span />
        <span />
        <span />
        <span />
        <div className="continuum-fragment-image" />
        <span />
        <span />
      </div>
      <span className="continuum-fragment-corner" />
    </div>
  )
}

export function ContinuumHero() {
  const [chapter, setChapter] = useState(0)
  const currentChapter = chapters[chapter]

  return (
    <section className="continuum" aria-labelledby="continuum-title" data-chapter={chapter}>
      <div className="continuum-intro">
        <p className="continuum-eyebrow">A living memory for your work</p>
        <h1 id="continuum-title">
          Ideas move.
          <br />
          <span className="continuum-title-secondary">Context stays.</span>
        </h1>
        <p className="continuum-description">
          Your conversations, decisions, and useful detours.
          <br className="continuum-desktop-break" /> Remember keeps the thread.
        </p>
        <div className="continuum-actions">
          <DownloadButton size="small" className="continuum-download">
            Download for Mac <span aria-hidden="true">↗</span>
          </DownloadButton>
          <a className="continuum-preview-link" href="#product-preview">
            Meet Remember <span aria-hidden="true">→</span>
          </a>
        </div>
      </div>

      <figure
        className="continuum-art"
        aria-label="A sculptural ribbon of work fragments coming together into a memory"
      >
        <div className="continuum-floor" aria-hidden="true" />
        <div className="continuum-world" aria-hidden="true">
          <div className="continuum-sculpture">
            {Array.from({ length: fragmentCount }, (_, index) => (
              <Fragment key={`fragment-${index}`} index={index} chapter={chapter} />
            ))}
            <div className="continuum-memory-face">
              <div className="continuum-memory-icon">r</div>
              <span>Nothing to retrace.</span>
              <strong>Just keep going.</strong>
              <div className="continuum-memory-line" />
              <div className="continuum-memory-line" />
              <div className="continuum-memory-line" />
            </div>
          </div>
        </div>

        <div className="continuum-art-annotation continuum-art-annotation-start" aria-hidden="true">
          <span>01 / The first thought</span>
          <i />
        </div>
        <div className="continuum-art-annotation continuum-art-annotation-end" aria-hidden="true">
          <i />
          <span>Every detail, connected.</span>
        </div>

        <figcaption className="continuum-art-caption">
          <span className="continuum-caption-kicker">A day, remembered</span>
          <span>Illustration</span>
        </figcaption>
      </figure>

      <div className="continuum-story">
        <div className="continuum-chapters" role="group" aria-label="Explore how a day becomes a memory">
          {chapters.map((item, index) => (
            <button
              key={item.label}
              type="button"
              aria-pressed={chapter === index}
              onClick={() => setChapter(index)}
              className="continuum-chapter"
            >
              <span className="continuum-chapter-number" aria-hidden="true">
                0{index + 1}
              </span>
              {item.label}
            </button>
          ))}
        </div>
        <div className="continuum-story-copy" aria-live="polite" aria-atomic="true">
          <p>{currentChapter.title}</p>
          <span>{currentChapter.detail}</span>
        </div>
      </div>

      <p className="continuum-footnote">
        <span className="continuum-local-dot" aria-hidden="true" />
        Local on your Mac. Connected to Codex &amp; Claude.
      </p>
    </section>
  )
}
