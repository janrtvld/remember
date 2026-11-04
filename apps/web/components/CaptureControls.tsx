'use client'

import {
  Dialog,
  DialogBackdrop,
  DialogDescription,
  DialogPanel,
  DialogTitle,
  Menu,
  MenuButton,
  MenuItem,
} from '@headlessui/react'
import { useLocalBridge } from '@internal/context/LocalBridgeProvider'
import { useI18n } from '@internal/locales'
import { Button } from '@internal/ui/Button'
import { DropdownMenuItems, dropdownItemStyle } from '@internal/ui/Dropdown'
import { IconButton } from '@internal/ui/IconButton'
import { type CapturePauseInput, isCaptureAllowed } from '@remember/shared'
import {
  CalendarDays as IconCalendarDays,
  ChevronDown as IconChevronDownSmall,
  X as IconCrossSmall,
  Pause as IconPause,
  Play as IconPlay,
  Trash2 as IconTrashCanSimple,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { ActivitySchedule } from './ActivitySchedule'
import { PauseCaptureDialog } from './PauseCaptureDialog'

function startOfTodayTimestamp() {
  const now = new Date()
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  return start.getTime()
}

const AUDIO_SOURCE: ['audio'] = ['audio']

export function CaptureControls() {
  const local = useLocalBridge()
  const { t } = useI18n()
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [audioPause, setAudioPause] = useState(false)
  const [pauseOpen, setPauseOpen] = useState(false)
  const [scheduleConfirmationOpen, setScheduleConfirmationOpen] = useState(false)
  const [resumeError, setResumeError] = useState<string | null>(null)
  const [clearSelection, setClearSelection] = useState<{ cutoff: number; label: string } | null>(null)
  const [clearError, setClearError] = useState<string | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('pause') !== '1') return

    setAudioPause(params.get('source') === 'audio')
    params.delete('source')
    setPauseOpen(true)
    params.delete('pause')
    const search = params.toString()
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`
    )
  }, [])

  if (!local.ready || !local.state || !local.settings) return null

  const settings = local.settings
  const schedulePaused = local.state.status === 'paused' && local.state.pauseReason === 'schedule'
  const manuallyPaused = settings.capturePaused

  const pause = async (input: CapturePauseInput) => {
    setPending(true)
    try {
      await window.remember.pauseCapture(input)
      await local.refresh()
      setPauseOpen(false)
    } finally {
      setPending(false)
    }
  }

  const resume = async (disableSchedule = false) => {
    setPending(true)
    setResumeError(null)
    try {
      if (disableSchedule) {
        await window.remember.updateSettings({
          captureSchedule: { ...settings.captureSchedule, enabled: false },
        })
      }
      await window.remember.resumeCapture()
      await local.refresh()
      setScheduleConfirmationOpen(false)
    } catch {
      setResumeError(t('De opname kon niet worden hervat. Probeer het opnieuw.'))
    } finally {
      setPending(false)
    }
  }

  const requestResume = () => {
    const schedule = settings.captureSchedule
    if (schedule.enabled && !isCaptureAllowed(schedule)) {
      setResumeError(null)
      setScheduleConfirmationOpen(true)
      return
    }
    void resume()
  }

  const clearRecent = async () => {
    if (!clearSelection || pending) return
    setPending(true)
    setClearError(null)
    try {
      await window.remember.clearRecentCapture(clearSelection.cutoff)
      await local.refresh()
      setClearSelection(null)
    } catch {
      setClearError(t('De recente gegevens konden niet volledig worden gewist.'))
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <Button size="small" variant="outline" color="secondary" onClick={() => setScheduleOpen(true)}>
          <IconCalendarDays className="size-4" aria-hidden="true" />
          {t('Schema')}
        </Button>
        {schedulePaused ? (
          <Button variant="outline" color="secondary" disabled={pending} onClick={requestResume}>
            <IconPlay className="size-4" aria-hidden="true" />
            {pending ? t('Hervatten…') : t('Hervat')}
          </Button>
        ) : (
          <Button variant="outline" color="secondary" disabled={pending} onClick={() => setPauseOpen(true)}>
            <IconPause className="size-4" aria-hidden="true" />
            {manuallyPaused ? t('Pauze aanpassen') : t('Pauzeer')}
          </Button>
        )}
        <Menu>
          <MenuButton
            as={Button}
            variant="outline"
            color="secondary"
            disabled={pending}
            className="cursor-pointer"
            aria-label={t('Wis recente gegevens')}
          >
            <IconTrashCanSimple className="size-4" aria-hidden="true" />
            <IconChevronDownSmall className="size-3 text-slate-400" aria-hidden="true" />
          </MenuButton>
          <DropdownMenuItems anchor="bottom end" className="mt-1 w-48 origin-top-right">
            <MenuItem>
              <button
                type="button"
                onClick={() => {
                  setClearError(null)
                  setClearSelection({ cutoff: Date.now() - 10 * 60_000, label: t('Laatste 10 minuten') })
                }}
                className={dropdownItemStyle}
              >
                {t('Laatste 10 minuten')}
              </button>
            </MenuItem>
            <MenuItem>
              <button
                type="button"
                onClick={() => {
                  setClearError(null)
                  setClearSelection({ cutoff: Date.now() - 60 * 60_000, label: t('Laatste uur') })
                }}
                className={dropdownItemStyle}
              >
                {t('Laatste uur')}
              </button>
            </MenuItem>
            <MenuItem>
              <button
                type="button"
                onClick={() => {
                  setClearError(null)
                  setClearSelection({ cutoff: startOfTodayTimestamp(), label: t('Vandaag') })
                }}
                className={dropdownItemStyle}
              >
                {t('Vandaag')}
              </button>
            </MenuItem>
          </DropdownMenuItems>
        </Menu>
      </div>

      <PauseCaptureDialog
        open={pauseOpen}
        defaultSources={audioPause ? AUDIO_SOURCE : undefined}
        pausedSources={manuallyPaused ? settings.capturePauseSources : []}
        pausedUntil={manuallyPaused ? settings.capturePausedUntil : null}
        pending={pending}
        onClose={() => setPauseOpen(false)}
        onApply={pause}
      />

      <Dialog
        open={scheduleConfirmationOpen}
        onClose={() => {
          if (!pending) setScheduleConfirmationOpen(false)
        }}
        className="relative z-50"
      >
        <DialogBackdrop
          transition
          className="fixed inset-0 bg-modal-backdrop backdrop-blur-[1px] transition-opacity data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
        />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <DialogPanel
            transition
            className="w-full max-w-sm origin-center rounded-xl bg-white p-5 shadow-raised transition-[opacity,scale] data-[closed]:scale-[0.98] data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
          >
            <DialogTitle className="font-semibold text-slate-950 text-md">{t('Buiten je opnameschema')}</DialogTitle>
            <DialogDescription className="mt-1.5 text-pretty text-slate-500 text-sm leading-5">
              {t(
                'Je schema houdt de opname nu gepauzeerd. Om direct te hervatten, schakelt Remember het opnameschema uit.'
              )}
            </DialogDescription>
            {resumeError ? (
              <p role="alert" className="mt-3 text-danger-700 text-sm">
                {resumeError}
              </p>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <Button
                autoFocus
                variant="text"
                color="secondary"
                disabled={pending}
                onClick={() => setScheduleConfirmationOpen(false)}
              >
                {t('Annuleer')}
              </Button>
              <Button disabled={pending} onClick={() => void resume(true)}>
                {pending ? t('Hervatten…') : t('Schema uitzetten en hervatten')}
              </Button>
            </div>
          </DialogPanel>
        </div>
      </Dialog>

      <Dialog
        open={Boolean(clearSelection)}
        onClose={() => {
          if (!pending) setClearSelection(null)
        }}
        className="app-no-drag relative z-50"
      >
        <DialogBackdrop
          transition
          className="fixed inset-0 bg-modal-backdrop backdrop-blur-[1px] transition-opacity data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
        />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <DialogPanel
            transition
            className="w-full max-w-sm origin-center overflow-hidden rounded-xl bg-white shadow-raised transition-[opacity,scale] data-[closed]:scale-[0.98] data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
          >
            <header className="border-slate-100 border-b px-4 py-3.5">
              <DialogTitle className="font-semibold text-slate-950 text-md">{t('Recente gegevens wissen')}</DialogTitle>
              <DialogDescription className="mt-0.5 text-slate-500 text-xs">{clearSelection?.label}</DialogDescription>
            </header>
            <div className="px-4 py-4">
              <p className="text-pretty text-slate-600 text-sm leading-5">
                {t(
                  'Lokaal bronmateriaal in dit tijdvak wordt definitief gewist. Afgeleide dag- en Wiki-inhoud van geraakte dagen wordt teruggezet. De opname blijft daarna gepauzeerd.'
                )}
              </p>
              {clearError ? (
                <p className="mt-3 text-danger-700 text-sm" role="alert">
                  {clearError}
                </p>
              ) : null}
            </div>
            <footer className="flex justify-end gap-2 border-slate-100 border-t px-4 py-3">
              <Button variant="text" color="secondary" onClick={() => setClearSelection(null)} disabled={pending}>
                {t('Annuleren')}
              </Button>
              <Button color="danger" onClick={() => void clearRecent()} disabled={pending}>
                {pending ? t('Wissen…') : t('Wissen en pauzeren')}
              </Button>
            </footer>
          </DialogPanel>
        </div>
      </Dialog>

      <Dialog open={scheduleOpen} onClose={setScheduleOpen} className="relative z-50">
        <DialogBackdrop
          transition
          className="fixed inset-0 bg-modal-backdrop backdrop-blur-[1px] transition-opacity data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
        />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <DialogPanel
            transition
            className="max-h-[calc(100dvh-2rem)] w-full max-w-md origin-center overflow-y-auto rounded-xl bg-white shadow-raised transition-[opacity,scale] data-[closed]:scale-[0.98] data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
          >
            <header className="flex items-start justify-between gap-3 border-slate-100 border-b px-4 py-3">
              <div className="min-w-0">
                <DialogTitle className="font-semibold text-slate-950 text-md">{t('Opnameschema')}</DialogTitle>
                <DialogDescription className="mt-0.5 max-w-sm text-pretty text-slate-500 text-xs leading-[18px]">
                  {t('Bepaal op welke dagen en tijden Remember automatisch activiteit vastlegt.')}
                </DialogDescription>
              </div>
              <IconButton aria-label={t('Sluit opnameschema')} size="compact" onClick={() => setScheduleOpen(false)}>
                <IconCrossSmall className="size-4" aria-hidden="true" />
              </IconButton>
            </header>
            <div id="capture-schedule-slot" data-integration="capture-schedule">
              <ActivitySchedule
                schedule={settings.captureSchedule}
                onChange={async (captureSchedule) => {
                  await window.remember.updateSettings({ captureSchedule })
                  await local.refresh()
                }}
              />
            </div>
          </DialogPanel>
        </div>
      </Dialog>
    </>
  )
}
