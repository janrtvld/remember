import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, Socket } from 'node:net'
import { type TestContext, test } from 'node:test'
import { connectHostTaskTcp } from '../hostTaskTcpConnector'

async function peer(t: TestContext, respond: (socket: Socket, request: Record<string, unknown>) => void) {
  const sockets = new Set<Socket>()
  const requests: Record<string, unknown>[] = []
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (data: string) => {
      buffer += data
      const end = buffer.indexOf('\n')
      if (end < 0) return
      const request = JSON.parse(buffer.slice(0, end)) as Record<string, unknown>
      buffer = buffer.slice(end + 1)
      requests.push(request)
      respond(socket, request)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return { endpoint: `tcp://127.0.0.1:${address.port}`, port: address.port, requests }
}

test('only canonical explicit IPv4 loopback endpoints are accepted', async () => {
  for (const endpoint of [
    'tcp://localhost:47850',
    'tcp://[::1]:47850',
    'tcp://192.0.2.1:47850',
    'tcp://user@127.0.0.1:47850',
    'tcp://127.0.0.1:0',
    'tcp://127.0.0.1:65536',
    'tcp://127.0.0.1:047850',
    'tcp://127.0.0.1:47850/',
    'tcp://127.0.0.1:47850?x=1',
    'tcp://127.0.0.1:47850#x',
    'ws://127.0.0.1:47850',
    ' tcp://127.0.0.1:47850',
  ])
    await assert.rejects(connectHostTaskTcp(endpoint), { message: 'host-task-tcp-endpoint-invalid' })
})

test('connection is established before return and request writes synchronously with exact identity', async (t) => {
  const remote = await peer(t, (socket, request) =>
    socket.write(`${JSON.stringify({ id: request.id, result: { ok: true } })}\n`)
  )
  const connection = await connectHostTaskTcp(remote.endpoint)
  t.after(() => connection.close())
  let writes = 0
  const original = Socket.prototype.write
  Socket.prototype.write = new Proxy(original, {
    apply(target, receiver: Socket, args: unknown[]) {
      if (receiver.remotePort === remote.port) writes++
      return Reflect.apply(target, receiver, args)
    },
  })
  let pending: Promise<unknown>
  try {
    pending = connection.request('snapshot', { afterSeq: 7 })
    assert.equal(writes, 1, 'Write must occur before request() returns its promise')
  } finally {
    Socket.prototype.write = original
  }
  assert.deepEqual(await pending, { ok: true })
  assert.deepEqual(remote.requests, [{ id: 1, op: 'snapshot', afterSeq: 7 }])
  assert.deepEqual(await connection.request('hello'), { ok: true })
  assert.equal(remote.requests[1]?.id, 2)
})

test('fragmented response is reassembled; actual coordinator error is propagated without replay', async (t) => {
  const remote = await peer(t, (socket, request) => {
    if (request.op === 'hello') {
      socket.write(`{"id":${request.id},"result":`)
      setImmediate(() => socket.write('{"sessionId":"owned"}}\n'))
    } else socket.write(`${JSON.stringify({ id: request.id, error: 'actual-coordinator-denial' })}\n`)
  })
  const connection = await connectHostTaskTcp(remote.endpoint)
  t.after(() => connection.close())
  assert.deepEqual(await connection.request('hello'), { sessionId: 'owned' })
  await assert.rejects(connection.request('stop'), { message: 'actual-coordinator-denial' })
  assert.equal(remote.requests.length, 2)
})

for (const [name, reply] of [
  ['wrong-id', (id: number) => `${JSON.stringify({ id: id + 1, result: true })}\n`],
  ['malformed', () => 'not-json\n'],
  ['extra-key', (id: number) => `${JSON.stringify({ id, result: true, extra: true })}\n`],
  ['result-and-error', (id: number) => `${JSON.stringify({ id, result: true, error: 'bad' })}\n`],
  ['extra-frame', (id: number) => `${JSON.stringify({ id, result: true })}\n{}\n`],
  ['oversize', () => 'x'.repeat(2 * 1024 * 1024 + 1)],
] as const) {
  test(`reject ${name} response, close and never replay`, async (t) => {
    const remote = await peer(t, (socket, request) => socket.write(reply(Number(request.id))))
    const connection = await connectHostTaskTcp(remote.endpoint)
    t.after(() => connection.close())
    await assert.rejects(connection.request('hello'), /host-task-tcp-(response-invalid|response-too-large)/)
    await assert.rejects(connection.request('hello'), { message: 'host-task-tcp-closed' })
    assert.equal(remote.requests.length, 1)
  })
}

test('reserved payload keys, unsupported operations and oversized requests never reach peer', async (t) => {
  const remote = await peer(t, () => {})
  const connection = await connectHostTaskTcp(remote.endpoint)
  t.after(() => connection.close())
  for (const [op, payload] of [
    ['hello', { id: 6 }],
    ['hello', { op: 'submit' }],
    ['shutdown', {}],
    ['submit', { text: 'x'.repeat(70_000) }],
  ] as const)
    await assert.rejects(connection.request(op, payload), /host-task-tcp-request-(invalid|too-large)/)
  assert.deepEqual(remote.requests, [])
})

test('concurrent request refuses; close settles pending once and no reconnect', async (t) => {
  const remote = await peer(t, () => {})
  const connection = await connectHostTaskTcp(remote.endpoint)
  const pending = connection.request('hello')
  const rejected = assert.rejects(pending, { message: 'host-task-tcp-closed' })
  await assert.rejects(connection.request('snapshot'), { message: 'host-task-tcp-busy' })
  connection.close()
  connection.close()
  await rejected
  await assert.rejects(connection.request('hello'), { message: 'host-task-tcp-closed' })
})

test('response timeout closes the connection without replay', async (t) => {
  const remote = await peer(t, () => {})
  const connection = await connectHostTaskTcp(remote.endpoint)
  t.after(() => connection.close())
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = connection.request('hello')
  const rejected = assert.rejects(pending, { message: 'host-task-tcp-response-timeout' })
  t.mock.timers.tick(10_000)
  await rejected
  await assert.rejects(connection.request('hello'), { message: 'host-task-tcp-closed' })
})

test('peer disconnect rejects pending request without reconnect', async (t) => {
  const remote = await peer(t, (socket) => socket.destroy())
  const connection = await connectHostTaskTcp(remote.endpoint)
  t.after(() => connection.close())
  await assert.rejects(connection.request('hello'), { message: 'host-task-tcp-closed' })
  assert.equal(remote.requests.length, 1)
})
