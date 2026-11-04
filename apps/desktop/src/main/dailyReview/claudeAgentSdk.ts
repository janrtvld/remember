import type { Options, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { createAgentError } from './agentErrors'
import { claudeResponseFailure } from './agentResponse'

type ClaudeSdkOptions = {
  abortController: AbortController
  cwd: string
  effort: NonNullable<Options['effort']>
  env: NodeJS.ProcessEnv
  executable: string
  model: string
  schema: Record<string, unknown>
  spawnClaudeCodeProcess: NonNullable<Options['spawnClaudeCodeProcess']>
  systemPrompt: string
}

type ClaudeChatSdkOptions = Omit<ClaudeSdkOptions, 'schema'>

export function buildClaudeSdkOptions(options: ClaudeSdkOptions): Options {
  return {
    abortController: options.abortController,
    cwd: options.cwd,
    effort: options.effort,
    env: options.env,
    mcpServers: {},
    model: options.model,
    outputFormat: { type: 'json_schema', schema: options.schema },
    pathToClaudeCodeExecutable: options.executable,
    permissionMode: 'dontAsk',
    persistSession: false,
    settingSources: [],
    spawnClaudeCodeProcess: options.spawnClaudeCodeProcess,
    strictMcpConfig: true,
    systemPrompt: options.systemPrompt,
    tools: [],
  }
}

export function buildClaudeChatSdkOptions(options: ClaudeChatSdkOptions): Options {
  const sdkOptions = buildClaudeSdkOptions({ ...options, schema: {} })
  const { outputFormat: _outputFormat, ...chatOptions } = sdkOptions
  return chatOptions
}

export function buildClaudeWorkspaceSdkOptions(options: ClaudeChatSdkOptions & { resume?: string }): Options {
  return {
    abortController: options.abortController,
    allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
    cwd: options.cwd,
    effort: options.effort,
    enableFileCheckpointing: true,
    env: options.env,
    mcpServers: {},
    model: options.model,
    pathToClaudeCodeExecutable: options.executable,
    permissionMode: 'dontAsk',
    persistSession: true,
    ...(options.resume ? { resume: options.resume } : {}),
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [], strictAllowlist: true },
      filesystem: { allowWrite: [options.cwd] },
    },
    settingSources: ['project'],
    spawnClaudeCodeProcess: options.spawnClaudeCodeProcess,
    strictMcpConfig: true,
    systemPrompt: options.systemPrompt,
    tools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
  }
}

export function claudeSdkResultError(result: SDKResultMessage) {
  if (result.subtype === 'success') {
    if (!result.is_error) return null
    const failure = claudeResponseFailure(JSON.stringify(result))
    return failure ? createAgentError(failure.code, failure.detail) : new Error(result.result || 'claude-failed')
  }

  const detail = result.errors.join('\n') || result.subtype
  if (result.subtype === 'error_max_structured_output_retries') {
    return createAgentError('claude-structured-output-failed', detail)
  }
  if (/authenticate|authentication|oauth session expired|unauthorized/i.test(detail)) {
    return createAgentError('claude-auth-required', detail)
  }
  return new Error(detail)
}

export function isSuccessfulClaudeSdkResult(
  result: SDKResultMessage | null
): result is Extract<SDKResultMessage, { subtype: 'success' }> {
  return result?.subtype === 'success' && !result.is_error
}
