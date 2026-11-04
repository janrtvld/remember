import type { RemoteAgentComputer } from '@remember/shared'
import { initializeCodexServer } from './codexAppServer'
import type { CodexConnection } from './codexJsonRpc'
import { connectCodexWebSocket } from './codexWebSocket'
import { object } from './codexWorkerRequests'

export type CodexRemoteCheckpoint = {
  computer: RemoteAgentComputer
  threadId: string
  turnId: string | null
  previousTurnId: string | null
  commandItemIds?: string[]
}

export function remoteTurns(thread: Record<string, unknown>) {
  if (!Array.isArray(thread.turns)) throw new Error('codex-remote-history-unavailable')
  return thread.turns.map(object)
}

export function checkpointTurn(thread: Record<string, unknown>, checkpoint: CodexRemoteCheckpoint) {
  const turns = remoteTurns(thread)
  if (checkpoint.turnId) return turns.find((turn) => turn.id === checkpoint.turnId)
  const previousIndex = checkpoint.previousTurnId
    ? turns.findIndex((turn) => turn.id === checkpoint.previousTurnId)
    : -1
  if (checkpoint.previousTurnId && previousIndex < 0) throw new Error('codex-remote-history-unavailable')
  const following = turns.slice(previousIndex + 1)
  if (following.length > 1) throw new Error('codex-remote-ambiguous-turn')
  return following[0]
}

export async function readRemoteThread(server: CodexConnection, threadId: string) {
  return object(object(await server.request('thread/read', { threadId, includeTurns: true }, 10_000)).thread)
}

function unfinishedCommands(turn: Record<string, unknown>) {
  if (!Array.isArray(turn.items)) throw new Error('codex-remote-history-unavailable')
  return turn.items.map(object).filter((item) => {
    if (item.type !== 'commandExecution' || item.status === 'declined') return false
    if (!['completed', 'failed'].includes(String(item.status))) return true
    return Boolean(item.processId) && typeof item.exitCode !== 'number'
  })
}

export function remoteTurnHasUnfinishedCommands(turn: Record<string, unknown>) {
  return unfinishedCommands(turn).length > 0
}

type BackgroundTerminal = { itemId: string; processId: string }

export async function readRemoteBackgroundTerminals(server: CodexConnection, threadId: string) {
  const terminals: BackgroundTerminal[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  do {
    const result = object(
      await server.request(
        'thread/backgroundTerminals/list',
        { threadId, limit: 100, ...(cursor ? { cursor } : {}) },
        5_000
      )
    )
    if (!Array.isArray(result.data)) throw new Error('codex-remote-stop-unconfirmed')
    for (const value of result.data) {
      const terminal = object(value)
      if (
        typeof terminal.itemId !== 'string' ||
        !terminal.itemId ||
        typeof terminal.processId !== 'string' ||
        !terminal.processId
      )
        throw new Error('codex-remote-stop-unconfirmed')
      terminals.push({ itemId: terminal.itemId, processId: terminal.processId })
    }
    if (terminals.length > 1_000) throw new Error('codex-remote-stop-unconfirmed')
    cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined
    if (cursor && cursors.has(cursor)) throw new Error('codex-remote-stop-unconfirmed')
    if (cursor) cursors.add(cursor)
  } while (cursor)
  return terminals
}

function commandItems(turn: Record<string, unknown>) {
  if (!Array.isArray(turn.items)) throw new Error('codex-remote-history-unavailable')
  return turn.items.map(object).filter((item) => item.type === 'commandExecution')
}

export async function assertRemoteTurnSettled(
  server: CodexConnection,
  thread: Record<string, unknown>,
  turn: Record<string, unknown>,
  commandItemIds: readonly string[] = []
) {
  const background = await readRemoteBackgroundTerminals(server, String(thread.id))
  const otherItems = new Set(
    remoteTurns(thread)
      .filter((entry) => entry.id !== turn.id)
      .flatMap((entry) => commandItems(entry).map((item) => item.id))
  )
  const commands = commandItems(turn)
  if (
    turn.status === 'inProgress' ||
    unfinishedCommands(turn).length ||
    background.some((entry) => !otherItems.has(entry.itemId)) ||
    commandItemIds.some(
      (id) =>
        !commands.some((item) => item.id === id && (item.status === 'declined' || typeof item.exitCode === 'number'))
    )
  )
    throw new RemoteTurnUncertainError()
}

export async function interruptRemoteTurn(
  server: CodexConnection,
  threadId: string,
  turnId: string,
  commandItemIds: readonly string[] = []
) {
  const initial = remoteTurns(await readRemoteThread(server, threadId)).find((entry) => entry.id === turnId)
  if (!initial) throw new Error('codex-remote-stop-unconfirmed')
  const ownedItems = new Set(commandItemIds)
  for (const item of commandItems(initial)) {
    if (item.source === 'unifiedExecStartup' && typeof item.id === 'string') ownedItems.add(item.id)
  }
  if (initial.status === 'inProgress') await server.request('turn/interrupt', { threadId, turnId }, 5_000)
  else if (!['completed', 'interrupted', 'failed'].includes(String(initial.status)))
    throw new Error('codex-remote-stop-unconfirmed')

  const terminated = new Set<string>()
  const otherKnownItems = new Set<unknown>()
  let reattached = false
  const deadline = Date.now() + 5_000
  do {
    const turns = remoteTurns(await readRemoteThread(server, threadId))
    const turn = turns.find((entry) => entry.id === turnId)
    if (!turn) throw new Error('codex-remote-stop-unconfirmed')
    const commands = commandItems(turn)
    for (const item of commands) {
      if (item.source === 'unifiedExecStartup' && typeof item.id === 'string') ownedItems.add(item.id)
    }
    for (const entry of turns.filter((entry) => entry.id !== turnId)) {
      for (const item of commandItems(entry)) otherKnownItems.add(item.id)
    }
    const terminals = await readRemoteBackgroundTerminals(server, threadId)
    const outstanding = terminals.filter((terminal) => !otherKnownItems.has(terminal.itemId))
    const allOwnedCommandsExited = [...ownedItems].every((id) =>
      commands.some((item) => item.id === id && (item.status === 'declined' || typeof item.exitCode === 'number'))
    )
    if (
      ['completed', 'interrupted', 'failed'].includes(String(turn.status)) &&
      !unfinishedCommands(turn).length &&
      !outstanding.length &&
      allOwnedCommandsExited
    )
      return turn

    if (!reattached && outstanding.some((terminal) => !ownedItems.has(terminal.itemId))) {
      // thread/read omits live items on some hosts. Resume only attaches to the
      // existing thread and exposes its in-memory item-to-turn ownership.
      const resumed = object(object(await server.request('thread/resume', { threadId }, 5_000)).thread)
      if (resumed.id !== threadId) throw new Error('codex-remote-stop-unconfirmed')
      for (const entry of remoteTurns(resumed)) {
        for (const item of commandItems(entry)) {
          if (entry.id === turnId && item.source === 'unifiedExecStartup' && typeof item.id === 'string')
            ownedItems.add(item.id)
          else if (entry.id !== turnId) otherKnownItems.add(item.id)
        }
      }
      reattached = true
    }
    for (const terminal of outstanding) {
      if (!ownedItems.has(terminal.itemId) || terminated.has(terminal.processId)) continue
      const result = object(
        await server.request('thread/backgroundTerminals/terminate', { threadId, processId: terminal.processId }, 5_000)
      )
      if (typeof result.terminated !== 'boolean') throw new Error('codex-remote-stop-unconfirmed')
      terminated.add(terminal.processId)
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  } while (Date.now() < deadline)
  throw new Error('codex-remote-stop-unconfirmed')
}

export class RemoteTurnUncertainError extends Error {
  constructor(stopping = false) {
    super(stopping ? 'codex-remote-stop-unconfirmed' : 'codex-remote-recovery-required')
  }
}

export async function stopCodexRemoteCheckpoint(checkpoint: CodexRemoteCheckpoint, version: string) {
  const server = await connectCodexWebSocket(checkpoint.computer.endpoint, {
    onNotification: () => {},
    onClose: () => {},
  })
  try {
    await initializeCodexServer(server, version)
    const thread = await readRemoteThread(server, checkpoint.threadId)
    const turn = checkpointTurn(thread, checkpoint)
    if (!turn) {
      if (
        object(thread.status).type === 'active' ||
        checkpoint.turnId ||
        checkpoint.commandItemIds?.length ||
        (await readRemoteBackgroundTerminals(server, checkpoint.threadId)).length
      )
        throw new RemoteTurnUncertainError(true)
      return
    }
    await interruptRemoteTurn(server, checkpoint.threadId, String(turn.id), checkpoint.commandItemIds)
  } finally {
    server.close()
  }
}
