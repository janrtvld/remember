// Live protocol smoke test. Uses Node 24's built-in WebSocket, no dependencies.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const root = join(homedir(), 'Remember Agent')
const mode = process.argv[2] ?? 'create'
if (!['create', 'resume'].includes(mode)) throw new Error('Use create or resume')
const ws = new WebSocket('ws://127.0.0.1:47831')
const pending = new Map()
let nextId = 0
let resolveTurn
let rejectTurn
const completed = new Promise((resolve, reject) => {
  resolveTurn = resolve
  rejectTurn = reject
})
// Avoid an unhandled rejection while a request is still pending.
completed.catch(() => {})
const timer = setTimeout(() => {
  console.error('Probe timed out')
  process.exit(1)
}, 180000)
ws.addEventListener('message', ({ data }) => {
  const msg = JSON.parse(data)
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
  } else if (msg.id !== undefined && msg.method) {
    // Never silently approve commands requested by a remote agent.
    ws.send(JSON.stringify({ id: msg.id, error: { code: -32601, message: 'Probe cannot approve requests' } }))
  } else if (msg.method === 'turn/completed') {
    if (msg.params.turn.status === 'completed') resolveTurn(msg.params.turn)
    else rejectTurn(new Error(JSON.stringify(msg.params.turn.error ?? msg.params.turn.status)))
  } else if (msg.method === 'item/completed') {
    console.log('Completed item:', msg.params.item.type)
  }
})
function rpc(method, params) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
try {
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  await rpc('initialize', {
    clientInfo: { name: 'remember_agent_host_probe', title: 'Remember Agent Host Probe', version: '0.1.0' },
  })
  ws.send(JSON.stringify({ method: 'initialized' }))
  const params = { cwd: join(root, 'workspace'), sandbox: 'workspace-write', approvalPolicy: 'never' }
  const saved = mode === 'resume' ? JSON.parse(await readFile(join(root, 'state/probe.json'), 'utf8')) : null
  const result = await rpc(
    mode === 'resume' ? 'thread/resume' : 'thread/start',
    saved ? { ...params, threadId: saved.threadId } : params
  )
  const threadId = result.thread.id
  await mkdir(join(root, 'state'), { recursive: true })
  await writeFile(join(root, 'state/probe.json'), JSON.stringify({ threadId }, null, 2), { mode: 0o600 })
  console.log('Thread:', threadId, 'mode:', mode)
  const text =
    mode === 'create'
      ? 'Use a real shell tool to create host-proof.txt in the current workspace with exactly REMEMBER_AGENT_HOST_OK followed by a newline. Read it back using a shell tool. Do nothing else.'
      : 'Use a real shell tool to read host-proof.txt created in the previous turn. If its content is REMEMBER_AGENT_HOST_OK, create restart-proof.txt containing REMEMBER_AGENT_RESUMED followed by a newline using a shell tool. Do nothing else.'
  await rpc('turn/start', { threadId, input: [{ type: 'text', text }] })
  await completed
  const name = mode === 'create' ? 'host-proof.txt' : 'restart-proof.txt'
  const expected = mode === 'create' ? 'REMEMBER_AGENT_HOST_OK\n' : 'REMEMBER_AGENT_RESUMED\n'
  if ((await readFile(join(root, 'workspace', name), 'utf8')) !== expected) throw new Error('Proof mismatch')
  console.log('PASS:', name, 'verified on disk')
} finally {
  clearTimeout(timer)
  ws.close()
}
