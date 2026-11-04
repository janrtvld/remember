export type AgentComputer = { kind: 'local' } | RemoteAgentComputer

export type RemoteAgentComputer = {
  kind: 'remote'
  endpoint: string
  workspace: string
  displayHost?: string
}

export function normalizeAgentComputer(value: unknown): AgentComputer {
  if (value === undefined || value === null) return { kind: 'local' }
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-agent-computer')
  const input = value as Record<string, unknown>
  if (input.kind === 'local') return { kind: 'local' }
  if (input.kind !== 'remote' || typeof input.endpoint !== 'string' || typeof input.workspace !== 'string') {
    throw new Error('invalid-agent-computer')
  }
  let endpoint: URL
  try {
    endpoint = new URL(input.endpoint)
  } catch {
    throw new Error('invalid-agent-computer-endpoint')
  }
  if (
    !['ws:', 'wss:'].includes(endpoint.protocol) ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname) ||
    !endpoint.port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/'
  ) {
    throw new Error('invalid-agent-computer-endpoint')
  }
  const workspace = input.workspace.trim()
  if (
    !workspace.startsWith('/') ||
    workspace.length > 2000 ||
    [...workspace].some((character) => character.charCodeAt(0) < 32) ||
    workspace.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new Error('invalid-agent-computer-workspace')
  }
  const displayHost = normalizeAgentDisplayHost(input.displayHost)
  return {
    kind: 'remote',
    endpoint: endpoint.toString(),
    workspace: workspace.replace(/\/+$/, '') || '/',
    ...(displayHost ? { displayHost } : {}),
  }
}

export function normalizeAgentDisplayHost(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('invalid-agent-computer-display-host')
  const address = value.trim()
  if (!address) return undefined
  const service = /^(.*)\._rfb\._tcp\.local$/i.exec(address)
  if (service) {
    const instance = service[1]
    if (
      !instance.trim() ||
      new TextEncoder().encode(instance).length > 63 ||
      ['.', '/', '@', ':', '#', '?', '%', '\\', '[', ']'].some((character) => instance.includes(character)) ||
      /[\p{C}\p{Zl}\p{Zp}]/u.test(instance)
    )
      throw new Error('invalid-agent-computer-display-host')
    return `${instance}._rfb._tcp.local`
  }
  const host = address.toLowerCase()
  if (host.length > 253) throw new Error('invalid-agent-computer-display-host')
  const ipv6 = /^\[[0-9a-f:]+\]$/.test(host)
  const hostname = host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  if (!ipv6 && !hostname) throw new Error('invalid-agent-computer-display-host')
  try {
    const parsed = new URL(`http://${host}/`)
    // Reject numeric aliases and other URL rewrites so the saved host is unambiguous.
    if (!ipv6 && parsed.hostname !== host) throw new Error('rewritten-host')
    return parsed.hostname
  } catch {
    throw new Error('invalid-agent-computer-display-host')
  }
}

export function agentComputerExecutionTarget(computer: AgentComputer): AgentComputer {
  return computer.kind === 'local'
    ? { kind: 'local' }
    : { kind: 'remote', endpoint: computer.endpoint, workspace: computer.workspace }
}

export function agentComputerExecutionKey(computer: AgentComputer): string {
  return JSON.stringify(agentComputerExecutionTarget(computer))
}
