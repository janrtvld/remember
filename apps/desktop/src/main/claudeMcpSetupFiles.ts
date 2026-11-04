import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ClaudeMcpSetupStatus } from '@remember/shared'

export interface ClaudeMcpSetupPaths {
  config: string
  legacyCodeConfig: string
  command: string
  serverName: string
  dataDirectory?: string
}

type JsonObject = Record<string, unknown>

export function resolveClaudeMcpSetupPaths(
  homeDirectory: string,
  command: string,
  options: { serverName?: string; dataDirectory?: string } = {}
): ClaudeMcpSetupPaths {
  return {
    config: join(homeDirectory, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    legacyCodeConfig: join(homeDirectory, '.claude.json'),
    command,
    serverName: options.serverName ?? 'remember',
    dataDirectory: options.dataDirectory,
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readClaudeConfig(path: string): Promise<JsonObject> {
  let contents: string
  try {
    contents = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  const parsed: unknown = JSON.parse(contents)
  if (!isObject(parsed)) throw new Error('Claude-configuratie heeft geen geldig objectformaat.')
  return parsed
}

async function writeClaudeConfig(path: string, config: JsonObject): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.remember-installing`
  await rm(temporary, { force: true })
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}

function desiredServer(paths: ClaudeMcpSetupPaths): JsonObject {
  return {
    command: paths.command,
    args: ['mcp'],
    ...(paths.dataDirectory ? { env: { REMEMBER_DATA_DIR: paths.dataDirectory } } : {}),
  }
}

function matchesRememberServer(value: unknown, paths: ClaudeMcpSetupPaths): boolean {
  if (!isObject(value) || value.disabled === true) return false
  if (value.env !== undefined && !isObject(value.env)) return false
  if (
    isObject(value.env) &&
    value.env.REMEMBER_DATA_DIR !== undefined &&
    value.env.REMEMBER_DATA_DIR !== paths.dataDirectory
  )
    return false
  const args = value.args
  return (
    (value.type == null || value.type === 'stdio') &&
    value.command === paths.command &&
    Array.isArray(args) &&
    args.length === 1 &&
    args[0] === 'mcp'
  )
}

function statusFromConfig(config: JsonObject, paths: ClaudeMcpSetupPaths): ClaudeMcpSetupStatus {
  const mcpServers = config.mcpServers
  if (mcpServers == null) {
    return { connected: false, conflict: false, commandPath: paths.command, error: null }
  }
  if (!isObject(mcpServers)) throw new Error('Claude mcpServers-configuratie heeft geen geldig objectformaat.')
  if (!Object.hasOwn(mcpServers, paths.serverName)) {
    return { connected: false, conflict: false, commandPath: paths.command, error: null }
  }
  if (matchesRememberServer(mcpServers[paths.serverName], paths)) {
    return { connected: true, conflict: false, commandPath: paths.command, error: null }
  }
  return { connected: false, conflict: true, commandPath: paths.command, error: null }
}

export async function getClaudeMcpSetupStatusAt(paths: ClaudeMcpSetupPaths): Promise<ClaudeMcpSetupStatus> {
  return statusFromConfig(await readClaudeConfig(paths.config), paths)
}

export async function installClaudeMcpAt(paths: ClaudeMcpSetupPaths): Promise<ClaudeMcpSetupStatus> {
  const config = await readClaudeConfig(paths.config)
  const status = statusFromConfig(config, paths)
  if (status.conflict) return status

  if (!status.connected) {
    const mcpServers = isObject(config.mcpServers) ? config.mcpServers : {}
    await writeClaudeConfig(paths.config, {
      ...config,
      mcpServers: {
        ...mcpServers,
        [paths.serverName]: desiredServer(paths),
      },
    })
  }

  if (paths.serverName === 'remember') {
    const legacyConfig = await readClaudeConfig(paths.legacyCodeConfig)
    if (isObject(legacyConfig.mcpServers) && matchesRememberServer(legacyConfig.mcpServers.remember, paths)) {
      const { remember: _remember, ...remainingServers } = legacyConfig.mcpServers
      await writeClaudeConfig(paths.legacyCodeConfig, { ...legacyConfig, mcpServers: remainingServers })
    }
  }
  return getClaudeMcpSetupStatusAt(paths)
}
