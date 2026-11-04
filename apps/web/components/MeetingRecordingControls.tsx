'use client'

import { manualMeetingPendingHref } from '@internal/components/manualMeetingConversation'
import { useLocalBridge } from '@internal/context/LocalBridgeProvider'
import { useI18n } from '@internal/locales'
import { IconButton } from '@internal/ui/IconButton'
import type { ManualMeeting } from '@remember/shared'
import { X as IconCrossSmall } from 'lucide-react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import {
  captureManualMeetingSourceContext,
  clearManualMeetingSpaceContext,
  conversationSpaceContext,
  readManualMeetingSpaceContext,
  withConversationSpaceContext,
} from './conversationSpaceContext'
import { RecordingControls } from './RecordingControls'
import { discardableManualMeetingSource, discardedManualMeetingSourceUpdate } from './spaceConversation'
import { useRecordingClock } from './useRecordingClock'
import { wikiHomeHref } from './wikiRoutes'

function isMeetingPaused(meeting: ManualMeeting) {
  return meeting.status === 'recording' && meeting.pausedAt != null
}

function MeetingRecordingControl({
  meeting,
  onStopStarted,
  onStopFailed,
  onDiscarded,
}: {
  meeting: ManualMeeting
  onStopStarted?: (meeting: ManualMeeting) => void
  onStopFailed?: (meeting: ManualMeeting) => void
  onDiscarded?: (meeting: ManualMeeting, sourceContext: ReturnType<typeof captureManualMeetingSourceContext>) => void
}) {
  const { acceptState, bridge } = useLocalBridge()
  const { t } = useI18n()
  const router = useRouter()
  const [stopping, setStopping] = useState(false)
  const [stopRequestedAt, setStopRequestedAt] = useState<number | null>(null)
  const [discarding, setDiscarding] = useState(false)
  const [pausing, setPausing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const paused = isMeetingPaused(meeting)
  const { duration, running } = useRecordingClock(meeting, stopRequestedAt)

  async function stop() {
    if (!bridge || stopping || discarding || pausing) return
    setStopping(true)
    setStopRequestedAt(Date.now())
    setError(null)
    onStopStarted?.(meeting)
    try {
      const next = await bridge.stopManualMeeting(meeting.id)
      acceptState(next)
    } catch {
      onStopFailed?.(meeting)
      setError(t('De opname kon niet worden gestopt.'))
      setStopping(false)
      setStopRequestedAt(null)
    }
  }

  async function togglePause() {
    if (!bridge || stopping || discarding || pausing) return
    setPausing(true)
    setError(null)
    try {
      const next = paused ? await bridge.resumeManualMeeting(meeting.id) : await bridge.pauseManualMeeting(meeting.id)
      acceptState(next)
    } catch {
      setError(paused ? t('De opname kon niet worden hervat.') : t('De opname kon niet worden gepauzeerd.'))
    } finally {
      setPausing(false)
    }
  }

  async function discard() {
    if (!bridge || stopping || discarding || pausing) return
    setDiscarding(true)
    setStopRequestedAt(Date.now())
    setError(null)
    const sourceContext = captureManualMeetingSourceContext(meeting.id)
    try {
      const next = await bridge.discardManualMeeting(meeting.id)
      acceptState(next)
      onDiscarded?.(meeting, sourceContext)
    } catch {
      setError(t('De opname kon niet worden verwijderd.'))
      setDiscarding(false)
      setStopRequestedAt(null)
    }
  }

  return (
    <RecordingControls
      duration={duration}
      running={running}
      active={!stopping && !discarding}
      busy={stopping || discarding || pausing}
      error={error}
      onPause={togglePause}
      onStop={stop}
      onDiscard={discard}
      onOpenConversation={() =>
        router.push(withConversationSpaceContext('/conversations/live/', readManualMeetingSpaceContext(meeting.id)))
      }
    />
  )
}

export function ManualMeetingFloatingControl() {
  const local = useLocalBridge()
  const { t } = useI18n()
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const meeting = local.state?.manualMeeting ?? null
  const [endingMeeting, setEndingMeeting] = useState<ManualMeeting | null>(null)
  const [cleanupError, setCleanupError] = useState(false)
  const stopReturnHref = useRef('/conversations/')
  const visibleMeeting = meeting?.status === 'recording' ? meeting : endingMeeting

  useEffect(() => {
    if (endingMeeting && pathname.startsWith('/conversations/pending')) setEndingMeeting(null)
  }, [endingMeeting, pathname])

  function beginFinishingRecording(finishedMeeting: ManualMeeting) {
    const query = searchParams.toString()
    stopReturnHref.current = query ? `${pathname}?${query}` : pathname
    setEndingMeeting(finishedMeeting)
    const origin = readManualMeetingSpaceContext(finishedMeeting.id)
    const context = local.wikiOverview?.spaces.some((space) => space.id === origin?.spaceId) ? origin : null
    router.push(manualMeetingPendingHref(finishedMeeting.id, context))
  }

  function restoreAfterStopFailure() {
    setEndingMeeting(null)
    router.replace(stopReturnHref.current)
  }

  async function clearFinishingRecording(
    discardedMeeting: ManualMeeting,
    sourceContext: ReturnType<typeof captureManualMeetingSourceContext>
  ) {
    setEndingMeeting(null)
    setCleanupError(false)
    const origin = sourceContext.origin ?? conversationSpaceContext(searchParams)
    const space = local.wikiOverview?.spaces.find((candidate) => candidate.id === origin?.spaceId)
    if (pathname.startsWith('/conversations/pending') && searchParams.get('meeting') === discardedMeeting.id) {
      router.replace(space ? wikiHomeHref(space.id) : '/conversations/')
    }
    try {
      const context = await sourceContext.resolve()
      if (!local.bridge || !space || context?.spaceId !== space.id) return
      for (let attempt = 0; attempt < 2; attempt++) {
        const pages = await local.bridge.listWikiPages(space.id)
        const currentContext = await sourceContext.resolve()
        const deletion = discardableManualMeetingSource(discardedMeeting.id, currentContext, pages)
        const update = deletion
          ? null
          : discardedManualMeetingSourceUpdate(discardedMeeting.id, currentContext, pages, t('Opname weggegooid'))
        try {
          if (deletion) await local.deleteWikiPage(deletion)
          else if (update) await local.saveWikiPage(update)
          break
        } catch (error) {
          if (/wiki-page-not-found/.test(String(error))) break
          if (attempt === 0 && /wiki-page-(?:conflict|has-children)/.test(String(error))) continue
          throw error
        }
      }
    } catch {
      setCleanupError(true)
    } finally {
      clearManualMeetingSpaceContext(discardedMeeting.id)
    }
  }

  return (
    <>
      {visibleMeeting && !pathname.startsWith('/conversations/live') ? (
        <MeetingRecordingControl
          meeting={visibleMeeting}
          onStopStarted={beginFinishingRecording}
          onStopFailed={restoreAfterStopFailure}
          onDiscarded={clearFinishingRecording}
        />
      ) : null}
      {cleanupError ? (
        <div
          role="alert"
          className="app-no-drag fixed bottom-5 left-1/2 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-lg bg-white px-3 py-2 text-danger-700 text-sm shadow-raised ring-1 ring-black/[0.06]"
        >
          <p>{t('De opname is verwijderd, maar de gekoppelde pagina kon niet worden bijgewerkt.')}</p>
          <IconButton size="compact" onClick={() => setCleanupError(false)} aria-label={t('Sluiten')}>
            <IconCrossSmall className="size-4" aria-hidden="true" />
          </IconButton>
        </div>
      ) : null}
    </>
  )
}
