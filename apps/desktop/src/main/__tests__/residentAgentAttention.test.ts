import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { ResidentAgentStore } from '../residentAgentStore'

test('unread survives restart; old acknowledgements cannot clear a later answer', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'remember-attention-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'conversation.sqlite')
  let store = new ResidentAgentStore(file)
  const first = store.start('First question', 'codex')
  assert.equal(store.hasUnreadMessages(), false)
  assert.throws(() => store.markRead(first.id), /assistant-read-invalid/)
  store.update(first.id, { text: 'First answer', steps: [], status: 'completed' })
  assert.equal(store.hasUnreadMessages(), true)
  store.close()
  store = new ResidentAgentStore(file)
  assert.equal(store.hasUnreadMessages(), true)
  store.markRead(first.id)
  assert.equal(store.hasUnreadMessages(), false)
  const second = store.start('Second question', 'codex')
  store.update(second.id, { text: 'Second answer', steps: [], status: 'completed' })
  store.markRead(first.id)
  assert.equal(store.hasUnreadMessages(), true)
  store.markRead(second.id)
  store.markRead(first.id)
  assert.equal(store.hasUnreadMessages(), false)
  store.close()
  store = new ResidentAgentStore(file)
  assert.equal(store.hasUnreadMessages(), false)
  store.close()
})

test('migration does not light up old history; failures and interrupted new work still need reading', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'remember-attention-migration-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'conversation.sqlite')
  let store = new ResidentAgentStore(file)
  const old = store.start('Old question', 'codex')
  store.update(old.id, { text: 'Old answer', steps: [], status: 'completed' })
  store.close()
  const database = new DatabaseSync(file)
  database.prepare("DELETE FROM assistant_state WHERE key='read_through_sequence'").run()
  database.close()
  store = new ResidentAgentStore(file)
  assert.equal(store.hasUnreadMessages(), false)
  const failed = store.start('Failing question', 'codex')
  store.update(failed.id, { text: '', steps: [], status: 'failed', error: 'provider-unavailable' })
  assert.equal(store.hasUnreadMessages(), true)
  const user = store.conversation(null).messages.find((message) => message.role === 'user')
  assert(user)
  assert.throws(() => store.markRead(user.id), /assistant-read-invalid/)
  store.markRead(failed.id)
  assert.equal(store.hasUnreadMessages(), false)
  store.start('Interrupted question', 'codex')
  store.close()
  store = new ResidentAgentStore(file)
  assert.equal(store.hasUnreadMessages(), true)
  store.close()
})

test('a prepared remote command cannot consume the unread state of its future answer', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'remember-command-attention-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = new ResidentAgentStore(join(directory, 'conversation.sqlite'))
  t.after(() => store.close())
  const command = store.startCommand('Read the clock', {
    kind: 'remote',
    endpoint: 'ws://127.0.0.1:47831/',
    workspace: '/private/tmp/attention-test',
    displayHost: 'mini.local',
  })
  assert.equal(store.get(command.id)?.status, 'interrupted')
  assert.equal(store.hasUnreadMessages(), false)
  assert.throws(() => store.markRead(command.id), /assistant-read-invalid/)
  store.markCommandDispatch(command.id)
  assert.throws(() => store.markRead(command.id), /assistant-read-invalid/)
  store.recordCommandCheckpoint(command.id, {
    messageId: command.id,
    computer: command.command.computer,
    threadId: 'attention-thread',
    turnId: 'attention-turn',
    previousTurnId: null,
  })
  assert.throws(() => store.markRead(command.id), /assistant-read-invalid/)
  store.recordCommandCheckpoint(command.id, null)
  store.finishCommand(command.id, { text: 'Clock read', steps: [], status: 'completed' }, 'completed')
  assert.equal(store.hasUnreadMessages(), true)
  store.markRead(command.id)
  assert.equal(store.hasUnreadMessages(), false)
})
