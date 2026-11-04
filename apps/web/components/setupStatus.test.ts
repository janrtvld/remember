import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type CaptureState, hasCompletedOnboarding, type LocalSettings } from '@remember/shared'
import { hasCompletedSetupChoices, isSetupComplete, isSetupResolving } from './setupStatus'

const completedState = {
  modelDownloaded: true,
  microphonePermission: 'granted',
  accessibilityPermission: 'granted',
  restartRequired: false,
  systemAudioCheckStatus: 'ready',
} as CaptureState

const completedSettings = {
  privacyOnboardingCompleted: true,
  dayAnalysisProvider: 'codex',
  cloudAnalysisConsent: true,
  audioCaptureEnabled: false,
  audioCaptureOnboardingCompleted: true,
  dayAnalysisOnboardingCompleted: true,
  contextImportOnboardingCompleted: true,
} as unknown as LocalSettings

describe('setup completion', () => {
  it('completes in Manual mode without always-on permissions', () => {
    assert.equal(isSetupComplete({ state: completedState, settings: completedSettings }), true)
  })

  it('stays open while a required onboarding choice is unresolved', () => {
    for (const key of [
      'privacyOnboardingCompleted',
      'audioCaptureOnboardingCompleted',
      'dayAnalysisOnboardingCompleted',
    ] as const) {
      assert.equal(isSetupComplete({ state: completedState, settings: { ...completedSettings, [key]: false } }), false)
      assert.equal(hasCompletedOnboarding({ ...completedSettings, [key]: false }), false)
    }
  })

  it('finishes setup without importing context or enabling agent learning', () => {
    const settings = {
      ...completedSettings,
      contextImportOnboardingCompleted: false,
      agentLearningEnabled: false,
    }
    assert.equal(hasCompletedOnboarding(settings), true)
    assert.equal(isSetupComplete({ state: completedState, settings }), true)
  })

  it('requires connected AI and consent, while allowing automatic updates to be off', () => {
    assert.equal(hasCompletedOnboarding({ ...completedSettings, dayAnalysisProvider: null }), false)
    assert.equal(hasCompletedOnboarding({ ...completedSettings, cloudAnalysisConsent: false }), false)
    assert.equal(hasCompletedOnboarding({ ...completedSettings, frequentDayRefresh: false }), true)
  })

  it('keeps saved work and recovery controls reachable after a returning user revokes AI consent', () => {
    for (const offlineMode of [false, true]) {
      const settings = Object.freeze({ ...completedSettings, cloudAnalysisConsent: false, offlineMode })
      assert.equal(hasCompletedSetupChoices(settings), true)
      assert.equal(isSetupComplete({ state: completedState, settings }), true)
      assert.equal(hasCompletedOnboarding(settings), false, 'Runtime processing still requires consent')
      assert.equal(settings.cloudAnalysisConsent, false)
      assert.equal(settings.offlineMode, offlineMode)
    }
  })

  it('does not treat a new installation with no AI consent as completed onboarding', () => {
    const settings = { ...completedSettings, cloudAnalysisConsent: false, dayAnalysisOnboardingCompleted: false }
    assert.equal(hasCompletedSetupChoices(settings), false)
    assert.equal(isSetupComplete({ state: completedState, settings }), false)
    assert.equal(hasCompletedSetupChoices({ ...completedSettings, dayAnalysisProvider: null }), false)
  })

  it('reopens setup when a Manual mode install is missing its transcription model', () => {
    assert.equal(
      isSetupComplete({ state: { ...completedState, modelDownloaded: false }, settings: completedSettings }),
      false
    )
  })

  it('waits for permission resolution only during always-on setup', () => {
    const checkingPermissions = {
      ...completedState,
      systemAudioCheckStatus: 'checking',
    } as CaptureState

    assert.equal(
      isSetupResolving({
        state: checkingPermissions,
        settings: { ...completedSettings, audioCaptureEnabled: true },
      }),
      true
    )
    assert.equal(isSetupResolving({ state: checkingPermissions, settings: completedSettings }), false)
  })
})
