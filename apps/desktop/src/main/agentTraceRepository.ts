import { join } from 'node:path'
import type { AgentTraceEvent } from '@remember/shared'
import { app } from 'electron'
import { appendAgentTraceAt, readAgentTraceAt, recoverInterruptedAgentTraceAt } from './agentTraceStore'

function agentTracePath() {
  return join(app.getPath('userData'), 'daily-review', 'agent-trace.ndjson')
}

export function listAgentTrace() {
  return readAgentTraceAt(agentTracePath())
}

export function recordAgentTrace(event: AgentTraceEvent) {
  try {
    appendAgentTraceAt(agentTracePath(), event)
  } catch (error) {
    console.warn('[agent-trace] could not record event', error)
  }
}

export function recoverInterruptedAgentTrace() {
  try {
    return recoverInterruptedAgentTraceAt(agentTracePath())
  } catch (error) {
    console.warn('[agent-trace] could not recover interrupted events', error)
    return 0
  }
}
