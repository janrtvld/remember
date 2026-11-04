import { execFile, spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentProvider, AgentSetup } from '@remember/shared'
import { app, clipboard } from 'electron'
import {
  type AgentChatRuntime,
  buildDesktopChatAppleScript,
  matchingRememberMcpServer,
  normalizeAgentChatInput,
  parseAgentChatInput,
} from './agentChat'
import { resolveAgentProcessCommand, selectAgentStatusProbe } from './agentPaths'
import { getWorkItemAgentExecution } from './agentProjects'
import { resolveClaudeMcpSetupPaths } from './claudeMcpSetupFiles'
import { bundledClaudeExecutable, claudeProcessEnvironment } from './claudeRuntime'
import { getCliSetupStatus } from './cliSetup'
import { cancelCodexChatGptLogin, openCodexChatGptLogin } from './codexAuth'
import { bundledCodexExecutable, codexProcessEnvironment } from './codexRuntime'
import { buildCodexWorkerHandoffPrompt } from './codexWorkerHandoff'
import { terminateAgentProcess, trackAgentCancellation, trackAgentProcess } from './dailyReview/agentProcessLifecycle'
import { getEvidenceStore } from './dailyReview/evidenceRepository'
import { isOfflineMode, OFFLINE_MODE_ERROR, requireNetworkAccess } from './networkAccess'
import { getSettings } from './settings'

const selectedAgentExecutables = new Map<AgentProvider, string>()

function executableCandidates(provider: AgentProvider) {
  const executable = provider === 'codex' ? bundledCodexExecutable() : bundledClaudeExecutable()
  return executable ? [executable] : []
}

export function findAgentExecutable(provider = getSettings().defaultAgentProvider) {
  const selectedExecutable = selectedAgentExecutables.get(provider)
  if (selectedExecutable && isExecutable(selectedExecutable)) return selectedExecutable

  for (const candidate of executableCandidates(provider)) {
    if (isExecutable(candidate)) return candidate
  }
  return null
}

function isExecutable(candidate: string) {
  try {
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function runStatus(executable: string, provider: AgentProvider) {
  const args = provider === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status']
  return runAgentCommand(executable, provider, args, 5_000)
}

async function runAgentCommand(executable: string, provider: AgentProvider, args: string[], timeoutMs: number) {
  const homeDirectory = app.getPath('home')
  const environment = await (provider === 'codex'
    ? codexProcessEnvironment(executable)
    : claudeProcessEnvironment(executable))
  requireNetworkAccess()
  const command = resolveAgentProcessCommand(executable, args, homeDirectory, environment)
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = trackAgentProcess(
      spawn(command.executable, command.arguments, {
        detached: true,
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    )
    const output: Buffer[] = []
    let settled = false
    const finish = (code: number | null, detail?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      const processOutput = Buffer.concat(output).toString('utf8').trim()
      resolve({ code, output: [processOutput, detail].filter(Boolean).join('\n') })
    }
    const timeout = setTimeout(() => {
      terminateAgentProcess(child)
      finish(null, 'Agent command timed out.')
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => output.push(chunk))
    child.on('error', (error) => finish(null, error.message))
    child.on('close', (code) => finish(code))
  })
}

export async function checkAgent(provider = getSettings().defaultAgentProvider): Promise<AgentSetup> {
  if (provider !== 'claude' && provider !== 'codex') throw new Error('invalid-agent-provider')
  if (isOfflineMode()) {
    return { provider, status: 'error', executable: findAgentExecutable(provider), detail: OFFLINE_MODE_ERROR }
  }
  const executables = executableCandidates(provider).filter(isExecutable)
  if (!executables.length) return { provider, status: 'missing', executable: null, detail: null }

  const probes = await Promise.all(
    executables.map(async (executable) => ({ executable, ...(await runStatus(executable, provider)) }))
  )
  const selected = selectAgentStatusProbe(provider, probes)
  if (!selected) return { provider, status: 'missing', executable: null, detail: null }
  const authentication = selected.authentication
  if (authentication !== 'unknown') selectedAgentExecutables.set(provider, selected.executable)
  return {
    provider,
    status: authentication === 'authenticated' ? 'ready' : authentication === 'signed-out' ? 'signed-out' : 'error',
    executable: selected.executable,
    detail:
      authentication === 'authenticated'
        ? null
        : selected.output || (provider === 'claude' ? 'Claude is niet gekoppeld.' : 'Codex is niet ingelogd.'),
  }
}

export async function openAgentLogin(provider = getSettings().defaultAgentProvider) {
  if (provider !== 'claude' && provider !== 'codex') throw new Error('invalid-agent-provider')
  requireNetworkAccess()
  const executable = findAgentExecutable(provider)
  if (!executable) throw new Error(`${provider}-runtime-missing`)
  if (provider === 'codex') {
    await openCodexChatGptLogin(executable)
    return
  }
  const result = await runAgentCommand(executable, provider, ['auth', 'login', '--claudeai'], 10 * 60_000)
  if (result.code !== 0) throw new Error(result.output || 'claude-login-failed')
}

export async function logoutAgent(provider = getSettings().defaultAgentProvider) {
  requireNetworkAccess()
  if (provider === 'codex') await cancelCodexChatGptLogin()
  requireNetworkAccess()
  const executable = findAgentExecutable(provider)
  if (!executable) throw new Error(`${provider}-runtime-missing`)
  const result = await runAgentCommand(
    executable,
    provider,
    provider === 'claude' ? ['auth', 'logout'] : ['logout'],
    10_000
  )
  if (result.code !== 0) throw new Error(result.output || `${provider}-logout-failed`)
}

export async function openAgentChat(rawInput: unknown) {
  const intent = parseAgentChatInput(rawInput)
  if (!intent || process.platform !== 'darwin') return false
  requireNetworkAccess()

  const cli = await getCliSetupStatus()
  const runtime: AgentChatRuntime = {
    commandPath: cli.commandPath,
    dataDirectory: join(app.getPath('userData'), 'daily-review'),
    isolated: !app.isPackaged && !!process.env.REMEMBER_USER_DATA_DIR,
  }
  if (!cli.commandInstalled && intent.kind !== 'workItem' && (intent.provider === 'claude' || runtime.isolated))
    throw new Error('remember-agent-cli-unavailable')
  if (intent.provider === 'claude') {
    const paths = resolveClaudeMcpSetupPaths(homedir(), runtime.commandPath)
    let configuration: unknown = null
    try {
      configuration = JSON.parse(await readFile(paths.config, 'utf8'))
    } catch {
      throw new Error('remember-agent-claude-profile-not-connected')
    }
    const mcpServerName = matchingRememberMcpServer(configuration, runtime)
    if (!mcpServerName) throw new Error('remember-agent-claude-profile-not-connected')
    runtime.mcpServerName = mcpServerName
  }
  if (intent.kind === 'workItem') {
    const item = getEvidenceStore().getWorkItem(intent.workItemId)
    if (!item) throw new Error('work-item-not-found')
    if (item.agentSessions.some((session) => session.status === 'running'))
      throw new Error('agent-work-item-already-running')
    runtime.taskPrompt = buildCodexWorkerHandoffPrompt(
      item,
      getWorkItemAgentExecution(item.id, 'codex').workingDirectory
    )
  }
  const input = normalizeAgentChatInput(rawInput, runtime)
  if (!input) return false

  const previousClipboard = await clipboard.readText()
  await clipboard.writeText(input.prompt)
  return new Promise<boolean>((resolve) => {
    const abortController = new AbortController()
    const releaseCancellation = trackAgentCancellation(() => abortController.abort())
    execFile(
      '/usr/bin/osascript',
      ['-e', buildDesktopChatAppleScript(input.provider)],
      { timeout: 8_000, signal: abortController.signal },
      (error) => {
        releaseCancellation()
        void (async () => {
          if ((await clipboard.readText()) === input.prompt) await clipboard.writeText(previousClipboard)
          resolve(!error)
        })().catch(() => resolve(false))
      }
    )
  })
}
