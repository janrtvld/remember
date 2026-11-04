import { createHash } from 'node:crypto'
import { createConnection, createServer } from 'node:net'

type FaultOperation = 'submit' | 'stop'
type Operation = 'hello' | 'submit' | 'snapshot' | 'reply' | 'stop'
type JsonObject = Record<string, unknown>
export type HostProxyTrace = {
  event:
    | 'connect'
    | 'request'
    | 'response'
    | 'dropped-response'
    | 'disconnect'
    | 'blocked'
    | 'unblocked'
    | 'armed'
    | 'rejected'
  at: number
  connectionId?: number
  requestId?: number
  op?: Operation
  success?: boolean
  jobId?: string
  phase?: string
  sessionId?: string
  bytes?: number
  sha256?: string
  reason?: string
}

const MAX_REQUEST_BYTES = 70_000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_TRACE_ENTRIES = 10_000
const operations = new Set(['hello', 'submit', 'snapshot', 'reply', 'stop'])

function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null
}

function metadata(value: unknown) {
  const result = object(value)
  const job = object(result?.job) ?? result
  return {
    ...(typeof job?.id === 'string' && job.id.length <= 200 ? { jobId: job.id } : {}),
    ...(typeof job?.phase === 'string' && job.phase.length <= 40 ? { phase: job.phase } : {}),
    ...(typeof result?.sessionId === 'string' && result.sessionId.length <= 200 ? { sessionId: result.sessionId } : {}),
  }
}

/** Faults only this QA client's JSONL link, never the provider connection or SSH tunnel. */
export async function ownedHostProxy(targetEndpoint: string) {
  const match = /^tcp:\/\/(127\.0\.0\.1|\[::1\]|localhost):([0-9]{1,5})$/.exec(targetEndpoint)
  const port = Number(match?.[2])
  if (!match || port < 1 || port > 65_535) throw new Error('invalid-host-proxy-target')
  const target = { host: match[1] === '[::1]' ? '::1' : '127.0.0.1', port }
  const trace: HostProxyTrace[] = []
  const pairs = new Map<number, (reason: string) => void>()
  let blocked = false
  let closed = false
  let nextConnection = 0
  let armed: FaultOperation | null = null
  let closing: Promise<void> | null = null
  const record = (entry: Omit<HostProxyTrace, 'at'>) => {
    if (trace.length >= MAX_TRACE_ENTRIES) {
      blocked = true
      return false
    }
    trace.push({ at: Date.now(), ...entry })
    return true
  }

  const server = createServer((client) => {
    if (blocked || closed || pairs.size >= 4) {
      record({ event: 'rejected', reason: blocked ? 'blocked' : closed ? 'closed' : 'connection-limit' })
      client.destroy()
      return
    }
    const connectionId = ++nextConnection
    const upstream = createConnection(target)
    let ended = false
    let requestBuffer = Buffer.alloc(0)
    let responseBuffer = Buffer.alloc(0)
    let pending: { id: number; op: Operation; jobId?: string } | null = null
    const closePair = (reason: string) => {
      if (ended) return
      ended = true
      clearTimeout(connectTimer)
      pairs.delete(connectionId)
      requestBuffer = Buffer.alloc(0)
      responseBuffer = Buffer.alloc(0)
      client.destroy()
      upstream.destroy()
      record({ event: 'disconnect', connectionId, reason })
    }
    const connectTimer = setTimeout(() => closePair('upstream-connect-timeout'), 5_000)
    pairs.set(connectionId, closePair)
    if (!record({ event: 'connect', connectionId })) return closePair('trace-limit')
    upstream.once('connect', () => clearTimeout(connectTimer))
    client.on('error', () => closePair('client-error')).on('close', () => closePair('client-closed'))
    upstream.on('error', () => closePair('upstream-error')).on('close', () => closePair('upstream-closed'))

    client.on('data', (chunk: Buffer) => {
      if (ended) return
      if (requestBuffer.length + chunk.length > MAX_REQUEST_BYTES) return closePair('request-too-large')
      requestBuffer = Buffer.concat([requestBuffer, chunk])
      const newline = requestBuffer.indexOf(10)
      if (newline < 0) return
      if (newline !== requestBuffer.length - 1 || pending) return closePair('nonserial-request')
      let request: JsonObject | null
      try {
        request = object(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(requestBuffer.subarray(0, newline)))
        )
      } catch {
        return closePair('invalid-request')
      }
      if (
        !request ||
        !Number.isSafeInteger(request.id) ||
        typeof request.op !== 'string' ||
        !operations.has(request.op)
      )
        return closePair('invalid-request')
      pending = {
        id: request.id as number,
        op: request.op as Operation,
        ...(typeof request.jobId === 'string' ? { jobId: request.jobId } : {}),
      }
      if (
        !record({ event: 'request', connectionId, requestId: pending.id, op: pending.op, bytes: requestBuffer.length })
      )
        return closePair('trace-limit')
      const frame = requestBuffer
      requestBuffer = Buffer.alloc(0)
      if (!upstream.write(frame)) client.pause()
    })
    upstream.on('drain', () => client.resume())

    upstream.on('data', (chunk: Buffer) => {
      if (ended) return
      if (responseBuffer.length + chunk.length > MAX_RESPONSE_BYTES) return closePair('response-too-large')
      responseBuffer = Buffer.concat([responseBuffer, chunk])
      const newline = responseBuffer.indexOf(10)
      if (newline < 0) return
      if (!pending || newline !== responseBuffer.length - 1) return closePair('invalid-response')
      let response: JsonObject | null
      try {
        response = object(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(responseBuffer.subarray(0, newline)))
        )
      } catch {
        return closePair('invalid-response')
      }
      const success = response !== null && Object.hasOwn(response, 'result') && !Object.hasOwn(response, 'error')
      if (
        !response ||
        response.id !== pending.id ||
        Object.keys(response).length !== 2 ||
        (!success && (typeof response.error !== 'string' || !response.error))
      )
        return closePair('invalid-response')
      const receipt = {
        connectionId,
        requestId: pending.id,
        op: pending.op,
        success,
        bytes: responseBuffer.length,
        sha256: createHash('sha256').update(responseBuffer).digest('hex'),
        ...(success ? metadata(response.result) : {}),
      }
      if (!record({ event: 'response', ...receipt })) return closePair('trace-limit')
      if (success && pending.op === armed) {
        const result = object(response.result)
        const job = pending.op === 'submit' ? object(result?.job) : result
        const accepted =
          pending.op === 'submit'
            ? typeof result?.created === 'boolean' && job?.id === pending.jobId && typeof job?.phase === 'string'
            : typeof job?.id === 'string' && ['stopped', 'completed'].includes(String(job.phase))
        if (!accepted) return closePair('invalid-success-receipt')
        armed = null
        record({ event: 'dropped-response', ...receipt })
        return closePair('response-intentionally-lost')
      }
      const frame = responseBuffer
      responseBuffer = Buffer.alloc(0)
      pending = null
      if (!client.write(frame)) upstream.pause()
    })
    client.on('drain', () => upstream.resume())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('host-proxy-listen-failed')
  return {
    endpoint: `tcp://127.0.0.1:${address.port}`,
    trace,
    block(value: boolean) {
      blocked = value
      record({ event: value ? 'blocked' : 'unblocked' })
      if (blocked) for (const close of pairs.values()) close('blocked')
    },
    dropNextResponse(op: FaultOperation) {
      if (closed || armed) throw new Error('host-proxy-fault-unavailable')
      if (op !== 'submit' && op !== 'stop') throw new Error('host-proxy-invalid-fault')
      armed = op
      record({ event: 'armed', op })
    },
    close() {
      if (closing) return closing
      closed = true
      for (const close of pairs.values()) close('proxy-closed')
      closing = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
      return closing
    },
  }
}
