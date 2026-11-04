'use client'

import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react'
import { useI18n } from '@internal/locales'
import { Button } from '@internal/ui/Button'
import type { LocalSettings } from '@remember/shared'
import { useState } from 'react'
import { ExclusionsSettings } from './ExclusionsSettings'
import { SetupButton } from './SetupButton'

export function SetupPrivacy({
  settings,
  busy,
  onContinue,
}: {
  settings: LocalSettings
  busy: boolean
  onContinue: () => void
}) {
  const { t } = useI18n()
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const hasCustomSettings =
    settings.appCaptureMode === 'include' ||
    settings.websiteCaptureMode === 'include' ||
    settings.excludedAppBundleIds.length > 0 ||
    settings.excludedWebsites.length > 0 ||
    !settings.excludePasswordManagers ||
    !settings.excludePrivateBrowsing

  return (
    <div className="mt-6 grid gap-5">
      <div className="flex flex-wrap gap-2">
        <SetupButton size="small" pending={busy} onClick={onContinue}>
          {hasCustomSettings ? t('Gebruik deze instellingen') : t('Gebruik standaardinstellingen')}
        </SetupButton>
        <Button size="small" variant="text" color="secondary" disabled={busy} onClick={() => setEditing(true)}>
          {t('Aanpassen')}
        </Button>
      </div>
      <Dialog
        open={editing}
        onClose={() => {
          if (!saving) setEditing(false)
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
            className="flex max-h-[calc(100dvh-2rem)] w-full max-w-xl flex-col overflow-hidden rounded-xl bg-canvas shadow-raised origin-center transition-[opacity,scale] data-[closed]:scale-[0.98] data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
          >
            <DialogTitle className="shrink-0 border-slate-100 border-b px-4 py-3.5 font-semibold text-slate-950 text-md">
              {t('Privacy instellen')}
            </DialogTitle>
            <div className="min-h-0 overflow-y-auto p-4">
              <ExclusionsSettings onPendingChange={setSaving} />
            </div>
            <footer className="flex shrink-0 justify-end border-slate-100 border-t px-4 py-3">
              <Button size="small" disabled={saving} onClick={() => setEditing(false)}>
                {t('Gereed')}
              </Button>
            </footer>
          </DialogPanel>
        </div>
      </Dialog>
    </div>
  )
}
