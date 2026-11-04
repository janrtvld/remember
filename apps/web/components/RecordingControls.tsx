'use client'

import { Dialog, DialogBackdrop, DialogPanel, DialogTitle, Menu, MenuButton, MenuItem } from '@headlessui/react'
import { useI18n } from '@internal/locales'
import { Button } from '@internal/ui/Button'
import { DropdownMenuItems, dropdownItemStyle } from '@internal/ui/Dropdown'
import { IconButton } from '@internal/ui/IconButton'
import { Spinner } from '@internal/ui/Spinner'
import { ChevronDown as IconChevronDownSmall, Square as IconStop } from 'lucide-react'
import { useState } from 'react'
import { DashboardPageFooter } from './DashboardPageFooter'
import { RecordingWave } from './RecordingWave'

export function RecordingControls({
  duration,
  running,
  active,
  busy,
  error,
  onPause,
  onStop,
  onDiscard,
  onOpenConversation,
}: {
  duration: string
  running: boolean
  active: boolean
  busy: boolean
  error: string | null
  onPause: () => void | Promise<void>
  onStop: () => void | Promise<void>
  onDiscard: () => void | Promise<void>
  onOpenConversation?: () => void
}) {
  const { t } = useI18n()
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  return (
    <>
      <DashboardPageFooter>
        <div
          data-recording-controller
          className="pointer-events-auto flex flex-col items-center justify-center gap-2 px-4 pt-3 pb-5"
        >
          {error && !confirmDiscard ? (
            <p role="alert" className="rounded-lg bg-white px-3 py-2 text-danger-700 text-sm shadow-raised">
              {error}
            </p>
          ) : null}
          <aside
            aria-label={t('Lopende meetingopname')}
            className="app-no-drag relative z-10 flex h-12 min-w-[100px] shrink-0 items-center justify-center gap-1 rounded-full bg-white px-2 shadow-raised ring-1 ring-black/[0.07]"
          >
            <Menu>
              <MenuButton
                aria-label={t('Opnameopties')}
                title={duration}
                className="flex h-9 items-center gap-2 rounded-full px-2 text-slate-500 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-slate-400"
              >
                {busy ? (
                  <Spinner size="xs" />
                ) : (
                  <RecordingWave active={running} className={running ? 'bg-blue-700' : 'bg-slate-400'} />
                )}
                <IconChevronDownSmall className="size-3" aria-hidden />
              </MenuButton>
              <DropdownMenuItems anchor="top start" className="mb-3 min-w-52">
                <div className="px-3 py-2 text-slate-500 text-xs">
                  <time className="tabular-nums">{duration}</time>
                </div>
                {onOpenConversation ? (
                  <MenuItem>
                    <button type="button" className={dropdownItemStyle} onClick={onOpenConversation}>
                      {t('Open gesprek')}
                    </button>
                  </MenuItem>
                ) : null}
                {active ? (
                  <>
                    <MenuItem>
                      <button
                        type="button"
                        className={dropdownItemStyle}
                        disabled={busy}
                        onClick={() => void onPause()}
                      >
                        {running ? t('Opname pauzeren') : t('Opname hervatten')}
                      </button>
                    </MenuItem>
                    <MenuItem>
                      <button
                        type="button"
                        className={dropdownItemStyle}
                        disabled={busy}
                        onClick={() => setConfirmDiscard(true)}
                      >
                        {t('Gesprek weggooien…')}
                      </button>
                    </MenuItem>
                  </>
                ) : null}
              </DropdownMenuItems>
            </Menu>
            <IconButton
              size="compact"
              className="rounded-full"
              disabled={!active || busy}
              aria-label={t('Stop opname')}
              title={t('Stop opname')}
              onClick={() => void onStop()}
            >
              <IconStop className="size-4" />
            </IconButton>
          </aside>
        </div>
      </DashboardPageFooter>
      <Dialog
        open={confirmDiscard}
        onClose={() => {
          if (!busy) setConfirmDiscard(false)
        }}
        className="app-no-drag relative z-50"
      >
        <DialogBackdrop className="fixed inset-0 bg-black/20" />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <DialogPanel className="w-full max-w-sm rounded-xl bg-white p-5 shadow-raised">
            <DialogTitle className="font-semibold text-sm">{t('Gesprek weggooien?')}</DialogTitle>
            <p className="mt-2 text-slate-500 text-sm">{t('Je opname en notities worden verwijderd.')}</p>
            {error ? (
              <p role="alert" className="mt-2 text-danger-700 text-sm">
                {error}
              </p>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <Button
                size="small"
                variant="text"
                color="secondary"
                disabled={busy}
                data-autofocus
                onClick={() => setConfirmDiscard(false)}
              >
                {t('Annuleren')}
              </Button>
              <Button size="small" color="danger" disabled={busy} onClick={() => void onDiscard()}>
                {busy ? t('Weggooien…') : t('Weggooien')}
              </Button>
            </div>
          </DialogPanel>
        </div>
      </Dialog>
    </>
  )
}
