import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { AgentTurnUpdate } from '@remember/shared'
import { createResidentAgentService, type ResidentAgentDriver } from '../residentAgentService'
import { ResidentAgentStore } from '../residentAgentStore'

function temporary(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(path.join(tmpdir(), 'remember-assistant-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return path.join(directory, 'conversation.sqlite')
}
const result = { provider: 'codex' as const, response: 'Ready', durationMs: 20, steps: [] }
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

test('messages, partial reply and provider identity survive a real store close/reopen; interrupted tools are not restarted', (t) => {
  const file = temporary(t)
  let store = new ResidentAgentStore(file)
  const turn = store.start('Remember my release', 'codex')
  store.setThread('codex', 'thread-1')
  store.update(turn.id, { text: 'Checking', steps: [], status: 'streaming' })
  store.close()
  store = new ResidentAgentStore(file)
  assert.equal(store.thread('codex'), 'thread-1')
  assert.equal(store.thread('claude'), null)
  const messages = store.conversation(null).messages
  assert.equal(messages[0]?.text, 'Remember my release')
  assert.equal(messages[1]?.text, 'Checking')
  assert.equal(messages[1]?.status, 'interrupted')
  assert.equal(store.conversation(null).activeTurnId, null)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  store.close()
})

test('retry resumes the same provider thread without duplicating the user instruction and retains failed attempt', async (t) => {
  const file = temporary(t)
  const store = new ResidentAgentStore(file)
  const calls: Parameters<ResidentAgentDriver['run']>[0][] = []
  const driver: ResidentAgentDriver = {
    run: async (input) => {
      calls.push(input)
      input.onThread('thread-persisted')
      if (calls.length === 1) throw new Error('network-failed')
      return result
    },
    cancel: () => {},
  }
  let context = 'context revision 1'
  const service = createResidentAgentService({
    store,
    driver,
    context: () => context,
    assertAvailable: () => {},
    changed: () => {},
  })
  service.send({ text: 'Check the task', provider: 'codex' })
  await tick()
  const failed = service.snapshot().messages.at(-1)
  assert.equal(failed?.status, 'failed')
  context = 'context revision 2'
  service.retry(failed?.id ?? '')
  await tick()
  assert.equal(calls[1]?.threadId, 'thread-persisted')
  assert.match(calls[1]?.prompt ?? '', /context revision 2/)
  assert.equal(service.snapshot().messages.filter((entry) => entry.role === 'user').length, 1)
  assert.deepEqual(
    service
      .snapshot()
      .messages.filter((entry) => entry.role === 'assistant')
      .map((entry) => entry.status),
    ['failed', 'completed']
  )
  assert.throws(() => service.retry(service.snapshot().messages.at(-1)?.id ?? ''), /not-retryable/)
  await service.dispose()
})

test('cancel waits for the owned worker, persists partial output and rejects concurrent sends', async (t) => {
  const store = new ResidentAgentStore(temporary(t))
  let finish: ((value: typeof result) => void) | undefined
  let update: ((value: AgentTurnUpdate) => void) | undefined
  let turnId = ''
  const cancelled: string[] = []
  const service = createResidentAgentService({
    store,
    context: () => '{}',
    assertAvailable: () => {},
    changed: () => {},
    driver: {
      run: async (input) => {
        turnId = input.turnId
        update = input.onUpdate
        return new Promise((resolve) => {
          finish = resolve
        })
      },
      cancel: (id) => {
        cancelled.push(id)
        finish?.(result)
      },
    },
  })
  service.send({ text: 'Check this', provider: 'codex' })
  assert.throws(() => service.send({ text: 'Another turn', provider: 'codex' }), /already-running/)
  update?.({ type: 'response', id: 'response', turnId, provider: 'codex', text: 'Partial result', at: 1 })
  await service.cancel()
  assert.deepEqual(cancelled, [turnId])
  assert.equal(service.snapshot().activeTurnId, null)
  assert.equal(service.snapshot().messages.at(-1)?.status, 'cancelled')
  assert.equal(service.snapshot().messages.at(-1)?.text, 'Partial result')
  await service.dispose()
})

test('unavailable/offline requests do not persist an unsent user message or start a worker', async (t) => {
  const store = new ResidentAgentStore(temporary(t))
  let started = false
  const service = createResidentAgentService({
    store,
    context: () => '{}',
    changed: () => {},
    assertAvailable: () => {
      throw new Error('offline')
    },
    driver: {
      run: async () => {
        started = true
        return result
      },
      cancel: () => {},
    },
  })
  assert.throws(() => service.send({ text: 'Send', provider: 'codex' }), /offline/)
  assert.equal(started, false)
  assert.deepEqual(service.snapshot().messages, [])
  await service.dispose()
})

test('long conversations are paged with stable ordering and no dropped messages', (t) => {
  const store = new ResidentAgentStore(temporary(t))
  for (let index = 0; index < 45; index++) {
    const turn = store.start(`Question ${index}`, 'codex')
    store.update(turn.id, { text: `Answer ${index}`, steps: [], status: 'completed' })
  }
  const latest = store.conversation(null)
  const earlier = store.conversation(null, latest.messages[0]?.id)
  const first = store.conversation(null, earlier.messages[0]?.id)
  assert.equal(latest.messages.length, 40)
  assert.equal(earlier.messages.length, 40)
  assert.equal(first.messages.length, 10)
  assert.equal(first.hasEarlier, false)
  assert.equal(new Set([...first.messages, ...earlier.messages, ...latest.messages].map((entry) => entry.id)).size, 90)
  store.close()
})

test('a privacy or consent change cancels the running worker and drops its context/thread before a subsequent turn', async (t) => {
  const store = new ResidentAgentStore(temporary(t))
  const calls: Parameters<ResidentAgentDriver['run']>[0][] = []
  let finish: ((value: typeof result & { threadId?: string }) => void) | undefined
  const service = createResidentAgentService({
    store,
    context: () => 'fresh permitted evidence',
    assertAvailable: () => {},
    changed: () => {},
    driver: {
      run: async (input) => {
        calls.push(input)
        if (calls.length > 1) return result
        input.onThread('old-thread-with-private-context')
        return new Promise((resolve) => {
          finish = resolve
        })
      },
      cancel: () => {
        calls[0]?.onThread('late-old-thread')
        finish?.({ ...result, threadId: 'stale-result-thread' })
      },
    },
  })
  service.send({ text: 'Old private topic', provider: 'codex' })
  await service.invalidateContext()
  assert.equal(store.thread('codex'), null)
  assert.equal(service.snapshot().messages.at(-1)?.status, 'cancelled')
  service.send({ text: 'New permitted topic', provider: 'codex' })
  await tick()
  assert.equal(calls[1]?.threadId, null)
  assert.ok(!calls[1]?.prompt.includes('Old private topic'))
  assert.match(calls[1]?.prompt ?? '', /New permitted topic/)
  assert.equal(service.snapshot().messages[0]?.text, 'Old private topic', 'Local chat archive remains readable')
  await service.dispose()
})

test('disposal waits for cancellation before closing the store and prevents later sends', async (t) => {
  const file = temporary(t)
  const store = new ResidentAgentStore(file)
  let finish: ((value: typeof result) => void) | undefined
  let cancelled = false
  const service = createResidentAgentService({
    store,
    context: () => '{}',
    assertAvailable: () => {},
    changed: () => {},
    driver: {
      run: async () =>
        new Promise((resolve) => {
          finish = resolve
        }),
      cancel: () => {
        cancelled = true
        finish?.(result)
      },
    },
  })
  service.send({ text: 'Delete after shutdown', provider: 'codex' })
  await service.dispose()
  assert.equal(cancelled, true)
  assert.throws(() => service.send({ text: 'Cannot write after close', provider: 'codex' }), /unavailable/)
  const restarted = new ResidentAgentStore(file)
  assert.equal(restarted.conversation(null).messages.at(-1)?.status, 'cancelled')
  restarted.close()
  rmSync(file)
})

test('a privacy policy changed while the app was stopped invalidates the previous thread on startup', (t) => {
  const file = temporary(t)
  let store = new ResidentAgentStore(file)
  assert.equal(store.synchronizePolicy('allowed-v1'), false)
  store.start('Previously permitted topic', 'codex')
  store.setThread('codex', 'private-thread')
  store.close()
  store = new ResidentAgentStore(file)
  assert.equal(store.synchronizePolicy('restricted-v2'), true)
  assert.equal(store.thread('codex'), null)
  assert.deepEqual(store.history(), [])
  assert.equal(store.conversation(null).messages.length, 2)
  store.close()
})

test('an uncertain remote run survives restart and blocks new work until the original attempt is recovered', async (t) => {
  const file = temporary(t)
  let store = new ResidentAgentStore(file)
  const original = store.start('Perform once', 'codex')
  store.setRemoteRun({
    messageId: original.id,
    computer: { kind: 'remote', endpoint: 'ws://127.0.0.1:47832/', workspace: '/agent' },
    threadId: 'remote-thread',
    turnId: null,
    previousTurnId: 'previous',
  })
  store.close()
  store = new ResidentAgentStore(file)
  let calls = 0
  const service = createResidentAgentService({
    store,
    context: () => '{}',
    assertAvailable: () => {},
    changed: () => {},
    execution: () => 'remote',
    driver: {
      cancel: () => {},
      run: async (input) => {
        calls += 1
        assert.equal(input.recovery?.threadId, 'remote-thread')
        assert.equal(input.recovery?.turnId, null)
        input.onCheckpoint(null)
        return result
      },
    },
  })
  assert.equal(service.snapshot().execution, 'remote')
  assert.equal(service.snapshot().remoteRecoveryRequired, true)
  assert.throws(() => service.send({ text: 'Do something else', provider: 'codex' }), /recovery-required/)
  service.retry(original.id)
  await tick()
  assert.equal(calls, 1)
  assert.equal(service.snapshot().remoteRecoveryRequired, false)
  assert.equal(service.snapshot().messages.filter((entry) => entry.role === 'user').length, 1)
  await service.dispose()
})

test('a failed remote stop remains interrupted; deletion or computer changes preserve the checkpoint and only allow stop recovery', async (t) => {
  const file = temporary(t)
  let store = new ResidentAgentStore(file)
  let reject!: (error: Error) => void
  const service = createResidentAgentService({
    store,
    context: () => 'private context',
    assertAvailable: () => {},
    changed: () => {},
    driver: {
      run: async (input) => {
        input.onThread('remote-thread')
        input.onCheckpoint({
          computer: { kind: 'remote', endpoint: 'ws://127.0.0.1:47832/', workspace: '/agent' },
          threadId: 'remote-thread',
          turnId: 'remote-turn',
          previousTurnId: null,
        })
        return new Promise((_resolve, fail) => {
          reject = fail
        })
      },
      cancel: () => reject(new Error('codex-remote-stop-unconfirmed')),
      stopRemote: async () => {
        throw new Error('codex-remote-unavailable')
      },
    },
  })
  service.send({ text: 'Private work', provider: 'codex' })
  await service.invalidateContext()
  assert.equal(service.snapshot().messages.at(-1)?.status, 'interrupted')
  assert.equal(store.remoteRun()?.contextInvalidated, true)
  assert.equal(store.thread('codex'), null)
  assert.deepEqual(store.history(), [])
  await assert.rejects(service.prepareForDeletion(), /remote-unavailable/)
  await service.dispose()
  store = new ResidentAgentStore(file)
  assert.equal(store.remoteRun()?.contextInvalidated, true)
  let stops = 0
  const restarted = createResidentAgentService({
    store,
    context: () => '{}',
    assertAvailable: () => {},
    changed: () => {},
    driver: {
      cancel: () => {},
      run: async () => {
        throw new Error('Invalidated context must never be resumed')
      },
      stopRemote: async (checkpoint) => {
        stops += 1
        assert.equal(checkpoint.threadId, 'remote-thread')
      },
    },
  })
  restarted.retry(store.remoteRun()?.messageId ?? '')
  await tick()
  assert.equal(stops, 1)
  assert.equal(store.remoteRun(), null)
  assert.equal(store.thread('codex'), null)
  await restarted.dispose()
})

test('a first remote checkpoint arriving after privacy invalidation remains stop-only and terminal state is committed atomically', async (t) => {
  const store = new ResidentAgentStore(temporary(t))
  let current!: Parameters<ResidentAgentDriver['run']>[0]
  let reject!: (error: Error) => void
  const service = createResidentAgentService({
    store,
    context: () => '{}',
    assertAvailable: () => {},
    changed: () => {},
    driver: {
      run: async (input) => {
        current = input
        return new Promise((_resolve, fail) => {
          reject = fail
        })
      },
      cancel: () => {
        current.onCheckpoint({
          computer: { kind: 'remote', endpoint: 'ws://127.0.0.1:47832/', workspace: '/agent' },
          threadId: 'late-thread',
          turnId: 'late-turn',
          previousTurnId: null,
        })
        reject(new Error('codex-remote-stop-unconfirmed'))
      },
      stopRemote: async () => {},
    },
  })
  service.send({ text: 'In flight during deletion', provider: 'codex' })
  await service.invalidateContext()
  assert.equal(store.remoteRun()?.contextInvalidated, true)
  await service.cancel()
  assert.equal(store.remoteRun(), null)
  assert.equal(service.snapshot().messages.at(-1)?.status, 'cancelled')
  await service.dispose()
})

test('remote completion checkpoint remains durable until its response is persisted', async (t) => {
  const store = new ResidentAgentStore(temporary(t))
  let complete!: (value: typeof result) => void
  const service = createResidentAgentService({
    store,
    context: () => '{}',
    assertAvailable: () => {},
    changed: () => {},
    driver: {
      run: async (input) => {
        input.onCheckpoint({
          computer: { kind: 'remote', endpoint: 'ws://127.0.0.1:47832/', workspace: '/agent' },
          threadId: 'thread',
          turnId: 'turn',
          previousTurnId: null,
        })
        input.onCheckpoint(null)
        return new Promise((resolve) => {
          complete = resolve
        })
      },
      cancel: () => {},
    },
  })
  service.send({ text: 'Do this once', provider: 'codex' })
  assert.equal(store.remoteRun()?.turnId, 'turn')
  complete(result)
  await tick()
  assert.equal(store.remoteRun(), null)
  assert.equal(service.snapshot().messages.at(-1)?.text, result.response)
  await service.dispose()
})
