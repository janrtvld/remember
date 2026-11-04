'use client'

import { Description, Field, Label } from '@headlessui/react'
import { useLocalBridge } from '@internal/context/LocalBridgeProvider'
import { getDictationBridge } from '@internal/lib/dictationBridge'
import { eventToAccelerator, formatAccelerator } from '@internal/lib/dictationShortcut'
import { useI18n } from '@internal/locales'
import { Button } from '@internal/ui/Button'
import { DropdownSelect } from '@internal/ui/Dropdown'
import { Spinner } from '@internal/ui/Spinner'
import { Switch } from '@internal/ui/Switch'
import type { DictationPreferences, DictationState } from '@remember/shared'
import { type ReactNode, useEffect, useEffectEvent, useState } from 'react'

function Row({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <Field className="grid min-h-[72px] gap-3 px-5 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <Label className="block text-balance font-medium text-slate-900 text-ui">{title}</Label>
        {description ? (
          <Description className="mt-0.5 max-w-prose text-pretty text-slate-500 text-xs leading-[1.5]">
            {description}
          </Description>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-2 sm:justify-end">{children}</div>
    </Field>
  )
}

export function DictationSettings() {
  const local = useLocalBridge()
  const { t } = useI18n()
  const [state, setState] = useState<DictationState | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const preferences = local.settings?.dictation

  useEffect(() => {
    const bridge = getDictationBridge()
    if (!bridge) return
    let mounted = true
    void bridge
      .getState()
      .then((value) => {
        if (mounted) setState(value)
      })
      .catch(() => {
        if (mounted) setError(true)
      })
    const unsubscribe = bridge.onState(setState)
    const refresh = () => {
      void bridge
        .getState()
        .then((value) => {
          if (mounted) setState(value)
        })
        .catch(() => undefined)
    }
    window.addEventListener('focus', refresh)
    void bridge.refreshMicrophones()
    return () => {
      mounted = false
      unsubscribe()
      window.removeEventListener('focus', refresh)
      void bridge.setShortcutRecording(false)
    }
  }, [])

  async function save(patch: Partial<DictationPreferences>) {
    if (!preferences) return
    setSaving(true)
    setError(false)
    try {
      await local.updateSettings({ dictation: { ...preferences, ...patch } })
      const next = await getDictationBridge()?.getState()
      if (next) setState(next)
    } catch {
      setError(true)
    } finally {
      setSaving(false)
    }
  }

  const saveShortcut = useEffectEvent((shortcut: string) => {
    void save({ shortcut })
  })

  useEffect(() => {
    if (!capturing) return
    const bridge = getDictationBridge()
    const finish = () => {
      setCapturing(false)
      void bridge?.setShortcutRecording(false)
    }
    const keydown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') return finish()
      const shortcut = eventToAccelerator(event)
      if (!shortcut) return
      finish()
      saveShortcut(shortcut)
    }
    window.addEventListener('keydown', keydown, true)
    window.addEventListener('blur', finish)
    return () => {
      window.removeEventListener('keydown', keydown, true)
      window.removeEventListener('blur', finish)
      void bridge?.setShortcutRecording(false)
    }
  }, [capturing])

  if (!preferences) return null
  const disabled = !state || saving
  const recording = state?.status === 'recording' || state?.status === 'starting'
  const microphoneOptions = ['', ...(state?.microphones.map((microphone) => microphone.id) ?? [])]
  const chosenMicrophone = microphoneOptions.includes(preferences.microphoneId ?? '')
    ? (preferences.microphoneId ?? '')
    : ''

  return (
    <section id="dictation" aria-label={t('Dictatie')}>
      <div className="divide-y divide-slate-100">
        <Row title={t('Microfoon')}>
          <DropdownSelect
            ariaLabel={t('Microfoon voor dictatie')}
            className="max-w-full sm:max-w-64"
            value={chosenMicrophone}
            options={microphoneOptions}
            disabled={disabled || recording}
            formatLabel={(id) =>
              state?.microphones.find((microphone) => microphone.id === id)?.label ?? t('Systeemstandaard')
            }
            onChange={(id) => void save({ microphoneId: id || null })}
          />
        </Row>
        <Row
          title={t('Sneltoets')}
          description={
            state && preferences.enabled && preferences.shortcut && !state.shortcutRegistered && !capturing
              ? t('Deze sneltoets is al in gebruik. Kies een andere.')
              : t('Druk om te beginnen en opnieuw om te stoppen.')
          }
        >
          <Button
            size="small"
            variant="outline"
            disabled={disabled}
            aria-label={t('Sneltoets voor dictatie opnemen')}
            onClick={async () => {
              try {
                await getDictationBridge()?.setShortcutRecording(true)
                setCapturing(true)
              } catch {
                setError(true)
              }
            }}
          >
            {capturing
              ? t('Druk een toetscombinatie…')
              : formatAccelerator(preferences.shortcut) || t('Kies sneltoets')}
          </Button>
          <Switch
            aria-label={t('Dictatiesneltoets inschakelen')}
            checked={preferences.enabled}
            disabled={disabled}
            onChange={(enabled) => void save({ enabled })}
          />
        </Row>
        <Row title={t('Automatisch invoegen')} description={t('Voeg de tekst in waar je cursor staat.')}>
          {preferences.autoInsert && state && !state.accessibilityGranted ? (
            <Button size="small" onClick={() => void getDictationBridge()?.requestAccessibility()}>
              {t('Sta toegang toe')}
            </Button>
          ) : null}
          <Switch
            checked={preferences.autoInsert}
            disabled={disabled}
            onChange={(autoInsert) => void save({ autoInsert })}
          />
        </Row>
        <Row title={t('Geluiden')} description={t('Een kort geluid bij starten, stoppen en afronden.')}>
          <Switch
            checked={preferences.soundsEnabled}
            disabled={disabled}
            onChange={(soundsEnabled) => void save({ soundsEnabled })}
          />
        </Row>
        <Row title={t('Media zachter tijdens dictatie')}>
          <Switch
            checked={preferences.dimMediaDuringRecording}
            disabled={disabled}
            onChange={(dimMediaDuringRecording) => void save({ dimMediaDuringRecording })}
          />
        </Row>
        <Row
          title={t('Ingebouwde microfoon bij afspelende audio')}
          description={t('Voorkom dat een Bluetooth-headset de geluidskwaliteit verlaagt.')}
        >
          <Switch
            checked={preferences.forceBuiltInMicWhenAudioPlaying}
            disabled={disabled}
            onChange={(forceBuiltInMicWhenAudioPlaying) => void save({ forceBuiltInMicWhenAudioPlaying })}
          />
        </Row>
        {!state?.modelReady ? (
          <Row
            title={t('Spraakherkenning')}
            description={
              state?.modelPreparing
                ? t('Het spraakmodel wordt voorbereid…')
                : t('Download het lokale spraakmodel voor dictatie en gesprekken.')
            }
          >
            {!state ? (
              <Spinner className="size-4" />
            ) : state.modelPreparing ? (
              <>
                <span className="text-slate-500 text-xs tabular-nums">
                  {state.modelProgress === null ? t('Installeren…') : `${Math.round(state.modelProgress * 100)}%`}
                </span>
                <Button size="small" onClick={() => void getDictationBridge()?.cancelModelPreparation()}>
                  {t('Annuleren')}
                </Button>
              </>
            ) : (
              <Button
                size="small"
                disabled={local.settings?.offlineMode}
                onClick={() => void getDictationBridge()?.prepareModel()}
              >
                {t('Download model')}
              </Button>
            )}
          </Row>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="px-5 py-3 text-danger-700 text-xs">
          {t('De instelling kon niet worden opgeslagen. Probeer opnieuw.')}
        </p>
      ) : null}
      {state?.error === 'download' ? (
        <p role="alert" className="px-5 py-3 text-danger-700 text-xs">
          {t('Het spraakmodel kon niet worden gedownload. Probeer opnieuw.')}
        </p>
      ) : null}
      {state && !state.modelReady && local.settings?.offlineMode ? (
        <p className="px-5 py-3 text-slate-500 text-xs">
          {t('Schakel offline-modus uit om het spraakmodel te downloaden.')}
        </p>
      ) : null}
    </section>
  )
}
