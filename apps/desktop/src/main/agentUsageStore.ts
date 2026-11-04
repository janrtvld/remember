import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AgentProvider, AgentUsageSummary, AgentUsageTotals } from '@remember/shared'

export type AgentUsageReceipt = {
  id: string
  provider: AgentProvider
  model: string
  recordedAt: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
}

const tokenCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0

export function codexUsageTokens(usage: unknown) {
  if (!usage || typeof usage !== 'object') return null
  const value = usage as Record<string, unknown>
  if (!tokenCount(value.input_tokens) || !tokenCount(value.output_tokens)) return null
  return {
    inputTokens: value.input_tokens,
    outputTokens: value.output_tokens,
    // Codex includes cache reads and writes in input_tokens; adding them again would double-count.
    cachedInputTokens: tokenCount(value.cached_input_tokens) ? value.cached_input_tokens : 0,
  }
}

export function claudeUsageTokens(usage: unknown) {
  if (!usage || typeof usage !== 'object') return null
  const value = usage as Record<string, unknown>
  if (!tokenCount(value.inputTokens) || !tokenCount(value.outputTokens)) return null
  const cachedInputTokens = tokenCount(value.cacheReadInputTokens) ? value.cacheReadInputTokens : 0
  const cacheCreationTokens = tokenCount(value.cacheCreationInputTokens) ? value.cacheCreationInputTokens : 0
  return {
    // Claude reports uncached input, cache reads, and cache writes separately.
    inputTokens: value.inputTokens + cachedInputTokens + cacheCreationTokens,
    outputTokens: value.outputTokens,
    cachedInputTokens,
  }
}

export function appendAgentUsageAt(path: string, receipt: AgentUsageReceipt) {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(receipt)}\n`, { encoding: 'utf8', mode: 0o600 })
}

export function readAgentUsageAt(path: string): AgentUsageReceipt[] {
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const receipts = new Map<string, AgentUsageReceipt>()
  for (const line of contents.split('\n')) {
    if (!line.trim()) continue
    try {
      const receipt = JSON.parse(line) as AgentUsageReceipt
      if (
        typeof receipt.id === 'string' &&
        (receipt.provider === 'claude' || receipt.provider === 'codex') &&
        typeof receipt.model === 'string' &&
        Number.isFinite(receipt.recordedAt) &&
        tokenCount(receipt.inputTokens) &&
        tokenCount(receipt.outputTokens) &&
        tokenCount(receipt.cachedInputTokens)
      )
        receipts.set(receipt.id, receipt)
    } catch {
      // A process may still be appending the final line.
    }
  }
  return [...receipts.values()]
}

function totals(receipts: AgentUsageReceipt[]): AgentUsageTotals {
  return receipts.reduce<AgentUsageTotals>(
    (sum, receipt) => ({
      inputTokens: sum.inputTokens + receipt.inputTokens,
      outputTokens: sum.outputTokens + receipt.outputTokens,
      cachedInputTokens: sum.cachedInputTokens + receipt.cachedInputTokens,
    }),
    { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }
  )
}

export function summarizeAgentUsage(receipts: AgentUsageReceipt[], now = Date.now()): AgentUsageSummary {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const week = new Date(today)
  week.setDate(week.getDate() - 6)
  const valid = receipts.filter((receipt) => receipt.recordedAt <= now)
  return {
    firstRecordedAt: valid.length
      ? valid.reduce((earliest, receipt) => Math.min(earliest, receipt.recordedAt), now)
      : null,
    providers: (['codex', 'claude'] as const).map((provider) => ({
      provider,
      today: totals(valid.filter((receipt) => receipt.provider === provider && receipt.recordedAt >= today.getTime())),
      week: totals(valid.filter((receipt) => receipt.provider === provider && receipt.recordedAt >= week.getTime())),
    })),
  }
}
