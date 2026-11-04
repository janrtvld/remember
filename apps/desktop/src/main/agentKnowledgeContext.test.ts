import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WorkItem } from '@remember/shared'
import { buildWorkItemAgentContext } from './agentKnowledgeContext'
import { REMEMBER_WORK_ITEM_CONTEXT_HEADER } from './agentTurnEnvelope'

const item: WorkItem = {
  id: 'item-1',
  title: 'Recover Atlas launch evidence',
  description: 'Use the authoritative launch notes, including every evidence rule and named owner.',
  prompt: '',
  context: 'Atlas evidence is stored in the team Wiki, not in the short Inbox label.',
  returnPoint: {
    lastMove: 'The recovery task was created.',
    unresolved: 'The exact launch owner still needs to be reported.',
    nextMove: 'Read the Atlas launch page.',
  },
  lifecycle: 'open',
  status: 'todo',
  priority: 'none',
  dueAt: null,
  attention: 'idle',
  createdAt: 1,
  updatedAt: 1,
  closedAt: null,
  userEditedTitle: false,
  userEditedDescription: false,
  sources: [],
  facts: [],
  observations: [],
  agentSessions: [],
}

test('preserves the saved work-item handoff without retrieving or adding Wiki knowledge', () => {
  const context = buildWorkItemAgentContext(item)
  assert.ok(context.startsWith(`${REMEMBER_WORK_ITEM_CONTEXT_HEADER}\n`))
  const handoff = JSON.parse(context.slice(REMEMBER_WORK_ITEM_CONTEXT_HEADER.length + 1))
  assert.deepEqual(handoff, {
    title: item.title,
    description: item.description,
    context: item.context,
    returnPoint: item.returnPoint,
  })
})
