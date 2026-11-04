'use client'

import { MicrophoneStatusLabel } from '@internal/components/AudioHistory'
import { DashboardContentHeader } from '@internal/components/DashboardContentHeader'
import { DashboardPageFooter } from '@internal/components/DashboardPageFooter'
import { useLocalBridge } from '@internal/context/LocalBridgeProvider'
import { useI18n } from '@internal/locales'
import { Button } from '@internal/ui/Button'
import { Container } from '@internal/ui/Container'
import { PendingIndicator } from '@internal/ui/PendingIndicator'
import { Spinner } from '@internal/ui/Spinner'
import { Check as IconCheckmark1Small } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'
import { ConversationEmptyState } from './ConversationEmptyState'
import { ConversationPreferences } from './ConversationPreferences'
import { useConversationStartControls } from './ConversationStartControls'
import { ConversationTabs } from './ConversationTabs'
import { conversationActivityItems, toggleConversationActivitySelection } from './conversationActivity'
import { formatConversationDate, formatConversationTimeRange } from './conversationDate'
import { DashboardLoadError } from './DashboardLoadError'

const CONVERSATION_ACTIVITY_PAGE_SIZE = 10

function clockTime(timestamp: number, locale: 'en-US' | 'nl-NL') {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(timestamp)
}

export function ConversationActivityView() {
  const local = useLocalBridge()
  const router = useRouter()
  const { dateLocale, t } = useI18n()
  const items = useMemo(() => conversationActivityItems(local.days), [local.days])
  const [visibleCount, setVisibleCount] = useState(CONVERSATION_ACTIVITY_PAGE_SIZE)
  const [selectedMomentIds, setSelectedMomentIds] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const conversationStart = useConversationStartControls()
  const momentDayById = useMemo(() => new Map(items.map((item) => [item.moment.id, item.dayId])), [items])
  const selectedDayId = selectedMomentIds.length ? momentDayById.get(selectedMomentIds[0] as string) : null
  const visibleItems = items.slice(0, visibleCount)
  const remainingCount = items.length - visibleItems.length
  const nextLoadCount = Math.min(CONVERSATION_ACTIVITY_PAGE_SIZE, remainingCount)

  function toggle(momentId: string, dayId: string) {
    if (saving || (selectedDayId && dayId !== selectedDayId)) return
    setError(null)
    setSelectedMomentIds((current) => toggleConversationActivitySelection(current, momentId))
  }

  async function createConversation() {
    if (!local.bridge || !selectedDayId || !selectedMomentIds.length || saving) return
    setSaving(true)
    setError(null)
    try {
      await local.bridge.recoverAudio(selectedDayId, selectedMomentIds)
      setSelectedMomentIds([])
      router.push('/conversations/')
    } catch {
      setError(t('Gesprek maken mislukt.'))
    } finally {
      setSaving(false)
    }
  }

  if (!local.ready || !local.state || local.dataLoadStatus.days === 'loading') {
    return (
      <Container className="flex grow flex-col gap-7 py-8 md:py-12">
        <DashboardContentHeader title={t('Gesprekken')} />
        <ConversationTabs active="activity" />
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
    <Container className="flex grow flex-col gap-7 pt-8 pb-28 md:pt-12">
      <DashboardContentHeader
        title={t('Gesprekken')}
        action={
          <span className="flex items-center gap-2">
            <ConversationPreferences />
            {conversationStart.action}
          </span>
        }
      />
      <ConversationTabs active="activity" />
      {conversationStart.feedback}
      {items.length ? (
        <section
          aria-labelledby="conversation-audio-activity-title"
          className="overflow-hidden rounded-xl bg-white shadow-raised"
        >
          <div className="flex min-h-12 shrink-0 items-center justify-between gap-3 border-slate-100 border-b px-4">
            <h2 id="conversation-audio-activity-title" className="font-semibold text-slate-900 text-md">
              {t('Fragmenten')}
            </h2>
            <MicrophoneStatusLabel captureState={local.state} />
          </div>
          <ol id="conversation-audio-activity-items" className="divide-y divide-slate-100">
            {visibleItems.map((item, index) => {
              const { moment } = item
              const inputId = `conversation-activity-${moment.id}`
              const checked = selectedMomentIds.includes(moment.id)
              const selectable = item.retained && moment.status === 'ready' && Boolean(moment.transcript.trim())
              const disabled = !selectable || saving || Boolean(selectedDayId && item.dayId !== selectedDayId)
              const detail =
                moment.status === 'transcribing'
                  ? t('Audio wordt lokaal verwerkt…')
                  : moment.status === 'failed'
                    ? t('Audio kon niet worden getranscribeerd.')
                    : moment.transcript || t('Spraak zonder betrouwbare transcriptie.')

              return (
                <li key={moment.id}>
                  {index === 0 || visibleItems[index - 1]?.dayId !== item.dayId ? (
                    <div className="border-slate-100 border-b px-4 py-2 font-medium text-slate-500 text-xs">
                      {formatConversationDate(moment.startedAt, dateLocale)}
                    </div>
                  ) : null}
                  <label
                    htmlFor={inputId}
                    className="group relative flex min-h-16 w-full min-w-0 cursor-pointer items-start gap-3 px-4 py-3 outline-none has-disabled:cursor-not-allowed has-focus-visible:ring-2 has-focus-visible:ring-inset has-focus-visible:ring-slate-400 hover:bg-slate-50"
                  >
                    <input
                      id={inputId}
                      type="checkbox"
                      className="peer sr-only"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => toggle(moment.id, item.dayId)}
                    />
                    <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border border-black/[0.12] bg-white text-transparent transition-[background-color,border-color,color] duration-150 group-hover:border-slate-300 peer-checked:border-blue-700 peer-checked:bg-blue-700 peer-checked:text-white peer-disabled:opacity-40 motion-reduce:transition-none">
                      <IconCheckmark1Small className="size-3.5" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-3 text-xs">
                        <span className="font-medium text-slate-600">
                          {moment.source === 'microphone' ? t('Microfoon') : t('Systeemaudio')}
                        </span>
                        <time
                          className="shrink-0 text-slate-600 tabular-nums"
                          dateTime={new Date(moment.startedAt).toISOString()}
                        >
                          {formatConversationTimeRange(
                            clockTime(moment.startedAt, dateLocale),
                            clockTime(moment.startedAt + moment.durationMs, dateLocale)
                          )}
                        </time>
                      </span>
                      <span
                        className={`mt-1 line-clamp-3 text-pretty text-sm leading-[1.55] ${moment.status === 'failed' ? 'text-danger-700' : 'text-slate-600'}`}
                      >
                        {detail}
                      </span>
                      {!item.retained && moment.status !== 'transcribing' ? (
                        <span className="mt-1 block text-slate-400 text-xs">{t('Audio niet meer beschikbaar')}</span>
                      ) : null}
                    </span>
                  </label>
                </li>
              )
            })}
          </ol>
          {remainingCount > 0 ? (
            <div className="border-slate-100 border-t">
              <button
                type="button"
                aria-controls="conversation-audio-activity-items"
                onClick={() =>
                  setVisibleCount((current) => Math.min(current + CONVERSATION_ACTIVITY_PAGE_SIZE, items.length))
                }
                className="flex h-10 w-full items-center justify-center font-medium text-slate-500 text-sm outline-none transition-[background-color,color] duration-150 ease-out hover:bg-slate-50 hover:text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-slate-400 motion-reduce:transition-none"
              >
                {t('{count} meer laden', { count: nextLoadCount })}
              </button>
            </div>
          ) : null}
          {selectedMomentIds.length ? (
            <DashboardPageFooter>
              <Container className="py-4">
                <div className="pointer-events-auto flex flex-wrap items-center justify-end gap-1 rounded-xl bg-white p-2 pl-3 shadow-raised">
                  {error ? (
                    <span className="mr-auto text-danger-700 text-xs" role="alert">
                      {error}
                    </span>
                  ) : (
                    <span className="mr-auto font-medium text-slate-700 text-sm tabular-nums" role="status">
                      {t('{count} geselecteerd', { count: selectedMomentIds.length })}
                    </span>
                  )}
                  <Button
                    size="small"
                    variant="text"
                    color="secondary"
                    disabled={saving}
                    onClick={() => {
                      setSelectedMomentIds([])
                      setError(null)
                    }}
                  >
                    {t('Wissen')}
                  </Button>
                  <Button size="small" disabled={saving} onClick={() => void createConversation()}>
                    {saving ? <Spinner size="xs" /> : null}
                    {t('Maak gesprek')}
                  </Button>
                </div>
              </Container>
            </DashboardPageFooter>
          ) : null}
        </section>
      ) : (
        <ConversationEmptyState
          title={t('Nog geen audioactiviteit')}
          description={t('Microfoon- en systeemaudio verschijnen hier zodra Remember ze lokaal heeft verwerkt.')}
          status={<MicrophoneStatusLabel captureState={local.state} />}
        />
      )}
    </Container>
  )
}
