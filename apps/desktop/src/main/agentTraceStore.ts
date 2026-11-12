import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import type { AgentTraceAction, AgentTraceDiagnostic, AgentTraceEvent } from '@remember/shared'

const MAX_TRACE_EVENTS = 200
// Every progress update appends its whole event again, so the file holds many
// superseded lines per retained event before it is worth rewriting.
const COMPACT_AFTER_LINES = MAX_TRACE_EVENTS * 4
const MAX_DIAGNOSTICS = 8
const MAX_DIAGNOSTIC_TEXT_LENGTH = 1024 * 1024
type StoredTraceEvent = Omit<Partial<AgentTraceEvent>, 'provider'> & {
  provider?: AgentTraceEvent['provider'] | 'local'
}

const traceActions = new Set<AgentTraceAction>([
  'day-refresh',
  'context-import',
  'agent-learning',
  'cli-status',
  'cli-days',
  'cli-day',
  'cli-search',
  'cli-conversations',
  'cli-usage',
  'cli-wiki-spaces',
  'cli-wiki-list',
  'cli-wiki-search',
  'cli-wiki-read',
  'cli-wiki-write',
])

function normalizeDiagnostic(value: unknown): AgentTraceDiagnostic | null {
  if (!value || typeof value !== 'object') return null
  const diagnostic = value as Partial<AgentTraceDiagnostic>
  if (
    (diagnostic.provider !== 'codex' && diagnostic.provider !== 'claude') ||
    (diagnostic.phase !== 'shard' && diagnostic.phase !== 'final') ||
    (diagnostic.attempt !== 1 && diagnostic.attempt !== 2) ||
    typeof diagnostic.executable !== 'string' ||
    typeof diagnostic.launchExecutable !== 'string' ||
    !Array.isArray(diagnostic.arguments) ||
    !diagnostic.arguments.every((argument) => typeof argument === 'string') ||
    typeof diagnostic.workingDirectory !== 'string' ||
    typeof diagnostic.model !== 'string' ||
    typeof diagnostic.effort !== 'string' ||
    (diagnostic.outputFormat !== 'json' && diagnostic.outputFormat !== 'codex-output-file') ||
    typeof diagnostic.startedAt !== 'number' ||
    typeof diagnostic.completedAt !== 'number' ||
    typeof diagnostic.promptBytes !== 'number' ||
    typeof diagnostic.stdoutBytes !== 'number' ||
    typeof diagnostic.stderrBytes !== 'number' ||
    typeof diagnostic.stdout !== 'string' ||
    typeof diagnostic.stderr !== 'string' ||
    typeof diagnostic.systemPrompt !== 'string' ||
    typeof diagnostic.schema !== 'string' ||
    typeof diagnostic.prompt !== 'string' ||
    typeof diagnostic.truncated !== 'boolean' ||
    typeof diagnostic.error !== 'string'
  ) {
    return null
  }

  return {
    provider: diagnostic.provider,
    phase: diagnostic.phase,
    shardIndex: typeof diagnostic.shardIndex === 'number' ? diagnostic.shardIndex : null,
    shardCount: typeof diagnostic.shardCount === 'number' ? diagnostic.shardCount : null,
    attempt: diagnostic.attempt,
    executable: diagnostic.executable.slice(0, 2_000),
    launchExecutable: diagnostic.launchExecutable.slice(0, 2_000),
    arguments: diagnostic.arguments.slice(0, 100).map((argument) => argument.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH)),
    workingDirectory: diagnostic.workingDirectory.slice(0, 2_000),
    version: typeof diagnostic.version === 'string' ? diagnostic.version.slice(0, 500) : null,
    model: diagnostic.model.slice(0, 500),
    effort: diagnostic.effort.slice(0, 500),
    outputFormat: diagnostic.outputFormat,
    environment: {
      home: typeof diagnostic.environment?.home === 'string' ? diagnostic.environment.home.slice(0, 2_000) : null,
      path: typeof diagnostic.environment?.path === 'string' ? diagnostic.environment.path.slice(0, 20_000) : null,
      shell: typeof diagnostic.environment?.shell === 'string' ? diagnostic.environment.shell.slice(0, 2_000) : null,
      bunInstall:
        typeof diagnostic.environment?.bunInstall === 'string'
          ? diagnostic.environment.bunInstall.slice(0, 2_000)
          : null,
      claudeCode:
        typeof diagnostic.environment?.claudeCode === 'string'
          ? diagnostic.environment.claudeCode.slice(0, 2_000)
          : null,
    },
    exitCode: typeof diagnostic.exitCode === 'number' ? diagnostic.exitCode : null,
    startedAt: diagnostic.startedAt,
    completedAt: diagnostic.completedAt,
    promptBytes: diagnostic.promptBytes,
    stdoutBytes: diagnostic.stdoutBytes,
    stderrBytes: diagnostic.stderrBytes,
    stdout: diagnostic.stdout.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH),
    stderr: diagnostic.stderr.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH),
    systemPrompt: diagnostic.systemPrompt.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH),
    schema: diagnostic.schema.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH),
    prompt: diagnostic.prompt.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH),
    truncated:
      diagnostic.truncated ||
      diagnostic.stdout.length > MAX_DIAGNOSTIC_TEXT_LENGTH ||
      diagnostic.stderr.length > MAX_DIAGNOSTIC_TEXT_LENGTH ||
      diagnostic.systemPrompt.length > MAX_DIAGNOSTIC_TEXT_LENGTH ||
      diagnostic.schema.length > MAX_DIAGNOSTIC_TEXT_LENGTH ||
      diagnostic.prompt.length > MAX_DIAGNOSTIC_TEXT_LENGTH,
    error: diagnostic.error.slice(0, 5_000),
  }
}

function normalizeTraceEvent(value: unknown): AgentTraceEvent | null {
  if (!value || typeof value !== 'object') return null
  const event = value as StoredTraceEvent
  if (
    typeof event.id !== 'string' ||
    !traceActions.has(event.action as AgentTraceAction) ||
    (event.status !== 'running' && event.status !== 'completed' && event.status !== 'failed') ||
    typeof event.startedAt !== 'number'
  ) {
    return null
  }
  if (event.action === 'day-refresh' && event.provider === 'local') return null

  return {
    id: event.id,
    action: event.action as AgentTraceAction,
    provider: event.provider === 'codex' || event.provider === 'claude' ? event.provider : null,
    status: event.status,
    startedAt: event.startedAt,
    completedAt: typeof event.completedAt === 'number' ? event.completedAt : null,
    dayId: typeof event.dayId === 'string' ? event.dayId : null,
    reason:
      event.reason === 'manual' ||
      event.reason === 'downtime' ||
      event.reason === 'active-interval' ||
      event.reason === 'end-of-day'
        ? event.reason
        : null,
    error: typeof event.error === 'string' ? event.error : null,
    logs: Array.isArray(event.logs)
      ? event.logs
          .filter((entry): entry is { timestamp: number; message: string } =>
            Boolean(
              entry &&
                typeof entry === 'object' &&
                typeof entry.timestamp === 'number' &&
                typeof entry.message === 'string'
            )
          )
          .slice(-50)
          .map((entry) => ({ timestamp: entry.timestamp, message: entry.message.slice(0, 500) }))
      : [],
    diagnostics: Array.isArray(event.diagnostics)
      ? event.diagnostics
          .map(normalizeDiagnostic)
          .filter((diagnostic): diagnostic is AgentTraceDiagnostic => diagnostic !== null)
          .slice(-MAX_DIAGNOSTICS)
      : [],
  }
}

function mergeTraceLines(latestById: Map<string, AgentTraceEvent>, lines: string[], withDiagnostics: boolean) {
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const event = normalizeTraceEvent(JSON.parse(line) as unknown)
      if (event) latestById.set(event.id, withDiagnostics ? event : { ...event, diagnostics: [] })
    } catch {
      // Ignore a partial final line if another process is appending.
    }
  }
}

function latestTraceEvents(latestById: Map<string, AgentTraceEvent>, limit: number) {
  return [...latestById.values()].sort((left, right) => right.startedAt - left.startedAt).slice(0, limit)
}

export function readAgentTraceAt(path: string, limit = MAX_TRACE_EVENTS) {
  let contents = ''
  try {
    contents = readFileSync(path, 'utf8')
  } catch {
    return []
  }

  const latestById = new Map<string, AgentTraceEvent>()
  mergeTraceLines(latestById, contents.split('\n'), true)
  return latestTraceEvents(latestById, limit)
}

/**
 * Lists recent activity for display. The list is polled, so each call reads
 * only what was appended since the previous one, and it omits diagnostics:
 * raw prompts and output stay in the file for explicit debugging.
 */
export function createAgentTraceReader(path: string, limit = MAX_TRACE_EVENTS) {
  let inode: number | null = null
  let offset = 0
  let latestById = new Map<string, AgentTraceEvent>()
  return () => {
    let file: number
    try {
      file = openSync(path, 'r')
    } catch {
      return []
    }
    try {
      const { ino, size } = fstatSync(file)
      if (ino !== inode || size < offset) {
        inode = ino
        offset = 0
        latestById = new Map()
      }
      if (size > offset) {
        const appended = Buffer.allocUnsafe(size - offset)
        const length = readSync(file, appended, 0, appended.length, offset)
        // Leave a line that is still being written for the next call.
        const complete = appended.lastIndexOf(0x0a, length - 1) + 1
        mergeTraceLines(latestById, appended.toString('utf8', 0, complete).split('\n'), false)
        offset += complete
        if (latestById.size > limit) {
          latestById = new Map(latestTraceEvents(latestById, limit).map((event) => [event.id, event]))
        }
      }
    } finally {
      closeSync(file)
    }
    return latestTraceEvents(latestById, limit)
  }
}

/** Rewrites a trace that has accumulated superseded lines down to its retained events. */
export function compactAgentTraceAt(path: string, limit = MAX_TRACE_EVENTS) {
  let contents = ''
  try {
    contents = readFileSync(path, 'utf8')
  } catch {
    return false
  }
  const lines = contents.split('\n')
  if (lines.length <= COMPACT_AFTER_LINES) return false
  const latestById = new Map<string, AgentTraceEvent>()
  mergeTraceLines(latestById, lines, true)
  const retained = latestTraceEvents(latestById, limit).reverse()
  const temporaryPath = `${path}.compacting`
  writeFileSync(temporaryPath, retained.map((event) => `${JSON.stringify(event)}\n`).join(''), {
    encoding: 'utf8',
    mode: 0o600,
  })
  renameSync(temporaryPath, path)
  return true
}

export function appendAgentTraceAt(path: string, event: AgentTraceEvent) {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 })
}

export function recoverInterruptedAgentTraceAt(path: string, completedAt = Date.now()) {
  const interrupted = readAgentTraceAt(path, MAX_TRACE_EVENTS).filter((event) => event.status === 'running')
  for (const event of interrupted) {
    appendAgentTraceAt(path, {
      ...event,
      status: 'failed',
      completedAt,
      error: 'agent-interrupted',
      logs: [...event.logs, { timestamp: completedAt, message: 'Onderbroken doordat Remember opnieuw startte' }],
    })
  }
  return interrupted.length
}
