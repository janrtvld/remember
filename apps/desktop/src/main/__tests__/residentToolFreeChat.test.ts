import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { CodexOptions, ThreadEvent, ThreadOptions, TurnOptions } from '@openai/codex-sdk'
import type { AgentTurnUpdate } from '@remember/shared'
import type { ResidentAgentDriver } from '../residentAgentService'
import { createResidentToolFreeChatDriver, type ToolFreeChatRuntime } from '../residentToolFreeChat'

const usage = {
  input_tokens: 10,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 3,
  reasoning_output_tokens: 2,
}
const completed: ThreadEvent = { type: 'turn.completed', usage }
const message = (text = 'Ik kan je vraag beantwoorden.'): ThreadEvent => ({
  type: 'item.completed',
  item: { type: 'agent_message', id: 'answer', text },
})
async function* stream(events: ThreadEvent[]) {
  yield* events
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function fixture(
  options: {
    events?: ThreadEvent[]
    run?: (turn: TurnOptions) => Promise<{ events: AsyncIterable<ThreadEvent> }>
    timeoutMs?: number
  } = {}
) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'remember-tool-free-'))
  const runtime: ToolFreeChatRuntime & { env: NodeJS.ProcessEnv } = {
    cwd,
    executable: '/synthetic/codex',
    env: { CODEX_HOME: '/synthetic/auth-home', PATH: '/usr/bin', KEEP: 'original' },
    model: 'configured-model',
    effort: 'low',
  }
  const calls: { client: CodexOptions; thread?: ThreadOptions; turn?: TurnOptions; prompt?: string }[] = []
  const updates: AgentTurnUpdate[] = []
  const threads: string[] = []
  const usageModels: string[] = []
  const setupSnapshots: { wrapper: string; authTarget: string }[] = []
  let runtimeReads = 0
  let time = 1_000
  const driver = createResidentToolFreeChatDriver({
    runtime: () => {
      runtimeReads += 1
      return runtime
    },
    timeoutMs: options.timeoutMs ?? 1_000,
    now: () => time++,
    onUsage: (model) => usageModels.push(model),
    createClient: (client) => {
      setupSnapshots.push({
        wrapper: readFileSync(client.codexPathOverride ?? '', 'utf8'),
        authTarget: readlinkSync(path.join(client.env?.CODEX_HOME ?? '', 'auth.json')),
      })
      const call: (typeof calls)[number] = { client }
      calls.push(call)
      return {
        startThread(thread) {
          call.thread = thread
          return {
            runStreamed: async (prompt, turn) => {
              call.prompt = prompt
              call.turn = turn
              return options.run
                ? options.run(turn)
                : {
                    events: stream(
                      options.events ?? [
                        { type: 'thread.started', thread_id: `fresh-${calls.length}` },
                        { type: 'item.updated', item: { type: 'reasoning', id: 'reason', text: 'Controleer status.' } },
                        message(),
                        completed,
                      ]
                    ),
                  }
            },
          }
        },
      }
    },
  })
  const input = (turnId = 'chat-A'): Parameters<ResidentAgentDriver['run']>[0] => ({
    turnId,
    provider: 'codex',
    prompt: 'Observed permitted context. Current user request: Wat gebeurt er?',
    instruction: 'Wat gebeurt er?',
    threadId: 'old-private-thread',
    recovery: null,
    hostRun: null,
    onThread: (id) => threads.push(id),
    onUpdate: (value) => updates.push(value),
    onCheckpoint: () => assert.fail('ordinary chat must not write a remote checkpoint'),
    onHostRun: () => assert.fail('ordinary chat must not write a host binding'),
  })
  return {
    driver,
    runtime,
    calls,
    updates,
    threads,
    usageModels,
    setupSnapshots,
    runtimeReads: () => runtimeReads,
    input,
    close() {
      driver.dispose()
      rmSync(cwd, { recursive: true, force: true })
    },
  }
}

test('fresh local tools-disabled SDK chat returns normal response and steps without remote callbacks', async () => {
  const f = fixture()
  try {
    const result = await f.driver.run(f.input())
    assert.equal(result.provider, 'codex')
    assert.equal(result.response, 'Ik kan je vraag beantwoorden.')
    assert.equal(result.threadId, undefined)
    assert(result.durationMs >= 0)
    assert.deepEqual(
      result.steps.map((step) => [step.id, step.kind, step.text]),
      [['reason', 'reasoning', 'Controleer status.']]
    )
    assert.deepEqual(f.threads, [])
    assert.deepEqual(f.usageModels, ['configured-model'])
    assert.equal(f.calls.length, 1)
    const call = f.calls[0]
    assert.equal(call.thread?.sandboxMode, 'read-only')
    assert.equal(call.thread?.networkAccessEnabled, false)
    assert.equal(call.thread?.webSearchMode, 'disabled')
    assert.equal(call.thread?.approvalPolicy, 'never')
    assert.equal(call.thread?.model, 'configured-model')
    assert.equal(call.thread?.modelReasoningEffort, 'low')
    const config = call.client.config as Record<string, unknown>
    const features = config.features as Record<string, unknown>
    for (const key of [
      'shell_tool',
      'unified_exec',
      'browser_use',
      'computer_use',
      'code_mode',
      'apps',
      'plugins',
      'view_image',
    ])
      assert.equal(features[key], false, key)
    assert.deepEqual(config.mcp_servers, {})
    assert.deepEqual(config.plugins, {})
    assert.deepEqual(config.tools, { web_search: false })
    assert.equal(config.include_environment_context, false)
    assert.equal(config.project_doc_max_bytes, 0)
    assert.equal(call.turn?.outputSchema, undefined)
    assert.match(call.prompt ?? '', /Current user request/)
    assert.match(call.prompt ?? '', /no tools/i)
    assert(!JSON.stringify(call).includes('old-private-thread'))
    assert.match(f.setupSnapshots[0].wrapper, /--ephemeral --ignore-user-config/)
    assert.equal(f.setupSnapshots[0].authTarget, '/synthetic/auth-home/auth.json')
    assert(!existsSync(call.thread?.workingDirectory ?? ''))
    assert.deepEqual(readdirSync(f.runtime.cwd), [])
    assert(f.updates.every((update) => update.turnId === 'chat-A' && update.provider === 'codex'))
    await f.driver.run(f.input('chat-B'))
    assert.deepEqual(f.threads, [])
    assert.notEqual(f.calls[0].thread?.workingDirectory, f.calls[1].thread?.workingDirectory)
  } finally {
    f.close()
  }
})

test('model, effort, environment and input are captured before the first SDK await', async () => {
  const gate = deferred<{ events: AsyncIterable<ThreadEvent> }>()
  const f = fixture({ run: () => gate.promise })
  try {
    const input = f.input()
    const result = f.driver.run(input)
    f.runtime.model = 'later-model'
    f.runtime.effort = 'high'
    f.runtime.env.KEEP = 'later'
    input.turnId = 'mutated-turn'
    input.prompt = 'mutated-prompt'
    gate.resolve({ events: stream([{ type: 'thread.started', thread_id: 'fresh' }, message(), completed]) })
    await result
    assert.equal(f.runtimeReads(), 1)
    assert.equal(f.calls[0].thread?.model, 'configured-model')
    assert.equal(f.calls[0].thread?.modelReasoningEffort, 'low')
    assert.equal(f.calls[0].client.env?.KEEP, 'original')
    assert(!f.calls[0].prompt?.includes('mutated-prompt'))
    assert(f.updates.every((update) => update.turnId === 'chat-A'))
    assert.deepEqual(f.usageModels, ['configured-model'])
  } finally {
    f.close()
  }
})

test('Claude and remote/host recovery reject before SDK construction', async () => {
  const f = fixture()
  try {
    await assert.rejects(f.driver.run({ ...f.input(), provider: 'claude' }), /assistant-tool-free-provider-unsupported/)
    await assert.rejects(
      f.driver.run({ ...f.input(), hostRun: {} as NonNullable<ReturnType<typeof f.input>['hostRun']> }),
      /assistant-tool-free-recovery-unsupported/
    )
    await assert.rejects(
      f.driver.run({ ...f.input(), recovery: {} as NonNullable<ReturnType<typeof f.input>['recovery']> }),
      /assistant-tool-free-recovery-unsupported/
    )
    assert.equal(f.calls.length, 0)
  } finally {
    f.close()
  }
})

test('cancellation is exact, a second ordinary turn is refused, and late SDK output is suppressed', async () => {
  const gate = deferred<{ events: AsyncIterable<ThreadEvent> }>()
  const f = fixture({ run: () => gate.promise })
  try {
    const running = f.driver.run(f.input())
    void running.catch(() => undefined)
    await new Promise((resolve) => setImmediate(resolve))
    f.driver.cancel('historical-action-B')
    assert.equal(f.calls[0].turn?.signal?.aborted, false)
    await assert.rejects(f.driver.run(f.input('chat-B')), /assistant-tool-free-busy/)
    f.driver.cancel('chat-A')
    await assert.rejects(running, /agent-cancelled/)
    assert.equal(f.calls[0].turn?.signal?.aborted, true)
    gate.resolve({
      events: stream([{ type: 'thread.started', thread_id: 'late' }, message('late private answer'), completed]),
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(f.updates, [])
    assert.deepEqual(f.threads, [])
    assert.equal(f.calls.length, 1)
  } finally {
    f.close()
  }
})

test('driver deadline settles even when SDK initialization ignores abort, without retry', async () => {
  const f = fixture({ timeoutMs: 10, run: () => new Promise(() => {}) })
  try {
    await assert.rejects(f.driver.run(f.input()), /assistant-tool-free-timeout/)
    assert.equal(f.calls[0].turn?.signal?.aborted, true)
    assert.equal(f.calls.length, 1)
  } finally {
    f.close()
  }
})

test('cooperative abort rejection cannot replace the exact deadline reason', async () => {
  const f = fixture({
    timeoutMs: 10,
    run: (turn) =>
      new Promise((_, reject) => turn.signal?.addEventListener('abort', () => reject(new Error('sdk-abort')))),
  })
  try {
    await assert.rejects(f.driver.run(f.input()), /assistant-tool-free-timeout/)
    assert.equal(f.calls.length, 1)
  } finally {
    f.close()
  }
})

test('dispose aborts only this driver lifetime and prevents later invocation', async () => {
  const f = fixture({ run: () => new Promise(() => {}) })
  try {
    const running = f.driver.run(f.input())
    void running.catch(() => undefined)
    await new Promise((resolve) => setImmediate(resolve))
    f.driver.dispose()
    await assert.rejects(running, /assistant-tool-free-disposed/)
    await assert.rejects(f.driver.run(f.input('later')), /assistant-tool-free-disposed/)
    assert.equal(f.calls.length, 1)
    assert.deepEqual(f.updates, [])
  } finally {
    f.close()
  }
})

test('provider failure is surfaced once and partial text without completion is not successful', async () => {
  for (const [events, expected] of [
    [[{ type: 'error', message: 'provider-disconnected' }], /provider-disconnected/],
    [[{ type: 'turn.failed', error: { message: 'provider-failed' } }], /provider-failed/],
    [[message('partial')], /assistant-tool-free-incomplete/],
    [[{ type: 'thread.started', thread_id: 'fresh' }, completed], /codex-empty-response/],
  ] as const) {
    const f = fixture({ events: [...events] })
    try {
      await assert.rejects(f.driver.run(f.input()), expected)
      assert.equal(f.calls.length, 1)
    } finally {
      f.close()
    }
  }
})

test('unexpected tool events fail closed instead of becoming an action or a false success', async () => {
  const f = fixture({
    events: [
      { type: 'thread.started', thread_id: 'fresh' },
      {
        type: 'item.started',
        item: {
          type: 'command_execution',
          id: 'shell',
          command: 'touch outside',
          aggregated_output: '',
          status: 'in_progress',
        },
      },
      message('Done'),
      completed,
    ],
  })
  try {
    await assert.rejects(f.driver.run(f.input()), /assistant-tool-free-unexpected-tool/)
    assert.equal(f.calls[0].turn?.signal?.aborted, true)
    assert.deepEqual(f.updates, [])
  } finally {
    f.close()
  }
})

test('oversized output aborts before publication', async () => {
  const f = fixture({
    events: [{ type: 'thread.started', thread_id: 'fresh' }, message('x'.repeat(128 * 1024 + 1)), completed],
  })
  try {
    await assert.rejects(f.driver.run(f.input()), /assistant-tool-free-output-too-large/)
    assert.deepEqual(f.updates, [])
  } finally {
    f.close()
  }
})

test('cancellation while environment loads prevents SDK invocation after it resolves', async () => {
  const env = deferred<NodeJS.ProcessEnv>()
  const cwd = mkdtempSync(path.join(tmpdir(), 'remember-tool-free-env-'))
  let calls = 0
  const driver = createResidentToolFreeChatDriver({
    runtime: () => ({ cwd, executable: '/synthetic/codex', model: 'captured-model', effort: 'low', env: env.promise }),
    createClient: () => {
      calls += 1
      throw new Error('unexpected-sdk-call')
    },
  })
  const f = fixture()
  try {
    const running = driver.run(f.input())
    driver.cancel('chat-A')
    await assert.rejects(running, /agent-cancelled/)
    env.resolve({ CODEX_HOME: '/synthetic/home' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls, 0)
    assert.deepEqual(readdirSync(cwd), [])
  } finally {
    driver.dispose()
    f.close()
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('current availability is rechecked after environment await and before provider input', async () => {
  const env = deferred<NodeJS.ProcessEnv>()
  const cwd = mkdtempSync(path.join(tmpdir(), 'remember-tool-free-policy-'))
  let permitted = true
  let calls = 0
  const driver = createResidentToolFreeChatDriver({
    runtime: () => ({
      cwd,
      executable: '/synthetic/codex',
      model: 'captured-model',
      effort: 'low',
      env: env.promise,
      assertAvailable() {
        if (!permitted) throw new Error('policy-revoked')
      },
    }),
    createClient: () => {
      calls += 1
      throw new Error('unexpected-sdk-call')
    },
  })
  const f = fixture()
  try {
    const running = driver.run(f.input())
    permitted = false
    env.resolve({ CODEX_HOME: '/synthetic/home' })
    await assert.rejects(running, /policy-revoked/)
    assert.equal(calls, 0)
    assert.deepEqual(readdirSync(cwd), [])
  } finally {
    driver.dispose()
    f.close()
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('permission loss before a streamed reply suppresses that private update', async () => {
  const gate = deferred<void>()
  const f = fixture({
    run: async () => ({
      events: (async function* () {
        yield { type: 'thread.started', thread_id: 'fresh' } as const
        await gate.promise
        yield message('new private text')
        yield completed
      })(),
    }),
  })
  let permitted = true
  f.runtime.assertAvailable = () => {
    if (!permitted) throw new Error('policy-revoked')
  }
  try {
    const running = f.driver.run(f.input())
    await new Promise((resolve) => setImmediate(resolve))
    permitted = false
    gate.resolve()
    await assert.rejects(running, /policy-revoked/)
    assert.deepEqual(f.updates, [])
    assert.deepEqual(f.threads, [])
    assert.deepEqual(readdirSync(f.runtime.cwd), [])
  } finally {
    f.close()
  }
})

test('invalid deadlines reject instead of disabling the bounded lifetime', () => {
  for (const timeoutMs of [0, -1, Infinity, Number.NaN, 120_001]) {
    assert.throws(
      () => createResidentToolFreeChatDriver({ runtime: () => assert.fail('no runtime'), timeoutMs }),
      /assistant-tool-free-timeout-invalid/
    )
  }
})

test('deadline also bounds a stalled event stream and removes only its owned directory', async () => {
  const f = fixture({
    timeoutMs: 10,
    run: async () => ({
      events: (async function* () {
        yield { type: 'thread.started', thread_id: 'fresh' } as const
        await new Promise(() => {})
      })(),
    }),
  })
  try {
    await assert.rejects(f.driver.run(f.input()), /assistant-tool-free-timeout/)
    assert.equal(f.calls[0].turn?.signal?.aborted, true)
    assert(existsSync(f.runtime.cwd))
    assert.deepEqual(readdirSync(f.runtime.cwd), [])
  } finally {
    f.close()
  }
})

test('synchronous cancellation from a streamed update prevents completion', async () => {
  const f = fixture()
  try {
    const input = f.input()
    input.onUpdate = () => f.driver.cancel('chat-A')
    await assert.rejects(f.driver.run(input), /agent-cancelled/)
    assert.deepEqual(f.usageModels, [])
    assert.deepEqual(readdirSync(f.runtime.cwd), [])
  } finally {
    f.close()
  }
})

test('an asynchronous environment rejection after immediate permission rejection remains handled', async () => {
  const env = deferred<NodeJS.ProcessEnv>()
  const f = fixture()
  const driver = createResidentToolFreeChatDriver({
    runtime: () => ({
      ...f.runtime,
      env: env.promise,
      assertAvailable() {
        throw new Error('policy-revoked')
      },
    }),
    createClient: () => assert.fail('no provider input'),
  })
  try {
    await assert.rejects(driver.run(f.input()), /policy-revoked/)
    env.reject(new Error('environment-unavailable'))
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(readdirSync(f.runtime.cwd), [])
  } finally {
    driver.dispose()
    f.close()
  }
})

test('actual SDK subprocess settles error, cancellation and completion without an uncaught abort', async (t) => {
  for (const mode of ['error', 'cancel', 'complete']) {
    await t.test(mode, () => {
      const cwd = mkdtempSync(path.join(tmpdir(), 'remember-tool-free-sdk-'))
      const executable = path.join(cwd, 'fake-codex')
      const pidFile = path.join(cwd, 'fake.pid')
      const runner = path.join(cwd, 'runner.mjs')
      const modulePath = fileURLToPath(new URL('../residentToolFreeChat.ts', import.meta.url))
      writeFileSync(
        executable,
        `#!${process.execPath}
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
emit({type:'thread.started',thread_id:'local-fixture-thread'});
if (${JSON.stringify(mode)} === 'error') emit({type:'error',message:'synthetic-provider-error'});
else if (${JSON.stringify(mode)} === 'cancel') emit({type:'item.updated',item:{type:'reasoning',id:'r',text:'ready'}});
else {
  emit({type:'item.completed',item:{type:'agent_message',id:'a',text:'local fixture answer'}});
  emit({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}});
}
if (${JSON.stringify(mode)} === 'complete') setTimeout(() => process.exit(0), 50);
else setInterval(() => {}, 1000);
`,
        { mode: 0o700 }
      )
      writeFileSync(
        runner,
        `
import assert from 'node:assert/strict';
import { createResidentToolFreeChatDriver } from ${JSON.stringify(modulePath)};
const driver = createResidentToolFreeChatDriver({
  runtime: () => ({ cwd:${JSON.stringify(cwd)}, executable:${JSON.stringify(executable)},
    env:{PATH:'/usr/bin:/bin',CODEX_HOME:${JSON.stringify(path.join(cwd, 'unused-auth-home'))}},
    model:'fixture',effort:'low' }), timeoutMs:5000,
});
const operation = driver.run({provider:'codex',turnId:'fixture-turn',prompt:'fixture only',
  onThread(){},onUpdate(){if (${JSON.stringify(mode)} === 'cancel') driver.cancel('fixture-turn');}});
if (${JSON.stringify(mode)} === 'complete') assert.equal((await operation).response,'local fixture answer');
else await assert.rejects(operation, {message:${JSON.stringify(mode === 'error' ? 'synthetic-provider-error' : 'agent-cancelled')}});
driver.dispose();
await new Promise(resolve => setTimeout(resolve, 2500));
process.stdout.write('settled\\n');
`
      )
      try {
        const result = spawnSync(process.execPath, ['--import', 'tsx', runner], {
          cwd: fileURLToPath(new URL('../../..', import.meta.url)),
          encoding: 'utf8',
          timeout: 12_000,
          maxBuffer: 128 * 1024,
        })
        assert.equal(result.error, undefined)
        assert.equal(result.status, 0, result.stderr)
        assert.match(result.stdout, /settled/)
        assert.doesNotMatch(result.stderr, /Unhandled 'error' event|AbortError/)
      } finally {
        if (existsSync(pidFile)) {
          try {
            process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL')
          } catch {}
        }
        rmSync(cwd, { recursive: true, force: true })
      }
    })
  }
})

const disabledCodeModeDiagnostic =
  'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.'
const codeModeDiagnosticEvent: ThreadEvent = {
  type: 'item.completed',
  item: { type: 'error', id: 'startup-diagnostic', message: disabledCodeModeDiagnostic },
}

test('exact code-mode startup diagnostic permits a later complete tools-disabled answer', async () => {
  const f = fixture({
    events: [
      { type: 'thread.started', thread_id: 'fresh' },
      codeModeDiagnosticEvent,
      { type: 'turn.started' },
      message(),
      completed,
    ],
  })
  try {
    assert.equal((await f.driver.run(f.input())).response, 'Ik kan je vraag beantwoorden.')
    assert.equal(f.updates.length, 1)
    assert.equal(f.updates[0].type, 'response')
  } finally {
    f.close()
  }
})

test('exact code-mode startup diagnostic is rejected after turn start', async () => {
  const f = fixture({ events: [{ type: 'turn.started' }, codeModeDiagnosticEvent, message(), completed] })
  try {
    await assert.rejects(f.driver.run(f.input()), { message: disabledCodeModeDiagnostic })
    assert.deepEqual(f.updates, [])
  } finally {
    f.close()
  }
})

test('other error items remain fatal before turn start', async () => {
  const f = fixture({
    events: [{ type: 'item.completed', item: { type: 'error', id: 'other', message: 'different diagnostic' } }],
  })
  try {
    await assert.rejects(f.driver.run(f.input()), { message: 'different diagnostic' })
    assert.deepEqual(f.updates, [])
  } finally {
    f.close()
  }
})

test('exact code-mode startup diagnostic alone cannot produce a completed answer', async () => {
  const f = fixture({ events: [{ type: 'thread.started', thread_id: 'fresh' }, codeModeDiagnosticEvent] })
  try {
    await assert.rejects(f.driver.run(f.input()), { message: 'assistant-tool-free-incomplete' })
    assert.deepEqual(f.updates, [])
  } finally {
    f.close()
  }
})
