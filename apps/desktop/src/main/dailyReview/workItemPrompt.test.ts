import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { WorkItem } from '@remember/shared'
import { WORK_ITEM_PROMPT_CHARACTER_BUDGET, workItemsForPrompt } from './workItemPrompt'

function workItem(id: string, lifecycle: WorkItem['lifecycle'], updatedAt: number): WorkItem {
  return {
    id,
    title: `Title ${id}`,
    description: `Description ${id}`,
    prompt: `Prompt ${id}`,
    context: `Context ${id}`,
    returnPoint: { lastMove: 'Last move', unresolved: 'Unresolved', nextMove: 'Next move' },
    lifecycle,
    status: 'todo',
    priority: 'none',
    dueAt: null,
    attention: 'idle',
    createdAt: updatedAt,
    updatedAt,
    closedAt: lifecycle === 'open' ? null : updatedAt,
    userEditedTitle: false,
    userEditedDescription: false,
    sources: [],
    facts: [],
    observations: [],
    agentSessions: [],
  }
}

describe('WorkItem analysis prompt projection', () => {
  it('preserves current open identity and context within strict field, history, and total budgets', () => {
    const current = {
      ...workItem('current-open', 'open', 1),
      status: 'in_progress' as const,
      attention: 'user_active' as const,
      description: 'd'.repeat(80_000),
      prompt: 'p'.repeat(80_000),
      context: 'c'.repeat(80_000),
      returnPoint: {
        lastMove: 'l'.repeat(80_000),
        unresolved: 'u'.repeat(80_000),
        nextMove: 'n'.repeat(80_000),
      },
    }
    const terminal = Array.from({ length: 100 }, (_, index) => workItem(`terminal-${index}`, 'completed', index + 2))

    const projected = workItemsForPrompt([...terminal, current])
    const preserved = projected.find((item) => item.id === current.id)

    assert.ok(preserved)
    assert.equal(preserved.lifecycle, 'open')
    assert.equal(preserved.status, 'in_progress')
    assert.equal(preserved.attention, 'user_active')
    assert.equal(preserved.context?.endsWith('…'), true)
    assert.equal(preserved.returnPoint?.unresolved.endsWith('…'), true)
    assert.ok(JSON.stringify(projected).length <= WORK_ITEM_PROMPT_CHARACTER_BUDGET)
    assert.ok(projected.some((item) => item.id === 'terminal-99'))
    assert.equal(
      projected.some((item) => item.id === 'terminal-0'),
      false
    )
    assert.equal(current.context.length, 80_000)
  })

  it('reserves room for open identities before adding rich context or terminal history', () => {
    const open = Array.from({ length: 40 }, (_, index) => ({
      ...workItem(`open-${index}`, 'open', 100 - index),
      status: 'in_progress' as const,
      attention: 'agent_running' as const,
      description: 'd'.repeat(80_000),
      prompt: 'p'.repeat(80_000),
      context: 'c'.repeat(80_000),
    }))
    const terminal = Array.from({ length: 24 }, (_, index) => workItem(`closed-${index}`, 'completed', index))

    const projected = workItemsForPrompt([...terminal, ...open])
    const projectedIds = new Set(projected.map((item) => item.id))

    assert.equal(
      open.every((item) => projectedIds.has(item.id)),
      true
    )
    assert.ok(projected.find((item) => item.id === 'open-0')?.context)
    const compact = projected.find((item) => item.lifecycle === 'open' && !item.context)
    assert.ok(compact, 'large queues must exercise the compact identity projection')
    assert.equal(compact.status, 'in_progress')
    assert.equal(compact.attention, 'agent_running')
    assert.ok(JSON.stringify(projected).length <= WORK_ITEM_PROMPT_CHARACTER_BUDGET)
  })
})

it('keeps all supported steps of a generated outcome in the next analysis', () => {
  const description = `${'A supported application requirement. '.repeat(14)}Final requirement: ask both references.`
  assert.ok(description.length > 320 && description.length < 600)
  const item = workItem('application', 'open', 10)
  item.description = description
  const [projected] = workItemsForPrompt([item])
  assert.equal(projected?.description, description)
})
