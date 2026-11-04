import type { AgentAccountUsage, AgentProvider } from '@remember/shared'
import { parseCodexAccountUsage } from './codexAccountUsage'
import { startCodexAppServer } from './codexAuth'
import { bundledCodexExecutable } from './codexRuntime'
import { isOfflineMode, requireNetworkAccess } from './networkAccess'

export async function getAgentAccountUsage(provider: AgentProvider): Promise<AgentAccountUsage> {
  if (provider !== 'codex' && provider !== 'claude') throw new Error('invalid-agent-provider')
  const unavailable: AgentAccountUsage = { provider, checkedAt: Date.now(), windows: [] }
  // Claude's SDK currently exposes account limits only through an explicitly unstable API.
  if (provider !== 'codex' || isOfflineMode()) return unavailable
  const executable = bundledCodexExecutable()
  if (!executable) return unavailable
  try {
    requireNetworkAccess()
    const server = await startCodexAppServer(
      executable,
      () => {},
      () => {}
    )
    try {
      requireNetworkAccess()
      return parseCodexAccountUsage(await server.request('account/rateLimits/read', {}))
    } finally {
      server.close()
    }
  } catch {
    return unavailable
  }
}
