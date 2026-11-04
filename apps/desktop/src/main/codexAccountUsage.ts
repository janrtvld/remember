import type { AgentAccountUsage } from '@remember/shared'

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

export function parseCodexAccountUsage(value: unknown, now = Date.now()): AgentAccountUsage {
  const response = object(value)
  const buckets = object(response.rateLimitsByLimitId)
  // Other buckets can meter separately. Never present one of them as the core Codex account.
  const core = object(buckets.codex ?? (Object.keys(buckets).length ? null : response.rateLimits))
  const windows: AgentAccountUsage['windows'] = []
  for (const key of ['primary', 'secondary']) {
    const window = object(core[key])
    if (typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) continue
    if (
      typeof window.windowDurationMins !== 'number' ||
      !Number.isSafeInteger(window.windowDurationMins) ||
      window.windowDurationMins <= 0
    )
      continue
    windows.push({
      remainingPercent: Math.max(0, Math.min(100, 100 - window.usedPercent)),
      durationMinutes: window.windowDurationMins,
      resetsAt:
        typeof window.resetsAt === 'number' && Number.isFinite(new Date(window.resetsAt * 1000).getTime())
          ? window.resetsAt * 1000
          : null,
    })
  }
  return { provider: 'codex', checkedAt: now, windows }
}
