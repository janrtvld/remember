import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { connect } from './client.mjs'
import { connectCodexWebSocket, initializeCodexServer, readRemoteThread, remoteTurns } from './driver.mjs'

const source = dirname(fileURLToPath(import.meta.url)),
  root = process.argv[2]
if (!root?.startsWith('/private/tmp/remember-e06-')) throw Error('owned-test-directory-required')
const workspace = join(root, 'workspace')
mkdirSync(workspace, { recursive: true, mode: 0o700 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, label, timeout = 120_000) {
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
    'Actual isolated coordinator SIGKILL and exact remote command Stop; synthetic client, not native Remember quit.',
  trace: [],
}
const save = () => writeFileSync(join(root, 'proof.json'), JSON.stringify(proof, null, 2))
function state() {
  const db = new DatabaseSync(join(root, 'job.sqlite'), { readOnly: true })
  try {
    return {
      job: db.prepare('SELECT * FROM job').get(),
      events: db
        .prepare('SELECT * FROM event ORDER BY seq')
        .all()
        .map((e) => ({ ...e, payload: JSON.parse(e.payload_json) })),
    }
  } finally {
    db.close()
  }
}
let child, client, sentinel
async function start() {
  child = spawn(process.execPath, [join(source, 'coordinator.mjs'), root], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (x) => (output += x))
  child.stderr.on('data', (x) => {
    proof.trace.push({ stderr: String(x) })
    save()
  })
  await until(() => output.includes('"ready":true'), 'ready', 10_000)
  proof.trace.push({ coordinatorPid: child.pid })
}
async function exitCoordinator(signal) {
  const done = new Promise((r) => child.once('exit', (code, exitSignal) => r({ code, signal: exitSignal })))
  child.kill(signal)
  const result = await done
  proof.trace.push({ coordinatorExited: child.pid, ...result })
  if (existsSync(join(root, 'client.sock'))) unlinkSync(join(root, 'client.sock'))
}
writeFileSync(
  join(workspace, 'late.py'),
  `import pathlib,time\np=pathlib.Path('.')\np.joinpath('late.txt').write_text('START\\n')\np.joinpath('deadline-ms').write_text(str(int(time.time()*1000)+35000))\ntime.sleep(35)\nwith p.joinpath('late.txt').open('a') as f:f.write('DONE\\n')\nprint(p.joinpath('late.txt').read_text())\n`
)
const spec = {
  workspace,
  model: 'gpt-6-astra',
  prompt:
    'Run python3 late.py once using the real shell. Wait until it finishes and report the actual output. Do not modify the script, do not retry or start any other commands. This is an explicit silent synthetic Stop fixture.',
}
try {
  await start()
  client = await connect(join(root, 'client.sock'))
  await client.call('submit', { jobId: 'crash-stop', spec })
  await until(() => existsSync(join(workspace, 'deadline-ms')), 'command-started')
  const owned = await until(() => {
    const value = state()
      .events.filter((e) => e.type === 'checkpoint' && e.payload.checkpoint?.commandItemIds?.length)
      .at(-1)?.payload.checkpoint
    return value
  }, 'persisted command owner')
  proof.checkpoint = owned
  proof.originalDeadlineMs = Number(readFileSync(join(workspace, 'deadline-ms'), 'utf8'))
  sentinel = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import{writeFileSync}from'node:fs';setTimeout(()=>writeFileSync(${JSON.stringify(join(workspace, 'sentinel.txt'))},${JSON.stringify('SENTINEL\n')}),42000)`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  sentinel.stderr.on('data', (x) => {
    proof.trace.push({ sentinelStderr: String(x) })
    save()
  })
  sentinel.on('exit', (code, signal) => {
    proof.trace.push({ sentinelExit: code, signal })
    save()
  })
  proof.sentinelPid = sentinel.pid
  await client.close()
  client = null
  await exitCoordinator('SIGKILL')
  await start()
  client = await connect(join(root, 'client.sock'))
  const recovered = await client.call('snapshot')
  assert.equal(recovered.job.phase, 'recovery-required')
  assert.equal(recovered.job.turnId, owned.turnId)
  assert.equal((await client.call('submit', { jobId: 'crash-stop', spec })).created, false)
  assert.equal(state().events.filter((e) => e.type === 'driver-invoked').length, 1)
  const stopped = await client.call('stop')
  assert.equal(stopped.phase, 'stopped')
  proof.stopConfirmedAt = new Date().toISOString()
  const rpc = await connectCodexWebSocket('ws://127.0.0.1:47831/', { onNotification() {}, onClose() {} })
  try {
    await initializeCodexServer(rpc, 'e06-stop-readback')
    const turns = remoteTurns(await readRemoteThread(rpc, owned.threadId))
    assert.equal(turns.length, 1)
    proof.turn = turns[0]
    assert.equal(proof.turn.id, owned.turnId)
    assert.notEqual(proof.turn.status, 'inProgress')
    proof.remainingTerminals = await rpc.request('thread/backgroundTerminals/list', {
      threadId: owned.threadId,
      limit: 100,
    })
    assert.equal(proof.remainingTerminals.data.length, 0)
  } finally {
    rpc.close()
  }
  await client.close()
  client = null
  await exitCoordinator('SIGTERM')
  await until(
    () => Date.now() > proof.originalDeadlineMs + 5000 && existsSync(join(workspace, 'sentinel.txt')),
    'independent deadline and sentinel',
    50_000
  )
  proof.lateReadback = readFileSync(join(workspace, 'late.txt'), 'utf8')
  proof.sentinel = readFileSync(join(workspace, 'sentinel.txt'), 'utf8')
  assert.equal(proof.lateReadback, 'START\n')
  assert.equal(proof.sentinel, 'SENTINEL\n')
  proof.status = 'passed'
  proof.finishedAt = new Date().toISOString()
  save()
  console.log(
    JSON.stringify({
      status: proof.status,
      root,
      threadId: owned.threadId,
      turnId: owned.turnId,
      lateReadback: proof.lateReadback,
      sentinel: proof.sentinel,
    })
  )
} catch (error) {
  proof.status = 'failed'
  proof.error = String(error.stack)
  save()
  console.error(error)
  if (client) await client.close().catch(() => {})
  if (child) child.unref()
  process.exitCode = 1
}
