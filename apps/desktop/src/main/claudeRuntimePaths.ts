import path from 'node:path'

export const CLAUDE_AGENT_SDK_VERSION = '0.3.317'
const AMBIENT_CLAUDE_CREDENTIAL_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_ORGANIZATION_ID',
  'ANTHROPIC_PROFILE',
  'CLAUDECODE',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_VERTEX',
] as const

export function bundledClaudeExecutablePath({
  isPackaged,
  appPath,
  resourcesPath,
  platform = process.platform,
  architecture = process.arch,
}: {
  isPackaged: boolean
  appPath: string
  resourcesPath: string
  platform?: NodeJS.Platform
  architecture?: string
}) {
  if (platform !== 'darwin' || architecture !== 'arm64') return null
  if (isPackaged) return path.join(resourcesPath, 'claude')
  return path.join(appPath, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-darwin-arm64', 'claude')
}

export function withClaudeRuntimeEnvironment(environment: NodeJS.ProcessEnv, configDirectory: string) {
  const isolatedEnvironment = { ...environment }
  for (const key of AMBIENT_CLAUDE_CREDENTIAL_KEYS) delete isolatedEnvironment[key]
  return {
    ...isolatedEnvironment,
    CLAUDE_CONFIG_DIR: configDirectory,
    CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
    CLAUDE_AGENT_SDK_VERSION,
  }
}
