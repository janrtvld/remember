import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import type { DictationRecorderEvent } from '@remember/shared'
import { app } from 'electron'
import { readPcmWavInfo } from './pcmWav'
import { type MicrophoneCaptureHandle, SharedMicrophoneService } from './sharedMicrophoneService'
import { createSharedMicrophoneTransport } from './sharedMicrophoneTransport'

export type { MicrophoneAudioChunk, MicrophoneCaptureHandle } from './sharedMicrophoneService'

export function isMicrophoneAudioCaptureAvailable() {
  return true
}

let service: SharedMicrophoneService | null = null

function microphoneService() {
  if (service) return service
  service = new SharedMicrophoneService({
    createTransport: createSharedMicrophoneTransport,
    outputPath: () => {
      const directory = path.join(app.getPath('temp'), `remember-shared-dictation-${process.pid}`)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      return path.join(directory, `${randomUUID()}.wav`)
    },
    readResult: (file) => {
      const size = statSync(file).size
      if (size < 44 || size > 60_000_000) throw new Error('Invalid shared recording size')
      const info = readPcmWavInfo(file)
      if (info.sampleRate !== 16_000 || info.sampleCount === 0) throw new Error('Invalid shared recording format')
      const wav = readFileSync(file)
      return wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer
    },
    removeFile: (file) => {
      try {
        unlinkSync(file)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          console.warn('[microphone] Could not remove recording', error)
      }
    },
  })
  return service
}

export function startMicrophoneAudioCapture(
  outputDirectory: string,
  chunkDurationMs: number,
  onReady: (microphoneName: string) => void,
  onChunk: Parameters<SharedMicrophoneService['startConversation']>[2]['onChunk'],
  onError: (code: string, message: string) => void,
  onPaused?: () => void
) {
  if (!isMicrophoneAudioCaptureAvailable()) return null
  return microphoneService().startConversation(outputDirectory, chunkDurationMs, {
    onReady,
    onChunk,
    onError,
    onPaused,
  })
}

export function stopMicrophoneAudioCapture(handle: MicrophoneCaptureHandle | null) {
  handle?.stop()
}

export function createSharedDictationCapture(onEvent: (event: DictationRecorderEvent) => void) {
  let disposed = false
  let sessionId: number | null = null
  return {
    available: isMicrophoneAudioCaptureAvailable,
    defaultInputSelected: () => !disposed && (service?.defaultInputSelected() ?? false),
    prewarm: async () => {
      if (!disposed && isMicrophoneAudioCaptureAvailable()) await microphoneService().prewarm()
    },
    start: async (options: {
      sessionId: number
      forceBuiltInMicrophone: boolean
      microphoneId?: string | null
      microphoneLabel?: string | null
    }) => {
      if (disposed || !isMicrophoneAudioCaptureAvailable()) return false
      sessionId = options.sessionId
      const accepted = await microphoneService().startDictation(options, (event) => {
        if (!disposed) onEvent(event)
      })
      if (!accepted && sessionId === options.sessionId) sessionId = null
      return accepted
    },
    stop: (current: number) => {
      if (!disposed && sessionId === current) service?.stopDictation(current)
    },
    cancel: (current: number) => {
      if (sessionId !== current) return
      sessionId = null
      service?.cancelDictation(current)
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      if (sessionId != null) service?.cancelDictation(sessionId)
      sessionId = null
    },
  }
}

export function disposeSharedMicrophoneCapture() {
  const closed = service?.dispose()
  service = null
  return closed
}
