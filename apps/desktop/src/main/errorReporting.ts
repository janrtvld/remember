import { release as osRelease } from 'node:os'
import type { AgentProvider, AgentTraceDiagnostic, DayRefreshReason } from '@remember/shared'
import * as Sentry from '@sentry/electron/main'
import { app } from 'electron'
import {
  normalizeRendererErrorReport,
  privacySafeError,
  type SentryEventLike,
  sanitizeSentryEvent,
} from './errorReportingSanitizer'

// Sentry DSNs are public ingestion identifiers, not authentication secrets. The
// production DSN is kept here so packaged apps can report without runtime env.
const PRODUCTION_SENTRY_DSN =
  'https://19b57283cb278f950d6660ab44fc6e83@o4511938143846400.ingest.de.sentry.io/4511938206629968'
const RATE_LIMIT_WINDOW_MS = 10 * 60_000
const RATE_LIMIT_MAX_PER_FINGERPRINT = 10
const recentReports = new Map<string, number[]>()
let initialized = false

function shouldReport(fingerprint: string, now = Date.now()) {
  const recent = (recentReports.get(fingerprint) ?? []).filter((timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS)
  if (recent.length >= RATE_LIMIT_MAX_PER_FINGERPRINT) return false
  recent.push(now)
  recentReports.set(fingerprint, recent)
  if (recentReports.size > 200) {
    for (const [key, timestamps] of recentReports) {
      if (!timestamps.some((timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS)) recentReports.delete(key)
    }
  }
  return true
}

function sentryDsn() {
  return process.env.REMEMBER_SENTRY_DSN?.trim() || PRODUCTION_SENTRY_DSN
}

export function initializeErrorReporting(enabled = true) {
  if (initialized) return
  const dsn = sentryDsn()
  const shouldEnable = enabled && Boolean(dsn) && (app.isPackaged || process.env.REMEMBER_SENTRY_ENABLE_DEV === '1')
  if (!shouldEnable) return
  if (app.isReady()) {
    console.warn('[sentry] Error reporting will remain disabled until the next launch')
    return
  }

  try {
    Sentry.init({
      dsn,
      environment: app.isPackaged ? 'production' : 'development',
      release: `remember-desktop-${app.getVersion()}`,
      enabled: true,
      sampleRate: 1,
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: { request: false, response: false },
        httpBodies: [],
        urlQueryParams: false,
        graphQL: { document: false, variables: false },
        genAI: { inputs: false, outputs: false },
        databaseQueryData: false,
        stackFrameVariables: false,
        frameContextLines: 0,
      },
      maxBreadcrumbs: 0,
      beforeSendLog: () => null,
      beforeSendMetric: () => null,
      tracesSampleRate: 0,
      tracePropagationTargets: [],
      attachScreenshot: false,
      defaultIntegrations: false,
      integrations: [
        Sentry.eventFiltersIntegration(),
        Sentry.functionToStringIntegration(),
        Sentry.onUnhandledRejectionIntegration({ mode: 'warn' }),
        Sentry.onUncaughtExceptionIntegration(),
        Sentry.normalizePathsIntegration(),
      ],
      initialScope: {
        tags: {
          app_version: app.getVersion(),
          electron_version: process.versions.electron,
          os: process.platform,
          os_version: osRelease(),
          architecture: process.arch,
        },
      },
      beforeSend: (event) => sanitizeSentryEvent(event as unknown as SentryEventLike) as unknown as typeof event,
    })
    initialized = true
  } catch {
    console.warn('[sentry] Error reporting could not start')
  }
}

export async function setErrorReportingEnabled(enabled: boolean) {
  if (enabled) {
    initializeErrorReporting()
    return
  }
  if (!initialized) return
  initialized = false
  await Sentry.close(0)
}

type AppErrorContext = {
  area: string
  code: string
  tags?: Record<string, string | number | boolean>
  diagnostics?: Record<string, string | number | boolean | null | undefined>
}

export function reportAppError(error: unknown, context: AppErrorContext) {
  if (!initialized) return
  const fingerprint = `${context.area}:${context.code}`
  if (!shouldReport(fingerprint)) return
  Sentry.captureException(privacySafeError(error, context.code), {
    tags: {
      app_area: context.area,
      error_code: context.code,
      ...context.tags,
    },
    extra: { diagnostics: context.diagnostics },
  })
}

export function reportRendererError(value: unknown) {
  const report = normalizeRendererErrorReport(value)
  if (!report || !initialized) return
  const fingerprint = `renderer:${report.name}:${report.message}`
  if (!shouldReport(fingerprint)) return
  const error = new Error(report.message)
  error.name = report.name
  if (report.stack) error.stack = report.stack
  reportAppError(error, {
    area: 'renderer',
    code: report.source === 'error' ? 'renderer-error' : 'renderer-unhandled-rejection',
  })
}

function safeAgentDiagnostics(diagnostics: AgentTraceDiagnostic[]) {
  const latest = diagnostics.at(-1)
  if (!latest) return undefined
  return {
    attempt: latest.attempt,
    phase: latest.phase,
    shard_count: latest.shardCount,
    exit_code: latest.exitCode,
    duration_ms: Math.max(0, latest.completedAt - latest.startedAt),
    prompt_bytes: latest.promptBytes,
    stdout_bytes: latest.stdoutBytes,
    stderr_bytes: latest.stderrBytes,
    truncated: latest.truncated,
  }
}

export function reportAgentFailure(input: {
  error: unknown
  errorCode: string
  provider: AgentProvider
  reason: DayRefreshReason
  diagnostics: AgentTraceDiagnostic[]
}) {
  if (input.errorCode === 'agent-cancelled') return
  reportAppError(input.error, {
    area: 'day-report',
    code: input.errorCode,
    tags: {
      provider: input.provider,
      reason: input.reason,
      phase: input.diagnostics.at(-1)?.phase ?? 'unknown',
    },
    diagnostics: safeAgentDiagnostics(input.diagnostics),
  })
}
