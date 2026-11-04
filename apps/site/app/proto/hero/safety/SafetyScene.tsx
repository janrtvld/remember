'use client'

import { useEffect, useRef, useState } from 'react'
import type { SiteLocale } from '../../../../lib/locale-shared'
import type { SafetyRuntime } from './safety-runtime'
import type { SceneVariant } from './scene-types'
import { workFragments } from './work-fragments'

export function SafetyScene({ variant, locale }: { variant: SceneVariant; locale: SiteLocale }) {
  const mount = useRef<HTMLDivElement>(null)
  const runtime = useRef<SafetyRuntime | null>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [paused, setPaused] = useState(false)
  const [reduced, setReduced] = useState(false)
  const [count, setCount] = useState(0)
  const [selected, setSelected] = useState<number | null>(null)
  const [open, setOpen] = useState(false)
  const nl = locale === 'nl'

  useEffect(() => {
    let cancelled = false
    import('./safety-runtime')
      .then(({ createSafetyRuntime }) => {
        if (cancelled || !mount.current) return
        try {
          runtime.current = createSafetyRuntime(mount.current, {
            variant,
            onCapture: setCount,
            onSelect: setSelected,
            onOpenChange: setOpen,
            onReady: (isReduced) => {
              setReduced(isReduced)
              setPaused(isReduced)
              setReady(true)
            },
          })
        } catch (error) {
          console.error('Safety net preview could not start', error)
          setFailed(true)
        }
      })
      .catch(() => setFailed(true))

    return () => {
      cancelled = true
      runtime.current?.dispose()
      runtime.current = null
    }
  }, [variant])

  return (
    <div className="safety-experience" data-scene-input="">
      <div
        className="safety-stage"
        ref={mount}
        data-ready={ready}
        aria-label={
          nl
            ? 'Interactief vangnet met momenten uit een werkdag'
            : 'Interactive safety net holding moments from a workday'
        }
      >
        {!ready && (
          <div className="safety-loading" role="status">
            {failed
              ? nl
                ? 'De 3D-preview kon niet starten.'
                : 'The 3D preview could not start.'
              : nl
                ? 'Je vangnet krijgt vorm…'
                : 'Your safety net is taking shape…'}
          </div>
        )}
      </div>
      <div className="safety-stage-label" aria-hidden="true">
        <span /> {nl ? 'Een dag, opgevangen' : 'A day, caught'}
      </div>
      <div className="safety-playback">
        <span className="safety-example">{nl ? 'Interactief voorbeeld' : 'Interactive example'}</span>
        {!reduced && (
          <button
            type="button"
            disabled={!ready}
            onClick={() => {
              runtime.current?.pause(!paused)
              setPaused(!paused)
            }}
            aria-label={
              paused ? (nl ? 'Animatie afspelen' : 'Play animation') : nl ? 'Animatie pauzeren' : 'Pause animation'
            }
            title={paused ? 'Afspelen' : 'Pauzeren'}
          >
            {paused ? '▷' : 'Ⅱ'}
          </button>
        )}
      </div>
      <div className="safety-context" aria-live="polite" aria-atomic="true">
        {selected === null ? (
          <>
            <strong>{nl ? 'Werk verder. Het blijft hier.' : 'Keep going. It stays here.'}</strong>
            <span>{nl ? 'Pak een moment uit je vangnet.' : 'Pick a moment from your safety net.'}</span>
          </>
        ) : (
          <>
            <strong>{workFragments[selected].detail}</strong>
            <span>
              {workFragments[selected].app} · {workFragments[selected].time} ·{' '}
              {nl ? 'terug bij de bron' : 'back to the source'}
            </span>
          </>
        )}
      </div>
      <div className="safety-controls">
        <button type="button" className="safety-add" disabled={!ready} onClick={() => runtime.current?.drop()}>
          <span aria-hidden="true">＋</span>
          {nl ? 'Laat iets vallen' : 'Drop something'}
        </button>
        <span className="safety-control-divider" aria-hidden="true" />
        <button
          type="button"
          disabled={!ready || count < 1}
          aria-pressed={selected !== null}
          onClick={() => runtime.current?.recall(selected ?? 0)}
        >
          {selected === null ? (nl ? 'Pak een moment terug' : 'Retrieve a moment') : nl ? 'Leg terug' : 'Put it back'}
          <span aria-hidden="true">↗</span>
        </button>
        <button
          type="button"
          disabled={!ready || count < 1}
          onClick={() => runtime.current?.recallNext()}
          aria-label={nl ? 'Volgend opgevangen moment' : 'Next captured moment'}
          title={nl ? 'Volgend moment' : 'Next moment'}
        >
          →
        </button>
        {variant === 'drawer' && (
          <button
            type="button"
            disabled={!ready}
            aria-pressed={open}
            onClick={() => {
              runtime.current?.open(!open)
              setOpen(!open)
            }}
          >
            {open ? (nl ? 'Lade dicht' : 'Close drawer') : nl ? 'Lade open' : 'Open drawer'}
          </button>
        )}
      </div>
      <p className="safety-instruction">
        {nl
          ? variant === 'drawer'
            ? 'Sleep aan de lade. Klik op een moment om het terug te halen.'
            : 'Trek aan het vangnet. Klik op een moment om het terug te halen.'
          : 'Pull the safety net. Click a moment to retrieve it.'}
      </p>
    </div>
  )
}
