import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AgentInteraction, AgentInteractionAnswer } from '@remember/shared'
import { EvidenceStore } from '../dailyReview/evidenceStore'
import { ResidentAgentStore } from '../residentAgentStore'
import { createResidentTaskTool } from '../residentTaskTool'

function fixture(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync('/private/tmp/remember-task-tool-')
  const evidence = new EvidenceStore(join(directory, 'evidence.sqlite'))
  const store = new ResidentAgentStore(join(directory, 'chat.sqlite'))
  const item = evidence.createWorkItem('Derde sollicitatie', 'Bewaar de bestaande beschrijving.')
  const turn = store.start('Werk mijn derde sollicitatietaak bij.', 'codex')
  const controller = new AbortController()
  const context = { threadId: 'thread', turnId: 'turn', callId: 'call', signal: controller.signal }
  const reviews: Omit<AgentInteraction, 'id' | 'turnId' | 'createdAt'>[] = []
  let allowed = true
  let onReview: () => Promise<Pick<AgentInteractionAnswer, 'action' | 'values'>> = async () => ({
    action: 'accept',
    values: {},
  })
  let changes = 0
  const dependencies = {
    messageId: turn.id,
    evidence,
    store,
    assertAvailable() {},
    permitted: () => allowed,
    ask: async (request: Omit<AgentInteraction, 'id' | 'turnId' | 'createdAt'>) => {
      reviews.push(request)
      return { id: 'review', ...(await onReview()) }
    },
    changed: () => {
      changes++
    },
  }
  const tool = createResidentTaskTool(dependencies)
  t.after(() => {
    evidence.close()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    item,
    evidence,
    store,
    tool,
    context,
    controller,
    reviews,
    dependencies,
    changes: () => changes,
    revoke: () => {
      allowed = false
    },
    review: (callback: typeof onReview) => {
      onReview = callback
    },
    request: (field: string, value: unknown) => ({
      action: 'update',
      taskId: item.id,
      expectedUpdatedAt: item.updatedAt,
      field,
      value,
    }),
  }
}

test('explicit reviewed Task title update preserves other fields and replays its durable receipt without another write', async (t) => {
  const f = fixture(t)
  const read = await f.tool.call({ action: 'read', taskId: f.item.id }, f.context)
  assert.equal((read as { task: { updatedAt: number } }).task.updatedAt, f.item.updatedAt)
  const request = f.request('title', 'Vacature kiezen en solliciteren')
  const result = await f.tool.call(request, f.context)
  assert.equal((result as { saved: boolean }).saved, true)
  assert.equal(f.reviews.length, 1)
  assert.match(f.reviews[0].detail, /Van: Derde sollicitatie\nNaar: Vacature kiezen en solliciteren/)
  const saved = f.evidence.getWorkItem(f.item.id)
  assert(saved)
  assert.equal(saved.description, f.item.description)
  assert.equal(saved.lifecycle, 'open')
  assert.equal(saved.title, 'Vacature kiezen en solliciteren')
  assert.deepEqual(await f.tool.call(request, f.context), result)
  assert.equal(f.reviews.length, 1)
  assert.equal(f.changes(), 1)
  assert.equal(f.evidence.getWorkItem(f.item.id)?.updatedAt, saved.updatedAt)
})

test('completion is reviewed and decline leaves the task unchanged', async (t) => {
  const f = fixture(t)
  f.review(async () => ({ action: 'decline', values: {} }))
  assert.deepEqual(await f.tool.call(f.request('lifecycle', 'completed'), f.context), {
    saved: false,
    reason: 'user-declined',
  })
  assert.match(f.reviews[0].detail, /Van: Open\nNaar: Afgerond/)
  assert.deepEqual(f.evidence.getWorkItem(f.item.id), f.item)
  assert.equal(f.changes(), 0)
})

test('human changes while review is open cannot be overwritten by a stale model update', async (t) => {
  const f = fixture(t)
  f.review(async () => {
    f.evidence.updateWorkItem(f.item.id, 'Mijn gewijzigde titel', f.item.description)
    return { action: 'accept', values: {} }
  })
  await assert.rejects(f.tool.call(f.request('lifecycle', 'completed'), f.context), /revision-conflict/)
  assert.equal(f.evidence.getWorkItem(f.item.id)?.title, 'Mijn gewijzigde titel')
  assert.equal(f.evidence.getWorkItem(f.item.id)?.lifecycle, 'open')
  assert.equal(f.changes(), 0)
})

test('automatic Task changes at the same timestamp invalidate an open review', async (t) => {
  const f = fixture(t)
  const conversation = {
    externalId: 'revinote-meeting',
    source: 'revinote' as const,
    startTime: '14:00',
    endTime: '14:30',
    title: 'Partner review',
    description: 'The partner review produced one follow-up.',
    actionPoints: ['Send the revised proposal'],
    actionPointItems: [
      { id: 'revinote:revinote-meeting:action:0', text: 'Send the revised proposal', completed: false },
    ],
  }
  const sync = () =>
    f.evidence.synchronizeConversationActionPoints({
      workdayId: 'day-revinote-action',
      conversations: [conversation],
      observedAt: 1_000,
    })
  sync()
  const imported = f.evidence.listWorkItems().find((item) => item.title === conversation.actionPoints[0])
  assert(imported)
  f.review(async () => {
    conversation.actionPoints[0] = 'Send the signed proposal'
    conversation.actionPointItems[0].text = conversation.actionPoints[0]
    sync()
    return { action: 'accept', values: {} }
  })

  await assert.rejects(
    f.tool.call(
      {
        action: 'update',
        taskId: imported.id,
        expectedUpdatedAt: imported.updatedAt,
        field: 'lifecycle',
        value: 'completed',
      },
      f.context
    ),
    /revision-conflict/
  )
  const current = f.evidence.getWorkItem(imported.id)
  assert(current)
  assert(current.updatedAt > imported.updatedAt)
  assert.equal(current.title, 'Send the signed proposal')
  assert.equal(current.lifecycle, 'open')
  assert.equal(f.changes(), 0)
})

test('source revocation and cancellation during review prevent the write', async (t) => {
  for (const revoke of [true, false]) {
    const f = fixture(t)
    f.review(async () => {
      if (revoke) f.revoke()
      else f.controller.abort()
      return { action: 'accept', values: {} }
    })
    await assert.rejects(f.tool.call(f.request('status', 'in_progress'), f.context))
    assert.deepEqual(f.evidence.getWorkItem(f.item.id), f.item)
    assert.equal(f.changes(), 0)
  }
})

test('Task edits cannot originate from an unbound turn or accept invalid fields', async (t) => {
  const f = fixture(t)
  const unbound = createResidentTaskTool({ ...f.dependencies, messageId: 'missing-message' })
  await assert.rejects(unbound.call(f.request('status', 'in_progress'), f.context), /explicit-user-turn/)
  for (const request of [
    f.request('status', 'completed'),
    f.request('dueAt', -1),
    f.request('title', ''),
    { ...f.request('title', 'New'), status: 'in_progress' },
    { ...f.request('title', 'New'), expectedUpdatedAt: 'old' },
  ])
    await assert.rejects(f.tool.call(request, f.context), /invalid-task-tool-request/)
  assert.equal(f.reviews.length, 0)
})

test('lost receipt after a saved change remains unknown and never repeats the effect', async (t) => {
  const f = fixture(t)
  const tool = createResidentTaskTool({
    ...f.dependencies,
    store: {
      get: f.store.get.bind(f.store),
      claimToolCall: f.store.claimToolCall.bind(f.store),
      finishToolCall: () => {
        throw new Error('receipt-unavailable')
      },
    },
  })
  const request = f.request('dueAt', 1_900_000_000_000)
  await assert.rejects(tool.call(request, f.context), /receipt-unavailable/)
  const saved = f.evidence.getWorkItem(f.item.id)
  assert(saved)
  assert.equal(saved.dueAt, 1_900_000_000_000)
  assert.equal(saved.priority, f.item.priority)
  await assert.rejects(tool.call(request, f.context), /outcome-unknown-read-before-retrying/)
  assert.equal(f.evidence.getWorkItem(f.item.id)?.updatedAt, saved.updatedAt)
  assert.equal(f.reviews.length, 1)
})

test('all existing Task setters reject stale expected versions, including apparent no-ops', (t) => {
  const f = fixture(t)
  const edited = f.evidence.updateWorkItem(f.item.id, 'Nieuw', f.item.description, f.item.updatedAt)
  assert.throws(
    () => f.evidence.updateWorkItem(edited.id, edited.title, edited.description, f.item.updatedAt),
    /revision-conflict/
  )
  assert.throws(() => f.evidence.updateWorkItemMetadata(edited.id, edited, f.item.updatedAt), /revision-conflict/)
  assert.throws(() => f.evidence.setWorkItemLifecycle(edited.id, 'open', f.item.updatedAt), /revision-conflict/)
  assert.deepEqual(f.evidence.getWorkItem(f.item.id), edited)
})
