'use client'

import { Dialog, DialogBackdrop, DialogDescription, DialogPanel, DialogTitle } from '@headlessui/react'
import { useI18n } from '@internal/locales'
import { Button } from '@internal/ui/Button'
import { IconButton } from '@internal/ui/IconButton'
import type { CapturePauseInput, CapturePauseSource } from '@remember/shared'
import {
  Check as IconCheckmark1Small,
  X as IconCrossSmall,
  AudioLines as IconWave,
  AppWindow as IconWindowApp,
} from 'lucide-react'
import { type FormEvent, useEffect, useId, useState } from 'react'
import { type CapturePauseDuration, capturePauseDurationMs, localDateTimeValue } from './capturePause'

const ALL_SOURCES: CapturePauseSource[] = ['audio', 'capture']

const durationChoices: Array<{ value: CapturePauseDuration; label: string }> = [
  { value: '15-minutes', label: '15 minuten' },
  { value: '1-hour', label: '1 uur' },
  { value: 'today', label: 'Vandaag' },
  { value: 'until-resumed', label: 'Tot ik hervat' },
  { value: 'custom', label: 'Kies…' },
]

function SourceChoice({
  source,
  checked,
  onChange,
}: {
  source: CapturePauseSource
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  const { t } = useI18n()
  const audio = source === 'audio'
  const Icon = audio ? IconWave : IconWindowApp
  const title = audio ? t('Audio') : t('Vastleggen')
  const detail = audio ? t('Microfoon en systeemaudio.') : t('App- en venstercontext.')

  return (
    <label className="group flex min-h-14 cursor-pointer items-center gap-3 outline-none ring-inset has-focus-visible:ring-2 has-focus-visible:ring-slate-400">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="peer sr-only"
      />
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500 transition-colors duration-150 motion-reduce:transition-none">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-slate-800 text-sm">{title}</span>
        <span className="mt-0.5 block text-pretty text-slate-500 text-xs leading-4">{detail}</span>
      </span>
      <span className="flex size-5 shrink-0 items-center justify-center rounded-md border border-black/[0.1] bg-white text-transparent transition-[background-color,border-color,color] duration-150 peer-checked:border-blue-700 peer-checked:bg-blue-700 peer-checked:text-white motion-reduce:transition-none">
        <IconCheckmark1Small className="size-3.5" aria-hidden="true" />
      </span>
    </label>
  )
}

export function PauseCaptureDialog({
  open,
  pausedSources,
  pausedUntil,
  defaultSources = ALL_SOURCES,
  pending,
  onClose,
  onApply,
}: {
  open: boolean
  pausedSources: CapturePauseSource[]
  defaultSources?: CapturePauseSource[]
  pausedUntil: number | null
  pending: boolean
  onClose: () => void
  onApply: (input: CapturePauseInput) => Promise<void>
}) {
  const { t } = useI18n()
  const groupName = useId()
  const [sources, setSources] = useState<CapturePauseSource[]>(['audio', 'capture'])
  const [duration, setDuration] = useState<CapturePauseDuration>('1-hour')
  const [customUntil, setCustomUntil] = useState('')
  const [error, setError] = useState<string | null>(null)
  const hasExistingPause = pausedSources.length > 0

  useEffect(() => {
    if (!open) return
    setSources(pausedSources.length ? pausedSources : defaultSources)
    setError(null)
    if (hasExistingPause && pausedUntil == null) {
      setDuration('until-resumed')
      setCustomUntil('')
      return
    }
    if (hasExistingPause && pausedUntil != null && pausedUntil > Date.now()) {
      setDuration('custom')
      setCustomUntil(localDateTimeValue(pausedUntil))
      return
    }
    setDuration('1-hour')
    setCustomUntil(localDateTimeValue(Date.now() + 60 * 60_000))
  }, [defaultSources, hasExistingPause, open, pausedSources, pausedUntil])

  const minimumCustomTime = localDateTimeValue(Date.now() + 60_000)

  function toggleSource(source: CapturePauseSource, checked: boolean) {
    setSources((current) =>
      checked ? Array.from(new Set([...current, source])) : current.filter((candidate) => candidate !== source)
    )
    if (error) setError(null)
  }

  async function applyPause(input: CapturePauseInput) {
    setError(null)
    try {
      await onApply(input)
    } catch {
      setError(t('De pauze kon niet worden ingesteld. Probeer het opnieuw.'))
    }
  }

  async function apply(event: FormEvent) {
    event.preventDefault()
    if (!sources.length) {
      setError(t('Kies minimaal één onderdeel om te pauzeren.'))
      return
    }
    const durationMs = capturePauseDurationMs(duration, customUntil)
    if (durationMs === undefined) {
      setError(t('Kies een tijdstip in de toekomst.'))
      return
    }
    await applyPause({ sources, durationMs })
  }

  return (
    <Dialog open={open} onClose={pending ? () => undefined : onClose} className="app-no-drag relative z-50">
      <DialogBackdrop
        transition
        className="fixed inset-0 bg-modal-backdrop backdrop-blur-[1px] transition-opacity data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
      />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel
          transition
          className="w-full max-w-md origin-center overflow-hidden rounded-xl bg-white shadow-raised transition-[opacity,scale] data-[closed]:scale-[0.98] data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
        >
          <form onSubmit={apply} noValidate>
            <header className="flex min-h-12 items-center gap-3 border-black/[0.07] border-b px-5">
              <div className="min-w-0 flex-1 py-3">
                <DialogTitle className="font-semibold text-slate-950 text-md">{t('Pauze instellen')}</DialogTitle>
                <DialogDescription className="mt-0.5 text-pretty text-slate-500 text-xs leading-4">
                  {t('Kies wat Remember tijdelijk niet vastlegt.')}
                </DialogDescription>
              </div>
              <IconButton
                type="button"
                onClick={onClose}
                disabled={pending}
                aria-label={t('Sluit pauze-instellingen')}
                size="compact"
              >
                <IconCrossSmall className="size-4" aria-hidden="true" />
              </IconButton>
            </header>

            <div className="grid gap-5 px-5 py-5">
              <fieldset>
                <legend className="mb-1.5 font-medium text-slate-600 text-xs">{t('Wat pauzeer je?')}</legend>
                <div className="grid gap-1">
                  <SourceChoice
                    source="audio"
                    checked={sources.includes('audio')}
                    onChange={(checked) => toggleSource('audio', checked)}
                  />
                  <SourceChoice
                    source="capture"
                    checked={sources.includes('capture')}
                    onChange={(checked) => toggleSource('capture', checked)}
                  />
                </div>
              </fieldset>

              <fieldset>
                <legend className="mb-2 font-medium text-slate-600 text-xs">{t('Tot wanneer?')}</legend>
                <div className="flex flex-nowrap gap-1">
                  {durationChoices.map((choice) => (
                    <label key={choice.value} className="cursor-pointer">
                      <input
                        type="radio"
                        name={groupName}
                        value={choice.value}
                        checked={duration === choice.value}
                        onChange={() => {
                          setDuration(choice.value)
                          setError(null)
                        }}
                        className="peer sr-only"
                      />
                      <span className="flex h-8 items-center whitespace-nowrap rounded-lg border border-black/[0.08] bg-white px-2 font-medium text-slate-600 text-sm outline-none transition-[background-color,border-color,color,box-shadow] duration-150 hover:bg-slate-50 peer-checked:border-slate-300 peer-checked:bg-slate-100 peer-checked:text-slate-900 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-slate-400 motion-reduce:transition-none">
                        {t(choice.label)}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              {duration === 'custom' ? (
                <div>
                  <label htmlFor="capture-pause-until" className="mb-1.5 block font-medium text-slate-600 text-xs">
                    {t('Hervat op')}
                  </label>
                  <input
                    id="capture-pause-until"
                    type="datetime-local"
                    value={customUntil}
                    min={minimumCustomTime}
                    onChange={(event) => {
                      setCustomUntil(event.target.value)
                      if (error) setError(null)
                    }}
                    className="h-9 w-full rounded-lg border border-black/[0.1] bg-white px-3 text-base text-slate-800 outline-none transition-[border-color,box-shadow] duration-150 focus-visible:border-slate-400 focus-visible:ring-2 focus-visible:ring-slate-200 motion-reduce:transition-none"
                  />
                </div>
              ) : null}

              {error ? (
                <p role="alert" className="text-danger-700 text-xs">
                  {error}
                </p>
              ) : null}
            </div>

            <footer className="flex items-center justify-between gap-3 border-black/[0.07] border-t px-5 py-3.5">
              {hasExistingPause ? (
                <Button
                  type="button"
                  variant="text"
                  color="secondary"
                  disabled={pending}
                  onClick={() => void applyPause({ sources: [], durationMs: null })}
                >
                  {t('Hervat alles')}
                </Button>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                <Button type="button" variant="text" color="secondary" onClick={onClose} disabled={pending}>
                  {t('Annuleer')}
                </Button>
                <Button type="submit" disabled={pending || sources.length === 0}>
                  {pending ? t('Pauzeren…') : t('Pauze instellen')}
                </Button>
              </div>
            </footer>
          </form>
        </DialogPanel>
      </div>
    </Dialog>
  )
}
