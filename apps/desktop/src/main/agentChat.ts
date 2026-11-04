import type { AgentProvider } from '@remember/shared'

const DESKTOP_APPS: Record<AgentProvider, { bundleId: string }> = {
  codex: {
    bundleId: 'com.openai.codex',
  },
  claude: {
    bundleId: 'com.anthropic.claudefordesktop',
  },
}

export type AgentChatRuntime = {
  commandPath: string
  dataDirectory: string
  isolated: boolean
  taskPrompt?: string
  mcpServerName?: string
}

type AgentChatIntent = { provider: AgentProvider } & (
  | { kind: 'query'; query: string }
  | { kind: 'workItem'; workItemId: string }
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function escapeAppleScriptString(value: string) {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

export function parseAgentChatInput(input: unknown): AgentChatIntent | null {
  if (!isRecord(input) || Object.keys(input).some((key) => !['provider', 'query', 'workItemId'].includes(key)))
    return null
  if (input.provider !== 'codex' && input.provider !== 'claude') return null
  if (input.workItemId !== undefined) {
    if (
      input.provider !== 'codex' ||
      input.query !== undefined ||
      typeof input.workItemId !== 'string' ||
      !input.workItemId.trim() ||
      input.workItemId.length > 200
    )
      return null
    return { provider: 'codex', kind: 'workItem', workItemId: input.workItemId }
  }
  if (typeof input.query !== 'string') return null

  const query = input.query.trim().slice(0, 20_000)
  if (!query) return null
  return { provider: input.provider, kind: 'query', query }
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function scopedCli(runtime: AgentChatRuntime, provider: AgentProvider) {
  return `REMEMBER_AGENT=${provider} REMEMBER_DATA_DIR=${shellQuote(runtime.dataDirectory)} ${shellQuote(runtime.commandPath)}`
}

function mcpScope(runtime?: AgentChatRuntime) {
  const server = JSON.stringify(runtime?.mcpServerName ?? 'remember')
  return (
    `Use the connected Remember MCP server ${server}.` +
    (runtime
      ? ` First call its remember_status tool and verify dataDirectory is ${JSON.stringify(runtime.dataDirectory)}. If it differs or this server is unavailable, stop and ask me to connect the correct Remember profile; do not fall back to another server.`
      : '')
  )
}

export function normalizeAgentChatInput(input: unknown, runtime?: AgentChatRuntime) {
  const intent = parseAgentChatInput(input)
  if (!intent) return null
  if (intent.kind === 'workItem')
    return runtime?.taskPrompt ? { provider: intent.provider, prompt: runtime.taskPrompt } : null
  if (intent.kind !== 'query') return null
  return {
    provider: intent.provider,
    prompt:
      intent.provider === 'claude'
        ? `${mcpScope(runtime)} Retrieve only context relevant to this question: ${intent.query}`
        : runtime?.isolated
          ? `Use only this Remember CLI/profile prefix for lookups: ${scopedCli(runtime, intent.provider)}. Do not fall back to another Remember profile. ${intent.query}`
          : `$remember ${intent.query}`,
  }
}

export function matchingRememberMcpServer(config: unknown, runtime: AgentChatRuntime): string | null {
  if (!isRecord(config) || !isRecord(config.mcpServers)) return null
  const matches = Object.entries(config.mcpServers).filter(([, server]) => {
    if (!isRecord(server) || server.disabled === true) return false
    if (server.type !== undefined && server.type !== 'stdio') return false
    if (server.command !== runtime.commandPath) return false
    if (!Array.isArray(server.args) || server.args.length !== 1 || server.args[0] !== 'mcp') return false
    if (server.env !== undefined && !isRecord(server.env)) return false
    const dataDirectory = isRecord(server.env) ? server.env.REMEMBER_DATA_DIR : undefined
    return dataDirectory === undefined || dataDirectory === runtime.dataDirectory
  })
  const preferredName = runtime.isolated ? 'remember-dev' : 'remember'
  return matches.find(([name]) => name === preferredName)?.[0] ?? matches[0]?.[0] ?? null
}

export function buildDesktopChatAppleScript(provider: AgentProvider) {
  const app = DESKTOP_APPS[provider]
  return `tell application id "${escapeAppleScriptString(app.bundleId)}" to activate
delay 0.8
tell application "System Events"
  set agentProcess to first application process whose bundle identifier is "${escapeAppleScriptString(app.bundleId)}"
  tell agentProcess
    set frontmost to true
    keystroke "n" using command down
    delay 0.25
    keystroke "v" using command down
    delay 0.1
    key code 36
  end tell
end tell`
}
