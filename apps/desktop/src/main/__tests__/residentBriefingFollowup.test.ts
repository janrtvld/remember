import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { createResidentAgentService, type ResidentAgentDriver } from '../residentAgentService'
import { ResidentAgentStore } from '../residentAgentStore'
import type { BriefingReplyReference } from '../residentReplyContext'
import { createResidentToolFreeChatDriver } from '../residentToolFreeChat'

const reference: BriefingReplyReference = {
  actionId: 'action-A',
  messageId: 'briefing-A',
  resultId: 'result-A',
  resultHash: 'a'.repeat(64),
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

function fixture(t: { after(fn: () => Promise<void>): void }, actualDriver?: ResidentAgentDriver) {
  const directory = mkdtempSync('/private/tmp/rpa5-service-')
  const store = new ResidentAgentStore(join(directory, 'chat.sqlite'))
  // Storage has its own real SQLite contrasts. These tests isolate the service's publication boundary.
  const refs = new Map<string, BriefingReplyReference[]>()
  let valid = true,
    storageFailure = false,
    supplied = [reference]
  Object.assign(store, {
    replyContext: (id: string) => structuredClone(refs.get(id) ?? []),
    recordReplyContext: (id: string, values: BriefingReplyReference[]) => {
      if (storageFailure) throw new Error('assistant-reply-context-write-failed')
      refs.set(id, structuredClone(values))
    },
  })
  const calls: Parameters<ResidentAgentDriver['run']>[0][] = []
  let finish!: (value: Awaited<ReturnType<ResidentAgentDriver['run']>>) => void
  let held = new Promise<Awaited<ReturnType<ResidentAgentDriver['run']>>>((resolve) => {
    finish = resolve
  })
  const chat = createResidentAgentService({
    store,
    assertAvailable() {},
    changed() {},
    separateTaskActions: true,
    context: () => ({
      text: 'VERIFIED BRIEFING BODY',
      memory: { sources: [], invalidated: false },
      replyContext: {
        references: structuredClone(supplied),
        assertCurrent: () => {
          if (!valid) throw new Error('briefing-source-invalidated')
        },
      },
    }),
    replyContextPermitted: () => valid,
    driver: actualDriver ?? {
      run: (input) => {
        calls.push(input)
        return held
      },
      cancel() {},
    },
  })
  const complete = (text = 'DERIVED PRIVATE ANSWER') =>
    finish({ provider: 'codex', response: text, durationMs: 1, steps: [] })
  t.after(async () => {
    complete()
    await chat.dispose()
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    store,
    chat,
    refs,
    calls,
    complete,
    invalidate: () => {
      valid = false
    },
    restore: () => {
      valid = true
    },
    failStorage: () => {
      storageFailure = true
    },
    setReferences: (value: BriefingReplyReference[]) => {
      supplied = value
    },
    next: () => {
      held = new Promise((resolve) => {
        finish = resolve
      })
    },
  }
}

test('RPA5 ordinary chat admits verified context and commits lineage before model dispatch', async (t) => {
  const f = fixture(t)
  f.chat.send({ text: 'Waarom dit advies?', provider: 'codex' })
  await flush()
  assert.equal(f.calls.length, 1)
  assert.match(f.calls[0].prompt, /VERIFIED BRIEFING BODY/)
  assert.deepEqual(f.refs.get(f.calls[0].turnId), [reference])
  f.complete()
  await flush()
  assert.equal(f.store.get(f.calls[0].turnId)?.status, 'completed')
})

test('RPA5 metadata failure prevents model dispatch', async (t) => {
  const f = fixture(t)
  f.failStorage()
  f.chat.send({ text: 'Waarom?', provider: 'codex' })
  await flush()
  assert.equal(f.calls.length, 0)
  assert.equal(f.chat.snapshot().messages.at(-1)?.status, 'failed')
})

test('RPA5 invalid preparation prevents dispatch', async (t) => {
  const f = fixture(t)
  f.invalidate()
  f.chat.send({ text: 'Waarom?', provider: 'codex' })
  await flush()
  assert.equal(f.calls.length, 0)
  assert.equal(f.chat.snapshot().messages.at(-1)?.text, '')
})

test('RPA5 revoked context refuses streamed private text and reasoning', async (t) => {
  const f = fixture(t)
  f.chat.send({ text: 'Waarom?', provider: 'codex' })
  await flush()
  const call = f.calls[0]
  assert(call)
  f.invalidate()
  assert.throws(
    () =>
      call.onUpdate({
        turnId: call.turnId,
        provider: 'codex',
        type: 'response',
        text: 'LATE SECRET',
        id: 'late',
        at: 1,
      }),
    /context/
  )
  f.complete('LATE SECRET')
  await flush()
  assert.equal(f.store.get(call.turnId)?.text, '')
  assert.deepEqual(f.store.get(call.turnId)?.steps, [])
})

test('RPA5 permission loss before final drops prior streamed output too', async (t) => {
  const f = fixture(t)
  f.chat.send({ text: 'Waarom?', provider: 'codex' })
  await flush()
  const call = f.calls[0]
  call.onUpdate({
    turnId: call.turnId,
    provider: 'codex',
    type: 'reasoning',
    text: 'PRIVATE REASONING',
    id: 'r',
    at: 1,
  })
  f.invalidate()
  f.complete('LATE SECRET')
  await flush()
  assert.equal(f.store.get(call.turnId)?.text, '')
  assert.deepEqual(f.store.get(call.turnId)?.steps, [])
  assert.equal(f.chat.snapshot().messages.at(-1)?.text, '')
})

test('RPA5 later source loss hides completed derived answer from snapshot', async (t) => {
  const f = fixture(t)
  f.chat.send({ text: 'Waarom?', provider: 'codex' })
  await flush()
  f.complete()
  await flush()
  assert.equal(f.chat.snapshot().messages.at(-1)?.text, 'DERIVED PRIVATE ANSWER')
  f.invalidate()
  assert.equal(f.chat.snapshot().messages.at(-1)?.text, '')
  assert.equal(f.chat.snapshot().messages.at(-1)?.error, 'assistant-proactive-source-unavailable')
})

test('current older derivative automatically admits its exact lineage into the continuing conversation', async (t) => {
  const f = fixture(t)
  f.chat.send({ text: 'Waarom?', provider: 'codex' })
  await flush()
  f.complete()
  await flush()
  f.next()
  f.setReferences([])
  f.chat.send({ text: 'En nu?', provider: 'codex' })
  await flush()
  assert.equal(f.calls.length, 2)
  assert(f.calls[1].prompt.includes('DERIVED PRIVATE ANSWER'))
  assert(f.calls[1].prompt.includes('Waarom?'))
  assert.deepEqual(f.refs.get(f.calls[1].turnId), [reference])
})

test('RPA5 exact admitted lineage permits ordinary follow-up history', async (t) => {
  const f = fixture(t)
  f.chat.send({ text: 'Waarom?', provider: 'codex' })
  await flush()
  f.complete()
  await flush()
  f.next()
  f.chat.send({ text: 'Leg dat korter uit', provider: 'codex' })
  await flush()
  assert(f.calls[1].prompt.includes('DERIVED PRIVATE ANSWER'))
  assert.deepEqual(f.refs.get(f.calls[1].turnId), [reference])
})

test('RPA5 a refused update permanently fences this turn even if a dependency returns valid again', async (t) => {
  const f = fixture(t)
  f.chat.send({ text: 'Waarom?', provider: 'codex' })
  await flush()
  const call = f.calls[0]
  f.invalidate()
  assert.throws(
    () =>
      call.onUpdate({
        turnId: call.turnId,
        provider: 'codex',
        type: 'response',
        text: 'LATE SECRET',
        id: 'late',
        at: 1,
      }),
    /context/
  )
  f.restore()
  f.complete('RESTORED SECRET')
  await flush()
  assert.equal(f.store.get(call.turnId)?.text, '')
  assert.equal(f.store.get(call.turnId)?.status, 'failed')
})

for (const replyContext of [
  { references: null, assertCurrent() {} },
  { references: {}, assertCurrent() {} },
  { assertCurrent() {} },
  { references: [] },
]) {
  test('RPA5 malformed internal context refuses dispatch instead of producing an unlinked reply', async () => {
    const directory = mkdtempSync('/private/tmp/rpa5-malformed-')
    const store = new ResidentAgentStore(join(directory, 'chat.sqlite'))
    let calls = 0
    const chat = createResidentAgentService({
      store,
      assertAvailable() {},
      changed() {},
      context: () => ({ text: 'PRIVATE PREPARED BODY', replyContext }) as never,
      driver: {
        async run() {
          calls++
          return { provider: 'codex', response: 'PRIVATE DERIVATIVE', durationMs: 1, steps: [] }
        },
        cancel() {},
      },
    })
    try {
      chat.send({ text: 'Waarom?', provider: 'codex' })
      await flush()
      assert.equal(calls, 0)
      assert.equal(chat.snapshot().messages.at(-1)?.text, '')
    } finally {
      await chat.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })
}

function sdkDispatchFixture(t: { after(fn: () => Promise<void>): void }, invalidateAtLastCheck = false) {
  const cwd = mkdtempSync('/private/tmp/rpa5-dispatch-')
  let releaseEnvironment!: (value: NodeJS.ProcessEnv) => void
  const environment = new Promise<NodeJS.ProcessEnv>((resolve) => {
    releaseEnvironment = resolve
  })
  let sdkCalls = 0
  let capturedInput: Parameters<ResidentAgentDriver['run']>[0] | undefined
  let f!: ReturnType<typeof fixture>
  const driver = createResidentToolFreeChatDriver({
    runtime: () => ({
      cwd,
      executable: '/synthetic/codex',
      model: 'synthetic-model',
      effort: 'low',
      env: environment,
      // This policy remains available when only a Personal source changes.
      assertAvailable() {},
    }),
    createClient: () => ({
      startThread: () => {
        if (invalidateAtLastCheck) f.invalidate()
        return {
          async runStreamed(prompt) {
            sdkCalls++
            assert.match(prompt, /VERIFIED BRIEFING BODY/)
            return {
              events: (async function* () {
                yield { type: 'thread.started' as const, thread_id: 'synthetic-thread' }
                yield {
                  type: 'item.completed' as const,
                  item: { type: 'agent_message' as const, id: 'answer', text: 'COMPOSED DERIVED ANSWER' },
                }
                yield {
                  type: 'turn.completed' as const,
                  usage: {
                    input_tokens: 1,
                    output_tokens: 1,
                    cached_input_tokens: 0,
                    cache_write_input_tokens: 0,
                    reasoning_output_tokens: 0,
                  },
                }
              })(),
            }
          },
        }
      },
    }),
  })
  f = fixture(t, {
    run(input) {
      capturedInput = input
      return driver.run(input)
    },
    cancel: driver.cancel,
  })
  t.after(async () => {
    driver.dispose()
    rmSync(cwd, { recursive: true, force: true })
  })
  return {
    ...f,
    sdkCalls: () => sdkCalls,
    input: () => {
      assert(capturedInput)
      return capturedInput as typeof capturedInput & { assertContextCurrent?: () => void }
    },
    async release() {
      releaseEnvironment({ CODEX_HOME: '/synthetic/auth-home', PATH: '/usr/bin' })
      for (let attempt = 0; attempt < 100 && f.chat.snapshot().activeTurnId; attempt++) await flush()
      assert.equal(f.chat.snapshot().activeTurnId, null, 'Composed service must settle')
    },
  }
}

test('RPA5 composed source guard refuses SDK invocation after held environment resolves', async (t) => {
  const f = sdkDispatchFixture(t)
  f.chat.send({ text: 'Waarom?', provider: 'codex' })
  await flush()
  assert.equal(f.sdkCalls(), 0)
  f.invalidate()
  await f.release()
  assert.equal(f.sdkCalls(), 0, 'No stale prompt may reach SDK runStreamed')
  assert.equal(f.store.get(f.input().turnId)?.text, '')
  assert.deepEqual(f.store.get(f.input().turnId)?.steps, [])
})

test('RPA5 composed source guard is rechecked at the final SDK invocation boundary', async (t) => {
  const f = sdkDispatchFixture(t, true)
  f.chat.send({ text: 'Waarom?', provider: 'codex' })
  await flush()
  await f.release()
  assert.equal(f.sdkCalls(), 0, 'Source changed by startThread callback must stop runStreamed')
  assert.equal(f.store.get(f.input().turnId)?.text, '')
})

test('RPA5 composed dispatch captures the original turn guard before the environment await', async (t) => {
  const f = sdkDispatchFixture(t)
  f.chat.send({ text: 'Waarom?', provider: 'codex' })
  await flush()
  f.input().assertContextCurrent = () => {}
  f.invalidate()
  await f.release()
  assert.equal(f.sdkCalls(), 0, 'Mutated caller guard must not replace captured original')
  assert.equal(f.store.get(f.input().turnId)?.text, '')
})

test('RPA5 composed valid dispatch calls SDK once and retains its exact lineage and answer', async (t) => {
  const f = sdkDispatchFixture(t)
  f.chat.send({ text: 'Waarom?', provider: 'codex' })
  await flush()
  await f.release()
  assert.equal(f.sdkCalls(), 1)
  assert.deepEqual(f.refs.get(f.input().turnId), [reference])
  assert.equal(f.store.get(f.input().turnId)?.status, 'completed')
  assert.equal(f.store.get(f.input().turnId)?.text, 'COMPOSED DERIVED ANSWER')
})
