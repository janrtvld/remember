import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createResidentArchiveTool } from '../residentArchiveTool'

const context = { signal: new AbortController().signal, threadId: 't', turnId: 'r', callId: 'c' }

test('canonical conversation command is exact, bounded, read-only and records its result', async () => {
  const calls: string[][] = []
  const recorded: unknown[] = []
  const tool = createResidentArchiveTool({
    run: async (args) => {
      calls.push(args)
      return { items: [] }
    },
    assertCurrent: () => {},
    onConversations: (row) => recorded.push(row),
  })
  await tool.call({ action: 'conversations', date: '2026-09-29', offset: 20 }, context)
  assert.deepEqual(calls, [['conversations', '2026-09-29', '--page', '--limit', '20', '--offset', '20']])
  assert.deepEqual(recorded, [{ items: [] }])
  for (const bad of [
    { action: 'delete' },
    { action: 'conversations', date: '2026-02-30' },
    { action: 'conversations', date: '2026-09-29', offset: -1 },
    { action: 'source', kind: 'audio', id: 'id' },
    { action: 'source', kind: 'conversation', id: '--all' },
    { action: 'search', query: 'x', shell: 'rm' },
    { action: 'days', date: '2026-09-29' },
  ])
    await assert.rejects(tool.call(bad, context))
  assert.equal(calls.length, 1)
})

test('revocation after asynchronous read withholds result and ledger admission', async () => {
  let allowed = true
  let recorded = false
  const tool = createResidentArchiveTool({
    run: async () => {
      allowed = false
      return { secret: true }
    },
    assertCurrent: () => {
      if (!allowed) throw new Error('revoked')
    },
    onConversations: () => {
      recorded = true
    },
  })
  await assert.rejects(tool.call({ action: 'conversations', date: '2026-09-29' }, context), /revoked/)
  assert.equal(recorded, false)
})

test('cancellation and transport failure are not an empty archive', async () => {
  let calls = 0
  const tool = createResidentArchiveTool({
    run: async () => {
      calls++
      throw new Error('offline')
    },
    assertCurrent: () => {},
    onConversations: () => assert.fail(),
  })
  await assert.rejects(tool.call({ action: 'days' }, { ...context, signal: AbortSignal.abort() }), /agent-cancelled/)
  assert.equal(calls, 0)
  await assert.rejects(tool.call({ action: 'days' }, context), /offline/)
})

test('days only exposes date metadata, never stored private summaries', async () => {
  const tool = createResidentArchiveTool({
    run: async () => [
      { id: 'day', date: '2026-09-29', startedAt: 1, endedAt: 2, summary: 'private', decisions: ['secret'] },
    ],
    assertCurrent: () => {},
    onConversations: () => assert.fail(),
  })
  assert.deepEqual(await tool.call({ action: 'days' }, context), [
    { id: 'day', date: '2026-09-29', startedAt: 1, endedAt: 2 },
  ])
})
