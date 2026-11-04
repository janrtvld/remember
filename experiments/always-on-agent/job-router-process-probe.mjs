import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(import.meta.url)
const repository = fileURLToPath(new URL('../../', import.meta.url))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let rpcId = 0

async function rpc(path, op, payload = {}) {
  const socket = createConnection(path)
  socket.setEncoding('utf8')
  try {
    await once(socket, 'connect')
    return await new Promise((resolve, reject) => {
      let text = ''
      const timer = setTimeout(() => finish(reject, Error('probe-rpc-timeout')), 5000)
      const finish = (callback, value) => {
        clearTimeout(timer)
        callback(value)
      }
      socket.once('error', (error) => finish(reject, error))
      socket.once('close', () => finish(reject, Error('probe-rpc-closed')))
      socket.on('data', (data) => {
        text += data
        if (!text.includes('\n')) return
        const value = JSON.parse(text.slice(0, text.indexOf('\n')))
        finish(value.error ? reject : resolve, value.error ? Error(value.error) : value.result)
      })
      socket.write(`${JSON.stringify({ id: ++rpcId, op, ...payload })}\n`)
    })
  } finally {
    socket.destroy()
  }
}

async function childCoordinator(directory) {
  const { createCoordinator } = await import(`${repository}/experiments/always-on-agent/coordinator.mjs`)
  const log = (value) =>
    appendFileSync(
      join(directory, 'fake-provider.jsonl'),
      `${JSON.stringify({ ...value, pid: process.pid, at: Date.now() })}\n`
    )
  const coordinator = await createCoordinator({
    directory,
    nativeClient: true,
    driver: {
      async runCodexWorker(input) {
        log({ type: 'invocation', prompt: input.prompt })
        const threadId = `thread-${input.prompt}`
        const turnId = `turn-${input.prompt}`
        input.onThread(threadId)
        input.onCheckpoint({ computer: input.remote, threadId, turnId: null, previousTurnId: null })
        input.onCheckpoint({ computer: input.remote, threadId, turnId, previousTurnId: null })
        if (input.prompt.startsWith('complete-')) {
          input.onCheckpoint(null)
          log({ type: 'result', response: `Result ${input.prompt}` })
          return { response: `Result ${input.prompt}`, threadId }
        }
        const cancelled = new Promise((_, reject) =>
          input.signal.addEventListener(
            'abort',
            () => {
              log({ type: 'abort' })
              input.onCheckpoint(null)
              reject(Error('agent-cancelled'))
            },
            { once: true }
          )
        )
        const requested = input.ask(
          {
            title: `Review ${input.prompt}`,
            fields: [],
            actions: [
              { id: 'accept', label: 'Accept' },
              { id: 'decline', label: 'Decline' },
            ],
          },
          input.signal
        )
        const answer = await Promise.race([requested, cancelled])
        log({ type: 'review-answer', answer })
        input.onCheckpoint(null)
        return { response: `Reviewed ${input.prompt}`, threadId }
      },
      async stopCodexRemoteCheckpoint(checkpoint) {
        log({ type: 'recovery-stop', checkpoint })
      },
    },
  })
  process.send({ ready: true, pid: process.pid, socketPath: coordinator.socketPath })
  process.on('message', async (message) => {
    if (message.op !== 'close') return
    try {
      await coordinator.close()
      process.send({ closed: true })
      process.exit(0)
    } catch (error) {
      process.send({ closeError: error.message })
    }
  })
}

async function childRouter(directory) {
  const { openJobRouter } = await import(`${repository}/experiments/always-on-agent/job-router.mjs`)
  let fault = null
  const router = openJobRouter({
    directory,
    connectChild: async (descriptor) => {
      return {
        async request(op, payload) {
          if (op === 'submit' && fault?.jobId === descriptor.assignment.jobId && fault.stage === 'before-dispatch') {
            appendFileSync(
              join(directory, 'crashes.jsonl'),
              `${JSON.stringify({ ...fault, pid: process.pid, at: Date.now() })}\n`
            )
            process.exit(71)
          }
          const result = await rpc(join(descriptor.directory, 'client.sock'), op, payload)
          if (op === 'submit' && fault?.jobId === descriptor.assignment.jobId && fault.stage === 'after-submit-ack') {
            appendFileSync(
              join(directory, 'crashes.jsonl'),
              `${JSON.stringify({ ...fault, result, pid: process.pid, at: Date.now() })}\n`
            )
            process.exit(72)
          }
          return result
        },
        async close() {},
      }
    },
  })
  process.send({ ready: true, pid: process.pid })
  process.on('message', async (message) => {
    if (message.op === 'close') {
      await router.close()
      process.exit(0)
    }
    if (message.op === 'fault') {
      fault = message.value
      process.send({ id: message.id, result: true })
      return
    }
    try {
      process.send({ id: message.id, result: await router.request(JSON.stringify(message.request)) })
    } catch (error) {
      process.send({ id: message.id, error: error.message })
    }
  })
}

async function main() {
  const root = mkdtempSync('/private/tmp/e071-process-')
  const children = []
  const proof = {
    root,
    pid: process.pid,
    boundary:
      'Actual separate local router/coordinator processes, existing single-job protocol, fake providers and opaque Task IDs only. No native Remember, Mini, model, cloud or actual Task authority.',
    status: 'running',
    events: [],
    descriptors: [],
    checks: [],
  }
  const save = () => writeFileSync(join(root, 'report.json'), JSON.stringify(proof, null, 2))
  const record = (type, value) => {
    proof.events.push({ type, value, at: Date.now() })
    save()
  }
  const check = (name, value) => {
    assert(value, name)
    proof.checks.push(name)
  }
  let next = 0
  const spawn = async (kind, directory) => {
    const processChild = fork(here, [kind, directory], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    const item = { process: processChild, kind, directory, pid: processChild.pid, exited: false }
    children.push(item)
    processChild.stdout.on('data', (data) => appendFileSync(join(root, `process-${item.pid}.log`), data))
    processChild.stderr.on('data', (data) => appendFileSync(join(root, `process-${item.pid}.log`), data))
    processChild.on('exit', (code, signal) => {
      item.exited = true
      record('process-exit', { pid: item.pid, code, signal })
    })
    await Promise.race([
      once(processChild, 'message').then(([message]) => {
        assert(message.ready)
        record('process-ready', { kind, directory, ...message })
      }),
      once(processChild, 'exit').then(() => {
        throw Error('probe-child-exited-before-ready')
      }),
      delay(5000).then(() => {
        throw Error('probe-child-ready-timeout')
      }),
    ])
    return item
  }
  const call = (item, request, op = 'request') =>
    new Promise((resolve, reject) => {
      const id = ++next
      const timer = setTimeout(() => finish(reject, Error('probe-router-timeout')), 8000)
      const onExit = () => finish(reject, Error('probe-router-exited'))
      const onMessage = (message) => {
        if (message.id === id)
          finish(message.error ? reject : resolve, message.error ? Error(message.error) : message.result)
      }
      const finish = (callback, result) => {
        clearTimeout(timer)
        item.process.off('message', onMessage)
        item.process.off('exit', onExit)
        callback(result)
      }
      item.process.on('message', onMessage)
      item.process.once('exit', onExit)
      item.process.send(op === 'fault' ? { id, op, value: request } : { id, op, request })
    })
  const assignment = (suffix) => ({
    jobId: `job-${suffix}`,
    messageId: `message-${suffix}`,
    workItemId: `task-${suffix}`,
    sessionId: `task-session-${suffix}`,
  })
  const input = (prompt) => ({
    prompt,
    model: 'fake-model',
    systemPrompt: 'Synthetic process probe only',
    effort: 'low',
    threadId: null,
    reviewTtlMs: 300000,
    tools: [],
  })
  const register = async (router, suffix, prompt) => {
    const result = await call(router, { op: 'register', assignment: assignment(suffix), input: input(prompt) })
    const descriptor = result.descriptor ?? result
    proof.descriptors.push(descriptor)
    save()
    await spawn('--coordinator-child', descriptor.directory)
    return descriptor.assignment
  }
  const waitFor = async (router, assigned, predicate) => {
    for (let n = 0; n < 100; n++) {
      const result = await call(router, { op: 'snapshot', assignment: assigned })
      if (predicate(result)) return result
      await delay(20)
    }
    throw Error('probe-snapshot-timeout')
  }
  const verifyCrash = (directory, child, stage, code, assigned) => {
    const exit = proof.events.find((event) => event.type === 'process-exit' && event.value.pid === child.pid)
    assert.equal(exit?.value.code, code)
    const markers = readFileSync(join(directory, 'crashes.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    const marker = markers.find((entry) => entry.pid === child.pid)
    assert.equal(marker?.stage, stage)
    assert.equal(marker?.jobId, assigned.jobId)
    const database = new DatabaseSync(join(directory, 'registry.sqlite'), { readOnly: true })
    try {
      const row = database.prepare('SELECT * FROM router_job WHERE job_id=?').get(assigned.jobId)
      assert.equal(row.dispatch_state, 'dispatch-intent')
      assert.deepEqual(JSON.parse(row.assignment_json), assigned)
      record('durable-intent-before-router-restart', { stage, exit: exit.value, marker, row })
    } finally {
      database.close()
    }
  }
  let router, crashRouter
  try {
    const directory = join(root, 'registry')
    mkdirSync(directory)
    router = await spawn('--router-child', directory)
    const a = await register(router, 'a', 'review-a')
    await call(router, { op: 'submit', assignment: a })
    const waitingA = await waitFor(router, a, (r) => r.snapshot.requests.length === 1)
    const reviewA = waitingA.snapshot.requests[0]
    record('review-a', reviewA)
    await call(router, {
      op: 'reply',
      assignment: a,
      requestId: reviewA.id,
      sessionId: reviewA.sessionId,
      result: { action: 'accept', values: {} },
    })
    const finalA = await waitFor(router, a, (r) => r.state === 'completed')
    check('A result exact', finalA.snapshot.result.response === 'Reviewed review-a')
    const b = await register(router, 'b', 'review-b')
    await call(router, { jobId: b.jobId, stage: 'after-submit-ack' }, 'fault')
    await assert.rejects(call(router, { op: 'submit', assignment: b }), /router-exited/)
    verifyCrash(directory, router, 'after-submit-ack', 72, b)
    router = await spawn('--router-child', directory)
    const waitingB = await waitFor(router, b, (r) => r.snapshot.requests.length === 1)
    check('B waiting after real router exit', waitingB.state === 'waiting')
    const repeatedB = await call(router, { op: 'submit', assignment: b })
    check('Lost ACK does not replace B', repeatedB.snapshot.job.id === b.jobId)
    const oldA = await call(router, { op: 'stop', assignment: a })
    check('Historical Stop A stays completed', oldA.state === 'completed')
    const sameB = await call(router, { op: 'snapshot', assignment: b })
    check('Historical Stop did not stop B', sameB.state === 'waiting')
    const request = sameB.snapshot.requests[0]
    await assert.rejects(
      call(router, {
        op: 'reply',
        assignment: b,
        requestId: reviewA.id,
        sessionId: reviewA.sessionId,
        result: { action: 'accept', values: {} },
      })
    )
    await assert.rejects(
      call(router, {
        op: 'reply',
        assignment: a,
        requestId: request.id,
        sessionId: request.sessionId,
        result: { action: 'accept', values: {} },
      })
    )
    const unchanged = await call(router, { op: 'snapshot', assignment: b })
    check('Cross-job review did not resolve B', unchanged.snapshot.requests[0].id === request.id)
    const stoppedB = await call(router, { op: 'stop', assignment: b })
    check('Exact B Stop terminal', stoppedB.state === 'stopped')
    const c = await register(router, 'c', 'complete-c')
    await call(router, { op: 'submit', assignment: c })
    const finalC = await waitFor(router, c, (r) => r.state === 'completed')
    check('Stopped B allows explicit C', finalC.snapshot.result.response === 'Result complete-c')
    router.process.send({ op: 'close' })
    await once(router.process, 'exit')
    router = await spawn('--router-child', directory)
    for (const [assigned, state] of [
      [a, 'completed'],
      [b, 'stopped'],
      [c, 'completed'],
    ]) {
      const result = await call(router, { op: 'snapshot', assignment: assigned })
      check(`History ${assigned.jobId} survives another process restart`, result.state === state)
      const expected = proof.descriptors.find((entry) => entry.assignment.jobId === assigned.jobId)
      assert.deepEqual(result.descriptor, expected)
      assert.equal(result.snapshot.job.id, assigned.jobId)
      assert.equal(result.snapshot.job.inputHash, expected.inputHash)
      assert.equal(result.snapshot.job.spec.workspace, expected.workspace)
      if (assigned.jobId === a.jobId) assert.equal(result.snapshot.result.response, 'Reviewed review-a')
      if (assigned.jobId === c.jobId) assert.equal(result.snapshot.result.response, 'Result complete-c')
      record('final-snapshot', result)
    }
    const cutDirectory = join(root, 'cut-registry')
    mkdirSync(cutDirectory)
    crashRouter = await spawn('--router-child', cutDirectory)
    const cut = await register(crashRouter, 'cut', 'complete-cut')
    await call(crashRouter, { jobId: cut.jobId, stage: 'before-dispatch' }, 'fault')
    await assert.rejects(call(crashRouter, { op: 'submit', assignment: cut }), /router-exited/)
    verifyCrash(cutDirectory, crashRouter, 'before-dispatch', 71, cut)
    crashRouter = await spawn('--router-child', cutDirectory)
    const uncertain = await call(crashRouter, { op: 'submit', assignment: cut })
    check(
      'Empty child after dispatch intent remains uncertain',
      uncertain.state === 'recovery-required' && uncertain.snapshot.job === null
    )
    await assert.rejects(
      call(crashRouter, { op: 'register', assignment: assignment('blocked'), input: input('complete-blocked') })
    )
    record('uncertain-cut', uncertain)
    proof.status = 'passed'
  } catch (error) {
    proof.status = 'failed'
    proof.error = error.stack
  } finally {
    for (const descriptor of proof.descriptors) {
      try {
        const state = await rpc(join(descriptor.directory, 'client.sock'), 'snapshot')
        if (state.job && !['completed', 'stopped', 'recovery-required'].includes(state.job.phase))
          await rpc(join(descriptor.directory, 'client.sock'), 'stop')
      } catch (error) {
        record('cleanup-read-error', { directory: descriptor.directory, error: error.message })
      }
    }
    proof.cleanupErrors = []
    for (const child of children.filter((child) => !child.exited)) {
      try {
        if (child.process.connected)
          child.process.send({ op: 'close' }, (error) => {
            if (error) record('cleanup-ipc-error', { pid: child.pid, error: error.message })
          })
        for (let n = 0; n < 30 && !child.exited; n++) await delay(100)
        if (!child.exited) {
          child.process.kill('SIGTERM')
          for (let n = 0; n < 20 && !child.exited; n++) await delay(100)
        }
        if (!child.exited) {
          child.process.kill('SIGKILL')
          for (let n = 0; n < 20 && !child.exited; n++) await delay(100)
        }
        if (!child.exited) proof.cleanupErrors.push({ pid: child.pid, error: 'owned-child-did-not-exit' })
      } catch (error) {
        proof.cleanupErrors.push({ pid: child.pid, error: error.message })
      }
    }
    proof.processes = children.map(({ kind, directory, pid, exited }) => ({ kind, directory, pid, exited }))
    proof.providerLogs = proof.descriptors.map((descriptor) => {
      try {
        return {
          jobId: descriptor.assignment.jobId,
          entries: readFileSync(join(descriptor.directory, 'fake-provider.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map(JSON.parse),
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          proof.status = 'failed'
          proof.cleanupErrors.push({ jobId: descriptor.assignment.jobId, error: error.message })
        }
        return { jobId: descriptor.assignment.jobId, entries: [], missing: error.code === 'ENOENT' }
      }
    })
    if (proof.status === 'passed') {
      try {
        for (const record of proof.providerLogs)
          assert.equal(record.entries.filter((v) => v.type === 'invocation').length, record.jobId === 'job-cut' ? 0 : 1)
        const aLog = proof.providerLogs.find((entry) => entry.jobId === 'job-a').entries
        const bLog = proof.providerLogs.find((entry) => entry.jobId === 'job-b').entries
        assert.equal(aLog.filter((entry) => entry.type === 'review-answer').length, 1)
        assert.deepEqual(aLog.find((entry) => entry.type === 'review-answer').answer, { action: 'accept', values: {} })
        assert.equal(aLog.filter((entry) => entry.type === 'abort' || entry.type === 'recovery-stop').length, 0)
        assert.equal(bLog.filter((entry) => entry.type === 'review-answer').length, 0)
        assert.equal(bLog.filter((entry) => entry.type === 'abort').length, 1)
        assert(proof.processes.every((p) => p.exited))
        assert.equal(proof.cleanupErrors.length, 0)
      } catch (error) {
        proof.status = 'failed'
        proof.error = error.stack
      }
    }
    save()
    process.stdout.write(`${JSON.stringify({ status: proof.status, report: join(root, 'report.json') })}\n`)
  }
  if (proof.status !== 'passed') process.exitCode = 1
}

if (process.argv[2] === '--coordinator-child') await childCoordinator(resolve(process.argv[3]))
else if (process.argv[2] === '--router-child') await childRouter(resolve(process.argv[3]))
else if (process.argv[2] === '--run' && process.argv.length === 3) await main()
else throw Error('Use --run for this isolated local fake-provider experiment')
