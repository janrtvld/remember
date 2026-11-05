'use client'

import {
  Dialog,
  DialogBackdrop,
  DialogPanel,
  DialogTitle,
  Disclosure,
  DisclosureButton,
  DisclosurePanel,
  Tab,
  TabGroup,
  TabList,
  TabPanel,
  TabPanels,
} from '@headlessui/react'
import { useLocalBridge } from '@internal/context/LocalBridgeProvider'
import { readLocalStorageJson, removeLocalStorageItem, writeLocalStorageJson } from '@internal/lib/localStorageJson'
import { useI18n } from '@internal/locales'
import { Button } from '@internal/ui/Button'
import { IconButton } from '@internal/ui/IconButton'
import { PendingIndicator } from '@internal/ui/PendingIndicator'
import { Spinner } from '@internal/ui/Spinner'
import type { AgentProvider, AgentTurnStep, AgentTurnUpdate, WorkItem } from '@remember/shared'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  Bot as IconAgents,
  Archive as IconArchiveJunk,
  ArrowDown as IconArrowDown,
  Inbox as IconArrowInbox,
  ArrowLeft as IconArrowLeft,
  ArrowRight as IconArrowRight,
  MessageSquare as IconBubbleSparkle,
  MessagesSquare as IconBubbles,
  Check as IconCheckmark1Small,
  ChevronRight as IconChevronRight,
  CircleCheck as IconCircleCheck,
  CircleDashed as IconCircleDashed,
  X as IconCrossSmall,
  Inbox as IconInbox,
  Pencil as IconPencil,
  Plus as IconPlusSmall,
  Square as IconStop,
  AppWindow as IconWindowCursor,
} from 'lucide-react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { twMerge } from 'tailwind-merge'
import { AgentWorkerControls, useAgentWorkerInteractions } from './AgentWorkerControls'
import { DashboardLoadError } from './DashboardLoadError'
import { DashboardPageHeader } from './DashboardPageHeader'
import { isLocalToday } from './dayNavigation'
import { InboxOutcome } from './InboxOutcome'
import { type InboxReadState, markInboxTaskRead, markInboxTasksUnread, parseInboxReadState } from './inboxReadState'
import {
  formatInboxRelativeTime,
  type InboxActivityEvent,
  type InboxAgentTurn,
  type InboxTaskDraft,
  type InboxTaskItem,
  inboxAgentTurns,
  inboxOriginSource,
  inboxReturnPoint,
  inboxSelectionAfterRemoval,
  inboxSourceHref,
  inboxTaskEvents,
  inboxTaskHref,
  inboxTasks,
  isInboxTaskUnread,
  reconcileInboxTaskDraft,
  sameInboxTaskDraft,
  selectedInboxTask,
} from './inboxTasks'
import { ListContextMenu } from './ListContextMenu'
import { compactMarkdownContentClassName, MarkdownContent } from './MarkdownContent'
import { useInboxLifecycle } from './useInboxLifecycle'
import { useListSelection } from './useListSelection'

type StoredInboxDraft = InboxTaskDraft & {
  version: 1
  baseSignature: string
}

const INBOX_DRAFT_STORAGE_PREFIX = 'remember:inbox-draft:'
const INBOX_READ_STATE_STORAGE_KEY = 'remember:inbox-read-state'

function writeInboxReadState(state: InboxReadState) {
  writeLocalStorageJson(INBOX_READ_STATE_STORAGE_KEY, state)
}

function inboxDraftSignature(draft: InboxTaskDraft) {
  return `${draft.title}\u0000${draft.description}`
}

function inboxDraftStorageKey(taskKey: string) {
  return `${INBOX_DRAFT_STORAGE_PREFIX}${taskKey}`
}

function readStoredInboxDraft(taskKey: string): StoredInboxDraft | null {
  const key = inboxDraftStorageKey(taskKey)
  const stored = readLocalStorageJson(key) as Partial<StoredInboxDraft> | null
  if (!stored) return null
  if (
    stored.version !== 1 ||
    typeof stored.baseSignature !== 'string' ||
    typeof stored.title !== 'string' ||
    typeof stored.description !== 'string'
  ) {
    removeLocalStorageItem(key)
    return null
  }
  return stored as StoredInboxDraft
}

function writeStoredInboxDraft(taskKey: string, draft: Omit<StoredInboxDraft, 'version'>) {
  writeLocalStorageJson(inboxDraftStorageKey(taskKey), { version: 1, ...draft } satisfies StoredInboxDraft)
}

function removeStoredInboxDraft(taskKey: string) {
  removeLocalStorageItem(inboxDraftStorageKey(taskKey))
}

export function InboxView() {
  const local = useLocalBridge()
  const { t } = useI18n()
  const [createOpen, setCreateOpen] = useState(false)
  const [showCompleted, setShowCompleted] = useState(false)
  const lifecycle = useInboxLifecycle(local.workItems, local.upsertWorkItem)
  const searchParams = useSearchParams()
  const requestedItemId = searchParams.get('item')
  const requestedWorkItem = lifecycle.items.find((item) => item.id === requestedItemId)
  const requestedTaskIncludingCompleted = requestedWorkItem
    ? { taskKey: requestedWorkItem.id, workItem: requestedWorkItem }
    : null
  const includeCompleted =
    showCompleted ||
    (requestedTaskIncludingCompleted?.workItem.lifecycle !== 'open' && requestedTaskIncludingCompleted != null)
  const items = useMemo(() => inboxTasks(lifecycle.items, includeCompleted), [includeCompleted, lifecycle.items])
  const requestedTask = selectedInboxTask(items, requestedItemId)
  const hasExplicitSelection = Boolean(requestedItemId)
  const showRequestedDetail = hasExplicitSelection && requestedTask !== null
  const selected = hasExplicitSelection ? requestedTask : (items[0] ?? null)
  const [readState, setReadState] = useState<InboxReadState | null>(null)
  const [desktopDetailVisible, setDesktopDetailVisible] = useState(false)
  const [pageVisibleAndFocused, setPageVisibleAndFocused] = useState(false)

  useEffect(() => {
    const media = window.matchMedia('(min-width: 768px)')
    const update = () => setDesktopDetailVisible(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    const update = () => setPageVisibleAndFocused(document.visibilityState === 'visible' && document.hasFocus())
    update()
    document.addEventListener('visibilitychange', update)
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    return () => {
      document.removeEventListener('visibilitychange', update)
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
    }
  }, [])

  useEffect(() => {
    if (local.dataLoadStatus.workItems !== 'ready' || readState) return
    const stored = parseInboxReadState(readLocalStorageJson(INBOX_READ_STATE_STORAGE_KEY))
    if (stored) {
      setReadState(stored)
      return
    }

    const baseline = {
      version: 1,
      seenUpdatedAtByTask: Object.fromEntries(local.workItems.map((item) => [item.id, item.updatedAt])),
      manuallyUnreadTaskKeys: [],
    } satisfies InboxReadState
    writeInboxReadState(baseline)
    setReadState(baseline)
  }, [local.dataLoadStatus.workItems, local.workItems, readState])

  const markRead = useCallback((item: InboxTaskItem, explicit = false) => {
    setReadState((current) => {
      if (!current) return current
      const next = markInboxTaskRead(current, item.taskKey, item.workItem.updatedAt, explicit)
      if (next !== current) writeInboxReadState(next)
      return next
    })
  }, [])

  const markUnread = useCallback((targets: InboxTaskItem[]) => {
    setReadState((current) => {
      if (!current) return current
      const next = markInboxTasksUnread(
        current,
        targets.map((item) => item.taskKey)
      )
      if (next !== current) writeInboxReadState(next)
      return next
    })
  }, [])

  const previousRequestedItemId = useRef(requestedItemId)
  useEffect(() => {
    const changed = previousRequestedItemId.current !== requestedItemId
    previousRequestedItemId.current = requestedItemId
    if (changed && requestedTask) markRead(requestedTask, true)
  }, [markRead, requestedItemId, requestedTask])

  useEffect(() => {
    if (!selected || !readState || !pageVisibleAndFocused || (!hasExplicitSelection && !desktopDetailVisible)) return
    markRead(selected)
  }, [desktopDetailVisible, hasExplicitSelection, markRead, pageVisibleAndFocused, readState, selected])

  const unreadTaskKeys = useMemo(
    () =>
      new Set(
        readState
          ? items
              .filter((item) =>
                isInboxTaskUnread(
                  item,
                  readState.seenUpdatedAtByTask[item.taskKey],
                  readState.manuallyUnreadTaskKeys.includes(item.taskKey)
                )
              )
              .map((item) => item.taskKey)
          : []
      ),
    [items, readState]
  )

  function changeShowCompleted(next: boolean) {
    setShowCompleted(next)
    if (!next && selected?.workItem.lifecycle !== 'open') window.history.replaceState(null, '', '/inbox/')
  }

  async function setLifecycle(targets: InboxTaskItem[], nextLifecycle: WorkItem['lifecycle']) {
    const previousHref = window.location.pathname + window.location.search
    const update = lifecycle.setLifecycle(targets, nextLifecycle)
    let nextHref: string | null = null
    if (selected && (hasExplicitSelection || desktopDetailVisible)) {
      const next =
        nextLifecycle !== 'open' && !showCompleted
          ? inboxSelectionAfterRemoval(items, selected, new Set(targets.map((item) => item.taskKey)))
          : selected
      nextHref = next ? inboxTaskHref(next) : '/inbox/'
      window.history.replaceState(null, '', nextHref)
    }
    const failed = await update
    if (
      selected &&
      failed.includes(selected.taskKey) &&
      nextHref === window.location.pathname + window.location.search
    ) {
      window.history.replaceState(null, '', previousHref)
    }
    return failed
  }

  if (local.dataLoadStatus.workItems === 'loading') {
    return (
      <>
        <h1 className="sr-only">{t('Inbox')}</h1>
        <InboxPageHeader item={null} showCompleted={includeCompleted} onShowCompletedChange={changeShowCompleted} />
        <main className="flex min-h-[22rem] grow items-center justify-center">
          <PendingIndicator size="lg" label={t('Inbox')} />
        </main>
      </>
    )
  }
  if (local.dataLoadStatus.workItems === 'error') {
    return (
      <DashboardLoadError title={t('Inbox')} message={t('Inbox kon niet worden geladen.')} onRetry={local.refresh} />
    )
  }

  return (
    <>
      <h1 className="sr-only">{t('Inbox')}</h1>
      {lifecycle.failed ? (
        <p className="border-black/[0.05] border-b px-4 py-2 text-danger-700 text-xs" role="alert">
          {t('Sommige actiepunten konden niet worden bijgewerkt. Probeer opnieuw.')}
        </p>
      ) : null}
      {selected ? null : (
        <InboxPageHeader
          item={null}
          showCompleted={includeCompleted}
          onShowCompletedChange={changeShowCompleted}
          onCreate={() => setCreateOpen(true)}
        />
      )}
      {items.length ? (
        <div className="grid h-full min-h-0 grid-cols-1 bg-white md:grid-cols-[minmax(17rem,21rem)_minmax(0,1fr)]">
          <InboxList
            items={items}
            selected={selected}
            unreadTaskKeys={unreadTaskKeys}
            onMarkUnread={markUnread}
            onOpenItem={(item) => {
              // New selections are marked read after their detail has captured its first-visit state.
              if (item.taskKey === selected?.taskKey && readState?.seenUpdatedAtByTask[item.taskKey] !== undefined) {
                markRead(item, true)
              }
            }}
            hiddenOnNarrow={showRequestedDetail}
            pendingTaskKeys={lifecycle.pending}
            onSetLifecycle={setLifecycle}
          />
          {selected ? (
            <InboxDetail
              key={selected.taskKey}
              activityVisible={showRequestedDetail || desktopDetailVisible}
              item={selected}
              firstVisit={
                readState !== null &&
                readState.seenUpdatedAtByTask[selected.taskKey] === undefined &&
                (showRequestedDetail || desktopDetailVisible)
              }
              showOnNarrow={showRequestedDetail}
              showCompleted={includeCompleted}
              onShowCompletedChange={changeShowCompleted}
              onSetLifecycle={setLifecycle}
              onCreate={() => setCreateOpen(true)}
            />
          ) : (
            <main className="hidden min-h-0 items-center justify-center px-6 text-center md:flex">
              <p className="text-slate-500 text-ui">{t('Selecteer een actiepunt.')}</p>
            </main>
          )}
        </div>
      ) : (
        <div className="grid h-full min-h-[22rem] grow grid-cols-1 bg-white md:grid-cols-[minmax(17rem,21rem)_minmax(0,1fr)]">
          <section
            aria-label={t('Inbox')}
            className="flex min-h-0 min-w-0 items-center justify-center border-black/[0.07] px-6 text-center md:border-r"
          >
            <p className="text-slate-500 text-ui">{t('Je inbox is leeg')}</p>
          </section>
          <main className="hidden min-h-0 min-w-0 flex-col items-center justify-center px-6 text-center text-slate-500 md:flex">
            <IconInbox className="size-20 [&_path]:stroke-[1.25px]" aria-hidden="true" />
            <p className="mt-6 text-ui">{t('Geen actiepunt geselecteerd')}</p>
          </main>
        </div>
      )}
      <CreateActionPointDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(created) => {
          setCreateOpen(false)
          local.upsertWorkItem(created)
          markRead({ workItem: created, taskKey: created.id })
          const search = new URLSearchParams({ item: created.id })
          window.history.pushState(null, '', `/inbox/?${search.toString()}`)
        }}
      />
    </>
  )
}

function InboxPageHeader({
  item,
  showDetailOnNarrow = false,
  removing = false,
  showCompleted,
  onShowCompletedChange,
  agentRunning = false,
  agentProvider = 'codex',
  onRemove,
  onCreate,
}: {
  item: InboxTaskItem | null
  showDetailOnNarrow?: boolean
  removing?: boolean
  showCompleted: boolean
  onShowCompletedChange: (showCompleted: boolean) => void
  agentRunning?: boolean
  agentProvider?: AgentProvider
  onRemove?: () => void
  onCreate?: () => void
}) {
  const { t } = useI18n()
  const sourceHref = item ? inboxSourceHref(item) : null

  return (
    <DashboardPageHeader>
      <header
        className={twMerge('grid min-h-[43px] grid-cols-1', item && 'md:grid-cols-[minmax(17rem,21rem)_minmax(0,1fr)]')}
      >
        <div
          className={twMerge(
            'flex min-h-[43px] min-w-0 items-center border-slate-200 border-b pl-3 pr-2.5',
            item && 'md:border-r'
          )}
        >
          <nav aria-label={t('Kruimelpad')} className="min-w-0 flex-1 overflow-hidden">
            <ol className="flex min-w-0 items-center text-slate-800 text-sm">
              <li className="shrink-0">
                {showDetailOnNarrow && item ? (
                  <Link
                    href="/inbox/"
                    onNavigate={(event) => {
                      event.preventDefault()
                      window.history.pushState(null, '', '/inbox/')
                    }}
                    className="flex h-7 items-center rounded-md px-2 font-medium text-slate-800 outline-none hover:bg-slate-100 hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-400"
                  >
                    {t('Inbox')}
                  </Link>
                ) : (
                  <span aria-current="page" className="flex h-7 items-center px-2 font-medium text-slate-800">
                    {t('Inbox')}
                  </span>
                )}
              </li>
              {showDetailOnNarrow && item ? (
                <>
                  <li aria-hidden="true" className="flex shrink-0 items-center text-current md:hidden">
                    <IconChevronRight className="size-3.5" />
                  </li>
                  <li aria-current="page" className="flex min-w-0 items-center font-medium text-slate-800 md:hidden">
                    <span className="min-w-0 truncate px-2">{item.workItem.title}</span>
                    {agentRunning ? <InboxAgentRunningIndicator provider={agentProvider} /> : null}
                  </li>
                </>
              ) : null}
            </ol>
          </nav>
          <InboxViewPreferences showCompleted={showCompleted} onShowCompletedChange={onShowCompletedChange} />
          {onCreate ? (
            <IconButton
              type="button"
              onClick={onCreate}
              aria-label={t('Nieuw actiepunt')}
              size="compact"
              className="ml-1 shrink-0"
            >
              <IconPlusSmall className="size-4" aria-hidden="true" />
            </IconButton>
          ) : null}
          {showDetailOnNarrow && item && (sourceHref || onRemove) ? (
            <div className="ml-1 flex shrink-0 items-center gap-0.5 md:hidden">
              {sourceHref ? <InboxEvidenceLink item={item} href={sourceHref} /> : null}
              {onRemove ? (
                <IconButton
                  type="button"
                  onClick={onRemove}
                  disabled={removing}
                  aria-label={t('Markeer {title} als niet nodig', { title: item.workItem.title })}
                  title={t('Niet nodig')}
                  size="compact"
                >
                  {removing ? <Spinner size="xs" /> : <IconArchiveJunk className="size-4" aria-hidden="true" />}
                </IconButton>
              ) : null}
            </div>
          ) : null}
        </div>
        {item ? (
          <div className="hidden min-h-[43px] min-w-0 items-center border-slate-200 border-b px-3 md:flex">
            <div className="flex min-w-0 flex-1 items-center">
              <span className="min-w-0 truncate px-2 font-medium text-slate-800 text-sm">{item.workItem.title}</span>
              {agentRunning ? <InboxAgentRunningIndicator provider={agentProvider} /> : null}
            </div>
            {sourceHref || onRemove ? (
              <div className="ml-1 flex shrink-0 items-center gap-0.5">
                {sourceHref ? <InboxEvidenceLink item={item} href={sourceHref} /> : null}
                {onRemove ? (
                  <IconButton
                    type="button"
                    onClick={onRemove}
                    disabled={removing}
                    aria-label={t('Markeer {title} als niet nodig', { title: item.workItem.title })}
                    title={t('Niet nodig')}
                    size="compact"
                  >
                    {removing ? <Spinner size="xs" /> : <IconArchiveJunk className="size-4" aria-hidden="true" />}
                  </IconButton>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </header>
    </DashboardPageHeader>
  )
}

function InboxEvidenceLink({ item, href }: { item: InboxTaskItem; href: string }) {
  const { t } = useI18n()
  const source = inboxOriginSource(item)
  const label =
    source?.kind === 'meeting' ? t('Open gesprek') : source?.kind === 'observed' ? t('Open tijdlijn') : t('Bewijs')

  return (
    <Link
      href={href}
      aria-label={label}
      title={label}
      className="relative flex size-6 shrink-0 select-none items-center justify-center rounded-lg text-slate-400 outline-none transition-[background-color,color,transform] duration-150 ease-out before:absolute before:-inset-1 before:content-[''] hover:bg-slate-100 hover:text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 active:scale-[0.98] motion-reduce:transition-none"
    >
      <IconAgents className="size-4" aria-hidden="true" />
    </Link>
  )
}

function InboxViewPreferences({
  showCompleted,
  onShowCompletedChange,
}: {
  showCompleted: boolean
  onShowCompletedChange: (showCompleted: boolean) => void
}) {
  const { t } = useI18n()
  const label = showCompleted ? t('Alleen open taken tonen') : t('Alle taken tonen')
  return (
    <IconButton
      type="button"
      size="compact"
      tone={showCompleted ? 'accent' : 'neutral'}
      aria-label={label}
      aria-pressed={showCompleted}
      title={label}
      onClick={() => onShowCompletedChange(!showCompleted)}
      className={twMerge('ml-1 shrink-0', showCompleted && 'bg-blue-100 text-blue-700 hover:bg-slate-100')}
    >
      <IconInbox className="size-4" aria-hidden="true" />
    </IconButton>
  )
}

function InboxAgentRunningIndicator({ provider }: { provider: AgentProvider }) {
  const { t } = useI18n()
  const providerName = provider === 'claude' ? 'Claude' : 'Codex'
  const label = t('{provider} werkt aan dit actiepunt', { provider: providerName })
  return (
    <span className="inline-flex size-6 shrink-0 items-center justify-center" title={label}>
      <Spinner size="xs" label={label} />
    </span>
  )
}

function CreateActionPointDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (created: WorkItem) => void
}) {
  const { t } = useI18n()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setTitle('')
    setDescription('')
    setError(null)
    if ('ontouchstart' in window) return
    const frame = requestAnimationFrame(() => titleInputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])

  async function create(event: FormEvent) {
    event.preventDefault()
    const normalizedTitle = title.trim()
    if (!normalizedTitle || saving) return
    if (normalizedTitle.length > 120) {
      setError(t('Een titel mag maximaal 120 tekens bevatten.'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      const created = await window.remember.createWorkItem({
        title: normalizedTitle,
        description: description.trim(),
      })
      onCreated(created)
    } catch {
      setError(t('Dit actiepunt kon niet worden toegevoegd. Probeer het opnieuw.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onClose={saving ? () => undefined : onClose} className="app-no-drag relative z-50">
      <DialogBackdrop
        transition
        className="fixed inset-0 bg-modal-backdrop backdrop-blur-[1px] transition-opacity data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
      />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel
          transition
          className="flex max-h-[calc(100dvh-2rem)] w-full max-w-md origin-center flex-col overflow-hidden rounded-xl bg-white shadow-raised transition-[opacity,scale] data-[closed]:scale-[0.98] data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
        >
          <form onSubmit={create} className="flex min-h-0 flex-1 flex-col">
            <header className="flex min-h-14 shrink-0 items-center gap-3 border-black/[0.07] border-b px-5 py-3.5">
              <DialogTitle className="min-w-0 flex-1 font-semibold text-slate-950 text-md">
                {t('Nieuw actiepunt')}
              </DialogTitle>
              <IconButton type="button" size="compact" onClick={onClose} disabled={saving} aria-label={t('Sluiten')}>
                <IconCrossSmall className="size-4" aria-hidden="true" />
              </IconButton>
            </header>
            <div className="min-h-0 overflow-y-auto p-5">
              <label htmlFor="new-action-point-title" className="sr-only">
                {t('Titel')}
              </label>
              <input
                ref={titleInputRef}
                id="new-action-point-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={120}
                aria-describedby="new-action-point-title-limit"
                placeholder={t('Titel van actiepunt')}
                className="block h-9 w-full bg-transparent font-semibold text-lg text-slate-950 outline-none placeholder:font-medium placeholder:text-slate-300"
              />

              <label htmlFor="new-action-point-description" className="sr-only">
                {t('Beschrijving')}
              </label>
              <textarea
                id="new-action-point-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                    event.preventDefault()
                    event.currentTarget.form?.requestSubmit()
                  }
                }}
                rows={5}
                placeholder={t('Beschrijving toevoegen…')}
                className="mt-2 block min-h-28 w-full resize-none bg-transparent text-slate-700 text-ui leading-6 outline-none placeholder:text-slate-300"
              />
              {error ? (
                <p className="mt-3 text-danger-700 text-xs" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
            <footer className="flex shrink-0 justify-end gap-2 border-black/[0.07] border-t px-5 py-3.5">
              <Button type="button" variant="text" color="secondary" onClick={onClose} disabled={saving}>
                {t('Annuleer')}
              </Button>
              <Button type="submit" disabled={saving || !title.trim()}>
                {saving ? t('Toevoegen…') : t('Toevoegen')}
              </Button>
            </footer>
          </form>
        </DialogPanel>
      </div>
    </Dialog>
  )
}

function InboxList({
  items,
  selected,
  unreadTaskKeys,
  onMarkUnread,
  onOpenItem,
  hiddenOnNarrow,
  pendingTaskKeys,
  onSetLifecycle,
}: {
  items: InboxTaskItem[]
  selected: InboxTaskItem | null
  unreadTaskKeys: ReadonlySet<string>
  onMarkUnread: (items: InboxTaskItem[]) => void
  onOpenItem: (item: InboxTaskItem) => void
  hiddenOnNarrow: boolean
  pendingTaskKeys: ReadonlyMap<string, WorkItem['lifecycle']>
  onSetLifecycle: (items: InboxTaskItem[], lifecycle: WorkItem['lifecycle']) => Promise<string[]>
}) {
  const local = useLocalBridge()
  const { t } = useI18n()
  const [now, setNow] = useState(0)
  const listRef = useRef<HTMLElement>(null)
  const itemIds = useMemo(() => items.map((item) => item.taskKey), [items])
  const selection = useListSelection(itemIds, listRef)
  const selectedItems = items.filter((item) => selection.selectedSet.has(item.taskKey))
  const getItemKey = useCallback((index: number) => items[index].taskKey, [items])
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 61,
    getItemKey,
    overscan: 6,
  })
  const selectedIndex = selected ? itemIds.indexOf(selected.taskKey) : -1

  useEffect(() => {
    if (selectedIndex >= 0) virtualizer.scrollToIndex(selectedIndex, { align: 'auto' })
  }, [selectedIndex, virtualizer])

  useEffect(() => {
    const updateNow = () => setNow(Date.now())
    updateNow()
    const interval = window.setInterval(updateNow, 60_000)
    return () => window.clearInterval(interval)
  }, [])

  async function setLifecycle(targets: InboxTaskItem[], lifecycle: WorkItem['lifecycle']) {
    const failed = await onSetLifecycle(targets, lifecycle)
    if (!failed.length) selection.clear()
  }

  return (
    <section
      ref={listRef}
      aria-label={t('Inbox')}
      className={twMerge(
        'flex min-h-0 min-w-0 flex-col overflow-y-auto overscroll-contain border-black/[0.07] md:border-r',
        hiddenOnNarrow ? 'hidden md:flex' : 'flex'
      )}
    >
      <ol className="relative min-w-0 shrink-0" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const item = items[row.index]
          const active = selected?.taskKey === item.taskKey
          const unread = unreadTaskKeys.has(item.taskKey)
          const agentRunning = local.taskActionsEnabled === false && item.workItem.attention === 'agent_running'
          const completed = item.workItem.lifecycle === 'completed'
          const closed = item.workItem.lifecycle !== 'open'
          const toggling = pendingTaskKeys.has(item.taskKey)
          const marked = selection.selectedSet.has(item.taskKey)
          const contextItems = marked ? selectedItems : [item]
          const provider = item.workItem.agentSessions.at(-1)?.provider ?? 'codex'
          return (
            <li
              key={row.key}
              ref={virtualizer.measureElement}
              data-index={row.index}
              aria-posinset={row.index + 1}
              aria-setsize={items.length}
              className={twMerge(
                'group absolute top-0 left-0 w-full min-w-0',
                row.index < items.length - 1 && 'border-black/[0.05] border-b'
              )}
              style={{ transform: `translateY(${row.start}px)` }}
            >
              <ListContextMenu
                label={t('Actiepunten')}
                onOpen={() => selection.selectForContext(item.taskKey)}
                actions={[
                  {
                    label: t('Markeren als ongelezen'),
                    onSelect: () => onMarkUnread(contextItems),
                  },
                  {
                    label: t('Afronden'),
                    disabled:
                      contextItems.some((item) => pendingTaskKeys.has(item.taskKey)) ||
                      contextItems.every((item) => item.workItem.lifecycle === 'completed'),
                    onSelect: () => void setLifecycle(contextItems, 'completed'),
                  },
                  {
                    label: t('Heropenen'),
                    disabled:
                      contextItems.some((item) => pendingTaskKeys.has(item.taskKey)) ||
                      contextItems.every((item) => item.workItem.lifecycle === 'open'),
                    onSelect: () => void setLifecycle(contextItems, 'open'),
                  },
                  {
                    label: t('Niet nodig'),
                    disabled: contextItems.some((item) => pendingTaskKeys.has(item.taskKey)),
                    onSelect: () => void setLifecycle(contextItems, 'abandoned'),
                  },
                ]}
              >
                {(contextProps) => (
                  <Link
                    {...contextProps}
                    href={inboxTaskHref(item)}
                    onClick={(event) => {
                      if (selection.click(event, item.taskKey, selected?.taskKey)) return
                      onOpenItem(item)
                      if (event.button !== 0 || event.altKey) return
                      event.preventDefault()
                      window.history.pushState(null, '', inboxTaskHref(item))
                    }}
                    aria-current={active ? 'true' : undefined}
                    aria-description={marked ? t('Geselecteerd') : undefined}
                    className={twMerge(
                      'relative grid min-h-[54px] w-full min-w-0 max-w-full grid-cols-[2rem_minmax(0,1fr)] items-center gap-3 px-4 py-3 text-left outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-400 motion-reduce:transition-none',
                      marked || active ? 'bg-slate-100/80' : 'hover:bg-slate-50 active:bg-slate-100'
                    )}
                  >
                    <InboxOriginMark item={item} />
                    <div className={twMerge('min-w-0 grid gap-0.5 self-center', agentRunning ? 'pr-14' : 'pr-7')}>
                      <span className="flex min-w-0 items-center gap-2">
                        {unread ? (
                          <>
                            <span className="size-2 shrink-0 rounded-full bg-blue-700" aria-hidden="true" />
                            <span className="sr-only">{t('Ongelezen')}</span>
                          </>
                        ) : null}
                        <span
                          className={twMerge(
                            'block min-w-0 truncate font-medium text-[13px] text-slate-900 leading-[17px]',
                            completed && 'text-slate-500 line-through decoration-slate-300'
                          )}
                        >
                          {item.workItem.title}
                        </span>
                      </span>
                      <span className="mt-px block truncate text-slate-600 text-xs leading-4">
                        {inboxOriginSentence(item)}
                      </span>
                    </div>
                    <time
                      dateTime={new Date(item.workItem.updatedAt).toISOString()}
                      className={twMerge(
                        'absolute right-2.5 bottom-2.5 w-6 text-center text-slate-600 text-xs leading-4 tabular-nums',
                        agentRunning && 'opacity-0'
                      )}
                    >
                      {formatInboxRelativeTime(item.workItem.updatedAt, now)}
                    </time>
                  </Link>
                )}
              </ListContextMenu>
              <div className="absolute top-1.5 right-2.5 z-10 flex h-6 items-center gap-0.5">
                {agentRunning ? <InboxAgentRunningIndicator provider={provider} /> : null}
                <IconButton
                  type="button"
                  size="compact"
                  tone={closed ? 'accent' : 'neutral'}
                  disabled={toggling}
                  onClick={() => void setLifecycle([item], closed ? 'open' : 'completed')}
                  aria-label={
                    closed
                      ? t('Heropen {title}', { title: item.workItem.title })
                      : t('Markeer {title} als afgerond', { title: item.workItem.title })
                  }
                  title={closed ? t('Heropenen') : t('Afronden')}
                  className="before:-inset-2"
                >
                  {closed ? (
                    <IconCircleCheck className="size-[18px]" aria-hidden="true" />
                  ) : (
                    <IconCircleDashed className="size-4" aria-hidden="true" />
                  )}
                </IconButton>
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function InboxDetail({
  item,
  firstVisit,
  activityVisible,
  showOnNarrow,
  showCompleted,
  onShowCompletedChange,
  onSetLifecycle,
  onCreate,
}: {
  item: InboxTaskItem
  firstVisit: boolean
  activityVisible: boolean
  showOnNarrow: boolean
  showCompleted: boolean
  onShowCompletedChange: (showCompleted: boolean) => void
  onSetLifecycle: (items: InboxTaskItem[], lifecycle: WorkItem['lifecycle']) => Promise<string[]>
  onCreate: () => void
}) {
  const local = useLocalBridge()
  const legacyAgent = local.taskActionsEnabled === false
  const { dateLocale, t } = useI18n()
  const [title, setTitle] = useState(item.workItem.title)
  const [description, setDescription] = useState(item.workItem.description)
  const [activeTab, setActiveTab] = useState(0)
  const [stoppingTurnId, setStoppingTurnId] = useState<string | null>(null)
  const [showLatestMessage, setShowLatestMessage] = useState(false)
  const [draftReady, setDraftReady] = useState(false)
  const [recoveredDraft, setRecoveredDraft] = useState<StoredInboxDraft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingTurn, setPendingTurn] = useState<PendingAgentTurn | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const followMessagesRef = useRef(true)
  const taskKeyRef = useRef(item.taskKey)
  const draftRef = useRef<InboxTaskDraft>({ title: item.workItem.title, description: item.workItem.description })
  const savedDraftRef = useRef<InboxTaskDraft>({
    title: item.workItem.title,
    description: item.workItem.description,
  })
  const savePromiseRef = useRef<Promise<boolean> | null>(null)
  const saveTaskRef = useRef<(() => Promise<boolean>) | null>(null)
  const recoveredDraftRef = useRef<StoredInboxDraft | null>(null)
  const defaultProvider = local.settings?.defaultAgentProvider ?? 'codex'
  const turns = inboxAgentTurns(item)
  const interactions = useAgentWorkerInteractions(item.taskKey)
  const artifact = item.workItem.agentSessions.findLast(
    (session) => session.status === 'completed' && session.response.trim()
  )
  const activeSession = item.workItem.agentSessions.findLast(
    (session) => session.status === 'running' || session.status === 'waiting_on_user'
  )
  const activeTurnId =
    (pendingTurn?.status === 'working' ? pendingTurn.id : activeSession?.id) ?? interactions.requests[0]?.turnId
  const canStop = Boolean(
    activeTurnId &&
      ((pendingTurn?.id === activeTurnId && (pendingTurn.steps.length || pendingTurn.response)) ||
        (activeSession?.id === activeTurnId && pendingTurn?.id !== activeTurnId) ||
        interactions.requests.some((request) => request.turnId === activeTurnId))
  )
  const agentBusy = Boolean(activeTurnId) || item.workItem.attention === 'agent_running'
  const hasWorker = legacyAgent && (agentBusy || pendingTurn !== null || item.workItem.agentSessions.length > 0)
  const selectedTab = hasWorker ? Math.min(activeTab, artifact ? 2 : 1) : 0

  useEffect(() => {
    const incomingSaved = { title: item.workItem.title, description: item.workItem.description }
    if (taskKeyRef.current !== item.taskKey) {
      taskKeyRef.current = item.taskKey
      savedDraftRef.current = incomingSaved
      draftRef.current = incomingSaved
      setTitle(incomingSaved.title)
      setDescription(incomingSaved.description)
      return
    }
    const nextDraft = reconcileInboxTaskDraft(draftRef.current, savedDraftRef.current, incomingSaved)
    savedDraftRef.current = incomingSaved
    draftRef.current = nextDraft
    setTitle(nextDraft.title)
    setDescription(nextDraft.description)
  }, [item.workItem.description, item.workItem.title, item.taskKey])

  useEffect(() => {
    const stored = readStoredInboxDraft(item.taskKey)
    if (stored) {
      const restored = { title: stored.title, description: stored.description }
      if (sameInboxTaskDraft(restored, savedDraftRef.current)) {
        removeStoredInboxDraft(item.taskKey)
      } else if (stored.baseSignature === inboxDraftSignature(savedDraftRef.current)) {
        draftRef.current = restored
        setTitle(restored.title)
        setDescription(restored.description)
      } else {
        recoveredDraftRef.current = stored
        setRecoveredDraft(stored)
      }
    }
    setDraftReady(true)
  }, [item.taskKey])

  useEffect(
    () =>
      window.remember.onAgentTurnUpdate((update) => {
        setPendingTurn((current) => mergePendingAgentTurn(current, update))
      }),
    []
  )

  useEffect(() => {
    const container = scrollContainerRef.current
    const content = container?.firstElementChild
    setShowLatestMessage(false)
    if (selectedTab !== 1 || !container || !content) return
    followMessagesRef.current = true
    const follow = () => {
      if (followMessagesRef.current) container.scrollTop = container.scrollHeight
    }
    follow()
    const observer = new ResizeObserver(follow)
    observer.observe(content)
    observer.observe(container)
    return () => observer.disconnect()
  }, [selectedTab])

  function scrollToLatestMessage() {
    followMessagesRef.current = true
    const container = scrollContainerRef.current
    if (container) container.scrollTop = container.scrollHeight
    setShowLatestMessage(false)
  }

  async function stopAgent() {
    if (!legacyAgent || !activeTurnId || !canStop || stoppingTurnId === activeTurnId) return
    setStoppingTurnId(activeTurnId)
    setError(null)
    try {
      await window.remember.cancelAgentTurn(activeTurnId)
    } catch {
      setStoppingTurnId(null)
      setError(t('De worker kon niet worden gestopt.'))
    }
  }

  async function persistTaskDrafts() {
    while (true) {
      const draft = { ...draftRef.current, title: draftRef.current.title.trim() }
      if (!draft.title) return false
      if (sameInboxTaskDraft(draft, savedDraftRef.current)) return true

      const updated = await window.remember.updateWorkItem(item.taskKey, draft)
      savedDraftRef.current = draft
      local.upsertWorkItem(updated)
    }
  }

  async function saveTask() {
    if (savePromiseRef.current) return savePromiseRef.current
    setError(null)
    const savePromise = persistTaskDrafts().catch(() => {
      setError(t('Het actiepunt kon niet worden opgeslagen.'))
      return false
    })
    savePromiseRef.current = savePromise
    try {
      const saved = await savePromise
      if (saved && !recoveredDraftRef.current && sameInboxTaskDraft(draftRef.current, savedDraftRef.current)) {
        removeStoredInboxDraft(item.taskKey)
      }
      return saved
    } finally {
      savePromiseRef.current = null
    }
  }

  saveTaskRef.current = saveTask

  function changeTitle(value: string) {
    if (recoveredDraftRef.current) discardRecoveredDraft()
    const nextTitle = value.replace(/[\r\n]/g, '')
    draftRef.current = { ...draftRef.current, title: nextTitle }
    setTitle(nextTitle)
  }

  function changeDescription(value: string) {
    if (recoveredDraftRef.current) discardRecoveredDraft()
    draftRef.current = { ...draftRef.current, description: value }
    setDescription(value)
  }

  const draftRevision = `${title}\u0000${description}`
  useEffect(() => {
    if (!draftRevision) return
    if (sameInboxTaskDraft(draftRef.current, savedDraftRef.current) || !draftRef.current.title.trim()) return
    const timeout = window.setTimeout(() => void saveTaskRef.current?.(), 700)
    return () => window.clearTimeout(timeout)
  }, [draftRevision])

  useEffect(() => {
    if (!draftReady || recoveredDraft) return
    const pendingDraft = { title, description }
    if (sameInboxTaskDraft(pendingDraft, savedDraftRef.current)) {
      removeStoredInboxDraft(item.taskKey)
      return
    }
    const timeout = window.setTimeout(
      () =>
        writeStoredInboxDraft(item.taskKey, {
          baseSignature: inboxDraftSignature(savedDraftRef.current),
          ...pendingDraft,
        }),
      150
    )
    return () => window.clearTimeout(timeout)
  }, [description, draftReady, item.taskKey, recoveredDraft, title])

  useEffect(() => {
    const persistPendingDraft = () => {
      if (sameInboxTaskDraft(draftRef.current, savedDraftRef.current)) return
      writeStoredInboxDraft(item.taskKey, {
        baseSignature: inboxDraftSignature(savedDraftRef.current),
        ...draftRef.current,
      })
    }
    window.addEventListener('beforeunload', persistPendingDraft)
    return () => {
      window.removeEventListener('beforeunload', persistPendingDraft)
      persistPendingDraft()
    }
  }, [item.taskKey])

  function restoreRecoveredDraft() {
    if (!recoveredDraft) return
    const restored = { title: recoveredDraft.title, description: recoveredDraft.description }
    draftRef.current = restored
    recoveredDraftRef.current = null
    setTitle(restored.title)
    setDescription(restored.description)
    setRecoveredDraft(null)
    writeStoredInboxDraft(item.taskKey, {
      baseSignature: inboxDraftSignature(savedDraftRef.current),
      ...restored,
    })
  }

  function discardRecoveredDraft() {
    recoveredDraftRef.current = null
    setRecoveredDraft(null)
    removeStoredInboxDraft(item.taskKey)
  }

  async function removeTask() {
    const failed = await onSetLifecycle([item], 'abandoned')
    if (!failed.includes(item.taskKey)) removeStoredInboxDraft(item.taskKey)
  }

  return (
    <>
      <InboxPageHeader
        item={item}
        showDetailOnNarrow={showOnNarrow}
        showCompleted={showCompleted}
        onShowCompletedChange={onShowCompletedChange}
        agentRunning={legacyAgent && (item.workItem.attention === 'agent_running' || pendingTurn?.status === 'working')}
        agentProvider={pendingTurn?.provider ?? item.workItem.agentSessions.at(-1)?.provider ?? defaultProvider}
        onRemove={item.workItem.lifecycle === 'open' ? () => void removeTask() : undefined}
        onCreate={onCreate}
      />
      <article
        className={twMerge(
          'relative min-h-0 min-w-0 flex-col overflow-hidden',
          showOnNarrow ? 'flex' : 'hidden md:flex'
        )}
      >
        <TabGroup selectedIndex={selectedTab} onChange={setActiveTab} className="flex min-h-0 flex-1 flex-col">
          {hasWorker ? (
            <TabList
              aria-label={t('Taakonderdelen')}
              className="flex shrink-0 gap-1 overflow-x-auto border-slate-200 border-b px-3 py-2 [scrollbar-width:none]"
            >
              {[t('Taak'), t('Chat'), ...(artifact ? [t('Resultaat')] : [])].map((label, index) => (
                <Tab
                  key={label}
                  className="flex h-7 shrink-0 items-center gap-2 rounded-md px-2 text-sm text-slate-500 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-slate-400 data-selected:bg-slate-100 data-selected:text-slate-900"
                >
                  {label}
                  {index === 1 && agentBusy ? <Spinner size="xs" /> : null}
                </Tab>
              ))}
            </TabList>
          ) : null}
          <div
            ref={scrollContainerRef}
            onScroll={(event) => {
              if (selectedTab !== 1) return
              const container = event.currentTarget
              const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 64
              followMessagesRef.current = nearBottom
              setShowLatestMessage(!nearBottom)
            }}
            className="inbox-detail-scrollbar custom-scrollbar custom-scrollbar-auto-gutter min-h-0 flex-1 overflow-y-auto overscroll-contain"
          >
            <div className="mx-auto w-full max-w-[720px] px-4 pt-4 pb-5 sm:px-6">
              <TabPanels>
                <TabPanel unmount={false}>
                  <div className="flex items-start gap-2">
                    <IconButton
                      onClick={() => window.history.pushState(null, '', '/inbox/')}
                      aria-label={t('Terug naar Inbox')}
                      size="compact"
                      className="-ml-1 md:hidden"
                    >
                      <IconArrowLeft className="size-4" aria-hidden="true" />
                    </IconButton>
                    <label htmlFor="inbox-task-title" className="sr-only">
                      {t('Titel van actiepunt')}
                    </label>
                    <textarea
                      id="inbox-task-title"
                      rows={1}
                      value={title}
                      maxLength={120}
                      onChange={(event) => changeTitle(event.target.value)}
                      onBlur={() => void saveTask()}
                      className="block min-w-0 flex-1 resize-none overflow-hidden bg-transparent font-semibold text-xl text-slate-950 leading-7 tracking-[-0.02em] outline-none placeholder:text-slate-300 [field-sizing:content]"
                    />
                    {!title.trim() ? (
                      <span className="mt-1 shrink-0 px-1 text-danger-700 text-xs">{t('Voeg een titel toe')}</span>
                    ) : null}
                  </div>

                  <section className="mt-3">
                    <label htmlFor="inbox-task-description" className="sr-only">
                      {t('Beschrijving van actiepunt')}
                    </label>
                    <textarea
                      id="inbox-task-description"
                      rows={2}
                      value={description}
                      onChange={(event) => changeDescription(event.target.value)}
                      onBlur={() => void saveTask()}
                      placeholder={t('Voeg een beschrijving toe…')}
                      className="block min-h-12 w-full resize-none overflow-hidden bg-transparent text-slate-700 text-ui leading-6 outline-none placeholder:text-slate-300 [field-sizing:content]"
                    />
                  </section>

                  {recoveredDraft ? (
                    <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-950 text-sm">
                      <p className="font-medium">{t('Er staat een ouder lokaal concept klaar.')}</p>
                      <p className="mt-0.5 text-amber-800 text-xs">
                        {t('Het actiepunt is intussen gewijzigd. Kies welke versie je wilt houden.')}
                      </p>
                      <div className="mt-2 flex gap-2">
                        <Button size="small" variant="outline" color="secondary" onClick={discardRecoveredDraft}>
                          {t('Concept verwijderen')}
                        </Button>
                        <Button size="small" onClick={restoreRecoveredDraft}>
                          {t('Concept gebruiken')}
                        </Button>
                      </div>
                    </div>
                  ) : null}

                  <InboxActivity key={`${item.taskKey}:${activityVisible}`} item={item} autoOpen={firstVisit} />
                </TabPanel>
                {hasWorker ? (
                  <TabPanel>
                    {!turns.length && !pendingTurn ? (
                      <p className="text-slate-500 text-sm">
                        {agentBusy
                          ? t('De worker is bezig. Het resultaat wordt hier bewaard.')
                          : t('Pak de taak op om de worker te starten.')}
                      </p>
                    ) : null}
                    {turns.length || pendingTurn ? (
                      <AgentThread turns={turns} pendingTurn={pendingTurn} dateLocale={dateLocale} />
                    ) : null}
                    <AgentWorkerControls
                      requests={interactions.requests}
                      error={interactions.error}
                      onRefresh={interactions.refresh}
                    />
                  </TabPanel>
                ) : null}
                {artifact ? (
                  <TabPanel>
                    <InboxOutcome title={title} sessions={item.workItem.agentSessions} />
                  </TabPanel>
                ) : null}
              </TabPanels>

              {error ? (
                <p className="mt-4 text-danger-700 text-xs" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
          </div>

          {(selectedTab === 1 && showLatestMessage) || (agentBusy && legacyAgent) ? (
            <div className="mx-auto flex w-full max-w-[720px] shrink-0 flex-wrap items-center gap-2 px-4 pb-4 sm:px-6">
              {selectedTab === 1 && showLatestMessage ? (
                <Button size="small" variant="outline" color="secondary" onClick={scrollToLatestMessage}>
                  <IconArrowDown className="size-3.5" aria-hidden="true" />
                  {t('Nieuwste bericht')}
                </Button>
              ) : null}
              {agentBusy && legacyAgent ? (
                <Button
                  size="small"
                  variant="outline"
                  disabled={!canStop || Boolean(stoppingTurnId)}
                  onClick={() => void stopAgent()}
                >
                  <IconStop className="size-3.5" aria-hidden="true" />
                  {t('Stop')}
                </Button>
              ) : null}
            </div>
          ) : null}
        </TabGroup>
      </article>
    </>
  )
}

function InboxActivity({ item, autoOpen }: { item: InboxTaskItem; autoOpen: boolean }) {
  const { dateLocale, t } = useI18n()
  const [disclosureVersion, setDisclosureVersion] = useState(0)
  const autoOpenedRef = useRef(autoOpen)
  const events = inboxTaskEvents(item).toReversed()
  const eventReasons = new Set(events.map((event) => event.reason.trim()).filter(Boolean))
  const returnPoint = inboxReturnPoint(item)
  const contextEntries =
    item.workItem.lifecycle === 'open'
      ? [
          {
            id: 'next-move',
            kind: 'next' as const,
            label: t('Volgende stap'),
            detail: returnPoint.nextMove,
          },
          {
            id: 'unresolved',
            kind: 'open' as const,
            label: t('Nog open'),
            detail: returnPoint.unresolved,
          },
          {
            id: 'last-move',
            kind: 'done' as const,
            label: t('Waar je bleef'),
            detail: returnPoint.lastMove,
          },
        ].filter((entry) => entry.detail && !eventReasons.has(entry.detail.trim()))
      : []
  const entries = [
    ...contextEntries.map((entry) => ({ ...entry, event: null })),
    ...events.map((event) => ({ id: event.id, kind: 'event' as const, label: '', detail: '', event })),
  ]

  useEffect(() => {
    if (!autoOpen || autoOpenedRef.current) return
    autoOpenedRef.current = true
    setDisclosureVersion((current) => current + 1)
  }, [autoOpen])

  if (!entries.length) return null

  return (
    <section className="mt-6 border-black/[0.06] border-t pt-3" aria-label={t('Activiteit')}>
      <Disclosure key={disclosureVersion} defaultOpen={autoOpen || autoOpenedRef.current}>
        {({ open }) => (
          <>
            <h2>
              <DisclosureButton className="group -mx-1.5 flex h-7 items-center gap-1.5 rounded-md px-1.5 font-medium text-slate-600 text-xs outline-none transition-colors duration-150 hover:bg-slate-50 hover:text-slate-800 focus-visible:ring-2 focus-visible:ring-slate-400 motion-reduce:transition-none">
                {t('Activiteit')}
                <IconChevronRight
                  className={twMerge('size-3 text-slate-500 transition-transform duration-150', open && 'rotate-90')}
                  aria-hidden="true"
                />
              </DisclosureButton>
            </h2>
            <DisclosurePanel>
              <ol className="mt-3">
                {entries.map((entry, index) => (
                  <li key={entry.id} className="relative grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2.5 pb-3 last:pb-0">
                    {index < entries.length - 1 ? (
                      <span aria-hidden="true" className="absolute top-5 bottom-0 left-[11.5px] w-px bg-slate-200" />
                    ) : null}
                    <span className="relative z-10 flex size-6 items-center justify-center bg-white text-slate-500">
                      {entry.event ? <ActivityIcon event={entry.event} /> : <ActivityContextIcon kind={entry.kind} />}
                    </span>
                    <div className="min-w-0 pt-0.5">
                      {entry.event ? (
                        <p className="text-slate-600 text-sm leading-5">
                          {entry.event.type === 'created' ? (
                            <InboxCreatedActivity item={item} event={entry.event} />
                          ) : (
                            activityLabel(entry.event, t)
                          )}{' '}
                          <time
                            className="whitespace-nowrap text-slate-500 text-xs tabular-nums"
                            dateTime={new Date(entry.event.at).toISOString()}
                          >
                            · {formatActivityTime(entry.event.at, dateLocale)}
                          </time>
                        </p>
                      ) : (
                        <p className="text-pretty text-slate-700 text-sm leading-5">
                          <span className="font-medium text-slate-500">{entry.label}:</span> {entry.detail}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </DisclosurePanel>
          </>
        )}
      </Disclosure>
    </section>
  )
}

function InboxCreatedActivity({ item, event }: { item: InboxTaskItem; event: InboxActivityEvent }) {
  const { t } = useI18n()
  const source = inboxOriginSource(item)
  const href = inboxSourceHref(item)
  if (!source || !href) return activityLabel(event, t)

  const label = source.label.trim() || t(source.kind === 'meeting' ? 'Gesprek' : 'Tijdlijn')
  const description =
    event.actor === 'user'
      ? t('Door jou toegevoegd vanuit')
      : source.kind === 'meeting'
        ? t('Remember herkende dit als actiepunt in het gesprek')
        : t('Remember herkende dit als actiepunt vanuit')

  return (
    <>
      {description}{' '}
      <Link
        href={href}
        className="rounded-sm underline decoration-slate-300 underline-offset-2 hover:text-slate-900 hover:decoration-slate-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
      >
        {label}
      </Link>
    </>
  )
}

function ActivityContextIcon({ kind }: { kind: 'next' | 'open' | 'done' }) {
  if (kind === 'next') return <IconArrowRight className="size-3.5" aria-hidden="true" />
  if (kind === 'open') return <IconCircleDashed className="size-3.5" aria-hidden="true" />
  return <IconCheckmark1Small className="size-4" aria-hidden="true" />
}

type PendingAgentTurn = {
  id: string
  provider: AgentProvider
  at: number
  message: string
  status: 'working' | 'complete' | 'error' | 'cancelled'
  response?: string
  durationMs?: number
  steps: AgentTurnStep[]
}

function mergePendingAgentTurn(current: PendingAgentTurn | null, update: AgentTurnUpdate) {
  if (current?.status !== 'working' || current.id !== update.turnId || current.provider !== update.provider)
    return current
  if (update.type === 'response') return { ...current, response: update.text }
  const text = update.text.trim()
  if (!text) return current
  const existing = current.steps.findIndex((step) => step.id === update.id)
  const step: AgentTurnStep = { id: update.id, kind: update.type, text, at: update.at }
  return {
    ...current,
    steps:
      existing >= 0
        ? current.steps.map((candidate, index) => (index === existing ? { ...step, at: candidate.at } : candidate))
        : [...current.steps, step],
  }
}

function AgentThread({
  turns,
  pendingTurn,
  dateLocale,
}: {
  turns: InboxAgentTurn[]
  pendingTurn: PendingAgentTurn | null
  dateLocale: string
}) {
  const { t } = useI18n()
  const entries: PendingAgentTurn[] = [
    ...turns.map((turn) => (pendingTurn?.id === turn.id ? pendingTurn : turn)),
    ...(pendingTurn && !turns.some((turn) => turn.id === pendingTurn.id) ? [pendingTurn] : []),
  ]

  return (
    <section className="min-w-0 scroll-mt-5" aria-label={t('Agentgesprek')}>
      <ol className="space-y-7">
        {entries.map((turn, index) => (
          <li key={turn.id} className="min-w-0">
            {index === 0 || !sameLocalDay(entries[index - 1]?.at, turn.at) ? (
              <p className="mb-5 text-center text-slate-500 text-xs">{formatThreadTimestamp(turn.at, dateLocale)}</p>
            ) : null}
            <div className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap wrap-anywhere rounded-xl bg-slate-100 px-3 py-2 text-slate-800 text-ui leading-5">
              {turn.message}
            </div>
            <div className="mt-4 max-w-[42rem]">
              <Disclosure>
                {({ open }) => (
                  <>
                    <DisclosureButton className="group -ml-2 flex min-h-7 items-center gap-1.5 rounded-md px-2 text-left font-medium text-slate-500 text-xs outline-none transition-colors hover:bg-slate-50 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-slate-400">
                      {turn.status === 'working' ? (
                        <span className="size-1.5 animate-pulse rounded-full bg-slate-400 motion-reduce:animate-none" />
                      ) : null}
                      <span>
                        {turn.status === 'working'
                          ? t('{provider} werkt', { provider: providerName(turn.provider) })
                          : turn.status === 'complete'
                            ? t('Werkte {duration}', { duration: formatDuration(turn.durationMs ?? 0) })
                            : turn.status === 'cancelled'
                              ? t('Gestopt')
                              : t('{provider} kon niet antwoorden', { provider: providerName(turn.provider) })}
                      </span>
                      <IconChevronRight
                        className={twMerge('size-3 transition-transform', open && 'rotate-90')}
                        aria-hidden="true"
                      />
                    </DisclosureButton>
                    <DisclosurePanel className="mt-2 max-w-[38rem] pl-1">
                      <ol className="space-y-2">
                        {(turn.steps.length
                          ? turn.steps
                          : turn.status === 'working'
                            ? [
                                {
                                  id: `${turn.id}-fallback`,
                                  kind: 'status' as const,
                                  text: t('Opdracht begrijpen'),
                                  at: turn.at,
                                },
                              ]
                            : []
                        ).map((step) => (
                          <li key={step.id}>
                            {step.kind === 'reasoning' ? (
                              <p className="border-slate-200 border-l-2 pl-3 whitespace-pre-wrap text-slate-500 text-ui leading-5">
                                {step.text}
                              </p>
                            ) : (
                              <p className="text-slate-500 text-ui leading-5">{step.text}</p>
                            )}
                          </li>
                        ))}
                      </ol>
                    </DisclosurePanel>
                  </>
                )}
              </Disclosure>
              {turn.response ? (
                <MarkdownContent className={twMerge(compactMarkdownContentClassName, 'mt-2 min-w-0 wrap-anywhere')}>
                  {turn.response}
                </MarkdownContent>
              ) : turn.status === 'error' ? (
                <p className="mt-2 text-danger-700 text-ui">{t('Er is geen antwoord ontvangen.')}</p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

function providerName(provider: AgentProvider) {
  return provider === 'claude' ? 'Claude' : 'Codex'
}

function sameLocalDay(left: number | undefined, right: number) {
  if (left == null) return false
  const first = new Date(left)
  const second = new Date(right)
  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  )
}

function formatThreadTimestamp(timestamp: number, locale: string) {
  const date = new Date(timestamp)
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date)
  if (isLocalToday(timestamp)) return `${locale.startsWith('nl') ? 'Vandaag' : 'Today'}, ${time}`
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function formatDuration(durationMs: number) {
  if (durationMs < 1_000) return '<1 sec'
  return `${Math.max(1, Math.round(durationMs / 1_000))} sec`
}

function ActivityIcon({ event }: { event: InboxActivityEvent }) {
  if (event.observation) return <IconBubbleSparkle className="size-3.5" aria-hidden="true" />
  if (event.type === 'delegated') return <IconBubbleSparkle className="size-3.5" aria-hidden="true" />
  if (event.type === 'completed') return <IconCheckmark1Small className="size-4" aria-hidden="true" />
  if (event.type === 'revised' || event.type === 'superseded') {
    return <IconPencil className="size-3.5" aria-hidden="true" />
  }
  return <IconArrowInbox className="size-3.5" aria-hidden="true" />
}

function InboxOriginMark({
  item,
  compact = false,
  decorative = false,
}: {
  item: InboxTaskItem
  compact?: boolean
  decorative?: boolean
}) {
  const { t } = useI18n()
  const source = inboxOriginSource(item)
  const kind = source?.kind ?? 'legacy'
  const iconClass = compact ? 'size-3.5' : 'size-4'
  return (
    <span
      className={twMerge(
        'relative flex shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600 shadow-inset',
        compact ? 'size-7' : 'size-8'
      )}
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : t('Herkomst: {source}', { source: source?.label || t('Dagoverzicht') })}
    >
      {kind === 'meeting' ? (
        <IconBubbles className={iconClass} aria-hidden="true" />
      ) : kind === 'observed' ? (
        <IconWindowCursor className={iconClass} aria-hidden="true" />
      ) : kind === 'manual' ? (
        <IconPencil className={iconClass} aria-hidden="true" />
      ) : (
        <IconArrowInbox className={iconClass} aria-hidden="true" />
      )}
    </span>
  )
}

function inboxOriginSentence(item: InboxTaskItem) {
  const source = inboxOriginSource(item)
  return (
    source?.detail || source?.label || item.workItem.context || item.workItem.description || 'Herkend als open werk.'
  )
}

function formatActivityTime(timestamp: number, locale: string) {
  const date = new Date(timestamp)
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date)
  if (isLocalToday(timestamp)) return time
  const day = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(date)
  return `${day}, ${time}`
}

function activityLabel(
  event: InboxActivityEvent,
  t: (key: string, replacements?: Record<string, string | number>) => string
) {
  if (event.observation) return t('Remember zag voortgang: {summary}', { summary: event.reason })
  if (event.type === 'created') {
    return event.actor === 'user' ? t('Door jou toegevoegd aan Inbox') : t('Remember herkende dit als open actiepunt')
  }
  if (event.type === 'delegated') {
    return t('Aan {provider} gestuurd', { provider: event.provider === 'claude' ? 'Claude' : 'Codex' })
  }
  if (event.type === 'completed') return t('Als afgerond gemarkeerd')
  if (event.type === 'reopened') return t('Opnieuw geopend')
  if (event.type === 'revised') return t('Actiepunt bijgewerkt')
  if (event.type === 'superseded') return t('Actiepunt vervangen')
  return event.reason
}
