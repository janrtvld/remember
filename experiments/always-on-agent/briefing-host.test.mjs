import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { createBriefingHost } from './briefing-host.mjs'
import { hashBriefingText, hashBriefingValue, validateBriefingObservation } from './briefing-protocol.mjs'

const packet = {
  sources: [
    { sourceId: 's1', revision: hashBriefingText('Atlas total 18%. Limit 10%.'), text: 'Atlas total 18%. Limit 10%.' },
  ],
}
const line = (text) => ({ text, quotes: [{ sourceId: 's1', quote: 'Atlas total 18%.' }] })
const output = JSON.stringify({
  version: 1,
  kind: 'private-briefing',
  reason: line('Prepare decision.'),
  briefing: {
    title: 'Atlas',
    decision: line('Wait for evidence.'),
    facts: [line('18% total.'), line('10% boundary.')],
    openPoints: [line('Missing mobile view.')],
    questions: [line('Owner?'), line('Threshold?'), line('Next step?')],
  },
})
async function setup(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'brief-host-')).replace(/^\/var\//, '/private/var/')
  const jobId = randomUUID(),
    directory = join(root, 'jobs', hashBriefingText(jobId).slice(0, 24)),
    workspace = join(directory, 'workspace')
  mkdirSync(workspace, { recursive: true, mode: 0o700 })
  const spec = {
    version: 1,
    preparedInput: {
      prompt: JSON.stringify(packet),
      systemPrompt: 'Make briefing',
      model: 'gpt-5.6-luna',
      effort: 'low',
      threadId: null,
      tools: [],
      maxInputBytes: 49152,
      maxOutputBytes: 16384,
      maxDurationMs: 120000,
    },
    sourcePacketHash: hashBriefingValue(packet),
    deadlineAt: 1,
    outputBasename: 'briefing.md',
    workspace,
  }
  const descriptor = {
    version: 1,
    actionId: randomUUID(),
    jobId,
    assistantMessageId: randomUUID(),
    targetId: 'mini',
    targetEpoch: 'epoch1',
    root,
    directory,
    workspace,
    inputHash: hashBriefingValue(spec),
    authorityHash: hashBriefingText('grant'),
  }
  let invocations = 0,
    mono = 100
  const execution = {
    invocationId: randomUUID(),
    pid: 12345,
    providerThreadId: 'fixture-thread',
    exit: { code: 0, signal: null, at: 100 },
  }
  const executor = options.executor ?? {
    async run(_spec, { onExecution }) {
      invocations++
      onExecution(execution)
      return { rawOutput: output, execution }
    },
  }
  const host = createBriefingHost({ descriptor, executor, monotonic: () => mono, ...options.host })
  const binding = { actionId: descriptor.actionId, jobId, inputHash: descriptor.inputHash }
  const snapshot = () => host.request('snapshot', { ...binding, afterSeq: 0 })
  const submit = () => host.request('submit', { descriptor, spec })
  const wait = async (phase) => {
    for (let i = 0; i < 100; i++) {
      const s = await snapshot()
      if (s.phase === phase) return s
      await new Promise((r) => setTimeout(r, 2))
    }
    throw new Error('phase-timeout:' + phase)
  }
  const authorize = async (patch) => {
    const s = await snapshot()
    return host.request('authorize-write', {
      ...binding,
      authorityHash: descriptor.authorityHash,
      sessionId: s.sessionId,
      requestId: s.permission?.requestId,
      nonce: s.permission?.nonce,
      contentHash: s.permission?.contentHash,
      decision: 'allow',
      ...patch,
    })
  }
  return {
    root,
    directory,
    workspace,
    spec,
    descriptor,
    binding,
    host,
    execution,
    snapshot,
    submit,
    wait,
    authorize,
    advance: (n) => {
      mono += n
    },
    count: () => invocations,
    close: async () => {
      await host.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}
test('exact submit ACK and duplicate launch once, one fixed write/readback/completed', async () => {
  const f = await setup()
  try {
    await f.submit()
    await f.wait('awaiting-write-permission')
    await f.submit()
    assert.equal(f.count(), 1)
    await f.authorize()
    const s = await f.wait('completed')
    validateBriefingObservation(s, f.descriptor)
    const r = await f.host.request('read-result', { ...f.binding, resultId: s.receipt.resultId })
    assert.match(r.content, /Atlas/)
    assert.equal(statSync(join(f.workspace, 'briefing.md')).mode & 0o777, 0o600)
    const time = s.updatedAt
    await f.host.request('stop', f.binding)
    assert.equal((await f.snapshot()).updatedAt, time)
  } finally {
    await f.close()
  }
})
test('wrong binding/hash/path and unknown operation reject before invocation', async () => {
  const f = await setup()
  try {
    for (const descriptor of [
      { ...f.descriptor, actionId: 'other' },
      { ...f.descriptor, inputHash: hashBriefingText('x') },
      { ...f.descriptor, workspace: '/tmp/else' },
    ])
      await assert.rejects(f.host.request('submit', { descriptor, spec: f.spec }), /briefing-/)
    await assert.rejects(f.host.request('write-file', { path: '/tmp/else' }), /briefing-/)
    assert.equal(f.count(), 0)
  } finally {
    await f.close()
  }
})
test('lease wrong nonce/session and expiry cannot restart deadline', async () => {
  const f = await setup()
  try {
    await f.submit()
    await f.wait('awaiting-write-permission')
    await assert.rejects(f.authorize({ nonce: 'wrong' }), /briefing-/)
    await assert.rejects(f.authorize({ sessionId: 'wrong' }), /briefing-/)
    f.advance(3001)
    await assert.rejects(f.authorize(), /briefing-/)
    assert.equal(existsSync(join(f.workspace, 'briefing.md')), false)
  } finally {
    await f.close()
  }
})
test('Stop seals write before late permission and preserves unrelated identity', async () => {
  const f = await setup()
  try {
    await f.submit()
    await f.wait('awaiting-write-permission')
    await assert.rejects(f.host.request('stop', { ...f.binding, actionId: 'foreign' }), /briefing-/)
    await f.host.request('stop', f.binding)
    assert.equal((await f.snapshot()).phase, 'stopped')
    await assert.rejects(f.authorize(), /briefing-/)
    assert.equal(existsSync(join(f.workspace, 'briefing.md')), false)
  } finally {
    await f.close()
  }
})
test('existing file and symlink are rejected without replacement', async () => {
  for (const symlink of [false, true]) {
    const f = await setup()
    try {
      const outside = join(f.root, 'sentinel')
      writeFileSync(outside, 'untouched')
      if (symlink) symlinkSync(outside, join(f.workspace, 'briefing.md'))
      else writeFileSync(join(f.workspace, 'briefing.md'), 'existing')
      await f.submit()
      await f.wait('awaiting-write-permission')
      await assert.rejects(f.authorize(), /briefing-|EEXIST/)
      assert.equal(readFileSync(outside, 'utf8'), 'untouched')
      assert.equal(readFileSync(join(f.workspace, 'briefing.md'), 'utf8'), symlink ? 'untouched' : 'existing')
    } finally {
      await f.close()
    }
  }
})
test('cut after file before receipt reopens unknown and never repairs/reexecutes', async () => {
  const f = await setup({
    host: {
      fault: (point) => {
        if (point === 'after-file') throw new Error('cut-after-file')
      },
    },
  })
  let reopened
  try {
    await f.submit()
    await f.wait('awaiting-write-permission')
    await assert.rejects(f.authorize(), /cut-after-file/)
    assert.equal((await f.snapshot()).receipt, null)
    await f.host.close()
    reopened = createBriefingHost({
      descriptor: f.descriptor,
      executor: {
        run() {
          throw new Error('replay')
        },
      },
    })
    const s = await reopened.request('snapshot', { ...f.binding, afterSeq: 0 })
    assert.equal(s.phase, 'unknown')
    assert.equal(s.receipt, null)
    await reopened.request('submit', { descriptor: f.descriptor, spec: f.spec })
    assert.equal((await reopened.request('snapshot', { ...f.binding, afterSeq: 0 })).phase, 'unknown')
    assert.equal(f.count(), 1)
    await assert.rejects(reopened.request('read-result', { ...f.binding, resultId: 'invented' }), /briefing-/)
  } finally {
    await reopened?.close()
    await f.close()
  }
})
test('cut after receipt before completion retains readback but not completion', async () => {
  const f = await setup({
    host: {
      fault: (point) => {
        if (point === 'after-receipt') throw new Error('cut-after-receipt')
      },
    },
  })
  let reopened
  try {
    await f.submit()
    await f.wait('awaiting-write-permission')
    await assert.rejects(f.authorize(), /cut-after-receipt/)
    const before = await f.snapshot()
    assert.ok(before.receipt)
    assert.equal(before.phase, 'unknown')
    await f.host.close()
    reopened = createBriefingHost({
      descriptor: f.descriptor,
      executor: {
        run() {
          throw new Error('replay')
        },
      },
    })
    const s = await reopened.request('snapshot', { ...f.binding, afterSeq: 0 })
    assert.deepEqual(s.receipt, before.receipt)
    assert.equal(s.phase, 'unknown')
    assert.ok((await reopened.request('read-result', { ...f.binding, resultId: s.receipt.resultId })).content)
  } finally {
    await reopened?.close()
    await f.close()
  }
})
test('silent validated inference completes with no intent/file', async () => {
  const f = await setup({
    executor: {
      async run(_spec, { onExecution }) {
        const execution = {
          invocationId: 'silent',
          pid: 123,
          providerThreadId: 'thread',
          exit: { code: 0, signal: null, at: 100 },
        }
        onExecution(execution)
        return {
          execution,
          rawOutput: JSON.stringify({ version: 1, kind: 'silent', reason: line('Already done.'), briefing: null }),
        }
      },
    },
  })
  try {
    await f.submit()
    const s = await f.wait('completed')
    assert.equal(s.completion, 'silent')
    assert.equal(s.receipt, null)
    assert.equal(existsSync(join(f.workspace, 'briefing.md')), false)
  } finally {
    await f.close()
  }
})
test('zero-row durable intent fails before challenge/file', async () => {
  const f = await setup()
  try {
    const db = new DatabaseSync(join(f.directory, 'briefing.sqlite'))
    db.exec('CREATE TRIGGER ignore_intent BEFORE INSERT ON write_intent BEGIN SELECT RAISE(IGNORE); END')
    db.close()
    await f.submit()
    await f.wait('unknown')
    assert.equal((await f.snapshot()).permission, null)
    assert.equal(existsSync(join(f.workspace, 'briefing.md')), false)
  } finally {
    await f.close()
  }
})
test('preprovisioned slot binds future action/message only at first exact submit', async () => {
  const f = await setup()
  await f.host.close()
  rmSync(join(f.directory, 'briefing.sqlite'))
  rmSync(join(f.directory, 'briefing.sqlite-wal'), { force: true })
  rmSync(join(f.directory, 'briefing.sqlite-shm'), { force: true })
  const slot = Object.fromEntries(
    ['version', 'targetId', 'targetEpoch', 'root', 'directory', 'workspace', 'jobId'].map((k) => [k, f.descriptor[k]])
  )
  const host = createBriefingHost({
    slot,
    executor: {
      async run() {
        throw new Error('fixture-stop')
      },
    },
  })
  try {
    const hello = await host.request('hello', {})
    assert.equal(hello.jobId, slot.jobId)
    await assert.rejects(
      host.request('submit', { descriptor: { ...f.descriptor, targetEpoch: 'wrong' }, spec: f.spec }),
      /briefing-/
    )
    await assert.rejects(
      host.request('snapshot', { ...f.binding, afterSeq: 0 }),
      /briefing-job-missing|briefing-binding/
    )
    const accepted = await host.request('submit', { descriptor: f.descriptor, spec: f.spec })
    assert.equal(accepted.descriptor.assistantMessageId, f.descriptor.assistantMessageId)
    await new Promise((r) => setTimeout(r, 5))
    await assert.rejects(
      host.request('submit', { descriptor: { ...f.descriptor, actionId: 'second' }, spec: f.spec }),
      /briefing-/
    )
  } finally {
    await host.close()
    await f.close()
  }
})
test('Stop persists actual exit observed after abort; missing exit remains unknown', async () => {
  for (const confirmed of [true, false]) {
    const f = await setup({
      executor: {
        async run(_spec, { signal, onExecution }) {
          const execution = { invocationId: 'held', pid: 456, providerThreadId: 'thread-held', exit: null }
          onExecution(execution)
          await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
          if (confirmed) onExecution({ ...execution, exit: { code: null, signal: 'SIGTERM', at: 101 } })
          throw new Error('fixture-aborted')
        },
      },
    })
    try {
      await f.submit()
      await f.wait('executing')
      const s = await f.host.request('stop', f.binding)
      assert.equal(s.phase, confirmed ? 'stopped' : 'unknown')
      assert.equal(existsSync(join(f.workspace, 'briefing.md')), false)
    } finally {
      await f.close()
    }
  }
})
test('workspace replacement and monotonic regression refuse before effect', async () => {
  for (const kind of ['workspace', 'clock']) {
    const f = await setup()
    try {
      await f.submit()
      await f.wait('awaiting-write-permission')
      if (kind === 'clock') f.advance(-1)
      else {
        rmSync(f.workspace, { recursive: true })
        mkdirSync(f.workspace, { mode: 0o700 })
      }
      await assert.rejects(f.authorize(), /briefing-/)
      assert.equal(existsSync(join(f.workspace, 'briefing.md')), false)
    } finally {
      await f.close()
    }
  }
})
test('completed restart preserves exact time/hash and readback catches changed file', async () => {
  const f = await setup()
  let reopened
  try {
    await f.submit()
    await f.wait('awaiting-write-permission')
    await f.authorize()
    const before = await f.snapshot()
    await f.host.close()
    reopened = createBriefingHost({
      descriptor: f.descriptor,
      executor: {
        run() {
          throw new Error('replay')
        },
      },
    })
    const after = await reopened.request('snapshot', { ...f.binding, afterSeq: before.cursor })
    assert.equal(after.phase, 'completed')
    assert.equal(after.updatedAt, before.updatedAt)
    assert.deepEqual(after.receipt, before.receipt)
    assert.equal(after.events.length, 1)
    writeFileSync(join(f.workspace, 'briefing.md'), 'changed')
    await assert.rejects(
      reopened.request('read-result', { ...f.binding, resultId: before.receipt.resultId }),
      /briefing-/
    )
  } finally {
    await reopened?.close()
    await f.close()
  }
})
test('executor identity cannot change after observed PID/thread binding', async () => {
  const f = await setup({
    executor: {
      async run(_spec, { onExecution }) {
        const execution = { invocationId: 'bound', pid: 456, providerThreadId: 'actual-thread', exit: null }
        onExecution(execution)
        onExecution({ ...execution, pid: 789, exit: { code: 0, signal: null, at: 101 } })
        throw new Error('must-not-reach')
      },
    },
  })
  try {
    await f.submit()
    const state = await f.wait('unknown')
    assert.equal(state.execution.pid, 456)
    assert.equal(state.permission, null)
    assert.equal(existsSync(join(f.workspace, 'briefing.md')), false)
  } finally {
    await f.close()
  }
})
