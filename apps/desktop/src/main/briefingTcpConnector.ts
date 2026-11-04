import { createConnection } from 'node:net'

export interface BriefingConnection {
  request(op: string, payload?: Record<string, unknown>): Promise<unknown>
  close(): void
}

export async function connectBriefingTcp(endpoint: string): Promise<BriefingConnection> {
  const match = /^tcp:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(endpoint)
  if (!match || Number(match[1]) > 65_535) throw new Error('briefing-tcp-endpoint-invalid')

  return new Promise<BriefingConnection>((connected, connectionFailed) => {
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

    const close = (error = new Error('briefing-tcp-closed')) => {
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
    const connectTimer = setTimeout(() => close(new Error('briefing-tcp-connect-timeout')), 5_000)
    socket.setNoDelay(true)
    socket.setEncoding('utf8')
    socket.on('error', () => close(new Error('briefing-tcp-closed')))
    socket.on('close', () => close())
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > 65_536) {
        close(new Error('briefing-tcp-response-too-large'))
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
            (!value.error ||
              typeof value.error !== 'object' ||
              Array.isArray(value.error) ||
              Object.keys(value.error).length !== 1 ||
              typeof (value.error as { message?: unknown }).message !== 'string' ||
              !(value.error as { message: string }).message ||
              (value.error as { message: string }).message.length > 200))
        )
          throw new Error('invalid')
        const current = pending
        pending = null
        buffer = ''
        clearTimeout(current.timer)
        if (value.error) current.reject(new Error((value.error as { message: string }).message))
        else current.resolve(value.result)
      } catch {
        close(new Error('briefing-tcp-response-invalid'))
      }
    })
    socket.once('connect', () => {
      ready = true
      clearTimeout(connectTimer)
      connected({
        request(op, payload = {}) {
          if (closed) return Promise.reject(new Error('briefing-tcp-closed'))
          if (pending) return Promise.reject(new Error('briefing-tcp-busy'))
          let wire: string
          try {
            if (
              !['hello', 'snapshot', 'submit', 'authorize-write', 'stop', 'read-result'].includes(op) ||
              !payload ||
              typeof payload !== 'object' ||
              Array.isArray(payload) ||
              Object.hasOwn(payload, 'id') ||
              Object.hasOwn(payload, 'op')
            )
              throw new Error('invalid')
            wire = `${JSON.stringify({ id: sequence + 1, method: op, payload })}\n`
          } catch {
            return Promise.reject(new Error('briefing-tcp-request-invalid'))
          }
          if (Buffer.byteLength(wire) > 65_536) return Promise.reject(new Error('briefing-tcp-request-too-large'))
          return new Promise((resolve, reject) => {
            pending = {
              id: ++sequence,
              resolve,
              reject,
              timer: setTimeout(() => close(new Error('briefing-tcp-response-timeout')), 10_000),
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
