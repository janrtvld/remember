import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { AssistantConversation, SendAssistantMessageInput } from '@remember/shared'
import { createBrowserAssistantBridge } from '../../../../web/lib/browserAssistantBridge'
import { createResidentAgentService, type ResidentAgentDriver } from '../residentAgentService'
import { ResidentAgentStore } from '../residentAgentStore'

const result = { provider: 'codex' as const, response: 'Ready', durationMs: 1, steps: [] }
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const computer = { kind: 'remote' as const, endpoint: 'ws://127.0.0.1:47999/', workspace: '/test/mini' }
const message = (text = 'Test input'): SendAssistantMessageInput & { clientMessageId: string } => ({
  clientMessageId: randomUUID(),
  text,
  provider: 'codex',
})

function setup(t: { after(fn: () => Promise<void>): void }, unified = false) {
  const directory = mkdtempSync(join(tmpdir(), 'remember-submission-'))
  const file = join(directory, 'conversation.sqlite')
  let allowed = true
  let target = computer
  let holdCancellation = false
  let confirmTerminal = true
  const calls: Parameters<ResidentAgentDriver['run']>[0][] = []
  const pending = new Map<string, () => void>()
  let onChanged: () => void = () => {}
  const create = () =>
    createResidentAgentService({
      store: new ResidentAgentStore(file),
      context: () => '',
      assertAvailable: () => {
        if (!allowed) throw new Error('unavailable')
      },
      changed: () => onChanged(),
      ...(unified ? { commands: { unified: true, target: () => ({ computer: target, label: 'Mini' }) } } : {}),
      driver: {
        run: async (input) => {
          calls.push(input)
          if (unified) {
            input.onDispatch?.()
            input.onCheckpoint({ computer, threadId: input.turnId, turnId: input.turnId, previousTurnId: null })
          }
          const answer = await new Promise<typeof result>((resolve) => pending.set(input.turnId, () => resolve(result)))
          if (unified && confirmTerminal) input.onCheckpoint(null)
          return answer
        },
        cancel: (id) => {
          if (!holdCancellation) pending.get(id)?.()
        },
      },
    })
  let service = create()
  t.after(async () => {
    holdCancellation = false
    for (const finish of pending.values()) finish()
    await service.dispose()
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    file,
    get service() {
      return service
    },
    calls,
    holdCancellation: () => {
      holdCancellation = true
    },
    leaveStopUnconfirmed: () => {
      confirmTerminal = false
    },
    changeTarget: () => {
      target = { ...computer, workspace: '/different' }
    },
    finish: () => {
      for (const finish of pending.values()) finish()
    },
    changed: (fn: () => void) => {
      onChanged = fn
    },
    revoke: () => {
      allowed = false
    },
    restart: async () => {
      await service.dispose()
      service = create()
    },
  }
}

test('client ID is present in events before ACK; retransmission during run and after reopen never reruns', async (t) => {
  const h = setup(t)
  const input = message()
  let event: AssistantConversation | undefined
  h.changed(() => {
    event = h.service.snapshot()
  })
  const accepted = h.service.send(input)
  assert.equal(event?.messages[0]?.id, input.clientMessageId)
  assert.equal(accepted.messages[0]?.id, input.clientMessageId)
  assert.equal(h.service.send(input).activeTurnId, accepted.activeTurnId)
  await tick()
  assert.equal(h.calls.length, 1)
  h.finish()
  await tick()
  await h.restart()
  assert.equal(h.service.send(input).messages.length, 2)
  await tick()
  assert.equal(h.calls.length, 1)
})

test('invalid IDs, conflicting payloads and unavailable duplicate sends do not dispatch', async (t) => {
  const h = setup(t)
  for (const clientMessageId of ['', 'not-a-uuid', 5, null])
    assert.throws(() => h.service.send({ ...message(), clientMessageId }), /invalid-assistant-message/)
  assert.equal(h.service.snapshot().messages.length, 0)
  const input = message()
  h.service.send(input)
  assert.throws(() => h.service.send({ ...input, text: 'Different work' }), /assistant-message-id-conflict/)
  assert.throws(() => h.service.send({ ...input, provider: 'claude' }), /assistant-message-id-conflict/)
  h.revoke()
  assert.throws(() => h.service.send(input), /unavailable/)
  await tick()
  assert.equal(h.calls.length <= 1, true)
  h.finish()
})

test('queued client ID survives dispatch and retransmission never duplicates a command', async (t) => {
  const h = setup(t, true)
  h.service.send(message('First'))
  await tick()
  const input = { ...message('Second'), queue: true }
  assert.equal(h.service.send(input).queuedMessages?.[0]?.id, input.clientMessageId)
  assert.equal(h.service.send(input).queuedMessages?.length, 1)
  h.finish()
  await tick()
  assert.equal(h.calls.length, 2)
  const current = h.service.send(input)
  assert.equal(current.queuedMessages?.length, 0)
  assert.equal(current.messages.filter((entry) => entry.id === input.clientMessageId).length, 1)
  assert.equal(current.messages.at(-1)?.replyTo, input.clientMessageId)
  h.finish()
  await tick()
  await h.restart()
  h.service.send(input)
  await tick()
  assert.equal(h.calls.length, 2)
})

test('discarded queue receipt survives restart and cannot be resurrected by a delayed retry', async (t) => {
  const h = setup(t, true)
  h.service.send(message('First'))
  await tick()
  const input = { ...message('Discarded'), queue: true }
  h.service.send(input)
  await h.service.cancel(input.clientMessageId)
  assert.equal(h.service.send(input).queuedMessages?.length, 0)
  h.finish()
  await tick()
  await h.restart()
  assert.equal(h.service.send(input).queuedMessages?.length, 0)
  await tick()
  assert.equal(h.calls.length, 1)
})

test('lost discard ACK can be retried without stopping or pausing other work, including after restart', async (t) => {
  const h = setup(t, true)
  const first = h.service.send(message('First'))
  await tick()
  const discarded = { ...message('Edit this'), queue: true }
  const later = { ...message('Keep waiting'), queue: true }
  h.service.send(discarded)
  h.service.send(later)
  await h.service.cancel(discarded.clientMessageId)
  await h.service.cancel(discarded.clientMessageId)
  assert.equal(h.service.snapshot().activeTurnId, first.activeTurnId)
  assert.deepEqual(h.service.snapshot().queuedMessages, [
    { id: later.clientMessageId, text: later.text, state: 'waiting' },
  ])
  h.finish()
  await tick()
  const next = h.service.snapshot().activeTurnId
  assert(next && next !== first.activeTurnId)
  await h.service.cancel(discarded.clientMessageId)
  assert.equal(h.service.snapshot().activeTurnId, next)
  h.finish()
  await tick()
  await h.restart()
  const restarted = h.service.send(message('After restart'))
  await tick()
  const pending = { ...message('Still waiting'), queue: true }
  h.service.send(pending)
  await h.service.cancel(discarded.clientMessageId)
  assert.equal(h.service.snapshot().activeTurnId, restarted.activeTurnId)
  assert.deepEqual(h.service.snapshot().queuedMessages, [
    { id: pending.clientMessageId, text: pending.text, state: 'waiting' },
  ])
  assert.equal(h.calls.length, 3)
})

test('discard rejects an already dispatched queue ID without stopping its command or pausing later work', async (t) => {
  const h = setup(t, true)
  h.service.send(message('First'))
  await tick()
  const sent = { ...message('Already sent'), queue: true }
  h.service.send(sent)
  h.finish()
  await tick()
  const active = h.service.snapshot().activeTurnId
  const pending = { ...message('Keep waiting'), queue: true }
  h.service.send(pending)
  await assert.rejects(h.service.cancel(sent.clientMessageId), /assistant-queue-already-sent/)
  assert.equal(h.service.snapshot().activeTurnId, active)
  assert.deepEqual(h.service.snapshot().queuedMessages, [
    { id: pending.clientMessageId, text: pending.text, state: 'waiting' },
  ])
  await assert.rejects(h.service.cancel(randomUUID()), /exact-control-required/)
})

test('a dispatched queue ID outside the visible history still rejects discard after restart', async (t) => {
  const h = setup(t, true)
  h.service.send(message('First'))
  await tick()
  const sent = { ...message('Old queued input'), queue: true }
  h.service.send(sent)
  h.finish()
  await tick()
  h.finish()
  await tick()
  for (let index = 0; index < 21; index += 1) {
    h.service.send(message(`Later input ${index}`))
    await tick()
    h.finish()
    await tick()
  }
  await h.restart()
  const snapshot = h.service.snapshot()
  assert.equal(snapshot.hasEarlier, true)
  assert.equal(
    snapshot.messages.some((entry) => entry.id === sent.clientMessageId),
    false
  )
  await assert.rejects(h.service.cancel(sent.clientMessageId), /assistant-queue-already-sent/)
  assert.equal(h.service.snapshot().activeTurnId, null)
})

test('discard receipt and queue removal commit atomically', async (t) => {
  const h = setup(t, true)
  h.service.send(message('First'))
  await tick()
  const queued = { ...message('Must survive failed discard'), queue: true }
  h.service.send(queued)
  const database = new DatabaseSync(h.file)
  t.after(async () => database.close())
  database.exec(
    'CREATE TRIGGER reject_discard BEFORE INSERT ON assistant_queue_discard BEGIN SELECT RAISE(IGNORE); END'
  )
  await assert.rejects(h.service.cancel(queued.clientMessageId), /write-not-persisted/)
  assert.deepEqual(h.service.snapshot().queuedMessages, [
    { id: queued.clientMessageId, text: queued.text, state: 'waiting' },
  ])
  assert.equal(database.prepare('SELECT count(*) AS count FROM assistant_queue_discard').get()?.count, 0)
  database.exec('DROP TRIGGER reject_discard')
  await h.service.cancel(queued.clientMessageId)
  assert.equal(h.service.snapshot().queuedMessages?.length, 0)
})

test('message and durable receipt commit atomically when receipt insertion fails', (t) => {
  const h = setup(t)
  const database = new DatabaseSync(h.file)
  database.exec(
    'CREATE TRIGGER reject_submission BEFORE INSERT ON assistant_submission BEGIN SELECT RAISE(IGNORE); END'
  )
  assert.throws(() => h.service.send(message()), /write-not-persisted/)
  assert.equal(h.service.snapshot().messages.length, 0)
  assert.equal(database.prepare('SELECT count(*) AS count FROM assistant_submission').get()?.count, 0)
  database.close()
})

test('browser preview reconciles client IDs and duplicate sends before promise acknowledgement', async (t) => {
  const bridge = createBrowserAssistantBridge()
  t.after(async () => {
    await bridge.cancelAssistantTurn()
  })
  const input = message()
  let event: Promise<AssistantConversation> | undefined
  bridge.onAssistantChanged(() => {
    event = bridge.getAssistantConversation()
  })
  const pending = bridge.sendAssistantMessage(input)
  assert.equal((await event)?.messages[0]?.id, input.clientMessageId)
  assert.equal((await pending).messages.length, 2)
  assert.equal((await bridge.sendAssistantMessage(input)).messages.length, 2)
  await assert.rejects(bridge.sendAssistantMessage({ ...input, text: 'different' }), /id-conflict/)
})

test('Send now requires the exact active turn, waits for confirmed stop and consumes selected queue once', async (t) => {
  const h = setup(t, true)
  const first = h.service.send(message('First'))
  await tick()
  const queued = { ...message('Send this now'), queue: true }
  const later = { ...message('Leave paused'), queue: true }
  h.service.send(queued)
  h.service.send(later)
  await assert.rejects(h.service.sendQueued({ queuedMessageId: queued.clientMessageId }), /exact-control-required/)
  await assert.rejects(
    h.service.sendQueued({ queuedMessageId: queued.clientMessageId, interruptMessageId: 'stale' }),
    /exact-control-required/
  )
  h.holdCancellation()
  const input = { queuedMessageId: queued.clientMessageId, interruptMessageId: first.activeTurnId }
  const sent = h.service.sendQueued(input)
  const duplicate = h.service.sendQueued(input)
  await tick()
  assert.equal(h.calls.length, 1)
  assert.equal(h.service.snapshot().queuedMessages?.length, 2)
  h.finish()
  await Promise.all([sent, duplicate])
  await tick()
  assert.equal(h.calls.length, 2)
  assert.equal(h.service.snapshot().messages.at(-1)?.replyTo, queued.clientMessageId)
  assert.deepEqual(h.service.snapshot().queuedMessages, [
    { id: later.clientMessageId, text: later.text, state: 'paused' },
  ])
  assert.equal((await h.service.sendQueued(input)).messages.length, 4)
  h.finish()
})

test('Send now preserves a paused queue when stop is unconfirmed', async (t) => {
  const h = setup(t, true)
  h.leaveStopUnconfirmed()
  const first = h.service.send(message('First'))
  await tick()
  const queued = { ...message('Later'), queue: true }
  h.service.send(queued)
  await assert.rejects(
    h.service.sendQueued({ queuedMessageId: queued.clientMessageId, interruptMessageId: first.activeTurnId }),
    /stop-unconfirmed/
  )
  assert.equal(h.calls.length, 1)
  assert.deepEqual(h.service.snapshot().queuedMessages, [
    { id: queued.clientMessageId, text: queued.text, state: 'paused' },
  ])
})

for (const change of ['remove', 'target', 'permission'] as const) {
  test(`Send now revalidates ${change} after awaiting stop`, async (t) => {
    const h = setup(t, true)
    const first = h.service.send(message('First'))
    await tick()
    const queued = { ...message('Later'), queue: true }
    h.service.send(queued)
    h.holdCancellation()
    const sent = h.service.sendQueued({
      queuedMessageId: queued.clientMessageId,
      interruptMessageId: first.activeTurnId,
    })
    if (change === 'remove') await h.service.cancel(queued.clientMessageId)
    if (change === 'target') h.changeTarget()
    if (change === 'permission') h.revoke()
    const rejected = assert.rejects(
      sent,
      change === 'remove' ? /queue-missing/ : change === 'target' ? /target-changed/ : /unavailable/
    )
    h.finish()
    await rejected
    assert.equal(h.calls.length, 1)
  })
}

test('Send now resumes an explicitly selected paused queue after restart without starting other queued work', async (t) => {
  const h = setup(t, true)
  const first = h.service.send(message('First'))
  await tick()
  const queued = { ...message('Later'), queue: true }
  h.service.send(queued)
  await h.service.cancel(first.activeTurnId ?? undefined)
  await h.restart()
  assert.equal(h.service.snapshot().queuedMessages?.[0]?.state, 'paused')
  await h.service.sendQueued({ queuedMessageId: queued.clientMessageId })
  await tick()
  assert.equal(h.calls.length, 2)
  assert.equal(h.service.snapshot().messages.at(-1)?.replyTo, queued.clientMessageId)
  h.finish()
})
