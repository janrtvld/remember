export interface DictationPreferences {
  enabled: boolean
  shortcut: string | null
  microphoneId: string | null
  autoInsert: boolean
  soundsEnabled: boolean
  dimMediaDuringRecording: boolean
  forceBuiltInMicWhenAudioPlaying: boolean
}

export const DEFAULT_DICTATION_PREFERENCES: DictationPreferences = {
  enabled: true,
  shortcut: 'CommandOrControl+J',
  microphoneId: null,
  autoInsert: true,
  soundsEnabled: true,
  dimMediaDuringRecording: true,
  forceBuiltInMicWhenAudioPlaying: true,
}

export function normalizeDictationPreferences(value: unknown): DictationPreferences {
  const input = value && typeof value === 'object' ? (value as Partial<DictationPreferences>) : {}
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : DEFAULT_DICTATION_PREFERENCES.enabled,
    shortcut:
      input.shortcut === null
        ? null
        : typeof input.shortcut === 'string' && input.shortcut.trim().length <= 128
          ? input.shortcut.trim() || null
          : DEFAULT_DICTATION_PREFERENCES.shortcut,
    microphoneId:
      typeof input.microphoneId === 'string' && input.microphoneId.length <= 512
        ? input.microphoneId.trim() || null
        : null,
    autoInsert: typeof input.autoInsert === 'boolean' ? input.autoInsert : DEFAULT_DICTATION_PREFERENCES.autoInsert,
    soundsEnabled:
      typeof input.soundsEnabled === 'boolean' ? input.soundsEnabled : DEFAULT_DICTATION_PREFERENCES.soundsEnabled,
    dimMediaDuringRecording:
      typeof input.dimMediaDuringRecording === 'boolean'
        ? input.dimMediaDuringRecording
        : DEFAULT_DICTATION_PREFERENCES.dimMediaDuringRecording,
    forceBuiltInMicWhenAudioPlaying:
      typeof input.forceBuiltInMicWhenAudioPlaying === 'boolean'
        ? input.forceBuiltInMicWhenAudioPlaying
        : DEFAULT_DICTATION_PREFERENCES.forceBuiltInMicWhenAudioPlaying,
  }
}

export type DictationStatus = 'idle' | 'starting' | 'recording' | 'transcribing' | 'done' | 'error'
export interface DictationNote {
  id: string
  createdAt: number
  durationMs: number
  text: string
  status: 'processing' | 'completed' | 'failed'
  error: 'interrupted' | NonNullable<DictationState['error']> | null
  hasAudio: boolean
}

export interface DictationState {
  status: DictationStatus
  startedAt: number | null
  level: number
  text: string
  result: 'inserted' | 'copied' | null
  error: 'microphone' | 'recording' | 'transcription' | 'no-speech' | 'model-required' | 'download' | null
  canRetry: boolean
  microphones: Array<{ id: string; label: string }>
  shortcutRegistered: boolean
  accessibilityGranted: boolean
  modelReady: boolean
  modelProgress: number | null
  modelPreparing: boolean
}

export interface DictationBridge {
  getHistory: () => Promise<DictationNote[]>
  onHistory: (listener: (notes: DictationNote[]) => void) => () => void
  retryNote: (id: string) => Promise<void>
  deleteNote: (id: string) => Promise<void>
  copyNote: (id: string) => Promise<void>
  downloadNote: (id: string) => Promise<ArrayBuffer | null>
  getState: () => Promise<DictationState>
  onState: (listener: (state: DictationState) => void) => () => void
  toggle: (target?: 'composer') => Promise<void>
  cancel: () => Promise<void>
  retry: () => Promise<void>
  copy: () => Promise<void>
  prepareModel: () => Promise<void>
  cancelModelPreparation: () => Promise<void>
  requestAccessibility: () => Promise<boolean>
  refreshMicrophones: () => Promise<void>
  setShortcutRecording: (recording: boolean) => Promise<void>
}

export const DICTATION_CHANNELS = {
  getHistory: 'remember:dictation:history',
  historyChanged: 'remember:dictation:history-changed',
  retryNote: 'remember:dictation:retry-note',
  deleteNote: 'remember:dictation:delete-note',
  copyNote: 'remember:dictation:copy-note',
  downloadNote: 'remember:dictation:download-note',
  getState: 'remember:dictation:state',
  stateChanged: 'remember:dictation:changed',
  toggle: 'remember:dictation:toggle',
  cancel: 'remember:dictation:cancel',
  retry: 'remember:dictation:retry',
  copy: 'remember:dictation:copy',
  prepareModel: 'remember:dictation:prepare-model',
  cancelModelPreparation: 'remember:dictation:cancel-model',
  requestAccessibility: 'remember:dictation:accessibility',
  refreshMicrophones: 'remember:dictation:microphones',
  setShortcutRecording: 'remember:dictation:shortcut-recording',
  recorderEvent: 'remember:dictation-recorder:event',
  recorderCommand: 'remember:dictation-recorder:command',
} as const

export type DictationRecorderCommand =
  | { type: 'start'; sessionId: number; microphoneId: string | null; forceBuiltInMicrophone: boolean }
  | { type: 'stop' | 'cancel'; sessionId: number }
  | { type: 'devices' }
  | { type: 'sound'; cue: 'tap' | 'success' }

export type DictationRecorderEvent =
  | { type: 'ready' }
  | { type: 'devices'; devices: Array<{ id: string; label: string }> }
  | { type: 'started'; sessionId: number; startedAt: number }
  | { type: 'level'; sessionId: number; level: number }
  | { type: 'error'; sessionId: number; message: string }
  | { type: 'result'; sessionId: number; wav: ArrayBuffer; durationMs: number }
