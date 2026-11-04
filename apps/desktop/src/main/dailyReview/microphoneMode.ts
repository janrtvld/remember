import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { app, systemPreferences } from 'electron'

let preparation: Promise<void> | null = null

/** Leave capture processing to Chromium and opt out of macOS's additional Mic Mode processing. */
export function prepareMicrophoneMode(): Promise<void> {
  if (process.platform !== 'darwin' || systemPreferences.getMediaAccessStatus('microphone') !== 'granted')
    return Promise.resolve()
  if (preparation) return preparation

  const executable = app.isPackaged
    ? join(process.resourcesPath, 'microphone-audio-capture')
    : join(app.getAppPath(), 'native', 'microphone-audio-capture')
  preparation = new Promise<void>((resolve) => {
    execFile(
      executable,
      ['--configure-microphone-mode'],
      { timeout: 8_000, killSignal: 'SIGKILL', maxBuffer: 4096 },
      (error, stdout) => {
        try {
          if (error) throw error
          const result = JSON.parse(stdout)
          if (result.type !== 'configured' || result.voice_processing_bypassed !== true || result.running !== false)
            throw new Error('Unexpected microphone mode configuration result')
        } catch (cause) {
          // An unavailable Mic Mode opt-out must never prevent recording.
          console.warn('[microphone] Could not configure macOS microphone mode', cause)
        }
        resolve()
      }
    )
  })
  return preparation
}
