import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createResidentAgentService } from '../residentAgentService'
import { ResidentAgentStore, type ResidentHostRun } from '../residentAgentStore'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const message = { text: 'Existing answer', steps: [], status: 'cancelled' as const }
const marker = 'assistant-host-request-expired'
function setup(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'remember-host-expiry-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'conversation.sqlite')
  const store = new ResidentAgentStore(file)
  const turn = store.start('One request', 'codex')
  const binding: ResidentHostRun = {
    messageId: turn.id,
    jobId: 'job-one',
    endpoint: 'tcp://127.0.0.1:47833',
    cursor: 50,
    phase: 'stopped',
    connection: 'connected',
    stopReason: 'request-expired',
  }
  return { file, store, turn, binding }
}

test('confirmed deadline reason persists atomically on the message and remains historical after the next host job', async (t) => {
  const { file, store, turn, binding } = setup(t)
  store.claimToolCall('claimed-write', 'hash', { messageId: turn.id, toolName: 'remember_memory' })
  store.persistHostRun(binding, message)
  assert.equal(store.get(turn.id)?.error, marker)
  assert.equal(store.conversation(null).hostJob?.stopReason, 'request-expired')
  store.persistHostRun({ ...binding, stopReason: undefined, connection: 'disconnected' }, { ...message, error: null })
  assert.equal(store.get(turn.id)?.error, marker, 'Late updates must not erase the confirmed reason')
  const next = store.start('A new explicit request', 'codex')
  store.persistHostRun(
    { ...binding, jobId: 'job-two', messageId: next.id, stopReason: undefined, phase: 'completed' },
    { ...message, status: 'completed' }
  )
  assert.equal(store.get(turn.id)?.error, marker)
  assert.equal(store.conversation(null).hostJob?.stopReason, undefined)
  store.close()
  const reopened = new ResidentAgentStore(file)
  let calls = 0
  const service = createResidentAgentService({
    store: reopened,
    context: () => '',
    assertAvailable: () => {},
    changed: () => {},
    driver: {
      run: async () => {
        calls++
        throw new Error('Unexpected dispatch')
      },
      cancel() {},
    },
  })
  assert.equal(service.snapshot().messages.find((entry) => entry.id === turn.id)?.error, marker)
  assert.throws(() => service.retry(turn.id), /message-not-retryable/)
  assert.equal(calls, 0)
  assert.equal(
    reopened.claimToolCall('claimed-write', 'hash', { messageId: turn.id, toolName: 'remember_memory' }).result,
    null
  )
  await service.dispose()
})

test('an expired request with unconfirmed Stop remains recovery-required with its actual error until Stop succeeds', async (t) => {
  const { file, store, turn, binding } = setup(t)
  const uncertain = {
    ...binding,
    phase: 'recovery-required' as const,
    connection: 'disconnected' as const,
    stopRequested: true,
  }
  store.persistHostRun(uncertain, { ...message, status: 'interrupted', error: 'host-unreachable' })
  assert.equal(store.get(turn.id)?.error, 'host-unreachable')
  store.close()
  const reopened = new ResidentAgentStore(file)
  let available = false
  const service = createResidentAgentService({
    store: reopened,
    context: () => assert.fail('Recovery cannot request new context'),
    assertAvailable() {},
    changed() {},
    driver: {
      run: async () => assert.fail('Recovery cannot start a provider turn'),
      cancel() {},
      stopHost: async () => {
        if (!available) throw new Error('host-unreachable')
        return { phase: 'stopped', stopReason: 'request-expired' }
      },
    },
  })
  await assert.rejects(service.cancel(), /host-unreachable/)
  assert.equal(service.snapshot().hostJob?.phase, 'recovery-required')
  assert.equal(service.snapshot().hostJob?.stopReason, 'request-expired')
  assert.equal(reopened.get(turn.id)?.error, 'host-unreachable')
  available = true
  await service.cancel()
  assert.equal(service.snapshot().hostJob?.phase, 'stopped')
  assert.equal(reopened.get(turn.id)?.error, marker)
  await service.dispose()
})

test('old manual cancellations and completed races never receive the expired Stop message', async (t) => {
  const { store, turn, binding } = setup(t)
  store.persistHostRun({ ...binding, stopReason: undefined }, message)
  assert.equal(store.get(turn.id)?.error, null)
  const next = store.start('Explicit next request', 'codex')
  store.persistHostRun(
    { ...binding, jobId: 'job-two', messageId: next.id, phase: 'completed' },
    { ...message, status: 'completed' }
  )
  assert.equal(store.get(next.id)?.error, null)
  store.close()
})

test('an active driver deadline result uses the same persisted reason without repeating the task', async (t) => {
  const { store, turn, binding } = setup(t)
  store.persistHostRun({ ...binding, phase: 'running', stopReason: undefined }, { ...message, status: 'streaming' })
  let calls = 0
  const service = createResidentAgentService({
    store,
    context: () => assert.fail('Existing host has no new prompt'),
    assertAvailable() {},
    changed() {},
    driver: {
      run: async (input) => {
        calls++
        input.onHostRun(binding)
        throw new Error('agent-cancelled')
      },
      cancel() {},
    },
  })
  service.resumeHost()
  await tick()
  assert.equal(store.get(turn.id)?.error, marker)
  assert.equal(service.snapshot().hostJob?.stopReason, 'request-expired')
  service.retry(turn.id)
  await tick()
  assert.equal(calls, 1)
  await service.dispose()
})

test('a newly observed deadline reason survives failed Stop and restart without a false terminal message', async (t) => {
  const { file, store, turn, binding } = setup(t)
  store.persistHostRun(
    { ...binding, phase: 'recovery-required', stopReason: undefined },
    { ...message, status: 'interrupted', error: 'host-disconnected' }
  )
  const service = createResidentAgentService({
    store,
    context: () => assert.fail('No new context'),
    assertAvailable() {},
    changed() {},
    driver: {
      run: async () => assert.fail('No provider turn'),
      cancel() {},
      stopHost: async (_binding, onStopReason) => {
        onStopReason?.('request-expired')
        throw new Error('provider-stop-unreachable')
      },
    },
  })
  await assert.rejects(service.cancel(), /provider-stop-unreachable/)
  assert.equal(service.snapshot().hostJob?.phase, 'recovery-required')
  assert.equal(service.snapshot().hostJob?.stopReason, 'request-expired')
  assert.equal(store.get(turn.id)?.error, 'provider-stop-unreachable')
  await service.dispose()
  const reopened = new ResidentAgentStore(file)
  assert.equal(reopened.hostRun()?.stopReason, 'request-expired')
  assert.equal(reopened.hostRun()?.phase, 'recovery-required')
  assert.equal(reopened.get(turn.id)?.status, 'interrupted')
  assert.equal(reopened.get(turn.id)?.error, 'provider-stop-unreachable')
  reopened.close()
})
