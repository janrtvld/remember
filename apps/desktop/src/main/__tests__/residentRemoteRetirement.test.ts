import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { agentComputerExecutionKey } from '@remember/shared'
import { createResidentAgentService } from '../residentAgentService'
import { ResidentAgentStore } from '../residentAgentStore'

const computer = {
  kind: 'remote' as const,
  endpoint: 'ws://127.0.0.1:47831/',
  workspace: '/private/tmp/retired-remote-work',
}
const checkpoint = (messageId: string) => ({
  messageId,
  computer,
  threadId: 'old-remote-thread',
  turnId: 'old-remote-turn',
  previousTurnId: null,
})

function fixture(t: { after(fn: () => void): void }, legacySchema = false) {
  const directory = mkdtempSync(join(tmpdir(), 'remember-retire-remote-'))
  const file = join(directory, 'conversation.sqlite')
  if (legacySchema) {
    const db = new DatabaseSync(file)
    db.exec(`CREATE TABLE assistant_command (message_id TEXT PRIMARY KEY, user_message_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL, value_json TEXT NOT NULL, terminal_json TEXT);
      CREATE TABLE assistant_queued_message (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      text TEXT NOT NULL, execution_key TEXT NOT NULL);`)
    db.close()
  }
  let store = new ResidentAgentStore(file)
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const rows = (table: string) => {
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      return db
        .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
        .all()
        .map((row) => ({ ...row }))
    } finally {
      db.close()
    }
  }
  return {
    get store() {
      return store
    },
    file,
    rows,
    reopen(before?: (file: string) => void) {
      store.close()
      before?.(file)
      store = new ResidentAgentStore(file)
    },
  }
}

function seedLegacyTask(f: ReturnType<typeof fixture>, state: 'running' | 'completed' | 'cancelled-unsubmitted') {
  const turn = f.store.start(`Legacy task ${state}`, 'codex')
  f.store.update(turn.id, {
    text: `Original ${state} task text`,
    steps: [{ id: 'legacy-step', kind: 'status', text: 'Original progress', at: 1 }],
    status: state === 'running' ? 'streaming' : state === 'completed' ? 'completed' : 'cancelled',
  })
  const actionId = `action-${state}`
  const db = new DatabaseSync(f.file)
  db.prepare(`INSERT INTO assistant_task_run
    (action_id,work_item_id,session_id,job_id,user_message_id,assistant_message_id,envelope_hash,envelope_json,
    session_receipt_json,outcome_json,outcome_hash,outcome_receipt_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    actionId,
    `task-${state}`,
    `session-${state}`,
    `job-${state}`,
    f.store.get(turn.id)?.replyTo ?? '',
    turn.id,
    'legacy-hash',
    JSON.stringify({ legacy: 'Preserve the original envelope, including unsupported historical fields' }),
    JSON.stringify({ original: 'session receipt' }),
    state === 'completed' ? JSON.stringify({ status: 'completed', response: 'Original verified outcome' }) : null,
    state === 'completed' ? 'original-outcome-hash' : null,
    state === 'completed' ? JSON.stringify({ original: 'outcome receipt' }) : null
  )
  db.prepare(`INSERT INTO assistant_task_execution
    (action_id,prepared_json,prepared_hash,state,observation_json,terminal_json,cancellation_json)
    VALUES (?,?,?,?,?,?,?)`).run(
    actionId,
    JSON.stringify({ original: 'prepared input' }),
    'prepared-hash',
    state,
    JSON.stringify({ original: 'observation' }),
    state === 'completed' ? JSON.stringify({ original: 'terminal receipt' }) : null,
    state === 'cancelled-unsubmitted' ? JSON.stringify({ kind: 'unsubmitted', at: 1 }) : null
  )
  db.prepare(`INSERT INTO assistant_task_memory_source VALUES (?,?,?,?)`).run(
    actionId,
    'personal',
    'legacy-source',
    JSON.stringify({ original: 'source reference' })
  )
  db.close()
  return { actionId, messageId: turn.id }
}

test('remote failures without ownership never replay locally or enter paired prompt history, without rewriting stored errors', async (t) => {
  const f = fixture(t)
  const ids = []
  for (const status of ['failed', 'cancelled', 'interrupted'] as const) {
    const turn = f.store.start(`Old remote-only instruction ${status}`, 'codex')
    f.store.update(turn.id, {
      text: 'Keep the original partial response',
      steps: [{ id: 'old-progress', kind: 'status', text: 'Original remote progress', at: 1 }],
      status,
      error: `codex-remote-${status}`,
    })
    ids.push(turn.id)
  }
  const original = f.rows('assistant_message')
  f.store.retireRemoteExecution()
  f.reopen()
  f.store.retireRemoteExecution()
  assert.deepEqual(f.rows('assistant_message'), original)
  assert.deepEqual(f.store.history(), [])
  assert.deepEqual(f.store.history(true), [])
  const prompts: string[] = []
  const service = createResidentAgentService({
    store: f.store,
    context: () => 'Current local context',
    assertAvailable: () => {},
    changed: () => {},
    driver: {
      run: async (input) => {
        prompts.push(input.prompt)
        return { provider: input.provider, response: 'New local answer', steps: [], durationMs: 1 }
      },
      cancel: () => {},
    },
  })
  for (const id of ids) {
    const message = f.store.get(id)
    assert.equal(message?.text, 'Keep the original partial response')
    assert.equal(
      message?.error,
      message?.status === 'cancelled' ? 'assistant-remote-retired-cancelled' : 'assistant-remote-retired'
    )
    assert.equal(message?.command, undefined)
    assert.throws(() => service.retry(id), /not-retryable/)
  }
  assert.deepEqual(prompts, [])
  assert.deepEqual(f.rows('assistant_message'), original)
  service.send({ text: 'New explicit local request', provider: 'claude' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(prompts.length, 1)
  assert.doesNotMatch(prompts[0], /Old remote-only instruction|Original remote progress|original partial response/)
  assert.equal(service.snapshot().messages.at(-1)?.text, 'New local answer')
})

test('a remote error with a live ownership checkpoint retains the exact QA recovery path', (t) => {
  const f = fixture(t)
  const turn = f.store.start('Existing owned remote request', 'codex')
  f.store.update(turn.id, { text: 'Partial', steps: [], status: 'failed', error: 'codex-remote-recovery-required' })
  f.store.setRemoteRun(checkpoint(turn.id))
  assert.equal(f.store.get(turn.id)?.error, 'codex-remote-recovery-required')
  assert.equal(f.store.remoteRun()?.messageId, turn.id)
})

test('legacy host and task controls retire across upgrade and restart without blocking a new local turn', async (t) => {
  const f = fixture(t)
  const completed = f.store.start('Completed host instruction', 'codex')
  const completedBinding = {
    jobId: 'completed-host-job',
    messageId: completed.id,
    endpoint: 'tcp://127.0.0.1:47833',
    cursor: 2,
    phase: 'completed' as const,
    connection: 'connected' as const,
  }
  f.store.persistHostRun(completedBinding, { text: 'Original host result', steps: [], status: 'completed' })
  const pending = f.store.start('Pending host instruction', 'codex')
  const pendingBinding = {
    ...completedBinding,
    jobId: 'pending-host-job',
    messageId: pending.id,
    phase: 'running' as const,
  }
  f.store.persistHostRun(pendingBinding, { text: 'Original partial host text', steps: [], status: 'streaming' })
  const tasks = (['running', 'completed', 'cancelled-unsubmitted'] as const).map((state) => seedLegacyTask(f, state))
  f.reopen((file) => {
    const db = new DatabaseSync(file)
    db.exec(
      'ALTER TABLE assistant_host_run DROP COLUMN retired_at; ALTER TABLE assistant_task_run DROP COLUMN retired_at;'
    )
    db.close()
  })
  const tables = [
    'assistant_host_run',
    'assistant_task_run',
    'assistant_task_execution',
    'assistant_task_memory_source',
  ]
  const before = tables.map(f.rows)
  const completedMessage = f.store.get(completed.id)
  const completedTask = f.store.get(tasks[1].messageId)
  f.store.retireRemoteExecution()
  assert.equal(f.store.hostRun(), null)
  assert.equal(f.store.conversation(null).hostJob, undefined)
  assert.equal(f.store.conversation(null).activeTurnId, null)
  assert.deepEqual(f.store.unresolvedHostTaskExecutions(), [])
  assert.deepEqual(f.store.get(completed.id), completedMessage)
  assert.deepEqual(f.store.get(tasks[1].messageId), completedTask)
  assert.equal(f.store.get(pending.id)?.text, 'Original partial host text')
  assert.equal(f.store.get(pending.id)?.status, 'interrupted')
  assert.equal(f.store.get(pending.id)?.error, 'assistant-remote-retired')
  assert.equal(f.store.get(tasks[2].messageId)?.status, 'cancelled')
  assert.equal(f.store.get(tasks[2].messageId)?.error, 'assistant-remote-retired-cancelled')
  for (const task of tasks) {
    assert.equal(f.store.getHostTaskIntent(task.actionId), null)
    assert.equal(f.store.hostTaskExecution(task.actionId), null)
    assert.equal(f.store.hostTaskExecutionForMessage(task.messageId), null)
    assert.equal(f.store.ownsHostTaskMessage(task.messageId), true)
    assert.throws(() => f.store.start('', 'codex', task.messageId), /not-retryable/)
    assert.throws(() => f.store.invalidateHostTaskAction(task.actionId), /execution-not-found/)
  }
  assert.throws(
    () => f.store.persistHostRun(pendingBinding, { text: 'Late result', steps: [], status: 'streaming' }),
    /remote-retired/
  )
  assert.throws(() => f.store.start('', 'codex', pending.id), /not-retryable/)
  f.store.initiatives.assertCommandSlotAvailable()
  for (let index = 0; index < tables.length; index++) {
    const after = f.rows(tables[index])
    if (index < 2) {
      assert.deepEqual(
        after,
        before[index].map((row, i) => ({ ...row, retired_at: after[i].retired_at }))
      )
      assert(after.every((row) => typeof row.retired_at === 'number'))
    } else assert.deepEqual(after, before[index])
  }
  const durable = tables.map(f.rows)
  f.store.resetContext()
  f.reopen()
  f.store.retireRemoteExecution()
  assert.deepEqual(tables.map(f.rows), durable)
  assert.deepEqual(f.store.history(), [])
  const calls: string[] = []
  const service = createResidentAgentService({
    store: f.store,
    context: () => 'Current local context',
    assertAvailable: () => {},
    changed: () => {},
    driver: {
      run: async (input) => {
        calls.push(input.provider)
        assert.equal(input.hostRun, null)
        assert.equal(input.recovery, null)
        return { provider: input.provider, response: 'New local result', steps: [], durationMs: 1 }
      },
      cancel: () => {},
      stopHost: async () => {
        throw new Error('Retired host must never be contacted')
      },
    },
  })
  service.send({ text: 'New local instruction', provider: 'claude' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(calls, ['claude'])
  assert.equal(service.snapshot().messages.at(-1)?.text, 'New local result')
  assert.equal(service.snapshot().activeTurnId, null)
  assert.equal(service.snapshot().hostJob, undefined)
})

test('a failed task retirement rolls back host controls and partial-message changes atomically', (t) => {
  const f = fixture(t)
  const host = f.store.start('Pending legacy host', 'codex')
  f.store.persistHostRun(
    {
      jobId: 'legacy-host',
      messageId: host.id,
      endpoint: 'tcp://127.0.0.1:47833',
      cursor: 1,
      phase: 'running',
      connection: 'connected',
    },
    { text: 'Keep this partial text', steps: [], status: 'streaming' }
  )
  seedLegacyTask(f, 'running')
  const tables = ['assistant_message', 'assistant_host_run', 'assistant_task_run', 'assistant_task_execution']
  const before = tables.map(f.rows)
  const db = new DatabaseSync(f.file)
  db.exec(`CREATE TRIGGER ignore_task_retirement BEFORE UPDATE OF retired_at ON assistant_task_run
    BEGIN SELECT RAISE(IGNORE); END`)
  db.close()
  assert.throws(() => f.store.retireRemoteExecution(), /write-not-persisted/)
  assert.deepEqual(tables.map(f.rows), before)
  assert.equal(f.store.hostRun()?.jobId, 'legacy-host')
})

test('local migration retires remote controls without changing completed outcomes or losing commands and queued text', (t) => {
  const f = fixture(t, true)
  const done = f.store.startCommand('Old completed remote instruction', computer)
  f.store.markCommandDispatch(done.id)
  f.store.recordCommandCheckpoint(done.id, checkpoint(done.id))
  f.store.recordCommandCheckpoint(done.id, null)
  f.store.finishCommand(done.id, { text: 'Original remote result', steps: [], status: 'completed' }, 'completed')
  const original = f.store.get(done.id)
  const pending = f.store.startCommand('Old unfinished remote instruction', computer)
  f.store.markCommandDispatch(pending.id)
  f.store.recordCommandCheckpoint(pending.id, checkpoint(pending.id))
  const queued = f.store.queueMessage('Keep this remote queue text', agentComputerExecutionKey(computer))
  const localQueue = f.store.queueMessage('Separate local queue', agentComputerExecutionKey({ kind: 'local' }))
  const beforeCommands = f.rows('assistant_command')
  const beforeCheckpoint = f.rows('assistant_remote_run')[0]?.checkpoint
  f.store.retireRemoteExecution()

  assert.deepEqual(f.store.unresolvedCommands(), [])
  assert.equal(f.store.command(done.id), null)
  assert.equal(f.store.command(pending.id), null)
  assert.equal(f.store.remoteRun(), null)
  assert(original)
  const { command: _command, ...originalMessage } = original
  assert.deepEqual(f.store.get(done.id), originalMessage)
  const retired = f.store.get(pending.id)
  assert.equal(retired?.status, 'interrupted')
  assert.equal(retired?.error, 'assistant-remote-retired')
  assert.equal(retired?.command, undefined)
  assert.equal(retired?.text, '')
  const afterCommands = f.rows('assistant_command')
  for (let i = 0; i < beforeCommands.length; i++) {
    assert.deepEqual(afterCommands[i], { ...beforeCommands[i], retired_at: afterCommands[i]?.retired_at })
    assert.equal(typeof afterCommands[i]?.retired_at, 'number')
  }
  assert.equal(f.rows('assistant_retired_remote_run')[0]?.checkpoint, beforeCheckpoint)
  assert.equal(f.rows('assistant_retired_remote_run').length, 1)
  assert.deepEqual(
    f.store.queuedMessages().map((entry) => entry.id),
    [localQueue]
  )
  const archivedQueue = f.rows('assistant_queued_message').find((entry) => entry.id === queued)
  assert.equal(archivedQueue?.text, 'Keep this remote queue text')
  assert.equal(typeof archivedQueue?.retired_at, 'number')
  assert.deepEqual(f.store.history(), [])
  assert.throws(() => f.store.start('', 'codex', pending.id), /not-retryable/)
  assert.throws(
    () => f.store.update(pending.id, { text: 'Overwrite', steps: [], status: 'completed' }),
    /command-owned/
  )
  f.store.initiatives.assertTaskSlotAvailable()
  f.store.initiatives.assertCommandSlotAvailable()
  const local = f.store.start('New local instruction', 'claude')
  f.store.update(local.id, { text: 'Local result', steps: [], status: 'completed' })
  assert.equal(f.store.history().at(-1)?.text, 'Local result')
  const durable = ['assistant_command', 'assistant_retired_remote_run', 'assistant_queued_message'].map(f.rows)
  f.reopen()
  f.store.retireRemoteExecution()
  assert.deepEqual(
    ['assistant_command', 'assistant_retired_remote_run', 'assistant_queued_message'].map(f.rows),
    durable
  )
  assert.equal(f.store.get(pending.id)?.error, 'assistant-remote-retired')
})

test('legacy remote checkpoint is archived and cannot become local history or retry after restart', (t) => {
  const f = fixture(t)
  const legacy = f.store.start('Legacy remote instruction', 'codex')
  f.store.update(legacy.id, { text: 'Last known partial result', steps: [], status: 'streaming' })
  f.store.setRemoteRun(checkpoint(legacy.id))
  const originalCheckpoint = f.rows('assistant_remote_run')[0]?.checkpoint
  f.store.retireRemoteExecution()
  assert.equal(f.store.remoteRun(), null)
  assert.equal(f.store.get(legacy.id)?.status, 'interrupted')
  assert.equal(f.store.get(legacy.id)?.error, 'assistant-remote-retired')
  assert.equal(f.store.get(legacy.id)?.text, 'Last known partial result')
  assert.equal(f.rows('assistant_retired_remote_run')[0]?.checkpoint, originalCheckpoint)
  assert.deepEqual(f.store.history(), [])
  assert.throws(() => f.store.start('', 'codex', legacy.id), /not-retryable/)
  f.reopen()
  f.store.retireRemoteExecution()
  assert.equal(f.store.remoteRun(), null)
  assert.equal(f.rows('assistant_retired_remote_run').length, 1)
  assert.equal(f.store.get(legacy.id)?.error, 'assistant-remote-retired')
  assert.deepEqual(f.store.history(), [])
})

test('a failed retirement write rolls back messages, controls, queue and checkpoint archive together', (t) => {
  const f = fixture(t)
  const pending = f.store.startCommand('Pending remote instruction', computer)
  f.store.markCommandDispatch(pending.id)
  f.store.recordCommandCheckpoint(pending.id, checkpoint(pending.id))
  f.store.queueMessage('Queued remote instruction', agentComputerExecutionKey(computer))
  const before = ['assistant_message', 'assistant_command', 'assistant_remote_run', 'assistant_queued_message'].map(
    f.rows
  )
  const db = new DatabaseSync(f.file)
  db.exec(`CREATE TRIGGER ignore_retirement BEFORE UPDATE OF retired_at ON assistant_command
    BEGIN SELECT RAISE(IGNORE); END`)
  db.close()
  assert.throws(() => f.store.retireRemoteExecution(), /write-not-persisted/)
  assert.deepEqual(
    ['assistant_message', 'assistant_command', 'assistant_remote_run', 'assistant_queued_message'].map(f.rows),
    before
  )
  assert.deepEqual(f.rows('assistant_retired_remote_run'), [])
})

test('reserved, dispatching and already-unknown controls retire without inventing a stopped outcome', (t) => {
  for (const phase of ['reserved', 'dispatching', 'unknown']) {
    const f = fixture(t)
    const pending = f.store.startCommand(`Old ${phase} instruction`, computer)
    if (phase !== 'reserved') f.store.markCommandDispatch(pending.id)
    if (phase === 'unknown') f.reopen()
    const original = f.rows('assistant_command')[0]?.value_json
    f.store.retireRemoteExecution()
    assert.equal(f.rows('assistant_command')[0]?.value_json, original)
    assert.equal(f.store.get(pending.id)?.status, 'interrupted')
    assert.equal(f.store.get(pending.id)?.error, 'assistant-remote-retired')
    assert.deepEqual(f.store.unresolvedCommands(), [])
    assert.equal(f.store.get(pending.id)?.command, undefined)
    assert.equal(f.store.hasUnreadMessages(), true)
  }
})

test('retired stopped commands and legacy checkpoints project no-retry markers without altering their stored outcomes', (t) => {
  const f = fixture(t)
  const stopped = f.store.startCommand('Old stopped remote instruction', computer)
  f.store.markCommandDispatch(stopped.id)
  f.store.recordCommandCheckpoint(stopped.id, checkpoint(stopped.id))
  f.store.recordCommandCheckpoint(stopped.id, null)
  f.store.finishCommand(stopped.id, { text: 'Stopped after partial work', steps: [], status: 'cancelled' }, 'stopped')
  const legacy = f.store.start('Legacy stopped remote instruction', 'codex')
  f.store.update(legacy.id, { text: 'Legacy partial work', steps: [], status: 'cancelled', error: null })
  f.store.setRemoteRun(checkpoint(legacy.id))
  const before = f.rows('assistant_message')
  const receipt = f.rows('assistant_command')[0]?.terminal_json
  f.store.retireRemoteExecution()
  assert.deepEqual(f.rows('assistant_message'), before)
  assert.equal(f.rows('assistant_command')[0]?.terminal_json, receipt)
  for (const id of [stopped.id, legacy.id]) {
    const value = f.store.get(id)
    assert.equal(value?.status, 'cancelled')
    assert.equal(value?.error, 'assistant-remote-retired-cancelled')
    assert.equal(value?.command, undefined)
    assert.equal(f.store.conversation(null).messages.find((message) => message.id === id)?.error, value?.error)
    assert.throws(() => f.store.start('', 'codex', id), /not-retryable/)
  }
  f.reopen()
  assert.deepEqual(f.rows('assistant_message'), before)
  assert.equal(f.store.get(stopped.id)?.error, 'assistant-remote-retired-cancelled')
  assert.equal(f.store.get(legacy.id)?.error, 'assistant-remote-retired-cancelled')
})
