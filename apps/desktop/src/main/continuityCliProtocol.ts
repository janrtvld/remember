import type { AgentLearningStatus, CaptureState, LocalSettings } from '@remember/shared'

interface ContinuityStatusDependencies {
  dataDirectory: string
  getCaptureState: () => CaptureState
  getSettings: () => LocalSettings
  getLearningStatus: () => AgentLearningStatus
  now?: () => number
}

/** A live observation, separate from persisted source timestamps and processing coverage. */
export function createContinuityStatusHandler(dependencies: ContinuityStatusDependencies) {
  return (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-request')
    const request = value as Record<string, unknown>
    if (typeof request.id !== 'string' || !request.id.trim()) throw new Error('invalid-request-id')
    if (request.action !== 'continuity.status') throw new Error('unknown-request-action')

    const state = dependencies.getCaptureState()
    const settings = dependencies.getSettings()
    return {
      id: request.id,
      ok: true as const,
      result: {
        observedAt: (dependencies.now ?? Date.now)(),
        dataDirectory: dependencies.dataDirectory,
        capture: {
          availability: 'live',
          status: state.status,
          activeSessionId: state.activeSessionId,
          startedAt: state.startedAt,
          pauseReason: state.pauseReason,
          pausedSources: state.pausedSources,
          pausedUntil: settings.capturePausedUntil,
          nextScheduleTransitionAt: state.nextScheduleTransitionAt,
          context: {
            status: state.contextCaptureStatus,
            health: state.contextCaptureHealth,
            lastEventAt: state.contextCaptureLastEventAt,
          },
          audio: {
            enabled: settings.audioCaptureEnabled,
            microphoneLastChunkAt: state.microphoneLastChunkAt,
            systemAudioCheckStatus: state.systemAudioCheckStatus,
            systemAudioCheckError: state.systemAudioCheckError,
          },
          error: state.error,
        },
        processing: {
          offlineMode: settings.offlineMode,
          automaticDayRefreshEnabled: settings.frequentDayRefresh,
          dayRefreshIntervalMinutes: settings.frequentDayRefreshIntervalMinutes,
          automaticRevinoteProcessing: settings.automaticRevinoteProcessing,
          agentLearning: dependencies.getLearningStatus(),
        },
      },
    }
  }
}
