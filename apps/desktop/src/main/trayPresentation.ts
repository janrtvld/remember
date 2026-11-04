import type { AppLocale, CaptureStatus, UpdateState } from '@remember/shared'
import { localText } from './localization'

type TrayPresentationInput = {
  status: CaptureStatus
  capturePausedUntil: number | null
  pauseReason: 'manual' | 'schedule' | null
  nextScheduleTransitionAt: number | null
  now: number
}

export function formatPauseEnd(timestamp: number, locale: AppLocale = 'nl') {
  return new Intl.DateTimeFormat(locale === 'nl' ? 'nl-NL' : 'en-US', { hour: '2-digit', minute: '2-digit' }).format(
    timestamp
  )
}

export function getTrayPauseActions(locale: AppLocale = 'nl') {
  return [
    { action: 'dialog' as const, label: localText(locale, 'Pauzeer…', 'Pause…') },
    {
      action: 'audio-one-hour' as const,
      label: localText(locale, 'Pauzeer audio voor 1 uur', 'Pause audio for 1 hour'),
    },
    {
      action: 'capture-one-hour' as const,
      label: localText(locale, 'Pauzeer vastleggen voor 1 uur', 'Pause capture for 1 hour'),
    },
  ]
}

export function getTrayPresentation(
  { status, capturePausedUntil, pauseReason, nextScheduleTransitionAt, now }: TrayPresentationInput,
  locale: AppLocale = 'nl'
) {
  const isPaused = status === 'paused'
  const pausedUntil = isPaused && capturePausedUntil != null && capturePausedUntil > now ? capturePausedUntil : null

  if (!isPaused) {
    return {
      canPause: status === 'recording',
      canResume: false,
      icon: 'normal' as const,
      pauseActionLabel: localText(locale, 'Pauzeer opname voor 1 uur', 'Pause capture for 1 hour'),
      tooltip:
        status === 'recording'
          ? localText(locale, 'Remember — opname actief', 'Remember — capture active')
          : 'Remember',
    }
  }

  if (pauseReason === 'schedule') {
    const formattedTransition =
      nextScheduleTransitionAt == null ? null : formatPauseEnd(nextScheduleTransitionAt, locale)
    return {
      canPause: false,
      canResume: false,
      icon: 'paused' as const,
      pauseActionLabel:
        formattedTransition == null
          ? localText(locale, 'Buiten opnametijd', 'Outside capture hours')
          : localText(
              locale,
              `Buiten opnametijd (tot ${formattedTransition})`,
              `Outside capture hours (until ${formattedTransition})`
            ),
      tooltip:
        formattedTransition == null
          ? localText(locale, 'Remember — buiten opnametijd', 'Remember — outside capture hours')
          : localText(
              locale,
              `Remember — buiten opnametijd tot ${formattedTransition}`,
              `Remember — outside capture hours until ${formattedTransition}`
            ),
    }
  }

  const formattedPauseEnd = pausedUntil == null ? null : formatPauseEnd(pausedUntil, locale)
  return {
    canPause: false,
    canResume: true,
    icon: 'paused' as const,
    pauseActionLabel:
      formattedPauseEnd == null
        ? localText(locale, 'Hervat opname', 'Resume capture')
        : localText(
            locale,
            `Hervat opname (gepauzeerd tot ${formattedPauseEnd})`,
            `Resume capture (paused until ${formattedPauseEnd})`
          ),
    tooltip:
      formattedPauseEnd == null
        ? localText(locale, 'Remember — opname gepauzeerd', 'Remember — capture paused')
        : localText(
            locale,
            `Remember — opname gepauzeerd tot ${formattedPauseEnd}`,
            `Remember — capture paused until ${formattedPauseEnd}`
          ),
  }
}

export function getTrayUpdatePresentation(update: UpdateState, locale: AppLocale = 'nl', offlineMode = false) {
  const versionSuffix = update.version ? ` ${update.version}` : ''

  if (offlineMode && update.status !== 'downloaded') {
    return {
      action: 'none' as const,
      enabled: false,
      label: localText(locale, 'Updates gepauzeerd in Offline mode', 'Updates paused in Offline mode'),
      tooltip: null,
    }
  }
  if (update.status === 'unavailable') {
    return {
      action: 'none' as const,
      enabled: false,
      label:
        update.availability === 'development'
          ? localText(locale, 'Updates beschikbaar in de geïnstalleerde app', 'Updates available in the installed app')
          : localText(locale, 'Geen updatekanaal beschikbaar', 'No update channel available'),
      tooltip: null,
    }
  }
  if (update.status === 'checking') {
    return {
      action: 'none' as const,
      enabled: false,
      label: localText(locale, 'Controleren op updates…', 'Checking for updates…'),
      tooltip: localText(locale, 'Remember — controleren op updates', 'Remember — checking for updates'),
    }
  }
  if (update.status === 'available') {
    return {
      action: 'download' as const,
      enabled: true,
      label: localText(locale, `Download update${versionSuffix}`, `Download update${versionSuffix}`),
      tooltip: localText(
        locale,
        `Remember — update${versionSuffix} beschikbaar`,
        `Remember — update${versionSuffix} available`
      ),
    }
  }
  if (update.status === 'downloading') {
    const progress = Math.round((update.downloadProgress ?? 0) * 100)
    return {
      action: 'none' as const,
      enabled: false,
      label: localText(
        locale,
        `Update${versionSuffix} downloaden… ${progress}%`,
        `Downloading update${versionSuffix}… ${progress}%`
      ),
      tooltip: localText(
        locale,
        `Remember — update${versionSuffix} downloaden (${progress}%)`,
        `Remember — downloading update${versionSuffix} (${progress}%)`
      ),
    }
  }
  if (update.status === 'downloaded') {
    return {
      action: 'restart' as const,
      enabled: true,
      label: localText(
        locale,
        `Herstart en installeer update${versionSuffix}`,
        `Restart and install update${versionSuffix}`
      ),
      tooltip: localText(
        locale,
        `Remember — herstart om update${versionSuffix} te installeren`,
        `Remember — restart to install update${versionSuffix}`
      ),
    }
  }
  if (update.status === 'error') {
    const isDownloadError = update.errorStage === 'download'
    return {
      action: isDownloadError ? ('download' as const) : ('check' as const),
      enabled: true,
      label: isDownloadError
        ? localText(locale, 'Download mislukt — probeer opnieuw', 'Download failed — try again')
        : localText(locale, 'Controleren mislukt — probeer opnieuw', 'Check failed — try again'),
      tooltip: isDownloadError
        ? localText(locale, 'Remember — update downloaden mislukt', 'Remember — update download failed')
        : localText(locale, 'Remember — updatecontrole mislukt', 'Remember — update check failed'),
    }
  }
  if (update.status === 'up-to-date') {
    return {
      action: 'check' as const,
      enabled: true,
      label: localText(locale, 'Actueel — controleer opnieuw…', 'Up to date — check again…'),
      tooltip: null,
    }
  }
  return {
    action: 'check' as const,
    enabled: true,
    label: localText(locale, 'Controleer op updates…', 'Check for updates…'),
    tooltip: null,
  }
}
