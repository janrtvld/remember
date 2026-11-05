'use client'

import type { WorkItem } from '@remember/shared'
import {
  Archive as IconArchiveJunk,
  Inbox as IconArrowInbox,
  ArrowRight as IconArrowRight,
  ArrowUp as IconArrowUp,
  MessagesSquare as IconBubbles,
  Check as IconCheckmark1Small,
  ChevronRight as IconChevronRight,
  CircleDashed as IconCircleDashed,
  Inbox as IconInbox,
  Pencil as IconPencil,
  Plus as IconPlusSmall,
  AppWindow as IconWindowCursor,
} from 'lucide-react'
import { useState } from 'react'
import { createPreviewInboxItems } from './inboxFixtures'
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
  const [showCompleted, setShowCompleted] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>('meeting-flow')
  const [readIds, setReadIds] = useState(() => new Set(['meeting-flow', 'manual-support']))
  const visibleTasks = inboxTasks(workItems, showCompleted)
  const selectedTask = selectedInboxTask(visibleTasks, selectedId) ?? visibleTasks[0] ?? null
  const selected = selectedTask?.workItem ?? null

  function updateItem(id: string, update: (item: WorkItem) => WorkItem) {
    setWorkItems((current) => current.map((item) => (item.id === id ? update(item) : item)))
  }

  function selectItem(id: string) {
    setSelectedId(id)
    setReadIds((current) => (current.has(id) ? current : new Set(current).add(id)))
  }

  function selectNextItem(id: string) {
    const next = visibleTasks.find((item) => item.taskKey !== id) ?? null
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
      setSelectedId(firstOpen?.taskKey ?? null)
    }
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

  const selectedTitle = selected?.title ?? ''
  const selectedDescription = selected?.description ?? ''
  const selectedClosed = selected ? selected.lifecycle !== 'open' : false
  const selectedSource = selected ? itemSource(selected) : null
  const selectedReturnPoint = selectedTask ? inboxReturnPoint(selectedTask) : null
  return (
    <div className="flex min-h-full grow flex-col overflow-hidden">
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
                  {t('Taken', 'Tasks')}
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
            <IconInbox className="size-4" />
          </button>
          <button
            type="button"
            aria-label={t('Nieuw actiepunt', 'New action item')}
            disabled
            className="ml-1 flex size-7 shrink-0 items-center justify-center rounded-md text-slate-500 outline-none hover:bg-slate-100 hover:text-slate-800 focus-visible:ring-2 focus-visible:ring-slate-400 disabled:pointer-events-none disabled:text-slate-300"
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
            aria-label={t('Taken', 'Tasks')}
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
              <div className="mx-auto w-full max-w-[720px] px-10 pt-6 pb-8">
                <label htmlFor="preview-inbox-title" className="sr-only">
                  {t('Titel van actiepunt', 'Action point title')}
                </label>
                <textarea
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

                <InboxPreviewActivity
                  item={selected}
                  returnPoint={selectedReturnPoint}
                  includeContext={!selectedClosed}
                />
              </div>
            </div>
          </article>
        </div>
      ) : (
        <main className="flex min-h-80 grow flex-col items-center justify-center px-6 text-center">
          <p className="text-slate-500 text-sm">{t('Niets op je bord', 'Nothing on your plate')}</p>
          <button
            type="button"
            disabled
            className="mt-4 flex h-8 items-center gap-1.5 rounded-lg bg-blue-700 px-3 font-medium text-white text-sm outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:pointer-events-none disabled:opacity-50"
          >
            <IconPlusSmall className="size-4" />
            {t('Nieuw actiepunt', 'New action item')}
          </button>
        </main>
      )}
    </div>
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
