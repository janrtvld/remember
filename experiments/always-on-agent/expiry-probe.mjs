import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { connect } from './client.mjs'

const source = dirname(fileURLToPath(import.meta.url))
const root = process.argv[2]
if (!root?.startsWith('/private/tmp/remember-e06-')) throw Error('owned-test-directory-required')
const workspace = join(root, 'workspace')
mkdirSync(workspace, { recursive: true, mode: 0o700 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, label, timeout = 90_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw Error(`timeout:${label}`)
}
const proof = {
  startedAt: new Date().toISOString(),
  boundary:
    'Live provider client-tool expiry in a temporary Mini coordinator. Synthetic review, no real Remember policy.',
  trace: [],
}
const save = () => writeFileSync(join(root, 'proof.json'), JSON.stringify(proof, null, 2))
const child = spawn(process.execPath, [join(source, 'coordinator.mjs'), root], { stdio: ['ignore', 'pipe', 'pipe'] })
let output = '',
  client
child.stdout.on('data', (x) => (output += x))
child.stderr.on('data', (x) => {
  proof.trace.push({ stderr: String(x) })
  save()
})
try {
  await until(() => output.includes('"ready":true'), 'ready', 10_000)
  client = await connect(join(root, 'client.sock'))
  const spec = {
    workspace,
    model: 'gpt-6-astra',
    reviewTtlMs: 5000,
    prompt:
      'Silent synthetic test: first call remember_client_probe with nonce e06-expiry. Do no other work while waiting. Only if that tool returns approved=true, use a real shell to write APPROVED to approved.txt in the current workspace. Otherwise do not write or retry anything; finish.',
  }
  await client.call('submit', { jobId: 'expiry', spec })
  const pending = await until(async () => {
    const x = await client.call('snapshot')
    return x.requests.some((r) => r.method === 'fixture-source') ? x : null
  }, 'pending')
  const request = pending.requests.find((r) => r.method === 'fixture-source')
  assert.equal(existsSync(join(workspace, 'approved.txt')), false)
  await client.close()
  client = null
  await sleep(10_000)
  client = await connect(join(root, 'client.sock'))
  const stopped = await client.call('snapshot')
  assert.equal(stopped.job.phase, 'stopped')
  assert.equal(stopped.requests.length, 0)
  await assert.rejects(
    client.call('reply', {
      requestId: request.id,
      sessionId: pending.sessionId,
      sourceRevision: 'fixture-v1',
      result: { approved: true },
    }),
    /review-expired/
  )
  assert.equal((await client.call('submit', { jobId: 'expiry', spec })).created, false)
  assert.equal(existsSync(join(workspace, 'approved.txt')), false)
  const db = new DatabaseSync(join(root, 'job.sqlite'), { readOnly: true })
  proof.requests = db.prepare('SELECT id,status FROM server_request').all()
  proof.driverStarts = db.prepare("SELECT COUNT(*) AS count FROM event WHERE type='driver-invoked'").get().count
  proof.forwardedReviews = db.prepare("SELECT COUNT(*) AS count FROM event WHERE type='review-forwarded'").get().count
  db.close()
  assert.equal(proof.driverStarts, 1)
  assert.equal(proof.forwardedReviews, 0)
  assert.equal(proof.requests[0].status, 'expired')
  proof.threadId = stopped.job.threadId
  proof.turnId = stopped.job.turnId
  await client.close()
  client = null
  const exited = new Promise((r) => child.once('exit', r))
  child.kill('SIGTERM')
  await exited
  proof.status = 'passed'
  proof.finishedAt = new Date().toISOString()
  save()
  console.log(JSON.stringify(proof))
} catch (error) {
  proof.status = 'failed'
  proof.error = String(error.stack)
  save()
  console.error(error)
  if (client) await client.close().catch(() => {})
  child.unref()
  process.exitCode = 1
}
