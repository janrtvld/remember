import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { callCodexClientTool } from '../codexClientTools'
import type { ProactiveDecision } from '../dailyReview/proactiveStore'
import { createResidentAgentService, type ResidentAgentDriver } from '../residentAgentService'
import { ResidentAgentStore } from '../residentAgentStore'

const now = 1_800_000_000_000
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const result = {
  provider: 'codex' as const,
  response: 'Mitchel handles the store publication.',
  steps: [],
  durationMs: 1,
}
const toolContext = { threadId: 'fixture', turnId: 'fixture', callId: 'fixture', signal: new AbortController().signal }
function fixture(t: { after(fn: () => void | Promise<void>): void }, kind: 'day' | 'note' | 'context' = 'day') {
  const directory = mkdtempSync('/private/tmp/remember-chat-context-')
  const file = join(directory, 'chat.sqlite')
  let store = new ResidentAgentStore(file, { now: () => now })
  const sourceId = kind === 'day' ? `day-sync:${'e'.repeat(64)}` : 'source-A'
  const initiative: ProactiveDecision = {
    id: 'build-status',
    kind: 'clarify',
    topicKey: 'store-publication',
    text: 'Both production builds are successful. Has the Woub store publication been confirmed?',
    createdAt: now,
    expiresAt: now + 60_000,
    policyToken: 'policy',
    conversationGeneration: 0,
    inputHash: 'a'.repeat(64),
    consumerGeneration: 1,
    deletionRevision: 0,
    deliveredMessageId: null,
    invalidatedAt: null,
    sourceIds: [`${kind}:${sourceId}`],
    supportingQuotes: [{ sourceId: `${kind}:${sourceId}`, quote: 'Builds successful' }],
    sourceRefs: [
      {
        kind,
        sourceId,
        evidenceId: `${kind}:${sourceId}`,
        eventId: 'event-A',
        eventRevision: 'b'.repeat(64),
        revision: 'c'.repeat(64),
        contentKey: 'd'.repeat(64),
        workdayId: kind === 'note' ? '' : 'day-A',
        observedAt: now,
        appName: '',
        windowTitle: '',
        url: '',
      },
    ],
  }
  const initiativeId = store.appendProactiveInitiative(initiative)
  assert(initiativeId)
  let valid = true
  let pending = false
  let finish!: (result: Awaited<ReturnType<ResidentAgentDriver['run']>>) => void
  let calls: Parameters<ResidentAgentDriver['run']>[0][] = []
  const create = () =>
    createResidentAgentService({
      store,
      context: () => '{}',
      assertAvailable() {},
      changed() {},
      proactive: { canPublish: () => true, changed() {}, messagePermitted: () => valid, now: () => now },
      replyContextPermitted: () => valid,
      driver: {
        cancel() {},
        run: async (input) => {
          calls.push(input)
          return pending
            ? new Promise((resolve) => {
                finish = resolve
              })
            : result
        },
      },
    })
  let service = create()
  t.after(async () => {
    await service.dispose()
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    get store() {
      return store
    },
    get service() {
      return service
    },
    get calls() {
      return calls
    },
    initiativeId,
    revoke() {
      valid = false
    },
    hold() {
      pending = true
    },
    finish() {
      finish(result)
    },
    async reopen() {
      await service.dispose()
      store = new ResidentAgentStore(file, { now: () => now })
      calls = []
      service = create()
    },
  }
}
for (const kind of ['day', 'note', 'context'] as const) {
  test(`${kind} initiative and ownership correction continue as one conversation after restart`, async (t) => {
    const f = fixture(t, kind)
    f.service.send({ text: 'Mitchel is picking that up.', provider: 'codex' })
    await tick()
    assert.match(f.calls[0].prompt, /Both production builds are successful/)
    assert.match(f.calls[0].prompt, /Mitchel is picking that up/)
    assert.match(f.calls[0].prompt, /"origin":"initiative"/)
    assert.equal(f.store.replyContext(f.calls[0].turnId)[0]?.messageId, f.initiativeId)
    await f.reopen()
    f.service.send({ text: 'Who handles it again?', provider: 'codex' })
    await tick()
    assert.match(f.calls[0].prompt, /Both production builds are successful/)
    assert.match(f.calls[0].prompt, /Mitchel is picking that up/)
    assert.match(f.calls[0].prompt, /Mitchel handles the store publication/)
  })
}

test('source loss hides the initiative and derived replies, and latches before late output', async (t) => {
  const f = fixture(t)
  f.service.send({ text: 'Mitchel is picking that up.', provider: 'codex' })
  await tick()
  f.hold()
  f.service.send({ text: 'Thanks.', provider: 'codex' })
  await tick()
  const active = f.calls[1]
  f.revoke()
  assert.throws(() => active.assertContextCurrent?.(), /context-changed/)
  f.finish()
  await tick()
  assert.equal(f.store.get(active.turnId)?.text, '')
  const snapshot = JSON.stringify(f.service.snapshot())
  assert(!snapshot.includes('Both production builds'))
  assert(!snapshot.includes(result.response))
})

test('older chat pages progress without gaps, survive restart and need no source archive read', async (t) => {
  const f = fixture(t)
  for (let index = 0; index < 35; index++) {
    const turn = f.store.start(`user-${index}`, 'codex')
    f.store.update(turn.id, { text: `assistant-${index}`, status: 'completed', steps: [] })
  }
  await f.reopen()
  f.service.send({ text: 'Recall our earlier conversation.', provider: 'codex' })
  await tick()
  const call = f.calls[0]
  const inline = JSON.parse(
    call.prompt.split('Continuing conversation:\n')[1].split('\n\n=== Current user request ===')[0]
  )
  assert.equal(inline.messages.length, 40)
  assert(!inline.messages.some((entry: { text: string }) => entry.text === 'user-0'))
  assert(call.conversationTool)
  const earlier = (await call.conversationTool.call({ before: inline.nextBefore }, toolContext)) as typeof inline
  assert(earlier.messages.some((entry: { text: string }) => entry.text === 'user-0'))
  assert(earlier.messages.some((entry: { id: string }) => entry.id === f.initiativeId))
  assert.equal(earlier.nextBefore, null)
  const ids = [...inline.messages, ...earlier.messages].map((entry: { id: string }) => entry.id)
  assert.equal(new Set(ids).size, 71)
  assert.equal(f.store.replyContext(call.turnId)[0]?.messageId, f.initiativeId)
})

test('escaped long messages stay within tool limits and can be read in full', async (t) => {
  const f = fixture(t)
  const turn = f.store.start('Long response please.', 'codex')
  const text = '"\\\n🙂'.repeat(5000)
  f.store.update(turn.id, { text, status: 'completed', steps: [] })
  f.service.send({ text: 'Recall the long response.', provider: 'codex' })
  await tick()
  const tool = f.calls[0].conversationTool
  assert(tool)
  let restored = '',
    offset: number | null = 0
  while (offset !== null) {
    const response = await callCodexClientTool(tool, { messageId: turn.id, offset }, toolContext)
    assert(response.success)
    const chunk = JSON.parse(response.contentItems[0].text)
    restored += chunk.text
    assert(chunk.nextOffset === null || chunk.nextOffset > offset)
    offset = chunk.nextOffset
  }
  assert.equal(restored, text)
  const page = await callCodexClientTool(tool, { before: f.store.get(f.calls[0].turnId)?.replyTo }, toolContext)
  assert(page.success)
  assert(page.contentItems[0].text.length <= 32_000)
})

test('history tools reject malformed, future and reset cursors; cancellation prevents reads', async (t) => {
  const f = fixture(t)
  f.service.send({ text: 'Thanks.', provider: 'codex' })
  await tick()
  const tool = f.calls[0].conversationTool
  assert(tool)
  for (const input of [
    {},
    { before: 'absent' },
    { messageId: f.calls[0].turnId },
    { before: f.initiativeId, offset: 1 },
    { messageId: f.initiativeId, offset: -1 },
  ])
    await assert.rejects(tool.call(input, toolContext), /history/)
  await assert.rejects(tool.call({ before: f.initiativeId }, { ...toolContext, signal: AbortSignal.abort() }))
  f.store.resetContext()
  await assert.rejects(tool.call({ before: f.initiativeId }, toolContext), /history/)
})

test('retrying an older failed request retains later user corrections in the same conversation', async (t) => {
  const f = fixture(t)
  const old = f.store.start('Who handles the publication?', 'codex')
  f.store.update(old.id, { text: '', status: 'failed', steps: [] })
  const correction = f.store.start('Sam handles it now, instead of Mitchel.', 'codex')
  f.store.update(correction.id, { text: 'Sam handles the publication.', status: 'completed', steps: [] })
  f.service.retry(old.id)
  await tick()
  assert.match(f.calls[0].prompt, /Sam handles it now/)
  assert.match(f.calls[0].prompt, /Sam handles the publication/)
})
