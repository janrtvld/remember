import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { RemoteAgentComputer } from '@remember/shared'
import { createResidentAgentService, type ResidentAgentDriver } from '../residentAgentService'
import { ResidentAgentStore } from '../residentAgentStore'

const computer: RemoteAgentComputer = { kind: 'remote', endpoint: 'ws://127.0.0.1:47999/', workspace: '/test/mini' }
const result = { provider: 'codex' as const, response: 'Done', steps: [], durationMs: 2 }
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
function setup(t: { after(fn: () => void | Promise<void>): void }, run?: ResidentAgentDriver['run'], unified = false) {
  const directory = mkdtempSync(path.join(tmpdir(), 'rpa7-command-service-'))
  const store = new ResidentAgentStore(path.join(directory, 'conversation.sqlite'))
  const calls: Parameters<ResidentAgentDriver['run']>[0][] = []
  let target = structuredClone(computer)
  let permitted = true
  let contextCalls = 0
  const service = createResidentAgentService({
    store,
    context: () => {
      contextCalls++
      return 'PRIVATE CONTEXT'
    },
    assertAvailable: () => {
      if (!permitted) throw new Error('not-available')
    },
    changed: () => {},
    commands: { unified, target: () => ({ computer: target, label: 'My Mini' }) },
    driver: {
      run: async (input) => {
        calls.push(input)
        return run ? run(input) : result
      },
      cancel: () => {},
      stopRemote: async () => {},
    },
  })
  t.after(async () => {
    await service.dispose()
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    store,
    service,
    calls,
    contextCalls: () => contextCalls,
    setTarget: (value: RemoteAgentComputer) => {
      target = value
    },
    revoke: () => {
      permitted = false
    },
  }
}

test('explicit command freezes target and exact input, uses fresh thread and no implicit context', async (t) => {
  const h = setup(t, async (input) => {
    input.assertContextCurrent?.()
    input.onDispatch?.()
    input.onCheckpoint({ computer, threadId: 'new-thread', turnId: 'new-turn', previousTurnId: null })
    input.onCheckpoint(null)
    return { ...result, threadId: 'new-thread' }
  })
  h.store.setThread('codex', 'OLD-THREAD')
  h.service.send({ text: 'Do this exactly', provider: 'codex', mode: 'command' })
  await tick()
  const call = h.calls[0]!
  assert.equal(call.prompt, 'Do this exactly')
  assert.equal(call.threadId, null)
  assert.equal(h.contextCalls(), 0)
  assert.deepEqual(call.command?.computer, computer)
  assert.equal(h.store.thread('codex'), 'OLD-THREAD')
  assert.equal(h.service.snapshot().messages.at(-1)?.command?.state, 'completed')
})

test('default question retains source context and never reserves a command', async (t) => {
  const h = setup(t)
  h.service.send({ text: 'Explain', provider: 'codex', mode: 'question' })
  await tick()
  assert.match(h.calls[0]?.prompt ?? '', /PRIVATE CONTEXT/)
  assert.equal(h.calls[0]?.command, undefined)
  assert.equal(h.store.unresolvedCommands().length, 0)
})

test('unsupported mode and command with Claude are rejected before messages/provider', (t) => {
  const h = setup(t)
  assert.throws(() => h.service.send({ text: 'x', provider: 'codex', mode: 'auto' }), /invalid/)
  assert.throws(() => h.service.send({ text: 'x', provider: 'claude', mode: 'command' }), /invalid/)
  assert.equal(h.service.snapshot().messages.length, 0)
  assert.equal(h.calls.length, 0)
})

test('a target change during awaited preparation blocks dispatch; exact old target stays bound', async (t) => {
  let release!: () => void
  let effects = 0
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const h = setup(t, async (input) => {
    await held
    input.assertContextCurrent?.()
    input.onDispatch?.()
    effects++
    return result
  })
  h.service.send({ text: 'x', provider: 'codex', mode: 'command' })
  h.setTarget({ ...computer, workspace: '/different' })
  release()
  await tick()
  assert.equal(effects, 0)
  const message = h.service.snapshot().messages.at(-1)!
  assert.equal(message.command?.state, 'cancelled')
  assert.deepEqual(h.store.command(message.id)?.computer, computer)
})

test('dispatch without checkpoint stays unknown and blocks successor and generic retry', async (t) => {
  const h = setup(t, async (input) => {
    input.onDispatch?.()
    throw new Error('lost-before-checkpoint')
  })
  h.service.send({ text: 'x', provider: 'codex', mode: 'command' })
  await tick()
  const message = h.service.snapshot().messages.at(-1)!
  assert.equal(message.command?.state, 'unknown')
  assert.equal(message.command?.canStop, false)
  assert.throws(() => h.service.send({ text: 'second', provider: 'codex', mode: 'command' }), /slot|recovery/)
  assert.throws(() => h.service.retry(message.id), /exact-control|not-retryable/)
  await assert.rejects(h.service.cancel(message.id), /unconfirmed/)
  assert.equal(h.calls.length, 1)
})

test('lost ACK retains exact checkpoint; wrong or omitted Stop cannot stop it', async (t) => {
  const h = setup(t, async (input) => {
    input.onDispatch?.()
    input.onCheckpoint({ computer, threadId: 't', turnId: 'u', previousTurnId: null })
    throw new Error('lost-ack')
  })
  h.service.send({ text: 'x', provider: 'codex', mode: 'command' })
  await tick()
  const id = h.service.snapshot().messages.at(-1)!.id
  await assert.rejects(h.service.cancel(), /exact-control/)
  await assert.rejects(h.service.cancel('wrong-id'), /exact-control/)
  await h.service.cancel(id)
  assert.equal(h.store.command(id)?.state, 'stopped')
  assert.equal(h.store.unresolvedCommands().length, 0)
  assert.equal(h.calls.length, 1)
})

test('policy revocation during awaited preparation invokes no remote work', async (t) => {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let effects = 0
  const h = setup(t, async (input) => {
    await held
    input.assertContextCurrent?.()
    input.onDispatch?.()
    effects++
    return result
  })
  h.service.send({ text: 'x', provider: 'codex', mode: 'command' })
  h.revoke()
  release()
  await tick()
  assert.equal(effects, 0)
  assert.equal(h.store.unresolvedCommands().length, 0)
})

for (const mode of [undefined, 'question', 'command'] as const) {
  test(`unified private chat sends ${mode ?? 'default'} through exact Mini command with context`, async (t) => {
    const h = setup(
      t,
      async (input) => {
        input.onDispatch?.()
        input.onCheckpoint({ computer, threadId: 'mini-thread', turnId: 'mini-turn', previousTurnId: null })
        input.onCheckpoint(null)
        return result
      },
      true
    )
    h.service.send({ text: 'Wat heb ik vandaag gedaan?', provider: 'codex', ...(mode ? { mode } : {}) })
    await tick()
    assert.equal(h.calls.length, 1)
    assert.deepEqual(h.calls[0]?.command?.computer, computer)
    assert.match(h.calls[0]!.prompt, /PRIVATE CONTEXT/)
    assert.match(h.calls[0]!.prompt, /Wat heb ik vandaag gedaan/)
    assert.equal(h.calls[0]?.threadId, null)
    assert.equal(h.contextCalls(), 1)
    assert.equal(h.service.snapshot().commandMode?.unified, true)
  })
}

test('unified follow-up includes prior completed Mini answer and reset still removes it', async (t) => {
  const h = setup(
    t,
    async (input) => {
      input.onDispatch?.()
      input.onCheckpoint({ computer, threadId: 'mini-thread', turnId: 'mini-turn', previousTurnId: null })
      input.onCheckpoint(null)
      return { ...result, response: 'First answer unique marker' }
    },
    true
  )
  h.service.send({ text: 'First question', provider: 'codex' })
  await tick()
  h.service.send({ text: 'Tell me more', provider: 'codex' })
  await tick()
  assert.match(h.calls[1]!.prompt, /First answer unique marker/)
  assert.equal(h.store.history().length, 0)
  assert.ok(h.store.history(true).length > 0)
  h.store.resetContext()
  assert.equal(h.store.history(true).length, 0)
})

test('unified queue waits, runs FIFO once after completion and includes preceding answer', async (t) => {
  let finish!: () => void
  const h = setup(
    t,
    async (input) => {
      input.onDispatch?.()
      input.onCheckpoint({ computer, threadId: input.turnId, turnId: input.turnId, previousTurnId: null })
      if (input.instruction === 'first')
        await new Promise<void>((resolve) => {
          finish = resolve
        })
      input.onCheckpoint(null)
      return { ...result, response: `answer:${input.instruction}` }
    },
    true
  )
  h.service.send({ text: 'first', provider: 'codex' })
  await tick()
  const ownedRecovery = h.service.snapshot().remoteRecoveryRequired
  const detachedRecovery = h.store.conversation(null).remoteRecoveryRequired
  h.service.send({ text: 'second', provider: 'codex', queue: true })
  h.service.send({ text: 'third', provider: 'codex', queue: true })
  assert.equal(h.calls.length, 1)
  assert.equal(h.store.queuedMessages().length, 2)
  finish()
  await tick()
  await tick()
  assert.deepEqual(
    h.calls.map((call) => call.instruction),
    ['first', 'second', 'third']
  )
  assert.equal(ownedRecovery, false)
  assert.equal(detachedRecovery, true)
  assert.match(h.calls[1]!.prompt, /answer:first/)
  assert.equal(h.store.queuedMessages().length, 0)
})

test('queue cancellation removes only queued input and Stop pauses remaining messages', async (t) => {
  let finish!: () => void
  const h = setup(
    t,
    async (input) => {
      input.onDispatch?.()
      input.onCheckpoint({ computer, threadId: input.turnId, turnId: input.turnId, previousTurnId: null })
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      input.onCheckpoint(null)
      return result
    },
    true
  )
  const first = h.service.send({ text: 'first', provider: 'codex' })
  await tick()
  h.service.send({ text: 'remove', provider: 'codex', queue: true })
  h.service.send({ text: 'keep', provider: 'codex', queue: true })
  await h.service.cancel(h.store.queuedMessages()[0]!.id)
  assert.equal(h.calls.length, 1)
  const stopping = h.service.cancel(first.messages.find((message) => message.command)!.id)
  finish()
  await stopping
  assert.equal(h.calls.length, 1)
  assert.equal(h.store.queuedMessages()[0]!.text, 'keep')
})

test('queue survives store reopen without execution and target change prevents draining', async (t) => {
  let finish!: () => void
  const h = setup(
    t,
    async (input) => {
      input.onDispatch?.()
      input.onCheckpoint({ computer, threadId: input.turnId, turnId: input.turnId, previousTurnId: null })
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      input.onCheckpoint(null)
      return result
    },
    true
  )
  h.service.send({ text: 'first', provider: 'codex' })
  await tick()
  h.service.send({ text: 'next', provider: 'codex', queue: true })
  h.setTarget({ ...computer, workspace: '/other' })
  finish()
  await tick()
  assert.equal(h.calls.length, 1)
  assert.equal(h.store.queuedMessages()[0]!.text, 'next')
  const directory = mkdtempSync(path.join(tmpdir(), 'queue-reopen-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'conversation.sqlite')
  const a = new ResidentAgentStore(filename)
  const id = a.queueMessage('saved draft', 'target')
  a.close()
  const b = new ResidentAgentStore(filename)
  assert.equal(b.queuedMessages()[0]!.id, id)
  let dispatches = 0
  const restored = createResidentAgentService({
    store: b,
    context: () => '',
    assertAvailable: () => {},
    changed: () => {},
    commands: { unified: true, target: () => ({ computer, label: 'Mini' }) },
    driver: {
      run: async () => {
        dispatches++
        return result
      },
      cancel: () => {},
    },
  })
  assert.deepEqual(restored.snapshot().queuedMessages, [{ id, text: 'saved draft', state: 'paused' }])
  await tick()
  assert.equal(dispatches, 0)
  await restored.dispose()
})
