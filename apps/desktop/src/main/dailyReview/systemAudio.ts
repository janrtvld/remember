import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { publishRecordingAudioLevel } from '../recordingAudioMeter'
import {
  createAudioHelperStartupGuard,
  createSystemAudioVerificationCompletion,
  type SystemAudioVerificationResult,
} from './systemAudioLifecycle'

const MAX_LINE_BYTES = 64 * 1024
const SYSTEM_AUDIO_STARTUP_TIMEOUT_MS = 10_000
const VERIFY_TIMEOUT_MS = 10_000

export type SystemAudioChunk = {
  path: string
  startedAt: number
  durationMs: number
  averageLevel: number
  captureEpochId: string
  sequence: number
  sampleCount: number
  sampleTime: number | null
}

type NativeEvent =
  | { type: 'ready' }
  | { type: 'level'; rms: number }
  | {
      type: 'chunk'
      path: string
      started_at: number
      duration_ms: number
      average_level: number
      capture_epoch_id: string
      sequence: number
      sample_count: number
      first_sample_time: number | null
    }
  | { type: 'error'; code: string; message: string }

function helperPath() {
  const packaged = path.join(process.resourcesPath, 'system-audio-capture')
  if (app.isPackaged && existsSync(packaged)) return packaged
  return path.join(app.getAppPath(), 'native', 'system-audio-capture')
}

export function isSystemAudioCaptureAvailable() {
  return process.platform === 'darwin' && existsSync(helperPath())
}

function parseEvent(line: string): NativeEvent | null {
  try {
    const value = JSON.parse(line) as Partial<NativeEvent>
    return typeof value.type === 'string' ? (value as NativeEvent) : null
  } catch {
    return null
  }
}

function wireOutput(child: ChildProcessWithoutNullStreams, onEvent: (event: NativeEvent) => void) {
  let buffer = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const event = parseEvent(buffer.slice(0, newline).trim())
      buffer = buffer.slice(newline + 1)
      if (event) onEvent(event)
      newline = buffer.indexOf('\n')
    }
    if (buffer.length > MAX_LINE_BYTES) buffer = ''
  })
  child.stderr.on('data', (chunk: Buffer) => {
    console.error('[daily-review] system audio:', chunk.toString('utf8').trim())
  })
}

export function startSystemAudioCapture(
  outputDirectory: string,
  chunkDurationMs: number,
  onChunk: (chunk: SystemAudioChunk) => void,
  onError: (code: string, message: string) => void,
  onReady?: () => void
) {
  if (!isSystemAudioCaptureAvailable()) return null
  const child = spawn(helperPath(), ['--output-dir', outputDirectory, '--chunk-ms', String(chunkDurationMs)])
  let didReportError = false
  let didBecomeReady = false
  let startupGuard: ReturnType<typeof createAudioHelperStartupGuard>
  const reportError = (code: string, message: string) => {
    if (didReportError) return
    didReportError = true
    startupGuard.markFailed()
    onError(code, message)
  }
  startupGuard = createAudioHelperStartupGuard({
    timeoutMs: SYSTEM_AUDIO_STARTUP_TIMEOUT_MS,
    onTimeout: () => {
      reportError('system-audio-capture-start-timeout', 'System audio helper did not become ready')
      stopSystemAudioCapture(child)
    },
  })
  wireOutput(child, (event) => {
    if (event.type === 'ready') {
      if (didBecomeReady || didReportError) return
      didBecomeReady = true
      startupGuard.markReady()
      onReady?.()
    } else if (event.type === 'level') {
      publishRecordingAudioLevel('system', event.rms)
    } else if (event.type === 'chunk') {
      onChunk({
        path: event.path,
        startedAt: event.started_at,
        durationMs: event.duration_ms,
        averageLevel: event.average_level,
        captureEpochId: event.capture_epoch_id,
        sequence: event.sequence,
        sampleCount: event.sample_count,
        sampleTime: event.first_sample_time,
      })
    } else if (event.type === 'error') {
      reportError(event.code, event.message)
    }
  })
  child.on('error', (error) => {
    reportError('system-audio-capture-failed', error.message)
  })
  child.on('exit', (code, signal) => {
    startupGuard.markFailed()
    if (didReportError || signal === 'SIGINT' || signal === 'SIGTERM') return
    if (!didBecomeReady || code !== 0) {
      reportError('system-audio-capture-failed', `System audio helper exited (${code ?? signal ?? 'unknown'})`)
    }
  })
  return child
}

export function stopSystemAudioCapture(child: ChildProcessWithoutNullStreams | null) {
  if (!child || child.killed) return
  child.kill('SIGINT')
  const timeout = setTimeout(() => {
    if (child.exitCode == null) child.kill('SIGTERM')
  }, 2_000)
  child.once('exit', () => clearTimeout(timeout))
}

export function verifySystemAudioCapture() {
  if (!isSystemAudioCaptureAvailable()) {
    return Promise.resolve({ ok: false, error: 'Core Audio Tap helper is unavailable' })
  }

  return new Promise<SystemAudioVerificationResult>((resolve) => {
    const directory = path.join(app.getPath('temp'), `remember-system-audio-check-${randomUUID()}`)
    const child = spawn(helperPath(), ['--output-dir', directory, '--chunk-ms', '1000'])
    const completion = createSystemAudioVerificationCompletion({
      cleanup: () => rmSync(directory, { force: true, recursive: true }),
      resolve,
    })
    const finish = (result: SystemAudioVerificationResult) => {
      if (!completion.settle(result)) return
      clearTimeout(timeout)
      stopSystemAudioCapture(child)
    }
    const timeout = setTimeout(() => finish({ ok: false, error: 'Core Audio Tap check timed out' }), VERIFY_TIMEOUT_MS)
    wireOutput(child, (event) => {
      if (event.type === 'ready') finish({ ok: true, error: null })
      if (event.type === 'error') finish({ ok: false, error: event.message })
    })
    child.on('error', (error) => finish({ ok: false, error: error.message }))
    child.once('close', (code, signal) => {
      completion.settle({
        ok: false,
        error: `Core Audio Tap check exited (${code ?? signal ?? 'unknown'})`,
      })
      completion.close()
    })
  })
}
