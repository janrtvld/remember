'use client'

import { useI18n } from '@internal/locales'
import type { AudioMoment, CaptureState } from '@remember/shared'
import { Check as IconCheckmark1Small, Info as IconCircleInfo } from 'lucide-react'
import { useMemo, useState } from 'react'
import { formatConversationTimeRange } from './conversationDate'
import { microphoneHeaderStatus } from './microphoneHeaderStatus'

const AUDIO_HISTORY_PAGE_SIZE = 5

function formatTime(timestamp: number, locale: 'en-US' | 'nl-NL') {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(timestamp)
}

export function MicrophoneStatusLabel({ captureState }: { captureState: CaptureState }) {
  const { t } = useI18n()
  const status = microphoneHeaderStatus(captureState)
  const label =
    status === 'active'
      ? t('Actief')
      : status === 'connecting'
        ? t('Wordt verbonden')
        : status === 'permission-denied'
          ? t('Microfoontoegang ontbreekt')
          : status === 'stale'
            ? t('Geen recente audio')
            : status === 'paused'
              ? t('Gepauzeerd')
              : t('Niet actief')

  return (
    <span className="flex shrink-0 items-center gap-1 font-medium text-slate-500 text-xs">
      <span>{label}</span>
      {(status === 'active' || status === 'stale') && captureState.microphoneName ? (
        <span className="group relative flex">
          <button
            type="button"
            aria-label={t('Actieve microfoon: {microphone}', { microphone: captureState.microphoneName })}
            className="relative flex size-5 items-center justify-center rounded-md text-slate-400 outline-none before:absolute before:-inset-1 hover:bg-slate-100 hover:text-slate-600 focus-visible:ring-2 focus-visible:ring-slate-400"
          >
            <IconCircleInfo className="size-3.5" aria-hidden="true" />
          </button>
          <span
            role="tooltip"
            className="invisible absolute top-full right-0 z-30 mt-1.5 w-max max-w-64 rounded-lg bg-white px-3 py-2 font-medium text-slate-800 text-xs opacity-0 shadow-raised transition-[opacity,visibility] duration-[125ms] ease-out group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100 motion-reduce:transition-none"
          >
            {captureState.microphoneName}
          </span>
        </span>
      ) : null}
    </span>
  )
}

export function audioHistoryMoments(days: Array<{ moments: AudioMoment[] }>) {
  return days
    .flatMap((day) => day.moments)
    .filter((moment) => moment.status !== 'empty' && (moment.status !== 'ready' || moment.transcript.trim()))
}

interface AudioHistorySelection {
  isSelectable: (moment: AudioMoment) => boolean
  isChecked: (moment: AudioMoment) => boolean
  isDisabled: (moment: AudioMoment) => boolean
  onToggle: (moment: AudioMoment) => void
}

export function AudioHistory({
  moments,
  captureState,
  selection,
}: {
  moments: AudioMoment[]
  captureState: CaptureState
  selection?: AudioHistorySelection
}) {
  const { dateLocale, t } = useI18n()
  const [visibleCount, setVisibleCount] = useState(AUDIO_HISTORY_PAGE_SIZE)
  const orderedMoments = useMemo(() => moments.slice().sort((a, b) => b.startedAt - a.startedAt), [moments])
  const visibleMoments = orderedMoments.slice(0, visibleCount)
  const remainingCount = orderedMoments.length - visibleMoments.length
  const nextLoadCount = Math.min(AUDIO_HISTORY_PAGE_SIZE, remainingCount)

  return (
    <section aria-labelledby="audio-history-title" className="overflow-hidden rounded-xl bg-white shadow-raised">
      <div className="flex min-h-12 items-center justify-between gap-3 border-slate-100 border-b px-4">
        <h2 id="audio-history-title" className="font-semibold text-slate-900 text-md">
          {t('Fragmenten')}
        </h2>
        <MicrophoneStatusLabel captureState={captureState} />
      </div>
      {orderedMoments.length ? (
        <ol id="audio-history-moments" className="divide-y divide-slate-100">
          {visibleMoments.map((moment) => {
            const inputId = `audio-history-${moment.id}`
            const selectable = selection?.isSelectable(moment) ?? false
            const checked = selectable && Boolean(selection?.isChecked(moment))
            const disabled = selectable && Boolean(selection?.isDisabled(moment))
            const detail =
              moment.status === 'transcribing'
                ? t('Audio wordt lokaal verwerkt…')
                : moment.status === 'failed'
                  ? t('Audio kon niet worden getranscribeerd.')
                  : moment.transcript
            const content = (
              <>
                {selectable ? (
                  <>
                    <input
                      id={inputId}
                      type="checkbox"
                      className="peer sr-only"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => selection?.onToggle(moment)}
                    />
                    <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border border-black/[0.12] bg-white text-transparent transition-[background-color,border-color,color] duration-150 group-hover:border-slate-300 peer-checked:border-blue-700 peer-checked:bg-blue-700 peer-checked:text-white motion-reduce:transition-none">
                      <IconCheckmark1Small className="size-3.5" aria-hidden="true" />
                    </span>
                  </>
                ) : null}
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-3 text-xs">
                    <span className="font-medium text-slate-600">
                      {moment.source === 'microphone' ? t('Microfoon') : t('Systeemaudio')}
                    </span>
                    <time className="text-slate-600 tabular-nums" dateTime={new Date(moment.startedAt).toISOString()}>
                      <span className="sr-only">
                        {t('Opnamefragment van {start} tot {end}', {
                          start: formatTime(moment.startedAt, dateLocale),
                          end: formatTime(moment.startedAt + moment.durationMs, dateLocale),
                        })}
                      </span>
                      <span aria-hidden="true">
                        {formatConversationTimeRange(
                          formatTime(moment.startedAt, dateLocale),
                          formatTime(moment.startedAt + moment.durationMs, dateLocale)
                        )}
                      </span>
                    </time>
                  </span>
                  <span
                    className={`mt-1 line-clamp-3 block text-pretty text-sm leading-[1.55] ${
                      moment.status === 'failed' ? 'text-danger-700' : 'text-slate-600'
                    }`}
                  >
                    {detail}
                  </span>
                </span>
              </>
            )
            return (
              <li key={moment.id}>
                {selectable ? (
                  <label
                    htmlFor={inputId}
                    className="group flex min-h-16 w-full min-w-0 cursor-pointer items-start gap-3 px-4 py-3 outline-none has-disabled:cursor-not-allowed has-disabled:opacity-45 has-focus-visible:ring-2 has-focus-visible:ring-inset has-focus-visible:ring-slate-400 hover:bg-slate-50"
                  >
                    {content}
                  </label>
                ) : (
                  <div className="flex min-h-16 min-w-0 items-start px-4 py-3">{content}</div>
                )}
              </li>
            )
          })}
        </ol>
      ) : (
        <div className="flex min-h-40 flex-col items-center justify-center px-6 text-center">
          <p className="font-medium text-slate-800 text-ui">{t('Nog geen bruikbare audiofragmenten')}</p>
          <p className="mt-1 text-pretty text-slate-500 text-xs">
            {t('De nieuwste getranscribeerde gesprekken verschijnen hier.')}
          </p>
        </div>
      )}
      {remainingCount > 0 ? (
        <footer className="border-slate-100 border-t">
          <button
            type="button"
            aria-controls="audio-history-moments"
            onClick={() => setVisibleCount((current) => current + AUDIO_HISTORY_PAGE_SIZE)}
            className="flex h-10 w-full items-center justify-center font-medium text-slate-500 text-sm outline-none transition-[background-color,color] duration-150 ease-out hover:bg-slate-50 hover:text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-slate-400 motion-reduce:transition-none"
          >
            {t('{count} meer laden', { count: nextLoadCount })}
          </button>
        </footer>
      ) : null}
    </section>
  )
}
