import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, type Socket } from 'node:net'
import { type TestContext, test } from 'node:test'
import { connectResidentHost } from '../residentHostConnection'

type Request = { id: number; op: string; [key: string]: unknown }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

async function host(t: TestContext, handle: (request: Request, socket: Socket) => void, hostname = '127.0.0.1') {
  const sockets = new Set<Socket>()
  const requests: Request[] = []
  let connections = 0
  const server = createServer((socket) => {
    connections++
    sockets.add(socket)
    let buffer = ''
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    socket.on('data', (data) => {
      buffer += data.toString()
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n')
        const request = JSON.parse(buffer.slice(0, end)) as Request
        buffer = buffer.slice(end + 1)
        requests.push(request)
        handle(request, socket)
      }
    })
  })
  server.listen(0, hostname)
  await once(server, 'listening')
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const address = server.address()
  assert(address && typeof address !== 'string')
  return {
    endpoint: `tcp://${hostname === '::1' ? '[::1]' : hostname}:${address.port}`,
    requests,
    get connections() {
      return connections
    },
  }
}

function reply(socket: Socket, request: Request, result: unknown) {
  socket.write(`${JSON.stringify({ id: request.id, result })}\n`)
}

test('endpoint validation allows only explicit loopback TCP ports without auth, paths or URL suffixes', async () => {
  for (const endpoint of [
    'tcp://example.com:47832',
    'tcp://192.168.1.3:47832',
    'tcp://127.0.0.2:47832',
    'tcp://[::ffff:127.0.0.1]:47832',
    'tcp://localhost',
    'tcp://localhost:0',
    'tcp://localhost:65536',
    'tcp://localhost:123/',
    'tcp://localhost:123/path',
    'tcp://localhost:123?secret=x',
    'tcp://localhost:123#fragment',
    'tcp://user:secret@localhost:123',
    'ws://localhost:123',
    'tcp://localhost:123\n',
    'tcp://2130706433:123',
    'tcp://127.1:123',
  ]) {
    await assert.rejects(connectResidentHost(endpoint), /resident-host-invalid-endpoint/, endpoint)
  }
})

test('localhost and IPv6 loopback connect to real local sockets', async (t) => {
  for (const hostname of ['127.0.0.1', '::1']) {
    const fixture = await host(t, (request, socket) => reply(socket, request, { local: true }), hostname)
    const endpoint = hostname === '127.0.0.1' ? fixture.endpoint.replace('127.0.0.1', 'localhost') : fixture.endpoint
    const connection = await connectResidentHost(endpoint)
    t.after(() => connection.close())
    assert.deepEqual(await connection.request('snapshot'), { local: true })
  }
})

test('the serial queue sends no second operation until the first reply, including split UTF-8 responses', async (t) => {
  const first = deferred<{ request: Request; socket: Socket }>()
  const fixture = await host(t, (request, socket) => {
    if (request.op === 'submit') first.resolve({ request, socket })
    else reply(socket, request, { op: request.op })
  })
  const connection = await connectResidentHost(fixture.endpoint)
  t.after(() => connection.close())
  const accepted = connection.request<{ accepted: string }>('submit', { jobId: 'synthetic' })
  const snapshot = connection.request('snapshot')
  const { request, socket } = await first.promise
  assert.deepEqual(
    fixture.requests.map(({ op }) => op),
    ['submit']
  )
  const response = Buffer.from(`${JSON.stringify({ id: request.id, result: { accepted: 'klaar 🚲' } })}\n`)
  const split = response.indexOf(Buffer.from('🚲')) + 2
  socket.write(response.subarray(0, split))
  socket.write(response.subarray(split))
  assert.deepEqual(await accepted, { accepted: 'klaar 🚲' })
  assert.deepEqual(await snapshot, { op: 'snapshot' })
  assert.deepEqual(
    fixture.requests.map(({ id }) => id),
    [1, 2]
  )
})

test('a matching server error rejects only that operation and does not retry it', async (t) => {
  const fixture = await host(t, (request, socket) => {
    if (request.op === 'reply') socket.write(`${JSON.stringify({ id: request.id, error: 'review-expired' })}\n`)
    else reply(socket, request, { phase: 'waiting' })
  })
  const connection = await connectResidentHost(fixture.endpoint)
  t.after(() => connection.close())
  await assert.rejects(connection.request('reply', { requestId: 'expired-review' }), /review-expired/)
  assert.deepEqual(await connection.request('snapshot'), { phase: 'waiting' })
  assert.deepEqual(
    fixture.requests.map(({ op }) => op),
    ['reply', 'snapshot']
  )
})

test('lost submit ACK rejects pending and queued work without reconnecting, retrying or sending Stop', async (t) => {
  const fixture = await host(t, (_request, socket) => socket.destroy())
  const connection = await connectResidentHost(fixture.endpoint)
  const submitted = assert.rejects(connection.request('submit', { jobId: 'once' }), /disconnected/)
  const queued = assert.rejects(connection.request('reply', { approved: true }), /disconnected/)
  await Promise.all([submitted, queued])
  assert.equal(fixture.connections, 1)
  assert.deepEqual(
    fixture.requests.map(({ op }) => op),
    ['submit']
  )
  await assert.rejects(connection.request('snapshot'), /disconnected/)
})

test('close detaches the TCP client and rejects unsent work without any host Stop', async (t) => {
  const received = deferred<Socket>()
  const fixture = await host(t, (_request, socket) => received.resolve(socket))
  const connection = await connectResidentHost(fixture.endpoint)
  const pending = assert.rejects(connection.request('submit', { jobId: 'keep-running' }), /resident-host-closed/)
  const queued = assert.rejects(connection.request('reply', { approved: true }), /resident-host-closed/)
  const socket = await received.promise
  const detached = once(socket, 'close')
  connection.close()
  connection.close()
  await Promise.all([pending, queued, detached])
  assert.deepEqual(
    fixture.requests.map(({ op }) => op),
    ['submit']
  )
  await assert.rejects(connection.request('stop'), /resident-host-closed/)
})

test('AbortSignal covers the connection lifetime, including pending and queued requests', async (t) => {
  const received = deferred<void>()
  const fixture = await host(t, () => received.resolve())
  const controller = new AbortController()
  const connection = await connectResidentHost(fixture.endpoint, controller.signal)
  const pending = assert.rejects(connection.request('snapshot'), /resident-host-aborted/)
  const queued = assert.rejects(connection.request('submit', { jobId: 'never-sent' }), /resident-host-aborted/)
  await received.promise
  controller.abort()
  await Promise.all([pending, queued])
  assert.equal(fixture.requests.length, 1)
  await assert.rejects(connectResidentHost(fixture.endpoint, controller.signal), /resident-host-aborted/)
  assert.equal(fixture.connections, 1)
})

test('malformed JSON, invalid UTF-8, wrong IDs and invalid envelopes close the connection', async (t) => {
  const frames = [
    'null\n',
    '[]\n',
    '{broken}\n',
    '{"id":2,"result":{}}\n',
    '{"id":"1","result":{}}\n',
    '{"id":1}\n',
    '{"id":1,"result":{},"error":"conflict"}\n',
    '{"id":1,"error":{"message":"bad"}}\n',
    '{"id":1,"result":{},"unexpected":true}\n',
    '{"id":1,"result":{}}\n{"id":2,"result":{}}\n',
    Buffer.concat([Buffer.from('{"id":1,"result":"'), Buffer.from([0xff]), Buffer.from('"}\n')]),
  ]
  for (const frame of frames) {
    const fixture = await host(t, (_request, socket) => socket.write(frame))
    const connection = await connectResidentHost(fixture.endpoint)
    await assert.rejects(connection.request('snapshot'), /resident-host-invalid-response/)
    await assert.rejects(connection.request('submit'), /resident-host-invalid-response/)
    assert.equal(fixture.connections, 1)
  }
})

test('request bounds and reserved fields reject before writing; oversized responses fail closed', async (t) => {
  const fixture = await host(t, (_request, socket) => socket.write(Buffer.alloc(2 * 1024 * 1024 + 1, 120)))
  const connection = await connectResidentHost(fixture.endpoint)
  await assert.rejects(connection.request('submit', { text: 'a'.repeat(70_000) }), /request-too-large/)
  await assert.rejects(connection.request('submit', { text: '😀'.repeat(20_000) }), /request-too-large/)
  for (const payload of [{ id: 7 }, { op: 'stop' }, { toJSON: () => ({ op: 'stop' }) }]) {
    await assert.rejects(connection.request('snapshot', payload), /invalid-request/)
  }
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  await assert.rejects(connection.request('snapshot', cyclic), /invalid-request/)
  assert.equal(fixture.requests.length, 0)
  await assert.rejects(connection.request('snapshot'), /invalid-response/)
  assert.equal(fixture.requests.length, 1)
})

test('the 10-second deadline includes queue time and never retries an outcome with a lost ACK', async (t) => {
  const first = deferred<{ request: Request; socket: Socket }>()
  const second = deferred<void>()
  const fixture = await host(t, (request, socket) => {
    if (request.id === 1) first.resolve({ request, socket })
    else second.resolve()
  })
  const connection = await connectResidentHost(fixture.endpoint)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const initial = connection.request('snapshot')
  const queued = assert.rejects(connection.request('submit', { jobId: 'deadline' }), /request-timeout/)
  const { socket, request } = await first.promise
  t.mock.timers.tick(9990)
  reply(socket, request, { ready: true })
  assert.deepEqual(await initial, { ready: true })
  await second.promise
  t.mock.timers.tick(10)
  await queued
  assert.equal(fixture.connections, 1)
  assert.deepEqual(
    fixture.requests.map(({ op }) => op),
    ['snapshot', 'submit']
  )
  await assert.rejects(connection.request('snapshot'), /request-timeout/)
})

test('the queue is bounded and closing rejects every accepted outstanding request', async (t) => {
  const fixture = await host(t, () => {})
  const connection = await connectResidentHost(fixture.endpoint)
  const outstanding = Array.from({ length: 32 }, () =>
    assert.rejects(connection.request('snapshot'), /resident-host-closed/)
  )
  await assert.rejects(connection.request('snapshot'), /queue-full/)
  connection.close()
  await Promise.all(outstanding)
})
