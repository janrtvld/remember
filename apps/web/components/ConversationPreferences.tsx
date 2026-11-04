'use client'

import { Description, Dialog, DialogBackdrop, DialogPanel, DialogTitle, Field, Label } from '@headlessui/react'
import { useLocalBridge } from '@internal/context/LocalBridgeProvider'
import { useI18n } from '@internal/locales'
import { Button } from '@internal/ui/Button'
import { IconButton } from '@internal/ui/IconButton'
import { Spinner } from '@internal/ui/Spinner'
import { Switch } from '@internal/ui/Switch'
import type { RevinoteConnectionStatus } from '@remember/shared'
import { X as IconCrossSmall, SlidersHorizontal as IconSettingsSliderHor } from 'lucide-react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { type ReactNode, useEffect, useState } from 'react'
import { modelSetupPresentation } from './modelSetupPresentation'

const controlButtonClassName =
  'outline-none transition-[background-color,border-color,color,transform] duration-150 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 active:scale-[0.96] disabled:bg-slate-50 disabled:text-slate-400 disabled:text-opacity-100 motion-reduce:transition-none'

function PreferenceRow({
  title,
  description,
  children,
}: {
  title: string
  description: ReactNode
  children: ReactNode
}) {
  return (
    <section className="grid min-h-[72px] gap-3 px-5 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <h3 className="text-balance font-medium text-slate-900 text-ui">{title}</h3>
        <div className="mt-0.5 max-w-prose text-pretty text-slate-500 text-xs leading-[1.5]">{description}</div>
      </div>
      <div className="flex shrink-0 items-center sm:justify-end">{children}</div>
    </section>
  )
}

export function ConversationPreferences({
  open: controlledOpen,
  onOpenChange,
}: {
  open?: boolean
  onOpenChange?: (open: boolean) => void
} = {}) {
  const local = useLocalBridge()
  const { dateLocale, locale, t } = useI18n()
  const [internalOpen, setInternalOpen] = useState(false)
  const searchParams = useSearchParams()
  const pathname = usePathname()
  const router = useRouter()
  const open = (controlledOpen ?? internalOpen) || searchParams.get('preferences') === '1'
  function setOpen(next: boolean) {
    ;(onOpenChange ?? setInternalOpen)(next)
    if (!next && searchParams.has('preferences')) {
      const params = new URLSearchParams(searchParams)
      params.delete('preferences')
      router.replace(`${pathname}${params.size ? `?${params}` : ''}`, { scroll: false })
    }
  }
  const [isUpdatingAudioCapture, setIsUpdatingAudioCapture] = useState(false)
  const [isUpdatingAutomaticRevinoteProcessing, setIsUpdatingAutomaticRevinoteProcessing] = useState(false)
  const [revinoteStatus, setRevinoteStatus] = useState<RevinoteConnectionStatus | null>(null)
  const [revinoteStatusError, setRevinoteStatusError] = useState(false)
  const [revinoteBusy, setRevinoteBusy] = useState(false)
  const settings = local.settings
  const state = local.state
  const offlineMode = settings?.offlineMode === true

  useEffect(() => {
    if (!open || !local.bridge || !settings || offlineMode) return
    let active = true
    void local.bridge
      .getRevinoteConnectionStatus()
      .then((status) => {
        if (!active) return
        setRevinoteStatus(status)
        setRevinoteStatusError(false)
      })
      .catch(() => {
        if (active) setRevinoteStatusError(true)
      })
    const unsubscribe = local.bridge.onRevinoteConnectionStatus((status) => {
      if (!active) return
      setRevinoteStatus(status)
      setRevinoteStatusError(false)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [local.bridge, offlineMode, open, settings])

  async function continueAudioCaptureSetup() {
    if (!local.bridge || !settings || !state) return
    setIsUpdatingAudioCapture(true)
    try {
      if (state.restartRequired) {
        await local.bridge.restartApp()
        return
      }
      if (state.microphonePermission === 'not-determined') {
        await local.bridge.requestMicrophonePermission()
      } else if (state.microphonePermission !== 'granted') {
        await local.bridge.openMicrophoneSettings()
      } else if (state.systemAudioCheckStatus !== 'ready') {
        await local.bridge.verifySystemAudio()
      } else if (!state.modelDownloaded) {
        if (settings.offlineMode) await local.updateSettings({ offlineMode: false })
        local.acceptState(await local.bridge.prepareModel())
      }
      await local.refresh()
    } finally {
      setIsUpdatingAudioCapture(false)
    }
  }

  async function changeAudioCaptureSetting(audioCaptureEnabled: boolean) {
    if (!local.bridge || !settings || !state) return
    setIsUpdatingAudioCapture(true)
    try {
      await local.updateSettings({ audioCaptureEnabled, audioCaptureOnboardingCompleted: true })
      if (audioCaptureEnabled) {
        if (!state.modelDownloaded && !settings.offlineMode) {
          const nextState = await local.bridge.prepareModel()
          local.acceptState(nextState)
          if (!nextState.modelDownloaded) return
        }
        if (state.microphonePermission === 'not-determined') {
          await local.bridge.requestMicrophonePermission()
        } else if (
          state.microphonePermission === 'granted' &&
          !state.restartRequired &&
          state.systemAudioCheckStatus !== 'ready'
        ) {
          await local.bridge.verifySystemAudio()
        }
      }
      await local.refresh()
    } finally {
      setIsUpdatingAudioCapture(false)
    }
  }

  async function changeAutomaticRevinoteProcessing(automaticRevinoteProcessing: boolean) {
    setIsUpdatingAutomaticRevinoteProcessing(true)
    try {
      await local.updateSettings({ automaticRevinoteProcessing })
    } finally {
      setIsUpdatingAutomaticRevinoteProcessing(false)
    }
  }

  async function connectRevinote() {
    if (!local.bridge) return
    setRevinoteBusy(true)
    setRevinoteStatusError(false)
    try {
      setRevinoteStatus(await local.bridge.connectRevinote())
    } catch {
      setRevinoteStatusError(true)
    } finally {
      setRevinoteBusy(false)
    }
  }

  async function syncRevinote() {
    if (!local.bridge) return
    setRevinoteBusy(true)
    setRevinoteStatusError(false)
    try {
      const result = await local.bridge.syncRevinote()
      setRevinoteStatus(result.status)
    } catch {
      setRevinoteStatusError(true)
    } finally {
      setRevinoteBusy(false)
    }
  }

  async function disconnectRevinote() {
    if (!local.bridge) return
    setRevinoteBusy(true)
    setRevinoteStatusError(false)
    try {
      setRevinoteStatus(await local.bridge.disconnectRevinote())
    } catch {
      setRevinoteStatusError(true)
    } finally {
      setRevinoteBusy(false)
    }
  }

  async function retryRevinoteStatus() {
    if (!local.bridge) return
    setRevinoteBusy(true)
    setRevinoteStatusError(false)
    try {
      setRevinoteStatus(await local.bridge.getRevinoteConnectionStatus())
    } catch {
      setRevinoteStatusError(true)
    } finally {
      setRevinoteBusy(false)
    }
  }

  const audioModelPresentation = state && settings ? modelSetupPresentation(state, settings.offlineMode, locale) : null
  const audioCaptureNeedsAction = Boolean(
    settings?.audioCaptureEnabled &&
      state &&
      (state.restartRequired ||
        state.microphonePermission !== 'granted' ||
        state.systemAudioCheckStatus !== 'ready' ||
        !state.modelDownloaded)
  )
  const audioCaptureActionLabel = !state
    ? ''
    : state.restartRequired
      ? t('Herstart app')
      : state.microphonePermission === 'not-determined'
        ? t('Sta microfoon toe')
        : state.microphonePermission !== 'granted'
          ? t('Open instellingen')
          : state.systemAudioCheckStatus === 'checking'
            ? t('Controleren…')
            : state.systemAudioCheckStatus === 'failed'
              ? t('Controleer opnieuw')
              : state.systemAudioCheckStatus !== 'ready'
                ? t('Controleer toegang')
                : (audioModelPresentation?.actionLabel ?? '')
  const audioCaptureDescription = !settings?.audioCaptureEnabled
    ? t('Herken gesprekken op de achtergrond. Je kunt ook zelf een gesprek starten.')
    : state?.restartRequired
      ? t('Herstart Remember één keer om de audiomachtigingen te activeren.')
      : state?.microphonePermission !== 'granted'
        ? t('Microfoontoegang is nog niet verleend.')
        : state.systemAudioCheckStatus === 'failed'
          ? t('Systeemaudio kon niet starten. Probeer opnieuw; controleer de macOS-toegang als dit blijft gebeuren.')
          : state.systemAudioCheckStatus !== 'ready'
            ? t('Toegang tot systeem- en appaudio moet nog worden gecontroleerd.')
            : state.modelDownloaded
              ? t('Herken gesprekken op de achtergrond. Je kunt ook zelf een gesprek starten.')
              : (audioModelPresentation?.detail ?? '')

  const revinoteDescription = (() => {
    if (offlineMode) return t('Niet beschikbaar in Offline mode. Opnames blijven lokaal.')
    if (revinoteStatusError) {
      return (
        <span className="text-danger-700" role="alert">
          {t('De Revinote-status kon niet worden gecontroleerd.')}
        </span>
      )
    }
    if (!revinoteStatus) return t('Revinote-verbinding controleren…')
    if (revinoteStatus.state === 'disconnected') {
      return t('Synchroniseer mobiele meetingopnames automatisch met Remember.')
    }
    if (revinoteStatus.state === 'connecting') return t('Wachten op toestemming in Revinote…')
    if (revinoteStatus.state === 'error') {
      const message =
        revinoteStatus.error === 'revinote-plan-required'
          ? t('Voor deze koppeling heb je Revinote Personal of Business nodig.')
          : revinoteStatus.error?.startsWith('revinote-oauth-')
            ? t('Koppelen met Revinote is niet gelukt. Probeer het opnieuw.')
            : t('Synchroniseren is niet gelukt. Koppel Revinote opnieuw.')
      return (
        <span className="text-danger-700" role="alert">
          {message}
        </span>
      )
    }
    const count = revinoteStatus.importedCount
    if (!revinoteStatus.canPostProcess) {
      return t('{count} gesprekken gekoppeld. Koppel opnieuw om gesprekken met Revinote na te bewerken.', { count })
    }
    if (!revinoteStatus.lastSyncedAt) {
      return t('{count} gesprekken gekoppeld. De eerste synchronisatie start zo.', { count })
    }
    return t('{count} gesprekken · Laatst gesynchroniseerd {date}', {
      count,
      date: new Intl.DateTimeFormat(dateLocale, { dateStyle: 'medium', timeStyle: 'short' }).format(
        revinoteStatus.lastSyncedAt
      ),
    })
  })()

  return (
    <>
      <IconButton
        size="compact"
        aria-label={t('Gespreksvoorkeuren')}
        title={t('Gespreksvoorkeuren')}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <IconSettingsSliderHor className="size-4" aria-hidden="true" />
      </IconButton>
      <Dialog
        open={open}
        onClose={revinoteBusy || isUpdatingAudioCapture ? () => undefined : setOpen}
        className="app-no-drag relative z-50"
      >
        <DialogBackdrop
          transition
          className="fixed inset-0 bg-modal-backdrop backdrop-blur-[1px] transition-opacity data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
        />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <DialogPanel
            transition
            className="flex max-h-[calc(100dvh-2rem)] w-full max-w-xl flex-col overflow-hidden rounded-xl bg-white shadow-raised origin-center transition-[opacity,scale] data-[closed]:scale-[0.98] data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
          >
            <header className="flex min-h-14 shrink-0 items-center gap-4 border-black/[0.07] border-b px-5 py-3.5">
              <DialogTitle className="min-w-0 flex-1 font-semibold text-slate-950 text-md">
                {t('Gespreksvoorkeuren')}
              </DialogTitle>
              <IconButton
                size="compact"
                aria-label={t('Sluiten')}
                disabled={revinoteBusy || isUpdatingAudioCapture}
                onClick={() => setOpen(false)}
              >
                <IconCrossSmall className="size-4" aria-hidden="true" />
              </IconButton>
            </header>
            {settings && state ? (
              <div className="min-h-0 overflow-y-auto divide-y divide-slate-100">
                <PreferenceRow title={t('Gesprekken automatisch vastleggen')} description={audioCaptureDescription}>
                  <div className="flex items-center gap-2">
                    {audioCaptureNeedsAction ? (
                      <Button
                        size="small"
                        variant="outline"
                        color="secondary"
                        disabled={isUpdatingAudioCapture || state.systemAudioCheckStatus === 'checking'}
                        onClick={() => void continueAudioCaptureSetup()}
                      >
                        {audioCaptureActionLabel}
                      </Button>
                    ) : null}
                    <Switch
                      size="small"
                      aria-label={t('Gesprekken automatisch vastleggen')}
                      checked={settings.audioCaptureEnabled}
                      disabled={isUpdatingAudioCapture || state.manualMeeting?.status === 'recording'}
                      onChange={(enabled) => void changeAudioCaptureSetting(enabled)}
                    />
                  </div>
                </PreferenceRow>
                <PreferenceRow title="Revinote" description={revinoteDescription}>
                  {revinoteStatusError ? (
                    <Button
                      size="small"
                      variant="outline"
                      color="secondary"
                      disabled={revinoteBusy || offlineMode}
                      className={controlButtonClassName}
                      onClick={() => void retryRevinoteStatus()}
                    >
                      {revinoteBusy ? t('Controleren…') : t('Probeer opnieuw')}
                    </Button>
                  ) : revinoteStatus?.state === 'connected' ? (
                    <div className="flex items-center gap-1">
                      <Button
                        size="small"
                        variant="text"
                        color="secondary"
                        disabled={revinoteBusy}
                        onClick={() => void disconnectRevinote()}
                      >
                        {t('Ontkoppelen')}
                      </Button>
                      <Button
                        size="small"
                        variant="outline"
                        color="secondary"
                        disabled={revinoteBusy || offlineMode}
                        className={controlButtonClassName}
                        onClick={() => void (revinoteStatus.canPostProcess ? syncRevinote() : connectRevinote())}
                      >
                        {revinoteBusy
                          ? revinoteStatus.canPostProcess
                            ? t('Synchroniseren…')
                            : t('Koppelen…')
                          : revinoteStatus.canPostProcess
                            ? t('Synchroniseer nu')
                            : t('Koppel opnieuw')}
                      </Button>
                    </div>
                  ) : (
                    <Button
                      size="small"
                      variant="outline"
                      color="secondary"
                      disabled={revinoteBusy || !revinoteStatus || revinoteStatus.state === 'connecting' || offlineMode}
                      className={controlButtonClassName}
                      onClick={() => void connectRevinote()}
                    >
                      {!revinoteStatus
                        ? t('Controleren…')
                        : revinoteBusy || revinoteStatus.state === 'connecting'
                          ? t('Koppelen…')
                          : t('Koppel Revinote')}
                    </Button>
                  )}
                </PreferenceRow>
                <Field className="grid min-h-[72px] gap-3 px-5 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                  <div className="min-w-0">
                    <Label className="block cursor-pointer text-balance font-medium text-slate-900 text-ui">
                      {t('Automatisch verwerken met Revinote')}
                    </Label>
                    <Description className="mt-0.5 max-w-prose text-pretty text-slate-500 text-xs leading-[1.5]">
                      {offlineMode
                        ? t(
                            'Opnames die je in Offline mode afrondt, blijven lokaal en worden later niet automatisch naar Revinote gestuurd.'
                          )
                        : revinoteStatus?.state === 'connected' && revinoteStatus.canPostProcess
                          ? t(
                              'Slaat de verwerking in Remember over en stuurt afgeronde gesprekken automatisch naar Revinote.'
                            )
                          : settings.automaticRevinoteProcessing
                            ? t('Automatische verwerking wacht totdat Revinote opnieuw is gekoppeld.')
                            : t('Koppel Revinote met verwerkingsrechten om dit in te schakelen.')}
                    </Description>
                  </div>
                  <Switch
                    checked={settings.automaticRevinoteProcessing}
                    disabled={
                      isUpdatingAutomaticRevinoteProcessing ||
                      revinoteBusy ||
                      (!settings.automaticRevinoteProcessing &&
                        (offlineMode || revinoteStatus?.state !== 'connected' || !revinoteStatus.canPostProcess))
                    }
                    onChange={(checked) => void changeAutomaticRevinoteProcessing(checked)}
                  />
                </Field>
              </div>
            ) : (
              <div className="flex min-h-44 items-center justify-center" role="status">
                <Spinner size="lg" label={t('Gespreksvoorkeuren')} />
              </div>
            )}
          </DialogPanel>
        </div>
      </Dialog>
    </>
  )
}
