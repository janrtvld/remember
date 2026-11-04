import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, realpathSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openJournal } from './journal.mjs'

// Experimental, single job, local Unix socket. Client detach never owns cancellation.
export async function createCoordinator({ directory, driver, nativeClient = false }) {
  directory = realpathSync(directory)
  chmodSync(directory, 0o700)
  const socketPath = join(directory, 'client.sock')
  let journal
  let worker = null
  let workerActive = false
  let controller = null
  let checkpoint = null
  let checkpointCleared = false
  let stopping = null
  let closing = false
  let acceptedConnections = 0
  const liveRequests = new Map()
  const clients = new Set()
  const elapsed = () => Number(process.hrtime.bigint() / 1_000_000n)
  const event = (type, payload = {}) => journal.appendEvent(type, { ...payload, monotonicMs: elapsed() })
  const server = createServer((socket) => {
    if (closing || clients.size >= 4 || !journal) {
      socket.destroy()
      return
    }
    clients.add(socket)
    const clientId = ++acceptedConnections
    event('client-attached', { clientId })
    let buffer = ''
    let busy = false
    socket.setEncoding('utf8')
    socket.on('error', () => {})
    socket.on('close', () => {
      clients.delete(socket)
      if (!closing) event('client-detached', { clientId })
    })
    socket.on('data', (chunk) => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > 70_000) {
        socket.destroy()
        return
      }
      if (!buffer.includes('\n')) return
      const lines = buffer.split('\n')
      buffer = lines.pop()
      if (lines.length !== 1 || busy) {
        socket.destroy()
        return
      }
      busy = true
      let request
      try {
        request = JSON.parse(lines[0])
      } catch {
        socket.destroy()
        return
      }
      if (!request || Array.isArray(request) || typeof request !== 'object' || !Number.isSafeInteger(request.id)) {
        socket.destroy()
        return
      }
      Promise.resolve()
        .then(() => handle(request))
        .then(
          (result) => {
            if (!socket.destroyed) socket.write(`${JSON.stringify({ id: request.id, result })}\n`)
          },
          (error) => {
            if (!socket.destroyed)
              socket.write(`${JSON.stringify({ id: request.id, error: String(error.message).slice(0, 200) })}\n`)
          }
        )
        .finally(() => {
          busy = false
        })
    })
  })
  // Do not unlink a socket: an existing coordinator must not be fenced accidentally.
  await new Promise((accept, reject) => {
    server.once('error', reject)
    server.listen(socketPath, accept)
  })
  chmodSync(socketPath, 0o600)
  try {
    journal = openJournal(join(directory, 'job.sqlite'))
  } catch (error) {
    server.close()
    throw error
  }
  event('coordinator-started', { pid: process.pid, sessionId: journal.sessionId })

  function allEvents() {
    const result = []
    for (;;) {
      const page = journal.events({ afterSeq: result.at(-1)?.seq ?? 0 })
      result.push(...page)
      if (page.length < 100) return result
    }
  }
  checkpoint =
    allEvents()
      .filter((entry) => entry.type === 'checkpoint' && entry.payload.checkpoint)
      .at(-1)?.payload.checkpoint ?? null

  function jobSnapshot() {
    const job = journal.getJob()
    return job && journal.latestEvent('review-expiry') ? { ...job, stopReason: 'request-expired' } : job
  }

  function waitForReview(method, payload, signal) {
    const id = randomUUID()
    const expiresAt = Date.now() + (journal.getJob().spec.reviewTtlMs ?? 120_000)
    const record = journal.putRequest({
      id,
      method,
      payload: { ...payload, expiresAt, ...(nativeClient ? {} : { sourceRevision: 'fixture-v1' }) },
    })
    return new Promise((accept, reject) => {
      const finish = (result, error) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        liveRequests.delete(id)
        if (error) reject(error)
        else accept(result)
      }
      const abort = () => {
        let failure = new Error('review-expired')
        try {
          journal.expireRequest({ id, sessionId: journal.sessionId, reason: 'upstream-request-resolved-or-cancelled' })
        } catch (error) {
          failure = error
        }
        finish(null, failure)
        if (failure.message !== 'review-expired') controller?.abort()
      }
      let timer
      const expire = () => {
        const remaining = expiresAt - Date.now()
        if (remaining > 0) {
          timer = setTimeout(expire, remaining)
          return
        }
        event('review-expiry', { id })
        void stop().catch(() => {})
      }
      timer = setTimeout(expire, Math.max(0, expiresAt - Date.now()))
      liveRequests.set(id, { record, expiresAt, finish })
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }

  async function execute(spec) {
    workerActive = true
    controller = new AbortController()
    const computer = { kind: 'remote', endpoint: 'ws://127.0.0.1:47831/', workspace: spec.workspace }
    event('driver-invoked')
    try {
      const result = await driver.runCodexWorker({
        cwd: spec.workspace,
        version: 'e06-experiment',
        model: spec.model,
        effort: spec.effort ?? 'low',
        threadId: spec.threadId ?? null,
        prompt: spec.prompt,
        systemPrompt:
          spec.systemPrompt ??
          'Run only the explicit synthetic test in the supplied workspace. Do not access accounts, network, other directories, audio, screen, browser, or other users. No extra tasks. Client absence is not permission for a client-only operation. Follow the numbered steps exactly and use a separate command call for each numbered shell step.',
        signal: controller.signal,
        remote: computer,
        report(type, id, text) {
          event('worker-report', { type, id, text: text.slice(0, 10_000) })
        },
        onUsage(usage) {
          event('usage', { usage })
        },
        onThread(threadId) {
          journal.transition({ phase: 'thread-bound', threadId })
        },
        onCheckpoint(value) {
          event('checkpoint', { checkpoint: value })
          if (!value) {
            checkpointCleared = true
            return
          }
          checkpoint = value
          checkpointCleared = false
          const job = journal.getJob()
          if (value.turnId && ['turn-start-intent', 'running'].includes(job.phase))
            journal.transition({ phase: 'running', turnId: value.turnId })
          else if (!value.turnId && job.phase === 'thread-bound') journal.transition({ phase: 'turn-start-intent' })
        },
        ask(request, signal) {
          return waitForReview('provider-approval', { request }, signal)
        },
        tools: nativeClient
          ? (spec.tools ?? []).map((tool) => ({
              ...tool,
              async call(input, context) {
                const reply = await waitForReview(
                  'client-tool',
                  {
                    tool: tool.name,
                    input,
                    threadId: context.threadId,
                    turnId: context.turnId,
                    callId: context.callId,
                  },
                  context.signal
                )
                if (!reply.success) throw new Error(reply.error ?? 'client-tool-failed')
                return reply.output
              },
            }))
          : [
              {
                name: 'remember_client_probe',
                description:
                  'Synthetic client-only source review. Call exactly when requested. Wait for a connected client; approved=false means stop without further writes.',
                inputSchema: {
                  type: 'object',
                  properties: { nonce: { type: 'string' } },
                  required: ['nonce'],
                  additionalProperties: false,
                },
                async call(input, context) {
                  if (
                    !input ||
                    typeof input.nonce !== 'string' ||
                    input.nonce.length > 128 ||
                    Object.keys(input).length !== 1
                  )
                    throw new Error('invalid-probe-input')
                  return waitForReview(
                    'fixture-source',
                    { input, threadId: context.threadId, turnId: context.turnId, callId: context.callId },
                    context.signal
                  )
                },
              },
            ],
      })
      event('result-persisted', { result })
      journal.transition({ phase: 'completed' })
    } catch (error) {
      event('worker-ended', { error: String(error.message).slice(0, 1000), checkpointCleared })
      const confirmedStop = controller.signal.aborted && checkpointCleared && error.message === 'agent-cancelled'
      journal.transition({ phase: confirmedStop ? 'stopped' : 'recovery-required' })
    } finally {
      workerActive = false
      for (const request of liveRequests.values()) request.finish(null, new Error('worker-ended'))
    }
  }

  async function stop() {
    if (stopping) return stopping
    stopping = (async () => {
      const job = journal.getJob()
      if (!job) throw new Error('job-missing')
      if (['completed', 'stopped'].includes(job.phase)) return jobSnapshot()
      event('stop-requested')
      if (workerActive && worker && controller) {
        controller.abort()
        await worker
      }
      if (['stopped', 'completed'].includes(journal.getJob().phase)) return jobSnapshot()
      if (checkpoint) {
        if (!checkpoint.turnId) throw new Error('stop-unconfirmed-start-acceptance')
        await driver.stopCodexRemoteCheckpoint(checkpoint, 'e06-experiment')
        event('stop-confirmed', { threadId: checkpoint.threadId, turnId: checkpoint.turnId })
        journal.transition({ phase: 'stopped' })
      } else throw new Error('stop-unconfirmed-no-checkpoint')
      if (!['stopped', 'completed'].includes(journal.getJob().phase)) throw new Error('stop-unconfirmed')
      return jobSnapshot()
    })()
    try {
      return await stopping
    } finally {
      stopping = null
    }
  }

  async function handle(message) {
    if (!message || !Number.isSafeInteger(message.id)) throw new Error('invalid-message')
    if (message.op === 'hello')
      return {
        protocol: 'remember-host-job-v1',
        singleJob: true,
        nativeClient,
        jobId: journal.getJob()?.id ?? null,
        workspace: join(directory, 'workspace'),
        sessionId: journal.sessionId,
      }
    if (message.op === 'snapshot')
      return {
        sessionId: journal.sessionId,
        job: jobSnapshot(),
        requests: journal.pendingRequests(),
        events: journal.events({ afterSeq: message.afterSeq ?? 0 }),
        result:
          journal.getJob()?.phase === 'completed'
            ? (journal.latestEvent('result-persisted')?.payload.result ?? null)
            : null,
        pid: process.pid,
      }
    if (message.op === 'submit') {
      const spec = message.spec
      if (
        !spec ||
        typeof spec.prompt !== 'string' ||
        spec.prompt.length > 30_000 ||
        typeof spec.model !== 'string' ||
        !/^[a-z0-9.-]{1,80}$/.test(spec.model) ||
        spec.workspace !== join(directory, 'workspace') ||
        (spec.reviewTtlMs !== undefined &&
          (!Number.isInteger(spec.reviewTtlMs) || spec.reviewTtlMs < 5_000 || spec.reviewTtlMs > 300_000))
      )
        throw new Error('invalid-spec')
      if (nativeClient) {
        if (
          typeof spec.systemPrompt !== 'string' ||
          spec.systemPrompt.length > 20_000 ||
          !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(spec.effort) ||
          (spec.threadId !== null && (typeof spec.threadId !== 'string' || spec.threadId.length > 200)) ||
          !Array.isArray(spec.tools) ||
          spec.tools.length > 1 ||
          spec.tools.some(
            (tool) =>
              tool?.name !== 'remember_memory' ||
              typeof tool.description !== 'string' ||
              tool.description.length > 4000 ||
              !tool.inputSchema ||
              typeof tool.inputSchema !== 'object'
          )
        )
          throw new Error('invalid-native-spec')
      } else if (spec.systemPrompt || spec.tools || spec.threadId || spec.effort) throw new Error('fixture-only')
      const outcome = journal.submit({ id: message.jobId, spec })
      if (outcome.created) {
        mkdirSync(spec.workspace, { recursive: true, mode: 0o700 })
        worker = execute(spec)
      }
      return outcome
    }
    if (message.op === 'reply') {
      const current = liveRequests.get(message.requestId)
      if (!current || message.sessionId !== journal.sessionId || current.expiresAt <= Date.now())
        throw new Error('review-expired')
      if (nativeClient) {
        if (current.record.method === 'client-tool') {
          if (
            !message.result ||
            typeof message.result.success !== 'boolean' ||
            (message.result.success
              ? !Object.hasOwn(message.result, 'output')
              : typeof message.result.error !== 'string')
          )
            throw new Error('invalid-client-tool-result')
        } else if (current.record.method === 'provider-approval') {
          const actions = current.record.payload.request?.actions
          if (
            !message.result ||
            !Array.isArray(actions) ||
            !actions.some((action) => action.id === message.result.action) ||
            !message.result.values ||
            typeof message.result.values !== 'object' ||
            Array.isArray(message.result.values) ||
            Object.values(message.result.values).some((value) => typeof value !== 'string' || value.length > 10_000)
          )
            throw new Error('invalid-provider-review')
        } else throw new Error('unsupported-native-request')
        const saved = journal.resolveRequest({
          id: message.requestId,
          sessionId: message.sessionId,
          result: message.result,
        })
        current.finish(message.result)
        event('review-forwarded', { id: saved.id })
        return saved
      }
      if (message.sourceRevision !== current.record.payload.sourceRevision) throw new Error('review-revision-conflict')
      if (current.record.method !== 'fixture-source') throw new Error('provider-approval-requires-native-review')
      if (!message.result || typeof message.result.approved !== 'boolean' || Object.keys(message.result).length !== 1)
        throw new Error('invalid-fixture-review')
      const saved = journal.resolveRequest({
        id: message.requestId,
        sessionId: message.sessionId,
        result: message.result,
      })
      current.finish(message.result)
      event('review-forwarded', { id: saved.id })
      return saved
    }
    if (message.op === 'stop') return stop()
    throw new Error('unsupported-operation')
  }

  return {
    socketPath,
    async close() {
      if (worker && !['completed', 'stopped', 'recovery-required'].includes(journal.getJob()?.phase))
        throw new Error('active-coordinator-cannot-close')
      closing = true
      for (const socket of clients) socket.destroy()
      await new Promise((accept) => server.close(accept))
      journal.close()
    },
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2]
  if (!directory) throw new Error('directory-required')
  const driver = await import('./driver.mjs')
  const coordinator = await createCoordinator({
    directory,
    driver,
    nativeClient: process.argv.includes('--native-client'),
  })
  process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid, socket: coordinator.socketPath })}\n`)
  process.on('SIGTERM', () => {
    void coordinator.close().then(
      () => process.exit(0),
      () => process.exit(1)
    )
  })
}
