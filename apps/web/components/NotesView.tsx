'use client'

import { DashboardContentHeader } from '@internal/components/DashboardContentHeader'
import { useLocalBridge } from '@internal/context/LocalBridgeProvider'
import { getDictationBridge } from '@internal/lib/dictationBridge'
import { formatAccelerator } from '@internal/lib/dictationShortcut'
import { useI18n } from '@internal/locales'
import { Button } from '@internal/ui/Button'
import { Container } from '@internal/ui/Container'
import { CopyIcon } from '@internal/ui/CopyIcon'
import { IconButton } from '@internal/ui/IconButton'
import { PendingIndicator } from '@internal/ui/PendingIndicator'
import { Spinner } from '@internal/ui/Spinner'
import type { DictationBridge, DictationNote, DictationState } from '@remember/shared'
import {
  Inbox as IconArrowInbox,
  RotateCw as IconArrowRotateClockwise,
  Mic as IconMicrophone,
  Square as IconStop,
  Trash2 as IconTrashCan,
} from 'lucide-react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ConversationEmptyState } from './ConversationEmptyState'
import { ConversationTabs } from './ConversationTabs'
import { formatConversationDate } from './conversationDate'
import { DictationPreferences } from './DictationPreferences'

export function NotesView() {
  const { t, dateLocale } = useI18n()
  const local = useLocalBridge()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [state, setState] = useState<DictationState | null>(null)
  const [notes, setNotes] = useState<DictationNote[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [reload, setReload] = useState(0)
  const [actionError, setActionError] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [visibleCount, setVisibleCount] = useState(50)
  const [preferencesOpen, setPreferencesOpen] = useState(false)
  const showPreferences = preferencesOpen || searchParams.get('preferences') === '1'
  const targetNoteId = searchParams.get('noteId')
  const focusedNoteId = useRef<string | null>(null)
  const targetIndex = notes?.findIndex((note) => note.id === targetNoteId) ?? -1
  const displayedCount = Math.max(visibleCount, targetIndex + 1)
  const groups = useMemo(() => {
    const byDate = new Map<number, DictationNote[]>()
    for (const note of notes?.slice(0, displayedCount) ?? []) {
      const date = new Date(note.createdAt).setHours(0, 0, 0, 0)
      const items = byDate.get(date) ?? []
      items.push(note)
      byDate.set(date, items)
    }
    return [...byDate].map(([date, items]) => ({ date, items }))
  }, [notes, displayedCount])

  useEffect(() => {
    if (reload > 0) setNotes(null)
    const bridge = getDictationBridge()
    if (!bridge) {
      setLoadError(true)
      return
    }
    let active = true
    let receivedState = false
    let receivedHistory = false
    setLoadError(false)
    const unsubscribeState = bridge.onState((value) => {
      receivedState = true
      setState(value)
    })
    const unsubscribeHistory = bridge.onHistory((value) => {
      receivedHistory = true
      setNotes(value)
    })
    void Promise.all([bridge.getState(), bridge.getHistory()])
      .then(([state, notes]) => {
        if (!active) return
        if (!receivedState) setState(state)
        if (!receivedHistory) setNotes(notes)
      })
      .catch(() => {
        if (active) setLoadError(true)
      })
    return () => {
      active = false
      unsubscribeState()
      unsubscribeHistory()
    }
  }, [reload])

  useEffect(() => {
    if (!targetNoteId || targetIndex < 0) {
      focusedNoteId.current = null
      return
    }
    if (focusedNoteId.current === targetNoteId) return
    const target = document.getElementById(`note-${targetNoteId}`)
    if (!target) return
    target.scrollIntoView({ block: 'center' })
    target.focus({ preventScroll: true })
    focusedNoteId.current = targetNoteId
  }, [targetNoteId, targetIndex])

  const recording = state?.status === 'recording'
  const processing = state?.status === 'starting' || state?.status === 'transcribing'
  const captureBusy = recording || processing

  function changePreferences(open: boolean) {
    setPreferencesOpen(open)
    if (!open && searchParams.has('preferences')) {
      const query = new URLSearchParams(searchParams.toString())
      query.delete('preferences')
      router.replace(`/notes/${query.size ? `?${query}` : ''}`, { scroll: false })
    }
  }

  async function act(key: string, action: (bridge: DictationBridge) => Promise<unknown>) {
    if (busy) return
    setBusy(key)
    setActionError(false)
    try {
      const bridge = getDictationBridge()
      if (!bridge) throw new Error('dictation-unavailable')
      await action(bridge)
    } catch {
      setActionError(true)
    } finally {
      setBusy(null)
    }
  }

  async function download(note: DictationNote) {
    const audio = await getDictationBridge()?.downloadNote(note.id)
    if (!audio) throw new Error('dictation-audio-unavailable')
    const url = URL.createObjectURL(new Blob([audio], { type: 'audio/wav' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `note-${new Date(note.createdAt).toISOString().replaceAll(':', '-')}.wav`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <Container className="flex grow flex-col gap-7 py-8 md:py-12">
      <DashboardContentHeader
        title={t('Gesprekken')}
        action={
          <span className="flex items-center gap-2">
            <DictationPreferences open={showPreferences} onOpenChange={changePreferences} />
            <Button
              size="small"
              variant={recording ? 'solid' : 'outline'}
              color={recording ? 'primary' : 'secondary'}
              disabled={!state || processing || busy !== null}
              onClick={() => {
                if (!state?.modelReady) {
                  changePreferences(true)
                  return
                }
                void act('record', (bridge) => bridge.toggle())
              }}
            >
              {processing ? (
                <Spinner size="xs" />
              ) : recording ? (
                <IconStop className="size-4" />
              ) : (
                <IconMicrophone className="size-4" />
              )}
              {recording ? t('Stop opname') : processing ? t('Verwerken…') : t('Dicteren')}
              {!captureBusy && local.settings?.dictation.enabled && local.settings.dictation.shortcut ? (
                <kbd className="hidden font-normal text-slate-400 text-xs sm:inline">
                  {formatAccelerator(local.settings.dictation.shortcut)}
                </kbd>
              ) : null}
            </Button>
          </span>
        }
      />
      <ConversationTabs active="notes" />
      {targetNoteId && notes !== null && !loadError && targetIndex < 0 ? (
        <p className="text-slate-500 text-sm" role="status" data-note-unavailable={targetNoteId}>
          {t('Deze notitie is niet meer beschikbaar.')}
        </p>
      ) : null}
      {actionError ? (
        <p className="text-danger-700 text-sm" role="alert">
          {t('Dit is niet gelukt. Probeer opnieuw.')}
        </p>
      ) : null}
      {loadError ? (
        <div className="flex min-h-64 flex-col items-center justify-center px-6 text-center">
          <p role="alert" className="max-w-sm text-pretty text-slate-600 text-sm">
            {t('Notities konden niet worden geladen.')}
          </p>
          <Button
            size="small"
            variant="outline"
            color="secondary"
            className="mt-4"
            onClick={() => setReload((value) => value + 1)}
          >
            {t('Probeer opnieuw')}
          </Button>
        </div>
      ) : notes === null ? (
        <PendingIndicator label={t('Notities laden')} />
      ) : notes.length === 0 ? (
        <ConversationEmptyState title={t('Nog geen notities')} description={t('Je dictaties verschijnen hier.')} />
      ) : (
        <>
          <div id="note-history" className="grid gap-7">
            {groups.map((group) => (
              <section key={group.date} aria-labelledby={`notes-${group.date}`} className="grid gap-2">
                <h2 id={`notes-${group.date}`} className="px-1 font-semibold text-slate-500 text-sm">
                  {formatConversationDate(group.date, dateLocale)}
                </h2>
                <ol className="divide-y divide-slate-100 overflow-hidden rounded-xl bg-white shadow-raised">
                  {group.items.map((note) => (
                    <li key={note.id}>
                      <article
                        id={`note-${note.id}`}
                        data-note-id={note.id}
                        tabIndex={-1}
                        className="group outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-400 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 p-3 sm:grid-cols-[96px_minmax(0,1fr)_auto]"
                      >
                        <time
                          dateTime={new Date(note.createdAt).toISOString()}
                          title={new Intl.DateTimeFormat(dateLocale, { dateStyle: 'full', timeStyle: 'short' }).format(
                            note.createdAt
                          )}
                          className="col-start-1 row-start-1 whitespace-nowrap pt-0.5 font-medium text-slate-500 text-xs tabular-nums"
                        >
                          {new Intl.DateTimeFormat(dateLocale, {
                            hour: '2-digit',
                            minute: '2-digit',
                            hourCycle: 'h23',
                          }).format(note.createdAt)}
                        </time>
                        <div className="col-span-2 col-start-1 row-start-2 min-w-0 sm:col-span-1 sm:col-start-2 sm:row-start-1">
                          {note.status === 'completed' ? (
                            <p className="whitespace-pre-wrap break-words font-sans font-normal text-slate-800 text-ui leading-6">
                              {note.text}
                            </p>
                          ) : (
                            <p className="flex items-center gap-2 text-slate-500 text-ui leading-5" role="status">
                              {note.status === 'processing' ? (
                                <>
                                  <Spinner size="xs" />
                                  {t('Verwerken…')}
                                </>
                              ) : note.error === 'no-speech' ? (
                                t('Geen spraak gehoord.')
                              ) : (
                                t('Deze opname is nog niet uitgeschreven.')
                              )}
                            </p>
                          )}
                        </div>
                        <div
                          className={`col-start-2 row-start-1 flex min-h-6 items-center justify-end gap-2 opacity-100 transition-opacity duration-150 group-focus-within:opacity-100 sm:col-start-3 md:group-hover:opacity-100 motion-reduce:transition-none ${deleting === note.id || busy === note.id ? '' : 'md:opacity-0'}`}
                        >
                          {deleting === note.id ? (
                            <>
                              <Button size="small" variant="text" color="secondary" onClick={() => setDeleting(null)}>
                                {t('Annuleren')}
                              </Button>
                              <Button
                                size="small"
                                color="danger"
                                disabled={captureBusy || busy !== null}
                                onClick={() =>
                                  void act(note.id, async (bridge) => {
                                    await bridge.deleteNote(note.id)
                                    setDeleting(null)
                                  })
                                }
                              >
                                {t('Verwijderen')}
                              </Button>
                            </>
                          ) : (
                            <>
                              {note.status === 'failed' && note.hasAudio ? (
                                <IconButton
                                  size="compact"
                                  aria-label={t('Notitie opnieuw verwerken')}
                                  title={t('Notitie opnieuw verwerken')}
                                  disabled={captureBusy || busy !== null}
                                  onClick={() => void act(note.id, (bridge) => bridge.retryNote(note.id))}
                                >
                                  <IconArrowRotateClockwise className="size-4" />
                                </IconButton>
                              ) : null}
                              {note.text ? <CopyIcon value={note.text} ariaLabel={t('Notitie kopiëren')} /> : null}
                              {note.hasAudio ? (
                                <IconButton
                                  size="compact"
                                  aria-label={t('Audio downloaden')}
                                  title={t('Audio downloaden')}
                                  disabled={busy !== null}
                                  onClick={() => void act(note.id, () => download(note))}
                                >
                                  <IconArrowInbox className="size-4" />
                                </IconButton>
                              ) : null}
                              <IconButton
                                size="compact"
                                aria-label={t('Notitie verwijderen')}
                                title={t('Notitie verwijderen')}
                                disabled={captureBusy || busy !== null}
                                onClick={() => setDeleting(note.id)}
                              >
                                <IconTrashCan className="size-4" />
                              </IconButton>
                            </>
                          )}
                        </div>
                      </article>
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </div>
          {notes.length > displayedCount ? (
            <div className="flex justify-center">
              <Button
                size="small"
                variant="outline"
                color="secondary"
                aria-controls="note-history"
                onClick={() => setVisibleCount(displayedCount + 50)}
              >
                {t('Meer laden')}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </Container>
  )
}
