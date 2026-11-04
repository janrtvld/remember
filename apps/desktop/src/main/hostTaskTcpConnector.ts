import { createConnection } from 'node:net'

export interface HostTaskTcpConnection {
  request(op: string, payload?: Record<string, unknown>): Promise<unknown>
  close(): void
}

export async function connectHostTaskTcp(endpoint: string): Promise<HostTaskTcpConnection> {
  const match = /^tcp:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(endpoint)
  if (!match || Number(match[1]) > 65_535) throw new Error('host-task-tcp-endpoint-invalid')

  return new Promise<HostTaskTcpConnection>((connected, connectionFailed) => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(match[1]) })
    let closed = false
    let ready = false
    let sequence = 0
    let buffer = ''
    let pending: {
      id: number
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    } | null = null

    const close = (error = new Error('host-task-tcp-closed')) => {
      if (closed) return
      closed = true
      clearTimeout(connectTimer)
      if (!ready) connectionFailed(error)
      if (pending) {
        clearTimeout(pending.timer)
        pending.reject(error)
        pending = null
      }
      socket.destroy()
    }
    const connectTimer = setTimeout(() => close(new Error('host-task-tcp-connect-timeout')), 5_000)
    socket.setEncoding('utf8')
    socket.on('error', () => close(new Error('host-task-tcp-closed')))
    socket.on('close', () => close())
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) {
        close(new Error('host-task-tcp-response-too-large'))
        return
      }
      const end = buffer.indexOf('\n')
      if (end < 0) return
      try {
        if (!pending || end !== buffer.length - 1) throw new Error('invalid')
        const response: unknown = JSON.parse(buffer.slice(0, end))
        if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('invalid')
        const value = response as Record<string, unknown>
        if (
          Object.keys(value).length !== 2 ||
          value.id !== pending.id ||
          (!Object.hasOwn(value, 'result') && !Object.hasOwn(value, 'error')) ||
          (Object.hasOwn(value, 'error') &&
            (typeof value.error !== 'string' || !value.error || value.error.length > 200))
        )
          throw new Error('invalid')
        const current = pending
        pending = null
        buffer = ''
        clearTimeout(current.timer)
        if (typeof value.error === 'string') current.reject(new Error(value.error))
        else current.resolve(value.result)
      } catch {
        close(new Error('host-task-tcp-response-invalid'))
      }
    })
    socket.once('connect', () => {
      ready = true
      clearTimeout(connectTimer)
      connected({
        request(op, payload = {}) {
          if (closed) return Promise.reject(new Error('host-task-tcp-closed'))
          if (pending) return Promise.reject(new Error('host-task-tcp-busy'))
          let wire: string
          try {
            if (
              !['hello', 'snapshot', 'submit', 'reply', 'stop'].includes(op) ||
              !payload ||
              typeof payload !== 'object' ||
              Array.isArray(payload) ||
              Object.hasOwn(payload, 'id') ||
              Object.hasOwn(payload, 'op')
            )
              throw new Error('invalid')
            wire = `${JSON.stringify({ ...payload, id: sequence + 1, op })}\n`
          } catch {
            return Promise.reject(new Error('host-task-tcp-request-invalid'))
          }
          if (Buffer.byteLength(wire) > 70_000) return Promise.reject(new Error('host-task-tcp-request-too-large'))
          return new Promise((resolve, reject) => {
            pending = {
              id: ++sequence,
              resolve,
              reject,
              timer: setTimeout(() => close(new Error('host-task-tcp-response-timeout')), 10_000),
            }
            // The service's synchronous final guard immediately precedes this write.
            try {
              socket.write(wire)
            } catch {
              close()
            }
          })
        },
        close: () => close(),
      })
    })
  })
}
