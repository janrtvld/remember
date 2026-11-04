'use client'

import { useEffect, useRef, useState } from 'react'
import { DownloadButton } from '../../../components/DownloadButton'
import { createPrismRenderer } from './prism-renderer'
import './prism.css'

export function PrismHero() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<ReturnType<typeof createPrismRenderer>>(null)
  const [ready, setReady] = useState(false)
  const [perspective, setPerspective] = useState(0)

  useEffect(() => {
    if (!canvasRef.current) return

    rendererRef.current = createPrismRenderer(canvasRef.current, setReady)

    return () => {
      rendererRef.current?.dispose()
      rendererRef.current = null
    }
  }, [])

  return (
    <section className="prism-hero" aria-labelledby="prism-title">
      <div className="prism-composition">
        <div className="prism-copy">
          <h1 id="prism-title">
            A little less
            <br />
            on your mind.
          </h1>
          <p>Your ideas, decisions, and everything in between. Remember keeps the context, so you can keep going.</p>
          <div className="prism-actions">
            <DownloadButton size="small" className="prism-download">
              Download for Mac
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M3 8h9M8.5 4.5 12 8l-3.5 3.5"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </DownloadButton>
            <a className="prism-preview-link" href="#product-preview">
              Meet Remember <span aria-hidden="true">↗</span>
            </a>
          </div>
          <p className="prism-meta">On your Mac. With Codex &amp; Claude.</p>
        </div>

        <div
          className="prism-object"
          onPointerMove={(event) => {
            if (event.pointerType === 'touch') return
            const bounds = event.currentTarget.getBoundingClientRect()
            rendererRef.current?.point(
              ((event.clientX - bounds.left) / bounds.width - 0.5) * 2,
              ((event.clientY - bounds.top) / bounds.height - 0.5) * -2
            )
          }}
          onPointerLeave={() => rendererRef.current?.point(0, 0)}
        >
          <div className="prism-fallback" data-hidden={ready} aria-hidden="true">
            <div
              className="prism-fallback-stack"
              style={{ transform: `rotateX(-14deg) rotateY(${perspective * 90 - 28}deg) rotateZ(-6deg)` }}
            >
              {[0, 1, 2, 3, 4, 5, 6].map((leaf) => {
                const angle = (leaf - 3) * -0.19 + 0.1
                const x = Number((-Math.sin(angle) * 86).toFixed(3))
                const y = Number(((1 - Math.cos(angle)) * 86).toFixed(3))
                const rotateY = Number(((leaf - 3) * 5.7 - 6.9).toFixed(3))
                const rotateZ = Number(((-angle * 180) / Math.PI).toFixed(3))

                return (
                  <div
                    className="prism-fallback-leaf"
                    key={leaf}
                    style={{
                      transform: `translate3d(${x}px, ${y}px, ${(leaf - 3) * -19}px) rotateY(${rotateY}deg) rotateZ(${rotateZ}deg)`,
                    }}
                  />
                )
              })}
            </div>
          </div>
          <canvas
            ref={canvasRef}
            className="prism-canvas"
            data-ready={ready}
            role="img"
            aria-label="A sculpture of seven overlapping optical glass leaves"
          />
          <div className="prism-object-note">
            <span>Everything connects.</span>
            <button
              type="button"
              className="prism-turn"
              aria-label="Rotate the glass sculpture"
              onClick={() => {
                rendererRef.current?.turn()
                setPerspective((value) => value + 1)
              }}
            >
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path
                  d="M15.8 8.7a5.9 5.9 0 1 0-.7 4.4M16 4.7v4.2h-4.2"
                  stroke="currentColor"
                  strokeWidth="1.25"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>
      </div>
      <div className="prism-footer">
        <span>Remember for macOS</span>
        <a href="#product-preview" aria-label="Explore the Remember app">
          Explore Remember <span aria-hidden="true">↓</span>
        </a>
      </div>
    </section>
  )
}
