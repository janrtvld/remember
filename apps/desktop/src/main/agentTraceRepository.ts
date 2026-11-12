import { join } from 'node:path'
import type { AgentTraceEvent } from '@remember/shared'
import { app } from 'electron'
import {
  appendAgentTraceAt,
  compactAgentTraceAt,
  createAgentTraceReader,
  recoverInterruptedAgentTraceAt,
} from './agentTraceStore'

function agentTracePath() {
  return join(app.getPath('userData'), 'daily-review', 'agent-trace.ndjson')
}

let readTrace: ReturnType<typeof createAgentTraceReader> | null = null

export function listAgentTrace() {
  readTrace ??= createAgentTraceReader(agentTracePath())
  return readTrace()
}

export function recordAgentTrace(event: AgentTraceEvent) {
  try {
    appendAgentTraceAt(agentTracePath(), event)
  } catch (error) {
    console.warn('[agent-trace] could not record event', error)
  }
}

/**
 * Fails the events a previous run left running. Launch defers this past the first screen because the trace can be
 * tens of megabytes, so events started by this run (at or after `launchedAt`) are left alone.
 */
export function recoverInterruptedAgentTrace(launchedAt: number) {
  try {
    compactAgentTraceAt(agentTracePath())
    return recoverInterruptedAgentTraceAt(agentTracePath(), Date.now(), launchedAt)
  } catch (error) {
    console.warn('[agent-trace] could not recover interrupted events', error)
    return 0
  }
}
