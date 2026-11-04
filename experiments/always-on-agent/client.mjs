import { createConnection } from 'node:net'
export async function connect(path) {
  const socket = createConnection(path)
  await new Promise((r, j) => {
    socket.once('connect', r)
    socket.once('error', j)
  })
  let next = 0,
    buffer = ''
  const pending = new Map()
  socket.setEncoding('utf8')
  socket.on('error', () => {})
  socket.on('data', (chunk) => {
    buffer += chunk
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n'),
        message = JSON.parse(buffer.slice(0, index))
      buffer = buffer.slice(index + 1)
      const request = pending.get(message.id)
      if (request) {
        pending.delete(message.id)
        message.error ? request.reject(Error(message.error)) : request.resolve(message.result)
      }
    }
  })
  socket.on('close', () => {
    for (const request of pending.values()) request.reject(Error('client-closed'))
    pending.clear()
  })
  return {
    call(op, data = {}) {
      return new Promise((resolve, reject) => {
        const id = ++next
        pending.set(id, { resolve, reject })
        socket.write(`${JSON.stringify({ id, op, ...data })}\n`)
      })
    },
    async close() {
      if (socket.destroyed) return
      const closed = new Promise((r) => socket.once('close', r))
      socket.end()
      await closed
    },
  }
}
