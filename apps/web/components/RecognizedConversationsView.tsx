'use client'

import { DashboardContentHeader } from '@internal/components/DashboardContentHeader'
import { useLocalBridge } from '@internal/context/LocalBridgeProvider'
import { useI18n } from '@internal/locales'
import { Button } from '@internal/ui/Button'
import { Container } from '@internal/ui/Container'
import { IconButton } from '@internal/ui/IconButton'
import { PendingIndicator } from '@internal/ui/PendingIndicator'
import { Spinner } from '@internal/ui/Spinner'
import type { ConversationCandidate, Day } from '@remember/shared'
import { Check as IconCheckmark1Small, Merge as IconMergedSimple } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'
import { twMerge } from 'tailwind-merge'
import { ConversationEmptyState } from './ConversationEmptyState'
import { ConversationPreferences } from './ConversationPreferences'
import { useConversationStartControls } from './ConversationStartControls'
import { ConversationsView } from './ConversationsView'
import { ConversationTabs } from './ConversationTabs'
import { formatConversationDate } from './conversationDate'
import { DashboardLoadError } from './DashboardLoadError'
import { ListContextMenu } from './ListContextMenu'
import { useListSelection } from './useListSelection'

type RecognizedItem = { day: Day; candidate: ConversationCandidate }

function startOfLocalDay(timestamp: number) {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function clockTime(timestamp: number, locale: 'en-US' | 'nl-NL') {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(timestamp)
}

function providerName(provider: string | null, fallback: string) {
  switch (provider) {
    case 'woub':
      return 'Woub'
    case 'google-meet':
      return 'Google Meet'
    case 'microsoft-teams':
      return 'Microsoft Teams'
    case 'slack-huddle':
      return 'Slack'
    case 'facetime':
      return 'FaceTime'
    case 'discord':
      return 'Discord'
    case 'zoom':
      return 'Zoom'
    default:
      return fallback
  }
}

function mergeableDayId(items: RecognizedItem[]) {
  const counts = new Map<string, number>()
  for (const item of items) {
    const count = (counts.get(item.day.id) ?? 0) + 1
    if (count >= 2) return item.day.id
    counts.set(item.day.id, count)
  }
  return null
}

export function RecognizedConversationsView() {
  const local = useLocalBridge()
  const router = useRouter()
  useEffect(() => {
    if (local.settings?.audioCaptureEnabled === false) router.replace('/conversations/')
  }, [local.settings?.audioCaptureEnabled, router])
  const { dateLocale, t } = useI18n()
  const [busyEpisodeIds, setBusyEpisodeIds] = useState<string[]>([])
  const listRef = useRef<HTMLDivElement>(null)
  const [combineDayId, setCombineDayId] = useState<string | null>(null)
  const [combining, setCombining] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const conversationStart = useConversationStartControls()
  const groups = useMemo(() => {
    const byDate = new Map<number, RecognizedItem[]>()
    for (const day of local.days) {
      const date = startOfLocalDay(day.startedAt)
      const items = byDate.get(date) ?? []
      for (const candidate of day.conversationCandidates ?? []) items.push({ day, candidate })
      if (items.length) byDate.set(date, items)
    }
    return [...byDate.entries()]
      .map(([date, items]) => ({
        date,
        items: items.sort((left, right) => right.candidate.startedAt - left.candidate.startedAt),
      }))
      .sort((left, right) => right.date - left.date)
  }, [local.days])

  const items = useMemo(() => groups.flatMap((group) => group.items), [groups])
  const itemIds = useMemo(() => items.map((item) => item.candidate.episodeId), [items])
  const selection = useListSelection(itemIds, listRef, combineDayId === null)
  const mergeIds = useMemo(
    () => items.filter((item) => item.day.id === combineDayId).map((item) => item.candidate.episodeId),
    [combineDayId, items]
  )
  const mergeSelection = useListSelection(mergeIds, listRef, combineDayId !== null)
  const selectedEpisodeIds = mergeSelection.selectedIds
  const selectedItems = items.filter((item) => selection.selectedSet.has(item.candidate.episodeId))

  async function decide(targets: RecognizedItem[], decision: 'save' | 'dismiss') {
    if (!local.bridge || busyEpisodeIds.length || combining) return
    setBusyEpisodeIds(targets.map((item) => item.candidate.episodeId))
    setError(null)
    let failed = false
    for (const item of targets) {
      try {
        // Saving separately must not merge unrelated selected conversations.
        if (decision === 'save') await local.bridge.recoverConversation(item.day.id, [item.candidate.episodeId])
        else await local.bridge.dismissConversationCandidate(item.day.id, item.candidate.episodeId)
      } catch {
        failed = true
      }
    }
    if (failed) setError(decision === 'save' ? t('Gesprek bewaren mislukt.') : t('Gesprek negeren mislukt.'))
    else selection.clear()
    setBusyEpisodeIds([])
  }

  function toggleCombineMode(dayId: string) {
    if (combining || busyEpisodeIds.length) return
    selection.clear()
    setCombineDayId((current) => (current === dayId ? null : dayId))
    mergeSelection.clear()
    setError(null)
  }

  function toggleSelection(item: RecognizedItem) {
    setError(null)
    mergeSelection.toggle(item.candidate.episodeId)
  }

  async function combineSelected() {
    if (!local.bridge || !combineDayId || selectedEpisodeIds.length < 2) return
    setCombining(true)
    setError(null)
    try {
      await local.bridge.recoverConversation(combineDayId, selectedEpisodeIds)
      mergeSelection.clear()
      setCombineDayId(null)
    } catch {
      setError(t('Herkende gesprekken samenvoegen mislukt.'))
    } finally {
      setCombining(false)
    }
  }

  if (local.settings?.audioCaptureEnabled === false) return <ConversationsView />

  if (!local.ready || local.dataLoadStatus.days === 'loading') {
    return (
      <Container className="flex grow flex-col gap-7 py-8 md:py-12">
        <DashboardContentHeader title={t('Gesprekken')} />
        <ConversationTabs active="recognized" />
        <PendingIndicator label={t('Gesprekken laden')} />
      </Container>
    )
  }
  if (local.dataLoadStatus.days === 'error') {
    return (
      <DashboardLoadError
        title={t('Gesprekken')}
        message={t('Gesprekken konden niet worden geladen.')}
        onRetry={local.refresh}
      />
    )
  }

  return (
    <Container className="flex grow flex-col gap-7 py-8 md:py-12">
      <DashboardContentHeader
        title={t('Gesprekken')}
        action={
          <span className="flex items-center gap-2">
            <ConversationPreferences />
            {conversationStart.action}
          </span>
        }
      />
      <ConversationTabs active="recognized" />
      {conversationStart.feedback}
      {error ? (
        <p className="text-danger-700 text-xs" role="alert">
          {error}
        </p>
      ) : null}
      {groups.length ? (
        <div ref={listRef} className="grid gap-7">
          {groups.map((group) => {
            const headingId = `recognized-conversations-${group.date}`
            const groupMergeableDayId = mergeableDayId(group.items)
            const groupCombineMode = groupMergeableDayId !== null && combineDayId === groupMergeableDayId
            return (
              <section key={group.date} aria-labelledby={headingId} className="grid gap-2">
                <div className="flex items-center gap-1 px-1">
                  <h2 id={headingId} className="font-semibold text-slate-500 text-sm">
                    {formatConversationDate(group.date, dateLocale)}
                  </h2>
                  {groupMergeableDayId ? (
                    <IconButton
                      size="compact"
                      aria-label={t('Gesprekken samenvoegen')}
                      title={t('Gesprekken samenvoegen')}
                      aria-pressed={groupCombineMode}
                      disabled={combining || Boolean(busyEpisodeIds.length)}
                      onClick={() => toggleCombineMode(groupMergeableDayId)}
                      className={`-my-1 shrink-0 ${groupCombineMode ? 'bg-blue-100/70 text-blue-700' : ''}`}
                    >
                      <IconMergedSimple className="size-3.5" aria-hidden="true" />
                    </IconButton>
                  ) : null}
                </div>
                {groupCombineMode ? (
                  <div className="flex min-h-11 items-center justify-end gap-1 rounded-xl bg-white p-2 pl-3 shadow-raised">
                    <span className="mr-auto font-medium text-slate-700 text-sm tabular-nums">
                      {selectedEpisodeIds.length
                        ? t('{count} geselecteerd', { count: selectedEpisodeIds.length })
                        : t('Nog niets geselecteerd')}
                    </span>
                    <Button
                      size="small"
                      variant="text"
                      color="secondary"
                      disabled={combining || Boolean(busyEpisodeIds.length)}
                      onClick={() => toggleCombineMode(groupMergeableDayId)}
                    >
                      {t('Annuleer')}
                    </Button>
                    <Button
                      size="small"
                      disabled={combining || selectedEpisodeIds.length < 2}
                      onClick={() => void combineSelected()}
                    >
                      {combining ? <Spinner size="xs" /> : null}
                      {combining ? t('Samenvoegen…') : t('Samenvoegen en bewaren')}
                    </Button>
                  </div>
                ) : null}
                <ol className="divide-y divide-slate-100 overflow-hidden rounded-xl bg-white shadow-raised">
                  {group.items.map((item) => {
                    const { candidate } = item
                    const busy = busyEpisodeIds.includes(candidate.episodeId)
                    const marked = selection.selectedSet.has(candidate.episodeId)
                    const contextItems = marked ? selectedItems : [item]
                    const checked = selectedEpisodeIds.includes(candidate.episodeId)
                    const selectionDisabled = combining
                    const content = (
                      <>
                        <span className="self-start whitespace-nowrap pt-0.5 font-medium text-slate-500 text-xs tabular-nums">
                          {clockTime(candidate.startedAt, dateLocale)} → {clockTime(candidate.endedAt, dateLocale)}
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="truncate font-medium text-slate-900 text-ui leading-5">
                            {candidate.title.trim() || providerName(candidate.provider, t('Gesprek'))}
                          </span>
                          <span className="line-clamp-2 text-pretty text-slate-500 text-xs leading-[18px]">
                            {candidate.description.trim() || candidate.preview}
                          </span>
                        </span>
                      </>
                    )
                    if (groupCombineMode && item.day.id === groupMergeableDayId) {
                      return (
                        <li key={candidate.episodeId}>
                          <label className="group grid min-w-0 cursor-pointer grid-cols-[auto_96px_minmax(0,1fr)] items-center gap-3 p-3 outline-none has-disabled:cursor-not-allowed has-disabled:opacity-45 has-focus-visible:ring-2 has-focus-visible:ring-inset has-focus-visible:ring-slate-400">
                            <input
                              type="checkbox"
                              className="peer sr-only"
                              checked={checked}
                              disabled={selectionDisabled}
                              onChange={() => toggleSelection(item)}
                            />
                            <span className="flex size-5 shrink-0 items-center justify-center rounded-md border border-black/[0.12] bg-white text-transparent transition-[background-color,border-color,color] duration-150 group-hover:border-slate-300 peer-checked:border-blue-700 peer-checked:bg-blue-700 peer-checked:text-white motion-reduce:transition-none">
                              <IconCheckmark1Small className="size-3.5" aria-hidden="true" />
                            </span>
                            {content}
                          </label>
                        </li>
                      )
                    }
                    return (
                      <li key={candidate.episodeId}>
                        <ListContextMenu<HTMLDivElement>
                          label={t('Gesprekken')}
                          onOpen={() => {
                            if (combineDayId) toggleCombineMode(combineDayId)
                            selection.selectForContext(candidate.episodeId)
                          }}
                          actions={[
                            {
                              label: t('Bewaren'),
                              disabled: Boolean(busyEpisodeIds.length) || combining,
                              onSelect: () => void decide(contextItems, 'save'),
                            },
                            {
                              label: t('Niet bewaren'),
                              disabled: Boolean(busyEpisodeIds.length) || combining,
                              onSelect: () => void decide(contextItems, 'dismiss'),
                            },
                          ]}
                        >
                          {(contextProps) => (
                            <div
                              {...contextProps}
                              tabIndex={-1}
                              role="group"
                              aria-label={candidate.title.trim() || t('Gesprek')}
                              aria-description={marked ? t('Geselecteerd') : undefined}
                              className={twMerge(
                                'group grid min-w-0 grid-cols-[96px_minmax(0,1fr)_auto] items-center gap-3 p-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-400 max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:[&>span:first-child]:col-span-2',
                                marked && 'bg-slate-100/80'
                              )}
                              onClick={(event) => {
                                if ((event.target as Element).closest('button, input, label')) return
                                if (!selection.click(event, candidate.episodeId))
                                  selection.selectForContext(candidate.episodeId)
                              }}
                              onKeyDown={(event) => {
                                contextProps.onKeyDown?.(event)
                                if (event.target !== event.currentTarget || ![' ', 'Enter'].includes(event.key)) return
                                event.preventDefault()
                                selection.selectForContext(candidate.episodeId)
                              }}
                            >
                              {content}
                              <span className="flex items-center gap-1">
                                <Button
                                  size="small"
                                  variant="text"
                                  color="secondary"
                                  disabled={Boolean(busyEpisodeIds.length) || combining}
                                  onClick={() => void decide([item], 'dismiss')}
                                >
                                  {t('Niet bewaren')}
                                </Button>
                                <Button
                                  size="small"
                                  disabled={Boolean(busyEpisodeIds.length) || combining}
                                  onClick={() => void decide([item], 'save')}
                                >
                                  {busy ? <Spinner size="xs" /> : null}
                                  {t('Bewaren')}
                                </Button>
                              </span>
                            </div>
                          )}
                        </ListContextMenu>
                      </li>
                    )
                  })}
                </ol>
              </section>
            )
          })}
        </div>
      ) : (
        <ConversationEmptyState
          title={t('Geen herkende gesprekken')}
          description={t('Door Remember herkende gesprekken verschijnen hier om te bewaren of te negeren.')}
        />
      )}
    </Container>
  )
}
