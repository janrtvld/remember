import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

type McpServer = {
  enabled_tools?: string[]
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  env_vars?: string[]
  startup_timeout_sec?: number
  tool_timeout_sec?: number
}

// Personal installation integration: use the provider's installed launcher and
// dependencies. Do not copy binaries, import unrelated plugins, or use its login.
export function installedCodexWorkerTools(providerHome: string): Record<string, McpServer> {
  for (const plugin of ['unified-computer-use', 'computer-use']) {
    const root = path.join(providerHome, 'plugins', 'cache', 'openai-bundled', plugin)
    let versions: string[]
    try {
      versions = readdirSync(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    } catch {
      continue
    }
    for (const version of versions) {
      const directory = path.join(root, version)
      try {
        const manifest = JSON.parse(readFileSync(path.join(directory, '.mcp.json'), 'utf8'))
        const name = plugin === 'unified-computer-use' ? 'cua_repl' : 'computer-use'
        const server = manifest.mcpServers?.[name]
        if (!server || typeof server.command !== 'string') continue
        const command = path.resolve(directory, server.command)
        if (!existsSync(command)) continue
        if (plugin === 'computer-use' && !existsSync(path.join(providerHome, 'computer-use', 'Codex Computer Use.app')))
          continue
        return {
          [name]: {
            command,
            ...(plugin === 'unified-computer-use' ? { enabled_tools: ['js', 'js_reset', 'turn_ended'] } : {}),
            args:
              Array.isArray(server.args) && server.args.every((arg: unknown) => typeof arg === 'string')
                ? server.args
                : [],
            cwd: path.resolve(directory, server.cwd ?? '.'),
            env: {
              ...server.env,
              CODEX_HOME: providerHome,
              ...(plugin === 'unified-computer-use' ? { BROWSER_USE_AVAILABLE_BACKENDS: 'chrome' } : {}),
            },
            env_vars: Array.isArray(server.env_vars) ? server.env_vars : [],
            startup_timeout_sec: 120,
            tool_timeout_sec: 300,
          },
        }
      } catch {
        /* Missing or stale installations do not disable shell/MCP work. */
      }
    }
  }
  return {}
}
