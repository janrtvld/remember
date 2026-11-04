import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { AssistantConversation, AssistantTaskAction } from '@remember/shared'
import type { HostTaskEnvelopeV1 } from '../hostTaskProtocol'
import { createResidentAgentService } from '../residentAgentService'
import { ResidentAgentStore } from '../residentAgentStore'
import { createResidentConversationOwner } from '../residentConversationOwner'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const envelope: HostTaskEnvelopeV1 = {
  version: 1,
  actionId: 'action-A',
  workItemId: 'task-A',
  sessionId: 'session-A',
  jobId: 'job-A',
  userMessageId: 'user-A',
  assistantMessageId: 'assistant-A',
  provider: 'codex',
  instruction: 'PRIVATE TASK INSTRUCTION',
  targetId: 'target',
  policyFingerprint: 'policy',
  startedAt: 1000,
  sources: [],
  taskDefinition: {
    version: 1,
    id: 'task-A',
    title: 'PRIVATE TASK TITLE',
    description: '',
    prompt: '',
    aiSuggestion: null,
    context: '',
    returnPoint: { lastMove: '', unresolved: '', nextMove: '' },
    lifecycle: 'open',
    status: 'todo',
    priority: 'none',
    dueAt: null,
    sources: [],
  },
  preparedInput: {
    prompt: 'PRIVATE INPUT',
    systemPrompt: '',
    model: 'gpt-5.6-sol',
    effort: 'low',
    threadId: null,
    tools: [],
    workspace: '/private/tmp/shared-owner-test',
  },
}

function fixture(t: { after(fn: () => Promise<void>): void }, hostBinding = false) {
  const directory = mkdtempSync('/private/tmp/rpa2-owner-')
  const store = new ResidentAgentStore(join(directory, 'chat.sqlite'))
  store.createHostTaskIntent(envelope)
  if (hostBinding) {
    const database = new DatabaseSync(join(directory, 'chat.sqlite'))
    database
      .prepare("INSERT INTO assistant_host_run (job_id, message_id, binding) VALUES ('job-A', 'assistant-A', ?)")
      .run(
        JSON.stringify({
          jobId: 'job-A',
          messageId: 'assistant-A',
          endpoint: 'tcp://127.0.0.1:48001',
          cursor: 10,
          phase: 'waiting',
          connection: 'connected',
        })
      )
    database.close()
  }
  const pending = deferred<{ provider: 'codex'; response: string; durationMs: number; steps: [] }>()
  const prompts: string[] = [],
    cancellations: string[] = [],
    controls: unknown[] = [],
    disposed: string[] = []
  let contextGate: Promise<void> | null = null
  let activeTask = true
  let taskSends = 0
  const action: AssistantTaskAction = {
    actionId: 'action-A',
    messageId: 'assistant-A',
    workItemId: 'task-A',
    state: 'waiting',
    connection: 'connected',
    allowedControls: ['stop'],
  }
  const tasks = {
    async snapshot(): Promise<AssistantConversation> {
      return {
        ...store.conversation(activeTask ? action.messageId : null),
        execution: 'remote',
        taskActionsEnabled: true,
        activeTaskAction: activeTask ? action : null,
        messages: store
          .conversation(null)
          .messages.map((m) => (m.id === action.messageId ? { ...m, taskAction: action } : m)),
      }
    },
    async draft(_input: unknown) {
      return { token: 'draft-B' } as never
    },
    async send(_input: unknown) {
      taskSends++
      throw new Error('host-task-active')
    },
    async control(input: unknown) {
      controls.push(input)
      activeTask = false
      return this.snapshot()
    },
    ownsMessage(id: string) {
      return store.ownsHostTaskMessage(id)
    },
    async prepareForDeletion() {
      disposed.push('task-deletion')
    },
    async dispose() {
      assert(store.get('assistant-A'))
      disposed.push('task-dispose')
    },
  }
  const chat = createResidentAgentService({
    store,
    separateTaskActions: true,
    assertAvailable() {},
    changed() {},
    context: async () => {
      await contextGate
      return '{}'
    },
    proactive: { canPublish: () => !activeTask, changed() {}, messagePermitted: () => true },
    driver: {
      run: async (input) => {
        prompts.push(input.prompt)
        return pending.promise
      },
      cancel: (id) => {
        cancellations.push(id)
        pending.resolve({ provider: 'codex', response: 'Late response', durationMs: 10, steps: [] })
      },
    },
  })
  const owner = createResidentConversationOwner({ chat, tasks, onTaskInput: () => store.noteConversationInput() })
  t.after(async () => {
    await owner.dispose()
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    store,
    owner,
    chat,
    tasks,
    prompts,
    cancellations,
    controls,
    disposed,
    pending,
    taskSends: () => taskSends,
    holdContext(promise: Promise<void>) {
      contextGate = promise
    },
  }
}

test('Task owner baseline rejects free input; shared owner admits chat during exact pending action', async (t) => {
  const f = fixture(t)
  await assert.rejects(f.tasks.send({ text: 'status', provider: 'codex' }), /host-task-active/)
  const conversation = await f.owner.send({ text: 'Hoe staat het ervoor?', provider: 'codex' })
  await tick()
  assert(conversation.activeTurnId)
  assert.notEqual(conversation.activeTurnId, 'assistant-A')
  assert.equal(conversation.activeTaskAction?.messageId, 'assistant-A')
  assert.equal(conversation.sharedTaskChat, true)
  assert.equal(conversation.execution, 'local')
  assert.equal(f.prompts.length, 1)
  assert.equal(f.taskSends(), 1)
  await assert.rejects(f.owner.send({ text: 'Second', provider: 'codex' }), /already-running/)
})

test('both intent message roles stay visible but never enter history or proactive context, before and after awaits', async (t) => {
  const f = fixture(t)
  assert.equal(f.store.ownsHostTaskMessage('user-A'), true)
  assert.equal(f.store.ownsHostTaskMessage('assistant-A'), true)
  assert.equal(f.store.ownsHostTaskMessage('unknown'), false)
  assert.equal(f.store.history().length, 0)
  assert.equal(f.chat.proactiveState().recentMessages.length, 0)
  assert.equal((await f.owner.snapshot()).messages.length, 2)
  const gate = deferred<void>()
  f.holdContext(gate.promise)
  await f.owner.send({ text: 'Hello', provider: 'codex' })
  try {
    f.store.resetContext()
  } finally {
    gate.resolve()
  }
  await tick()
  assert.equal(f.prompts.length, 1)
  assert.equal(f.prompts[0].includes('PRIVATE'), false)
})

test('ordinary Stop cancels only chat and exact action control never cancels that chat', async (t) => {
  const f = fixture(t)
  const c = await f.owner.send({ text: 'Hello', provider: 'codex' })
  await tick()
  await f.owner.control({ actionId: 'action-A', messageId: 'assistant-A', command: 'stop' })
  assert.equal(f.cancellations.length, 0)
  assert.equal(f.controls.length, 1)
  await f.owner.cancel()
  assert.deepEqual(f.cancellations, [c.activeTurnId])
  assert.equal(f.controls.length, 1)
  assert.equal(f.store.get(c.activeTurnId!)?.status, 'cancelled')
})

test('generic retry refuses both historical Task roles and malformed free/task sends never route implicitly', async (t) => {
  const f = fixture(t)
  for (const id of ['user-A', 'assistant-A']) await assert.rejects(f.owner.retry(id), /exact-control-required/)
  for (const input of [
    { text: 'Hello', provider: 'claude' },
    { text: 'Hello', provider: 'codex', actionId: 'action-A' },
    { text: 'Hello', provider: 'codex', task: undefined },
  ])
    await assert.rejects(f.owner.send(input))
  assert.equal(f.prompts.length, 0)
  assert.equal(f.taskSends(), 0)
})

test('Task send advances attention generation without invalidating A and never retries a blocked B', async (t) => {
  const f = fixture(t)
  const before = f.store.proactiveConversationGeneration()
  await assert.rejects(
    f.owner.send({ text: 'B draft', provider: 'codex', task: { token: 'draft-B' } }),
    /host-task-active/
  )
  assert.equal(f.store.proactiveConversationGeneration(), before + 1)
  assert.equal(f.store.getHostTaskIntent('action-A')?.invalidated, false)
  await f.owner.control({ actionId: 'action-A', messageId: 'assistant-A', command: 'stop' })
  await tick()
  assert.equal(f.taskSends(), 1)
})

test('Task component disposes before shared DB closes; dispose is idempotent and never sends action Stop', async (t) => {
  const f = fixture(t)
  await f.owner.dispose()
  await f.owner.dispose()
  assert.deepEqual(f.disposed, ['task-dispose'])
  assert.equal(f.controls.length, 0)
  await assert.rejects(f.owner.send({ text: 'after quit', provider: 'codex' }), /unavailable/)
})

test('durable current host binding owned by Task never becomes ordinary active turn or generic Stop target', async (t) => {
  const f = fixture(t, true)
  const before = f.store.hostRun()
  assert.equal((await f.owner.snapshot()).activeTurnId, null)
  const chat = await f.owner.send({ text: 'Status?', provider: 'codex' })
  assert(chat.activeTurnId && chat.activeTurnId !== 'assistant-A')
  await f.owner.cancel()
  assert.deepEqual(f.store.hostRun(), before)
  assert.equal(f.controls.length, 0)
  assert.equal((await f.owner.snapshot()).activeTurnId, null)
})
