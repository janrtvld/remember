import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  type ConversationSummary,
  conversationActionPointItems,
  type WorkItem,
  type WorkItemAgentSessionStatus,
  workItemForConversationActionPoint,
} from '@remember/shared'
import {
  applyPendingInboxLifecycles,
  buildInboxAgentPrompt,
  capitalizeAgentMentions,
  composerAgent,
  composerAgentMention,
  composerInstruction,
  formatInboxRelativeTime,
  inboxAgentTurns,
  inboxReturnPoint,
  inboxSelectionAfterRemoval,
  inboxSourceHref,
  inboxTaskHref,
  inboxTasks,
  isInboxTaskUnread,
  reconcileInboxTaskDraft,
  replaceComposerAgentMention,
  sameInboxTaskDraft,
  selectedInboxTask,
} from './inboxTasks'

describe('accepted worker instructions', () => {
  it('includes the accepted offer in the worker instruction', () => {
    const task = { ...item('pdf', 1, 'Make a PDF'), aiSuggestion: 'Want me to make a PDF with the answers?' }
    assert.match(
      buildInboxAgentPrompt(task, 'Include the sources'),
      /Geaccepteerd AI-voorstel:\nWant me to make a PDF with the answers\?/
    )
    assert.match(buildInboxAgentPrompt(task, 'Include the sources'), /Include the sources/)
  })
})

describe('selection after completing inbox tasks', () => {
  const items = ['first', 'second', 'third', 'fourth'].map((id, index) => ({
    taskKey: id,
    workItem: item(id, 4 - index, id),
  }))

  it('advances from the third task to the fourth', () => {
    assert.equal(inboxSelectionAfterRemoval(items, items[2], new Set(['third'])), items[3])
  })

  it('falls back to the previous task at the end', () => {
    assert.equal(inboxSelectionAfterRemoval(items, items[3], new Set(['fourth'])), items[2])
  })

  it('preserves selection when another task is completed', () => {
    assert.equal(inboxSelectionAfterRemoval(items, items[2], new Set(['first'])), items[2])
  })

  it('skips every task in a bulk completion', () => {
    assert.equal(inboxSelectionAfterRemoval(items, items[2], new Set(['third', 'fourth'])), items[1])
  })

  it('clears selection when no tasks remain', () => {
    assert.equal(inboxSelectionAfterRemoval(items, items[2], new Set(items.map((item) => item.taskKey))), null)
  })
})

function item(id: string, updatedAt: number, title: string, lifecycle: WorkItem['lifecycle'] = 'open'): WorkItem {
  return {
    id,
    title,
    description: 'Task context',
    prompt: 'Prepared task instruction',
    context: 'Persisted work context',
    returnPoint: {
      lastMove: 'The implementation was reviewed.',
      unresolved: 'The narrow state still needs proof.',
      nextMove: 'Open the renderer at 520 px.',
    },
    lifecycle,
    status: 'todo',
    priority: 'none',
    dueAt: null,
    attention: 'idle',
    createdAt: updatedAt - 10,
    updatedAt,
    closedAt: lifecycle === 'open' ? null : updatedAt,
    userEditedTitle: false,
    userEditedDescription: false,
    sources: [
      {
        id: `${id}:source`,
        kind: 'observed',
        label: 'Remember',
        detail: 'Observed work',
        workdayId: null,
        conversationStartTime: null,
        observedAt: updatedAt - 10,
        confidence: 0.9,
      },
    ],
    facts: [
      {
        id: `${id}:created`,
        type: 'created',
        actor: 'system',
        summary: 'Remember herkende dit als open werk.',
        at: updatedAt - 10,
        agentSessionId: null,
      },
    ],
    observations: [],
    agentSessions: [],
  }
}

describe('Inbox tasks', () => {
  it('shows a pending completion immediately and rolls back against the latest saved content', () => {
    const original = item('pending', 10, 'Original task')
    const other = item('other', 20, 'Other task')
    const pending = new Map([['pending', 'completed' as const]])
    const visible = applyPendingInboxLifecycles([original, other], pending)
    assert.deepEqual(
      inboxTasks(visible).map((entry) => entry.taskKey),
      ['other']
    )
    assert.equal(visible[1], other)
    assert.equal(original.lifecycle, 'open')

    // A background refresh must retain the pending checkbox state without losing a newer edit.
    const refreshed = { ...original, title: 'Edited elsewhere', updatedAt: 30 }
    const refreshedItems = [refreshed, other]
    const stillPending = applyPendingInboxLifecycles(refreshedItems, pending)
    assert.equal(stillPending[0]?.lifecycle, 'completed')
    assert.equal(stillPending[0]?.title, 'Edited elsewhere')
    const rolledBack = applyPendingInboxLifecycles(refreshedItems, new Map())
    assert.equal(rolledBack, refreshedItems)
    assert.equal(rolledBack[0]?.lifecycle, 'open')
    assert.equal(rolledBack[0]?.title, 'Edited elsewhere')
  })

  it('reads durable open work items and keeps the newest first', () => {
    assert.deepEqual(
      inboxTasks([item('older', 10, 'Older task'), item('newer', 20, 'Newer task')]).map(
        (entry) => entry.workItem.title
      ),
      ['Newer task', 'Older task']
    )
  })

  it('keeps chronology primary instead of promoting agent state', () => {
    const olderWaiting = item('waiting', 10, 'Waiting task')
    olderWaiting.attention = 'waiting_on_user'
    const newerIdle = item('newer', 20, 'Newer task')
    assert.deepEqual(
      inboxTasks([olderWaiting, newerIdle]).map((entry) => entry.taskKey),
      ['newer', 'waiting']
    )
  })

  it('does not title-dedupe distinct items and excludes closed lifecycle states', () => {
    const openOne = item('one', 10, 'Review the release')
    const openTwo = item('two', 20, 'Review the release')
    assert.deepEqual(
      inboxTasks([openOne, openTwo]).map((entry) => entry.taskKey),
      ['two', 'one']
    )
    assert.deepEqual(
      inboxTasks([openOne, item('closed', 30, 'Done', 'completed')]).map((entry) => entry.taskKey),
      ['one']
    )
  })

  it('optionally shows every closed lifecycle after open work', () => {
    assert.deepEqual(
      inboxTasks(
        [
          item('abandoned', 50, 'Not needed', 'abandoned'),
          item('superseded', 40, 'Replaced task', 'superseded'),
          item('done', 30, 'Completed task', 'completed'),
          item('open', 10, 'Open task'),
        ],
        true
      ).map((entry) => entry.taskKey),
      ['open', 'done', 'abandoned', 'superseded']
    )
  })

  it('uses stable work-item identity in detail links', () => {
    const [entry] = inboxTasks([item('work-item-1', 20, 'Review inbox')])
    assert.ok(entry)
    assert.equal(inboxTaskHref(entry), '/inbox/?item=work-item-1')
    assert.equal(selectedInboxTask([entry], entry.taskKey), entry)
  })

  it('keeps unseen AI work unread until its current version has been viewed', () => {
    const workItem = item('observed', 20, 'Review inbox')
    const [entry] = inboxTasks([workItem])
    assert.ok(entry)
    assert.equal(isInboxTaskUnread(entry), true)
    assert.equal(isInboxTaskUnread(entry, workItem.updatedAt), false)
    assert.equal(isInboxTaskUnread(entry, workItem.updatedAt - 1), true)

    workItem.sources[0] = { ...workItem.sources[0], kind: 'manual' }
    assert.equal(isInboxTaskUnread(entry), false)
    assert.equal(isInboxTaskUnread(entry, workItem.updatedAt, true), true)
  })

  it('preserves continuity and links a meeting back to its conversation', () => {
    const workItem = item('meeting', 20, 'Review inbox')
    workItem.sources[0] = {
      ...workItem.sources[0],
      kind: 'meeting',
      workdayId: 'day-1',
      conversationReference: 'episode:renderer-review',
      conversationStartTime: '10:02',
    }
    const [entry] = inboxTasks([workItem])
    assert.ok(entry)
    assert.equal(inboxSourceHref(entry), '/day/conversation/?id=day-1&conversation=episode%3Arenderer-review')
    assert.deepEqual(inboxReturnPoint(entry), workItem.returnPoint)
  })

  it('resolves a conversation action point to the exact Inbox work item', () => {
    const conversation: ConversationSummary = {
      episodeId: 'renderer-review',
      startTime: '10:02',
      endTime: '10:16',
      title: 'Renderer review',
      description: 'The renderer follow-up was agreed.',
      actionPoints: ['Verify the narrow layout'],
    }
    const [actionPoint] = conversationActionPointItems(conversation)
    assert.ok(actionPoint)
    const workItem = item('meeting-action', 20, actionPoint.text)
    workItem.sources[0] = {
      ...workItem.sources[0],
      kind: 'meeting',
      workdayId: 'day-1',
      conversationReference: 'episode:renderer-review',
      conversationActionId: actionPoint.id,
      conversationStartTime: conversation.startTime,
    }

    assert.equal(workItemForConversationActionPoint([workItem], conversation, actionPoint)?.id, workItem.id)
    workItem.lifecycle = 'completed'
    assert.equal(workItemForConversationActionPoint([workItem], conversation, actionPoint)?.lifecycle, 'completed')
  })

  it('links screen evidence to the matching moment in the timeline', () => {
    const workItem = item('observed', 2_000, 'Review inbox')
    workItem.sources[0] = { ...workItem.sources[0], workdayId: 'day-1', observedAt: 1_990 }
    const [entry] = inboxTasks([workItem])
    assert.ok(entry)
    assert.equal(inboxSourceHref(entry), '/day/timeline/?id=day-1&timelineAt=1990')
  })

  it('keeps the original source after recognition on later days, regardless of source order', () => {
    const workItem = item('observed', Date.UTC(2026, 8, 7, 8), 'Book road-trip car')
    const original = {
      ...workItem.sources[0],
      workdayId: '2026-09-05',
      observedAt: Date.UTC(2026, 8, 5, 8, 22),
    }
    const update = {
      ...original,
      id: 'later-source',
      workdayId: '2026-09-07',
      observedAt: workItem.updatedAt,
    }
    const entry = { workItem, taskKey: workItem.id }
    for (const sources of [
      [original, update],
      [update, original],
    ]) {
      workItem.sources = sources
      assert.equal(inboxSourceHref(entry), `/day/timeline/?id=2026-09-05&timelineAt=${original.observedAt}`)
      assert.deepEqual(workItem.sources, sources)
    }
  })

  it('does not substitute a later source when the origin has no destination', () => {
    const workItem = item('no-origin-link', 2_000, 'Review inbox')
    workItem.sources.push({ ...workItem.sources[0], id: 'later', workdayId: 'today', observedAt: 2_000 })
    const entry = { workItem, taskKey: workItem.id }
    assert.equal(inboxSourceHref(entry), null)
    workItem.sources = []
    assert.equal(inboxSourceHref(entry), null)
  })

  it('preserves a newer local draft when an earlier save refreshes the item', () => {
    const saved = { title: 'Original title', description: 'Original description' }
    const localDraft = { title: 'Edited title', description: 'Edited description' }
    const firstSaveResponse = { title: 'Edited title', description: 'Original description' }

    assert.equal(sameInboxTaskDraft(localDraft, saved), false)
    assert.equal(reconcileInboxTaskDraft(localDraft, saved, firstSaveResponse), localDraft)
    assert.equal(reconcileInboxTaskDraft(saved, saved, firstSaveResponse), firstSaveResponse)
  })

  it('formats compact Linear-style relative timestamps', () => {
    const now = Date.UTC(2026, 7, 20, 12)
    assert.equal(formatInboxRelativeTime(now - 10_000, now), '1m')
    assert.equal(formatInboxRelativeTime(now - 7 * 60_000, now), '7m')
    assert.equal(formatInboxRelativeTime(now - 3 * 60 * 60_000, now), '3h')
    assert.equal(formatInboxRelativeTime(now - 2 * 24 * 60 * 60_000, now), '2d')
  })

  it('routes an explicit mention and removes it from the instruction', () => {
    const workItem = item('prompt', 20, 'Review release')
    workItem.description = 'Use the signed build.'
    assert.equal(composerAgent('@claude check dit zorgvuldig', 'codex'), 'claude')
    assert.equal(composerInstruction('@claude check dit zorgvuldig'), 'check dit zorgvuldig')
    assert.match(
      buildInboxAgentPrompt(workItem, '@codex verify signatures'),
      /Bericht van de gebruiker:\nverify signatures/
    )
  })

  it('hands the agent the prepared context and return point', () => {
    const [entry] = inboxTasks([item('handoff', 20, 'Review inbox')])
    assert.ok(entry)
    const prompt = buildInboxAgentPrompt(entry.workItem, '@codex finish it')
    assert.match(prompt, /Terugkeerpunt:/)
    assert.match(prompt, /Voorbereide opdracht:\nPrepared task instruction/)
    assert.match(prompt, /Nog open: The narrow state still needs proof\./)
  })

  it('capitalizes and replaces supported agent mentions', () => {
    assert.equal(capitalizeAgentMentions('@codex pak dit op met @CLAUDE'), '@Codex pak dit op met @Claude')
    assert.deepEqual(composerAgentMention('Pak dit op met @cl'), { start: 15, query: 'cl' })
    assert.equal(replaceComposerAgentMention('Pak dit op met @cl', 'claude'), 'Pak dit op met @Claude ')
  })

  it('turns persisted agent sessions into an inline thread', () => {
    const workItem = item('chat', 20, 'Review inbox')
    workItem.agentSessions = [
      {
        id: 'turn-1',
        provider: 'codex',
        status: 'completed',
        instruction: 'Full task context',
        message: 'Maak een testplan.',
        response: '  Hier is het testplan.\n',
        startedAt: 30,
        updatedAt: 31,
        completedAt: 31,
        durationMs: 1_200,
        steps: [{ id: 'reasoning-1', kind: 'reasoning', text: 'Eerst de risicopaden bepalen.', at: 25 }],
      },
    ]
    const [entry] = inboxTasks([workItem])
    assert.ok(entry)
    assert.deepEqual(inboxAgentTurns(entry), [
      {
        id: 'turn-1',
        provider: 'codex',
        at: 30,
        status: 'complete',
        message: 'Maak een testplan.',
        response: 'Hier is het testplan.',
        durationMs: 1_200,
        steps: [{ id: 'reasoning-1', kind: 'reasoning', text: 'Eerst de risicopaden bepalen.', at: 25 }],
      },
    ])
  })

  it('restores unanswered active and interrupted messages in the conversation', () => {
    const workItem = item('unfinished-chat', 20, 'Review inbox')
    const statuses: WorkItemAgentSessionStatus[] = [
      'running',
      'waiting_on_user',
      'cancelled',
      'failed',
      'stale',
      'completed',
    ]
    workItem.agentSessions = statuses.map((status, index) => ({
      id: `turn-${index}`,
      provider: 'codex',
      status,
      instruction: '@codex Review the task.',
      message: '',
      response: '  ',
      startedAt: 30 + index,
      updatedAt: 40,
      completedAt: null,
      durationMs: null,
      steps: [],
    }))

    const turns = inboxAgentTurns({ workItem, taskKey: workItem.id })
    assert.deepEqual(
      turns.map(({ id, status, message, response }) => ({ id, status, message, response })),
      ['working', 'working', 'cancelled', 'error', 'error', 'complete'].map((status, index) => ({
        id: `turn-${index}`,
        status,
        message: 'Review the task.',
        response: '',
      }))
    )
  })

  it('keeps partial responses without marking an unfinished or stopped turn complete', () => {
    const workItem = item('partial-chat', 20, 'Review inbox')
    const statuses: WorkItemAgentSessionStatus[] = ['running', 'cancelled', 'failed']
    workItem.agentSessions = statuses.map((status, index) => ({
      id: `turn-${index}`,
      provider: 'codex',
      status,
      instruction: 'Full task context',
      message: 'Maak een testplan.',
      response: '  Begin bij het inloggen.\n',
      startedAt: 30 + index,
      updatedAt: 40,
      completedAt: null,
      durationMs: null,
      steps: [],
    }))

    assert.deepEqual(
      inboxAgentTurns({ workItem, taskKey: workItem.id }).map(({ status, response }) => ({ status, response })),
      [
        { status: 'working', response: 'Begin bij het inloggen.' },
        { status: 'cancelled', response: 'Begin bij het inloggen.' },
        { status: 'error', response: 'Begin bij het inloggen.' },
      ]
    )
  })
})
