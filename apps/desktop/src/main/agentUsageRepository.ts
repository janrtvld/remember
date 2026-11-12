import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { app } from 'electron'
import {
  appendAgentUsageAt,
  claudeUsageTokens,
  codexUsageTokens,
  createAgentUsageReader,
  summarizeAgentUsage,
} from './agentUsageStore'

function usagePath() {
  return join(app.getPath('userData'), 'daily-review', 'agent-usage.ndjson')
}

let readUsage: ReturnType<typeof createAgentUsageReader> | null = null

export function getAgentUsage() {
  readUsage ??= createAgentUsageReader(usagePath())
  return summarizeAgentUsage(readUsage())
}

export function recordCodexUsage(model: string, usage: unknown) {
  const tokens = codexUsageTokens(usage)
  if (!tokens) return
  try {
    appendAgentUsageAt(usagePath(), { id: randomUUID(), provider: 'codex', model, recordedAt: Date.now(), ...tokens })
  } catch (error) {
    console.warn('[agent-usage] could not record Codex usage', error)
  }
}

export function recordClaudeUsage(result: SDKResultMessage) {
  // Every query here sends one prompt. modelUsage includes subagents and cache tokens,
  // and starts fresh when an existing Claude session is resumed.
  const invocationId = randomUUID()
  try {
    for (const [model, usage] of Object.entries(result.modelUsage ?? {})) {
      const tokens = claudeUsageTokens(usage)
      if (!tokens) continue
      appendAgentUsageAt(usagePath(), {
        id: `${invocationId}:${model}`,
        provider: 'claude',
        model,
        recordedAt: Date.now(),
        ...tokens,
      })
    }
  } catch (error) {
    console.warn('[agent-usage] could not record Claude usage', error)
  }
}
