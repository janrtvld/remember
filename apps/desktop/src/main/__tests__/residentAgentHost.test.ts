import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { AgentTurnUpdate } from '@remember/shared'
import { createResidentAgentService, type ResidentAgentDriver } from '../residentAgentService'
import { ResidentAgentStore, type ResidentHostRun } from '../residentAgentStore'

function temporary(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(path.join(tmpdir(), 'remember-host-lifecycle-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return path.join(directory, 'conversation.sqlite')
}

const result = { provider: 'codex' as const, response: 'Host result', durationMs: 20, steps: [] }
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const patch = { text: 'Started on the host', steps: [], status: 'streaming' as const }

function binding(messageId: string, overrides: Partial<ResidentHostRun> = {}): ResidentHostRun {
  return {
    jobId: `job-${messageId}`,
    messageId,
    endpoint: 'tcp://127.0.0.1:47833',
    cursor: 1,
    phase: 'running',
    connection: 'connected',
    ...overrides,
  }
}

function response(turnId: string, text: string): AgentTurnUpdate {
  return { type: 'response', turnId, provider: 'codex', id: 'response', text, at: 1 }
}

function serviceFor(store: ResidentAgentStore, driver: ResidentAgentDriver, context = () => 'Initial context') {
  return createResidentAgentService({ store, driver, context, assertAvailable: () => {}, changed: () => {} })
}

test('host ownership survives restart without converting the message to a failed local run or exposing endpoint/job IDs', (t) => {
  const file = temporary(t)
  let store = new ResidentAgentStore(file)
  const host = store.start('Continue while closed', 'codex')
  store.persistHostRun(binding(host.id), patch)
  const local = store.start('Local attempt', 'codex')
  store.close()

  store = new ResidentAgentStore(file)
  assert.equal(store.get(host.id)?.status, 'streaming')
  assert.equal(store.get(local.id)?.status, 'interrupted')
  assert.equal(store.hostRun()?.connection, 'disconnected')
  assert.equal(store.conversation(null).activeTurnId, host.id)
  assert.deepEqual(store.conversation(null).hostJob, {
    messageId: host.id,
    phase: 'running',
    connection: 'disconnected',
  })
  store.close()
})

test('host event cursor and final message commit atomically, including rollback on a binding write failure', (t) => {
  const file = temporary(t)
  const store = new ResidentAgentStore(file)
  const turn = store.start('One result', 'codex')
  store.persistHostRun(binding(turn.id), patch)
  const database = new DatabaseSync(file)
  database.exec(`CREATE TRIGGER reject_test_cursor BEFORE UPDATE ON assistant_host_run
    WHEN json_extract(NEW.binding, '$.cursor') = 2
    BEGIN SELECT RAISE(ABORT, 'test-persistence-failure'); END;`)
  assert.throws(
    () =>
      store.persistHostRun(binding(turn.id, { cursor: 2, phase: 'completed' }), {
        ...patch,
        text: 'Final',
        status: 'completed',
      }),
    /test-persistence-failure/
  )
  assert.equal(store.hostRun()?.cursor, 1)
  assert.equal(store.get(turn.id)?.text, patch.text)
  assert.equal(store.get(turn.id)?.status, 'streaming')
  database.exec('DROP TRIGGER reject_test_cursor')
  database.close()
  store.persistHostRun(binding(turn.id, { cursor: 2, phase: 'completed' }), {
    ...patch,
    text: 'Final',
    status: 'completed',
  })
  store.close()

  const restarted = new ResidentAgentStore(file)
  assert.equal(restarted.hostRun()?.cursor, 2)
  assert.equal(restarted.get(turn.id)?.text, 'Final')
  assert.equal(restarted.get(turn.id)?.status, 'completed')
  restarted.close()
})

test('host identity and cursor cannot be rewritten, and policy/stop flags survive late callbacks', (t) => {
  const store = new ResidentAgentStore(temporary(t))
  const turn = store.start('Private task', 'codex')
  store.persistHostRun(binding(turn.id, { cursor: 4, stopRequested: true, contextInvalidated: true }), patch)
  for (const change of [{ endpoint: 'tcp://127.0.0.1:9' }, { jobId: 'different-job' }]) {
    assert.throws(() => store.persistHostRun(binding(turn.id, { cursor: 5, ...change }), patch), /binding-mismatch/)
  }
  assert.throws(() => store.persistHostRun(binding(turn.id, { cursor: 3 }), patch), /cursor-regression/)
  assert.throws(
    () => store.persistHostRun(binding(turn.id, { cursor: 5, phase: 'completed' }), patch),
    /result-not-persisted/
  )
  store.persistHostRun(binding(turn.id, { cursor: 5 }), patch)
  assert.equal(store.hostRun()?.contextInvalidated, true)
  assert.equal(store.hostRun()?.stopRequested, true)
  store.close()
})

test('quit detaches, restart/retry attaches the same job and message without reloading context or submitting another instruction', async (t) => {
  const file = temporary(t)
  let store = new ResidentAgentStore(file)
  let reject!: (error: Error) => void
  let detached = ''
  let original!: Parameters<ResidentAgentDriver['run']>[0]
  let service = serviceFor(store, {
    run: async (input) => {
      original = input
      input.onHostRun(binding(input.turnId))
      input.onUpdate(response(input.turnId, 'Working remotely'))
      return new Promise((_resolve, fail) => {
        reject = fail
      })
    },
    detachHost: (id) => {
      detached = id
      reject(new Error('client-detached'))
    },
    cancel: () => assert.fail('Quit must not cancel'),
    stopHost: async () => assert.fail('Quit must not stop'),
  })
  service.send({ text: 'Keep working', provider: 'codex' })
  await service.dispose()
  assert.equal(detached, original.turnId)

  store = new ResidentAgentStore(file)
  assert.equal(store.get(original.turnId)?.status, 'streaming')
  let calls = 0
  service = serviceFor(
    store,
    {
      run: async (input) => {
        calls += 1
        assert.equal(input.turnId, original.turnId)
        assert.equal(input.hostRun?.jobId, `job-${original.turnId}`)
        assert.equal(input.prompt, '')
        assert.equal(input.instruction, 'Keep working')
        assert.equal(input.threadId, null)
        input.onUpdate(response(input.turnId, result.response))
        input.onHostRun(binding(input.turnId, { cursor: 3, phase: 'completed' }))
        return result
      },
      cancel: () => assert.fail('Reattach must not cancel'),
    },
    () => assert.fail('Reattach must not fetch or submit new context')
  )
  assert.throws(() => service.send({ text: 'Another job', provider: 'codex' }), /host-recovery-required/)
  service.retry(original.turnId)
  await tick()
  assert.equal(service.snapshot().messages.length, 2)
  assert.equal(service.snapshot().messages.at(-1)?.id, original.turnId)
  assert.equal(service.snapshot().messages.at(-1)?.text, result.response)
  await service.dispose()

  store = new ResidentAgentStore(file)
  service = serviceFor(store, {
    run: async () => {
      calls += 1
      return result
    },
    cancel: () => {},
  })
  service.resumeHost()
  await tick()
  assert.equal(calls, 1, 'Completed durable job is not submitted again on a second restart')
  assert.equal(service.snapshot().messages.length, 2)
  await service.dispose()
})

test('lost submission acknowledgement preserves the original starting binding and retry never creates a second message', async (t) => {
  const store = new ResidentAgentStore(temporary(t))
  let attempts = 0
  const service = serviceFor(store, {
    run: async (input) => {
      attempts += 1
      if (attempts === 1)
        input.onHostRun(binding(input.turnId, { cursor: 0, phase: 'starting', connection: 'connecting' }))
      else assert.equal(input.hostRun?.cursor, 0)
      throw new Error('ack-lost')
    },
    cancel: () => assert.fail('Transport loss is not cancellation'),
  })
  service.send({ text: 'Exactly once', provider: 'codex' })
  await tick()
  const id = service.snapshot().messages.at(-1)?.id ?? ''
  assert.equal(store.hostRun()?.phase, 'starting')
  assert.equal(store.hostRun()?.connection, 'disconnected')
  assert.equal(store.get(id)?.status, 'interrupted')
  service.retry(id)
  await tick()
  assert.equal(attempts, 2)
  assert.equal(service.snapshot().messages.length, 2)
  assert.equal(store.get(id)?.status, 'interrupted')
  await service.dispose()
})

test('privacy invalidation durably requests Stop; an unreachable Stop blocks deletion and resumes stop-only while offline', async (t) => {
  const file = temporary(t)
  let store = new ResidentAgentStore(file)
  let current!: Parameters<ResidentAgentDriver['run']>[0]
  let reject!: (error: Error) => void
  const stops: ResidentHostRun[] = []
  let service = serviceFor(store, {
    run: async (input) => {
      current = input
      input.onHostRun(binding(input.turnId))
      input.onThread('previous-private-thread')
      return new Promise((_resolve, fail) => {
        reject = fail
      })
    },
    detachHost: () => {
      current.onUpdate(response(current.turnId, 'Late forbidden result'))
      reject(new Error('detached'))
    },
    cancel: () => assert.fail('Host uses exact Stop, not local worker cancellation'),
    stopHost: async (run) => {
      stops.push(run)
      assert.equal(store.hostRun()?.contextInvalidated, true)
      assert.equal(store.hostRun()?.stopRequested, true)
      throw new Error('host-stop-unconfirmed')
    },
  })
  service.send({ text: 'Private topic', provider: 'codex' })
  await assert.rejects(service.invalidateContext(), /host-stop-unconfirmed/)
  assert.equal(store.thread('codex'), null)
  assert.deepEqual(store.history(), [])
  assert.equal(store.get(current.turnId)?.text, '')
  assert.equal(store.get(current.turnId)?.status, 'interrupted')
  assert.equal(store.hostRun()?.phase, 'recovery-required')
  await assert.rejects(service.prepareForDeletion(), /host-stop-unconfirmed/)
  await service.dispose()

  store = new ResidentAgentStore(file)
  let availableCalls = 0
  service = createResidentAgentService({
    store,
    changed: () => {},
    context: () => assert.fail('Invalidated context must never be rebuilt'),
    assertAvailable: () => {
      availableCalls += 1
      throw new Error('offline')
    },
    driver: {
      run: async () => assert.fail('Invalidated job must never resume model or client tools'),
      cancel: () => assert.fail('Host Stop must not use local cancellation'),
      stopHost: async (run) => {
        stops.push(run)
      },
    },
  })
  service.resumeHost()
  await tick()
  assert.equal(availableCalls, 0, 'Stop control remains possible when new cloud work is disabled')
  assert.equal(stops.length, 3)
  assert.equal(store.hostRun()?.phase, 'stopped')
  assert.equal(store.get(current.turnId)?.status, 'cancelled')
  await service.prepareForDeletion()
  await service.dispose()
})

test('final event is durable before driver settlement, ignores late updates, and survives immediate quit', async (t) => {
  const file = temporary(t)
  const store = new ResidentAgentStore(file)
  let reject!: (error: Error) => void
  const service = serviceFor(store, {
    run: async (input) => {
      input.onHostRun(binding(input.turnId))
      input.onUpdate(response(input.turnId, result.response))
      input.onHostRun(binding(input.turnId, { cursor: 7, phase: 'completed' }))
      input.onUpdate(response(input.turnId, 'Unexpected stale update'))
      return new Promise((_resolve, fail) => {
        reject = fail
      })
    },
    detachHost: () => reject(new Error('client-detached')),
    cancel: () => assert.fail('A completed host result must not be cancelled'),
  })
  service.send({ text: 'Final response', provider: 'codex' })
  assert.equal(store.hostRun()?.cursor, 7)
  assert.equal(service.snapshot().messages.at(-1)?.text, result.response)
  assert.equal(service.snapshot().messages.at(-1)?.status, 'completed')
  await service.dispose()
  const restarted = new ResidentAgentStore(file)
  assert.equal(restarted.hostRun()?.cursor, 7)
  assert.equal(restarted.conversation(null).messages.at(-1)?.text, result.response)
  assert.equal(restarted.conversation(null).activeTurnId, null)
  restarted.close()
})

test('a completed binding with an incomplete message is reconciled on the same message', async (t) => {
  const store = new ResidentAgentStore(temporary(t))
  const turn = store.start('Recover projection', 'codex')
  store.persistHostRun(binding(turn.id, { cursor: 4, phase: 'completed' }), { ...patch, status: 'completed' })
  store.update(turn.id, { ...patch, status: 'interrupted' })
  let calls = 0
  const service = serviceFor(store, {
    run: async (input) => {
      calls += 1
      assert.equal(input.hostRun?.phase, 'completed')
      // Snapshot reconciliation can return a terminal result without replaying already acknowledged events.
      return result
    },
    cancel: () => {},
  })
  assert.throws(
    () => service.send({ text: 'Cannot skip projection recovery', provider: 'codex' }),
    /host-recovery-required/
  )
  service.resumeHost()
  await tick()
  assert.equal(calls, 1)
  assert.equal(store.get(turn.id)?.status, 'completed')
  assert.equal(store.get(turn.id)?.text, result.response)
  assert.equal(service.snapshot().messages.length, 2)
  await service.dispose()
})

test('reattaching preserves earlier durable work steps alongside only the new streamed steps', async (t) => {
  const store = new ResidentAgentStore(temporary(t))
  const turn = store.start('Do two steps', 'codex')
  const before = { id: 'before', kind: 'status' as const, text: 'First step', at: 1 }
  const after = { id: 'after', kind: 'status' as const, text: 'Second step', at: 2 }
  store.persistHostRun(binding(turn.id), { ...patch, steps: [before] })
  const service = serviceFor(store, {
    run: async (input) => {
      input.onUpdate({
        type: 'status',
        turnId: input.turnId,
        provider: 'codex',
        id: after.id,
        text: after.text,
        at: after.at,
      })
      input.onUpdate(response(input.turnId, result.response))
      input.onHostRun(binding(input.turnId, { cursor: 3, phase: 'completed' }))
      return { ...result, steps: [after] }
    },
    cancel: () => {},
  })
  service.resumeHost()
  await tick()
  assert.deepEqual(store.get(turn.id)?.steps, [before, after])
  await service.dispose()
})

test('explicit Stop disconnects a running client before exact remote Stop and rejects late callback data', async (t) => {
  const store = new ResidentAgentStore(temporary(t))
  let current!: Parameters<ResidentAgentDriver['run']>[0]
  let reject!: (error: Error) => void
  const operations: string[] = []
  const service = serviceFor(store, {
    run: async (input) => {
      current = input
      input.onHostRun(binding(input.turnId))
      input.onUpdate(response(input.turnId, 'Visible partial answer'))
      return new Promise((_resolve, fail) => {
        reject = fail
      })
    },
    detachHost: () => {
      operations.push('detach')
      assert.equal(store.hostRun()?.stopRequested, true)
      current.onUpdate(response(current.turnId, 'Unexpected late answer'))
      current.onHostRun(binding(current.turnId, { cursor: 5, phase: 'completed' }))
      reject(new Error('detached'))
    },
    stopHost: async (run) => {
      operations.push('stop')
      assert.equal(run.messageId, current.turnId)
      assert.equal(run.cursor, 1)
      assert.equal(run.stopRequested, true)
    },
    cancel: () => assert.fail('Legacy cancellation must not own a host job'),
  })
  service.send({ text: 'Stop when asked', provider: 'codex' })
  await service.cancel()
  assert.deepEqual(operations, ['detach', 'stop'])
  assert.equal(store.hostRun()?.phase, 'stopped')
  assert.equal(store.get(current.turnId)?.status, 'cancelled')
  assert.equal(store.get(current.turnId)?.text, 'Visible partial answer')
  await service.dispose()
})

test('startup policy changes mark persisted host context before Stop, and unsupported Stop cannot claim success', async (t) => {
  const file = temporary(t)
  let store = new ResidentAgentStore(file)
  store.synchronizePolicy('old-policy')
  const turn = store.start('Previously allowed context', 'codex')
  store.persistHostRun(binding(turn.id), patch)
  store.close()
  store = new ResidentAgentStore(file)
  const service = serviceFor(store, {
    run: async () => assert.fail('Changed context may not resume'),
    cancel: () => assert.fail('No local process owns the host job'),
  })
  await assert.rejects(service.setContextPolicy('new-policy'), /host-stop-unconfirmed/)
  assert.equal(store.hostRun()?.contextInvalidated, true)
  assert.equal(store.hostRun()?.stopRequested, true)
  assert.equal(store.hostRun()?.phase, 'recovery-required')
  assert.equal(store.get(turn.id)?.status, 'interrupted')
  await assert.rejects(service.prepareForDeletion(), /host-stop-unconfirmed/)
  await service.dispose()
  const restarted = new ResidentAgentStore(file)
  assert.equal(restarted.hostRun()?.contextInvalidated, true)
  assert.equal(restarted.hostRun()?.stopRequested, true)
  restarted.close()
})

test('Stop racing a completed host job preserves the authoritative result instead of claiming it was cancelled', async (t) => {
  const file = temporary(t)
  const store = new ResidentAgentStore(file)
  const turn = store.start('Finishing just before Stop', 'codex')
  store.persistHostRun(binding(turn.id, { connection: 'disconnected' }), patch)
  let stops = 0
  const service = serviceFor(store, {
    run: async () => assert.fail('Stop reconciliation must not start or resume model execution'),
    cancel: () => {},
    stopHost: async (run) => {
      stops += 1
      assert.equal(run.jobId, `job-${turn.id}`)
      return { phase: 'completed', response: 'Actually finished on the host' }
    },
  })
  await service.cancel()
  assert.equal(stops, 1)
  assert.equal(store.hostRun()?.phase, 'completed')
  assert.equal(store.get(turn.id)?.status, 'completed')
  assert.equal(store.get(turn.id)?.text, 'Actually finished on the host')
  await service.dispose()
  const restarted = new ResidentAgentStore(file)
  assert.equal(restarted.get(turn.id)?.text, 'Actually finished on the host')
  assert.equal(restarted.get(turn.id)?.status, 'completed')
  restarted.close()
})

test('privacy invalidation preserves terminal ownership but cannot import a newly completed private response', async (t) => {
  for (const invalidateDuringStop of [false, true]) {
    const file = temporary(t)
    const store = new ResidentAgentStore(file)
    const turn = store.start('Context later withdrawn', 'codex')
    store.persistHostRun(binding(turn.id, { connection: 'disconnected' }), patch)
    let finishStop!: (outcome: { phase: 'completed'; response: string }) => void
    const service = serviceFor(store, {
      run: async () => assert.fail('Private context must not resume'),
      cancel: () => {},
      stopHost: async () =>
        new Promise((resolve) => {
          finishStop = resolve
        }),
    })
    const stopping = invalidateDuringStop ? service.cancel() : service.invalidateContext()
    const invalidating = invalidateDuringStop ? service.invalidateContext() : stopping
    finishStop({ phase: 'completed', response: 'New private result [Saved page](/wiki/?space=private&slug=secret)' })
    await Promise.all([stopping, invalidating])
    assert.equal(store.hostRun()?.phase, 'completed')
    assert.equal(store.hostRun()?.contextInvalidated, true)
    assert.equal(store.get(turn.id)?.text, patch.text, 'Only the existing local archive remains visible')
    assert.equal(store.get(turn.id)?.status, 'completed')
    assert.deepEqual(store.get(turn.id)?.results, [])
    assert.deepEqual(store.history(), [])
    await service.dispose()
    const restarted = new ResidentAgentStore(file)
    assert.equal(restarted.get(turn.id)?.text, patch.text)
    assert.deepEqual(restarted.get(turn.id)?.results, [])
    assert.equal(restarted.hostRun()?.contextInvalidated, true)
    restarted.close()
  }
})

test('driver completion without host terminal confirmation cannot silently clear ownership or claim success', async (t) => {
  const store = new ResidentAgentStore(temporary(t))
  const service = serviceFor(store, {
    run: async (input) => {
      input.onHostRun(binding(input.turnId))
      return result
    },
    cancel: () => {},
  })
  service.send({ text: 'Needs host confirmation', provider: 'codex' })
  await tick()
  assert.equal(store.hostRun()?.phase, 'running')
  assert.equal(store.hostRun()?.connection, 'disconnected')
  assert.equal(service.snapshot().messages.at(-1)?.status, 'interrupted')
  assert.match(service.snapshot().messages.at(-1)?.error ?? '', /result-unconfirmed/)
  await service.dispose()
})

test('Stop during a pre-submission handshake rejects a late first binding before the driver can submit', async (t) => {
  const store = new ResidentAgentStore(temporary(t))
  let finishHandshake!: () => void
  let submitted = false
  const service = serviceFor(store, {
    run: async (input) => {
      await new Promise<void>((resolve) => {
        finishHandshake = resolve
      })
      input.onHostRun(binding(input.turnId, { cursor: 0, phase: 'starting' }))
      submitted = true
      return result
    },
    cancel: () => finishHandshake(),
  })
  service.send({ text: 'Cancel before dispatch', provider: 'codex' })
  await service.cancel()
  assert.equal(submitted, false)
  assert.equal(store.hostRun(), null)
  assert.equal(service.snapshot().messages.at(-1)?.status, 'cancelled')
  await service.dispose()
})
