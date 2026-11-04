import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ConversationAudioPlaybackCoordinator,
  ConversationAudioPlaybackLeases,
  modelPreparationFailureState,
  modelPreparationStartState,
  nextAudioEngineToStart,
  shouldRunAudioEngines,
} from '../audioCapturePolicy'

describe('audio capture policy', () => {
  it('suspends audio engines while Remember is playing conversation audio', () => {
    assert.equal(shouldRunAudioEngines({ canRunAudioCapture: true, conversationAudioPlaybackActive: true }), false)
  })

  it('resumes eligible audio engines after playback ends', () => {
    assert.equal(shouldRunAudioEngines({ canRunAudioCapture: true, conversationAudioPlaybackActive: false }), true)
  })

  it('starts system audio only after the microphone helper is ready', () => {
    assert.equal(
      nextAudioEngineToStart({ microphoneStarted: false, microphoneReady: false, systemAudioStarted: false }),
      'microphone'
    )
    assert.equal(
      nextAudioEngineToStart({ microphoneStarted: true, microphoneReady: false, systemAudioStarted: false }),
      null
    )
    assert.equal(
      nextAudioEngineToStart({ microphoneStarted: true, microphoneReady: true, systemAudioStarted: false }),
      'system'
    )
    assert.equal(
      nextAudioEngineToStart({ microphoneStarted: true, microphoneReady: true, systemAudioStarted: true }),
      null
    )
  })

  it('restarts a missing microphone while system audio is still running or closing', () => {
    assert.equal(
      nextAudioEngineToStart({ microphoneStarted: false, microphoneReady: false, systemAudioStarted: true }),
      'microphone'
    )
  })

  it('keeps capture suspended until every player releases its lease', () => {
    const leases = new ConversationAudioPlaybackLeases()

    assert.equal(leases.set(1, 'player-a', true), 'started')
    assert.equal(leases.set(1, 'player-a', true), null)
    assert.equal(leases.set(1, 'player-b', true), null)
    assert.equal(leases.set(1, 'player-a', false), null)
    assert.equal(leases.active, true)
    assert.equal(leases.set(1, 'player-b', false), 'ended')
    assert.equal(leases.active, false)
  })

  it('releases only the destroyed sender while another renderer still owns playback', () => {
    const leases = new ConversationAudioPlaybackLeases()

    assert.equal(leases.set(1, 'player-a', true), 'started')
    assert.equal(leases.set(2, 'player-b', true), null)
    assert.equal(leases.releaseSender(1), null)
    assert.equal(leases.active, true)
    assert.equal(leases.releaseSender(2), 'ended')
    assert.equal(leases.active, false)
  })

  it('makes concurrent players wait for the first capture suspension', async () => {
    let finishSuspending: () => void = () => {}
    let suspensionCount = 0
    let resumeCount = 0
    const suspension = new Promise<void>((resolve) => {
      finishSuspending = resolve
    })
    const coordinator = new ConversationAudioPlaybackCoordinator(
      async () => {
        suspensionCount += 1
        await suspension
      },
      () => {
        resumeCount += 1
      }
    )

    const first = coordinator.set(1, 'player-a', true)
    await Promise.resolve()
    let secondResolved = false
    const second = coordinator.set(1, 'player-b', true).then(() => {
      secondResolved = true
    })
    await Promise.resolve()

    assert.equal(suspensionCount, 1)
    assert.equal(secondResolved, false)
    finishSuspending()
    await Promise.all([first, second])
    assert.equal(secondResolved, true)

    await coordinator.set(1, 'player-a', false)
    assert.equal(resumeCount, 0)
    await coordinator.set(1, 'player-b', false)
    assert.equal(resumeCount, 1)
  })

  it('keeps an active capture session recording while preparing the audio model', () => {
    const recording = { status: 'recording' as const, errorCode: null }

    assert.deepEqual(modelPreparationStartState(recording), recording)
    assert.deepEqual(modelPreparationFailureState(recording), recording)
  })

  it('clears a model error for a retry and reports a failed retry without an active session', () => {
    assert.deepEqual(modelPreparationStartState({ status: 'error', errorCode: 'model-required' }), {
      status: 'idle',
      errorCode: null,
    })
    assert.deepEqual(modelPreparationFailureState({ status: 'idle', errorCode: null }), {
      status: 'error',
      errorCode: 'model-download-failed',
    })
  })
})
