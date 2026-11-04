import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { ProactiveDecision } from '../dailyReview/proactiveStore'
import { createResidentAgentService, type ResidentAgentDriver } from '../residentAgentService'
import { ResidentAgentStore } from '../residentAgentStore'

const NOW = 1_800_000_000_000
const text = 'Notitie: de introductie mist een concreet voorbeeld.'
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

function toolSource(decision: ProactiveDecision, sourceText = text) {
  return decision.sourceRefs.map((ref) => ({
    ...ref,
    text: sourceText,
    sequence: 1,
    acceptedAt: NOW,
    source: 'day-sync',
    bundleId: '',
    provenance: { speaker: 'unknown' as const, mediaPlayback: 'unknown' as const, inputRoute: 'day-sync' },
  }))
}
function setup(t: { after(fn: () => void | Promise<void>): void }, kind: 'note' | 'day' = 'note') {
  const directory = mkdtempSync('/private/tmp/rpa6-lineage-')
  const file = join(directory, 'chat.sqlite')
  const store = new ResidentAgentStore(file, { now: () => NOW })
  let close: () => void | Promise<void> = () => {
    try {
      store.close()
    } catch {}
  }
  t.after(async () => {
    await close()
    rmSync(directory, { recursive: true, force: true })
  })
  const sourceId = kind === 'note' ? 'note-A' : `day-sync:${'e'.repeat(64)}`
  const evidenceId = `${kind}:${sourceId}`
  const decision: ProactiveDecision = {
    id: `${kind}-decision`,
    kind: 'clarify',
    text,
    topicKey: 'note-intro',
    sourceIds: [evidenceId],
    supportingQuotes: [{ sourceId: evidenceId, quote: text }],
    createdAt: NOW,
    expiresAt: NOW + 60_000,
    policyToken: 'policy',
    conversationGeneration: 0,
    inputHash: 'a'.repeat(64),
    consumerGeneration: 1,
    deletionRevision: 0,
    deliveredMessageId: null,
    invalidatedAt: null,
    sourceRefs: [
      {
        kind,
        sourceId,
        evidenceId,
        eventId: 'event-A',
        eventRevision: 'b'.repeat(64),
        revision: 'c'.repeat(64),
        contentKey: 'd'.repeat(64),
        workdayId: kind === 'note' ? '' : 'day-A',
        observedAt: NOW,
        appName: '',
        windowTitle: '',
        url: '',
      },
    ],
  }
  const messageId = store.appendProactiveInitiative(decision)
  assert(messageId)
  const reference = { kind: 'initiative' as const, decisionId: decision.id, messageId, inputHash: decision.inputHash }
  return {
    store,
    file,
    decision,
    reference,
    cleanup: (fn: typeof close) => {
      close = fn
    },
  }
}

test('Note receipt and exact ordinary lineage survive reopen; conflicting identity cannot rebind', (t) => {
  const f = setup(t)
  const turn = f.store.start('Wat bedoel je?', 'codex')
  f.store.recordReplyContext(turn.id, [f.reference])
  f.store.recordReplyContext(turn.id, [f.reference])
  assert.deepEqual(f.store.replyContext(turn.id), [f.reference])
  for (const field of ['decisionId', 'messageId', 'inputHash']) {
    const other = f.store.start('Andere vraag', 'codex')
    assert.throws(() => f.store.recordReplyContext(other.id, [{ ...f.reference, [field]: 'forged' }]), /reply-context/)
    assert.deepEqual(f.store.replyContext(other.id), [])
  }
  f.store.close()
  const reopened = new ResidentAgentStore(f.file, { now: () => NOW })
  assert.deepEqual(reopened.replyContext(turn.id), [f.reference])
  reopened.close()
})

test('Note never acquires prepare authority or an invented day', (t) => {
  const f = setup(t)
  assert.throws(
    () => f.store.appendProactiveInitiative({ ...f.decision, id: 'bad', kind: 'prepare' }),
    /invalid-proactive/
  )
  assert.throws(
    () =>
      f.store.appendProactiveInitiative({
        ...f.decision,
        id: 'bad',
        sourceRefs: f.decision.sourceRefs.map((s) => ({ ...s, workdayId: 'invented' })),
      }),
    /invalid-proactive/
  )
})

test('ordinary Note follow-up records exact lineage, drops late output and excludes source/derivative after deletion', async (t) => {
  const f = setup(t)
  let valid = true
  let admitted = true
  const calls: Parameters<ResidentAgentDriver['run']>[0][] = []
  let finish!: (value: Awaited<ReturnType<ResidentAgentDriver['run']>>) => void
  const service = createResidentAgentService({
    store: f.store,
    assertAvailable() {},
    changed() {},
    separateTaskActions: true,
    proactive: { canPublish: () => true, changed() {}, messagePermitted: () => valid, now: () => NOW },
    replyContextPermitted: () => valid,
    context: () => ({
      text: valid && admitted ? text : '{}',
      replyContext: {
        references: valid && admitted ? [f.reference] : [],
        assertCurrent: () => {
          if (admitted && !valid) throw new Error('note-deleted')
        },
      },
    }),
    driver: {
      run: (input) => {
        calls.push(input)
        return new Promise((resolve) => {
          finish = resolve
        })
      },
      cancel() {},
    },
  })
  f.cleanup(() => service.dispose())
  service.send({ text: 'Leg dit uit', provider: 'codex' })
  await tick()
  assert.equal(calls.length, 1)
  assert.match(calls[0].prompt, /introductie mist/)
  assert.deepEqual(f.store.replyContext(calls[0].turnId), [f.reference])
  finish({ provider: 'codex', response: 'DERIVED-NOTE-ANSWER', durationMs: 1, steps: [] })
  await tick()
  valid = false
  admitted = false
  assert(!JSON.stringify(service.snapshot()).includes('DERIVED-NOTE-ANSWER'))
  service.send({ text: 'Wat weet je nog?', provider: 'codex' })
  await tick()
  assert.equal(calls.length, 2)
  assert(!calls[1].prompt.includes(text))
  assert(!calls[1].prompt.includes('DERIVED-NOTE-ANSWER'))
  finish({ provider: 'codex', response: 'Geen huidige notitie.', durationMs: 1, steps: [] })
  await tick()
  valid = true
  admitted = true
  service.send({ text: 'Opnieuw uitleg', provider: 'codex' })
  await tick()
  valid = false
  assert.throws(() => calls[2].assertContextCurrent?.(), /context/)
  finish({ provider: 'codex', response: 'LATE-PRIVATE', durationMs: 1, steps: [] })
  await tick()
  assert.equal(f.store.get(calls[2].turnId)?.text, '')
})

test('unadmitted Note initiative is excluded from ordinary input even while source is current', async (t) => {
  const f = setup(t)
  let prompt = ''
  const service = createResidentAgentService({
    store: f.store,
    assertAvailable() {},
    changed() {},
    context: () => '{}',
    separateTaskActions: true,
    proactive: { canPublish: () => true, changed() {}, messagePermitted: () => true, now: () => NOW },
    driver: {
      run: async (input) => {
        prompt = input.prompt
        return { provider: 'codex', response: 'OK', durationMs: 1, steps: [] }
      },
      cancel() {},
    },
  })
  f.cleanup(() => service.dispose())
  service.send({ text: 'Hallo', provider: 'codex' })
  await tick()
  assert(!prompt.includes(text))
})

test('prepared ordinary Note context is bounded, current and guarded independently of its delivered receipt', async (t) => {
  const { prepareNoteChatContext, assertNoteReplyReference } = await import('../residentNoteContext')
  const f = setup(t)
  let valid = true
  const dependencies = {
    store: f.store,
    current: () =>
      valid
        ? f.decision.sourceRefs.map((ref) => ({
            ...ref,
            text,
            sequence: 1,
            acceptedAt: NOW,
            source: 'saved-note',
            bundleId: '',
            provenance: { speaker: 'unknown' as const, mediaPlayback: 'unknown' as const, inputRoute: 'saved-note' },
          }))
        : null,
  }
  const prepared = prepareNoteChatContext(dependencies)
  assert.deepEqual(prepared.references, [f.reference])
  assert.equal(prepared.notes[0]?.sources[0]?.text, text)
  assert.deepEqual(prepareNoteChatContext(dependencies, 0).notes, [])
  assert.deepEqual(prepareNoteChatContext(dependencies, 3, 2).notes, [])
  valid = false
  assert.throws(prepared.assertCurrent, /note-context-unavailable/)
  assert.deepEqual(prepareNoteChatContext(dependencies).notes, [])
  valid = true
  assert.throws(
    () => assertNoteReplyReference({ ...f.reference, inputHash: 'f'.repeat(64) }, dependencies),
    /note-context-unavailable/
  )
})

test('private chat follows only the preceding assistant and carries its exact lineage beyond the history window', async (t) => {
  const { prepareNoteChatContext } = await import('../residentNoteContext')
  const f = setup(t)
  const latestDecision = {
    ...f.decision,
    id: 'latest-offer',
    topicKey: 'latest-topic',
    text: 'A different useful offer.',
  }
  const latestId = f.store.appendProactiveInitiative(latestDecision)
  assert(latestId)
  const checked: string[] = []
  let valid = true
  const dependencies = {
    store: f.store,
    current: (decision: ProactiveDecision) => {
      checked.push(decision.id)
      return valid
        ? decision.sourceRefs.map((ref) => ({
            ...ref,
            text,
            sequence: 1,
            acceptedAt: NOW,
            source: 'saved-note',
            bundleId: '',
            provenance: { speaker: 'unknown' as const, mediaPlayback: 'unknown' as const, inputRoute: 'saved-note' },
          }))
        : null
    },
  }
  const computer = { kind: 'remote' as const, endpoint: 'ws://127.0.0.1:47831/', workspace: '/private/tmp/reply-chain' }
  const finish = (id: string) => {
    f.store.markCommandDispatch(id)
    f.store.recordCommandCheckpoint(id, {
      computer,
      messageId: id,
      threadId: `thread:${id}`,
      turnId: `turn:${id}`,
      previousTurnId: null,
    })
    f.store.recordCommandCheckpoint(id, null)
    f.store.finishCommand(id, { text: 'A source-backed reply.', status: 'completed', steps: [] }, 'completed')
  }
  for (let index = 0; index < 5; index++) {
    const turn = f.store.startCommand(index === 0 ? 'Ja graag' : 'Werk dat verder uit', computer)
    const prepared = prepareNoteChatContext(dependencies, 3, 48_000, turn.id)
    assert.deepEqual(
      prepared.references.map((ref) => ref.messageId),
      [latestId]
    )
    f.store.recordReplyContext(turn.id, prepared.references)
    finish(turn.id)
  }
  assert(!f.store.history(true).some((message) => message.id === latestId))
  assert(
    checked.every((id) => id === latestDecision.id),
    'Older unrelated offers are never validated or attached'
  )
  const unrelated = f.store.startCommand('Een ander onderwerp', computer)
  finish(unrelated.id)
  checked.length = 0
  const fresh = f.store.startCommand('Ik wil hier gewoon met je kunnen praten.', computer)
  const prepared = prepareNoteChatContext(dependencies, 3, 48_000, fresh.id)
  assert.deepEqual(prepared.references, [])
  valid = false
  prepared.assertCurrent()
  assert.deepEqual(checked, [])
})

test('stopped, reset and unavailable prior replies never cause traversal back to older initiatives', async (t) => {
  const { prepareNoteChatContext } = await import('../residentNoteContext')
  const f = setup(t, 'day')
  let valid = true
  const dependencies = {
    store: f.store,
    current: (decision: ProactiveDecision) =>
      valid
        ? decision.sourceRefs.map((ref) => ({
            ...ref,
            text,
            sequence: 1,
            acceptedAt: NOW,
            source: 'day-sync',
            bundleId: '',
            provenance: { speaker: 'unknown' as const, mediaPlayback: 'unknown' as const, inputRoute: 'day-sync' },
          }))
        : null,
  }
  const computer = { kind: 'remote' as const, endpoint: 'ws://127.0.0.1:47831/', workspace: '/private/tmp/reply-stop' }
  const first = f.store.startCommand('Ja graag', computer)
  const admitted = prepareNoteChatContext(dependencies, 3, 48_000, first.id)
  assert.deepEqual(admitted.references, [f.reference])
  valid = false
  assert.throws(admitted.assertCurrent, /note-context-unavailable/)
  assert.deepEqual(prepareNoteChatContext(dependencies, 3, 48_000, first.id).references, [])
  valid = true
  f.store.recordReplyContext(first.id, admitted.references)
  f.store.finishCommand(first.id, { text: '', status: 'cancelled', steps: [] }, 'unsubmitted')
  const afterStop = f.store.startCommand('Gewoon praten', computer)
  assert.deepEqual(prepareNoteChatContext(dependencies, 3, 48_000, afterStop.id).references, [])
  f.store.finishCommand(afterStop.id, { text: '', status: 'cancelled', steps: [] }, 'unsubmitted')
  f.store.resetContext()
  const afterReset = f.store.startCommand('Nog een vraag', computer)
  assert.deepEqual(prepareNoteChatContext(dependencies, 3, 48_000, afterReset.id).references, [])
})

test('a new topic has no old-source dependency until the model requests the preceding reply', async (t) => {
  const f = setup(t, 'day')
  let valid = true
  let call: Parameters<ResidentAgentDriver['run']>[0] | undefined
  let finish: ((result: Awaited<ReturnType<ResidentAgentDriver['run']>>) => void) | undefined
  const computer = { kind: 'remote' as const, endpoint: 'ws://127.0.0.1:47831/', workspace: '/private/tmp/new-topic' }
  const service = createResidentAgentService({
    store: f.store,
    assertAvailable() {},
    changed() {},
    commands: { unified: true, target: () => ({ computer, label: 'Mini' }) },
    proactive: {
      canPublish: () => true,
      changed() {},
      messagePermitted: () => valid,
      now: () => NOW,
    },
    replyContextPermitted: () => valid,
    context: () => ({
      text: '{"previousReply":{"sourceBacked":true,"readTool":"remember_reply"}}',
      replyContext: { references: [], assertCurrent() {} },
    }),
    driver: {
      run: (input) => {
        call = input
        input.onDispatch?.()
        input.onCheckpoint({ computer, threadId: 'remote', turnId: 'turn', previousTurnId: null })
        input.onCheckpoint(null)
        return new Promise((resolve) => {
          finish = resolve
        })
      },
      cancel() {},
    },
  })
  f.cleanup(() => service.dispose())
  service.send({ text: 'Ik wil hier gewoon met je kunnen praten.', provider: 'codex' })
  await tick()
  assert(call && finish)
  assert(!call.prompt.includes(text))
  assert.deepEqual(f.store.replyContext(call.turnId), [])
  valid = false
  call.assertContextCurrent?.()
  finish({ provider: 'codex', response: 'Natuurlijk, waar zit je aan te denken?', durationMs: 1, steps: [] })
  await tick()
  assert.equal(f.store.command(call.turnId)?.state, 'completed')
  assert.equal(service.snapshot().messages.at(-1)?.text, 'Natuurlijk, waar zit je aan te denken?')
})

test('lazy reply reads bind exact lineage before text exposure, are idempotent and stay bounded', async (t) => {
  const { createNoteReplyTool, noteReplyAvailable } = await import('../residentNoteContext')
  const f = setup(t, 'day')
  const computer = { kind: 'remote' as const, endpoint: 'ws://127.0.0.1:47831/', workspace: '/private/tmp/lazy-reply' }
  const turn = f.store.startCommand('Ja graag', computer)
  let valid = true
  let reread: ((signal: AbortSignal) => Promise<unknown>) | undefined
  let guard: (() => void) | undefined
  assert(noteReplyAvailable(f.store, turn.id))
  const tool = createNoteReplyTool({
    store: f.store,
    messageId: turn.id,
    current: (decision) => (valid ? toolSource(decision, `${'x'.repeat(40_000)}${text}${'y'.repeat(6000)}`) : null),
    assertAvailable() {},
    withSourceValidation: (operation) => operation(),
    admit: (context) => {
      context.assertCurrent()
      f.store.recordReplyContext(turn.id, context.references)
      guard = context.assertCurrent
    },
    recordRead: (_value, read) => {
      assert.deepEqual(f.store.replyContext(turn.id), [f.reference])
      reread = read
    },
  })
  const toolContext = { threadId: 'thread', turnId: 'turn', callId: 'read', signal: new AbortController().signal }
  const first = await tool.call({}, toolContext)
  assert.deepEqual(await tool.call({}, toolContext), first)
  assert.deepEqual(f.store.replyContext(turn.id), [f.reference])
  const output = JSON.stringify(first)
  assert(output.length <= 32_000)
  assert(output.includes(text))
  assert(output.includes('"truncated":true'))
  assert(reread && guard)
  for (let index = 0; index < 5; index++) {
    const later = f.store.start(`Later unrelated turn ${index}`, 'codex')
    f.store.update(later.id, { text: 'Another topic.', status: 'completed', steps: [] })
  }
  assert(!f.store.history(true).some((message) => message.id === turn.id))
  assert.deepEqual(await reread(toolContext.signal), first)
  valid = false
  assert.throws(guard, /note-context-unavailable/)
  assert.deepEqual(await reread(toolContext.signal), { available: false })
  valid = true
  f.store.markCommandDispatch(turn.id)
  f.store.recordCommandCheckpoint(turn.id, {
    computer,
    messageId: turn.id,
    threadId: 'remote',
    turnId: 'turn',
    previousTurnId: null,
  })
  f.store.recordCommandCheckpoint(turn.id, null)
  f.store.finishCommand(turn.id, { text: 'PRIVATE-LAZY-FOLLOWUP', status: 'completed', steps: [] }, 'completed')
  f.store.close()
  const reopened = new ResidentAgentStore(f.file, { now: () => NOW })
  assert.deepEqual(reopened.replyContext(turn.id), [f.reference])
  const restoredService = createResidentAgentService({
    store: reopened,
    assertAvailable() {},
    changed() {},
    context: () => '{}',
    proactive: { canPublish: () => true, changed() {}, messagePermitted: () => false },
    replyContextPermitted: () => false,
    driver: { run: async () => ({ provider: 'codex', response: '', durationMs: 1, steps: [] }), cancel() {} },
  })
  assert.equal(restoredService.snapshot().messages.find((message) => message.id === turn.id)?.text, '')
  await restoredService.dispose()
})

test('lazy selected source loss and original policy loss both latch before late output', async (t) => {
  const { createNoteReplyTool } = await import('../residentNoteContext')
  for (const revoked of ['source', 'policy']) {
    const f = setup(t, 'day')
    let valid = true,
      policy = true
    let call: Parameters<ResidentAgentDriver['run']>[0] | undefined
    let finish: ((result: Awaited<ReturnType<ResidentAgentDriver['run']>>) => void) | undefined
    const computer = {
      kind: 'remote' as const,
      endpoint: 'ws://127.0.0.1:47831/',
      workspace: '/private/tmp/lazy-guard',
    }
    const service = createResidentAgentService({
      store: f.store,
      assertAvailable() {},
      changed() {},
      commands: { unified: true, target: () => ({ computer, label: 'Mini' }) },
      proactive: { canPublish: () => true, changed() {}, messagePermitted: () => valid, now: () => NOW },
      replyContextPermitted: () => valid,
      context: () => ({
        text: '{}',
        replyContext: {
          references: [],
          assertCurrent() {
            if (!policy) throw new Error('policy-changed')
          },
        },
      }),
      driver: {
        run: async (input) => {
          call = input
          input.onDispatch?.()
          input.onCheckpoint({ computer, threadId: 'remote', turnId: 'turn', previousTurnId: null })
          input.onCheckpoint(null)
          assert(input.admitReplyContext)
          const tool = createNoteReplyTool({
            store: f.store,
            messageId: input.turnId,
            current: (decision) => (valid ? toolSource(decision) : null),
            assertAvailable: () => input.assertContextCurrent?.(),
            withSourceValidation: (operation) => operation(),
            admit: input.admitReplyContext,
            recordRead() {},
          })
          await tool.call(
            {},
            { threadId: 'remote', turnId: 'turn', callId: 'read', signal: new AbortController().signal }
          )
          return new Promise((resolve) => {
            finish = resolve
          })
        },
        cancel() {},
      },
    })
    f.cleanup(() => service.dispose())
    service.send({ text: 'Ja graag', provider: 'codex' })
    await tick()
    assert(call && finish)
    assert.deepEqual(f.store.replyContext(call.turnId), [f.reference])
    if (revoked === 'source') valid = false
    else policy = false
    assert.throws(() => call?.assertContextCurrent?.(), /context-changed/)
    valid = true
    policy = true
    finish({ provider: 'codex', response: 'LATE-PRIVATE', durationMs: 1, steps: [] })
    await tick()
    assert.equal(f.store.get(call.turnId)?.text, '')
  }
})

test('dismissed offers and conflicting retained identities cannot be lazily rebound', async (t) => {
  const { createNoteReplyTool, noteReplyAvailable } = await import('../residentNoteContext')
  const f = setup(t)
  const reply = f.store.start('Explain', 'codex')
  f.store.recordReplyContext(reply.id, [f.reference])
  f.store.update(reply.id, { text: 'Derived answer', status: 'completed', steps: [] })
  const probe = new DatabaseSync(f.file)
  probe
    .prepare('UPDATE assistant_reply_context SET references_json=? WHERE message_id=?')
    .run(JSON.stringify([{ ...f.reference, inputHash: 'f'.repeat(64) }]), reply.id)
  probe.close()
  const next = f.store.start('Elaborate', 'codex')
  const tool = createNoteReplyTool({
    store: f.store,
    messageId: next.id,
    current: toolSource,
    assertAvailable() {},
    withSourceValidation: (operation) => operation(),
    admit() {
      assert.fail('No rebinding')
    },
    recordRead() {},
  })
  const context = { threadId: 'thread', turnId: 'turn', callId: 'read', signal: new AbortController().signal }
  await assert.rejects(tool.call({}, context), /note-context-unavailable/)
  assert.deepEqual(f.store.replyContext(next.id), [])
  f.store.dismissProactiveInitiative(f.reference.messageId)
  assert.equal(noteReplyAvailable(f.store, next.id), false)
  assert.deepEqual(await tool.call({}, context), { available: false })
})

test('Day snapshot follows an explicit command with immutable lineage and loses access when the source is revoked', async (t) => {
  const { prepareNoteChatContext } = await import('../residentNoteContext')
  const f = setup(t, 'day')
  let valid = true
  const dependencies = {
    store: f.store,
    current: () =>
      valid
        ? f.decision.sourceRefs.map((ref) => ({
            ...ref,
            text,
            sequence: 1,
            acceptedAt: NOW,
            source: 'day-sync',
            bundleId: '',
            provenance: { speaker: 'unknown' as const, mediaPlayback: 'unknown' as const, inputRoute: 'day-sync' },
          }))
        : null,
  }
  const prepared = prepareNoteChatContext(dependencies)
  assert.deepEqual(prepared.notes, [])
  const source = f.decision.sourceRefs[0]
  assert(source)
  assert.deepEqual(prepared.days[0]?.sources, [{ dayId: 'day-A', snapshotId: source.sourceId, text, updatedAt: NOW }])
  assert.equal(f.store.get(f.reference.messageId)?.initiative?.sources[0]?.dayId, 'day-A')
  const command = f.store.startCommand('Werk dit verder uit', {
    kind: 'remote',
    endpoint: 'ws://127.0.0.1:47831/',
    workspace: '/private/tmp/day-sync-qa',
  })
  f.store.recordReplyContext(command.id, prepared.references)
  assert.deepEqual(f.store.replyContext(command.id), [f.reference])
  valid = false
  assert.throws(prepared.assertCurrent, /context-unavailable/)
  assert.deepEqual(prepareNoteChatContext(dependencies).days, [])
  f.store.close()
  const reopened = new ResidentAgentStore(f.file, { now: () => NOW })
  assert.deepEqual(reopened.replyContext(command.id), [f.reference])
  reopened.close()
})

test('Day receipts require the snapshot evidence identity and never authorize preparation', (t) => {
  const f = setup(t, 'day')
  assert.throws(
    () => f.store.appendProactiveInitiative({ ...f.decision, id: 'bad-prepare', kind: 'prepare' }),
    /invalid-proactive/
  )
  const sourceRefs = f.decision.sourceRefs.map((source) => ({ ...source, evidenceId: 'forged' }))
  assert.throws(
    () =>
      f.store.appendProactiveInitiative({
        ...f.decision,
        id: 'bad-source',
        sourceRefs,
        sourceIds: ['forged'],
        supportingQuotes: [{ sourceId: 'forged', quote: text }],
      }),
    /invalid-proactive/
  )
})

test('unified command latches Day source loss before regrant and withholds partial and late private text', async (t) => {
  const f = setup(t, 'day')
  let valid = true
  let call: Parameters<ResidentAgentDriver['run']>[0] | undefined
  let finish: ((result: Awaited<ReturnType<ResidentAgentDriver['run']>>) => void) | undefined
  const computer = { kind: 'remote' as const, endpoint: 'ws://127.0.0.1:47831/', workspace: '/private/tmp/lineage' }
  const service = createResidentAgentService({
    store: f.store,
    assertAvailable() {},
    changed() {},
    commands: { unified: true, target: () => ({ computer, label: 'Mini' }) },
    proactive: { canPublish: () => true, changed() {}, messagePermitted: () => valid, now: () => NOW },
    replyContextPermitted: () => valid,
    context: () => ({
      text,
      replyContext: {
        references: [f.reference],
        assertCurrent() {
          if (!valid) throw new Error('source-revoked')
        },
      },
    }),
    driver: {
      run(input) {
        call = input
        input.onDispatch?.()
        input.onCheckpoint({ computer, threadId: 'remote', turnId: 'turn', previousTurnId: null })
        input.onUpdate({
          type: 'response',
          text: 'PARTIAL-PRIVATE-DAY',
          id: 'response',
          turnId: input.turnId,
          at: NOW,
          provider: 'codex',
        })
        return new Promise((resolve) => {
          finish = resolve
        })
      },
      cancel() {},
    },
  })
  f.cleanup(() => service.dispose())
  service.send({ text: 'Leg de dagupdate uit', provider: 'codex' })
  await tick()
  assert(call && finish)
  assert.deepEqual(f.store.replyContext(call.turnId), [f.reference])
  try {
    valid = false
    assert.throws(() => call?.assertContextCurrent?.(), /source-revoked|context-changed/)
    valid = true
    assert.throws(() => call?.assertContextCurrent?.(), /context-changed/)
  } finally {
    call.onCheckpoint(null)
    finish({ provider: 'codex', response: 'LATE-PRIVATE-DAY', durationMs: 1, steps: [] })
    await tick()
  }
  assert.equal(f.store.get(call.turnId)?.text, '')
  assert(!JSON.stringify(service.snapshot()).includes('PRIVATE-DAY'))
})

test('unified follow-up cannot inherit an initiative absent from its admitted context', async (t) => {
  const f = setup(t, 'day')
  let prompt = ''
  const service = createResidentAgentService({
    store: f.store,
    assertAvailable() {},
    changed() {},
    commands: {
      unified: true,
      target: () => ({
        computer: { kind: 'remote', endpoint: 'ws://127.0.0.1:47831/', workspace: '/private/tmp/lineage' },
        label: 'Mini',
      }),
    },
    proactive: { canPublish: () => true, changed() {}, messagePermitted: () => true, now: () => NOW },
    replyContextPermitted: () => true,
    context: () => ({ text: '{}', replyContext: { references: [], assertCurrent() {} } }),
    driver: {
      async run(input) {
        prompt = input.prompt
        input.onDispatch?.()
        input.onCheckpoint(null)
        return { provider: 'codex', response: 'Hallo', durationMs: 1, steps: [] }
      },
      cancel() {},
    },
  })
  f.cleanup(() => service.dispose())
  service.send({ text: 'Hallo', provider: 'codex' })
  await tick()
  assert(!prompt.includes(text))
})
