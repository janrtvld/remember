import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { AssistantConversation, AssistantTaskDraft } from '@remember/shared'
import { createHostTaskNativeFacade } from '../hostTaskNativeFacade'

function fixture() {
  const calls: Array<{ method: string; value?: unknown }> = []
  const snapshot: AssistantConversation = { messages: [], activeTurnId: null, hasEarlier: false, execution: 'remote' }
  const draft = { token: 'draft-token' } as AssistantTaskDraft
  const runtime = {
    snapshot(before?: string) {
      calls.push({ method: 'snapshot', value: before })
      return snapshot
    },
    draft(id: string) {
      calls.push({ method: 'draft', value: id })
      return draft
    },
    async send(input: { token: string; text: string }) {
      calls.push({ method: 'send', value: input })
      return snapshot
    },
    async control(input: { actionId: string; messageId: string; command: 'check' | 'stop' | 'cancel' }) {
      calls.push({ method: 'control', value: input })
      return snapshot
    },
    async prepareForDeletion() {
      calls.push({ method: 'deletion' })
    },
  }
  let resolve: (value: typeof runtime) => void = () => {
    throw new Error('uninitialized')
  }
  let disposed = false
  const ready = new Promise<typeof runtime>((done) => {
    resolve = done
  })
  const facade = createHostTaskNativeFacade({
    ready,
    ownsMessage: (id) => ['task-user', 'task-assistant', 'legacy-intent-user'].includes(id),
    disposed: () => disposed,
    async dispose() {
      disposed = true
      calls.push({ method: 'dispose' })
    },
  })
  return { calls, facade, snapshot, draft, resolve: () => resolve(runtime) }
}

test('component exposes exact snapshot/draft without dispatch during construction or readiness', async () => {
  const f = fixture()
  const pending = f.facade.snapshot('before-message')
  assert.deepEqual(f.calls, [])
  f.resolve()
  assert.deepEqual(await pending, f.snapshot)
  assert.deepEqual(await f.facade.draft('work-item'), f.draft)
  assert.deepEqual(f.calls, [
    { method: 'snapshot', value: 'before-message' },
    { method: 'draft', value: 'work-item' },
  ])
})

test('ordinary Send and malformed Task requests reject before readiness or any effect', async () => {
  const f = fixture()
  for (const input of [
    { text: 'hello', provider: 'codex' },
    { text: 'hello', provider: 'claude', task: { token: 'valid' } },
    { text: 'hello', provider: 'codex', task: { token: 'valid', id: 'extra' } },
    { text: 'hello', provider: 'codex', task: { token: 'valid' }, start: true },
    { text: null, provider: 'codex', task: { token: 'valid' } },
  ])
    await assert.rejects(f.facade.send(input), /host-task-input-invalid/)
  await assert.rejects(f.facade.snapshot({ before: 'x' }), /host-task-input-invalid/)
  await assert.rejects(f.facade.draft(''), /host-task-input-invalid/)
  await assert.rejects(f.facade.control({ actionId: 'a', messageId: 'm', command: 'retry' }), /host-task-input-invalid/)
  assert.deepEqual(f.calls, [])
})

test('Task Send copies exact token/text before awaiting readiness', async () => {
  const f = fixture()
  const input = { text: 'original instruction', provider: 'codex', task: { token: 'original-token' } }
  const sent = f.facade.send(input)
  input.text = 'mutated instruction'
  input.task.token = 'other-token'
  assert.deepEqual(f.calls, [])
  f.resolve()
  await sent
  assert.deepEqual(f.calls, [{ method: 'send', value: { token: 'original-token', text: 'original instruction' } }])
})

test('exact controls copy assignment and command before awaiting readiness', async () => {
  const f = fixture()
  const input = { actionId: 'action-a', messageId: 'message-a', command: 'check' }
  const controlled = f.facade.control(input)
  input.actionId = 'action-b'
  input.messageId = 'message-b'
  input.command = 'stop'
  f.resolve()
  await controlled
  assert.deepEqual(f.calls, [
    { method: 'control', value: { actionId: 'action-a', messageId: 'message-a', command: 'check' } },
  ])
})

test('history ownership is synchronous for both roles and legacy intents', () => {
  const f = fixture()
  assert.equal(f.facade.ownsMessage('task-user'), true)
  assert.equal(f.facade.ownsMessage('task-assistant'), true)
  assert.equal(f.facade.ownsMessage('legacy-intent-user'), true)
  assert.equal(f.facade.ownsMessage('ordinary'), false)
  assert.deepEqual(f.calls, [])
})

test('dispose while readiness is pending fences already parsed calls', async () => {
  const f = fixture()
  const pending = f.facade.send({ text: 'original', provider: 'codex', task: { token: 'token' } })
  await f.facade.dispose()
  f.resolve()
  await assert.rejects(pending, /host-task-disposed/)
  await assert.rejects(f.facade.snapshot(), /host-task-disposed/)
  assert.deepEqual(f.calls, [{ method: 'dispose' }])
})

test('deletion delegates to the existing exact runtime without submitting', async () => {
  const f = fixture()
  f.resolve()
  await f.facade.prepareForDeletion()
  assert.deepEqual(f.calls, [{ method: 'deletion' }])
})

test('native component owns no IPC handlers or shared Resident store close', () => {
  const source = readFileSync(new URL('../hostTaskNative.ts', import.meta.url), 'utf8')
  assert(!source.includes('ipcMain.handle'))
  assert(!source.includes('resident.close('))
})
