import { type CaptureState, hasCompletedOnboarding, type LocalSettings } from '@remember/shared'

type WidgetSetupState = Pick<
  CaptureState,
  | 'permissionsResolved'
  | 'accessibilityPermission'
  | 'restartRequired'
  | 'modelDownloaded'
  | 'settingsHealth'
  | 'microphonePermission'
  | 'systemAudioCheckStatus'
>

export function isEdgeWidgetSetupComplete(settings: LocalSettings, state: WidgetSetupState) {
  return (
    hasCompletedOnboarding(settings) &&
    state.permissionsResolved &&
    state.accessibilityPermission === 'granted' &&
    !state.restartRequired &&
    state.modelDownloaded &&
    state.settingsHealth.status !== 'recovery-required' &&
    (!settings.audioCaptureEnabled ||
      (state.microphonePermission === 'granted' && state.systemAudioCheckStatus === 'ready'))
  )
}
