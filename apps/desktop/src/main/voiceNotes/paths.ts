import { join } from 'node:path'
import { app } from 'electron'
import { SPEECH_MODEL_DIRECTORY } from './speechModel'

/** The utility-process script that runs local transcription (built next to the main bundle). */
export function transcribeWorkerPath(): string {
  return join(__dirname, 'transcribeWorker.js')
}

// The local transcription model is shared by every captured day and never synced.
export function voiceNotesDir(): string {
  return join(app.getPath('userData'), 'models')
}

/** Shared by conversation recognition and dictation. */
export function modelDir(): string {
  return join(voiceNotesDir(), SPEECH_MODEL_DIRECTORY)
}
