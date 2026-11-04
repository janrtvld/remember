import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { WikiPage, WikiSpace } from '@remember/shared'
import type { AgentContextSnapshot } from '../agentContextService'
import { validateResidentMemorySources } from '../residentAgentMemory'
import { createResidentAgentService } from '../residentAgentService'
import { ResidentAgentStore, type ResidentHostRun } from '../residentAgentStore'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

function storedHost(t: { after: (callback: () => void) => void }) {
  const directory = mkdtempSync(path.join(tmpdir(), 'remember-host-source-validation-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'chat.sqlite')
  const store = new ResidentAgentStore(file)
  const turn = store.start('Read the team Space', 'codex')
  const binding: ResidentHostRun = {
    jobId: turn.id,
    messageId: turn.id,
    endpoint: 'tcp://127.0.0.1:47833',
    cursor: 1,
    phase: 'running',
    connection: 'disconnected',
  }
  store.persistHostRun(binding, { text: '', steps: [], status: 'streaming' })
  return { file, store, turn, binding }
}

test('reopening a host job validates stored memory sources before importing a completed response', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'remember-host-source-validation-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'chat.sqlite')
  let store = new ResidentAgentStore(file)
  const turn = store.start('Read the team Space', 'codex')
  store.recordMemorySources([{ spaceId: 'team', slug: 'private-plan', revision: 'r1' }])
  const binding: ResidentHostRun = {
    jobId: turn.id,
    messageId: turn.id,
    endpoint: 'tcp://127.0.0.1:47833',
    cursor: 1,
    phase: 'running',
    connection: 'connected',
  }
  store.persistHostRun(binding, { text: '', steps: [], status: 'streaming' })
  store.close()
  store = new ResidentAgentStore(file)
  const operations: string[] = []
  const service = createResidentAgentService({
    store,
    context: () => assert.fail('Resume cannot prepare a new prompt'),
    assertAvailable: () => {},
    changed: () => {},
    validateHostContext: async () => {
      operations.push('validate')
      return 'invalidated' as const
    },
    driver: {
      cancel: () => assert.fail('Legacy cancellation does not own a host job'),
      run: async (input) => {
        operations.push('attach')
        input.onUpdate({
          turnId: turn.id,
          provider: 'codex',
          type: 'response',
          id: 'private',
          text: 'REVOKED_PRIVATE_CONTENT',
          at: 1,
        })
        input.onHostRun({ ...binding, phase: 'completed' })
        return { provider: 'codex', response: 'REVOKED_PRIVATE_CONTENT', durationMs: 1, steps: [] }
      },
      stopHost: async (current) => {
        operations.push('stop')
        assert.equal(current.jobId, binding.jobId)
        assert.equal(current.contextInvalidated, true)
        return { phase: 'completed' as const, response: 'REVOKED_PRIVATE_CONTENT' }
      },
    },
  })
  service.resumeHost()
  await tick()
  assert.deepEqual(operations, ['validate', 'stop'])
  assert.equal(store.get(turn.id)?.text, '')
  assert.equal(store.hostRun()?.contextInvalidated, true)
  assert.equal(store.hostRun()?.stopRequested, true)
  assert.equal(store.hostRun()?.phase, 'completed')
  await service.dispose()
})

test('unavailable source validation pauses recovery, then reattaches the same job after a fresh retry', async (t) => {
  const { store, turn, binding } = storedHost(t)
  let available = false
  let attachments = 0
  const service = createResidentAgentService({
    store,
    context: () => assert.fail('No prompt regeneration on resume'),
    assertAvailable: () => {},
    changed: () => {},
    validateHostContext: async () => (available ? 'valid' : 'unavailable'),
    driver: {
      cancel: () => {},
      run: async (input) => {
        attachments++
        assert.equal(input.hostRun?.jobId, binding.jobId)
        assert.equal(input.prompt, '')
        assert(input.hostRun)
        input.onHostRun({ ...input.hostRun, phase: 'completed' })
        return { provider: 'codex', response: 'Validated result', durationMs: 1, steps: [] }
      },
    },
  })
  service.resumeHost()
  await tick()
  assert.equal(attachments, 0)
  assert.equal(store.hostRun()?.phase, 'recovery-required')
  assert.equal(store.hostRun()?.contextInvalidated, undefined)
  assert.equal(store.hostRun()?.stopRequested, undefined)
  assert.equal(store.get(turn.id)?.error, 'assistant-host-context-unavailable')
  available = true
  service.retry(turn.id)
  await tick()
  assert.equal(attachments, 1)
  assert.equal(store.get(turn.id)?.text, 'Validated result')
  assert.equal(store.conversation(null).messages.length, 2)
  await service.dispose()
})

test('quitting while source validation waits detaches without a late host attachment or Stop', async (t) => {
  const { store } = storedHost(t)
  let validate!: (value: 'valid') => void
  let detaches = 0
  const service = createResidentAgentService({
    store,
    context: () => assert.fail('No prompt preparation'),
    assertAvailable: () => {},
    changed: () => {},
    validateHostContext: () =>
      new Promise((resolve) => {
        validate = resolve
      }),
    driver: {
      cancel: () => assert.fail('No local cancellation'),
      detachHost: () => {
        detaches++
      },
      run: async () => assert.fail('Quit must prevent late attachment'),
      stopHost: async () => assert.fail('Quit does not request Stop'),
    },
  })
  service.resumeHost()
  await tick()
  await Promise.race([
    service.dispose(),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('quit-waited-for-source-network')), 100)
      timer.unref()
    }),
  ])
  validate('valid')
  await tick()
  assert.equal(detaches, 1)
})

test('explicit Stop does not wait for an unresolved source refresh or attach after it resolves', async (t) => {
  const { store } = storedHost(t)
  let validate!: (value: 'valid') => void
  let stops = 0
  const service = createResidentAgentService({
    store,
    context: () => '',
    assertAvailable: () => {},
    changed: () => {},
    validateHostContext: () =>
      new Promise((resolve) => {
        validate = resolve
      }),
    driver: {
      cancel: () => {},
      detachHost: () => {},
      run: async () => assert.fail('Cannot attach after Stop'),
      stopHost: async () => {
        stops++
      },
    },
  })
  service.resumeHost()
  await tick()
  await Promise.race([
    service.cancel(),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('stop-waited-for-source-network')), 100)
      timer.unref()
    }),
  ])
  assert.equal(stops, 1)
  assert.equal(store.hostRun()?.phase, 'stopped')
  validate('valid')
  await tick()
  assert.equal(store.hostRun()?.phase, 'stopped')
  await service.dispose()
})

test('one total deadline bounds source validation and rejects a late successful refresh', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { store, turn } = storedHost(t)
  let signal: AbortSignal | undefined
  let validate!: (value: 'valid') => void
  const service = createResidentAgentService({
    store,
    context: () => '',
    assertAvailable: () => {},
    changed: () => {},
    validateHostContext: (current) => {
      signal = current
      return new Promise((resolve) => {
        validate = resolve
      })
    },
    driver: { cancel: () => {}, run: async () => assert.fail('No attachment after the validation deadline') },
  })
  service.resumeHost()
  await tick()
  t.mock.timers.tick(10_000)
  await tick()
  assert.equal(signal?.aborted, true)
  assert.equal(store.hostRun()?.phase, 'recovery-required')
  assert.equal(store.get(turn.id)?.error, 'assistant-host-context-unavailable')
  validate('valid')
  await tick()
  assert.equal(store.hostRun()?.phase, 'recovery-required')
  await service.dispose()
})

test('Stop confirms a completed host but withholds its result until current source access can be verified', async (t) => {
  const { file, store, turn } = storedHost(t)
  let available = false
  let imports = 0
  const options = {
    context: () => assert.fail('No new prompt'),
    assertAvailable: () => {},
    changed: () => {},
    validateHostContext: async () => (available ? ('valid' as const) : ('unavailable' as const)),
    driver: {
      cancel: () => {},
      run: async (input: Parameters<import('../residentAgentService').ResidentAgentDriver['run']>[0]) => {
        imports++
        assert(input.hostRun)
        input.onHostRun({ ...input.hostRun, phase: 'completed' })
        return { provider: 'codex' as const, response: 'PRIVATE_RESULT', durationMs: 1, steps: [] }
      },
      stopHost: async () => ({ phase: 'completed' as const, response: 'PRIVATE_RESULT' }),
    },
  }
  let service = createResidentAgentService({ ...options, store })
  await service.cancel()
  assert.equal(store.hostRun()?.phase, 'completed')
  assert.equal(store.hostRun()?.contextInvalidated, undefined)
  assert.equal(store.get(turn.id)?.text, '')
  assert.equal(store.get(turn.id)?.error, 'assistant-host-context-unavailable')
  assert.throws(
    () => service.send({ provider: 'codex', text: 'Start a different task' }),
    /assistant-host-recovery-required/
  )
  assert.equal(store.conversation(null).messages.length, 2)
  await service.dispose()
  const reopened = new ResidentAgentStore(file)
  service = createResidentAgentService({ ...options, store: reopened })
  service.resumeHost()
  await tick()
  assert.equal(imports, 0)
  assert.equal(reopened.get(turn.id)?.text, '')
  available = true
  service.retry(turn.id)
  await tick()
  assert.equal(imports, 0, 'A completed Stop reconciliation does not reattach or start the worker')
  assert.equal(reopened.get(turn.id)?.text, 'PRIVATE_RESULT')
  assert.equal(reopened.get(turn.id)?.error, null)
  await service.dispose()
})

test('direct Stop cannot import a completed response after its source was revoked while the client was closed', async (t) => {
  const { store, turn } = storedHost(t)
  const service = createResidentAgentService({
    store,
    context: () => '',
    assertAvailable: () => {},
    changed: () => {},
    validateHostContext: async () => 'invalidated',
    driver: {
      cancel: () => {},
      run: async () => assert.fail('No attachment'),
      stopHost: async () => ({ phase: 'completed', response: 'REVOKED_PRIVATE_CONTENT' }),
    },
  })
  await service.cancel()
  assert.equal(store.hostRun()?.phase, 'completed')
  assert.equal(store.hostRun()?.contextInvalidated, true)
  assert.equal(store.get(turn.id)?.text, '')
  await service.dispose()
})

test('an unreachable recheck preserves a completed withheld result without an invalid terminal transition', async (t) => {
  const { store, turn, binding } = storedHost(t)
  store.persistHostRun(
    { ...binding, phase: 'completed', stopRequested: true },
    {
      text: 'Earlier visible text',
      steps: [],
      status: 'completed',
      error: 'assistant-host-context-unavailable',
    }
  )
  const persistenceErrors: string[] = []
  const persist = store.persistHostRun.bind(store)
  store.persistHostRun = (next, patch) => {
    try {
      persist(next, patch)
    } catch (error) {
      persistenceErrors.push(String(error))
      throw error
    }
  }
  let connected = false
  let checks = 0
  const service = createResidentAgentService({
    store,
    context: () => assert.fail('No new prompt'),
    assertAvailable: () => {},
    changed: () => {},
    validateHostContext: async () => 'valid',
    driver: {
      cancel: () => {},
      run: async () => assert.fail('No new attachment or execution'),
      stopHost: async (current) => {
        checks++
        assert.equal(current.jobId, binding.jobId)
        if (!connected) throw new Error('host-connection-closed')
        return { phase: 'completed', response: 'Verified final result' }
      },
    },
  })
  service.retry(turn.id)
  await tick()
  assert.deepEqual(persistenceErrors, [], 'Network failure cannot rewrite an authoritative terminal phase')
  assert.equal(store.hostRun()?.phase, 'completed')
  assert.equal(store.hostRun()?.connection, 'disconnected')
  assert.equal(store.get(turn.id)?.text, 'Earlier visible text')
  assert.equal(store.get(turn.id)?.error, 'assistant-host-context-unavailable')
  assert.throws(() => service.send({ provider: 'codex', text: 'Another job' }), /host-recovery-required/)
  connected = true
  service.retry(turn.id)
  await tick()
  assert.equal(checks, 2)
  assert.equal(store.get(turn.id)?.text, 'Verified final result')
  assert.equal(store.get(turn.id)?.error, null)
  assert.equal(store.conversation(null).messages.length, 2)
  await service.dispose()
})

test('an account invalidation event with the old fingerprint still fences the host before a disconnected Stop', async (t) => {
  const { file, store } = storedHost(t)
  store.synchronizePolicy('old-account')
  let stops = 0
  const service = createResidentAgentService({
    store,
    context: () => '',
    assertAvailable: () => {},
    changed: () => {},
    driver: {
      cancel: () => assert.fail('No legacy process'),
      run: async () => assert.fail('Invalid account may not reattach'),
      stopHost: async () => {
        stops++
        throw new Error('host-unreachable')
      },
    },
  })
  const invalidating = service.invalidateContext()
  assert.equal(store.hostRun()?.contextInvalidated, true)
  assert.equal(store.hostRun()?.stopRequested, true)
  await assert.rejects(invalidating, /host-unreachable/)
  await service.setContextPolicy('old-account')
  assert.equal(stops, 1, 'The early account notification cannot rely on a changed fingerprint')
  await assert.rejects(service.setContextPolicy('signed-out'), /host-unreachable/)
  assert.equal(store.hostRun()?.phase, 'recovery-required')
  await service.dispose()
  const reopened = new ResidentAgentStore(file)
  assert.equal(reopened.hostRun()?.contextInvalidated, true)
  assert.equal(reopened.hostRun()?.stopRequested, true)
  assert.equal(reopened.hostRun()?.phase, 'recovery-required')
  reopened.close()
})

const source = { spaceId: 'team', slug: 'plan', revision: 'r1' }
const space: WikiSpace = {
  id: 'team',
  name: 'Team',
  description: '',
  icon: 'book',
  color: 'slate',
  maintenanceMode: 'auto',
}
const page: WikiPage = {
  slug: 'plan',
  title: 'Plan',
  content: 'Private plan',
  excerpt: '',
  revision: 'r1',
  sourceCount: 0,
  updatedAt: 1,
}
const snapshot: AgentContextSnapshot = { state: 'fresh', checkedAt: 1, pages: [page] }

test('source validation distinguishes removed or revised local sources from failed reads', async () => {
  const cases: {
    name: string
    spaces?: WikiSpace[]
    snapshot?: AgentContextSnapshot
    permitted?: boolean
    expected: string
  }[] = [
    { name: 'matching fresh source', expected: 'valid' },
    { name: 'Space removed', spaces: [], expected: 'invalidated' },
    { name: 'page deleted', snapshot: { ...snapshot, pages: [] }, expected: 'invalidated' },
    { name: 'page revised', snapshot: { ...snapshot, pages: [{ ...page, revision: 'r2' }] }, expected: 'invalidated' },
    { name: 'source excluded', permitted: false, expected: 'invalidated' },
    { name: 'cached', snapshot: { ...snapshot, state: 'cached' }, expected: 'unavailable' },
    { name: 'offline', snapshot: { ...snapshot, state: 'offline' }, expected: 'unavailable' },
    { name: 'refresh failed', snapshot: { ...snapshot, state: 'error' }, expected: 'unavailable' },
  ]
  for (const entry of cases) {
    const result = await validateResidentMemorySources([source], {
      spaces: () => entry.spaces ?? [space],
      read: async () => entry.snapshot ?? snapshot,
      pagePermitted: () => entry.permitted ?? true,
      assertAvailable: () => {},
    })
    assert.equal(result, entry.expected, entry.name)
  }
})

test('validation rechecks access after awaited reads and preserves explicit scoped access without reading unrelated Spaces', async () => {
  let spaces = [space]
  const visited: string[] = []
  const dependencies = {
    spaces: () => spaces,
    read: async (id: string) => {
      visited.push(id)
      spaces = []
      return snapshot
    },
    pagePermitted: () => false,
    assertAvailable: () => {},
  }
  assert.equal(await validateResidentMemorySources([source], dependencies), 'invalidated')
  assert.deepEqual(visited, ['team'])
  spaces = [space]
  assert.equal(
    await validateResidentMemorySources([{ ...source, explicit: true }], {
      ...dependencies,
      read: async () => snapshot,
    }),
    'valid'
  )
  assert.equal(
    await validateResidentMemorySources([source], {
      ...dependencies,
      read: async () => {
        throw new Error('network-down')
      },
    }),
    'unavailable'
  )
})

test('an approved own revision and its receipt commit atomically and validate after reopening', async (t) => {
  const { file, store, turn } = storedHost(t)
  store.recordMemorySources([{ ...source, explicit: true }])
  const receipt = {
    kind: 'saved-page',
    saved: true,
    proposed: false,
    spaceId: 'team',
    slug: 'plan',
    revision: 'r2',
    title: 'Plan',
  }
  store.claimToolCall('call', 'hash', { messageId: turn.id, toolName: 'remember_memory' })
  const database = new DatabaseSync(file)
  database.exec(`CREATE TRIGGER reject_source_revision BEFORE UPDATE ON assistant_memory_source
    BEGIN SELECT RAISE(ABORT, 'test-source-write-failure'); END;`)
  assert.throws(() => store.finishToolCall('call', receipt, { expectedRevision: 'r1' }), /test-source-write-failure/)
  assert.deepEqual(store.claimToolCall('call', 'hash'), { existing: true, result: null })
  assert.equal(store.memorySources()[0]?.revision, 'r1')
  database.exec('DROP TRIGGER reject_source_revision')
  database.close()
  store.finishToolCall('call', receipt, { expectedRevision: 'r1' })
  store.finishToolCall('call', receipt, { expectedRevision: 'r1' })
  store.close()
  const reopened = new ResidentAgentStore(file)
  assert.deepEqual(reopened.memorySources(), [{ ...source, revision: 'r2', explicit: true }])
  assert.equal(reopened.get(turn.id)?.results?.length, 1)
  assert.equal(
    await validateResidentMemorySources(reopened.memorySources(), {
      spaces: () => [space],
      read: async () => ({ ...snapshot, pages: [{ ...page, revision: 'r2' }] }),
      assertAvailable: () => {},
      pagePermitted: () => false,
    }),
    'valid'
  )
  reopened.close()
})

test('a saved receipt cannot create a source or advance a different previously observed revision', (t) => {
  const { store, turn } = storedHost(t)
  const receipt = {
    kind: 'saved-page',
    saved: true,
    proposed: false,
    spaceId: 'team',
    slug: 'plan',
    revision: 'r2',
    title: 'Plan',
  }
  store.claimToolCall('untracked', 'hash', { messageId: turn.id, toolName: 'remember_memory' })
  store.finishToolCall('untracked', receipt, { expectedRevision: 'r1' })
  assert.deepEqual(store.memorySources(), [])
  store.recordMemorySources([{ ...source, revision: 'r0' }])
  store.claimToolCall('different-revision', 'hash', { messageId: turn.id, toolName: 'remember_memory' })
  store.finishToolCall('different-revision', receipt, { expectedRevision: 'r1' })
  assert.equal(store.memorySources()[0]?.revision, 'r0')
  store.claimToolCall('proposed', 'hash', { messageId: turn.id, toolName: 'remember_memory' })
  assert.throws(
    () => store.finishToolCall('proposed', { saved: false, proposed: true }, { expectedRevision: 'r0' }),
    /source-receipt-invalid/
  )
  assert.equal(store.memorySources()[0]?.revision, 'r0')
  store.close()
})
