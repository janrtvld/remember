import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isEdgeWidgetSetupComplete } from '../edgeWidgetSetup'
import { DEFAULT_SETTINGS } from '../settingsStore'

const settings = {
  ...DEFAULT_SETTINGS,
  privacyOnboardingCompleted: true,
  audioCaptureOnboardingCompleted: true,
  dayAnalysisOnboardingCompleted: true,
  dayAnalysisProvider: 'codex' as const,
  cloudAnalysisConsent: true,
}
const ready: Parameters<typeof isEdgeWidgetSetupComplete>[1] = {
  permissionsResolved: true,
  accessibilityPermission: 'granted',
  restartRequired: false,
  modelDownloaded: true,
  settingsHealth: { status: 'healthy', reason: 'none', lastKnownGoodAvailable: false, lastKnownGoodAt: null },
  microphonePermission: 'not-determined',
  systemAudioCheckStatus: 'unchecked',
}

describe('edge widget setup', () => {
  it('requires every onboarding choice even when the model and permissions are ready', () => {
    assert.equal(isEdgeWidgetSetupComplete(settings, ready), true)
    for (const patch of [
      { privacyOnboardingCompleted: false },
      { audioCaptureOnboardingCompleted: false },
      { dayAnalysisOnboardingCompleted: false },
      { dayAnalysisProvider: null },
      { cloudAnalysisConsent: false },
    ]) {
      assert.equal(isEdgeWidgetSetupComplete({ ...settings, ...patch }, ready), false)
    }
  })

  it('keeps completed installs hidden while startup, model replacement, or permission recovery is pending', () => {
    for (const patch of [
      { permissionsResolved: false },
      { modelDownloaded: false },
      { restartRequired: true },
      { accessibilityPermission: 'denied' as const },
      { settingsHealth: { ...ready.settingsHealth, status: 'recovery-required' as const } },
    ]) {
      assert.equal(isEdgeWidgetSetupComplete(settings, { ...ready, ...patch }), false)
    }
  })

  it('requires audio permissions for always-on while allowing the manual recording choice', () => {
    assert.equal(isEdgeWidgetSetupComplete(settings, ready), true)
    const alwaysOn = { ...settings, audioCaptureEnabled: true }
    assert.equal(isEdgeWidgetSetupComplete(alwaysOn, ready), false)
    assert.equal(isEdgeWidgetSetupComplete(alwaysOn, { ...ready, microphonePermission: 'granted' }), false)
    assert.equal(isEdgeWidgetSetupComplete(alwaysOn, { ...ready, systemAudioCheckStatus: 'ready' }), false)
    assert.equal(
      isEdgeWidgetSetupComplete(alwaysOn, {
        ...ready,
        microphonePermission: 'granted',
        systemAudioCheckStatus: 'ready',
      }),
      true
    )
  })
})
