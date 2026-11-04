import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { DailyReviewContextPermissionStatus } from '@remember/shared'
import { app } from 'electron'

const MAX_LINE_BYTES = 2 * 1024 * 1024
const intentionallyStoppedChildren = new WeakSet<ChildProcessWithoutNullStreams>()

export interface ContextCaptureEvent {
  timestamp: number
  appName: string
  bundleId: string
  windowTitle: string
  text: string
  textSource: 'accessibility' | 'ocr'
  trigger: string
  monitorName: string
  screenshotPath: string
  url?: string
  focusedElement?: { role: string; title: string; description: string; value: string }
  inputIdleSeconds?: number
}

export interface ContextPermissions {
  accessibility: DailyReviewContextPermissionStatus
  inputMonitoring: DailyReviewContextPermissionStatus
}

interface NativePermissionsEvent {
  type: 'permissions'
  accessibility: boolean
  input_monitoring: boolean
}

interface NativeContextEvent {
  type: 'context'
  timestamp: number
  app_name: string
  bundle_id: string
  window_title: string
  text: string
  text_source: 'accessibility' | 'ocr'
  trigger: string
  monitor_name: string
  screenshot_path: string
  url?: string
  focused_element?: { role: string; title: string; description: string; value: string }
  input_idle_seconds?: number
}

interface NativeErrorEvent {
  type: 'error'
  code: string
  message: string
}

type NativeEvent = NativePermissionsEvent | NativeContextEvent | NativeErrorEvent | { type: 'ready' }

function helperPath() {
  const packaged = path.join(process.resourcesPath, 'context-capture')
  if (app.isPackaged && existsSync(packaged)) return packaged
  return path.join(app.getAppPath(), 'native', 'context-capture', 'target', 'release', 'remember-context-capture')
}

export function isContextCaptureAvailable() {
  return process.platform === 'darwin' && existsSync(helperPath())
}

function parseEvent(line: string): NativeEvent | null {
  try {
    const event = JSON.parse(line) as Partial<NativeEvent>
    return typeof event.type === 'string' ? (event as NativeEvent) : null
  } catch {
    return null
  }
}

function permissionStatus(granted: boolean): DailyReviewContextPermissionStatus {
  return granted ? 'granted' : 'denied'
}

export function normalizeContextApp(event: ContextCaptureEvent): ContextCaptureEvent {
  if (
    event.appName === 'Electron' &&
    (event.bundleId === 'computer.remember.app' ||
      event.bundleId === 'com.revinote.local' ||
      ['Remember', 'Daymark', 'Revinote Local'].includes(event.windowTitle.trim()))
  ) {
    return { ...event, appName: 'Remember', bundleId: 'computer.remember.app' }
  }
  return event
}

export function readContextPermissions(request = false): Promise<ContextPermissions> {
  if (!isContextCaptureAvailable()) {
    return Promise.resolve({ accessibility: 'unknown', inputMonitoring: 'unknown' })
  }

  return new Promise((resolve) => {
    const child = spawn(helperPath(), [request ? '--request-permissions' : '--permission-status'])
    let output = ''
    const fallback = { accessibility: 'unknown', inputMonitoring: 'unknown' } as const

    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      if (output.length > MAX_LINE_BYTES) output = ''
    })
    child.on('error', () => resolve(fallback))
    child.on('exit', () => {
      const event = output
        .split('\n')
        .map((line) => parseEvent(line.trim()))
        .find((candidate): candidate is NativePermissionsEvent => candidate?.type === 'permissions')
      if (!event) {
        resolve(fallback)
        return
      }
      resolve({
        accessibility: permissionStatus(event.accessibility),
        inputMonitoring: permissionStatus(event.input_monitoring),
      })
    })
  })
}

export function startContextCapture(
  outputDirectory: string,
  onContext: (event: ContextCaptureEvent) => void,
  onError: (code: string, message: string) => void
): ChildProcessWithoutNullStreams | null {
  if (!isContextCaptureAvailable()) return null

  const child = spawn(helperPath(), ['--output-dir', outputDirectory])
  let buffer = ''
  let didReportError = false
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      const event = parseEvent(line)
      if (event?.type === 'context') {
        onContext(
          normalizeContextApp({
            timestamp: event.timestamp,
            appName: event.app_name,
            bundleId: event.bundle_id,
            windowTitle: event.window_title,
            text: event.text,
            textSource: event.text_source,
            trigger: event.trigger,
            monitorName: event.monitor_name,
            screenshotPath: event.screenshot_path,
            url: event.url ?? '',
            focusedElement: event.focused_element,
            inputIdleSeconds: event.input_idle_seconds,
          })
        )
      } else if (event?.type === 'error') {
        didReportError = true
        onError(event.code, event.message)
      }
      newline = buffer.indexOf('\n')
    }
    if (buffer.length > MAX_LINE_BYTES) buffer = ''
  })
  child.stderr.on('data', (chunk: Buffer) => {
    console.error('[daily-review] context capture:', chunk.toString('utf8').trim())
  })
  child.on('error', (error) => {
    didReportError = true
    onError('context-capture-failed', error.message)
  })
  child.on('exit', (code, signal) => {
    const wasStopped = intentionallyStoppedChildren.delete(child)
    if (wasStopped || didReportError) return
    onError('context-capture-exited', `Context helper exited (${code ?? signal ?? 'unknown'})`)
  })
  return child
}

export function stopContextCapture(child: ChildProcessWithoutNullStreams | null) {
  if (!child || child.killed) return
  intentionallyStoppedChildren.add(child)
  let exited = false
  child.once('exit', () => {
    exited = true
  })
  child.kill('SIGINT')
  const timeout = setTimeout(() => {
    if (!exited) child.kill('SIGTERM')
  }, 2_000)
  child.once('exit', () => clearTimeout(timeout))
}
