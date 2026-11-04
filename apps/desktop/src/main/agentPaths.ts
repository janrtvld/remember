import { execFile } from 'node:child_process'
import { accessSync, closeSync, constants, openSync, readSync } from 'node:fs'
import path from 'node:path'
import type { AgentProvider } from '@remember/shared'

type AgentAuthenticationState = 'authenticated' | 'signed-out' | 'unknown'

type AgentStatusProbe = {
  executable: string
  code: number | null
  output: string
}

const SIGNED_OUT_PATTERN =
  /not logged in|not authenticated|signed out|unauthenticated|authentication required|please (?:log|sign) in|run \/login/i
const SHELL_ENVIRONMENT_TIMEOUT_MS = 5_000
const shellEnvironmentCache = new Map<string, Promise<NodeJS.ProcessEnv>>()

export function agentLoginShellEnvironment(homeDirectory: string, environment: NodeJS.ProcessEnv = process.env) {
  const shell = environment.SHELL?.startsWith('/') ? environment.SHELL : '/bin/zsh'
  const cacheKey = `${homeDirectory}\0${shell}`
  const cached = shellEnvironmentCache.get(cacheKey)
  if (cached) return cached

  const pending = new Promise<NodeJS.ProcessEnv>((resolve) => {
    execFile(
      shell,
      ['-lic', '/usr/bin/env -0'],
      {
        cwd: homeDirectory,
        env: { ...environment, HOME: homeDirectory },
        encoding: 'buffer',
        timeout: SHELL_ENVIRONMENT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout) => resolve(error ? {} : parseNullDelimitedEnvironment(stdout))
    )
  })
  shellEnvironmentCache.set(cacheKey, pending)
  return pending
}

export function parseNullDelimitedEnvironment(output: Buffer | string) {
  return Object.fromEntries(
    output
      .toString()
      .split('\0')
      .map((entry) => {
        const separator = entry.indexOf('=')
        return separator > 0 ? ([entry.slice(0, separator), entry.slice(separator + 1)] as const) : null
      })
      .filter((entry): entry is readonly [string, string] => entry !== null)
  )
}

export function agentProcessEnvironment(
  executable: string,
  homeDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
  shellEnvironment: NodeJS.ProcessEnv = {}
) {
  const bunInstall = environment.BUN_INSTALL?.trim() || shellEnvironment.BUN_INSTALL?.trim()
  const pathDirectories = [
    path.dirname(executable),
    ...(bunInstall ? [path.join(bunInstall, 'bin')] : []),
    path.join(homeDirectory, '.bun', 'bin'),
    path.join(homeDirectory, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...(shellEnvironment.PATH ?? '').split(path.delimiter),
    ...(environment.PATH ?? '').split(path.delimiter),
  ].filter(Boolean)

  return {
    ...shellEnvironment,
    ...environment,
    HOME: homeDirectory,
    CODEX_HOME:
      environment.CODEX_HOME?.trim() || shellEnvironment.CODEX_HOME?.trim() || path.join(homeDirectory, '.codex'),
    ...(bunInstall ? { BUN_INSTALL: bunInstall } : {}),
    PATH: Array.from(new Set(pathDirectories)).join(path.delimiter),
  }
}

export function resolveAgentProcessCommand(
  executable: string,
  arguments_: string[],
  homeDirectory: string,
  environment: NodeJS.ProcessEnv = process.env
) {
  const bunExecutable = executableFromPath('bun', [
    ...(environment.BUN_INSTALL ? [path.join(environment.BUN_INSTALL, 'bin')] : []),
    ...(environment.PATH ?? '').split(path.delimiter),
    path.join(homeDirectory, '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ])
  if (!hasNodeShebang(executable) || !isExecutable(bunExecutable)) {
    return { executable, arguments: arguments_ }
  }

  return {
    executable: bunExecutable,
    arguments: [executable, ...arguments_],
  }
}

function executableFromPath(name: string, directories: string[]) {
  return Array.from(new Set(directories.filter(Boolean)))
    .map((directory) => path.join(directory, name))
    .find(isExecutable)
}

export function agentAuthenticationState(
  provider: AgentProvider,
  code: number | null,
  output: string
): AgentAuthenticationState {
  if (SIGNED_OUT_PATTERN.test(output)) return 'signed-out'

  if (provider === 'claude') {
    const status = parseStatusObject(output)
    if (status?.loggedIn === true) return 'authenticated'
    if (status?.loggedIn === false) return 'signed-out'
    return 'unknown'
  }

  return code === 0 ? 'authenticated' : 'unknown'
}

export function selectAgentStatusProbe(provider: AgentProvider, probes: AgentStatusProbe[]) {
  const evaluated = probes.map((probe) => ({
    ...probe,
    authentication: agentAuthenticationState(provider, probe.code, probe.output),
  }))
  // A broken duplicate installation must not override a definitive result from another runnable CLI.
  return (
    evaluated.find((probe) => probe.authentication === 'authenticated') ??
    evaluated.find((probe) => probe.authentication === 'signed-out') ??
    evaluated[0] ??
    null
  )
}

function hasNodeShebang(executable: string) {
  try {
    const descriptor = openSync(executable, 'r')
    try {
      const buffer = Buffer.alloc(256)
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0)
      const firstLine = buffer.toString('utf8', 0, bytesRead).split(/\r?\n/, 1)[0] ?? ''
      return firstLine.startsWith('#!') && /\bnode\b/.test(firstLine)
    } finally {
      closeSync(descriptor)
    }
  } catch {
    return false
  }
}

function isExecutable(executable: string | undefined): executable is string {
  if (!executable) return false
  try {
    accessSync(executable, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function parseStatusObject(output: string) {
  const trimmed = output.trim()
  const objectStart = trimmed.indexOf('{')
  const objectEnd = trimmed.lastIndexOf('}')
  const candidates = [
    trimmed,
    objectStart >= 0 && objectEnd > objectStart ? trimmed.slice(objectStart, objectEnd + 1) : '',
  ]

  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as unknown
      if (value && typeof value === 'object') return value as { loggedIn?: unknown }
    } catch {
      // Try the status object after any CLI warnings.
    }
  }
  return null
}
