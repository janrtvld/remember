'use client'

import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react'
import { useI18n } from '@internal/locales'
import { Button } from '@internal/ui/Button'
import { IconButton } from '@internal/ui/IconButton'
import type { AgentProvider } from '@remember/shared'
import { CalendarDays, Layers3, LockKeyhole, Monitor, X } from 'lucide-react'

export function DayIntroduction({
  open,
  provider: selectedProvider,
  onClose,
}: {
  open: boolean
  provider: AgentProvider
  onClose: () => void
}) {
  const { locale } = useI18n()
  const provider = selectedProvider === 'claude' ? 'Claude' : 'ChatGPT'
  const nl = locale === 'nl'
  const steps = [
    {
      icon: Monitor,
      title: nl ? 'Remember legt je werk vast' : 'Remember captures your work',
      description: nl
        ? 'Remember legt schermcontext vast uit de apps en websites die je toestaat. Gesprekken die je opneemt, tellen ook mee.'
        : 'Remember captures screen context from the apps and websites you allow, plus conversations you choose to record.',
    },
    {
      icon: Layers3,
      title: nl ? `${provider} brengt er structuur in` : `${provider} organizes it`,
      description: nl
        ? 'Je geselecteerde AI herkent waar je aan werkt, wat af is en welke taken of losse eindjes nog aandacht vragen.'
        : 'Your AI identifies what you’re working on, what’s done, and which tasks and loose ends still need attention.',
    },
    {
      icon: CalendarDays,
      title: nl ? 'Vind het terug in Mijn dag en Taken' : 'Find it in My Day and Tasks',
      description: nl
        ? 'Bekijk je dagsamenvatting, waar je aandacht naartoe ging en wat je hebt gedaan. Open taken vind je in Taken.'
        : 'See a summary of your day, where your attention went, and what you accomplished. Open tasks stay in Tasks.',
    },
  ]

  return (
    <Dialog open={open} onClose={onClose} className="app-no-drag relative z-50">
      <DialogBackdrop className="fixed inset-0 bg-modal-backdrop backdrop-blur-[1px]" />
      <div className="fixed inset-0 overflow-y-auto p-4 sm:p-8">
        <div className="flex min-h-full items-center justify-center">
          <DialogPanel className="relative w-full max-w-[540px] rounded-xl bg-white text-slate-800 shadow-hard">
            <IconButton aria-label={nl ? 'Sluiten' : 'Close'} onClick={onClose} className="absolute top-4 right-4">
              <X className="size-4" />
            </IconButton>
            <div className="px-6 pt-6 pb-5">
              <DialogTitle className="pr-6 font-semibold text-2xl tracking-tight">
                {nl ? 'Zo werkt Remember' : 'How Remember works'}
              </DialogTitle>
              <ol className="mt-5 space-y-5">
                {steps.map(({ icon: Icon, title, description }) => (
                  <li key={title} className="flex gap-3">
                    <Icon className="mt-0.5 size-5 shrink-0 text-slate-400" strokeWidth={1.5} aria-hidden="true" />
                    <div>
                      <h2 className="font-semibold text-sm">{title}</h2>
                      <p className="mt-1 text-sm leading-[22px] text-slate-600">{description}</p>
                    </div>
                  </li>
                ))}
              </ol>
              <div className="mt-5 flex gap-2.5 border-black/[0.06] border-t pt-4 text-slate-500 text-xs leading-5">
                <LockKeyhole className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <p>
                  {nl
                    ? `Opgeslagen op je Mac. Relevante context gaat voor AI-verwerking naar ${provider}. Je kunt vastleggen altijd pauzeren en apps of websites uitsluiten.`
                    : `Stored on your Mac. Relevant context is sent to ${provider} for AI processing. You can pause capture or exclude apps and websites at any time.`}
                </p>
              </div>
            </div>
            <div className="flex justify-end px-6 pb-5">
              <Button onClick={onClose}>{nl ? 'Bekijk mijn dag' : 'See my day'}</Button>
            </div>
          </DialogPanel>
        </div>
      </div>
    </Dialog>
  )
}
