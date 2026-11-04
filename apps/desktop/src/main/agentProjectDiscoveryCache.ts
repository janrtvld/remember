import type { AgentProject } from '@remember/shared'

export function createAgentProjectDiscoveryCache(
  discover: () => Promise<AgentProject[]>,
  { now = Date.now, maxAgeMs = 60_000 }: { now?: () => number; maxAgeMs?: number } = {}
) {
  let cached: { projects: AgentProject[]; expiresAt: number } | null = null
  let pending: Promise<AgentProject[]> | null = null

  return () => {
    if (cached && now() < cached.expiresAt) return Promise.resolve(cached.projects)
    pending ??= discover()
      .then((projects) => {
        cached = { projects, expiresAt: now() + maxAgeMs }
        return projects
      })
      .finally(() => {
        pending = null
      })
    return pending
  }
}
