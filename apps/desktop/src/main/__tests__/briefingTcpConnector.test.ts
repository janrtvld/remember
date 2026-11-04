import assert from 'node:assert/strict'
import { createServer, type Socket } from 'node:net'
import { test } from 'node:test'
import { connectBriefingTcp } from '../briefingTcpConnector'

async function peer(answer: (socket: Socket, value: Record<string, unknown>) => void) {
  const requests: Record<string, unknown>[] = []
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    let input = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      input += chunk
      const end = input.indexOf('\n')
      if (end < 0) return
      const value = JSON.parse(input.slice(0, end)) as Record<string, unknown>
      input = input.slice(end + 1)
      requests.push(value)
      answer(socket, value)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert(address && typeof address === 'object')
  return {
    endpoint: `tcp://127.0.0.1:${address.port}`,
    requests,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

test('only an exact local configured endpoint is accepted', async () => {
  for (const endpoint of [
    'http://127.0.0.1:1234',
    'tcp://localhost:1234',
    'tcp://0.0.0.0:1234',
    'tcp://127.0.0.1:65536',
    'tcp://127.0.0.1:1234/path',
  ])
    await assert.rejects(connectBriefingTcp(endpoint), /briefing-tcp-endpoint-invalid/)
})

test('exact framing, split response and typed remote error', async () => {
  const host = await peer((socket, value) => {
    const wire = `${JSON.stringify(value.method === 'stop' ? { id: value.id, error: { message: 'wrong-action' } } : { id: value.id, result: { accepted: true } })}\n`
    socket.write(wire.slice(0, 5))
    setImmediate(() => socket.write(wire.slice(5)))
  })
  const connection = await connectBriefingTcp(host.endpoint)
  try {
    assert.deepEqual(await connection.request('hello'), { accepted: true })
    assert.deepEqual(host.requests[0], { id: 1, method: 'hello', payload: {} })
    await assert.rejects(connection.request('stop', { actionId: 'A' }), /^Error: wrong-action$/)
    assert.deepEqual(host.requests[1], { id: 2, method: 'stop', payload: { actionId: 'A' } })
    await assert.rejects(connection.request('shell'), /request-invalid/)
    await assert.rejects(connection.request('submit', { blob: 'x'.repeat(65_536) }), /request-too-large/)
    assert.equal(host.requests.length, 2)
  } finally {
    connection.close()
    await host.close()
  }
})

test('mismatched response, malformed error and excess bytes close the connection', async () => {
  for (const answer of [
    (id: unknown) => JSON.stringify({ id: Number(id) + 1, result: true }) + '\n',
    (id: unknown) => JSON.stringify({ id, error: 'wrong shape' }) + '\n',
    (id: unknown) => JSON.stringify({ id, result: true, extra: true }) + '\n',
    () => 'x'.repeat(65_537),
  ]) {
    const host = await peer((socket, value) => socket.write(answer(value.id)))
    const connection = await connectBriefingTcp(host.endpoint)
    try {
      await assert.rejects(connection.request('snapshot'), /response-(invalid|too-large)/)
      await assert.rejects(connection.request('hello'), /closed/)
    } finally {
      connection.close()
      await host.close()
    }
  }
})

test('close rejects a pending call and no concurrent request can overwrite it', async () => {
  const host = await peer(() => {})
  const connection = await connectBriefingTcp(host.endpoint)
  try {
    const pending = connection.request('snapshot')
    await assert.rejects(connection.request('stop'), /busy/)
    connection.close()
    await assert.rejects(pending, /closed/)
  } finally {
    connection.close()
    await host.close()
  }
})
