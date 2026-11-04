'use client'

import { BreadcrumbSeparator } from '@internal/components/BreadcrumbSeparator'
import { useConversationStartControls } from '@internal/components/ConversationStartControls'
import { readManualMeetingSpaceContext } from '@internal/components/conversationSpaceContext'
import { DashboardContentHeader } from '@internal/components/DashboardContentHeader'
import { DashboardPageHeader } from '@internal/components/DashboardPageHeader'
import { manualMeetingPendingHref } from '@internal/components/manualMeetingConversation'
import { MeetingDetailsWriter } from '@internal/components/meetingDetailsWriter'
import { RecordingControls } from '@internal/components/RecordingControls'
import { useRecordingClock } from '@internal/components/useRecordingClock'
import { useLocalBridge } from '@internal/context/LocalBridgeProvider'
import { Container } from '@internal/ui/Container'
import type { ManualMeeting } from '@remember/shared'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'

export function LiveConversation() {
  const local = useLocalBridge()
  const conversationStart = useConversationStartControls()
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [endingMeeting, setEndingMeeting] = useState<ManualMeeting | null>(null)
  const meeting = local.state?.manualMeeting ?? endingMeeting
  const [title, setTitle] = useState('Nieuw gesprek')
  const titleBeforeEdit = useRef('Nieuw gesprek')
  const [stopRequestedAt, setStopRequestedAt] = useState<number | null>(null)
  const [notes, setNotes] = useState('')
  const [pending, setPending] = useState(false)
  const initialized = useRef<string | null>(null)
  const phase = !meeting
    ? 'idle'
    : meeting?.status !== 'recording'
      ? 'ended'
      : meeting.pausedAt
        ? 'paused'
        : 'recording'
  const { duration, running } = useRecordingClock(meeting ?? null, stopRequestedAt)
  const meetingId = meeting?.id
  const bridge = local.bridge
  const detailsWriter = useMemo(
    () =>
      meetingId && bridge
        ? new MeetingDetailsWriter(
            ({ title, notes }) => bridge.updateManualMeetingDetails(meetingId, title, notes),
            setSaveError
          )
        : null,
    [meetingId, bridge]
  )

  useEffect(() => {
    router.prefetch('/conversations/pending/')
    router.prefetch('/conversations/conversation/')
  }, [router])

  useEffect(
    () => () => {
      void detailsWriter?.flush().catch(() => {})
    },
    [detailsWriter]
  )

  useEffect(() => {
    if (!meeting || initialized.current === meeting.id) return
    initialized.current = meeting.id
    setTitle(meeting.title || 'Nieuw gesprek')
    setNotes(meeting.notes)
  }, [meeting])

  function saveDetails(nextTitle: string, nextNotes: string) {
    detailsWriter?.update(nextTitle, nextNotes)
  }

  async function pause() {
    if (!meeting || !local.bridge || pending || saving) return
    setPending(true)
    try {
      const state = await (running
        ? local.bridge.pauseManualMeeting(meeting.id)
        : local.bridge.resumeManualMeeting(meeting.id))
      local.acceptState(state)
    } catch {
      setSaveError(true)
    } finally {
      setPending(false)
    }
  }

  async function reset() {
    if (!meeting || !local.bridge || saving) return
    setSaving(true)
    setStopRequestedAt(Date.now())
    try {
      detailsWriter?.cancelPending()
      local.acceptState(await local.bridge.discardManualMeeting(meeting.id))
      router.push('/conversations/')
    } catch {
      setSaveError(true)
      setSaving(false)
      setStopRequestedAt(null)
    }
  }

  async function finish() {
    if (saving || !local.bridge || !meeting) return
    const requestedAt = Date.now()
    setSaving(true)
    setStopRequestedAt(requestedAt)
    setEndingMeeting({ ...meeting, title, notes, endedAt: requestedAt, status: 'processing' })
    setSaveError(false)
    try {
      detailsWriter?.cancelPending()
      local.acceptState(await local.bridge.stopManualMeeting(meeting.id, { title, notes }))
      router.replace(manualMeetingPendingHref(meeting.id, readManualMeetingSpaceContext(meeting.id)))
    } catch {
      setSaveError(true)
      setSaving(false)
      setStopRequestedAt(null)
      setEndingMeeting(null)
    }
  }

  const starting = !local.ready || conversationStart.starting
  const active = (phase === 'recording' || phase === 'paused') && !saving && !starting
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <DashboardPageHeader>
        <div className="flex min-h-[43px] items-center border-slate-200 border-b pr-2 pl-3">
          <nav aria-label="Kruimelpad" className="min-w-0 flex-1 overflow-hidden">
            <ol className="flex min-w-0 items-center text-slate-800 text-sm">
              <li className="min-w-0">
                <button
                  type="button"
                  onClick={() => router.push('/conversations/')}
                  className="flex h-7 max-w-full items-center rounded-md px-2 font-medium outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-400"
                >
                  Gesprekken
                </button>
              </li>
              <BreadcrumbSeparator />
              <li aria-current="page" className="min-w-0 truncate px-2 font-medium">
                {title.trim() || 'Nieuw gesprek'}
              </li>
            </ol>
          </nav>
        </div>
      </DashboardPageHeader>
      <div className="flex min-h-0 flex-1">
        <Container className="relative flex min-h-0 flex-1 flex-col pt-5 pb-24 md:pt-8">
          <DashboardContentHeader
            className="min-h-0"
            title={
              <textarea
                rows={1}
                aria-label="Gesprekstitel"
                title="Titel wijzigen"
                disabled={!active}
                value={title}
                maxLength={120}
                autoComplete="off"
                onFocus={() => {
                  titleBeforeEdit.current = title
                }}
                onChange={(event) => {
                  const value = event.target.value.replace(/[\r\n]+/g, ' ')
                  setTitle(value)
                  saveDetails(value, notes)
                }}
                onBlur={() => setTitle((value) => value.trim() || 'Nieuw gesprek')}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    event.currentTarget.blur()
                  }
                  if (event.key === 'Escape') {
                    setTitle(titleBeforeEdit.current)
                    saveDetails(titleBeforeEdit.current, notes)
                    event.currentTarget.blur()
                  }
                }}
                className="block w-full min-w-0 resize-none overflow-hidden bg-transparent outline-none field-sizing-content"
              />
            }
          />
          <textarea
            aria-label="Gespreksnotities"
            placeholder="Schrijf je notities…"
            disabled={!active}
            value={notes}
            maxLength={100_000}
            onChange={(event) => {
              setNotes(event.target.value)
              saveDetails(title, event.target.value)
            }}
            className="mt-2 min-h-24 w-full flex-1 resize-none bg-transparent text-sm leading-7 outline-none placeholder:text-slate-400"
          />
          {conversationStart.feedback}
          {saveError && (
            <p role="alert" className="mt-2 text-sm text-danger-700">
              Dat lukte niet. Je invoer staat er nog; probeer opnieuw.
            </p>
          )}
        </Container>
      </div>
      {!meeting && !starting && !saving ? (
        conversationStart.action
      ) : (
        <RecordingControls
          duration={duration}
          running={running}
          active={active}
          busy={starting || saving || pending || phase === 'ended'}
          error={saveError ? 'Dat lukte niet. Probeer opnieuw.' : null}
          onPause={pause}
          onStop={finish}
          onDiscard={reset}
        />
      )}
    </div>
  )
}
