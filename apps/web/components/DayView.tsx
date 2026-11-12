'use client'

import {
  Dialog,
  DialogBackdrop,
  DialogDescription,
  DialogPanel,
  DialogTitle,
  Disclosure,
  DisclosureButton,
  DisclosurePanel,
  Menu,
  MenuButton,
  MenuItem,
} from '@headlessui/react'
import { DashboardPageHeader } from '@internal/components/DashboardPageHeader'
import {
  conversationAnalysisPending,
  conversationAtReference,
  conversationSummaryStatus,
} from '@internal/components/manualMeetingConversation'
import { useLocalBridge } from '@internal/context/LocalBridgeProvider'
import { useI18n } from '@internal/locales'
import { Button } from '@internal/ui/Button'
import { Container } from '@internal/ui/Container'
import { CopyIcon } from '@internal/ui/CopyIcon'
import { DropdownMenuItems, dropdownDangerItemStyle, dropdownItemStyle } from '@internal/ui/Dropdown'
import { IconButton } from '@internal/ui/IconButton'
import { PendingIndicator } from '@internal/ui/PendingIndicator'
import { Spinner } from '@internal/ui/Spinner'
import {
  type AppUsage,
  type CalendarBlock,
  type ConversationSummary,
  conversationActionPointItems,
  conversationReference,
  type Day,
  type DayMemory,
  normalizeAppIdentity,
  type ProjectAttention,
  type RevinoteConnectionStatus,
  type RevinotePostProcessStatus,
  workItemForConversationActionPoint,
} from '@remember/shared'
import {
  Inbox as IconArrowInbox,
  RotateCw as IconArrowRotateClockwise,
  Check as IconCheckmark1Small,
  ChevronDown as IconChevronDownSmall,
  ChevronRight as IconChevronRight,
  CloudOff as IconCloudSimpleDisconnected,
  Ellipsis as IconDotGrid1x3HorizontalTight,
  FileText as IconFileText,
  Pause as IconPause,
  Play as IconPlay,
  SquareArrowOutUpRight as IconSquareArrowTopRight,
  Trash2 as IconTrashCanSimple,
  Volume2 as IconVolumeFull,
  VolumeX as IconVolumeOff,
  AppWindow as IconWindowApp,
} from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Fragment, type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'
import { BreadcrumbSeparator } from './BreadcrumbSeparator'
import { ConversationAudioSkeleton, ConversationProcessingLines } from './ConversationProcessingState'
import { ConversationsPageHeader } from './ConversationsPageHeader'
import { formatConversationDate, formatConversationTimeRange } from './conversationDate'
import { conversationSpaceContext, conversationSpaceDestination } from './conversationSpaceContext'
import { transcriptForConversation } from './conversationTranscript'
import { DashboardLoadError } from './DashboardLoadError'
import { DayCalendarPicker } from './DayCalendarPicker'
import { dayConversationHref, dayHref, daySectionHref, isLocalToday } from './dayNavigation'
import { formatDay, formatDuration } from './daySummaryFormatting'
import { type DayTab, dayTabs } from './dayTabs'
import { createDayScheduleLayout, createRhythmEntries, formatLocalMinute } from './dayTimelineLayout'
import { inboxTaskHref } from './inboxTasks'
import { MarkdownContent, MarkdownList, MarkdownPreview } from './MarkdownContent'
import { RevinoteSourceIcon } from './RevinoteSourceIcon'
import { TimelineItemActions } from './TimelineItemActions'
import { wikiHomeHref } from './wikiRoutes'

function timeLabel(timestamp: number, locale: 'en-US' | 'nl-NL') {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(timestamp)
}

function daySwitchLabel(day: Day, locale: 'en-US' | 'nl-NL', t: ReturnType<typeof useI18n>['t']) {
  if (isLocalToday(day.startedAt)) return t('Vandaag')
  const label = new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(day.startedAt)
  return label.charAt(0).toLocaleUpperCase(locale) + label.slice(1)
}

function DayHeader({
  nestedDetail,
}: {
  nestedDetail: {
    title: string | null
    ancestors: Array<{ label: string; href: string }>
    deleteAction?: {
      busy: boolean
      onSelect: () => void
    }
    revinoteAction?: {
      state: 'idle' | 'busy' | 'queued'
      onSelect: () => void
    }
    revinoteHref?: string
    wikiHref?: string
  }
}) {
  const { t } = useI18n()

  return (
    <header className="flex min-h-[43px] items-center border-slate-200 border-b pr-2 pl-3">
      <nav aria-label={t('Kruimelpad')} className="min-w-0 flex-1 overflow-hidden">
        <ol className="flex min-w-0 items-center text-slate-800 text-sm">
          {nestedDetail.ancestors.map((ancestor, index) => (
            <Fragment key={ancestor.href}>
              {index > 0 ? <BreadcrumbSeparator /> : null}
              <li className="min-w-0">
                <Link
                  href={ancestor.href}
                  className="flex h-7 max-w-full items-center rounded-md px-2 font-medium text-slate-800 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-400"
                >
                  <span className="truncate font-medium">{ancestor.label}</span>
                </Link>
              </li>
            </Fragment>
          ))}
          {nestedDetail.title ? (
            <>
              <BreadcrumbSeparator />
              <li aria-current="page" className="min-w-0 font-medium truncate px-2 text-slate-800">
                {nestedDetail.title}
              </li>
            </>
          ) : null}
        </ol>
      </nav>
      {nestedDetail.deleteAction ||
      nestedDetail.revinoteAction ||
      nestedDetail.revinoteHref ||
      nestedDetail.wikiHref ? (
        <Menu>
          <MenuButton
            as={IconButton}
            disabled={nestedDetail.deleteAction?.busy}
            aria-label={t('Meer opties voor {title}', {
              title: nestedDetail.title ?? nestedDetail.ancestors[nestedDetail.ancestors.length - 1]?.label ?? '',
            })}
            className="shrink-0 cursor-pointer"
          >
            <IconDotGrid1x3HorizontalTight className="size-3.5" aria-hidden="true" />
          </MenuButton>
          <DropdownMenuItems
            anchor="bottom end"
            className={`mt-1 origin-top-right ${nestedDetail.revinoteAction || nestedDetail.wikiHref ? 'w-64' : 'w-48'}`}
          >
            {nestedDetail.wikiHref ? (
              <MenuItem>
                <Link href={nestedDetail.wikiHref} className={dropdownItemStyle}>
                  <IconFileText className="size-4" aria-hidden="true" />
                  {t('Gekoppeld document openen')}
                </Link>
              </MenuItem>
            ) : null}
            {nestedDetail.revinoteHref ? (
              <MenuItem>
                <a href={nestedDetail.revinoteHref} target="_blank" rel="noreferrer" className={dropdownItemStyle}>
                  <IconSquareArrowTopRight className="size-4" aria-hidden="true" />
                  {t('Openen in Revinote')}
                </a>
              </MenuItem>
            ) : null}
            {nestedDetail.revinoteAction ? (
              <MenuItem>
                <button
                  type="button"
                  onClick={nestedDetail.revinoteAction.onSelect}
                  disabled={nestedDetail.revinoteAction.state !== 'idle'}
                  className={`${dropdownItemStyle} disabled:cursor-wait disabled:text-slate-400`}
                >
                  {nestedDetail.revinoteAction.state === 'idle' ? (
                    <IconArrowRotateClockwise className="size-4" aria-hidden="true" />
                  ) : (
                    <Spinner size="sm" label={t('Revinote verwerkt het gesprek')} />
                  )}
                  {nestedDetail.revinoteAction.state === 'queued'
                    ? t('Wordt verwerkt in Revinote')
                    : nestedDetail.revinoteAction.state === 'busy'
                      ? t('Naar Revinote sturen…')
                      : t('Opnieuw verwerken met Revinote')}
                </button>
              </MenuItem>
            ) : null}
            {nestedDetail.deleteAction ? (
              <MenuItem>
                <button
                  type="button"
                  onClick={nestedDetail.deleteAction.onSelect}
                  disabled={nestedDetail.deleteAction.busy}
                  className={`${dropdownDangerItemStyle} disabled:cursor-wait disabled:text-slate-400`}
                >
                  <IconTrashCanSimple className="size-4" aria-hidden="true" />
                  {nestedDetail.deleteAction.busy ? t('Verwijderen…') : t('Gesprek verwijderen')}
                </button>
              </MenuItem>
            ) : null}
          </DropdownMenuItems>
        </Menu>
      ) : null}
    </header>
  )
}

function ItemList({ items, empty }: { items: string[]; empty: string }) {
  if (!items.length) return <p className="text-slate-500 text-ui">{empty}</p>
  return <MarkdownList items={items} />
}

function ProjectAttentionSection({ items, outcomes }: { items: ProjectAttention[]; outcomes: string[] }) {
  const { dateLocale, t } = useI18n()
  const totalMinutes = items.reduce((total, item) => total + item.durationMinutes, 0)
  const colors = [
    'bg-[oklch(var(--categorical-purple))]',
    'bg-[oklch(var(--categorical-teal))]',
    'bg-[oklch(var(--categorical-green))]',
    'bg-[oklch(var(--categorical-yellow))]',
    'bg-[oklch(var(--categorical-orange))]',
    'bg-[oklch(var(--categorical-pink))]',
    'bg-[oklch(var(--categorical-red))]',
    'bg-[oklch(var(--categorical-grey))]',
  ]

  return (
    <section className="border-black/[0.08] border-t pt-6" aria-labelledby="project-attention-heading">
      <div className="grid gap-8">
        <div>
          <h2 id="project-attention-heading" className="font-semibold text-slate-950 text-lg">
            {t('Aandacht')}
          </h2>
          {items.length ? (
            <div className="mt-6 grid gap-5">
              {items.map((item, index) => {
                const share = totalMinutes > 0 ? (item.durationMinutes / totalMinutes) * 100 : 0
                return (
                  <div key={item.project}>
                    <div className="mb-2 flex items-baseline justify-between gap-4">
                      <span className="min-w-0 truncate font-medium text-slate-800 text-ui">{item.project}</span>
                      <span className="shrink-0 text-slate-600 text-xs tabular-nums">
                        {formatDuration(item.durationMinutes * 60_000, dateLocale)}
                      </span>
                    </div>
                    <div
                      className="h-1.5 overflow-hidden rounded-full bg-slate-100"
                      role="img"
                      aria-label={t('{project}: {share}% van de herkende projecttijd', {
                        project: item.project,
                        share: Math.round(share),
                      })}
                    >
                      <div
                        className={`h-full rounded-full ${colors[index % colors.length]}`}
                        style={{ width: `${Math.max(4, share)}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="mt-4 text-slate-500 text-ui">{t('Nog geen projectverdeling herkend.')}</p>
          )}
        </div>
        <section className="border-black/[0.08] border-t pt-6" aria-labelledby="results-heading">
          <h3 id="results-heading" className="font-semibold text-slate-950 text-lg">
            {t('Resultaten')}
          </h3>
          <div className="mt-4">
            <ItemList items={outcomes} empty={t('Nog geen betekenisvolle resultaten.')} />
          </div>
        </section>
      </div>
    </section>
  )
}

function appsForTimelineBlock(day: Day, block: CalendarBlock): AppUsage[] {
  const blockStartedAt = timestampForDayTime(day.startedAt, block.startTime)
  const blockEndedAt = timestampForDayTime(day.startedAt, block.endTime)
  const usage = new Map<string, AppUsage>()
  const activities = day.appActivity.slice().sort((first, second) => first.startedAt - second.startedAt)

  for (const [index, activity] of activities.entries()) {
    if (activity.appName === 'Idle') continue
    const nextStartedAt = activities[index + 1]?.startedAt ?? blockEndedAt
    const activityEndedAt = Math.min(activity.endedAt ?? blockEndedAt, nextStartedAt)
    const overlap = Math.max(0, Math.min(activityEndedAt, blockEndedAt) - Math.max(activity.startedAt, blockStartedAt))
    if (!overlap) continue

    const identity = normalizeAppIdentity(activity)
    const key = identity.bundleId || identity.name
    const current = usage.get(key)
    usage.set(key, { ...identity, durationMs: (current?.durationMs ?? 0) + overlap })
  }

  return Array.from(usage.values())
    .sort((first, second) => second.durationMs - first.durationMs)
    .slice(0, 4)
}

function useTimelineAppIcons(blocks: CalendarBlock[], day: Day) {
  const appsByBlock = useMemo(() => blocks.map((block) => appsForTimelineBlock(day, block)), [blocks, day])
  const [icons, setIcons] = useState<Record<string, string>>({})

  useEffect(() => {
    const bundleIds = Array.from(
      new Set(appsByBlock.flatMap((apps) => apps.map((app) => app.bundleId).filter(Boolean)))
    )
    if (!bundleIds.length) return
    let active = true
    void window.remember.getAppIcons(bundleIds).then((nextIcons) => {
      if (active) setIcons(nextIcons)
    })
    return () => {
      active = false
    }
  }, [appsByBlock])

  return { appsByBlock, icons }
}

function TimelineAppStack({ apps, icons }: { apps: AppUsage[]; icons: Record<string, string> }) {
  const { t } = useI18n()
  if (!apps.length) return null
  return (
    <span
      role="img"
      className="flex shrink-0 items-center gap-0.5 pl-1.5"
      aria-label={t('Gebruikte apps: {apps}', { apps: apps.map((app) => app.name).join(', ') })}
    >
      {apps.map((app) => {
        const icon = icons[app.bundleId]
        return (
          <span
            key={app.bundleId || app.name}
            className={`flex size-6 items-center justify-center ${icon ? '' : 'rounded-[6px] bg-slate-100 text-slate-400'}`}
            title={app.name}
          >
            {icon ? (
              <Image unoptimized src={icon} alt="" width={24} height={24} className="size-full object-contain" />
            ) : (
              <IconWindowApp className="size-3" aria-hidden="true" />
            )}
          </span>
        )
      })}
    </span>
  )
}

function localMinuteRelativeToDay(dayStartedAt: number, timestamp: number) {
  const dayStart = new Date(dayStartedAt)
  const date = new Date(timestamp)
  const isLaterLocalDate =
    date.getFullYear() !== dayStart.getFullYear() ||
    date.getMonth() !== dayStart.getMonth() ||
    date.getDate() !== dayStart.getDate()
  return date.getHours() * 60 + date.getMinutes() + (isLaterLocalDate && timestamp > dayStartedAt ? 1440 : 0)
}

function formatBreakDuration(minutes: number, locale: 'en-US' | 'nl-NL') {
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  const unit = locale === 'nl-NL' ? 'u' : 'h'
  return remainder ? `${hours} ${unit} ${remainder} min` : `${hours} ${unit}`
}

function Timeline({
  blocks,
  day,
  hiddenItemIds,
  selectedItemId,
}: {
  blocks: CalendarBlock[]
  day: Day
  hiddenItemIds?: string[]
  selectedItemId?: string
}) {
  const { dateLocale, t } = useI18n()
  const { hiddenBlocks, visibleBlocks } = useMemo(() => {
    const hiddenIds = new Set(hiddenItemIds)
    return {
      hiddenBlocks: blocks.filter((block) => block.id && hiddenIds.has(block.id)),
      visibleBlocks: blocks.filter((block) => !block.id || !hiddenIds.has(block.id)),
    }
  }, [blocks, hiddenItemIds])
  const { appsByBlock, icons } = useTimelineAppIcons(visibleBlocks, day)
  const active = day.endedAt == null && isLocalToday(day.startedAt)
  const liveBlock = active ? blocks.at(-1) : undefined
  const [currentTime, setCurrentTime] = useState(Date.now())
  const [restoringHidden, setRestoringHidden] = useState(false)
  const [restoreError, setRestoreError] = useState(false)
  const selectedItemRef = useRef<HTMLLIElement>(null)

  useEffect(() => {
    if (!active) return
    const update = () => setCurrentTime(Date.now())
    update()
    const interval = window.setInterval(update, 30_000)
    return () => window.clearInterval(interval)
  }, [active])

  useEffect(() => {
    if (!selectedItemId) return
    const frame = window.requestAnimationFrame(() => selectedItemRef.current?.scrollIntoView({ block: 'center' }))
    return () => window.cancelAnimationFrame(frame)
  }, [selectedItemId])

  const endTimestamp = active ? currentTime : (day.endedAt ?? day.memory?.coveredThrough ?? day.startedAt)
  const layout = createDayScheduleLayout(visibleBlocks, {
    startMinute: localMinuteRelativeToDay(day.startedAt, day.startedAt),
    endMinute: localMinuteRelativeToDay(day.startedAt, endTimestamp),
  })
  const entries = createRhythmEntries(layout)
  const visibleEntries = active && entries.at(-1)?.type === 'gap' ? entries.slice(0, -1) : entries

  const restoreHidden = async () => {
    if (restoringHidden) return
    setRestoringHidden(true)
    setRestoreError(false)
    try {
      await window.remember.showHiddenTimelineItems(day.id)
    } catch {
      setRestoreError(true)
    } finally {
      setRestoringHidden(false)
    }
  }

  const restoreHiddenControl = hiddenBlocks.length ? (
    <div className="mt-1 pl-[calc(16px+0.5rem)] sm:pl-[calc(18px+0.75rem)]">
      <Button
        variant="text"
        color="secondary"
        size="small"
        disabled={restoringHidden}
        onClick={() => void restoreHidden()}
        className="text-slate-400 hover:bg-slate-50 hover:text-slate-700"
      >
        {restoringHidden ? t('Herstellen…') : t('Toon {count} verborgen activiteiten', { count: hiddenBlocks.length })}
      </Button>
      {restoreError ? (
        <p className="mt-1 text-danger-700 text-xs" role="alert">
          {t('Verborgen activiteiten konden niet worden hersteld.')}
        </p>
      ) : null}
    </div>
  ) : null

  if (!visibleEntries.length) {
    return (
      <div>
        <p className="text-slate-500 text-ui">{t('Nog geen activiteit in de tijdlijn.')}</p>
        {restoreHiddenControl}
      </div>
    )
  }

  return (
    <>
      <ol>
        {visibleEntries.map((entry, index) => {
          if (entry.type === 'gap') {
            const duration = entry.endMinute - entry.startMinute
            return (
              <li
                key={`gap-${entry.startMinute}-${entry.endMinute}`}
                className="grid min-h-10 grid-cols-[max-content_16px_minmax(0,1fr)] gap-x-2 sm:grid-cols-[max-content_18px_minmax(0,1fr)] sm:gap-x-3"
                aria-label={t('Pauze van {start} tot {end}, {duration}', {
                  start: formatLocalMinute(entry.startMinute),
                  end: formatLocalMinute(entry.endMinute),
                  duration: formatBreakDuration(duration, dateLocale),
                })}
              >
                <time className="self-center whitespace-nowrap text-left text-slate-400 text-xs leading-4 tabular-nums">
                  {formatLocalMinute(entry.startMinute)}–{formatLocalMinute(entry.endMinute)}
                </time>
                <div className="pointer-events-none relative flex justify-center" aria-hidden="true">
                  <span className="absolute inset-y-0 left-1/2 -translate-x-1/2 border-black/[0.12] border-l border-dashed" />
                </div>
                <div className="flex items-center pl-3 text-slate-400 text-xs">
                  <span>{t('Pauze')}</span>
                  <span className="ml-1.5 tabular-nums" aria-hidden="true">
                    · {formatBreakDuration(duration, dateLocale)}
                  </span>
                </div>
              </li>
            )
          }

          const { block, sourceIndex } = entry.item
          const isLiveEnd = Boolean(active && liveBlock && (block.id ? block.id === liveBlock.id : block === liveBlock))
          return (
            <li
              ref={block.id === selectedItemId ? selectedItemRef : undefined}
              key={`${sourceIndex}-${block.startTime}-${block.title}`}
              className="grid grid-cols-[max-content_16px_minmax(0,1fr)] gap-x-2 pb-5 sm:grid-cols-[max-content_18px_minmax(0,1fr)] sm:gap-x-3"
              aria-current={block.id === selectedItemId ? 'true' : undefined}
            >
              <time className="whitespace-nowrap pt-[5px] text-left font-medium text-slate-500 text-xs leading-4 tabular-nums">
                {block.startTime}–{block.endTime}
              </time>
              <div className="pointer-events-none relative flex justify-center" aria-hidden="true">
                {index > 0 ? (
                  <span className="absolute top-0 left-1/2 h-2.5 w-px -translate-x-1/2 bg-black/[0.09]" />
                ) : null}
                {index < visibleEntries.length - 1 ? (
                  <span className="absolute top-2.5 -bottom-5 left-1/2 w-px -translate-x-1/2 bg-black/[0.09]" />
                ) : null}
                {isLiveEnd ? (
                  <span className="absolute top-2.5 bottom-0 left-1/2 w-px -translate-x-1/2 bg-black/[0.09]" />
                ) : null}
                <span className="absolute top-1.5 size-2 rounded-full bg-blue-700 ring-4 ring-white" />
                {isLiveEnd ? (
                  <span className="absolute -bottom-[5px] left-1/2 size-2.5 -translate-x-1/2">
                    <span className="absolute inset-0 animate-ping rounded-full bg-blue-600 opacity-50 motion-reduce:animate-none" />
                    <span className="absolute inset-0 rounded-full bg-blue-700" />
                  </span>
                ) : null}
              </div>
              <article className="group relative isolate overflow-hidden rounded-lg bg-slate-50 px-3.5 py-3">
                {block.id === selectedItemId ? (
                  <span
                    className="pointer-events-none absolute inset-0 z-0 animate-timeline-source-pulse rounded-lg bg-slate-100 opacity-0 motion-reduce:animate-none motion-reduce:opacity-100"
                    aria-hidden="true"
                  />
                ) : null}
                <div className="relative z-10 flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-1">
                    <h2 className="min-w-0 text-balance font-medium text-slate-900 text-ui leading-5">{block.title}</h2>
                    <TimelineItemActions day={day} block={block} />
                  </div>
                  <TimelineAppStack apps={appsByBlock[sourceIndex] ?? []} icons={icons} />
                </div>
                {block.description ? (
                  <p className="relative z-10 mt-1 max-w-[68ch] text-pretty text-slate-500 text-ui leading-5">
                    {block.description}
                  </p>
                ) : null}
                {block.details?.length ? (
                  <Disclosure defaultOpen={block.id === selectedItemId} as="div" className="relative z-10 mt-2">
                    <DisclosureButton className="group/details -ml-1 flex min-h-7 items-center gap-1 rounded-md px-1 text-slate-500 text-xs outline-none hover:bg-slate-100 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-slate-300">
                      <IconChevronRight
                        className="size-3 transition-transform duration-150 group-data-open/details:rotate-90 motion-reduce:transition-none"
                        aria-hidden="true"
                      />
                      {t('Details')}
                    </DisclosureButton>
                    <DisclosurePanel>
                      <ol className="mt-1 grid gap-1.5 border-black/[0.07] border-l pl-3">
                        {block.details.map((detail, detailIndex) => (
                          <li
                            key={`${detail.at}-${detailIndex}-${detail.text}`}
                            className="grid grid-cols-[2.75rem_minmax(0,1fr)] gap-2 text-xs leading-5"
                          >
                            <time className="text-slate-400 tabular-nums">{detail.at}</time>
                            <span className="text-slate-600">{detail.text}</span>
                          </li>
                        ))}
                      </ol>
                    </DisclosurePanel>
                  </Disclosure>
                ) : null}
                {isLiveEnd ? <span className="sr-only">{t('Huidig moment')}</span> : null}
              </article>
            </li>
          )
        })}
      </ol>
      {restoreHiddenControl}
    </>
  )
}

function timestampForDayTime(dayStartedAt: number, time: string) {
  const [hours, minutes] = time.split(':').map(Number)
  const timestamp = new Date(dayStartedAt)
  timestamp.setHours(hours === 24 ? 0 : hours, minutes, 0, 0)
  if (hours === 24) timestamp.setDate(timestamp.getDate() + 1)
  return timestamp.getTime()
}

function timelineItemAt(day: Day, timestamp: number) {
  const blocks = (day.memory?.timeline ?? []).filter((block) => block.id)
  const containing = blocks.find(
    (block) =>
      timestampForDayTime(day.startedAt, block.startTime) <= timestamp &&
      timestamp < timestampForDayTime(day.startedAt, block.endTime)
  )
  if (containing?.id) return containing.id
  return blocks.toSorted(
    (left, right) =>
      Math.abs(timestampForDayTime(day.startedAt, left.startTime) - timestamp) -
      Math.abs(timestampForDayTime(day.startedAt, right.startTime) - timestamp)
  )[0]?.id
}

function ConversationsSection({ day, conversations }: { day: Day; conversations: ConversationSummary[] }) {
  const { t } = useI18n()
  if (!conversations.length) return <p className="text-slate-500 text-ui">{t('Nog geen gesprekken herkend.')}</p>

  return (
    <ol className="-mt-2 -mx-1.5">
      {conversations.map((conversation) => {
        const title = conversation.title.trim() || t('Nieuwe meeting')
        const reference = conversationReference(conversation)

        if (conversation.processing === 'merging') {
          return (
            <li key={reference}>
              <div className="flex w-full items-center justify-between gap-3 rounded-lg px-1.5 py-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="shrink-0 font-medium text-slate-500 text-xs tabular-nums">
                    {formatConversationTimeRange(conversation.startTime, conversation.endTime)}
                  </span>
                  <span className="truncate font-medium text-slate-900 text-ui leading-5">{title}</span>
                  {conversation.description ? (
                    <MarkdownPreview className="truncate text-slate-500 text-ui leading-5">
                      {conversation.description}
                    </MarkdownPreview>
                  ) : null}
                </div>
                <Spinner label={t('Gesprek verwerken')} />
              </div>
            </li>
          )
        }

        return (
          <li key={reference}>
            <Link
              href={dayConversationHref(day, conversation)}
              className="group flex w-full items-center justify-between gap-3 rounded-lg px-1.5 py-3 text-left outline-none transition-[background-color,transform] duration-150 hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-slate-400 active:scale-[0.995] motion-reduce:transition-none"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <span className="shrink-0 font-medium text-slate-500 text-xs tabular-nums">
                  {formatConversationTimeRange(conversation.startTime, conversation.endTime)}
                </span>
                <span className="flex min-w-0 items-center gap-1.5">
                  {conversation.processing === 'processing' ? (
                    <span
                      className="h-5 w-full max-w-56 animate-pulse rounded bg-slate-200 motion-reduce:animate-none"
                      role="status"
                      aria-label={t('Gesprek verwerken')}
                    />
                  ) : (
                    <span className="truncate font-medium text-slate-900 text-ui leading-5">{title}</span>
                  )}
                  {conversation.source === 'revinote' ? <RevinoteSourceIcon /> : null}
                </span>
                {conversation.processing === 'processing' ? (
                  <span className="h-3.5 w-28 animate-pulse rounded bg-slate-200 motion-reduce:animate-none" />
                ) : conversation.description ? (
                  <MarkdownPreview className="truncate text-slate-500 text-ui leading-5">
                    {conversation.description}
                  </MarkdownPreview>
                ) : null}
              </div>
              <IconChevronRight
                className="size-3.5 shrink-0 text-slate-300 transition-[color,transform] duration-150 group-hover:translate-x-px group-hover:text-slate-500 motion-reduce:transition-none"
                aria-hidden="true"
              />
            </Link>
          </li>
        )
      })}
    </ol>
  )
}

function formatAudioTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.floor(seconds % 60)
  return `${minutes}:${remainder.toString().padStart(2, '0')}`
}

function ConversationAudioPlayer({ src }: { src: string }) {
  const local = useLocalBridge()
  const { t } = useI18n()
  const playbackId = useId()
  const audioRef = useRef<HTMLAudioElement>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isMuted, setIsMuted] = useState(false)
  const [isPreparing, setIsPreparing] = useState(false)
  const [playbackError, setPlaybackError] = useState(false)
  const recordingActive = local.state?.manualMeeting?.status === 'recording'

  useEffect(
    () => () => {
      audioRef.current?.pause()
      void window.remember.setConversationAudioPlayback(playbackId, false)
    },
    [playbackId]
  )

  useEffect(() => {
    if (!recordingActive) return
    audioRef.current?.pause()
    void window.remember.setConversationAudioPlayback(playbackId, false)
  }, [playbackId, recordingActive])

  async function togglePlayback() {
    const audio = audioRef.current
    if (!audio || isPreparing) return
    if (!audio.paused) {
      audio.pause()
      return
    }

    setIsPreparing(true)
    setPlaybackError(false)
    try {
      await window.remember.setConversationAudioPlayback(playbackId, true)
      await audio.play()
    } catch {
      await window.remember.setConversationAudioPlayback(playbackId, false).catch(() => undefined)
      setPlaybackError(true)
    } finally {
      setIsPreparing(false)
    }
  }

  function seek(value: number) {
    const audio = audioRef.current
    if (!audio || duration <= 0) return
    audio.currentTime = value
    setCurrentTime(value)
  }

  function toggleMuted() {
    const audio = audioRef.current
    if (!audio) return
    audio.muted = !audio.muted
    setIsMuted(audio.muted)
  }

  function syncDuration() {
    const audioDuration = audioRef.current?.duration
    if (audioDuration && Number.isFinite(audioDuration)) setDuration(audioDuration)
  }

  const total = Math.max(duration, currentTime)

  if (playbackError) {
    return (
      <span className="text-danger-700 text-xs" role="alert">
        {t('Audio kon niet worden afgespeeld.')}
      </span>
    )
  }

  return (
    <div className="flex w-full max-w-[18rem] min-w-0 items-center gap-2">
      <IconButton
        size="compact"
        className="-ml-1 shrink-0 text-slate-600 hover:text-slate-800"
        onClick={() => void togglePlayback()}
        disabled={isPreparing || playbackError || recordingActive}
        aria-busy={isPreparing}
        aria-label={
          recordingActive
            ? t('Audio is niet beschikbaar tijdens een opname')
            : isPlaying
              ? t('Pauzeren')
              : t('Afspelen')
        }
      >
        {isPreparing ? (
          <Spinner size="sm" label={t('Audio laden')} />
        ) : isPlaying ? (
          <IconPause className="size-3.5" aria-hidden="true" />
        ) : (
          <IconPlay className="size-3.5" aria-hidden="true" />
        )}
      </IconButton>
      <span className="w-9 shrink-0 text-right font-medium text-slate-500 text-xs tabular-nums">
        {formatAudioTime(currentTime)}
      </span>
      <input
        type="range"
        min={0}
        max={Math.max(total, 0.1)}
        step={0.1}
        value={Math.min(currentTime, total)}
        onChange={(event) => seek(Number(event.target.value))}
        disabled={duration <= 0}
        aria-label={t('Positie in gespreksaudio')}
        className="h-4 min-w-12 flex-1 cursor-pointer appearance-none bg-transparent outline-none disabled:cursor-default [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-0.5 [&::-moz-range-thumb]:rounded-none [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-slate-500 [&::-moz-range-track]:h-1 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-slate-200 [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-slate-200 [&::-webkit-slider-thumb]:-mt-1 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-[3px] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-slate-500 focus-visible:[&::-moz-range-thumb]:ring-2 focus-visible:[&::-moz-range-thumb]:ring-slate-300 focus-visible:[&::-webkit-slider-thumb]:ring-2 focus-visible:[&::-webkit-slider-thumb]:ring-slate-300"
      />
      <span className="w-9 shrink-0 font-medium text-slate-500 text-xs tabular-nums">
        {duration > 0 ? formatAudioTime(total) : '--:--'}
      </span>
      <IconButton
        size="compact"
        className="shrink-0 text-slate-600 hover:text-slate-800"
        onClick={toggleMuted}
        aria-label={isMuted ? t('Geluid aanzetten') : t('Dempen')}
      >
        {isMuted ? (
          <IconVolumeOff className="size-3.5" aria-hidden="true" />
        ) : (
          <IconVolumeFull className="size-3.5" aria-hidden="true" />
        )}
      </IconButton>
      {/* biome-ignore lint/a11y/useMediaCaption: The timestamped transcript is available directly below the player. */}
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={syncDuration}
        onDurationChange={syncDuration}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onPlay={() => setIsPlaying(true)}
        onPause={() => {
          setIsPlaying(false)
          void window.remember.setConversationAudioPlayback(playbackId, false)
        }}
        onEnded={() => {
          setIsPlaying(false)
          void window.remember.setConversationAudioPlayback(playbackId, false)
        }}
        onError={() => {
          setIsPlaying(false)
          setPlaybackError(true)
          void window.remember.setConversationAudioPlayback(playbackId, false)
        }}
      />
    </div>
  )
}

function ConversationAudioPlayback({
  dayId,
  conversation,
  pending = false,
}: {
  dayId: string
  conversation: ConversationSummary
  pending?: boolean
}) {
  const { t } = useI18n()
  const [audioUrl, setAudioUrl] = useState<string | null | undefined>(undefined)
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState(false)
  const audioReference =
    conversation.source === 'revinote' && conversation.externalId
      ? `external:${conversation.externalId}`
      : conversation.episodeId

  useEffect(() => {
    let active = true
    if (!audioReference) {
      setAudioUrl(null)
      return () => undefined
    }
    setAudioUrl(undefined)
    setDownloadError(false)
    void window.remember
      .getConversationAudioUrl(dayId, audioReference)
      .then((url) => {
        if (active) setAudioUrl(url)
      })
      .catch(() => {
        if (active) setAudioUrl(null)
      })
    return () => {
      active = false
    }
  }, [audioReference, dayId])

  async function download() {
    if (!audioReference || downloading) return
    setDownloading(true)
    setDownloadError(false)
    try {
      await window.remember.saveConversationAudio(dayId, audioReference)
    } catch {
      setDownloadError(true)
    } finally {
      setDownloading(false)
    }
  }

  if (!audioReference) {
    return pending ? (
      <div className="mt-3">
        <ConversationAudioSkeleton />
      </div>
    ) : null
  }
  return (
    <div className="mt-3 flex w-full min-w-0 flex-col gap-1 text-sm">
      <div className="flex w-full max-w-[20rem] min-w-0 items-center gap-2">
        {audioUrl === null ? (
          <span className="text-slate-500">{t('Audio niet beschikbaar')}</span>
        ) : audioUrl ? (
          <ConversationAudioPlayer key={audioUrl} src={audioUrl} />
        ) : (
          <ConversationAudioSkeleton />
        )}
        {audioUrl === null ? null : (
          <IconButton
            size="compact"
            className="shrink-0 text-slate-600 hover:text-slate-800"
            aria-label={t('Audio downloaden')}
            title={t('Audio downloaden')}
            aria-busy={downloading}
            disabled={downloading}
            onClick={() => void download()}
          >
            {downloading ? <Spinner size="xs" /> : <IconArrowInbox className="size-3.5" aria-hidden="true" />}
          </IconButton>
        )}
      </div>
      {downloadError ? (
        <span className="text-danger-700 text-xs" role="alert">
          {t('Audio downloaden mislukt. Probeer opnieuw.')}
        </span>
      ) : null}
    </div>
  )
}

function revinotePostProcessError(error: unknown, t: ReturnType<typeof useI18n>['t']) {
  const message = error instanceof Error ? error.message : ''
  if (message.includes('revinote-permission-required')) {
    return t('Koppel Revinote opnieuw in Instellingen om gesprekken te kunnen verwerken.')
  }
  if (message.includes('revinote-minutes-required')) {
    return t('Je hebt niet genoeg Revinote-minuten om dit gesprek te verwerken.')
  }
  if (message.includes('revinote-plan-required')) {
    return t('Je Revinote-abonnement ondersteunt deze verwerking niet.')
  }
  if (message.includes('revinote-post-process-state-unknown')) {
    return t('De status van de vorige upload is onbekend. Controleer Revinote voordat je het opnieuw probeert.')
  }
  return t('Versturen naar Revinote mislukt')
}

function useConversationRevinotePostProcess({
  dayId,
  conversation,
  offlineMode,
}: {
  dayId: string
  conversation: ConversationSummary | null
  offlineMode: boolean
}) {
  const { t } = useI18n()
  const [connection, setConnection] = useState<RevinoteConnectionStatus | null>(null)
  const [audioAvailable, setAudioAvailable] = useState(false)
  const [status, setStatus] = useState<RevinotePostProcessStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const episodeId = conversation?.episodeId
    setConnection(null)
    setAudioAvailable(false)
    setStatus(null)
    setBusy(false)
    setError(null)
    if (offlineMode || !episodeId || conversation?.source === 'revinote') return () => undefined

    void Promise.all([
      window.remember.getRevinoteConnectionStatus(),
      window.remember.getConversationAudioUrl(dayId, episodeId),
      window.remember.getRevinotePostProcessStatus(episodeId),
    ])
      .then(([nextConnection, audioUrl, nextStatus]) => {
        if (!active) return
        setConnection(nextConnection)
        setAudioAvailable(Boolean(audioUrl))
        setStatus(nextStatus)
      })
      .catch(() => {
        if (active) setAudioAvailable(false)
      })
    const unsubscribe = window.remember.onRevinoteConnectionStatus((nextConnection) => {
      if (active) setConnection(nextConnection)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [conversation, dayId, offlineMode])

  const postProcess = async () => {
    if (!conversation || busy || offlineMode || status?.state === 'queued') return
    setBusy(true)
    setError(null)
    try {
      const result = await window.remember.postProcessConversationWithRevinote(
        dayId,
        conversationReference(conversation)
      )
      setStatus({ state: 'queued', ...result })
    } catch (cause) {
      setError(revinotePostProcessError(cause, t))
    } finally {
      setBusy(false)
    }
  }

  const available =
    connection?.state === 'connected' &&
    connection.canPostProcess &&
    audioAvailable &&
    Boolean(conversation?.episodeId) &&
    status !== null

  return {
    available,
    state: (busy ? 'busy' : status?.state === 'queued' ? 'queued' : 'idle') as 'idle' | 'busy' | 'queued',
    error,
    postProcess,
  }
}

const conversationCopyStyle =
  'shrink-0 opacity-0 transition-[opacity,background-color,color] duration-150 group-hover/conversation-section:opacity-100 group-focus-within/conversation-section:opacity-100 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:opacity-100'

function ConversationDetail({
  day,
  conversation,
  revinoteState,
  revinoteError,
  onRetryRevinote,
}: {
  day: Day
  conversation: ConversationSummary
  revinoteState: 'idle' | 'busy' | 'queued'
  revinoteError: string | null
  onRetryRevinote?: () => void
}) {
  const local = useLocalBridge()
  const { dateLocale, t } = useI18n()
  const [togglingActionId, setTogglingActionId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const { pending: analysisPending, retryable } = conversationSummaryStatus(conversation, revinoteState, revinoteError)
  const processingError =
    revinoteError ??
    (conversation.processingError === 'revinote'
      ? t('Samenvatting maken mislukt')
      : conversation.processingError === 'analysis'
        ? t('Samenvatting maken mislukt')
        : conversation.processingError === 'audio'
          ? t('Audio niet beschikbaar')
          : null)
  const summaryCandidate = conversation.summary?.trim() || conversation.description.trim()
  const summary = summaryCandidate === conversation.notes?.trim() ? '' : summaryCandidate
  const actionPoints = conversationActionPointItems(conversation)
  const transcriptEntries = transcriptForConversation(day, conversation)

  async function toggleActionPoint(actionPointId: string) {
    if (togglingActionId) return
    const actionPoint = actionPoints.find((candidate) => candidate.id === actionPointId)
    if (!actionPoint) return
    const workItem = workItemForConversationActionPoint(local.workItems, conversation, actionPoint)
    if (!workItem) return

    setTogglingActionId(actionPointId)
    setActionError(null)
    try {
      const updated = await window.remember.setWorkItemLifecycle(
        workItem.id,
        workItem.lifecycle === 'open' ? 'completed' : 'open'
      )
      local.upsertWorkItem(updated)
    } catch {
      setActionError(t('Het actiepunt kon niet worden bijgewerkt. Probeer het opnieuw.'))
    } finally {
      setTogglingActionId(null)
    }
  }

  return (
    <div>
      <article className="grid gap-8">
        <header>
          <h1 className="text-balance font-display font-semibold text-slate-950 text-2xl leading-[1.15] tracking-[-0.025em]">
            {analysisPending && !conversation.title.trim() ? (
              <span className="block h-7 w-full max-w-sm animate-pulse rounded bg-slate-200 motion-reduce:animate-none">
                <span className="sr-only">{t('Gesprek verwerken')}</span>
              </span>
            ) : (
              conversation.title.trim() || t('Nieuwe meeting')
            )}
          </h1>
          <p className="mt-3 text-slate-500 text-sm">
            {formatConversationDate(day.startedAt, dateLocale)} ·{' '}
            {formatConversationTimeRange(conversation.startTime, conversation.endTime)}
          </p>
          <ConversationAudioPlayback
            dayId={day.id}
            conversation={conversation}
            pending={analysisPending && Boolean(conversation.manualMeetingId)}
          />
        </header>

        {conversation.notes?.trim() ? (
          <section className="group/conversation-section" aria-labelledby="conversation-notes-heading">
            <div className="flex min-h-6 items-center justify-between gap-3">
              <h2 id="conversation-notes-heading" className="font-medium text-slate-600 text-sm">
                {t('Snelle notities')}
              </h2>
              <CopyIcon
                value={conversation.notes}
                ariaLabel={t('Kopieer notities')}
                className={conversationCopyStyle}
              />
            </div>
            <MarkdownContent className="mt-3">{conversation.notes}</MarkdownContent>
          </section>
        ) : null}

        {analysisPending || summary || processingError ? (
          <section className="group/conversation-section" aria-labelledby="conversation-summary-heading">
            <div className="flex min-h-6 items-center justify-between gap-3">
              <h2 id="conversation-summary-heading" className="font-medium text-slate-600 text-sm">
                {t('Samenvatting')}
              </h2>
              {analysisPending || !summary ? null : (
                <CopyIcon value={summary} ariaLabel={t('Kopieer samenvatting')} className={conversationCopyStyle} />
              )}
            </div>
            {processingError || analysisPending ? (
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <p
                  className="flex min-w-0 items-center gap-2 text-slate-500 text-sm"
                  role={analysisPending ? 'status' : 'alert'}
                >
                  {analysisPending ? (
                    <Spinner size="sm" />
                  ) : (
                    <IconCloudSimpleDisconnected className="size-4 shrink-0" aria-hidden />
                  )}
                  <span>{analysisPending ? t('Samenvatting maken…') : processingError}</span>
                </p>
                {retryable && onRetryRevinote ? (
                  <Button size="small" variant="text" color="secondary" onClick={onRetryRevinote}>
                    <IconArrowRotateClockwise className="size-3.5" aria-hidden />
                    {t('Opnieuw proberen')}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {analysisPending ? (
              <ConversationProcessingLines />
            ) : summary ? (
              <MarkdownContent className="mt-3">{summary}</MarkdownContent>
            ) : null}
          </section>
        ) : null}

        {analysisPending || actionPoints.length ? (
          <section className="group/conversation-section" aria-labelledby="conversation-actions-heading">
            <div className="flex min-h-6 items-center justify-between gap-3">
              <h2 id="conversation-actions-heading" className="font-medium text-slate-600 text-sm">
                {t('Actiepunten')}
              </h2>
              {!analysisPending && actionPoints.length ? (
                <CopyIcon
                  value={actionPoints.map((action) => `- ${action.text}`).join('\n')}
                  ariaLabel={t('Kopieer actiepunten')}
                  className={conversationCopyStyle}
                />
              ) : null}
            </div>
            {analysisPending ? (
              <ConversationProcessingLines kind="actions" />
            ) : (
              <ul className="mt-2 grid gap-0.5">
                {actionPoints.map((actionPoint) => {
                  const workItem = workItemForConversationActionPoint(local.workItems, conversation, actionPoint)
                  const completed = workItem?.lifecycle !== 'open' && workItem != null
                  const toggling = togglingActionId === actionPoint.id
                  if (!workItem) {
                    return (
                      <li key={actionPoint.id} className="flex min-h-8 items-start gap-2.5 py-1 text-slate-700 text-ui">
                        <span className="mt-[0.45rem] size-1 shrink-0 rounded-full bg-slate-400" aria-hidden="true" />
                        <span className="min-w-0 leading-5">{actionPoint.text}</span>
                      </li>
                    )
                  }
                  return (
                    <li
                      key={actionPoint.id}
                      className="group -mx-2 flex min-h-9 items-stretch rounded-lg transition-colors duration-150 hover:bg-slate-100/80 motion-reduce:transition-none"
                    >
                      <button
                        type="button"
                        disabled={togglingActionId != null}
                        aria-pressed={completed}
                        aria-label={
                          completed
                            ? t('Heropen {title}', { title: actionPoint.text })
                            : t('Markeer {title} als afgerond', { title: actionPoint.text })
                        }
                        title={completed ? t('Heropenen') : t('Afronden')}
                        onClick={() => void toggleActionPoint(actionPoint.id)}
                        className="flex w-9 shrink-0 items-center justify-center rounded-l-lg outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-400 disabled:cursor-default"
                      >
                        <span
                          className={`flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors duration-150 motion-reduce:transition-none ${
                            completed
                              ? 'border-blue-700 bg-blue-700 text-white'
                              : 'border-black/[0.14] bg-white text-transparent group-hover:border-slate-400'
                          }`}
                          aria-hidden="true"
                        >
                          {toggling ? (
                            <Spinner size="xs" className={completed ? 'text-white' : 'text-slate-500'} />
                          ) : (
                            <IconCheckmark1Small className="size-3" />
                          )}
                        </span>
                      </button>
                      <Link
                        href={inboxTaskHref({ taskKey: workItem.id })}
                        className="flex min-w-0 flex-1 items-center rounded-r-lg py-2 pr-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-400"
                      >
                        <span
                          className={`min-w-0 text-ui leading-5 ${
                            completed ? 'text-slate-600 line-through decoration-slate-300' : 'text-slate-700'
                          }`}
                        >
                          {actionPoint.text}
                        </span>
                      </Link>
                    </li>
                  )
                })}
              </ul>
            )}
            {actionError ? (
              <p className="mt-2 text-danger-700 text-xs" role="alert">
                {actionError}
              </p>
            ) : null}
          </section>
        ) : null}

        {analysisPending && !transcriptEntries.length ? (
          <section aria-labelledby="conversation-transcript-heading">
            <div className="flex min-h-8 items-center">
              <h2 id="conversation-transcript-heading" className="font-medium text-slate-600 text-sm">
                {t('Transcript')}
              </h2>
            </div>
            <ConversationProcessingLines />
          </section>
        ) : (
          <Disclosure
            as="section"
            className="group/conversation-section"
            aria-labelledby="conversation-transcript-heading"
          >
            {({ open }) => (
              <>
                <div className="flex min-h-8 items-center justify-between gap-3">
                  <DisclosureButton className="relative -mx-2 flex min-h-8 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-left outline-none before:absolute before:inset-x-0 before:-inset-y-1.5 hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-slate-400">
                    <h2 id="conversation-transcript-heading" className="font-medium text-slate-600 text-sm">
                      {t('Transcript')}
                    </h2>
                    <IconChevronDownSmall
                      className={`size-3 shrink-0 text-slate-400 transition-transform duration-150 ease-out motion-reduce:transition-none ${
                        open ? 'rotate-180' : 'rotate-0'
                      }`}
                      aria-hidden="true"
                    />
                  </DisclosureButton>
                  {open && transcriptEntries.length ? (
                    <CopyIcon
                      value={transcriptEntries
                        .map((item) => (item.label ? `${t(item.label)}\n${item.text}` : item.text))
                        .join('\n\n')}
                      ariaLabel={t('Kopieer transcript')}
                      className={conversationCopyStyle}
                    />
                  ) : null}
                </div>
                <DisclosurePanel
                  transition
                  role="region"
                  aria-labelledby="conversation-transcript-heading"
                  className="origin-top pt-3 transition-[opacity,transform] duration-150 ease-out data-closed:-translate-y-1 data-closed:opacity-0 motion-reduce:transform-none motion-reduce:transition-none"
                >
                  {transcriptEntries.length ? (
                    <ol className="grid max-w-[72ch] gap-5">
                      {transcriptEntries.map((item) => (
                        <li key={item.id}>
                          {item.label ? <p className="font-medium text-slate-500 text-sm">{t(item.label)}</p> : null}
                          <MarkdownContent className={item.label ? 'mt-1' : undefined}>{item.text}</MarkdownContent>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="text-slate-500 text-ui">{t('Geen transcriptfragmenten voor dit gesprek.')}</p>
                  )}
                </DisclosurePanel>
              </>
            )}
          </Disclosure>
        )}
      </article>
    </div>
  )
}

export function DayLoadingState({
  owner = 'workday',
  pageHeader,
}: {
  owner?: 'workday' | 'conversations'
  pageHeader?: ReactNode
}) {
  const { t } = useI18n()
  return (
    <>
      {pageHeader ?? (owner === 'conversations' ? <ConversationsPageHeader /> : null)}
      <Container className="py-8 md:py-12">
        <PendingIndicator label={owner === 'conversations' ? t('Gesprekken laden') : t('Dag laden')} />
      </Container>
    </>
  )
}

function DayTabsNavigation({ day, activeTab }: { day: Day; activeTab: DayTab }) {
  const { t } = useI18n()
  const tabRefs = useRef(new Map<DayTab, HTMLAnchorElement>())

  const handleKeyDown = (event: KeyboardEvent<HTMLAnchorElement>, tab: DayTab) => {
    const currentIndex = dayTabs.findIndex((item) => item.id === tab)
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % dayTabs.length
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + dayTabs.length) % dayTabs.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = dayTabs.length - 1
    if (nextIndex == null) return

    event.preventDefault()
    const nextTab = dayTabs[nextIndex].id
    tabRefs.current.get(nextTab)?.click()
  }

  return (
    <nav
      className="-mx-0.5 -mt-2 overflow-x-auto border-slate-200 border-b [scrollbar-width:none]"
      aria-label={t('Onderdelen van de dag')}
    >
      <div className="flex w-max min-w-full gap-5" role="tablist" aria-label={t('Dagweergaven')}>
        {dayTabs.map((item) => {
          const selected = activeTab === item.id
          return (
            <Link
              key={item.id}
              href={daySectionHref(day, item.id)}
              ref={(element) => {
                if (element) tabRefs.current.set(item.id, element)
                else tabRefs.current.delete(item.id)
              }}
              id={`day-${item.id}-tab`}
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onKeyDown={(event) => handleKeyDown(event, item.id)}
              className={`relative min-h-8 shrink-0 px-0.5 font-medium text-ui outline-none transition-[color,transform] duration-150 ease-out after:pointer-events-none after:absolute after:inset-x-0.5 after:-bottom-px after:h-[2.5px] after:rounded-full after:transition-colors after:duration-150 after:content-[''] hover:text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 active:scale-[0.96] motion-reduce:transition-none motion-reduce:after:transition-none ${
                selected ? 'text-slate-900 after:bg-blue-700' : 'text-slate-500 after:bg-transparent'
              }`}
            >
              {t(item.label)}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}

export function DayDashboard({
  day,
  days,
  onRefresh,
  offlineMode,
  view,
  conversationCollection,
  conversationDestination,
  requestedConversationReference,
  timelineItemId,
}: {
  day: Day
  days: Day[]
  onRefresh: () => void | Promise<void>
  offlineMode: boolean
  view: DayRouteView
  conversationCollection: 'workday' | 'conversations'
  conversationDestination?: ReturnType<typeof conversationSpaceDestination>
  requestedConversationReference?: string
  timelineItemId?: string
}) {
  const local = useLocalBridge()
  const router = useRouter()
  const { dateLocale, t } = useI18n()
  const memory = day.memory
  const presentedMemory: DayMemory = memory ?? {
    summary: '',
    currentFocus: null,
    outcomes: [],
    decisions: [],
    openLoops: [],
    projectAttention: [],
    conversations: [],
    timeline: [],
    knowledgeSuggestions: [],
    refreshedAt: day.startedAt,
    coveredThrough: day.startedAt,
  }
  const activeTab: DayTab = view === 'conversation' ? 'conversations' : view === 'knowledge' ? 'day' : view
  const selectedConversation =
    view === 'conversation' && requestedConversationReference
      ? conversationAtReference(memory?.conversations ?? [], requestedConversationReference)
      : null
  const revinotePostProcess = useConversationRevinotePostProcess({
    dayId: day.id,
    conversation: selectedConversation,
    offlineMode,
  })
  const [isRefreshRequested, setIsRefreshRequested] = useState(false)
  const [conversationDeleteTarget, setConversationDeleteTarget] = useState<ConversationSummary | null>(null)
  const [conversationDeleteBusy, setConversationDeleteBusy] = useState(false)
  const [conversationDeleteError, setConversationDeleteError] = useState(false)
  const isRefreshing = isRefreshRequested || day.refresh.status === 'refreshing'
  const conversationListHref =
    conversationDestination?.href ??
    (conversationCollection === 'conversations' ? '/conversations/' : daySectionHref(day, 'conversations'))

  const refresh = async () => {
    if (isRefreshing || offlineMode) return

    setIsRefreshRequested(true)
    try {
      await onRefresh()
    } finally {
      setIsRefreshRequested(false)
    }
  }

  const deleteConversation = async () => {
    if (!conversationDeleteTarget || conversationDeleteBusy) return
    setConversationDeleteBusy(true)
    setConversationDeleteError(false)
    try {
      await window.remember.deleteConversation(day.id, conversationReference(conversationDeleteTarget))
      setConversationDeleteTarget(null)
      router.replace(conversationListHref)
    } catch {
      setConversationDeleteError(true)
    } finally {
      setConversationDeleteBusy(false)
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      {selectedConversation ? (
        <DashboardPageHeader>
          <DayHeader
            nestedDetail={{
              title: selectedConversation.title.trim() || t('Nieuwe meeting'),
              ancestors: conversationDestination
                ? [{ label: conversationDestination.space.name, href: wikiHomeHref(conversationDestination.space.id) }]
                : conversationCollection === 'conversations'
                  ? [{ label: t('Gesprekken'), href: conversationListHref }]
                  : [
                      { label: daySwitchLabel(day, dateLocale, t), href: dayHref(day) },
                      { label: t('Gesprekken'), href: conversationListHref },
                    ],
              wikiHref: conversationDestination?.page ? conversationDestination.href : undefined,
              deleteAction: conversationAnalysisPending(selectedConversation.processing)
                ? undefined
                : {
                    busy: conversationDeleteBusy,
                    onSelect: () => {
                      setConversationDeleteError(false)
                      setConversationDeleteTarget(selectedConversation)
                    },
                  },
              revinoteHref:
                selectedConversation.source === 'revinote' && selectedConversation.externalId
                  ? `https://www.revinote.com/app/reports/${encodeURIComponent(selectedConversation.externalId)}`
                  : undefined,
              revinoteAction:
                !offlineMode &&
                revinotePostProcess.available &&
                !conversationAnalysisPending(selectedConversation.processing)
                  ? {
                      state: revinotePostProcess.state,
                      onSelect: () => void revinotePostProcess.postProcess(),
                    }
                  : undefined,
            }}
          />
        </DashboardPageHeader>
      ) : null}

      <Container
        className={`flex grow flex-col gap-8 ${selectedConversation ? 'px-6 py-10 sm:px-10 md:py-12 lg:px-10' : 'py-8 md:py-12'}`}
      >
        {selectedConversation ? (
          <ConversationDetail
            day={day}
            conversation={selectedConversation}
            revinoteState={revinotePostProcess.state}
            revinoteError={revinotePostProcess.error}
            onRetryRevinote={revinotePostProcess.available ? () => void revinotePostProcess.postProcess() : undefined}
          />
        ) : (
          <>
            <header>
              <div>
                <DayCalendarPicker day={day} days={days} label={formatDay(day.startedAt, dateLocale)} />
                <div className="mt-1 flex items-center gap-1 text-slate-500 text-xs tabular-nums">
                  <span>
                    {memory
                      ? t('Bijgewerkt tot {time}', { time: timeLabel(memory.coveredThrough, dateLocale) })
                      : t('Nog niet bijgewerkt')}
                  </span>
                  {isLocalToday(day.startedAt) ? (
                    <IconButton
                      size="compact"
                      disabled={isRefreshing || offlineMode}
                      onClick={() => void refresh()}
                      aria-label={
                        offlineMode
                          ? t('Gepauzeerd zolang Offline mode aanstaat.')
                          : isRefreshing
                            ? t('Dag wordt bijgewerkt')
                            : t('Dag bijwerken')
                      }
                      title={
                        offlineMode
                          ? t('Gepauzeerd zolang Offline mode aanstaat.')
                          : isRefreshing
                            ? t('Wordt bijgewerkt')
                            : t('Bijwerken')
                      }
                      className={
                        offlineMode
                          ? 'disabled:cursor-not-allowed disabled:text-slate-300'
                          : 'disabled:cursor-wait disabled:text-slate-300'
                      }
                    >
                      {isRefreshing ? (
                        <Spinner size="xs" />
                      ) : (
                        <IconArrowRotateClockwise aria-hidden="true" className="size-3" />
                      )}
                    </IconButton>
                  ) : null}
                  {day.refresh.status === 'failed' && !isRefreshing && !offlineMode ? (
                    <div className="group relative flex -ml-1" role="alert">
                      <IconButton
                        size="compact"
                        tone="danger"
                        aria-label={t('Verversen is mislukt. Probeer het later opnieuw.')}
                        aria-describedby="day-refresh-error-tooltip"
                        className="hover:bg-danger-100/50"
                      >
                        <IconCloudSimpleDisconnected className="size-3" aria-hidden="true" />
                      </IconButton>
                      <span
                        id="day-refresh-error-tooltip"
                        role="tooltip"
                        className="invisible absolute top-1/2 left-full z-50 ml-1.5 w-max max-w-64 -translate-y-1/2 rounded-lg bg-white px-3 py-2 font-medium text-slate-800 text-xs opacity-0 shadow-raised transition-[opacity,visibility] duration-[125ms] ease-out group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100 motion-reduce:transition-none"
                      >
                        {t('Verversen is mislukt. Probeer het later opnieuw.')}
                      </span>
                    </div>
                  ) : null}
                </div>
              </div>
            </header>

            <DayTabsNavigation day={day} activeTab={activeTab} />

            {activeTab === 'day' ? (
              <div id="day-day-panel" role="tabpanel" aria-labelledby="day-day-tab" className="grid gap-6 pb-4">
                <section aria-labelledby="day-summary-heading">
                  <h2 id="day-summary-heading" className="font-semibold text-slate-950 text-lg">
                    {t('Overzicht')}
                  </h2>
                  {presentedMemory.summary ? (
                    <MarkdownContent className="mt-4">{presentedMemory.summary}</MarkdownContent>
                  ) : (
                    <p className="mt-4 text-slate-500 text-ui">{t('Nog geen overzicht voor deze dag.')}</p>
                  )}
                </section>
                <ProjectAttentionSection
                  items={presentedMemory.projectAttention ?? []}
                  outcomes={presentedMemory.outcomes}
                />
              </div>
            ) : null}

            {activeTab === 'conversations' ? (
              <div
                id="day-conversations-panel"
                role="tabpanel"
                aria-labelledby="day-conversations-tab"
                className="pb-4"
              >
                <ConversationsSection day={day} conversations={presentedMemory.conversations} />
              </div>
            ) : null}

            {activeTab === 'timeline' ? (
              <div id="day-timeline-panel" role="tabpanel" aria-labelledby="day-timeline-tab" className="pb-4">
                <Timeline
                  blocks={presentedMemory.timeline}
                  day={day}
                  hiddenItemIds={presentedMemory.hiddenTimelineItemIds}
                  selectedItemId={timelineItemId}
                />
              </div>
            ) : null}
          </>
        )}
      </Container>
      <Dialog
        open={Boolean(conversationDeleteTarget)}
        onClose={conversationDeleteBusy ? () => undefined : () => setConversationDeleteTarget(null)}
        className="app-no-drag relative z-50"
      >
        <DialogBackdrop
          transition
          className="fixed inset-0 bg-modal-backdrop backdrop-blur-[1px] transition-opacity data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
        />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <DialogPanel
            transition
            className="w-full max-w-sm rounded-xl bg-white p-5 shadow-raised transition-opacity data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
          >
            <header>
              <DialogTitle className="font-semibold text-slate-950 text-sm">{t('Gesprek verwijderen?')}</DialogTitle>
              <DialogDescription className="mt-2 break-words text-slate-500 text-sm">
                {conversationDeleteTarget?.title}
              </DialogDescription>
            </header>
            {conversationDeleteError ? (
              <p className="mt-3 text-danger-700 text-sm" role="alert">
                {t('Het gesprek kon niet worden verwijderd. Probeer het opnieuw.')}
              </p>
            ) : null}
            <footer className="mt-5 flex justify-end gap-2">
              <Button
                size="small"
                data-autofocus
                variant="text"
                color="secondary"
                onClick={() => setConversationDeleteTarget(null)}
                disabled={conversationDeleteBusy}
              >
                {t('Annuleren')}
              </Button>
              <Button
                size="small"
                color="danger"
                onClick={() => void deleteConversation()}
                disabled={conversationDeleteBusy}
              >
                {conversationDeleteBusy ? t('Verwijderen…') : t('Verwijderen')}
              </Button>
            </footer>
          </DialogPanel>
        </div>
      </Dialog>
    </div>
  )
}

export type DayRouteView = DayTab | 'conversation'

export function DayView({
  view,
  conversationCollection = 'workday',
}: {
  view: DayRouteView
  conversationCollection?: 'workday' | 'conversations'
}) {
  const params = useSearchParams()
  const local = useLocalBridge()
  const { t } = useI18n()
  const context = conversationSpaceContext(params)
  const destination =
    view === 'conversation'
      ? conversationSpaceDestination(context, local.wikiOverview?.spaces ?? [], local.wikiBySpace)
      : null
  const contextSpaceId = destination?.space.id
  const contextPagesLoaded = contextSpaceId ? Boolean(local.wikiBySpace[contextSpaceId]) : false
  useEffect(() => {
    if (contextSpaceId && !contextPagesLoaded) void local.selectWikiSpace(contextSpaceId).catch(() => undefined)
  }, [contextPagesLoaded, contextSpaceId, local.selectWikiSpace])

  const pageHeader = destination ? (
    <DashboardPageHeader>
      <DayHeader
        nestedDetail={{
          title: destination.page?.title ?? t('Gesprek'),
          ancestors: [{ label: destination.space.name, href: wikiHomeHref(destination.space.id) }],
          wikiHref: destination.page ? destination.href : undefined,
        }}
      />
    </DashboardPageHeader>
  ) : conversationCollection === 'conversations' ? (
    <ConversationsPageHeader />
  ) : undefined
  const activeDay = local.state?.activeSessionId
    ? local.days.find((candidate) => candidate.id === local.state?.activeSessionId)
    : undefined
  const requestedDayId = params.get('id')
  const day = requestedDayId
    ? local.days.find((candidate) => candidate.id === requestedDayId)
    : activeDay || local.days.find((candidate) => isLocalToday(candidate.startedAt))

  if (!local.ready || local.dataLoadStatus.days === 'loading')
    return <DayLoadingState owner={conversationCollection} pageHeader={pageHeader} />
  if (local.dataLoadStatus.days === 'error') {
    return (
      <DashboardLoadError
        title={conversationCollection === 'conversations' ? t('Gesprekken') : t('Werkdagen')}
        message={
          conversationCollection === 'conversations'
            ? t('Gesprekken konden niet worden geladen.')
            : t('Werkdagen konden niet worden geladen.')
        }
        onRetry={local.refresh}
        pageHeader={pageHeader}
      />
    )
  }
  if (!day)
    return (
      <>
        {pageHeader}
        <Container className="py-10 text-slate-500 text-ui">
          {conversationCollection === 'conversations'
            ? t('Gesprek niet gevonden.')
            : requestedDayId
              ? t('Dag niet gevonden.')
              : t('Vandaag verschijnt zodra het vastleggen begint.')}
        </Container>
      </>
    )

  const refresh = async () => {
    await window.remember.refreshDay(day.id)
    await local.refresh()
  }

  const requestedConversation = params.get('conversation') ?? undefined
  if (
    view === 'conversation' &&
    requestedConversation &&
    !conversationAtReference(day.memory?.conversations ?? [], requestedConversation)
  ) {
    return (
      <>
        {pageHeader}
        <Container className="py-10 text-slate-500 text-ui">{t('Gesprek niet gevonden.')}</Container>
      </>
    )
  }
  const requestedTimelineAt = Number(params.get('timelineAt'))
  const requestedTimelineItem =
    params.get('timelineItem') ??
    (Number.isFinite(requestedTimelineAt) && requestedTimelineAt > 0
      ? timelineItemAt(day, requestedTimelineAt)
      : undefined)

  return (
    <DayDashboard
      key={`${day.id}-${view}-${requestedConversation ?? ''}-${requestedTimelineItem ?? ''}`}
      day={day}
      days={local.days}
      onRefresh={refresh}
      offlineMode={local.settings?.offlineMode === true}
      view={view}
      conversationCollection={conversationCollection}
      conversationDestination={destination}
      requestedConversationReference={requestedConversation}
      timelineItemId={requestedTimelineItem}
    />
  )
}
