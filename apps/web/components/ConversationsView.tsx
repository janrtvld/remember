'use client'

import { Dialog, DialogBackdrop, DialogPanel, DialogTitle, Menu, MenuButton, MenuItem } from '@headlessui/react'
import { DashboardContentHeader } from '@internal/components/DashboardContentHeader'
import { conversationsConversationHref } from '@internal/components/dayNavigation'
import { useLocalBridge } from '@internal/context/LocalBridgeProvider'
import { useI18n } from '@internal/locales'
import { Button } from '@internal/ui/Button'
import { Container } from '@internal/ui/Container'
import { DropdownMenuItems, dropdownItemStyle } from '@internal/ui/Dropdown'
import { IconButton } from '@internal/ui/IconButton'
import { PendingIndicator } from '@internal/ui/PendingIndicator'
import { Spinner } from '@internal/ui/Spinner'
import { type ConversationSummary, conversationReference, type Day } from '@remember/shared'
import {
  Check as IconCheckmark1Small,
  X as IconCrossSmall,
  Ellipsis as IconDotGrid1x3HorizontalTight,
} from 'lucide-react'
import Link from 'next/link'
import { type FormEvent, useMemo, useState } from 'react'
import { ConversationPreferences } from './ConversationPreferences'
import { useConversationStartControls } from './ConversationStartControls'
import { ConversationTabs } from './ConversationTabs'
import { formatConversationDate, formatConversationTimeRange } from './conversationDate'
import {
  canMergeConversationHistory,
  conversationHistory,
  limitConversationHistory,
  mergeableConversationHistory,
} from './conversationHistory'
import { MarkdownPreview } from './MarkdownContent'
import { RevinoteSourceIcon } from './RevinoteSourceIcon'

const CONVERSATION_PAGE_SIZE = 50
const conversationCanvasClassName = 'flex grow flex-col gap-7 py-8 md:py-12'

type MergeSelection = { day: Day; conversation: ConversationSummary }

function selectionKey(dayId: string, conversation: ConversationSummary) {
  return `${dayId}\u0000${conversationReference(conversation)}`
}

function ConversationMergeDialog({
  groups,
  open,
  onClose,
}: {
  groups: ReturnType<typeof conversationHistory>
  open: boolean
  onClose: () => void
}) {
  const local = useLocalBridge()
  const { dateLocale, t } = useI18n()
  const [selected, setSelected] = useState<MergeSelection[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selectedDayId = selected[0]?.day.id ?? null

  function close() {
    if (saving) return
    setSelected([])
    setError(null)
    onClose()
  }

  function toggle(day: Day, conversation: ConversationSummary) {
    const key = selectionKey(day.id, conversation)
    setError(null)
    setSelected((current) =>
      current.some((item) => selectionKey(item.day.id, item.conversation) === key)
        ? current.filter((item) => selectionKey(item.day.id, item.conversation) !== key)
        : [...current, { day, conversation }]
    )
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const dayId = selected[0]?.day.id
    if (!local.bridge || !dayId || selected.length < 2) return
    setSaving(true)
    setError(null)
    try {
      await local.bridge.mergeConversations(
        dayId,
        selected.map((item) => conversationReference(item.conversation))
      )
      setSelected([])
      onClose()
    } catch {
      setError(t('Deze gesprekken konden niet worden samengevoegd. Controleer of de audio nog beschikbaar is.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onClose={close} className="app-no-drag relative z-50">
      <DialogBackdrop
        transition
        className="fixed inset-0 bg-modal-backdrop backdrop-blur-[1px] transition-opacity data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
      />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel
          transition
          className="flex max-h-[calc(100dvh-2rem)] min-w-0 w-full max-w-xl origin-center flex-col overflow-hidden rounded-xl bg-white shadow-raised transition-[opacity,scale] data-[closed]:scale-[0.98] data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
        >
          <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
            <header className="flex min-h-14 shrink-0 items-center gap-4 border-black/[0.07] border-b px-5 py-3.5">
              <DialogTitle className="min-w-0 flex-1 font-semibold text-slate-950 text-md">
                {t('Gesprekken samenvoegen')}
              </DialogTitle>
              <IconButton
                type="button"
                onClick={close}
                disabled={saving}
                aria-label={t('Sluit samenvoegen')}
                size="compact"
              >
                <IconCrossSmall className="size-4" aria-hidden="true" />
              </IconButton>
            </header>
            <div className="min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain px-3 py-3">
              {groups.map((group) => (
                <fieldset key={group.date} className="mb-4 min-w-0 last:mb-0">
                  <legend className="px-2 pb-1.5 font-semibold text-slate-500 text-xs">
                    {formatConversationDate(group.date, dateLocale)}
                  </legend>
                  <div className="min-w-0 divide-y divide-slate-100 overflow-hidden rounded-xl bg-slate-50/70 shadow-inset">
                    {group.items.map(({ day, conversation }) => {
                      const key = selectionKey(day.id, conversation)
                      const checked = selected.some((item) => selectionKey(item.day.id, item.conversation) === key)
                      const hasLocalAudio = Boolean(conversation.episodeId && conversation.source !== 'revinote')
                      const disabled =
                        saving ||
                        !hasLocalAudio ||
                        Boolean(conversation.processing) ||
                        (selectedDayId !== null && selectedDayId !== day.id)
                      return (
                        <label
                          key={key}
                          className="group flex min-h-16 w-full min-w-0 cursor-pointer items-center gap-3 px-3 py-2.5 outline-none has-disabled:cursor-not-allowed has-disabled:opacity-45 has-focus-visible:ring-2 has-focus-visible:ring-inset has-focus-visible:ring-slate-400"
                        >
                          <input
                            type="checkbox"
                            className="peer sr-only"
                            checked={checked}
                            disabled={disabled}
                            onChange={() => toggle(day, conversation)}
                          />
                          <span className="flex size-5 shrink-0 items-center justify-center rounded-md border border-black/[0.12] bg-white text-transparent transition-[background-color,border-color,color] duration-150 group-hover:border-slate-300 peer-checked:border-blue-700 peer-checked:bg-blue-700 peer-checked:text-white motion-reduce:transition-none">
                            <IconCheckmark1Small className="size-3.5" aria-hidden="true" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="shrink-0 font-medium text-slate-500 text-xs tabular-nums">
                                {formatConversationTimeRange(conversation.startTime, conversation.endTime)}
                              </span>
                              <span className="truncate font-medium text-slate-900 text-sm">{conversation.title}</span>
                            </span>
                            <span className="mt-0.5 block truncate text-slate-500 text-xs">
                              {hasLocalAudio ? conversation.description : t('Geen lokale audio beschikbaar')}
                            </span>
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </fieldset>
              ))}
            </div>
            <footer className="shrink-0 border-black/[0.07] border-t px-5 py-3.5">
              {error ? (
                <p className="mb-3 text-danger-700 text-xs" role="alert">
                  {error}
                </p>
              ) : null}
              <div className="flex items-center justify-between gap-3">
                <p className="text-slate-500 text-xs tabular-nums">
                  {selected.length
                    ? t('{count} geselecteerd', { count: selected.length })
                    : t('Nog niets geselecteerd')}
                </p>
                <div className="flex gap-2">
                  <Button type="button" variant="text" color="secondary" onClick={close} disabled={saving}>
                    {t('Annuleer')}
                  </Button>
                  <Button type="submit" disabled={saving || selected.length < 2}>
                    {saving ? <Spinner size="xs" /> : null}
                    {saving ? t('Samenvoegen…') : t('Voeg samen')}
                  </Button>
                </div>
              </div>
            </footer>
          </form>
        </DialogPanel>
      </div>
    </Dialog>
  )
}

export function ConversationsLoadingState() {
  const { t } = useI18n()
  return (
    <Container className={conversationCanvasClassName}>
      <DashboardContentHeader title={t('Gesprekken')} />
      <ConversationTabs active="all" />
      <PendingIndicator label={t('Gesprekken laden')} />
    </Container>
  )
}

export function ConversationsView() {
  const local = useLocalBridge()
  const { dateLocale, t } = useI18n()
  const [visibleCount, setVisibleCount] = useState(CONVERSATION_PAGE_SIZE)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [retryBusyId, setRetryBusyId] = useState<string | null>(null)
  const [retryingLoad, setRetryingLoad] = useState(false)
  const conversationStart = useConversationStartControls()
  const groups = useMemo(() => conversationHistory(local.days), [local.days])
  const mergeGroups = useMemo(() => mergeableConversationHistory(groups), [groups])
  const visibleGroups = useMemo(() => limitConversationHistory(groups, visibleCount), [groups, visibleCount])
  const totalCount = useMemo(() => groups.reduce((count, group) => count + group.items.length, 0), [groups])
  const remainingCount = Math.max(totalCount - visibleCount, 0)
  const nextLoadCount = Math.min(CONVERSATION_PAGE_SIZE, remainingCount)
  const canMerge = canMergeConversationHistory(groups)

  async function retryLoad() {
    if (retryingLoad) return
    setRetryingLoad(true)
    try {
      await local.refresh()
    } finally {
      setRetryingLoad(false)
    }
  }

  async function retryConversation(dayId: string, episodeId: string) {
    if (!local.bridge || retryBusyId) return
    setRetryBusyId(episodeId)
    try {
      await local.bridge.recoverConversation(dayId, [episodeId])
    } finally {
      setRetryBusyId(null)
    }
  }

  if (!local.ready || local.dataLoadStatus.days === 'loading') return <ConversationsLoadingState />

  return (
    <Container className={conversationCanvasClassName}>
      <DashboardContentHeader
        title={
          canMerge ? (
            <span className="group/title inline-flex items-center gap-1">
              <span>{t('Gesprekken')}</span>
              <Menu>
                <MenuButton
                  as={IconButton}
                  aria-label={t('Meer opties voor gesprekken')}
                  size="compact"
                  className="cursor-pointer opacity-100 transition-opacity duration-150 data-open:bg-slate-100 data-open:text-slate-700 md:opacity-0 md:group-hover/title:opacity-100 md:group-focus-within/title:opacity-100 motion-reduce:transition-none"
                >
                  <IconDotGrid1x3HorizontalTight className="size-3.5" aria-hidden="true" />
                </MenuButton>
                <DropdownMenuItems anchor="bottom start" className="mt-1 w-52 origin-top-left">
                  <MenuItem>
                    <button type="button" onClick={() => setMergeOpen(true)} className={dropdownItemStyle}>
                      {t('Gesprekken samenvoegen')}
                    </button>
                  </MenuItem>
                </DropdownMenuItems>
              </Menu>
            </span>
          ) : (
            t('Gesprekken')
          )
        }
        action={
          <span className="flex shrink-0 items-center gap-2">
            <ConversationPreferences />
            {conversationStart.action}
          </span>
        }
      />
      <ConversationTabs active="all" />
      {conversationStart.feedback}
      {local.dataLoadStatus.days === 'error' ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-slate-500 text-sm" role="alert">
            {t('Gesprekken konden niet worden geladen.')}
          </p>
          <Button
            size="small"
            variant="outline"
            color="secondary"
            disabled={retryingLoad}
            onClick={() => void retryLoad()}
          >
            {retryingLoad ? <Spinner size="xs" /> : null}
            {t('Probeer opnieuw')}
          </Button>
        </div>
      ) : groups.length ? (
        <>
          <div id="conversation-history" className="grid min-w-0 gap-6">
            {visibleGroups.map((group) => {
              const headingId = `conversations-${group.date}`
              return (
                <section key={group.date} aria-labelledby={headingId} className="grid min-w-0 gap-2">
                  <h2 id={headingId} className="font-medium text-slate-500 text-xs">
                    {formatConversationDate(group.date, dateLocale)}
                  </h2>
                  <ol className="grid min-w-0 gap-0.5">
                    {group.items.map(({ day, conversation }) => {
                      const title = conversation.title.trim() || t('Nieuwe meeting')
                      const processing = conversation.processing
                      if (conversation.processingError && processing !== 'processing') {
                        const canRetry = conversation.processingError === 'analysis' && Boolean(conversation.episodeId)
                        const retrying = retryBusyId === conversation.episodeId
                        return (
                          <li
                            key={selectionKey(day.id, conversation)}
                            className="-mx-3 flex min-h-10 min-w-0 items-center gap-2 rounded-lg px-3 py-2"
                          >
                            <Link
                              href={conversationsConversationHref(day, conversation)}
                              className="min-w-0 flex-1 rounded-md outline-none hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-slate-400"
                            >
                              <span className="block truncate font-medium text-slate-900 text-ui leading-5">
                                {title}
                              </span>
                              <span className="mt-0.5 block text-danger-700 text-xs">
                                {conversation.processingError === 'revinote'
                                  ? t('Niet naar Revinote')
                                  : conversation.processingError === 'audio'
                                    ? t('Audio niet beschikbaar')
                                    : t('Verwerken mislukt')}
                              </span>
                            </Link>
                            <span className="shrink-0 whitespace-nowrap text-slate-500 text-xs tabular-nums">
                              {formatConversationTimeRange(conversation.startTime, conversation.endTime)}
                            </span>
                            {canRetry ? (
                              <Button
                                size="small"
                                variant="text"
                                color="secondary"
                                disabled={retrying}
                                onClick={() => void retryConversation(day.id, conversation.episodeId as string)}
                              >
                                {retrying ? <Spinner size="xs" /> : null}
                                {t('Opnieuw')}
                              </Button>
                            ) : null}
                          </li>
                        )
                      }
                      if (processing === 'merging') {
                        return (
                          <li key={selectionKey(day.id, conversation)} className="min-w-0">
                            <div
                              aria-live="polite"
                              className="-mx-3 flex min-h-10 min-w-0 items-center gap-2 rounded-lg px-3 py-2"
                            >
                              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                <span className="truncate font-medium text-slate-900 text-ui leading-5">{title}</span>
                                <MarkdownPreview className="truncate text-slate-500 text-xs">
                                  {conversation.description}
                                </MarkdownPreview>
                              </span>
                              <span className="shrink-0 whitespace-nowrap text-slate-500 text-xs tabular-nums">
                                {formatConversationTimeRange(conversation.startTime, conversation.endTime)}
                              </span>
                              <Spinner size="xs" label={t('Gesprek verwerken')} />
                            </div>
                          </li>
                        )
                      }
                      return (
                        <li key={selectionKey(day.id, conversation)} className="min-w-0">
                          <Link
                            href={conversationsConversationHref(day, conversation)}
                            className="-mx-3 flex min-h-10 min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-left outline-none transition-colors duration-150 ease-out hover:bg-slate-100/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-slate-400 active:bg-slate-100 motion-reduce:transition-none"
                          >
                            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                              <span className="flex min-w-0 items-center gap-1.5">
                                {processing === 'processing' ? (
                                  <span
                                    className="h-5 w-full max-w-64 animate-pulse rounded bg-slate-200 motion-reduce:animate-none"
                                    role="status"
                                    aria-label={t('Gesprek verwerken')}
                                  />
                                ) : (
                                  <span className="truncate font-medium text-slate-900 text-ui leading-5">{title}</span>
                                )}
                                {conversation.source === 'revinote' ? <RevinoteSourceIcon /> : null}
                              </span>
                              {processing === 'processing' ? (
                                <span className="h-3.5 w-32 animate-pulse rounded bg-slate-200 motion-reduce:animate-none" />
                              ) : conversation.description ? (
                                <MarkdownPreview className="truncate text-slate-500 text-xs">
                                  {conversation.description}
                                </MarkdownPreview>
                              ) : null}
                            </span>
                            <span className="shrink-0 whitespace-nowrap text-slate-500 text-xs tabular-nums">
                              {formatConversationTimeRange(conversation.startTime, conversation.endTime)}
                            </span>
                          </Link>
                        </li>
                      )
                    })}
                  </ol>
                </section>
              )
            })}
          </div>
          {remainingCount > 0 ? (
            <div className="flex justify-center">
              <Button
                size="small"
                variant="outline"
                color="secondary"
                aria-controls="conversation-history"
                onClick={() => setVisibleCount((current) => Math.min(current + CONVERSATION_PAGE_SIZE, totalCount))}
              >
                {t('{count} meer laden', { count: nextLoadCount })}
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <div className="grid gap-1">
          <h2 className="font-medium text-slate-700 text-sm">{t('Nog geen gesprekken')}</h2>
          <p className="text-slate-500 text-sm">
            {t('Gesprekken verschijnen hier zodra Remember ze in een werkdag heeft herkend.')}
          </p>
        </div>
      )}
      <ConversationMergeDialog groups={mergeGroups} open={mergeOpen} onClose={() => setMergeOpen(false)} />
    </Container>
  )
}
