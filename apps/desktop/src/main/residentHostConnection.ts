import { createConnection } from 'node:net'

const CONNECT_TIMEOUT_MS = 5_000
const REQUEST_TIMEOUT_MS = 10_000
const MAX_REQUEST_BYTES = 70_000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_QUEUED_REQUESTS = 32

export type ResidentHostConnection = {
  request<T>(op: string, payload?: Record<string, unknown>): Promise<T>
  close(): void
}

type PendingRequest = {
  id: number
  frame: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

function address(endpoint: string) {
  const match = /^tcp:\/\/(127\.0\.0\.1|\[::1\]|localhost):([0-9]{1,5})$/.exec(endpoint)
  const port = Number(match?.[2])
  if (!match || port < 1 || port > 65_535) throw new Error('resident-host-invalid-endpoint')
  return { host: match[1] === '[::1]' ? '::1' : '127.0.0.1', port }
}

export async function connectResidentHost(endpoint: string, signal?: AbortSignal): Promise<ResidentHostConnection> {
  const target = address(endpoint)
  if (signal?.aborted) throw new Error('resident-host-aborted')
  const socket = createConnection(target)
  const queue: PendingRequest[] = []
  let pending: PendingRequest | null = null
  let buffer = Buffer.alloc(0)
  let nextId = 1
  let closed: Error | null = null
  let connected = false
  let resolveConnection: () => void
  let rejectConnection: (error: Error) => void
  const connectionReady = new Promise<void>((resolve, reject) => {
    resolveConnection = resolve
    rejectConnection = reject
  })

  const fail = (error: Error) => {
    if (closed) return
    closed = error
    clearTimeout(connectTimer)
    signal?.removeEventListener('abort', abort)
    if (!connected) rejectConnection(error)
    const requests = pending ? [pending, ...queue] : [...queue]
    pending = null
    queue.length = 0
    buffer = Buffer.alloc(0)
    for (const request of requests) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    socket.destroy()
  }
  const abort = () => fail(new Error('resident-host-aborted'))
  const connectTimer = setTimeout(() => fail(new Error('resident-host-connect-timeout')), CONNECT_TIMEOUT_MS)

  function sendNext() {
    if (closed || pending || !queue.length) return
    pending = queue.shift() as PendingRequest
    socket.write(pending.frame, (error) => {
      if (error) fail(new Error('resident-host-disconnected'))
    })
  }

  socket.once('connect', () => {
    if (closed) return
    connected = true
    clearTimeout(connectTimer)
    resolveConnection()
  })
  socket.on('error', () => fail(new Error(connected ? 'resident-host-disconnected' : 'resident-host-unavailable')))
  socket.on('close', () => fail(new Error('resident-host-disconnected')))
  socket.on('end', () => fail(new Error('resident-host-disconnected')))
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()

  socket.on('data', (chunk: Buffer) => {
    if (closed) return
    if (!pending || buffer.length + chunk.length > MAX_RESPONSE_BYTES + 1) {
      fail(new Error('resident-host-invalid-response'))
      return
    }
    buffer = Buffer.concat([buffer, chunk])
    const newline = buffer.indexOf(10)
    if (newline < 0) {
      if (buffer.length > MAX_RESPONSE_BYTES) fail(new Error('resident-host-invalid-response'))
      return
    }
    if (newline !== buffer.length - 1 || newline > MAX_RESPONSE_BYTES) {
      fail(new Error('resident-host-invalid-response'))
      return
    }
    let response: unknown
    try {
      response = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, newline)))
    } catch {
      fail(new Error('resident-host-invalid-response'))
      return
    }
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      fail(new Error('resident-host-invalid-response'))
      return
    }
    const record = response as Record<string, unknown>
    const result = Object.hasOwn(record, 'result')
    const error = Object.hasOwn(record, 'error')
    if (
      !Number.isSafeInteger(record.id) ||
      record.id !== pending.id ||
      Object.keys(record).length !== 2 ||
      result === error ||
      (error && (typeof record.error !== 'string' || !record.error))
    ) {
      fail(new Error('resident-host-invalid-response'))
      return
    }
    const completed = pending
    pending = null
    buffer = Buffer.alloc(0)
    clearTimeout(completed.timer)
    if (error) completed.reject(new Error(String(record.error).slice(0, 1000)))
    else completed.resolve(record.result)
    sendNext()
  })

  await connectionReady
  return {
    request<T>(op: string, payload: Record<string, unknown> = {}): Promise<T> {
      if (closed) return Promise.reject(closed)
      if (queue.length + Number(pending !== null) >= MAX_QUEUED_REQUESTS) {
        return Promise.reject(new Error('resident-host-queue-full'))
      }
      let frame: string
      try {
        if (
          typeof op !== 'string' ||
          !/^[a-z][a-zA-Z0-9_-]{0,63}$/.test(op) ||
          !payload ||
          typeof payload !== 'object' ||
          Array.isArray(payload) ||
          ![Object.prototype, null].includes(Object.getPrototypeOf(payload)) ||
          ['id', 'op', 'toJSON'].some((key) => Object.hasOwn(payload, key)) ||
          !Number.isSafeInteger(nextId)
        )
          throw new Error('resident-host-invalid-request')
        frame = `${JSON.stringify({ ...payload, id: nextId, op })}\n`
      } catch {
        return Promise.reject(new Error('resident-host-invalid-request'))
      }
      if (Buffer.byteLength(frame) > MAX_REQUEST_BYTES)
        return Promise.reject(new Error('resident-host-request-too-large'))
      const id = nextId++
      return new Promise<unknown>((resolve, reject) => {
        const request: PendingRequest = {
          id,
          frame,
          resolve,
          reject,
          timer: setTimeout(() => {
            const error = new Error('resident-host-request-timeout')
            if (pending === request) fail(error)
            else {
              const index = queue.indexOf(request)
              if (index >= 0) queue.splice(index, 1)
              reject(error)
            }
          }, REQUEST_TIMEOUT_MS),
        }
        queue.push(request)
        sendNext()
      }) as Promise<T>
    },
    close() {
      fail(new Error('resident-host-closed'))
    },
  }
}
