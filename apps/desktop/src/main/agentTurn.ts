import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { SDKResultMessage, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import type {
  AgentComputer,
  AgentInteraction,
  AgentInteractionAnswer,
  AgentTurnStep,
  AgentTurnUpdate,
  RunAgentTurnInput,
  RunAgentTurnResult,
} from '@remember/shared'
import { app } from 'electron'
import { findAgentExecutable } from './agent'
import { REMEMBER_INLINE_SYSTEM_PROMPT, REMEMBER_WORKSPACE_SYSTEM_PROMPT } from './agentTurnEnvelope'
import { codexInfrastructureFailure, normalizeAgentTurnInput } from './agentTurnInput'
import { recordClaudeUsage, recordCodexUsage } from './agentUsageRepository'
import { claudeProcessEnvironment } from './claudeRuntime'
import type { CodexClientTool } from './codexClientTools'
import { type CodexRemoteCheckpoint, RemoteTurnUncertainError } from './codexRemoteRecovery'
import { codexProcessEnvironment } from './codexRuntime'
import { runCodexWorker } from './codexWorker'
import { agentErrorDetail, classifyAgentError, createAgentError } from './dailyReview/agentErrors'
import { trackAgentCancellation, trackAgentProcess } from './dailyReview/agentProcessLifecycle'
import {
  buildClaudeChatSdkOptions,
  buildClaudeWorkspaceSdkOptions,
  claudeSdkResultError,
} from './dailyReview/claudeAgentSdk'
import { buildCodexChatSdkConfiguration } from './dailyReview/codexAgentSdk'
import { offlineModeSentinelPath, requireNetworkAccess } from './networkAccess'
import { getSettings } from './settings'

const CLAUDE_TURN_TIMEOUT_MS = 5 * 60_000
const CLAUDE_WORKSPACE_TURN_TIMEOUT_MS = 30 * 60_000
const MAX_RESPONSE_BYTES = 128 * 1024
const MAX_STEP_TEXT_LENGTH = 4_000
const MAX_STEPS = 32

export type AgentTurnExecutionContext = {
  kind?: 'assistant'
  computer?: AgentComputer
  remoteRecovery?: CodexRemoteCheckpoint | null
  onRemoteCheckpoint?: (checkpoint: CodexRemoteCheckpoint | null) => void
  assertCurrent?: () => void
  onDispatch?: () => void
  finalizeResponse?: (response: string, signal: AbortSignal) => Promise<string>
  cancelRemoteRecovery?: boolean
  instructions?: string
  tools?: CodexClientTool[]
  workingDirectory?: string | null
  threadId?: string | null
  onThread?: (threadId: string) => void
  ask?: (
    request: Pick<AgentInteraction, 'title' | 'detail' | 'fields' | 'actions' | 'url'>,
    signal: AbortSignal
  ) => Promise<AgentInteractionAnswer>
}

type AgentExecutionResult = RunAgentTurnResult & { threadId?: string }

type AgentTurnUpdateListener = (update: AgentTurnUpdate) => void

function normalizedStepText(text: string) {
  return text.trim().slice(0, MAX_STEP_TEXT_LENGTH)
}

export function mergeAgentTurnStep(steps: AgentTurnStep[], update: AgentTurnUpdate): AgentTurnStep[] {
  if (update.type === 'response') return steps
  const text = normalizedStepText(update.text)
  if (!text) return steps
  const existingIndex = steps.findIndex((step) => step.id === update.id)
  const step = { id: update.id, kind: update.type, text, at: update.at }
  if (existingIndex >= 0) {
    return steps.map((current, index) => (index === existingIndex ? { ...step, at: current.at } : current))
  }
  return [...steps, step].slice(-MAX_STEPS)
}

function createTurnReporter(input: RunAgentTurnInput, listener?: AgentTurnUpdateListener) {
  let steps: AgentTurnStep[] = []
  const report = (type: AgentTurnUpdate['type'], id: string, text: string) => {
    const normalized = type === 'response' ? text : normalizedStepText(text)
    if (!normalized) return
    const update: AgentTurnUpdate = {
      turnId: input.turnId,
      provider: input.provider,
      type,
      id,
      text: normalized,
      at: Date.now(),
    }
    steps = mergeAgentTurnStep(steps, update)
    listener?.(update)
  }
  return { report, steps: () => steps }
}

function assertResponse(response: string) {
  const normalized = response.trim()
  if (!normalized) throw new Error('agent-empty-response')
  if (Buffer.byteLength(normalized) > MAX_RESPONSE_BYTES) throw new Error('agent-output-too-large')
  return normalized
}

function spawnClaudeCodeProcess(options: SpawnOptions) {
  requireNetworkAccess(options.signal)
  return trackAgentProcess(
    spawn(options.command, options.args, {
      cwd: options.cwd,
      detached: true,
      env: options.env,
      signal: options.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  )
}

async function runClaudeTurn(
  input: RunAgentTurnInput,
  executable: string,
  cwd: string,
  abortController: AbortController,
  report: (type: AgentTurnUpdate['type'], id: string, text: string) => void,
  execution: AgentTurnExecutionContext
) {
  const settings = getSettings()
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  const { createClaudeClientToolServer } = await import('./claudeClientTools')
  const environment = await claudeProcessEnvironment(executable)
  requireNetworkAccess(abortController.signal)
  let result: SDKResultMessage | null = null
  let sessionId = execution.threadId ?? input.turnId
  const workspaceMode = Boolean(execution.workingDirectory)
  const sdkOptions = workspaceMode
    ? buildClaudeWorkspaceSdkOptions({
        abortController,
        cwd,
        effort: settings.claudeAnalysisEffort,
        env: environment,
        executable,
        model: settings.claudeAnalysisModel,
        resume: execution.threadId ?? undefined,
        spawnClaudeCodeProcess,
        systemPrompt: execution.instructions ?? REMEMBER_WORKSPACE_SYSTEM_PROMPT,
      })
    : buildClaudeChatSdkOptions({
        abortController,
        cwd,
        effort: settings.claudeAnalysisEffort,
        env: environment,
        executable,
        model: settings.claudeAnalysisModel,
        spawnClaudeCodeProcess,
        systemPrompt: REMEMBER_INLINE_SYSTEM_PROMPT,
      })
  const clientTools = execution.tools?.length
    ? createClaudeClientToolServer(execution.tools, {
        turnId: input.turnId,
        threadId: () => sessionId,
        signal: abortController.signal,
        assertCurrent: execution.assertCurrent,
      })
    : null
  let streamedResponse = ''
  let writingStarted = false
  try {
    const sdkQuery = query({
      prompt: input.prompt,
      options: {
        ...sdkOptions,
        ...(clientTools
          ? {
              mcpServers: { remember: clientTools.server },
              allowedTools: [...(sdkOptions.allowedTools ?? []), ...clientTools.allowedTools],
            }
          : {}),
        includePartialMessages: true,
      },
    })
    for await (const message of sdkQuery) {
      if (message.type === 'system' && message.subtype === 'init') {
        sessionId = message.session_id
        execution.onThread?.(sessionId)
      }
      if (message.type === 'stream_event') {
        const event = message.event
        if (event.type === 'content_block_start' && event.content_block.type === 'thinking') {
          report('status', 'claude-thinking', 'Opdracht uitdenken')
        }
        if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
          report('status', `claude-tool-${event.content_block.id}`, `${event.content_block.name} uitvoeren`)
        }
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          if (!writingStarted) {
            writingStarted = true
            report('status', 'claude-writing', 'Antwoord schrijven')
          }
          streamedResponse += event.delta.text
          report('response', 'claude-response', streamedResponse)
        }
      }
      if (message.type === 'result') {
        result = message
        recordClaudeUsage(message)
      }
    }
    if (!result) throw new Error('claude-empty-response')
    const resultError = claudeSdkResultError(result)
    if (resultError) throw resultError
    if (result.subtype !== 'success') throw new Error('claude-failed')
    const response = assertResponse(result.result)
    if (response !== streamedResponse.trim()) report('response', 'claude-response', response)
    return { response, ...(workspaceMode ? { threadId: result.session_id } : {}) }
  } finally {
    await clientTools?.server.instance.close()
  }
}

// Non-task callers (for example the skill editor) retain their bounded SDK behavior.
async function runCodexInlineTurn(
  input: RunAgentTurnInput,
  executable: string,
  cwd: string,
  abortController: AbortController,
  report: (type: AgentTurnUpdate['type'], id: string, text: string) => void
): Promise<{ response: string; threadId?: string }> {
  const settings = getSettings()
  const { Codex } = await import('@openai/codex-sdk')
  const configuration = buildCodexChatSdkConfiguration({
    abortController,
    cwd,
    executable,
    model: settings.codexAnalysisModel,
    effort: settings.codexAnalysisEffort,
    env: { ...(await codexProcessEnvironment(executable)), REMEMBER_OFFLINE_SENTINEL: offlineModeSentinelPath() },
  })
  requireNetworkAccess(abortController.signal)
  const thread = new Codex(configuration.client).startThread(configuration.thread)
  const turn = await thread.runStreamed(`${REMEMBER_INLINE_SYSTEM_PROMPT}\n\n${input.prompt}`, configuration.turn)
  let response = ''
  for await (const event of turn.events) {
    if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
      if (event.item.type === 'reasoning') report('reasoning', event.item.id, event.item.text)
      if (event.item.type === 'agent_message') {
        response = event.item.text
        report('response', event.item.id, response)
      }
    }
    if (event.type === 'turn.completed') recordCodexUsage(settings.codexAnalysisModel, event.usage)
    if (event.type === 'turn.failed') throw new Error(event.error.message)
    if (event.type === 'error') throw new Error(event.message)
  }
  if (codexInfrastructureFailure(response)) throw new Error('codex-code-mode-host-missing')
  return { response: assertResponse(response) }
}

const activeTurns = new Map<string, AbortController>()
export function cancelAgentTurn(turnId: string) {
  const controller = activeTurns.get(turnId)
  if (!controller) return false
  controller.abort()
  return true
}

export async function runAgentTurn(
  rawInput: unknown,
  listener?: AgentTurnUpdateListener,
  execution: AgentTurnExecutionContext = {}
): Promise<AgentExecutionResult> {
  const input = normalizeAgentTurnInput(rawInput)
  if (!input) throw new Error('invalid-agent-turn')
  requireNetworkAccess()
  const remote = execution.kind === 'assistant' && execution.computer?.kind === 'remote' ? execution.computer : null
  if (remote && input.provider !== 'codex') throw new Error('assistant-remote-codex-required')
  const executable = remote ? null : findAgentExecutable(input.provider)
  if (!remote && !executable) throw new Error(`${input.provider}-runtime-missing`)

  if (activeTurns.has(input.turnId)) throw new Error('agent-turn-already-running')
  const startedAt = Date.now()
  const runtimeDirectory = remote ? null : mkdtempSync(path.join(tmpdir(), `remember-${input.provider}-turn-`))
  const workingDirectory = remote?.workspace ?? execution.workingDirectory ?? (runtimeDirectory as string)
  const abortController = new AbortController()
  activeTurns.set(input.turnId, abortController)
  const releaseCancellation = trackAgentCancellation(() => abortController.abort())
  const timeout =
    input.provider === 'claude'
      ? setTimeout(
          () => abortController.abort(),
          execution.workingDirectory ? CLAUDE_WORKSPACE_TURN_TIMEOUT_MS : CLAUDE_TURN_TIMEOUT_MS
        )
      : null
  const reporter = createTurnReporter(input, listener)
  reporter.report('status', 'preparing', 'Agent starten')
  try {
    const workItemId = input.workItemId
    const result =
      input.provider === 'claude'
        ? await runClaudeTurn(
            input,
            executable as string,
            workingDirectory,
            abortController,
            reporter.report,
            execution
          )
        : !workItemId && execution.kind !== 'assistant'
          ? await runCodexInlineTurn(input, executable as string, workingDirectory, abortController, reporter.report)
          : await runCodexWorker({
              ...(remote
                ? {
                    remote,
                    recovery: execution.remoteRecovery,
                    cancelRecovery: execution.cancelRemoteRecovery,
                    onCheckpoint: execution.onRemoteCheckpoint ?? (() => {}),
                  }
                : {
                    executable: executable as string,
                    env: await codexProcessEnvironment(executable as string),
                    providerHome: path.join(app.getPath('home'), '.codex'),
                  }),
              cwd: workingDirectory,
              version: app.getVersion(),
              model: getSettings().codexAnalysisModel,
              effort: getSettings().codexAnalysisEffort,
              prompt: input.prompt,
              assertCurrent: execution.assertCurrent,
              onDispatch: execution.onDispatch,
              systemPrompt: execution.instructions,
              tools: execution.tools,
              threadId: execution.threadId,
              signal: abortController.signal,
              report: reporter.report,
              onThread: execution.onThread ?? (() => {}),
              onUsage: (usage) => recordCodexUsage(getSettings().codexAnalysisModel, usage),
              ask: (request, signal) =>
                execution.ask
                  ? execution.ask(request, signal)
                  : Promise.reject(new Error('agent-interaction-unavailable')),
            })
    return {
      provider: input.provider,
      response: assertResponse(
        execution.finalizeResponse
          ? await execution.finalizeResponse(result.response, abortController.signal)
          : result.response
      ),
      durationMs: Date.now() - startedAt,
      steps: reporter.steps(),
      ...(result.threadId ? { threadId: result.threadId } : {}),
    }
  } catch (error) {
    if (remote || error instanceof RemoteTurnUncertainError) throw error
    const code = classifyAgentError(error)
    throw createAgentError(code, agentErrorDetail(error, code) ?? undefined)
  } finally {
    abortController.abort()
    activeTurns.delete(input.turnId)
    if (timeout) clearTimeout(timeout)
    releaseCancellation()
    if (runtimeDirectory) rmSync(runtimeDirectory, { recursive: true, force: true })
  }
}
