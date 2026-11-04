import type { AgentInteraction, AgentInteractionAnswer, AgentTurnUpdate, RemoteAgentComputer } from '@remember/shared'
import { REMEMBER_CODEX_WORKER_SYSTEM_PROMPT } from './agentTurnEnvelope'
import { createCodexAppServer, initializeCodexServer } from './codexAppServer'
import { type CodexClientTool, callCodexClientTool } from './codexClientTools'
import type { CodexConnection, CodexServerEvents } from './codexJsonRpc'
import {
  assertRemoteTurnSettled,
  type CodexRemoteCheckpoint,
  checkpointTurn,
  interruptRemoteTurn,
  RemoteTurnUncertainError,
  readRemoteThread,
  remoteTurns,
} from './codexRemoteRecovery'
import { connectCodexWebSocket } from './codexWebSocket'
import { answerCodexWorkerRequest, object } from './codexWorkerRequests'
import { installedCodexWorkerTools } from './codexWorkerTools'

type WorkerOptions = {
  cwd: string
  version: string
  model: string
  effort: string
  prompt: string
  systemPrompt?: string
  tools?: CodexClientTool[]
  threadId?: string | null
  assertCurrent?: () => void
  onDispatch?: () => void
  signal: AbortSignal
  report: (type: AgentTurnUpdate['type'], id: string, text: string) => void
  onThread: (threadId: string) => void
  onUsage: (usage: unknown) => void
  ask: (
    request: Pick<AgentInteraction, 'title' | 'detail' | 'fields' | 'actions' | 'url'>,
    signal: AbortSignal
  ) => Promise<AgentInteractionAnswer>
} & (
  | { remote?: undefined; executable: string; env: NodeJS.ProcessEnv; providerHome: string }
  | {
      remote: RemoteAgentComputer
      recovery?: CodexRemoteCheckpoint | null
      onCheckpoint: (checkpoint: CodexRemoteCheckpoint | null) => void
      cancelRecovery?: boolean
    }
)

export async function runCodexWorker(options: WorkerOptions) {
  if (options.signal.aborted && !(options.remote && options.cancelRecovery)) throw new Error('agent-cancelled')
  let threadId = options.threadId ?? ''
  let turnId = ''
  let response = ''
  let completed = false
  let terminalTurn: Record<string, unknown> | null = null
  let usage: Record<string, unknown> | undefined
  let hasUnifiedTools = false
  let checkpoint = options.remote ? (options.recovery ?? null) : null
  let stopping: Promise<void> | null = null
  let starting = false
  let server: CodexConnection
  const saveCheckpoint = (next: CodexRemoteCheckpoint | null) => {
    checkpoint = next
    if (options.remote) options.onCheckpoint(next)
  }
  const pendingItems = new Map<string, Record<string, unknown>>()
  const texts = new Map<string, string>()
  const summaries = new Map<string, string>()
  const commentary = new Set<string>()
  let resolveTerminal!: () => void
  let rejectTerminal!: (error: Error) => void
  const terminal = {
    promise: new Promise<void>((resolve, reject) => {
      resolveTerminal = resolve
      rejectTerminal = reject
    }),
    resolve: () => resolveTerminal(),
    reject: (error: Error) => rejectTerminal(error),
  }
  // The process can exit while initialization is still awaited.
  void terminal.promise.catch(() => undefined)
  const events: CodexServerEvents = {
    onRequest: (method, raw, signal) => {
      options.assertCurrent?.()
      const params = object(raw)
      if (threadId && params.threadId && params.threadId !== threadId)
        return Promise.reject(new Error('codex-request-thread-mismatch'))
      if (turnId && params.turnId && params.turnId !== turnId)
        return Promise.reject(new Error('codex-request-turn-mismatch'))
      if (method === 'item/tool/call') {
        const tool = options.tools?.find((entry) => entry.name === params.tool)
        if (!tool || params.namespace) return Promise.reject(new Error('unsupported-remember-tool'))
        if (
          !threadId ||
          !turnId ||
          params.threadId !== threadId ||
          params.turnId !== turnId ||
          typeof params.callId !== 'string' ||
          !params.callId ||
          params.callId.length > 200
        )
          return Promise.reject(new Error('invalid-remember-tool-context'))
        if (tool.name === 'remember_memory') {
          const action = object(params.arguments).action
          options.report(
            'status',
            params.callId,
            ['create', 'patch', 'ensure'].includes(String(action))
              ? 'Geheugenwijziging voorbereiden'
              : 'Geheugen raadplegen'
          )
        }
        return callCodexClientTool(tool, params.arguments, {
          threadId: String(params.threadId ?? ''),
          turnId: String(params.turnId ?? ''),
          callId: String(params.callId ?? ''),
          signal: AbortSignal.any([options.signal, signal]),
        })
      }
      const item = pendingItems.get(String(params.itemId))
      return answerCodexWorkerRequest(
        method,
        { ...params, ...(item?.type === 'fileChange' ? { changes: item.changes } : {}) },
        async (request) => {
          const answer = await options.ask(request, AbortSignal.any([options.signal, signal]))
          options.assertCurrent?.()
          return answer
        }
      )
    },
    onClose: (error) => {
      if (!completed) terminal.reject(error)
    },
    onNotification: (method, raw) => {
      const params = object(raw)
      if (threadId && params.threadId && params.threadId !== threadId) return
      const eventTurnId = params.turnId ?? object(params.turn).id
      if (turnId && eventTurnId && eventTurnId !== turnId) return
      if (options.remote && method === 'turn/completed' && !turnId && !starting) return
      if (method === 'mcpServer/startupStatus/updated' && params.status === 'failed') {
        options.report(
          'status',
          `codex-tool-${params.name}`,
          `Tool niet beschikbaar: ${String(params.name)}. ${String(params.error ?? '')}`
        )
      }
      if (method === 'turn/started') {
        turnId = String(object(params.turn).id ?? '')
        if (checkpoint && turnId) saveCheckpoint({ ...checkpoint, turnId })
        options.report('status', 'codex-started', 'Opdracht uitvoeren')
      }
      if (method === 'item/agentMessage/delta') {
        const id = String(params.itemId)
        const text = (texts.get(id) ?? '') + String(params.delta ?? '')
        if (Buffer.byteLength(text) > 128 * 1024) throw new Error('agent-output-too-large')
        texts.set(id, text)
        options.report(commentary.has(id) ? 'reasoning' : 'response', id, text)
      }
      if (method === 'item/reasoning/summaryTextDelta') {
        const id = `${String(params.itemId)}:summary:${params.summaryIndex ?? 0}`
        const text = (summaries.get(id) ?? '') + String(params.delta ?? '')
        if (Buffer.byteLength(text) > 128 * 1024) throw new Error('agent-output-too-large')
        summaries.set(id, text)
        options.report('reasoning', id, text)
      }
      if (method === 'item/started' || method === 'item/completed') {
        const item = object(params.item)
        const id = String(item.id)
        if (item.type === 'agentMessage' && item.phase === 'commentary') {
          commentary.add(id)
          const text = String(item.text ?? '')
          if (text) options.report('reasoning', id, text)
        }
        if (item.type === 'reasoning' && Array.isArray(item.summary)) {
          item.summary.forEach((text, index) => {
            if (typeof text === 'string' && text.trim()) {
              const summaryId = `${id}:summary:${index}`
              summaries.set(summaryId, text)
              options.report('reasoning', summaryId, text)
            }
          })
        }
        if (
          checkpoint &&
          params.turnId === turnId &&
          item.type === 'commandExecution' &&
          item.source === 'unifiedExecStartup' &&
          typeof item.id === 'string' &&
          !checkpoint.commandItemIds?.includes(item.id)
        )
          saveCheckpoint({ ...checkpoint, commandItemIds: [...(checkpoint.commandItemIds ?? []), item.id] })
        if (method === 'item/started') pendingItems.set(id, item)
        else pendingItems.delete(id)
        if (item.type === 'agentMessage' && method === 'item/completed' && item.phase !== 'commentary') {
          const text = String(item.text ?? '')
          if (text) {
            response = text
            options.report('response', id, text)
          }
        }
        if (item.type === 'commandExecution') options.report('status', id, `Uitvoeren: ${String(item.command ?? '')}`)
        if (item.type === 'fileChange') options.report('status', id, 'Bestanden wijzigen')
        if (item.type === 'mcpToolCall') options.report('status', id, `${String(item.server)}: ${String(item.tool)}`)
        if (item.type === 'webSearch') options.report('status', id, 'Zoeken op het web')
      }
      if (method === 'thread/tokenUsage/updated') usage = object(object(params.tokenUsage).last)
      if (method === 'error' && params.willRetry !== true)
        terminal.reject(new Error(String(object(params.error).message ?? 'codex-turn-failed')))
      if (method === 'turn/completed') {
        if (options.remote && (stopping || options.signal.aborted || options.cancelRecovery)) return
        const turn = object(params.turn)
        if (options.remote) {
          terminalTurn = turn
          terminal.resolve()
          return
        }
        completed = true
        if (turn.status === 'completed') terminal.resolve()
        else terminal.reject(new Error(String(object(turn.error).message ?? `codex-turn-${turn.status}`)))
      }
    },
  }
  const stopRemote = () => {
    if (stopping) return stopping
    stopping = (async () => {
      try {
        if (checkpoint && !turnId) {
          const turn = checkpointTurn(await readRemoteThread(server, threadId), checkpoint)
          turnId = String(turn?.id ?? '')
          if (turnId) saveCheckpoint({ ...checkpoint, turnId })
        }
        if (turnId) await interruptRemoteTurn(server, threadId, turnId, checkpoint?.commandItemIds)
        else if (starting) throw new RemoteTurnUncertainError(true)
        saveCheckpoint(null)
        terminal.reject(new Error('agent-cancelled'))
      } catch {
        terminal.reject(new RemoteTurnUncertainError(true))
      }
    })()
    return stopping
  }
  const abort = () => {
    if (options.remote) {
      if (!starting) void stopRemote()
      return
    }
    terminal.reject(new Error('agent-cancelled'))
    if (threadId && turnId)
      void server
        .request('turn/interrupt', { threadId, turnId }, 2_000)
        .catch(() => undefined)
        .finally(() => server.close())
    else server.close()
  }
  server = options.remote
    ? await connectCodexWebSocket(options.remote.endpoint, events, {
        signal: options.cancelRecovery ? undefined : options.signal,
      })
    : createCodexAppServer({ executable: options.executable, env: options.env, cwd: options.cwd, ...events })
  options.signal.addEventListener('abort', abort, { once: true })
  try {
    await initializeCodexServer(server, options.version)
    if (options.signal.aborted && !options.remote) throw new Error('agent-cancelled')
    if (options.remote && checkpoint) {
      threadId = checkpoint.threadId
      const thread = await readRemoteThread(server, threadId)
      const previous = checkpointTurn(thread, checkpoint)
      if (!previous) {
        if (object(thread.status).type === 'active') throw new RemoteTurnUncertainError()
        saveCheckpoint(null)
        throw new Error('codex-remote-turn-not-started')
      }
      turnId = String(previous.id)
      saveCheckpoint({ ...checkpoint, turnId })
      if (options.cancelRecovery || options.signal.aborted) {
        await interruptRemoteTurn(server, threadId, turnId, checkpoint?.commandItemIds)
        saveCheckpoint(null)
        throw new Error('agent-cancelled')
      }
      if (previous.status !== 'inProgress') {
        await assertRemoteTurnSettled(server, thread, previous, checkpoint.commandItemIds)
        saveCheckpoint(null)
        if (previous.status !== 'completed') throw new Error(`codex-turn-${previous.status}`)
        const items = Array.isArray(previous.items) ? previous.items.map(object) : []
        response = String(
          items.findLast((item) => item.type === 'agentMessage' && item.phase !== 'commentary')?.text ?? ''
        )
        if (!response.trim()) throw new Error('agent-empty-response')
        completed = true
        return { response, threadId }
      }
      options.report('status', 'codex-recovering', 'Bestaande opdracht op de agentcomputer hervatten')
      // Reattach to the original turn. No turn/start or previous approval is replayed.
      const resumed = object(object(await server.request('thread/resume', { threadId }, 10_000)).thread)
      const resumedTurn = checkpointTurn(resumed, { ...checkpoint, turnId })
      if (resumedTurn && resumedTurn.status !== 'inProgress') {
        for (const item of Array.isArray(resumedTurn.items) ? resumedTurn.items : []) {
          events.onNotification('item/completed', { threadId, item })
        }
        events.onNotification('turn/completed', { threadId, turn: resumedTurn })
      }
    } else {
      if (options.signal.aborted) throw new Error('agent-cancelled')
      const installed = options.remote ? {} : installedCodexWorkerTools(options.providerHome)
      options.report(
        'status',
        'codex-capabilities',
        options.remote ? 'Verbonden met de agentcomputer' : 'Browser en Codex-tools voorbereiden'
      )
      hasUnifiedTools = Boolean(installed.cua_repl)
      const settings = {
        model: options.model,
        cwd: options.cwd,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: 'workspace-write',
        developerInstructions: options.systemPrompt ?? REMEMBER_CODEX_WORKER_SYSTEM_PROMPT,
        config: {
          web_search: 'live',
          'sandbox_workspace_write.network_access': true,
          ...Object.fromEntries(Object.entries(installed).map(([name, config]) => [`mcp_servers.${name}`, config])),
        },
      }
      options.assertCurrent?.()
      options.onDispatch?.()
      const result = object(
        await server.request(threadId ? 'thread/resume' : 'thread/start', {
          ...settings,
          ...(!threadId && options.tools?.length
            ? {
                dynamicTools: options.tools.map(({ name, description, inputSchema }) => ({
                  type: 'function',
                  name,
                  description,
                  inputSchema,
                })),
              }
            : {}),
          ...(threadId ? { threadId } : {}),
        })
      )
      threadId = String(object(result.thread).id ?? '')
      if (!threadId) throw new Error('codex-thread-id-missing')
      options.onThread(threadId)
      if (options.remote) {
        const turns = remoteTurns(object(result.thread))
        const previous = turns.at(-1)
        saveCheckpoint({
          computer: options.remote,
          threadId,
          turnId: null,
          previousTurnId: previous ? String(previous.id) : null,
        })
        if (previous?.status === 'inProgress') {
          saveCheckpoint({ computer: options.remote, threadId, turnId: String(previous.id), previousTurnId: null })
          throw new RemoteTurnUncertainError()
        }
      }
      if (options.signal.aborted) {
        saveCheckpoint(null)
        throw new Error('agent-cancelled')
      }
      starting = true
      options.assertCurrent?.()
      const started = object(
        await server.request('turn/start', {
          threadId,
          input: [{ type: 'text', text: options.prompt, text_elements: [] }],
          effort: options.effort,
          summary: 'auto',
        })
      )
      starting = false
      turnId ||= String(object(started.turn).id ?? '')
      if (checkpoint && turnId) saveCheckpoint({ ...checkpoint, turnId })
      if (options.signal.aborted) abort()
    }
    await terminal.promise
    if (options.remote) {
      const thread = await readRemoteThread(server, threadId)
      const final = remoteTurns(thread).find((entry) => entry.id === turnId)
      if (!final) throw new RemoteTurnUncertainError()
      await assertRemoteTurnSettled(server, thread, final, checkpoint?.commandItemIds)
      if (options.signal.aborted) {
        await stopRemote()
        throw new Error('agent-cancelled')
      }
      completed = true
      saveCheckpoint(null)
      const terminalStatus = object(terminalTurn).status
      if (terminalStatus !== 'completed') throw new Error(`codex-turn-${terminalStatus}`)
    }
    if (!response.trim()) throw new Error('agent-empty-response')
    if (usage)
      options.onUsage({
        input_tokens: usage.inputTokens,
        cached_input_tokens: usage.cachedInputTokens,
        output_tokens: usage.outputTokens,
      })
    return { response, threadId }
  } catch (error) {
    if (options.remote && checkpoint)
      throw new RemoteTurnUncertainError(options.signal.aborted || options.cancelRecovery)
    throw error
  } finally {
    if (stopping) await stopping
    options.signal.removeEventListener('abort', abort)
    // Notify the provider helper so it can release per-turn app/browser state.
    if (hasUnifiedTools && threadId && turnId && !server.isClosed() && !options.signal.aborted) {
      await server
        .request(
          'mcpServer/tool/call',
          {
            threadId,
            server: 'cua_repl',
            tool: 'turn_ended',
            arguments: { hook_event_name: 'Stop', session_id: threadId, turn_id: turnId },
          },
          2_000
        )
        .catch(() => undefined)
    }
    server.close()
  }
}
