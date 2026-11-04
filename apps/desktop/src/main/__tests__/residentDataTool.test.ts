import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WorkItem } from '@remember/shared'
import { createResidentDataTool, noteHistoryChanged } from '../residentDataTool'

type Dependencies = Parameters<typeof createResidentDataTool>[0]
const now = new Date(2026, 9, 24, 12).getTime()
const settings = {
  excludePasswordManagers: true,
  excludePrivateBrowsing: true,
  appCaptureMode: 'exclude' as const,
  excludedAppBundleIds: ['private.app'],
  includedAppBundleIds: [],
  websiteCaptureMode: 'exclude' as const,
  excludedWebsites: [],
  includedWebsites: [],
}
const context = { threadId: 'thread', turnId: 'turn', callId: 'call', signal: new AbortController().signal }
function setup(taskOverrides: Partial<WorkItem> = {}) {
  const entries = Array.from({ length: 12 }, (_, i) => ({
    evidenceId: `screen-${i}`,
    timestamp: now + i,
    kind: 'screen-context' as const,
    app: 'Editor',
    text: `Activity ${i}`,
    window: 'Project',
  }))
  entries.push({ ...entries[0]!, evidenceId: 'secret', window: 'Password login', text: 'secret' })
  const days = [
    { id: 'today', localDay: '2026-10-24', contextMoments: [entries[0]] },
    { id: 'old', localDay: '2026-10-23', contextMoments: [] },
  ]
  let allowed = true
  let headers = 0
  let archives = 0
  const tool = createResidentDataTool({
    store: {
      readSessionHeaders: () => {
        headers++
        return days
      },
      readTaskContextEvidence: (workdayId: string, observedAt: number) =>
        (days.find((day) => day.id === workdayId)?.contextMoments ?? [])
          .filter((entry) => entry.timestamp === observedAt)
          .map((entry) => ({ ...entry, kind: 'context', appName: entry.app, windowTitle: entry.window })),
      readAnalysisEvidence: () => {
        archives++
        return entries
      },
      listWorkItems: () => [
        {
          id: 'task',
          title: 'Manual task',
          description: '',
          sources: [{ kind: 'manual', observedAt: now }],
          facts: [],
          observations: [],
          lifecycle: 'open',
          status: 'todo',
          ...taskOverrides,
        },
      ],
      ambientTasks: { hasTaskSources: () => false },
    } as unknown as Dependencies['store'],
    settings: () => settings,
    notes: () => ({
      state: 'available',
      epoch: 'epoch',
      sequence: 1,
      tombstones: {},
      notes: [
        {
          note: {
            id: 'note',
            text: 'Recorded idea',
            createdAt: now,
            durationMs: 2,
            status: 'completed',
            hasAudio: false,
            error: null,
          },
          revision: 1,
          incarnation: 'inc',
          contentHash: 'hash',
          completedAt: now,
        },
      ],
    }),
    now: () => now,
    assertCurrent: () => {
      if (!allowed) throw new Error('revoked')
    },
  })
  return {
    tool,
    reads: () => ({ headers, archives }),
    revoke: () => {
      allowed = false
    },
  }
}

test('Task and Note reads do not hydrate unrelated day metadata or evidence archives', async () => {
  const f = setup()
  await f.tool.call({ action: 'tasks' }, context)
  await f.tool.call({ action: 'notes' }, context)
  assert.deepEqual(f.reads(), { headers: 0, archives: 0 })
  await f.tool.call({ action: 'days' }, context)
  assert.deepEqual(f.reads(), { headers: 1, archives: 0 })
})

test('today reads real source-shaped rows across pages and excludes authentication surfaces', async () => {
  const { tool } = setup()
  const first = (await tool.call({ action: 'activity_details' }, context)) as {
    total: number
    nextOffset: number
    entries: unknown[]
    date: string
  }
  assert.equal(first.date, '2026-10-24')
  assert.equal(first.total, 12)
  assert.equal(first.nextOffset, 10)
  assert.equal(first.entries.length, 10)
  assert.ok(!JSON.stringify(first).includes('secret'))
  const last = (await tool.call({ action: 'activity_details', offset: first.nextOffset }, context)) as {
    nextOffset: null
    entries: unknown[]
  }
  assert.equal(last.nextOffset, null)
  assert.equal(last.entries.length, 2)
})

test('missing day never falls back to previous activity', async () => {
  const { tool } = setup()
  const result = (await tool.call({ action: 'activity', date: '2026-10-25' }, context)) as { total: number }
  assert.equal(result.total, 0)
})

test('notes and user-created tasks are available without live capture or proactive mode', async () => {
  const { tool } = setup()
  assert.match(JSON.stringify(await tool.call({ action: 'notes' }, context)), /Recorded idea/)
  assert.match(JSON.stringify(await tool.call({ action: 'tasks' }, context)), /Manual task/)
})

test('invalid dates, unsupported mutations, extra fields, revocation and cancellation refuse access', async () => {
  const { tool, revoke } = setup()
  for (const input of [
    { action: 'activity', date: '2026-02-30' },
    { action: 'delete' },
    { action: 'tasks', body: 'hidden' },
    { action: 'activity', offset: -1 },
  ]) {
    await assert.rejects(tool.call(input, context))
  }
  await assert.rejects(
    tool.call({ action: 'activity' }, { ...context, signal: AbortSignal.abort() }),
    /agent-cancelled/
  )
  revoke()
  await assert.rejects(tool.call({ action: 'activity_details' }, context), /revoked/)
})

test('day overview groups repeated snapshots while retaining count and source references', async () => {
  const { tool } = setup()
  const result = (await tool.call({ action: 'activity' }, context)) as {
    total: number
    entries: { observations: number; excerpts: { sourceId: string }[] }[]
  }
  assert.equal(result.total, 1)
  assert.equal(result.entries[0]?.observations, 12)
  assert.deepEqual(
    result.entries[0]?.excerpts.map((entry) => entry.sourceId),
    ['screen-0', 'screen-11']
  )
})

test('Note provider stop/start preserves chat; actual edit/deletion/unreadable invalidates', () => {
  const ready = { state: 'available' as const, epoch: 'epoch', sequence: 1, notes: [], tombstones: {} }
  const stopped = { state: 'unavailable' as const, reason: 'not-ready' as const }
  assert.equal(noteHistoryChanged(ready, stopped), false)
  assert.equal(noteHistoryChanged(stopped, ready), false)
  assert.equal(noteHistoryChanged(ready, { ...ready }), false)
  assert.equal(noteHistoryChanged(ready, { ...ready, sequence: 2 }), true)
  assert.equal(noteHistoryChanged(ready, { state: 'missing' }), true)
  assert.equal(noteHistoryChanged(ready, { state: 'unavailable', reason: 'unreadable' }), true)
})

test('conversation retrieval excludes screen fiction and labels transcripts without claiming speaker identity', async () => {
  const entries = [
    {
      kind: 'screen-context',
      evidenceId: 'demo',
      timestamp: now,
      app: 'Remember',
      text: `${'x'.repeat(1800)}\nDemo\nSam and Sofia`,
      window: 'Remember',
    },
    {
      kind: 'screen-context',
      evidenceId: 'ordinary',
      timestamp: now + 1,
      app: 'Remember',
      text: 'Meeting on screen',
      window: 'Remember',
    },
    {
      kind: 'screen-context',
      evidenceId: 'other-app',
      timestamp: now + 2,
      app: 'Editor',
      text: 'Demo',
      window: 'Editor',
    },
    {
      kind: 'transcript',
      evidenceId: 'speech',
      timestamp: now + 3,
      app: '',
      text: 'Actual stored speech',
      source: 'system',
    },
  ]
  const tool = createResidentDataTool({
    store: {
      readSessionHeaders: () => [{ id: 'today', localDay: '2026-10-24' }],
      readAnalysisEvidence: () => entries,
    } as unknown as Dependencies['store'],
    settings: () => settings,
    notes: () => ({ state: 'missing' }),
    assertCurrent: () => {},
    now: () => now,
  })
  const conversations = (await tool.call({ action: 'conversations' }, context)) as {
    entries: { sourceId: string; evidenceRole: string }[]
  }
  assert.deepEqual(
    conversations.entries.map((row) => [row.sourceId, row.evidenceRole]),
    [['speech', 'recorded-speech-unverified-speaker']]
  )
  const grouped = (await tool.call({ action: 'activity' }, context)) as { entries: { evidenceRole: string }[] }
  assert.equal(grouped.entries.length, 4)
  assert.deepEqual(
    grouped.entries.map((row) => row.evidenceRole),
    [
      'demo-screen-not-user-history',
      'screen-content-not-conversation-record',
      'screen-content-not-conversation-record',
      'recorded-speech-unverified-speaker',
    ]
  )
  const detailed = (await tool.call({ action: 'activity_details' }, context)) as {
    entries: { evidenceRole: string; text: string }[]
  }
  assert.equal(detailed.entries[0]?.evidenceRole, 'demo-screen-not-user-history')
  assert.ok(!detailed.entries[0]?.text.includes('Demo'))
  entries.splice(3, 1)
  const empty = (await tool.call({ action: 'conversations' }, context)) as { total: number }
  assert.equal(empty.total, 0)
})

test('topic retrieval filters permitted records before pagination and activity grouping', async () => {
  const { tool } = setup()
  for (const action of ['activity_details', 'activity', 'overview']) {
    const result = (await tool.call({ action, query: 'ACTIVITY 1' }, context)) as {
      total: number
      nextOffset: number | null
      entries: Array<{ observations?: number }>
    }
    assert.equal(result.nextOffset, null)
    if (action === 'activity_details') assert.equal(result.total, 3)
    else {
      assert.equal(result.total, 1)
      assert.equal(result.entries[0].observations, 3)
    }
    const hidden = (await tool.call({ action, query: 'secret' }, context)) as { total: number; entries: unknown[] }
    assert.equal(hidden.total, 0)
    assert.deepEqual(hidden.entries, [])
  }
  const tasks = (await tool.call({ action: 'tasks', query: 'manual' }, context)) as { total: number }
  assert.equal(tasks.total, 1)
  const missing = (await tool.call({ action: 'tasks', query: 'unrelated project' }, context)) as { total: number }
  assert.equal(missing.total, 0)
  for (const input of [
    { action: 'days', query: 'private' },
    { action: 'tasks', query: '' },
    { action: 'tasks', query: {} },
    { action: 'tasks', query: 'x'.repeat(201) },
  ]) {
    await assert.rejects(tool.call(input, context), /invalid-remember-data-query/)
  }
})

test('task retrieval retains automatic ownership and unresolved completion instead of asserting a commitment', async () => {
  const { tool } = setup({
    sources: [{ id: 'observed', kind: 'observed', workdayId: 'today', observedAt: now }] as WorkItem['sources'],
    observations: [
      { id: 'completion', kind: 'completion_candidate', observedAt: now, dismissedAt: null },
    ] as WorkItem['observations'],
  })
  const result = (await tool.call({ action: 'tasks' }, context)) as { entries: Record<string, unknown>[] }
  assert.equal(result.entries.length, 1)
  assert.equal(result.entries[0]?.userOwned, false)
  assert.equal(result.entries[0]?.claimKind, 'derived-task-unconfirmed-ownership')
  assert.equal(result.entries[0]?.uncertainty, 'completion-observed-but-lifecycle-open')
  assert.deepEqual(result.entries[0]?.observations, [{ kind: 'completion_candidate', observedAt: now }])
  const manual = (await setup().tool.call({ action: 'tasks' }, context)) as { entries: Record<string, unknown>[] }
  assert.equal(manual.entries[0]?.userOwned, true)
  assert.equal(manual.entries[0]?.uncertainty, null)
})
