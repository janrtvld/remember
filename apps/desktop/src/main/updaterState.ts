import type { UpdateState } from '@remember/shared'

export type UpdateAvailability = UpdateState['availability']

export type UpdateStateEvent =
  | { type: 'check-started' }
  | { type: 'update-not-available' }
  | { type: 'update-available'; version: string }
  | { type: 'download-started' }
  | { type: 'download-progress'; progress: number }
  | { type: 'update-downloaded'; version: string }
  | { type: 'cancelled' }
  | { type: 'failed'; stage: 'check' | 'download' }

export function createUpdateState(currentVersion: string, availability: UpdateAvailability): UpdateState {
  return {
    status: availability === 'supported' ? 'idle' : 'unavailable',
    availability,
    currentVersion,
    version: null,
    downloadProgress: null,
    errorStage: null,
    revision: 0,
  }
}

export function reduceUpdateState(state: UpdateState, event: UpdateStateEvent): UpdateState {
  const revision = state.revision + 1

  if (event.type === 'check-started') {
    return { ...state, status: 'checking', version: null, downloadProgress: null, errorStage: null, revision }
  }
  if (event.type === 'update-not-available') {
    return { ...state, status: 'up-to-date', version: null, downloadProgress: null, errorStage: null, revision }
  }
  if (event.type === 'update-available') {
    return {
      ...state,
      status: 'available',
      version: event.version,
      downloadProgress: null,
      errorStage: null,
      revision,
    }
  }
  if (event.type === 'download-started') {
    return { ...state, status: 'downloading', downloadProgress: 0, errorStage: null, revision }
  }
  if (event.type === 'download-progress') {
    return {
      ...state,
      status: 'downloading',
      downloadProgress: Math.min(1, Math.max(0, event.progress)),
      errorStage: null,
      revision,
    }
  }
  if (event.type === 'update-downloaded') {
    return {
      ...state,
      status: 'downloaded',
      version: event.version,
      downloadProgress: 1,
      errorStage: null,
      revision,
    }
  }
  if (event.type === 'cancelled') {
    return {
      ...state,
      status: state.version ? 'available' : 'idle',
      downloadProgress: null,
      errorStage: null,
      revision,
    }
  }
  return {
    ...state,
    status: 'error',
    version: event.stage === 'download' ? state.version : null,
    downloadProgress: null,
    errorStage: event.stage,
    revision,
  }
}
