import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { CodexOptions, ModelReasoningEffort, ThreadOptions, TurnOptions } from '@openai/codex-sdk'

type CodexSdkConfiguration = {
  abortController: AbortController
  cwd: string
  effort: string
  env: NodeJS.ProcessEnv
  executable: string
  model: string
  ownerProcessId?: number
  schema: object
  toolsDisabled?: boolean
}

type CodexChatSdkConfiguration = Omit<CodexSdkConfiguration, 'schema'>

function codexSdkWrapper(flags: string) {
  return `#!/bin/sh
set -m
wrapper_pid=$$
owner_pid=\${REMEMBER_CODEX_OWNER_PID:-$PPID}
codex_pid=
watchdog_pid=

terminate_codex() {
  trap - TERM INT HUP
  if [ -z "\${codex_pid:-}" ] || ! kill -0 "-$codex_pid" 2>/dev/null; then
    return
  fi
  kill -TERM "-$codex_pid" 2>/dev/null || kill -TERM "$codex_pid" 2>/dev/null || true
  sleep 2
  kill -KILL "-$codex_pid" 2>/dev/null || kill -KILL "$codex_pid" 2>/dev/null || true
}

stop_watchdog() {
  if [ -z "\${watchdog_pid:-}" ]; then
    return
  fi
  kill -HUP "-$watchdog_pid" 2>/dev/null || kill -HUP "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true
}

shutdown_codex() {
  stop_watchdog
  terminate_codex
}

trap 'shutdown_codex; exit 143' TERM
trap 'shutdown_codex; exit 130' INT
trap 'shutdown_codex; exit 129' HUP

if [ -n "\${REMEMBER_OFFLINE_SENTINEL:-}" ] && [ -e "$REMEMBER_OFFLINE_SENTINEL" ]; then
  exit 125
fi

"$REMEMBER_CODEX_EXECUTABLE" "$@" ${flags} &
codex_pid=$!

watch_owner() {
  trap 'exit 0' HUP
  while kill -0 "$owner_pid" 2>/dev/null && kill -0 "$wrapper_pid" 2>/dev/null; do
    sleep 1
  done
  terminate_codex
}

watch_owner &
watchdog_pid=$!

wait "$codex_pid"
codex_status=$?
stop_watchdog
terminate_codex
trap - TERM INT HUP
exit "$codex_status"
`
}

function definedEnvironment(environment: NodeJS.ProcessEnv) {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}

function codexSdkEnvironment(options: CodexChatSdkConfiguration) {
  return {
    ...definedEnvironment(options.env),
    REMEMBER_CODEX_EXECUTABLE: options.executable,
    REMEMBER_CODEX_OWNER_PID: String(options.ownerProcessId ?? process.pid),
  }
}

function scopedCodexSdkEnvironment(options: CodexSdkConfiguration) {
  const environment = codexSdkEnvironment(options)
  if (!options.toolsDisabled) return environment
  const authHome = options.env.CODEX_HOME
  if (!authHome || !path.isAbsolute(authHome)) throw new Error('codex-auth-home-missing')
  const directory = mkdtempSync(path.join(options.cwd, 'codex-home-'))
  // Global AGENTS.md is loaded independently of project_doc_max_bytes. Only
  // share the existing file-backed login; token refresh writes through this link.
  symlinkSync(path.join(authHome, 'auth.json'), path.join(directory, 'auth.json'))
  return { ...environment, CODEX_HOME: directory }
}

function createCodexSdkExecutable(directory: string, mode: 'isolated' | 'workspace' = 'isolated') {
  const executable = path.join(directory, 'codex-sdk')
  const flags = mode === 'workspace' ? '--ignore-user-config' : '--ephemeral --ignore-user-config --ignore-rules'
  writeFileSync(executable, codexSdkWrapper(flags), { encoding: 'utf8', mode: 0o700 })
  return executable
}

export function buildCodexWorkspaceSdkConfiguration(
  options: CodexChatSdkConfiguration & { runtimeDirectory: string }
): {
  client: CodexOptions
  thread: ThreadOptions
  turn: TurnOptions
} {
  return {
    client: {
      codexPathOverride: createCodexSdkExecutable(options.runtimeDirectory, 'workspace'),
      env: codexSdkEnvironment(options),
      config: {
        agents: { enabled: false },
        hooks: {},
        mcp_servers: {},
        memories: { generate_memories: false },
        plugins: {},
      },
    },
    thread: {
      approvalPolicy: 'never',
      model: options.model,
      modelReasoningEffort: options.effort as ModelReasoningEffort,
      networkAccessEnabled: false,
      sandboxMode: 'workspace-write',
      skipGitRepoCheck: true,
      webSearchMode: 'disabled',
      workingDirectory: options.cwd,
    },
    turn: { signal: options.abortController.signal },
  }
}

export function buildCodexSdkConfiguration(options: CodexSdkConfiguration): {
  client: CodexOptions
  thread: ThreadOptions
  turn: TurnOptions
} {
  return {
    client: {
      codexPathOverride: createCodexSdkExecutable(options.cwd),
      env: scopedCodexSdkEnvironment(options),
      config: {
        agents: { enabled: false },
        history: { persistence: 'none' },
        hooks: {},
        mcp_servers: {},
        memories: { generate_memories: false },
        plugins: {},
        ...(options.toolsDisabled
          ? {
              suppress_unstable_features_warning: true,
              features: {
                apps: false,
                artifact: false,
                browser_use: false,
                chronicle: false,
                code_mode: false,
                code_mode_host: false,
                computer_use: false,
                goals: false,
                hooks: false,
                image_generation: false,
                memories: false,
                multi_agent: false,
                multi_agent_v2: false,
                plugins: false,
                shell_snapshot: false,
                shell_tool: false,
                skill_search: false,
                skip_host_skill_discovery: true,
                sleep_tool: false,
                tool_suggest: false,
                unified_exec: false,
                view_image: false,
                workspace_dependencies: false,
              },
              project_doc_max_bytes: 0,
              include_environment_context: false,
              skills: { include_instructions: false },
              tools: { web_search: false },
            }
          : {}),
      },
    },
    thread: {
      approvalPolicy: 'never',
      model: options.model,
      modelReasoningEffort: options.effort as ModelReasoningEffort,
      networkAccessEnabled: false,
      sandboxMode: 'read-only',
      skipGitRepoCheck: true,
      webSearchMode: 'disabled',
      workingDirectory: options.cwd,
    },
    turn: {
      outputSchema: options.schema,
      signal: options.abortController.signal,
    },
  }
}

export function buildCodexChatSdkConfiguration(options: CodexChatSdkConfiguration): {
  client: CodexOptions
  thread: ThreadOptions
  turn: TurnOptions
} {
  const configuration = buildCodexSdkConfiguration({ ...options, schema: {} })
  return {
    ...configuration,
    client: {
      ...configuration.client,
      config: { ...configuration.client.config, model_reasoning_summary: 'auto' },
    },
    turn: { signal: options.abortController.signal },
  }
}
