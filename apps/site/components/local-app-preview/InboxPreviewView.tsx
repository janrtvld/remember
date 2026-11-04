'use client'

import type { WorkItem } from '@remember/shared'
import {
  Archive as IconArchiveJunk,
  Inbox as IconArrowInbox,
  ArrowRight as IconArrowRight,
  ArrowUp as IconArrowUp,
  Box as IconBox2,
  MessagesSquare as IconBubbles,
  Check as IconCheckmark1Small,
  ChevronDown as IconChevronDownSmall,
  ChevronRight as IconChevronRight,
  CircleDashed as IconCircleDashed,
  X as IconCrossSmall,
  Pencil as IconPencil,
  Plus as IconPlusSmall,
  AppWindow as IconWindowCursor,
} from 'lucide-react'
import Image from 'next/image'
import type { KeyboardEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import { createManualPreviewWorkItem, createPreviewInboxItems } from './inboxFixtures'
import { formatInboxRelativeTime, inboxReturnPoint, inboxTasks, selectedInboxTask } from './inboxPreviewModel'
import { usePreviewText } from './locale'

function itemSource(item: WorkItem) {
  return item.sources.reduce<WorkItem['sources'][number] | null>(
    (origin, source) => (!origin || source.observedAt < origin.observedAt ? source : origin),
    null
  )
}

export function InboxPreviewView({ onOpenSource }: { onOpenSource: (kind: 'meeting' | 'observed') => void }) {
  const { locale, t } = usePreviewText()
  const [workItems, setWorkItems] = useState(() => createPreviewInboxItems(locale))
  const [createOpen, setCreateOpen] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [showCompleted, setShowCompleted] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>('meeting-flow')
  const [readIds, setReadIds] = useState(() => new Set(['meeting-flow', 'manual-support']))
  const [composer, setComposer] = useState('')
  const [selectedProject, setSelectedProject] = useState('')
  const [agentState, setAgentState] = useState<'idle' | 'working' | 'sent'>('idle')
  const agentTimer = useRef<number | null>(null)
  const createTriggerRef = useRef<HTMLButtonElement>(null)
  const createDialogRef = useRef<HTMLDialogElement>(null)
  const selectedTitleRef = useRef<HTMLTextAreaElement>(null)
  const visibleTasks = inboxTasks(workItems, showCompleted)
  const selectedTask = selectedInboxTask(visibleTasks, selectedId) ?? visibleTasks[0] ?? null
  const selected = selectedTask?.workItem ?? null

  useEffect(
    () => () => {
      if (agentTimer.current) window.clearTimeout(agentTimer.current)
    },
    []
  )

  function updateItem(id: string, update: (item: WorkItem) => WorkItem) {
    setWorkItems((current) => current.map((item) => (item.id === id ? update(item) : item)))
  }

  function resetAgentComposer() {
    if (agentTimer.current) window.clearTimeout(agentTimer.current)
    agentTimer.current = null
    setComposer('')
    setSelectedProject('')
    setAgentState('idle')
  }

  function selectItem(id: string) {
    resetAgentComposer()
    setSelectedId(id)
    setReadIds((current) => (current.has(id) ? current : new Set(current).add(id)))
  }

  function selectNextItem(id: string) {
    const next = visibleTasks.find((item) => item.taskKey !== id) ?? null
    resetAgentComposer()
    setSelectedId(next?.taskKey ?? null)
    if (next) setReadIds((current) => (current.has(next.taskKey) ? current : new Set(current).add(next.taskKey)))
  }

  function setItemCompleted(id: string, nextCompleted: boolean) {
    updateItem(id, (item) => ({
      ...item,
      lifecycle: nextCompleted ? 'completed' : 'open',
      status: nextCompleted ? item.status : 'todo',
      closedAt: nextCompleted ? Date.now() : null,
    }))
    if (nextCompleted && !showCompleted && selected?.id === id) selectNextItem(id)
  }

  function toggleShowCompleted() {
    const next = !showCompleted
    setShowCompleted(next)
    if (!next && selected?.lifecycle !== 'open') {
      const firstOpen = inboxTasks(workItems)[0] ?? null
      resetAgentComposer()
      setSelectedId(firstOpen?.taskKey ?? null)
    }
  }

  function openCreateDialog() {
    setNewTitle('')
    setNewDescription('')
    setCreateOpen(true)
  }

  function closeCreateDialog({ restoreFocus = true } = {}) {
    setCreateOpen(false)
    if (restoreFocus) window.requestAnimationFrame(() => createTriggerRef.current?.focus())
  }

  function handleCreateDialogKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeCreateDialog()
      return
    }
    if (event.key !== 'Tab') return
    const dialog = createDialogRef.current
    if (!dialog) return
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    )
    const first = focusable.at(0)
    const last = focusable.at(-1)
    if (!first || !last) return
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  function createItem() {
    const title = newTitle.trim()
    if (!title) return
    const item = createManualPreviewWorkItem(locale, {
      id: `manual-${Date.now()}`,
      title,
      description: newDescription.trim(),
    })
    setWorkItems((current) => [item, ...current])
    resetAgentComposer()
    setSelectedId(item.id)
    setReadIds((current) => new Set(current).add(item.id))
    closeCreateDialog({ restoreFocus: false })
    window.requestAnimationFrame(() => selectedTitleRef.current?.focus())
  }

  function archiveSelected() {
    if (!selected) return
    updateItem(selected.id, (item) => ({ ...item, lifecycle: 'abandoned', closedAt: Date.now() }))
    selectNextItem(selected.id)
  }

  function updateContent(field: 'title' | 'description', value: string) {
    if (!selected) return
    updateItem(selected.id, (item) => ({
      ...item,
      [field]: value,
      ...(field === 'title' ? { userEditedTitle: true } : { userEditedDescription: true }),
    }))
  }

  function submitAgentTask() {
    if (!composer.trim() || agentState === 'working') return
    if (agentTimer.current) window.clearTimeout(agentTimer.current)
    setComposer('')
    setAgentState('working')
    agentTimer.current = window.setTimeout(() => {
      setAgentState('sent')
      agentTimer.current = null
    }, 700)
  }

  const selectedTitle = selected?.title ?? ''
  const selectedDescription = selected?.description ?? ''
  const selectedClosed = selected ? selected.lifecycle !== 'open' : false
  const selectedSource = selected ? itemSource(selected) : null
  const selectedSourceType =
    selectedSource?.kind === 'meeting'
      ? t('Gesprek', 'Conversation')
      : selectedSource?.kind === 'observed'
        ? t('Tijdlijn', 'Timeline')
        : selectedSource?.kind === 'manual'
          ? t('Handmatig toegevoegd', 'Added manually')
          : t('Dagoverzicht', 'Day overview')
  const selectedReturnPoint = selectedTask ? inboxReturnPoint(selectedTask) : null
  return (
    <>
      <div className="flex min-h-full grow flex-col overflow-hidden" inert={createOpen ? true : undefined}>
        <header
          className={`grid min-h-[43px] shrink-0 ${selected ? 'grid-cols-[minmax(17rem,21rem)_minmax(0,1fr)]' : ''}`}
        >
          <div
            className={`flex min-h-[43px] min-w-0 items-center border-b border-slate-200 pl-3 pr-2.5 ${selected ? 'border-r' : ''}`}
          >
            <nav aria-label={t('Kruimelpad', 'Breadcrumb')} className="min-w-0 flex-1 overflow-hidden">
              <ol className="flex min-w-0 items-center text-slate-800 text-sm">
                <li className="shrink-0">
                  <span aria-current="page" className="flex h-7 items-center px-2 font-medium">
                    Inbox
                  </span>
                </li>
              </ol>
            </nav>
            <button
              type="button"
              aria-label={
                showCompleted
                  ? t('Alleen open taken tonen', 'Show open tasks only')
                  : t('Alle taken tonen', 'Show all tasks')
              }
              aria-pressed={showCompleted}
              onClick={toggleShowCompleted}
              className={`ml-1 flex size-7 shrink-0 items-center justify-center rounded-md outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-slate-400 ${showCompleted ? 'bg-blue-100 text-blue-700' : 'text-slate-500'}`}
            >
              <IconBox2 className="size-4" />
            </button>
            <button
              ref={createTriggerRef}
              type="button"
              aria-label={t('Nieuw actiepunt', 'New action item')}
              onClick={openCreateDialog}
              className="ml-1 flex size-7 shrink-0 items-center justify-center rounded-md text-slate-500 outline-none hover:bg-slate-100 hover:text-slate-800 focus-visible:ring-2 focus-visible:ring-slate-400"
            >
              <IconPlusSmall className="size-4" />
            </button>
          </div>
          {selected ? (
            <div className="flex min-h-[43px] min-w-0 items-center border-b border-slate-200 px-3">
              <span className="min-w-0 flex-1 truncate px-2 font-medium text-slate-800 text-sm">{selectedTitle}</span>
              {selectedSource?.kind === 'meeting' || selectedSource?.kind === 'observed' ? (
                <button
                  type="button"
                  onClick={() => onOpenSource(selectedSource.kind === 'meeting' ? 'meeting' : 'observed')}
                  className="mr-2 flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 font-medium text-slate-500 text-xs outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-slate-400"
                >
                  {selectedSource.kind === 'meeting'
                    ? t('Open gesprek', 'Open conversation')
                    : t('Open tijdlijn', 'Open timeline')}
                  <IconArrowUp className="size-3 rotate-45" />
                </button>
              ) : null}
              {!selectedClosed ? (
                <button
                  type="button"
                  onClick={archiveSelected}
                  aria-label={t(`Markeer ${selectedTitle} als niet nodig`, `Mark ${selectedTitle} as not needed`)}
                  className="flex size-7 shrink-0 items-center justify-center rounded-md text-slate-500 outline-none hover:bg-slate-100 hover:text-slate-800 focus-visible:ring-2 focus-visible:ring-slate-400"
                >
                  <IconArchiveJunk className="size-4" />
                </button>
              ) : null}
            </div>
          ) : null}
        </header>
        {selected ? (
          <div className="grid min-h-0 grow grid-cols-[minmax(17rem,21rem)_minmax(0,1fr)] bg-white">
            <section
              aria-label="Inbox"
              className="custom-scrollbar custom-scrollbar-auto-gutter flex min-h-0 min-w-0 flex-col overflow-y-auto border-r border-black/[0.07]"
            >
              <ol className="ml-px min-w-0 divide-y divide-black/[0.05]">
                {visibleTasks.map(({ workItem: item }) => {
                  const active = item.id === selected.id
                  const completedItem = item.lifecycle === 'completed'
                  const closedItem = item.lifecycle !== 'open'
                  const source = itemSource(item)
                  const unread = source?.kind !== 'manual' && !readIds.has(item.id)
                  return (
                    <li key={item.id} className="group relative min-w-0">
                      <button
                        type="button"
                        onClick={() => selectItem(item.id)}
                        aria-current={active ? 'true' : undefined}
                        className={`relative grid min-h-[54px] w-full min-w-0 grid-cols-[2rem_minmax(0,1fr)] items-center gap-3 px-4 py-3 text-left outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-400 motion-reduce:transition-none ${active ? 'bg-slate-100/80' : 'hover:bg-slate-50 active:bg-slate-100'}`}
                      >
                        <InboxPreviewOriginMark item={item} />
                        <span className="grid min-w-0 gap-0.5 self-center pr-7">
                          <span className="flex min-w-0 items-center gap-2">
                            {unread ? (
                              <>
                                <span className="size-2 shrink-0 rounded-full bg-blue-700" aria-hidden="true" />
                                <span className="sr-only">{t('Ongelezen', 'Unread')}</span>
                              </>
                            ) : null}
                            <span
                              className={`block min-w-0 truncate font-medium text-[13px] leading-[17px] ${completedItem ? 'text-slate-500 line-through decoration-slate-300' : 'text-slate-900'}`}
                            >
                              {item.title}
                            </span>
                          </span>
                          <span className="mt-px block truncate text-slate-600 text-xs leading-4">
                            {source?.detail ?? ''}
                          </span>
                        </span>
                        <time className="absolute right-2.5 bottom-2.5 w-6 text-center text-slate-600 text-xs leading-4 tabular-nums">
                          {formatInboxRelativeTime(item.updatedAt)}
                        </time>
                      </button>
                      <button
                        type="button"
                        onClick={() => setItemCompleted(item.id, !closedItem)}
                        aria-label={
                          closedItem
                            ? t(`Heropen ${item.title}`, `Reopen ${item.title}`)
                            : t(`Markeer ${item.title} als afgerond`, `Mark ${item.title} as completed`)
                        }
                        className={`absolute top-1.5 right-2.5 z-10 flex size-7 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-slate-400 ${closedItem ? 'text-blue-700' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600'}`}
                      >
                        {closedItem ? (
                          <span className="flex size-[18px] items-center justify-center rounded-full bg-blue-700 text-white">
                            <IconCheckmark1Small className="size-3.5" />
                          </span>
                        ) : (
                          <IconCircleDashed className="size-4" />
                        )}
                      </button>
                    </li>
                  )
                })}
              </ol>
            </section>
            <article className="relative flex min-h-0 min-w-0 flex-col overflow-hidden">
              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-[720px] px-10 pt-6 pb-32">
                  <label htmlFor="preview-inbox-title" className="sr-only">
                    {t('Titel van actiepunt', 'Action point title')}
                  </label>
                  <textarea
                    ref={selectedTitleRef}
                    key={`title-${selected.id}`}
                    id="preview-inbox-title"
                    rows={1}
                    value={selectedTitle}
                    maxLength={120}
                    onChange={(event) => updateContent('title', event.target.value)}
                    className="block min-w-0 w-full resize-none overflow-hidden bg-transparent font-semibold text-xl text-slate-950 leading-7 tracking-[-0.02em] outline-none placeholder:text-slate-300 [field-sizing:content]"
                  />
                  <label htmlFor="preview-inbox-description" className="sr-only">
                    {t('Beschrijving van actiepunt', 'Action point description')}
                  </label>
                  <textarea
                    key={`description-${selected.id}`}
                    id="preview-inbox-description"
                    rows={2}
                    value={selectedDescription}
                    onChange={(event) => updateContent('description', event.target.value)}
                    className="mt-3 block min-h-12 w-full resize-none overflow-hidden bg-transparent text-slate-700 text-sm leading-6 outline-none placeholder:text-slate-300 [field-sizing:content]"
                  />

                  <section aria-label={t('Herkomst', 'Origin')} className="mt-6">
                    <div className="flex min-h-14 items-center gap-3 rounded-lg border border-black/[0.07] bg-white px-3 py-2.5">
                      <InboxPreviewOriginMark item={selected} compact decorative />
                      <span className="min-w-0 flex-1">
                        <span className="block text-slate-500 text-xs leading-4">{selectedSourceType}</span>
                        <span className="mt-0.5 block truncate font-medium text-slate-800 text-sm leading-5">
                          {selectedSource?.label ?? t('Dagoverzicht', 'Day overview')}
                        </span>
                      </span>
                    </div>
                  </section>

                  <InboxPreviewActivity
                    item={selected}
                    returnPoint={selectedReturnPoint}
                    includeContext={!selectedClosed}
                  />
                </div>
              </div>

              <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 pb-4">
                <div className="absolute inset-x-0 bottom-0 h-8 bg-white" />
                <div className="pointer-events-auto relative mx-auto w-full max-w-[720px] px-10">
                  <form
                    onSubmit={(event) => {
                      event.preventDefault()
                      submitAgentTask()
                    }}
                    className="relative w-full rounded-xl bg-white shadow-raised focus-within:shadow-raised-hover"
                  >
                    <label htmlFor="preview-inbox-agent" className="sr-only">
                      {t('Geef een agent een opdracht', 'Give an agent an instruction')}
                    </label>
                    <textarea
                      id="preview-inbox-agent"
                      rows={2}
                      value={composer}
                      disabled={agentState === 'working'}
                      onChange={(event) => {
                        setComposer(event.target.value)
                        setAgentState('idle')
                      }}
                      placeholder={t('Stuur een bericht…', 'Send a message…')}
                      className="block min-h-[54px] w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-slate-800 text-sm leading-5 outline-none placeholder:text-slate-500 disabled:cursor-wait disabled:text-slate-400"
                    />
                    <div className="flex min-h-10 items-center gap-1 px-2 pb-2">
                      <label className="relative flex h-7 max-w-44 min-w-0 items-center gap-1.5 rounded-md px-2 text-slate-600 outline-none hover:bg-slate-100 focus-within:ring-2 focus-within:ring-slate-400">
                        <Image
                          src="/brand/codex-monochrome.svg"
                          alt=""
                          width={16}
                          height={16}
                          className="pointer-events-none size-4 shrink-0 opacity-50"
                        />
                        <span className="sr-only">{t('Project kiezen', 'Choose project')}</span>
                        <select
                          value={selectedProject}
                          disabled={agentState === 'working'}
                          onChange={(event) => setSelectedProject(event.target.value)}
                          aria-label={t('Project kiezen', 'Choose project')}
                          className="min-w-0 flex-1 appearance-none bg-transparent pr-4 font-medium text-xs outline-none disabled:cursor-wait disabled:text-slate-400"
                        >
                          <option value="">{t('Project', 'Project')}</option>
                          <option value="none">{t('Geen project', 'No project')}</option>
                          <option value="Remember">Remember</option>
                          <option value="Website">{t('Website', 'Website')}</option>
                        </select>
                        <IconChevronDownSmall className="pointer-events-none absolute right-1.5 size-3 shrink-0 text-slate-400" />
                      </label>
                      <span className="ml-auto min-w-0 truncate px-1 text-slate-500 text-xs" aria-live="polite">
                        {agentState === 'working'
                          ? t('Codex werkt…', 'Codex is working…')
                          : agentState === 'sent'
                            ? t('Verstuurd naar Codex', 'Sent to Codex')
                            : ''}
                      </span>
                      <button
                        type="submit"
                        disabled={!composer.trim() || agentState === 'working'}
                        aria-label={t('Stuur naar Codex', 'Send to Codex')}
                        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-blue-700 text-white outline-none hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:bg-slate-100 disabled:text-slate-500"
                      >
                        <IconArrowUp className="size-4" />
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            </article>
          </div>
        ) : (
          <main className="flex min-h-80 grow flex-col items-center justify-center px-6 text-center">
            <p className="text-slate-500 text-sm">{t('Niets op je bord', 'Nothing on your plate')}</p>
            <button
              type="button"
              onClick={openCreateDialog}
              className="mt-4 flex h-8 items-center gap-1.5 rounded-lg bg-blue-700 px-3 font-medium text-white text-sm outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              <IconPlusSmall className="size-4" />
              {t('Nieuw actiepunt', 'New action item')}
            </button>
          </main>
        )}
      </div>
      {createOpen ? (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-slate-950/20 p-4 backdrop-blur-[1px]"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeCreateDialog()
          }}
        >
          <dialog
            ref={createDialogRef}
            open
            aria-modal="true"
            aria-labelledby="preview-new-action-point-title"
            className="relative m-0 flex max-h-[calc(100%_-_2rem)] w-full max-w-md flex-col overflow-hidden rounded-xl bg-white p-0 shadow-raised"
            onKeyDown={handleCreateDialogKeyDown}
          >
            <form
              onSubmit={(event) => {
                event.preventDefault()
                createItem()
              }}
              className="flex min-h-0 flex-1 flex-col"
            >
              <header className="flex min-h-14 shrink-0 items-center gap-3 border-black/[0.07] border-b px-5 py-3.5">
                <h2 id="preview-new-action-point-title" className="min-w-0 flex-1 font-semibold text-slate-950 text-md">
                  {t('Nieuw actiepunt', 'New action item')}
                </h2>
                <button
                  type="button"
                  onClick={() => closeCreateDialog()}
                  aria-label={t('Sluiten', 'Close')}
                  className="flex size-7 items-center justify-center rounded-md text-slate-500 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-slate-400"
                >
                  <IconCrossSmall className="size-4" />
                </button>
              </header>
              <div className="min-h-0 overflow-y-auto p-5">
                <label htmlFor="preview-new-action-point-name" className="sr-only">
                  {t('Titel', 'Title')}
                </label>
                <input
                  id="preview-new-action-point-name"
                  value={newTitle}
                  onChange={(event) => setNewTitle(event.target.value)}
                  maxLength={120}
                  autoFocus
                  placeholder={t('Titel van actiepunt', 'Action point title')}
                  className="block h-9 w-full bg-transparent font-semibold text-lg text-slate-950 outline-none placeholder:font-medium placeholder:text-slate-300"
                />
                <label htmlFor="preview-new-action-point-description" className="sr-only">
                  {t('Beschrijving', 'Description')}
                </label>
                <textarea
                  id="preview-new-action-point-description"
                  value={newDescription}
                  onChange={(event) => setNewDescription(event.target.value)}
                  rows={5}
                  placeholder={t('Beschrijving toevoegen…', 'Add a description…')}
                  className="mt-2 block min-h-28 w-full resize-none bg-transparent text-slate-700 text-sm leading-6 outline-none placeholder:text-slate-300"
                />
              </div>
              <footer className="flex shrink-0 justify-end gap-2 border-black/[0.07] border-t px-5 py-3.5">
                <button
                  type="button"
                  onClick={() => closeCreateDialog()}
                  className="h-8 rounded-lg px-3 font-medium text-slate-600 text-sm outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-slate-400"
                >
                  {t('Annuleer', 'Cancel')}
                </button>
                <button
                  type="submit"
                  disabled={!newTitle.trim()}
                  className="h-8 rounded-lg bg-blue-700 px-3 font-medium text-white text-sm outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:bg-slate-100 disabled:text-slate-400"
                >
                  {t('Toevoegen', 'Add')}
                </button>
              </footer>
            </form>
          </dialog>
        </div>
      ) : null}
    </>
  )
}

function InboxPreviewOriginMark({
  item,
  compact = false,
  decorative = false,
}: {
  item: WorkItem
  compact?: boolean
  decorative?: boolean
}) {
  const { t } = usePreviewText()
  const source = itemSource(item)
  const SourceIcon =
    source?.kind === 'meeting' ? IconBubbles : source?.kind === 'observed' ? IconWindowCursor : IconPencil
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600 shadow-inset ${compact ? 'size-7' : 'size-8'}`}
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : t(`Herkomst: ${source?.label ?? ''}`, `Origin: ${source?.label ?? ''}`)}
    >
      <SourceIcon className={compact ? 'size-3.5' : 'size-4'} />
    </span>
  )
}

type PreviewActivityEntry =
  | {
      id: string
      kind: 'next' | 'open' | 'done'
      label: string
      detail: string
      at: null
    }
  | {
      id: string
      kind: 'observed' | 'event'
      label: string
      detail: string
      at: number
    }

function InboxPreviewActivity({
  item,
  returnPoint,
  includeContext,
}: {
  item: WorkItem
  returnPoint: ReturnType<typeof inboxReturnPoint> | null
  includeContext: boolean
}) {
  const { locale, t } = usePreviewText()
  const history: PreviewActivityEntry[] = [
    ...item.observations
      .filter((observation) => observation.dismissedAt === null)
      .map((observation) => ({
        id: observation.id,
        kind: 'observed' as const,
        label: t('Remember zag voortgang', 'Remember saw progress'),
        detail: observation.summary,
        at: observation.observedAt,
      })),
    ...item.facts.map((fact) => ({
      id: fact.id,
      kind: 'event' as const,
      label: fact.summary,
      detail: '',
      at: fact.at,
    })),
  ].sort((left, right) => (right.at ?? 0) - (left.at ?? 0))
  const historyDetails = new Set(history.map((entry) => entry.detail.trim()).filter(Boolean))
  const context: PreviewActivityEntry[] =
    includeContext && returnPoint
      ? [
          {
            id: 'next-move',
            kind: 'next' as const,
            label: t('Volgende stap', 'Next step'),
            detail: returnPoint.nextMove,
            at: null,
          },
          {
            id: 'unresolved',
            kind: 'open' as const,
            label: t('Nog open', 'Still open'),
            detail: returnPoint.unresolved,
            at: null,
          },
          {
            id: 'last-move',
            kind: 'done' as const,
            label: t('Waar je bleef', 'Where you left off'),
            detail: returnPoint.lastMove,
            at: null,
          },
        ].filter((entry) => entry.detail && !historyDetails.has(entry.detail.trim()))
      : []
  const entries = [...context, ...history]
  if (!entries.length) return null

  return (
    <section className="mt-6 border-black/[0.06] border-t pt-3" aria-label={t('Activiteit', 'Activity')}>
      <details key={item.id} className="group">
        <summary className="-mx-1.5 flex h-7 cursor-pointer list-none items-center gap-1.5 rounded-md px-1.5 font-medium text-slate-600 text-xs outline-none hover:bg-slate-50 hover:text-slate-800 focus-visible:ring-2 focus-visible:ring-slate-400 [&::-webkit-details-marker]:hidden">
          {t('Activiteit', 'Activity')}
          <IconChevronRight
            className="size-3 text-slate-500 transition-transform duration-150 group-open:rotate-90"
            aria-hidden="true"
          />
        </summary>
        <ol className="mt-3">
          {entries.map((entry, index) => (
            <li key={entry.id} className="relative grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2.5 pb-3 last:pb-0">
              {index < entries.length - 1 ? (
                <span aria-hidden="true" className="absolute top-5 bottom-0 left-[11.5px] w-px bg-slate-200" />
              ) : null}
              <span className="relative z-10 flex size-6 items-center justify-center bg-white text-slate-500">
                <PreviewActivityIcon kind={entry.kind} />
              </span>
              <div className="min-w-0 pt-0.5">
                {entry.at === null ? (
                  <p className="text-pretty text-slate-700 text-sm leading-5">
                    <span className="font-medium text-slate-500">{entry.label}:</span> {entry.detail}
                  </p>
                ) : (
                  <p className="text-slate-600 text-sm leading-5">
                    {entry.label}
                    {entry.detail ? `: ${entry.detail}` : ''}{' '}
                    <time
                      className="whitespace-nowrap text-slate-500 text-xs tabular-nums"
                      dateTime={new Date(entry.at).toISOString()}
                    >
                      · {formatPreviewActivityTime(entry.at, locale)}
                    </time>
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      </details>
    </section>
  )
}

function PreviewActivityIcon({ kind }: { kind: PreviewActivityEntry['kind'] }) {
  if (kind === 'next') return <IconArrowRight className="size-3.5" aria-hidden="true" />
  if (kind === 'open') return <IconCircleDashed className="size-3.5" aria-hidden="true" />
  if (kind === 'done') return <IconCheckmark1Small className="size-4" aria-hidden="true" />
  if (kind === 'observed') return <IconWindowCursor className="size-3.5" aria-hidden="true" />
  return <IconArrowInbox className="size-3.5" aria-hidden="true" />
}

function formatPreviewActivityTime(timestamp: number, locale: string) {
  return new Intl.DateTimeFormat(locale === 'nl' ? 'nl-NL' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp)
}
