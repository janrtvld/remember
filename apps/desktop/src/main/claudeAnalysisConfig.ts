import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'

const CONFIG_FILENAME = 'claude-analysis.json'
const MAX_CONFIG_BYTES = 64 * 1024
const ALLOWED_KEYS = new Set(['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'])

type ClaudeAnalysisConfig = {
  ANTHROPIC_BASE_URL: string
  ANTHROPIC_AUTH_TOKEN: string
}

export type ClaudeAnalysisConfigState =
  | { status: 'absent'; path: string }
  | { status: 'valid'; path: string; config: ClaudeAnalysisConfig }
  | { status: 'invalid'; path: string; detail: string }

let configuredState: ClaudeAnalysisConfigState = { status: 'absent', path: CONFIG_FILENAME }

export function claudeAnalysisConfigPath(userDataDirectory: string) {
  return path.join(userDataDirectory, CONFIG_FILENAME)
}

export function loadClaudeAnalysisConfig(userDataDirectory: string): ClaudeAnalysisConfigState {
  const configPath = claudeAnalysisConfigPath(userDataDirectory)
  try {
    const linkInfo = lstatSync(configPath)
    if (!linkInfo.isFile()) return invalid(configPath, 'The configuration path must be a regular file.')
    if (linkInfo.size > MAX_CONFIG_BYTES)
      return invalid(configPath, 'The configuration file must be smaller than 64 KiB.')
    if (process.platform !== 'win32' && (linkInfo.mode & 0o077) !== 0) {
      return invalid(
        configPath,
        'The configuration file permissions must be restricted to the current user (chmod 600).'
      )
    }
    if (typeof process.getuid === 'function' && linkInfo.uid !== process.getuid()) {
      return invalid(configPath, 'The configuration file must be owned by the current user.')
    }

    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return invalid(configPath, 'The configuration file must contain one JSON object.')
    }

    const values = parsed as Record<string, unknown>
    const unknownKeys = Object.keys(values).filter((key) => !ALLOWED_KEYS.has(key))
    if (unknownKeys.length > 0) return invalid(configPath, 'The configuration file contains an unsupported key.')

    const baseUrl = requiredSingleLineString(values.ANTHROPIC_BASE_URL)
    const authToken = requiredSingleLineString(values.ANTHROPIC_AUTH_TOKEN)
    if (!baseUrl || !authToken) {
      return invalid(configPath, 'ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN must both be non-empty strings.')
    }

    let endpoint: URL
    try {
      endpoint = new URL(baseUrl)
    } catch {
      return invalid(configPath, 'ANTHROPIC_BASE_URL must be a valid HTTPS URL.')
    }
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) {
      return invalid(configPath, 'ANTHROPIC_BASE_URL must be an HTTPS URL without embedded credentials.')
    }

    return {
      status: 'valid',
      path: configPath,
      config: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: authToken },
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent', path: configPath }
    if (error instanceof SyntaxError) return invalid(configPath, 'The configuration file is not valid JSON.')
    return invalid(configPath, 'The configuration file could not be read.')
  }
}

export function initializeClaudeAnalysisConfig(userDataDirectory: string) {
  configuredState = loadClaudeAnalysisConfig(userDataDirectory)
  return configuredState
}

export function claudeAnalysisEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (configuredState.status === 'invalid') {
    throw new Error('claude-config-invalid', { cause: new Error(configuredState.detail) })
  }
  if (configuredState.status === 'absent') return environment
  return { ...environment, ...configuredState.config }
}

export function redactClaudeAnalysisSecrets(value: string) {
  if (configuredState.status !== 'valid') return value
  return value.replaceAll(configuredState.config.ANTHROPIC_AUTH_TOKEN, '[credential redacted]')
}

function requiredSingleLineString(value: unknown) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  const hasControlCharacter = Array.from(trimmed).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 31 || codePoint === 127
  })
  return trimmed && !hasControlCharacter ? trimmed : null
}

function invalid(configPath: string, detail: string): ClaudeAnalysisConfigState {
  return { status: 'invalid', path: configPath, detail }
}
