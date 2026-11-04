export type CodexServerEvents = {
  onNotification: (method: string, params: unknown) => void
  onRequest?: (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>
  onClose: (error: Error) => void
}

export type CodexConnection = {
  isClosed: () => boolean
  request: (method: string, params: object, timeoutMs?: number) => Promise<unknown>
  notify: (method: string, params: object) => void
  close: () => void
}

type Message = {
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string }
}

export function createCodexJsonRpc(
  events: CodexServerEvents,
  wire: { send: (data: string) => void; close: () => void }
) {
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }
  >()
  const incoming = new Map<number | string, AbortController>()
  let nextId = 1
  let closed = false
  const send = (message: Message) => {
    if (closed) throw new Error('codex-app-server-closed')
    wire.send(JSON.stringify(message))
  }
  const settle = (error: Error) => {
    if (closed) return
    closed = true
    for (const request of pending.values()) {
      clearTimeout(request.timeout)
      request.reject(error)
    }
    pending.clear()
    for (const request of incoming.values()) request.abort()
    incoming.clear()
    wire.close()
    events.onClose(error)
  }
  const receive = (data: string) => {
    let message: Message
    try {
      message = JSON.parse(data)
    } catch {
      return
    }
    if (closed || !message || typeof message !== 'object') return
    if (message.method) {
      if (message.id !== undefined) {
        const id = message.id
        const controller = new AbortController()
        incoming.get(id)?.abort()
        incoming.set(id, controller)
        void Promise.resolve()
          .then(() => {
            if (!events.onRequest) throw new Error(`Unsupported Codex request: ${message.method}`)
            return events.onRequest(message.method as string, message.params, controller.signal)
          })
          .then(
            (result) => {
              if (!closed && !controller.signal.aborted) send({ id, result })
            },
            (error: unknown) => {
              if (!closed && !controller.signal.aborted)
                send({
                  id,
                  error: { code: -32601, message: error instanceof Error ? error.message : 'Request failed' },
                })
            }
          )
          .catch((error: unknown) => settle(error instanceof Error ? error : new Error(String(error))))
          .finally(() => {
            if (incoming.get(id) === controller) incoming.delete(id)
          })
      } else {
        try {
          if (message.method === 'serverRequest/resolved') {
            const params = message.params as { requestId?: string | number } | undefined
            if (params?.requestId !== undefined) incoming.get(params.requestId)?.abort()
          }
          events.onNotification(message.method, message.params)
        } catch (error) {
          settle(error instanceof Error ? error : new Error(String(error)))
        }
      }
      return
    }
    if (typeof message.id !== 'number') return
    const request = pending.get(message.id)
    if (!request) return
    clearTimeout(request.timeout)
    pending.delete(message.id)
    if (message.error) request.reject(new Error(message.error.message || 'codex-app-server-error'))
    else request.resolve(message.result)
  }
  const connection: CodexConnection = {
    isClosed: () => closed,
    request(method, params, timeoutMs = 120_000) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`codex-app-server-timeout:${method}`))
        }, timeoutMs)
        pending.set(id, { resolve, reject, timeout })
        try {
          send({ id, method, params })
        } catch (error) {
          clearTimeout(timeout)
          pending.delete(id)
          reject(error)
        }
      })
    },
    notify: (method, params) => send({ method, params }),
    close: () => settle(new Error('codex-app-server-closed')),
  }
  return { connection, receive, settle }
}
