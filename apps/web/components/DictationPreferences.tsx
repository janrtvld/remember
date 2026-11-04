'use client'

import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react'
import { useI18n } from '@internal/locales'
import { IconButton } from '@internal/ui/IconButton'
import { X as IconCrossSmall, SlidersHorizontal as IconSettingsSliderHor } from 'lucide-react'
import { DictationSettings } from './DictationSettings'

export function DictationPreferences({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n()
  return (
    <>
      <IconButton
        size="compact"
        aria-label={t('Dictatievoorkeuren')}
        title={t('Dictatievoorkeuren')}
        aria-haspopup="dialog"
        onClick={() => onOpenChange(true)}
      >
        <IconSettingsSliderHor className="size-4" aria-hidden="true" />
      </IconButton>
      <Dialog open={open} onClose={onOpenChange} className="app-no-drag relative z-50">
        <DialogBackdrop
          transition
          className="fixed inset-0 bg-modal-backdrop backdrop-blur-[1px] transition-opacity data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
        />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <DialogPanel
            transition
            className="flex max-h-[calc(100dvh-2rem)] w-full max-w-xl origin-center flex-col overflow-hidden rounded-xl bg-white shadow-raised transition-[opacity,scale] data-[closed]:scale-[0.98] data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
          >
            <header className="flex min-h-14 shrink-0 items-center gap-4 border-black/[0.07] border-b px-5 py-3.5">
              <DialogTitle className="min-w-0 flex-1 font-semibold text-slate-950 text-md">
                {t('Dictatievoorkeuren')}
              </DialogTitle>
              <IconButton size="compact" aria-label={t('Sluiten')} onClick={() => onOpenChange(false)}>
                <IconCrossSmall className="size-4" aria-hidden="true" />
              </IconButton>
            </header>
            <div className="min-h-0 overflow-y-auto">
              <DictationSettings />
            </div>
          </DialogPanel>
        </div>
      </Dialog>
    </>
  )
}
