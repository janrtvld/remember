import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  appendAgentUsageAt,
  claudeUsageTokens,
  codexUsageTokens,
  createAgentUsageReader,
  summarizeAgentUsage,
} from '../agentUsageStore'
import { parseCodexAccountUsage } from '../codexAccountUsage'

test('provider token accounting includes Claude caches without double-counting Codex cache reads', () => {
  assert.deepEqual(codexUsageTokens({ input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100 }), {
    inputTokens: 1000,
    outputTokens: 100,
    cachedInputTokens: 800,
  })
  assert.deepEqual(
    claudeUsageTokens({ inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 700, cacheCreationInputTokens: 200 }),
    {
      inputTokens: 1000,
      outputTokens: 50,
      cachedInputTokens: 700,
    }
  )
  assert.equal(codexUsageTokens(null), null)
  assert.equal(codexUsageTokens({ input_tokens: -1, output_tokens: 0 }), null)
  assert.equal(claudeUsageTokens({ inputTokens: Number.NaN, outputTokens: 0 }), null)
})

test('receipts survive a new reader, deduplicate receipt IDs, and tolerate a partial append', () => {
  const directory = mkdtempSync(join(tmpdir(), 'remember-usage-'))
  try {
    const file = join(directory, 'usage.ndjson')
    const read = createAgentUsageReader(file)
    assert.deepEqual(read(), [])
    const receipt = {
      id: 'turn:model',
      provider: 'claude' as const,
      model: 'sonnet',
      recordedAt: 100,
      inputTokens: 1000,
      outputTokens: 100,
      cachedInputTokens: 800,
    }
    appendAgentUsageAt(file, receipt)
    appendAgentUsageAt(file, receipt)
    const later = { ...receipt, id: 'later:model', recordedAt: 200 }
    const laterLine = JSON.stringify(later)
    appendFileSync(file, laterLine.slice(0, 6))
    assert.deepEqual(read(), [receipt])
    appendFileSync(file, `${laterLine.slice(6)}\n`)
    assert.deepEqual(read(), [receipt, later])
    assert.deepEqual(createAgentUsageReader(file)(), [receipt, later])
    rmSync(file)
    assert.deepEqual(read(), [])
    appendAgentUsageAt(file, later)
    assert.deepEqual(read(), [later])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('summary uses local calendar days and keeps providers and absent history distinct', () => {
  const now = new Date(2026, 8, 16, 12).getTime()
  const receipt = {
    id: '1',
    provider: 'codex' as const,
    model: 'gpt',
    recordedAt: now,
    inputTokens: 1000,
    outputTokens: 100,
    cachedInputTokens: 500,
  }
  const summary = summarizeAgentUsage(
    [
      receipt,
      { ...receipt, id: '2', provider: 'claude', recordedAt: new Date(2026, 8, 10, 0).getTime() },
      { ...receipt, id: '3', recordedAt: new Date(2026, 8, 9, 23, 59).getTime() },
      { ...receipt, id: 'future', recordedAt: now + 60_000 },
    ],
    now
  )
  assert.equal(summary.firstRecordedAt, new Date(2026, 8, 9, 23, 59).getTime())
  assert.equal(summary.providers[0].today.inputTokens, 1000)
  assert.equal(summary.providers[0].week.inputTokens, 1000)
  assert.equal(summary.providers[1].today.inputTokens, 0)
  assert.equal(summary.providers[1].week.inputTokens, 1000)
  assert.equal(summarizeAgentUsage([], now).firstRecordedAt, null)
})

test('account usage prefers core Codex bucket, clamps remaining, and preserves unavailable values', () => {
  const result = parseCodexAccountUsage(
    {
      rateLimits: { primary: { usedPercent: 40, windowDurationMins: 300 } },
      rateLimitsByLimitId: {
        codex: {
          primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 2000 },
          secondary: { usedPercent: 105, windowDurationMins: 10080, resetsAt: null },
        },
        other: { primary: { usedPercent: 90, windowDurationMins: 300 } },
      },
    },
    1000
  )
  assert.deepEqual(result.windows, [
    { remainingPercent: 95, durationMinutes: 300, resetsAt: 2000000 },
    { remainingPercent: 0, durationMinutes: 10080, resetsAt: null },
  ])
  assert.deepEqual(
    parseCodexAccountUsage({
      rateLimitsByLimitId: { other: {} },
      rateLimits: { primary: { usedPercent: 5, windowDurationMins: 300 } },
    }).windows,
    []
  )
  assert.deepEqual(
    parseCodexAccountUsage({ rateLimits: { primary: { usedPercent: null, windowDurationMins: 300 } } }).windows,
    []
  )
  assert.equal(
    parseCodexAccountUsage({ rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 } } }).windows[0]
      .remainingPercent,
    90
  )
})
