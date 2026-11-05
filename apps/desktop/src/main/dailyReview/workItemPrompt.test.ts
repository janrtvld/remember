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
      title: 't'.repeat(240),
      description: 'd'.repeat(80_000),
      prompt: 'p'.repeat(80_000),
      context: 'c'.repeat(80_000),
    }))
    const terminal = Array.from({ length: 24 }, (_, index) => workItem(`closed-${index}`, 'completed', index))
    for (const item of open) {
      item.observations = (['progress', 'blocked', 'completion_candidate'] as const).map((kind, index) => ({
        id: `${item.id}-${kind}`,
        kind,
        summary: 'Reported task state. '.repeat(1_000),
        confidence: 0.8,
        workdayId: 'day',
        observedAt: 100 + index,
        dismissedAt: null,
      }))
      item.agentSessions = [1, 2].map((index) => ({
        id: `${item.id}-session-${index}`,
        provider: 'codex',
        status: 'running',
        instruction: 'A supported active task instruction. '.repeat(1_000),
        message: '',
        response: '',
        startedAt: 90,
        updatedAt: 99,
        completedAt: null,
        durationMs: null,
        steps: [],
      }))
      item.facts = [
        {
          id: `${item.id}-edited`,
          actor: 'user',
          type: 'edited',
          summary: 'A human-written constraint. '.repeat(1_000),
          at: 90,
          agentSessionId: null,
        },
      ]
    }

    const projected = workItemsForPrompt([...terminal, ...open])
    const projectedIds = new Set(projected.map((item) => item.id))

    assert.equal(
      open.every((item) => projectedIds.has(item.id)),
      true
    )
    const enriched = projected.find((item) => item.lifecycle === 'open' && item.observations)
    assert.ok(enriched, 'remaining space should retain relevant state without dropping identities')
    assert.equal(enriched.status, 'in_progress')
    assert.equal(enriched.attention, 'agent_running')
    assert.equal(enriched.observations?.[0]?.kind, 'completion_candidate')
    assert.equal(enriched.observations?.[0]?.confidence, 0.8)
    assert.ok((enriched.observations?.[0]?.summary.length ?? 0) <= 320)
    assert.ok(projected.some((item) => item.lifecycle === 'open' && !item.context && !item.observations))
    assert.ok(JSON.stringify(projected).length <= WORK_ITEM_PROMPT_CHARACTER_BUDGET)
  })

  it('carries possible completion, active delegated scope and later human edits without changing lifecycle', () => {
    const item = workItem('handoff', 'open', 30)
    item.observations = [
      {
        id: 'completion',
        kind: 'completion_candidate',
        summary: 'The agent reported the requested handoff draft was opened.',
        confidence: 0.7,
        workdayId: 'day',
        observedAt: 10,
        dismissedAt: null,
      },
      {
        id: 'old-progress',
        kind: 'progress',
        summary: 'An earlier draft was discussed.',
        confidence: 0.9,
        workdayId: 'day',
        observedAt: 5,
        dismissedAt: null,
      },
      {
        id: 'progress',
        kind: 'progress',
        summary: 'The draft received a requested revision.',
        confidence: 1,
        workdayId: 'day',
        observedAt: 25,
        dismissedAt: null,
      },
      {
        id: 'dismissed',
        kind: 'blocked',
        summary: 'An obsolete blocker.',
        confidence: 1,
        workdayId: 'day',
        observedAt: 26,
        dismissedAt: 27,
      },
    ]
    const running: WorkItem['agentSessions'][number] = {
      id: 'running',
      provider: 'codex',
      status: 'running',
      instruction: 'Apply the requested revision to the handoff draft.',
      message: '',
      response: '',
      startedAt: 21,
      updatedAt: 28,
      completedAt: null,
      durationMs: null,
      steps: [],
    }
    item.agentSessions = [running, { ...running, id: 'finished', status: 'completed', completedAt: 29 }]
    item.facts = [
      { id: 'created', actor: 'user', type: 'created', summary: 'Created handoff task.', at: 1, agentSessionId: null },
      {
        id: 'reopened',
        actor: 'user',
        type: 'reopened',
        summary: 'Requested another revision.',
        at: 20,
        agentSessionId: null,
      },
    ]

    const [projected] = workItemsForPrompt([item])

    assert.equal(projected?.lifecycle, 'open')
    assert.deepEqual(projected?.observations, [
      { kind: 'progress', summary: 'The draft received a requested revision.', confidence: 1, observedAt: 25 },
      {
        kind: 'completion_candidate',
        summary: 'The agent reported the requested handoff draft was opened.',
        confidence: 0.7,
        observedAt: 10,
      },
    ])
    assert.deepEqual(projected?.agentSessions, [{ status: 'running', instruction: running.instruction, updatedAt: 28 }])
    assert.deepEqual(projected?.userFacts, [{ type: 'reopened', summary: 'Requested another revision.', at: 20 }])
    assert.equal(item.observations.length, 4)
    assert.equal(item.agentSessions.length, 2)
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
