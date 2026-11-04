'use client'

import { Dialog, DialogBackdrop, DialogPanel, DialogTitle, Menu, MenuButton, MenuItem } from '@headlessui/react'
import { useLocalBridge } from '@internal/context/LocalBridgeProvider'
import { useI18n } from '@internal/locales'
import { Button } from '@internal/ui/Button'
import { DropdownMenuItems, dropdownDangerItemStyle, dropdownItemStyle } from '@internal/ui/Dropdown'
import { IconButton } from '@internal/ui/IconButton'
import { Spinner } from '@internal/ui/Spinner'
import type { CalendarBlock, Day } from '@remember/shared'
import {
  Book as IconBook,
  X as IconCrossSmall,
  Ellipsis as IconDotGrid1x3HorizontalTight,
  EyeOff as IconEyeSlash,
  Pencil as IconPencil,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { wikiPageHref } from './wikiRoutes'

function ModalFrame({ children }: { children: React.ReactNode }) {
  return (
    <>
      <DialogBackdrop
        transition
        className="fixed inset-0 bg-modal-backdrop backdrop-blur-[1px] transition-opacity data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
      />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel
          transition
          className="flex max-h-[calc(100dvh-2rem)] min-w-0 w-full max-w-lg origin-center flex-col overflow-hidden rounded-xl bg-white shadow-raised transition-[opacity,scale] data-[closed]:scale-[0.98] data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
        >
          {children}
        </DialogPanel>
      </div>
    </>
  )
}

function EditDialog({
  day,
  block,
  open,
  onClose,
}: {
  day: Day
  block: CalendarBlock
  open: boolean
  onClose: () => void
}) {
  const { t } = useI18n()
  const [title, setTitle] = useState(block.title)
  const [description, setDescription] = useState(block.description)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)
  const titleInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setTitle(block.title)
    setDescription(block.description)
    setError(false)
    if ('ontouchstart' in window) return
    const frame = window.requestAnimationFrame(() => titleInputRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [block.description, block.title, open])

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!block.id || !title.trim() || saving) return
    setSaving(true)
    setError(false)
    try {
      await window.remember.updateTimelineItem(day.id, block.id, { title, description })
      onClose()
    } catch {
      setError(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onClose={saving ? () => undefined : onClose} className="app-no-drag relative z-50">
      <ModalFrame>
        <form onSubmit={save}>
          <header className="flex items-center gap-3 border-black/[0.07] border-b px-5 py-4">
            <DialogTitle className="min-w-0 flex-1 font-semibold text-slate-950 text-md">
              {t('Tijdlijnactiviteit bewerken')}
            </DialogTitle>
            <IconButton
              type="button"
              onClick={onClose}
              disabled={saving}
              aria-label={t('Sluit bewerken')}
              size="compact"
            >
              <IconCrossSmall className="size-4" aria-hidden="true" />
            </IconButton>
          </header>
          <div className="grid gap-4 px-5 py-4">
            <label className="grid gap-1.5 font-medium text-slate-700 text-xs">
              {t('Titel')}
              <input
                ref={titleInputRef}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={120}
                className="h-9 rounded-lg border border-black/[0.12] bg-white px-3 font-normal text-slate-900 text-ui outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-200"
              />
            </label>
            <label className="grid gap-1.5 font-medium text-slate-700 text-xs">
              {t('Beschrijving')}
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={4}
                maxLength={600}
                className="resize-none rounded-lg border border-black/[0.12] bg-white px-3 py-2 font-normal text-slate-900 text-ui leading-5 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-200"
              />
            </label>
            {error ? (
              <p className="text-danger-700 text-sm" role="alert">
                {t('Deze activiteit kon niet worden opgeslagen.')}
              </p>
            ) : null}
          </div>
          <footer className="flex justify-end gap-2 border-black/[0.07] border-t px-5 py-3.5">
            <Button type="button" variant="text" color="secondary" onClick={onClose} disabled={saving}>
              {t('Annuleer')}
            </Button>
            <Button type="submit" disabled={saving || !title.trim()}>
              {saving ? t('Opslaan…') : t('Opslaan')}
            </Button>
          </footer>
        </form>
      </ModalFrame>
    </Dialog>
  )
}

export function TimelineItemActions({ day, block }: { day: Day; block: CalendarBlock }) {
  const local = useLocalBridge()
  const { t } = useI18n()
  const router = useRouter()
  const [editOpen, setEditOpen] = useState(false)
  const [busy, setBusy] = useState<'wiki' | 'hide' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const offlineMode = local.settings?.offlineMode === true
  const busyLabel = busy === 'wiki' ? t('Wiki bijwerken…') : busy === 'hide' ? t('Verbergen…') : null

  async function addToWiki() {
    if (!block.id || busy || offlineMode) return
    setBusy('wiki')
    setError(null)
    try {
      const result = await window.remember.addTimelineItemToWiki(day.id, block.id)
      await local.selectWikiSpace('personal')
      router.push(wikiPageHref('personal', result.slug))
    } catch {
      setError(t('Deze activiteit kon niet aan de Wiki worden toegevoegd.'))
    } finally {
      setBusy(null)
    }
  }

  async function hide() {
    if (!block.id || busy) return
    setBusy('hide')
    setError(null)
    try {
      await window.remember.hideTimelineItem(day.id, block.id)
    } catch {
      setError(t('Deze activiteit kon niet worden verborgen.'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <div className="relative flex shrink-0 flex-col items-end">
        <Menu>
          <MenuButton
            as={IconButton}
            size="compact"
            aria-label={busyLabel ?? t('Meer opties voor {title}', { title: block.title })}
            title={busyLabel ?? undefined}
            disabled={Boolean(busy)}
            className={`cursor-pointer transition-opacity duration-150 data-open:opacity-100 motion-reduce:transition-none ${
              busy
                ? 'opacity-100'
                : 'opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100'
            }`}
          >
            {busy ? <Spinner size="xs" /> : <IconDotGrid1x3HorizontalTight className="size-3" aria-hidden="true" />}
          </MenuButton>
          <DropdownMenuItems anchor="bottom end" className="mt-1 w-56 origin-top-right">
            {offlineMode ? (
              <p className="px-2.5 py-1.5 text-slate-500 text-xs">{t('AI is gepauzeerd in Offline mode.')}</p>
            ) : null}
            <MenuItem>
              <button
                type="button"
                onClick={() => void addToWiki()}
                disabled={offlineMode}
                className={`${dropdownItemStyle} disabled:cursor-not-allowed disabled:text-slate-400 disabled:hover:bg-transparent`}
              >
                <IconBook className="size-4" aria-hidden="true" />
                {t('Voeg toe aan Wiki')}
              </button>
            </MenuItem>
            <div className="my-1 border-black/[0.07] border-t" />
            <MenuItem>
              <button type="button" onClick={() => setEditOpen(true)} className={dropdownItemStyle}>
                <IconPencil className="size-4" aria-hidden="true" />
                {t('Bewerken')}
              </button>
            </MenuItem>
            <MenuItem>
              <button type="button" onClick={() => void hide()} className={dropdownDangerItemStyle}>
                <IconEyeSlash className="size-4" aria-hidden="true" />
                {t('Verberg uit tijdlijn')}
              </button>
            </MenuItem>
          </DropdownMenuItems>
        </Menu>
        {error
          ? createPortal(
              <div
                className="app-no-drag fixed right-4 bottom-4 z-50 flex w-64 max-w-[calc(100vw-2rem)] items-start gap-2 rounded-lg border border-danger-200 bg-white p-3 text-left text-danger-700 text-xs leading-4 shadow-raised"
                role="alert"
              >
                <p className="min-w-0 flex-1">{error}</p>
                <IconButton
                  size="compact"
                  onClick={() => setError(null)}
                  aria-label={t('Sluit foutmelding')}
                  className="-mt-1 -mr-1 shrink-0"
                >
                  <IconCrossSmall className="size-3.5" aria-hidden="true" />
                </IconButton>
              </div>,
              document.body
            )
          : null}
      </div>
      <EditDialog day={day} block={block} open={editOpen} onClose={() => setEditOpen(false)} />
    </>
  )
}
