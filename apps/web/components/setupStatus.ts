import type { CaptureState, LocalSettings } from '@remember/shared'

type SetupStatusInput = {
  state: CaptureState
  settings: LocalSettings
}

export function isSetupComplete({ state, settings }: SetupStatusInput) {
  return hasCompletedSetupChoices(settings) && state.modelDownloaded
}

// Revoking AI consent stops processing, but must not hide saved work or recovery controls.
export function hasCompletedSetupChoices(settings: LocalSettings) {
  return (
    settings.privacyOnboardingCompleted &&
    settings.audioCaptureOnboardingCompleted &&
    settings.dayAnalysisOnboardingCompleted &&
    settings.dayAnalysisProvider !== null
  )
}

export function isSetupResolving({ state, settings }: SetupStatusInput) {
  return (
    hasBaseSetupRequirements(state) &&
    settings.audioCaptureEnabled &&
    settings.audioCaptureOnboardingCompleted &&
    state.microphonePermission === 'granted' &&
    state.systemAudioCheckStatus === 'checking'
  )
}

function hasBaseSetupRequirements(state: CaptureState) {
  return state.accessibilityPermission === 'granted' && !state.restartRequired
}
