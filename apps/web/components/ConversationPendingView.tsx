'use client'

import { Menu, MenuButton, MenuItem } from '@headlessui/react'
import {
  ConversationAudioSkeleton,
  ConversationProcessingLines,
} from '@internal/components/ConversationProcessingState'
import { DashboardPageHeader } from '@internal/components/DashboardPageHeader'
import { conversationsConversationHref } from '@internal/components/dayNavigation'
import { conversationForManualMeeting } from '@internal/components/manualMeetingConversation'
import { useLocalBridge } from '@internal/context/LocalBridgeProvider'
import { useI18n } from '@internal/locales'
import { Button } from '@internal/ui/Button'
import { Container } from '@internal/ui/Container'
import { DropdownMenuItems, dropdownItemStyle } from '@internal/ui/Dropdown'
import { IconButton } from '@internal/ui/IconButton'
import type { ManualMeeting } from '@remember/shared'
import { Ellipsis as IconDotGrid1x3HorizontalTight, FileText as IconFileText } from 'lucide-react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { BreadcrumbSeparator } from './BreadcrumbSeparator'
import { formatConversationDate } from './conversationDate'
import {
  conversationSpaceContext,
  conversationSpaceDestination,
  readManualMeetingSpaceContext,
  withConversationSpaceContext,
} from './conversationSpaceContext'
import { wikiHomeHref } from './wikiRoutes'

const PENDING_CONVERSATION_TIMEOUT_MS = 15_000

function ConversationPendingState({
  failed,
  onRetry,
  onBack,
  destination,
  meeting,
}: {
  failed: boolean
  onRetry: () => void
  onBack: () => void
  destination: ReturnType<typeof conversationSpaceDestination>
  meeting: ManualMeeting | null
}) {
  const { dateLocale, t } = useI18n()
  const recording = meeting?.status === 'recording'
  const title = destination?.page?.title.trim() || meeting?.title.trim() || t('Gesprek')
  const startedAt = meeting && Number.isFinite(meeting.startedAt) ? meeting.startedAt : null

  return (
    <div
      className="flex min-h-full flex-col"
      role={failed || recording ? undefined : 'status'}
      aria-label={failed || recording ? undefined : t('Gesprek verwerken')}
    >
      <DashboardPageHeader>
        <div className="flex min-h-[43px] items-center border-slate-200 border-b pr-2 pl-3">
          <nav aria-label={t('Kruimelpad')} className="min-w-0 flex-1 overflow-hidden">
            <ol className="flex min-w-0 items-center text-slate-800 text-sm">
              <li className="min-w-0">
                <Link
                  href={destination ? wikiHomeHref(destination.space.id) : '/conversations/'}
                  className="flex h-7 max-w-full items-center rounded-md px-2 font-medium outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-400"
                >
                  <span className="truncate">{destination?.space.name ?? t('Gesprekken')}</span>
                </Link>
              </li>
              <BreadcrumbSeparator />
              <li aria-current="page" className="min-w-0 truncate px-2 font-medium">
                {title}
              </li>
            </ol>
          </nav>
          {destination?.page ? (
            <Menu>
              <MenuButton as={IconButton} aria-label={t('Meer opties voor {title}', { title })}>
                <IconDotGrid1x3HorizontalTight className="size-3.5" aria-hidden="true" />
              </MenuButton>
              <DropdownMenuItems anchor="bottom end" className="mt-1 w-64 origin-top-right">
                <MenuItem>
                  <Link href={destination.href} className={dropdownItemStyle}>
                    <IconFileText className="size-3.5" aria-hidden="true" />
                    {t('Gekoppeld document openen')}
                  </Link>
                </MenuItem>
              </DropdownMenuItems>
            </Menu>
          ) : null}
        </div>
      </DashboardPageHeader>
      <Container className="grow px-6 py-10 sm:px-10 md:py-12 lg:px-10">
        {recording ? (
          <article>
            <h1 className="text-balance font-display font-semibold text-2xl text-slate-950 leading-[1.15] tracking-[-0.025em]">
              {title}
            </h1>
            {startedAt !== null ? (
              <p className="mt-3 text-slate-500 text-sm">
                {formatConversationDate(startedAt, dateLocale)} ·{' '}
                {new Date(startedAt).toLocaleTimeString(dateLocale, { hour: '2-digit', minute: '2-digit' })}
              </p>
            ) : null}
            <p className="mt-3 text-slate-600 text-sm" role="status">
              {meeting.pausedAt != null ? t('Opname gepauzeerd') : t('Opname loopt')}
            </p>
          </article>
        ) : failed ? (
          <article className="pb-6">
            <h1 className="font-semibold text-2xl text-slate-950 tracking-tight">{t('Gesprek nog niet klaar')}</h1>
            <div className="mt-8">
              <p className="max-w-xl text-slate-600 text-sm leading-6" role="alert">
                {destination
                  ? t('Remember kon het verwerkte gesprek nog niet vinden. Probeer het opnieuw.')
                  : t(
                      'Remember kon het verwerkte gesprek nog niet vinden. Probeer het opnieuw of ga terug naar Gesprekken.'
                    )}
              </p>
              <div className="mt-5 flex flex-wrap items-center gap-2">
                <Button size="small" onClick={onRetry}>
                  {t('Probeer opnieuw')}
                </Button>
                <Button size="small" variant="outline" color="secondary" onClick={onBack}>
                  {destination
                    ? t('Terug naar {title}', { title: destination.page?.title ?? destination.space.name })
                    : t('Terug naar Gesprekken')}
                </Button>
              </div>
            </div>
          </article>
        ) : (
          <article className="grid gap-8">
            <header>
              <h1 className="h-7 w-full max-w-sm animate-pulse rounded bg-slate-200 motion-reduce:animate-none">
                <span className="sr-only">{t('Gesprek verwerken')}</span>
              </h1>
              <div
                className="mt-3 h-5 w-48 animate-pulse rounded bg-slate-200 motion-reduce:animate-none"
                aria-hidden="true"
              />
              <div className="mt-3" aria-hidden="true">
                <ConversationAudioSkeleton />
              </div>
            </header>
            <section>
              <h2 className="font-medium text-slate-600 text-sm">{t('Samenvatting')}</h2>
              <div aria-hidden="true">
                <ConversationProcessingLines />
              </div>
            </section>
            <section>
              <h2 className="font-medium text-slate-600 text-sm">{t('Actiepunten')}</h2>
              <div aria-hidden="true">
                <ConversationProcessingLines kind="actions" />
              </div>
            </section>
            <section>
              <div className="flex min-h-8 items-center">
                <h2 className="font-medium text-slate-600 text-sm">{t('Transcript')}</h2>
              </div>
              <div aria-hidden="true">
                <ConversationProcessingLines />
              </div>
            </section>
          </article>
        )}
      </Container>
    </div>
  )
}

export function ConversationPendingView() {
  const local = useLocalBridge()
  const router = useRouter()
  const searchParams = useSearchParams()
  const meetingId = searchParams.get('meeting')
  const context = useMemo(
    () => conversationSpaceContext(searchParams) ?? (meetingId ? readManualMeetingSpaceContext(meetingId) : null),
    [meetingId, searchParams]
  )
  const destination = conversationSpaceDestination(context, local.wikiOverview?.spaces ?? [], local.wikiBySpace)
  const accessibleContext = destination ? context : null
  const contextSpaceId = destination?.space.id
  const contextPagesLoaded = contextSpaceId ? Boolean(local.wikiBySpace[contextSpaceId]) : false
  const waitingForSpace = Boolean(context && !local.wikiOverview && local.dataLoadStatus.wiki === 'loading')
  const returnHref = destination?.href ?? '/conversations/'
  const [lookup, setLookup] = useState({ attempt: 0, failedMeetingId: null as string | null })
  const resolved = useMemo(
    () => (meetingId ? conversationForManualMeeting(local.days, meetingId) : null),
    [local.days, meetingId]
  )
  const meetingStillActive = local.state?.manualMeeting?.id === meetingId
  const meeting = meetingStillActive ? (local.state?.manualMeeting ?? null) : null

  useEffect(() => {
    if (contextSpaceId && !contextPagesLoaded) void local.selectWikiSpace(contextSpaceId).catch(() => undefined)
  }, [contextPagesLoaded, contextSpaceId, local.selectWikiSpace])

  useEffect(() => {
    if (!local.ready || waitingForSpace) return
    if (!meetingId) {
      router.replace(returnHref)
      return
    }
    if (resolved) {
      router.replace(
        withConversationSpaceContext(
          conversationsConversationHref(resolved.day, resolved.conversation),
          accessibleContext
        )
      )
      return
    }
    if (meetingStillActive) return
    const bridge = local.bridge
    let stopped = false
    let failureTimer: number | null = null

    const stopPolling = () => {
      stopped = true
      if (failureTimer !== null) window.clearTimeout(failureTimer)
    }

    const failLookup = () => {
      if (stopped) return
      stopPolling()
      setLookup((current) =>
        current.attempt === lookup.attempt ? { ...current, failedMeetingId: meetingId } : current
      )
    }

    const resolveConversation = async () => {
      if (!bridge || stopped) return
      try {
        const snapshot = await bridge.listDaySnapshot()
        if (stopped) return
        local.acceptDaySnapshot(snapshot)
        const match = conversationForManualMeeting(snapshot.days, meetingId)
        if (match) {
          stopPolling()
          router.replace(
            withConversationSpaceContext(
              conversationsConversationHref(match.day, match.conversation),
              accessibleContext
            )
          )
          return
        }
      } catch {
        if (stopped) return
      }
    }

    failureTimer = window.setTimeout(failLookup, PENDING_CONVERSATION_TIMEOUT_MS)
    void resolveConversation()
    return stopPolling
  }, [
    accessibleContext,
    local.acceptDaySnapshot,
    local.bridge,
    local.ready,
    lookup.attempt,
    meetingId,
    meetingStillActive,
    resolved,
    returnHref,
    router,
    waitingForSpace,
  ])

  const retry = () => {
    setLookup((current) => ({ attempt: current.attempt + 1, failedMeetingId: null }))
  }

  return (
    <ConversationPendingState
      failed={lookup.failedMeetingId === meetingId}
      onRetry={retry}
      onBack={() => router.replace(returnHref)}
      destination={destination}
      meeting={meeting}
    />
  )
}
