import { normalizeAgentComputer } from '@remember/shared'
import { type CodexConnection, type CodexServerEvents, createCodexJsonRpc } from './codexJsonRpc'

export async function connectCodexWebSocket(
  endpoint: string,
  events: CodexServerEvents,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<CodexConnection> {
  normalizeAgentComputer({ kind: 'remote', endpoint, workspace: '/' })
  if (options.signal?.aborted) throw new Error('agent-cancelled')
  const socket = new WebSocket(endpoint)
  const rpc = createCodexJsonRpc(events, {
    send: (data) => {
      if (socket.readyState !== WebSocket.OPEN) throw new Error('codex-remote-disconnected')
      socket.send(data)
    },
    close: () => socket.close(),
  })
  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > 16 * 1024 * 1024) {
      rpc.settle(new Error('codex-remote-invalid-message'))
      return
    }
    rpc.receive(event.data)
  })
  socket.addEventListener('close', () => rpc.settle(new Error('codex-remote-disconnected')))
  socket.addEventListener('error', () => rpc.settle(new Error('codex-remote-unavailable')))
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => fail(new Error('codex-remote-connect-timeout')), options.timeoutMs ?? 10_000)
    const cleanup = () => {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
      socket.removeEventListener('open', open)
      socket.removeEventListener('error', error)
      socket.removeEventListener('close', error)
    }
    const fail = (reason: Error) => {
      cleanup()
      rpc.settle(reason)
      reject(reason)
    }
    const abort = () => fail(new Error('agent-cancelled'))
    const error = () => fail(new Error('codex-remote-unavailable'))
    const open = () => {
      cleanup()
      resolve()
    }
    socket.addEventListener('open', open, { once: true })
    socket.addEventListener('error', error, { once: true })
    socket.addEventListener('close', error, { once: true })
    options.signal?.addEventListener('abort', abort, { once: true })
  })
  return rpc.connection
}
