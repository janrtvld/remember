'use client'

import { DashboardContentHeader } from '@internal/components/DashboardContentHeader'
import { useLocalBridge } from '@internal/context/LocalBridgeProvider'
import { useI18n } from '@internal/locales'
import { Container } from '@internal/ui/Container'
import { IconButton } from '@internal/ui/IconButton'
import { type AppUsage, type Day, summarizeAppUsage } from '@remember/shared'
import {
  ChevronDown as IconChevronDownSmall,
  ChevronLeft as IconChevronLeft,
  ChevronRight as IconChevronRight,
  Info as IconCircleInfo,
  AppWindow as IconWindowApp,
} from 'lucide-react'
import Image from 'next/image'
import { useEffect, useMemo, useState } from 'react'
import { ActivitiesLoadingState } from './ActivitiesLoadingState'
import { AudioHistory, audioHistoryMoments } from './AudioHistory'
import { DashboardLoadError } from './DashboardLoadError'

const PROCESS_LIKE_APP_NAME = /^[a-z0-9._-]+$/

function formatDuration(milliseconds: number, locale: 'en-US' | 'nl-NL') {
  if (milliseconds > 0 && milliseconds < 60_000) return '<1m'
  const totalMinutes = Math.max(0, Math.round(milliseconds / 60_000))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return hours ? `${hours}${locale === 'nl-NL' ? 'u' : 'h'}\u00a0${minutes}m` : `${minutes}m`
}

function startOfLocalDay(timestamp: number) {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date
}

function calendarDayDifference(laterTimestamp: number, earlierTimestamp: number) {
  const later = new Date(laterTimestamp)
  const earlier = new Date(earlierTimestamp)
  const laterDay = Date.UTC(later.getFullYear(), later.getMonth(), later.getDate())
  const earlierDay = Date.UTC(earlier.getFullYear(), earlier.getMonth(), earlier.getDate())
  return Math.round((laterDay - earlierDay) / 86_400_000)
}

function dayLabel(dayOffset: number, timestamp: number, locale: 'en-US' | 'nl-NL', t: ReturnType<typeof useI18n>['t']) {
  if (dayOffset === 0) return t('Vandaag')
  if (dayOffset === 1) return t('Gisteren')
  return new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' }).format(timestamp)
}

function useAppIcons(apps: AppUsage[]) {
  const [icons, setIcons] = useState<Record<string, string>>({})

  useEffect(() => {
    const bundleIds = apps.map((app) => app.bundleId).filter(Boolean)
    if (!bundleIds.length) return
    let active = true
    void window.remember.getAppIcons(bundleIds).then((nextIcons) => {
      if (active) setIcons(nextIcons)
    })
    return () => {
      active = false
    }
  }, [apps])

  return icons
}

function DaySwitcher({
  dayOffset,
  selectedTimestamp,
  maxDayOffset,
  onChange,
}: {
  dayOffset: number
  selectedTimestamp: number
  maxDayOffset: number
  onChange: (offset: number) => void
}) {
  const { dateLocale, t } = useI18n()
  return (
    <div className="flex items-center gap-0.5" role="group" aria-label={t('Kies een activiteitsdag')}>
      <IconButton
        aria-label={t('Vorige dag')}
        disabled={dayOffset >= maxDayOffset}
        className="disabled:text-slate-300"
        onClick={() => onChange(Math.min(dayOffset + 1, maxDayOffset))}
      >
        <IconChevronLeft className="size-3.5" aria-hidden="true" />
      </IconButton>
      <p className="min-w-20 max-w-40 truncate px-1 text-center font-medium text-slate-700 text-sm">
        {dayLabel(dayOffset, selectedTimestamp, dateLocale, t)}
      </p>
      <IconButton
        aria-label={t('Volgende dag')}
        disabled={dayOffset === 0}
        className="disabled:text-slate-300"
        onClick={() => onChange(Math.max(0, dayOffset - 1))}
      >
        <IconChevronRight className="size-3.5" aria-hidden="true" />
      </IconButton>
    </div>
  )
}

function ScreenTime({
  days,
  selectedTimestamp,
  dayOffset,
  maxDayOffset,
  onDayChange,
}: {
  days: Day[]
  selectedTimestamp: number
  dayOffset: number
  maxDayOffset: number
  onDayChange: (offset: number) => void
}) {
  const { dateLocale, t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const selectedDays = useMemo(
    () => days.filter((day) => startOfLocalDay(day.startedAt).getTime() === selectedTimestamp),
    [days, selectedTimestamp]
  )
  const apps = useMemo(() => summarizeAppUsage(selectedDays, selectedDays.length), [selectedDays])
  const visibleApps = expanded ? apps : apps.slice(0, 5)
  const appIcons = useAppIcons(apps)
  const totalDuration = apps.reduce((total, app) => total + app.durationMs, 0)

  return (
    <section aria-labelledby="screen-time-title" className="overflow-hidden rounded-xl bg-white shadow-raised">
      <div className="flex min-h-12 items-center justify-between gap-3 border-slate-100 border-b px-4">
        <h2 id="screen-time-title" className="font-semibold text-slate-900 text-md">
          {t('Vastgelegde apptijd')}
        </h2>
        <DaySwitcher
          dayOffset={dayOffset}
          selectedTimestamp={selectedTimestamp}
          maxDayOffset={maxDayOffset}
          onChange={onDayChange}
        />
      </div>
      {apps.length ? (
        <ol id="screen-time-apps" className="divide-y divide-slate-100 px-4">
          {visibleApps.map((app) => {
            const icon = PROCESS_LIKE_APP_NAME.test(app.name.trim()) ? undefined : appIcons[app.bundleId]
            const share = totalDuration > 0 ? app.durationMs / totalDuration : 0
            return (
              <li
                key={app.bundleId || app.name}
                className="grid grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3 py-3"
              >
                <span
                  className={`flex size-9 items-center justify-center overflow-hidden rounded-lg ${icon ? '' : 'bg-slate-100 text-slate-400'}`}
                >
                  {icon ? (
                    <Image unoptimized src={icon} alt="" width={36} height={36} className="size-full object-contain" />
                  ) : (
                    <IconWindowApp className="size-4" aria-hidden="true" />
                  )}
                </span>
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-800 text-ui" title={app.name}>
                    {app.name}
                  </p>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
                    <div className="h-full min-w-px rounded-full bg-blue-700" style={{ width: `${share * 100}%` }} />
                  </div>
                </div>
                <span className="min-w-14 text-right font-medium text-slate-600 text-xs tabular-nums">
                  {formatDuration(app.durationMs, dateLocale)}
                </span>
              </li>
            )
          })}
        </ol>
      ) : (
        <div className="flex min-h-56 flex-col items-center justify-center px-6 text-center">
          <p className="font-medium text-slate-800 text-md">{t('Nog geen schermtijd')}</p>
          <p className="mt-1 max-w-sm text-pretty text-slate-500 text-sm">
            {t('Appgebruik verschijnt zodra Remember activiteit voor deze dag heeft vastgelegd.')}
          </p>
        </div>
      )}
      {apps.length > 5 ? (
        <footer className="border-slate-100 border-t">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls="screen-time-apps"
            onClick={() => setExpanded((current) => !current)}
            className="flex h-10 w-full items-center justify-center gap-1.5 font-medium text-slate-500 text-sm outline-none transition-[background-color,color] duration-150 ease-out hover:bg-slate-50 hover:text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-slate-400 motion-reduce:transition-none"
          >
            {expanded ? t('Minder tonen') : t('Alle {count} tonen', { count: apps.length })}
            <IconChevronDownSmall
              className={`size-3.5 transition-transform duration-150 ease-out ${expanded ? 'rotate-180' : ''} motion-reduce:transition-none`}
              aria-hidden="true"
            />
          </button>
        </footer>
      ) : null}
    </section>
  )
}

export function ActivitiesView() {
  const local = useLocalBridge()
  const { t } = useI18n()
  const [dayOffset, setDayOffset] = useState(0)
  const latestAudioMoments = useMemo(() => audioHistoryMoments(local.days), [local.days])

  if (!local.ready || !local.state || local.dataLoadStatus.days === 'loading') {
    return <ActivitiesLoadingState />
  }
  if (local.dataLoadStatus.days === 'error') {
    return (
      <DashboardLoadError
        title={t('Activiteit')}
        message={t('Activiteit kon niet worden geladen.')}
        onRetry={local.refresh}
      />
    )
  }

  const todayStart = startOfLocalDay(Date.now())
  const earliestDay = local.days.reduce(
    (earliest, day) => Math.min(earliest, startOfLocalDay(day.startedAt).getTime()),
    todayStart.getTime()
  )
  const maxDayOffset = Math.max(0, calendarDayDifference(todayStart.getTime(), earliestDay))
  const selectedDayOffset = Math.min(dayOffset, maxDayOffset)
  const selectedDate = new Date(todayStart)
  selectedDate.setDate(selectedDate.getDate() - selectedDayOffset)
  const selectedTimestamp = selectedDate.getTime()

  return (
    <Container className="flex grow flex-col gap-6 py-8 md:py-12">
      <DashboardContentHeader title={t('Activiteit')} />
      {local.state.status === 'recording' && local.state.contextCaptureHealth === 'reconnecting' ? (
        <div
          role="status"
          className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900 text-sm"
        >
          <IconCircleInfo className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{t('App- en vensteropname wordt opnieuw verbonden. Audio-opname loopt door.')}</span>
        </div>
      ) : null}
      {local.state.accessibilityPermission === 'denied' ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900 text-sm"
        >
          {t('App- en vensteropname is gestopt omdat macOS-toegang ontbreekt. Je archief blijft beschikbaar.')}
        </div>
      ) : null}
      <ScreenTime
        key={selectedTimestamp}
        days={local.days}
        selectedTimestamp={selectedTimestamp}
        dayOffset={selectedDayOffset}
        maxDayOffset={maxDayOffset}
        onDayChange={setDayOffset}
      />
      <AudioHistory moments={latestAudioMoments} captureState={local.state} />
    </Container>
  )
}
