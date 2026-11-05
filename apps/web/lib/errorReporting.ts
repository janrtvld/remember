import type { RememberBridge, RendererErrorReport } from '@remember/shared'

const MAX_MESSAGE_LENGTH = 500
const MAX_STACK_LENGTH = 20_000
const REPORT_WINDOW_MS = 60_000
const MAX_REPORTS_PER_WINDOW = 10

function sanitize(value: string, maxLength: number) {
  return value
    .replaceAll(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replaceAll(/\b(?:access|refresh|id)[_-]?token\s*[:=]\s*["']?[^\s,"'}]+["']?/gi, '[token]=[redacted]')
    .replaceAll(/\b(?:sk|sess)-[a-z0-9_-]{8,}\b/gi, '[credential redacted]')
    .replaceAll(/[A-Z]:\\Users\\[^\\\s]+\\/gi, '~\\')
    .replaceAll(/\/Users\/[^/\s]+\//g, '~/')
    .replaceAll(/\/home\/[^/\s]+\//g, '~/')
    .replaceAll(
      /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi,
      '[email]'
    )
    .replaceAll(/([a-z][a-z0-9+.-]*:\/\/[^\s?#]+)\?[^\s#]*/gi, '$1?[redacted]')
    .slice(0, maxLength)
}

function errorReport(source: RendererErrorReport['source'], value: unknown, fallback: string): RendererErrorReport {
  const error = value instanceof Error ? value : null
  return {
    source,
    name: sanitize(error?.name || 'Error', 100),
    message: sanitize(error?.message || (typeof value === 'string' ? value : fallback), MAX_MESSAGE_LENGTH),
    stack: error?.stack ? sanitize(error.stack, MAX_STACK_LENGTH) : null,
  }
}

export function installRendererErrorReporting(bridge: Pick<RememberBridge, 'reportRendererError'>) {
  const reportTimes: number[] = []
  const report = (input: RendererErrorReport) => {
    const now = Date.now()
    while (reportTimes.length && now - (reportTimes[0] ?? now) >= REPORT_WINDOW_MS) reportTimes.shift()
    if (reportTimes.length >= MAX_REPORTS_PER_WINDOW) return
    reportTimes.push(now)
    bridge.reportRendererError(input)
  }
  const onError = (event: ErrorEvent) => {
    const input = errorReport('error', event.error, event.message || 'renderer-error')
    if (!input.stack && event.filename && Number.isInteger(event.lineno) && event.lineno > 0) {
      const column = Number.isInteger(event.colno) && event.colno >= 0 ? event.colno : 0
      input.stack = `${input.name}: renderer-error\n    at renderer (${sanitize(event.filename, 1_000)}:${event.lineno}:${column})`
    }
    if (/^ResizeObserver loop (?:limit exceeded|completed with undelivered notifications\.?)$/.test(event.message)) {
      input.reason = 'resize-observer-loop'
    } else if (/^Script error\.?$/.test(event.message)) {
      input.reason = 'script-error'
    } else if (!(event.error instanceof Error)) {
      input.reason = 'missing-error-object'
    }
    report(input)
  }
  const onUnhandledRejection = (event: PromiseRejectionEvent) =>
    report(errorReport('unhandled-rejection', event.reason, 'renderer-unhandled-rejection'))

  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onUnhandledRejection)
  return () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onUnhandledRejection)
  }
}
