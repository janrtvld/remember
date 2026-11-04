import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { AgentTurnStep } from '@remember/shared'
import { createResidentAgentService, type ResidentAgentDriver } from '../residentAgentService'
import { ResidentAgentStore, type ResidentHostRun } from '../residentAgentStore'

const marker = 'assistant-host-context-invalidated'
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const message = {
  text: 'I opened the relevant notes.',
  steps: [{ id: 'read-notes', kind: 'status', text: 'Reading notes', at: 1 }] satisfies AgentTurnStep[],
  status: 'streaming' as const,
}

function setup(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'remember-host-context-stop-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'conversation.sqlite')
  const store = new ResidentAgentStore(file)
  const turn = store.start('Draft the project update.', 'codex')
  const binding: ResidentHostRun = {
    jobId: 'owned-job',
    messageId: turn.id,
    endpoint: 'tcp://127.0.0.1:47833',
    cursor: 10,
    phase: 'waiting',
    connection: 'connected',
  }
  store.persistHostRun(binding, message)
  store.recordMemorySources([{ spaceId: 'personal', slug: 'project', revision: 'revision-one', explicit: true }])
  store.setThread('codex', 'provider-thread')
  store.claimToolCall('owned-write', 'arguments-hash', { messageId: turn.id, toolName: 'remember_memory' })
  return { file, store, turn, binding }
}

function serviceFor(store: ResidentAgentStore, stopHost: NonNullable<ResidentAgentDriver['stopHost']>) {
  return createResidentAgentService({
    store,
    context: () => assert.fail('Stopping cannot load or submit new context'),
    assertAvailable: () => {},
    changed: () => {},
    driver: {
      run: async () => assert.fail('Stopping cannot attach or submit a new provider turn'),
      cancel: () => assert.fail('A host job cannot use local cancellation'),
      stopHost,
    },
  })
}

function readRows(file: string) {
  const database = new DatabaseSync(file, { readOnly: true })
  try {
    return {
      messages: database.prepare('SELECT * FROM assistant_message ORDER BY sequence').all(),
      claims: database.prepare('SELECT * FROM assistant_tool_call ORDER BY id').all(),
    }
  } finally {
    database.close()
  }
}

test('C1 active context invalidation stops the same job and records a durable reason without importing work', async (t) => {
  const { store, turn, binding } = setup(t)
  const stops: ResidentHostRun[] = []
  const service = serviceFor(store, async (pending) => {
    stops.push(pending)
  })
  await service.invalidateContext()
  assert.equal(stops.length, 1)
  assert.equal(stops[0]?.jobId, binding.jobId)
  assert.equal(stops[0]?.messageId, turn.id)
  assert.equal(stops[0]?.stopReason, 'context-invalidated')
  assert.equal(store.hostRun()?.phase, 'stopped')
  assert.equal(store.hostRun()?.contextInvalidated, true)
  assert.equal(store.hostRun()?.stopRequested, true)
  assert.equal(store.get(turn.id)?.status, 'cancelled')
  assert.equal(store.get(turn.id)?.error, marker)
  assert.equal(store.get(turn.id)?.text, message.text)
  assert.deepEqual(store.get(turn.id)?.steps, message.steps)
  assert.deepEqual(store.get(turn.id)?.results, [])
  assert.deepEqual(store.memorySources(), [])
  assert.equal(store.thread('codex'), null)
  assert.equal(store.claimToolCall('owned-write', 'arguments-hash').result, null)
  await service.dispose()
})

test('C1 reset before startup preserves the cause and resumes only the same Stop', async (t) => {
  const { file, store, turn, binding } = setup(t)
  store.resetContext()
  assert.equal(store.hostRun()?.stopReason, 'context-invalidated')
  store.close()
  const reopened = new ResidentAgentStore(file)
  const stops: string[] = []
  const service = serviceFor(reopened, async (pending) => {
    stops.push(pending.jobId)
  })
  service.resumeHost()
  await tick()
  assert.deepEqual(stops, [binding.jobId])
  assert.equal(reopened.get(turn.id)?.error, marker)
  await service.dispose()
})

test('C1 a changed startup policy records the cause before cancelling the existing job', async (t) => {
  const { store, turn } = setup(t)
  store.synchronizePolicy('old-policy')
  const service = serviceFor(store, async () => {})
  await service.setContextPolicy('new-policy')
  assert.equal(store.hostRun()?.phase, 'stopped')
  assert.equal(store.hostRun()?.stopReason, 'context-invalidated')
  assert.equal(store.get(turn.id)?.error, marker)
  await service.dispose()
})

test('C1 resumed source validation records context Stop before any driver attachment', async (t) => {
  const { store, turn, binding } = setup(t)
  const operations: string[] = []
  const service = createResidentAgentService({
    store,
    context: () => assert.fail('No new prompt'),
    assertAvailable() {},
    changed() {},
    validateHostContext: async () => {
      operations.push('validate')
      return 'invalidated'
    },
    driver: {
      run: async () => assert.fail('Invalid sources cannot attach to a host job'),
      cancel() {},
      stopHost: async (pending) => {
        operations.push('stop')
        assert.equal(pending.jobId, binding.jobId)
        assert.equal(pending.stopReason, 'context-invalidated')
      },
    },
  })
  service.resumeHost()
  await tick()
  assert.deepEqual(operations, ['validate', 'stop'])
  assert.equal(store.get(turn.id)?.error, marker)
  await service.dispose()
})

test('C1 a legacy invalidated nonterminal binding obtains the reason only when Stop resumes', async (t) => {
  const { store, turn, binding } = setup(t)
  store.persistHostRun({ ...binding, contextInvalidated: true }, message)
  assert.equal(store.hostRun()?.stopReason, undefined)
  const service = serviceFor(store, async (pending) => {
    assert.equal(pending.stopReason, 'context-invalidated')
  })
  service.resumeHost()
  await tick()
  assert.equal(store.hostRun()?.phase, 'stopped')
  assert.equal(store.get(turn.id)?.error, marker)
  await service.dispose()
})

test('C1 terminal binding and historical marker commit together or both roll back', (t) => {
  const { file, store, turn } = setup(t)
  store.resetContext()
  const pending = store.hostRun()
  assert.ok(pending)
  const database = new DatabaseSync(file)
  database.exec(`CREATE TRIGGER reject_context_stop BEFORE UPDATE ON assistant_host_run
    WHEN json_extract(NEW.binding, '$.phase') = 'stopped'
    BEGIN SELECT RAISE(ABORT, 'test-context-stop-persistence-failure'); END;`)
  assert.throws(
    () => store.persistHostRun({ ...pending, phase: 'stopped' }, { ...message, status: 'cancelled', error: null }),
    /test-context-stop-persistence-failure/
  )
  assert.equal(store.hostRun()?.phase, 'waiting')
  assert.equal(store.get(turn.id)?.status, 'streaming')
  assert.equal(store.get(turn.id)?.error, null)
  database.exec('DROP TRIGGER reject_context_stop')
  database.close()
  store.persistHostRun({ ...pending, phase: 'stopped' }, { ...message, status: 'cancelled', error: null })
  assert.equal(store.hostRun()?.phase, 'stopped')
  assert.equal(store.get(turn.id)?.error, marker)
  store.close()
})

test('C2 an unconfirmed Stop retains the local reason and real error through restart and status check', async (t) => {
  const { file, store, turn, binding } = setup(t)
  let available = false
  const stops: string[] = []
  const stopHost = async (pending: ResidentHostRun) => {
    stops.push(pending.jobId)
    if (!available) throw new Error('owned-host-disconnected')
  }
  let service = serviceFor(store, stopHost)
  await assert.rejects(service.invalidateContext(), /owned-host-disconnected/)
  assert.equal(store.hostRun()?.stopReason, 'context-invalidated')
  assert.equal(store.hostRun()?.phase, 'recovery-required')
  assert.equal(store.get(turn.id)?.status, 'interrupted')
  assert.equal(store.get(turn.id)?.error, 'owned-host-disconnected')
  await service.dispose()
  const reopened = new ResidentAgentStore(file)
  service = serviceFor(reopened, stopHost)
  service.retry(turn.id)
  await tick()
  assert.equal(reopened.hostRun()?.phase, 'recovery-required')
  assert.equal(reopened.get(turn.id)?.error, 'owned-host-disconnected')
  available = true
  service.retry(turn.id)
  await tick()
  assert.deepEqual(stops, [binding.jobId, binding.jobId, binding.jobId])
  assert.equal(reopened.hostRun()?.phase, 'stopped')
  assert.equal(reopened.get(turn.id)?.error, marker)
  assert.equal(reopened.conversation(null).messages.length, 2)
  await service.dispose()
})

test('C3 the historical reason survives another binding and direct retries cannot create rows or dispatch', async (t) => {
  const { file, store, turn, binding } = setup(t)
  const first = serviceFor(store, async () => {})
  await first.invalidateContext()
  await first.dispose()
  const reopened = new ResidentAgentStore(file)
  const next = reopened.start('A new explicitly authorised task.', 'codex')
  reopened.persistHostRun(
    { ...binding, jobId: 'next-job', messageId: next.id, phase: 'completed' },
    { text: 'Separate result.', steps: [], status: 'completed' }
  )
  const before = readRows(file)
  const service = serviceFor(reopened, async () => assert.fail('No historical Stop replay'))
  assert.equal(reopened.get(turn.id)?.error, marker)
  assert.equal(reopened.get(next.id)?.error, null)
  assert.throws(() => reopened.start('', 'codex', turn.id), /assistant-message-not-retryable/)
  assert.throws(() => service.retry(turn.id), /assistant-message-not-retryable/)
  assert.deepEqual(readRows(file), before)
  await service.dispose()
})

test('C4 a later context reset never relabels a completed manual Stop', async (t) => {
  const { file, store, turn } = setup(t)
  const service = serviceFor(store, async () => {})
  await service.cancel()
  assert.equal(store.get(turn.id)?.error, null)
  await service.invalidateContext()
  assert.equal(store.hostRun()?.contextInvalidated, true)
  assert.equal(store.hostRun()?.stopReason, undefined)
  assert.equal(store.get(turn.id)?.error, null)
  await service.dispose()
  const reopened = new ResidentAgentStore(file)
  const old = reopened.hostRun()
  assert.ok(old)
  reopened.persistHostRun(old, { ...message, status: 'cancelled', error: null })
  assert.equal(reopened.get(turn.id)?.error, null)
  reopened.close()
})

for (const expiryFirst of [true, false]) {
  test(`C5 proven expiry wins with ${expiryFirst ? 'expiry before context' : 'context before expiry'}`, async (t) => {
    const { store, turn, binding } = setup(t)
    if (expiryFirst) store.persistHostRun({ ...binding, stopReason: 'request-expired' }, message)
    const service = serviceFor(store, async (_pending, onReason) => {
      onReason?.('request-expired')
      return { phase: 'stopped', stopReason: 'request-expired' }
    })
    await service.invalidateContext()
    assert.equal(store.hostRun()?.stopReason, 'request-expired')
    assert.equal(store.get(turn.id)?.error, 'assistant-host-request-expired')
    store.resetContext()
    assert.equal(store.get(turn.id)?.error, 'assistant-host-request-expired')
    await service.dispose()
  })
}

test('C5 completed during context Stop remains completed and never imports the newly returned private response', async (t) => {
  const { store, turn } = setup(t)
  const service = serviceFor(store, async () => ({ phase: 'completed', response: 'Newly private response' }))
  await service.invalidateContext()
  assert.equal(store.hostRun()?.phase, 'completed')
  assert.equal(store.get(turn.id)?.status, 'completed')
  assert.equal(store.get(turn.id)?.error, null)
  assert.equal(store.get(turn.id)?.text, message.text)
  assert.deepEqual(store.get(turn.id)?.steps, message.steps)
  await service.dispose()
})

test('C5 completed source-unavailable receipt stays retryable through the same validation route', async (t) => {
  const { store, turn } = setup(t)
  let valid = false
  let stops = 0
  const service = createResidentAgentService({
    store,
    context: () => assert.fail('No new context'),
    assertAvailable() {},
    changed() {},
    validateHostContext: async () => (valid ? 'valid' : 'unavailable'),
    driver: {
      run: async () => assert.fail('No new provider run'),
      cancel() {},
      stopHost: async () => {
        stops++
        return { phase: 'completed', response: 'Verified result' }
      },
    },
  })
  await service.cancel()
  assert.equal(store.hostRun()?.phase, 'completed')
  assert.equal(store.hostRun()?.stopReason, undefined)
  assert.equal(store.get(turn.id)?.error, 'assistant-host-context-unavailable')
  assert.equal(store.get(turn.id)?.text, message.text)
  valid = true
  service.retry(turn.id)
  await tick()
  assert.equal(stops, 2)
  assert.equal(store.get(turn.id)?.status, 'completed')
  assert.equal(store.get(turn.id)?.error, null)
  assert.equal(store.get(turn.id)?.text, 'Verified result')
  await service.dispose()
})
