import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { connect } from './client.mjs'
import { connectCodexWebSocket, initializeCodexServer, readRemoteThread, remoteTurns } from './driver.mjs'

const source = dirname(fileURLToPath(import.meta.url))
const root = process.argv[2]
if (!root?.startsWith('/private/tmp/remember-e06-')) throw Error('owned-test-directory-required')
const workspace = join(root, 'workspace')
mkdirSync(workspace, { recursive: true, mode: 0o700 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, label, timeout = 180_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await fn()
    if (value) return value
    await sleep(250)
  }
  throw Error(`timeout:${label}`)
}
const trace = []
const proof = {
  startedAt: new Date().toISOString(),
  boundary:
    'Temporary Mini coordinator with disconnected synthetic Unix-socket client. Not native Remember app quit or real Space revision/access validation.',
  trace,
}
const save = () => writeFileSync(join(root, 'proof.json'), JSON.stringify(proof, null, 2))
let child, client
function journalState() {
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
async function start() {
  child = spawn(process.execPath, [join(source, 'coordinator.mjs'), root], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (x) => (output += x))
  child.stderr.on('data', (x) => {
    trace.push({ stderr: String(x) })
    save()
  })
  await until(() => output.includes('"ready":true'), 'coordinator ready', 10_000)
  trace.push({ coordinatorPid: child.pid })
}
async function shutdown() {
  const exited = new Promise((r) => child.once('exit', r))
  child.kill('SIGTERM')
  await exited
  if (existsSync(join(root, 'client.sock'))) unlinkSync(join(root, 'client.sock'))
}
writeFileSync(
  join(workspace, 'a.py'),
  `import pathlib,time,uuid\np=pathlib.Path('.')\np.joinpath('a-started').write_text('started')\ndeadline=time.monotonic()+90\nwhile not p.joinpath('release-a').exists():\n if time.monotonic()>deadline: raise TimeoutError('barrier')\n time.sleep(.1)\nnonce=str(uuid.uuid4())\np.joinpath('nonce.txt').write_text(nonce)\nprint(nonce)\n`
)
writeFileSync(
  join(workspace, 'b.py'),
  `import pathlib,sys\np=pathlib.Path('.')\nnonce=sys.argv[1]\nassert nonce==p.joinpath('nonce.txt').read_text()\nwith p.joinpath('effects.jsonl').open('a') as f: f.write('B '+nonce+'\\n')\nprint(p.joinpath('effects.jsonl').read_text())\n`
)
writeFileSync(
  join(workspace, 'c.py'),
  `import pathlib,sys\np=pathlib.Path('.')\nnonce=sys.argv[1]\nassert nonce==p.joinpath('nonce.txt').read_text()\nwith p.joinpath('effects.jsonl').open('a') as f: f.write('C '+nonce+'\\n')\nprint(p.joinpath('effects.jsonl').read_text())\n`
)
const spec = {
  workspace,
  model: 'gpt-6-astra',
  reviewTtlMs: 120_000,
  prompt: `Run exactly this silent synthetic fixture in the current workspace. Do no other work. Step 1: run python3 a.py and wait for it to finish. It returns a random nonce. Step 2: in a NEW separate shell tool invocation, run python3 b.py '<the literal nonce from step 1>'. Do not substitute a shell expression or combine steps: literal nonce in command args is required. Step 3: call remember_client_probe with that same nonce and WAIT for its result. Step 4: ONLY if approved=true, in a NEW shell tool invocation run python3 c.py '<the literal nonce>'. If approved=false, stop without more writes. Finally state the actual file contents. No parallel execution of these steps, no scripts edits, no other tools.`,
}
try {
  await start()
  client = await connect(join(root, 'client.sock'))
  const submitted = await client.call('submit', { jobId: 'detached-multistep', spec })
  assert.equal(submitted.created, true)
  await until(() => existsSync(join(workspace, 'a-started')), 'A started')
  const before = await client.call('snapshot')
  proof.cursorBeforeDetach = before.events.at(-1)?.seq ?? 0
  await client.close()
  client = null
  await sleep(5500)
  writeFileSync(join(workspace, 'release-a'), 'release')
  await until(() => existsSync(join(workspace, 'effects.jsonl')), 'B after detach')
  await until(
    () => journalState().events.some((e) => e.type === 'request-pending' && e.payload.method === 'fixture-source'),
    'review pending while client absent'
  )
  await sleep(10_000)
  const effectsWhileAway = readFileSync(join(workspace, 'effects.jsonl'), 'utf8')
  assert.equal(effectsWhileAway.trim().split('\n').length, 1)
  const whileAway = journalState()
  const detach = whileAway.events.find((e) => e.type === 'client-detached')
  const nonce = readFileSync(join(workspace, 'nonce.txt'), 'utf8')
  const b = whileAway.events.find(
    (e) =>
      e.type === 'worker-report' &&
      e.payload.type === 'status' &&
      e.payload.text.includes('b.py') &&
      e.payload.text.includes(nonce)
  )
  assert.ok(detach && b && detach.seq < b.seq)
  assert.ok(b.payload.monotonicMs - detach.payload.monotonicMs >= 5000)
  proof.detachedStep = {
    detachSeq: detach.seq,
    bRequestedSeq: b.seq,
    commandItemId: b.payload.id,
    elapsedMs: b.payload.monotonicMs - detach.payload.monotonicMs,
    nonce,
    effectsWhileAway,
  }
  client = await connect(join(root, 'client.sock'))
  const pending = await until(async () => {
    const x = await client.call('snapshot')
    return x.requests.find((r) => r.method === 'fixture-source') ? x : null
  }, 'pending fixture')
  const request = pending.requests.find((r) => r.method === 'fixture-source')
  assert.equal(request.payload.input.nonce, nonce)
  await assert.rejects(
    client.call('reply', {
      requestId: request.id,
      sessionId: pending.sessionId,
      sourceRevision: 'fixture-old',
      result: { approved: true },
    }),
    /revision-conflict/
  )
  assert.equal(readFileSync(join(workspace, 'effects.jsonl'), 'utf8'), effectsWhileAway)
  const staleCheck = await client.call('snapshot')
  assert.ok(staleCheck.requests.some((r) => r.id === request.id))
  assert.equal(
    journalState().events.filter(
      (e) => ['request-resolved', 'review-forwarded'].includes(e.type) && e.payload.id === request.id
    ).length,
    0
  )
  await client.call('reply', {
    requestId: request.id,
    sessionId: pending.sessionId,
    sourceRevision: 'fixture-v1',
    result: { approved: true },
  })
  await client.close()
  client = null
  await until(() => journalState().job.phase === 'completed', 'complete after second detach')
  const done = journalState()
  const result = done.events.find((e) => e.type === 'result-persisted')
  assert.ok(result)
  const approved = done.events.find((e) => e.type === 'review-forwarded' && e.payload.id === request.id)
  const c = done.events.find(
    (e) =>
      e.type === 'worker-report' &&
      e.payload.type === 'status' &&
      e.payload.text.includes('c.py') &&
      e.payload.text.includes(nonce)
  )
  assert.ok(c && approved && c.seq > approved.seq && c.payload.id !== b.payload.id)
  proof.reviewOrder = {
    requestId: request.id,
    approvedSeq: approved.seq,
    cRequestedSeq: c.seq,
    cCommandItemId: c.payload.id,
  }
  assert.equal(readFileSync(join(workspace, 'effects.jsonl'), 'utf8'), `B ${nonce}\nC ${nonce}\n`)
  const threadId = done.job.thread_id,
    turnId = done.job.turn_id
  async function turns() {
    const rpc = await connectCodexWebSocket('ws://127.0.0.1:47831/', { onNotification() {}, onClose() {} })
    try {
      await initializeCodexServer(rpc, 'e06-readback')
      return remoteTurns(await readRemoteThread(rpc, threadId)).map((t) => ({ id: t.id, status: t.status }))
    } finally {
      rpc.close()
    }
  }
  const baselineTurns = await turns()
  assert.deepEqual(baselineTurns, [{ id: turnId, status: 'completed' }])
  proof.initialResult = { threadId, turnId, resultSeq: result.seq, result: result.payload.result, turns: baselineTurns }
  for (let i = 1; i <= 2; i++) {
    await shutdown()
    await start()
    client = await connect(join(root, 'client.sock'))
    const snapshot = await client.call('snapshot', { afterSeq: proof.cursorBeforeDetach })
    assert.equal(snapshot.job.phase, 'completed')
    assert.equal(snapshot.job.turnId, turnId)
    const replayEvents = [...snapshot.events]
    while (replayEvents.length && replayEvents.length % 100 === 0) {
      const page = await client.call('snapshot', { afterSeq: replayEvents.at(-1).seq })
      replayEvents.push(...page.events)
      if (page.events.length < 100) break
    }
    const replayResults = replayEvents.filter((e) => e.type === 'result-persisted')
    assert.equal(replayResults.length, 1)
    assert.deepEqual(replayResults[0].payload, result.payload)
    const replay = await client.call('submit', { jobId: 'detached-multistep', spec })
    assert.equal(replay.created, false)
    await assert.rejects(
      client.call('submit', { jobId: 'detached-multistep', spec: { ...spec, prompt: `${spec.prompt} changed` } }),
      /input-conflict/
    )
    assert.equal(journalState().events.filter((e) => e.type === 'driver-invoked').length, 1)
    assert.deepEqual(await turns(), baselineTurns)
    assert.equal(readFileSync(join(workspace, 'effects.jsonl'), 'utf8'), `B ${nonce}\nC ${nonce}\n`)
    trace.push({ restart: i, resultSeenFromCursor: replayResults.length === 1, sameTurn: true, effectLines: 2 })
    await client.close()
    client = null
  }
  proof.status = 'passed'
  proof.finishedAt = new Date().toISOString()
  save()
  await shutdown()
  console.log(JSON.stringify(proof))
} catch (error) {
  proof.status = 'failed'
  proof.error = String(error.stack)
  save()
  console.error(error)
  if (client) await client.close().catch(() => {})
  // Keep uncertain coordinator alive for an explicit scoped Stop; do not kill the provider.
  if (child) child.unref()
  process.exitCode = 1
}
