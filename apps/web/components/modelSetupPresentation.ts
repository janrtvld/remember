import type { AppLocale, CaptureState } from '@remember/shared'

type ModelState = Pick<CaptureState, 'error' | 'modelDownloadProgress' | 'modelPreparationPhase'>

export function modelSetupPresentation(state: ModelState, offlineMode: boolean, locale: AppLocale = 'nl') {
  const localDetail =
    locale === 'nl'
      ? 'Audio wordt lokaal omgezet naar tekst en blijft op deze Mac.'
      : 'Audio is transcribed locally and stays on this Mac.'

  if (state.modelPreparationPhase === 'installing') {
    return {
      detail: localDetail,
      actionLabel: locale === 'nl' ? 'Lokaal installeren…' : 'Installing locally…',
      disabled: true,
    }
  }

  if (state.modelPreparationPhase === 'downloading' && state.modelDownloadProgress != null) {
    return {
      detail: localDetail,
      actionLabel:
        locale === 'nl'
          ? `Downloaden · ${Math.round(state.modelDownloadProgress * 100)}%`
          : `Downloading · ${Math.round(state.modelDownloadProgress * 100)}%`,
      disabled: true,
    }
  }

  if (offlineMode) {
    return {
      detail:
        locale === 'nl'
          ? 'Offline mode staat aan. Ga online om het audiomodel eenmalig te downloaden; synchronisatie en online functies worden dan weer actief.'
          : 'Offline mode is on. Go online to download the audio model once; sync and online features will become active again.',
      actionLabel: locale === 'nl' ? 'Ga online en download model' : 'Go online and download model',
      disabled: false,
    }
  }

  if (state.error === 'model-download-failed' || state.error === 'model-download-offline') {
    return {
      detail:
        locale === 'nl'
          ? 'Het audiomodel kon niet worden gedownload. Controleer je verbinding en probeer het opnieuw.'
          : 'The audio model could not be downloaded. Check your connection and try again.',
      actionLabel: locale === 'nl' ? 'Probeer download opnieuw' : 'Retry download',
      disabled: false,
    }
  }

  return {
    detail: localDetail,
    actionLabel: locale === 'nl' ? 'Download model' : 'Download model',
    disabled: false,
  }
}
