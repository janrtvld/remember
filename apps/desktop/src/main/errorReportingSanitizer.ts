import { RENDERER_ERROR_REASONS, type RendererErrorReport } from '@remember/shared'

const MAX_MESSAGE_LENGTH = 500
const MAX_STACK_LENGTH = 20_000
const MAX_STACK_LINES = 80

const ALLOWED_TAGS = new Set([
  'app_area',
  'app_version',
  'architecture',
  'electron_version',
  'error_code',
  'event.environment',
  'event.origin',
  'event.process',
  'os',
  'os_version',
  'phase',
  'provider',
  'reason',
])

const ALLOWED_DIAGNOSTIC_FIELDS = new Set([
  'attempt',
  'duration_ms',
  'elapsed_ms',
  'exit_code',
  'microphone_ready',
  'phase',
  'prompt_bytes',
  'shard_count',
  'stderr_bytes',
  'stdout_bytes',
  'system_audio_ready',
  'truncated',
])

type StackFrameLike = {
  filename?: string
  function?: string
  lineno?: number
  colno?: number
  in_app?: boolean
  [key: string]: unknown
}

type ExceptionLike = {
  type?: string
  value?: string
  stacktrace?: { frames?: StackFrameLike[] }
}

type DebugImageLike = {
  type?: string
  code_file?: string
  code_id?: string
  debug_id?: string
  [key: string]: unknown
}

export type SentryEventLike = {
  event_id?: string
  timestamp?: number
  platform?: string
  level?: string
  message?: string
  exception?: { values?: ExceptionLike[] }
  release?: string
  environment?: string
  tags?: Record<string, string | number | boolean | undefined>
  contexts?: Record<string, Record<string, unknown> | undefined>
  extra?: Record<string, unknown>
  fingerprint?: string[]
  debug_meta?: { images?: DebugImageLike[] }
  user?: { ip_address?: string; [key: string]: unknown }
  sdk?: unknown
  [key: string]: unknown
}

export function sanitizeDiagnosticText(value: string, maxLength = MAX_MESSAGE_LENGTH) {
  return value
    .replaceAll(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replaceAll(/\b(?:access|refresh|id)[_-]?token\s*[:=]\s*["']?[^\s,"'}]+["']?/gi, '[token]=[redacted]')
    .replaceAll(
      /\b(?:api[_-]?key|authorization|password|secret)\s*[:=]\s*["']?[^\s,"'}]+["']?/gi,
      '[credential]=[redacted]'
    )
    .replaceAll(/\b(?:sk|sess)-[a-z0-9_-]{8,}\b/gi, '[credential redacted]')
    .replaceAll(/[A-Z]:\\Users\\[^\\\s]+\\/gi, '~\\')
    .replaceAll(/\/Users\/[^/\s]+\//g, '~/')
    .replaceAll(/\/home\/[^/\s]+\//g, '~/')
    .replaceAll(
      /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi,
      '[email]'
    )
    .replaceAll(/([a-z][a-z0-9+.-]*:\/\/[^\s?#]+)\?[^\s#]*/gi, '$1?[redacted]')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

export function sanitizeStack(value: string | null | undefined) {
  if (!value) return null
  return value
    .split('\n')
    .slice(0, MAX_STACK_LINES)
    .map((line) => sanitizeDiagnosticText(line, 1_000))
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_STACK_LENGTH)
}

function sanitizeFilename(value: string | undefined) {
  if (!value) return undefined
  const normalized = sanitizeDiagnosticText(value, 1_000).replaceAll('\\', '/').split(/[?#]/, 1)[0]
  if (!normalized) return undefined
  const appArchiveIndex = normalized.lastIndexOf('app.asar/')
  if (appArchiveIndex >= 0) return normalized.slice(appArchiveIndex)
  if (normalized.startsWith('node:')) return normalized
  if (normalized.startsWith('webpack://') || normalized.startsWith('file://')) {
    return normalized.split('/').slice(-4).join('/')
  }
  if (normalized.startsWith('~/')) return normalized
  return normalized.split('/').slice(-4).join('/')
}

function sanitizeStackFrame(frame: StackFrameLike): StackFrameLike {
  return {
    filename: sanitizeFilename(frame.filename),
    function: frame.function ? sanitizeDiagnosticText(frame.function, 300) : undefined,
    lineno: typeof frame.lineno === 'number' ? frame.lineno : undefined,
    colno: typeof frame.colno === 'number' ? frame.colno : undefined,
    in_app: typeof frame.in_app === 'boolean' ? frame.in_app : undefined,
  }
}

function sanitizeException(exception: ExceptionLike, publicMessage: string): ExceptionLike {
  return {
    type: exception.type ? sanitizeDiagnosticText(exception.type, 100) : undefined,
    value: exception.value ? publicMessage : undefined,
    stacktrace: exception.stacktrace?.frames
      ? { frames: exception.stacktrace.frames.slice(-MAX_STACK_LINES).map(sanitizeStackFrame) }
      : undefined,
  }
}

function safeTags(tags: SentryEventLike['tags']) {
  if (!tags) return undefined
  const entries = Object.entries(tags)
    .filter(([key]) => ALLOWED_TAGS.has(key))
    .map(([key, value]) => [key, typeof value === 'string' ? sanitizeDiagnosticText(value, 100) : value])
  return entries.length ? Object.fromEntries(entries) : undefined
}

function safeDiagnostics(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entries = Object.entries(value)
    .filter(
      ([key, field]) => ALLOWED_DIAGNOSTIC_FIELDS.has(key) && ['string', 'number', 'boolean'].includes(typeof field)
    )
    .map(([key, field]) => [key, typeof field === 'string' ? sanitizeDiagnosticText(field, 100) : field])
  return entries.length ? Object.fromEntries(entries) : undefined
}

function safeDebugMeta(value: SentryEventLike['debug_meta']) {
  const images = value?.images
    ?.slice(0, 50)
    .map((image) => ({
      type: image.type ? sanitizeDiagnosticText(image.type, 50) : undefined,
      code_file: sanitizeFilename(image.code_file),
      code_id: image.code_id ? sanitizeDiagnosticText(image.code_id, 100) : undefined,
      debug_id: image.debug_id ? sanitizeDiagnosticText(image.debug_id, 100) : undefined,
    }))
    .filter((image) => image.debug_id || image.code_id)
  return images?.length ? { images } : undefined
}

export function sanitizeSentryEvent(event: SentryEventLike): SentryEventLike {
  const diagnostics = safeDiagnostics(event.extra?.diagnostics)
  const publicMessage =
    (typeof event.tags?.error_code === 'string' && sanitizeDiagnosticText(event.tags.error_code, 100)) ||
    (event.exception?.values?.[0]?.type && sanitizeDiagnosticText(event.exception.values[0].type, 100)) ||
    'app-error'
  return {
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    level: event.level,
    message: event.message ? publicMessage : undefined,
    exception: event.exception?.values
      ? { values: event.exception.values.slice(0, 5).map((exception) => sanitizeException(exception, publicMessage)) }
      : undefined,
    release: event.release ? sanitizeDiagnosticText(event.release, 200) : undefined,
    environment: event.environment ? sanitizeDiagnosticText(event.environment, 50) : undefined,
    tags: safeTags(event.tags),
    extra: diagnostics ? { diagnostics } : undefined,
    fingerprint: event.fingerprint?.slice(0, 5).map((part) => sanitizeDiagnosticText(part, 100)),
    debug_meta: safeDebugMeta(event.debug_meta),
    // Sentry otherwise derives approximate geography from the ingest
    // connection even when IP storage is disabled. A fixed non-routable
    // sentinel prevents that enrichment without identifying the user.
    user: { ip_address: '0.0.0.0' },
    sdk: event.sdk,
  }
}

export function privacySafeError(error: unknown, publicMessage: string) {
  const safe = new Error(sanitizeDiagnosticText(publicMessage, 200))
  if (!(error instanceof Error) || !error.stack) return safe
  const frames = sanitizeStack(error.stack.split('\n').slice(1).join('\n'))
  safe.stack = `${safe.name}: ${safe.message}${frames ? `\n${frames}` : ''}`
  return safe
}

export function normalizeRendererErrorReport(value: unknown): RendererErrorReport | null {
  if (!value || typeof value !== 'object') return null
  const report = value as Partial<RendererErrorReport>
  if (report.source !== 'error' && report.source !== 'unhandled-rejection') return null
  if (typeof report.name !== 'string' || typeof report.message !== 'string') return null
  return {
    source: report.source,
    name: sanitizeDiagnosticText(report.name, 100) || 'Error',
    message: sanitizeDiagnosticText(report.message) || 'renderer-error',
    stack: typeof report.stack === 'string' ? sanitizeStack(report.stack) : null,
    ...(RENDERER_ERROR_REASONS.includes(report.reason as (typeof RENDERER_ERROR_REASONS)[number])
      ? { reason: report.reason }
      : {}),
  }
}
