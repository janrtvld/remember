import assert from 'node:assert/strict'
import { test } from 'node:test'
import { residentAgentContext } from '../residentAgentContext'
import { selectAgentTasks } from '../residentAgentPrivacy'
import { DEFAULT_SETTINGS } from '../settingsStore'

test('chat includes bounded fresh evidence and current task identities while respecting newly excluded apps', () => {
  const now = 3_000_000
  const context = residentAgentContext({
    capture: {
      activeSessionId: 'day',
      status: 'recording',
      pausedSources: [],
      contextCaptureHealth: 'healthy',
      contextCaptureLastEventAt: now - 100,
      microphoneLastChunkAt: now - 100,
    },
    days: [
      {
        id: 'day',
        startedAt: 0,
        memory: null,
        appActivity: [],
        contextMoments: [
          {
            id: 'private',
            timestamp: now,
            appName: 'Private',
            bundleId: 'com.private',
            windowTitle: 'Document',
            text: 'excluded content',
            textSource: 'accessibility',
            trigger: 'change',
            monitorName: 'main',
            screenshotPath: '/private/image.png',
          },
        ],
      },
    ],
    tasks: Array.from({ length: 60 }, (_, index) => ({
      id: `task-${index}`,
      title: '\\'.repeat(1000),
      description: '\\'.repeat(5000),
      lifecycle: 'open' as const,
      status: 'todo' as const,
      dueAt: null,
      priority: 'none' as const,
      updatedAt: index,
      returnPoint: { lastMove: '', unresolved: '', nextMove: '\\'.repeat(3000) },
      sources: [
        {
          id: `source-${index}`,
          kind: 'manual',
          label: 'Manual',
          detail: '',
          workdayId: null,
          conversationStartTime: null,
          observedAt: index,
          confidence: null,
        },
      ],
    })),
    evidence: [
      { kind: 'transcript', timestamp: now - 31 * 60_000, text: 'stale transcript' },
      { kind: 'screen-context', evidenceId: 'private', timestamp: now - 100, app: 'Private', text: 'excluded content' },
      { kind: 'transcript', timestamp: now, text: 'a fresh conversation', source: 'microphone' },
    ],
    settings: { ...DEFAULT_SETTINGS, excludedAppBundleIds: ['com.private'] },
    now,
  })
  assert.ok(context.length <= 38_000)
  assert.ok(!context.includes('stale transcript'))
  assert.ok(!context.includes('excluded content'))
  assert.ok(!context.includes('/private/image.png'))
  const parsed = JSON.parse(context)
  assert.equal(parsed.evidenceOmittedByPrivacy, 1)
  assert.equal(parsed.limits.taskCount, 60)
  assert.equal(parsed.limits.includedTaskCount, parsed.tasks.length)
  assert.ok(parsed.tasks.length > 0)
  assert.equal(parsed.tasks[0].id, 'task-59')
  assert.equal(parsed.capture.microphoneLastChunkAt, now - 100)
})

test('live speech task identity reaches chat context, while deleted or revised and mixed excluded provenance is omitted', () => {
  const source = {
    id: 'speech-source',
    kind: 'observed' as const,
    label: 'Voice',
    detail: '',
    workdayId: 'day',
    conversationStartTime: null,
    observedAt: 100,
    confidence: 1,
  }
  const task = {
    id: 'live-task',
    title: 'Send the plan',
    description: 'Owner confirmed',
    lifecycle: 'open' as const,
    status: 'todo' as const,
    dueAt: null,
    priority: 'none' as const,
    updatedAt: 100,
    returnPoint: { lastMove: '', unresolved: '', nextMove: '' },
    sources: [source],
  }
  let deleted = false
  const provenance = {
    hasTaskSources: () => true,
    taskSourceIds: () => ['speech-source'],
    taskEvidence: () =>
      deleted ? [] : [{ kind: 'speech' as const, text: 'Jan will send the plan', evidenceId: 'audio-1' }],
  }
  const input = {
    capture: {
      activeSessionId: 'day',
      status: 'recording' as const,
      pausedSources: [],
      contextCaptureHealth: 'healthy' as const,
      contextCaptureLastEventAt: 100,
      microphoneLastChunkAt: 100,
    },
    days: [{ id: 'day', startedAt: 0, memory: null, appActivity: [], contextMoments: [] }],
    tasks: [task],
    evidence: [],
    settings: DEFAULT_SETTINGS,
    provenance,
    now: 200,
  }
  assert.equal(JSON.parse(residentAgentContext(input)).tasks[0]?.id, 'live-task')
  deleted = true
  assert.deepEqual(JSON.parse(residentAgentContext(input)).tasks, [])
  deleted = false
  const mixed = { ...task, sources: [source, { ...source, id: 'legacy-source', observedAt: 101 }] }
  assert.deepEqual(selectAgentTasks([mixed], input), [])
})

test('derived task context without permitted provenance is omitted instead of reintroducing excluded screen text', () => {
  const contextMoment = (id: string, timestamp: number, bundleId: string) => ({
    id,
    timestamp,
    appName: 'Document',
    bundleId,
    windowTitle: 'Notes',
    text: id,
    textSource: 'accessibility' as const,
    trigger: 'change',
    monitorName: 'main',
    screenshotPath: '',
  })
  const source = {
    id: 'source',
    kind: 'observed' as const,
    label: 'Document',
    detail: '',
    workdayId: 'day',
    conversationStartTime: null,
    observedAt: 100,
    confidence: 1,
  }
  const task = {
    id: 'allowed',
    title: 'Allowed task',
    description: 'Allowed description',
    lifecycle: 'open' as const,
    status: 'todo' as const,
    dueAt: null,
    priority: 'none' as const,
    updatedAt: 200,
    returnPoint: { lastMove: '', unresolved: '', nextMove: '' },
    sources: [source],
  }
  const result = JSON.parse(
    residentAgentContext({
      capture: {
        activeSessionId: 'day',
        status: 'recording',
        pausedSources: [],
        contextCaptureHealth: 'healthy',
        contextCaptureLastEventAt: 200,
        microphoneLastChunkAt: 200,
      },
      days: [
        {
          id: 'day',
          startedAt: 0,
          memory: null,
          appActivity: [],
          contextMoments: [
            contextMoment('allowed-source', 100, 'com.notes'),
            contextMoment('excluded-source', 101, 'com.private'),
          ],
        },
      ],
      tasks: [
        task,
        { ...task, id: 'excluded-task', title: 'Excluded-derived title', sources: [{ ...source, observedAt: 101 }] },
        { ...task, id: 'unknown-task', sources: [{ ...source, observedAt: 102 }] },
        { ...task, id: 'meeting-task', sources: [{ ...source, kind: 'meeting' }] },
      ],
      evidence: [],
      settings: { ...DEFAULT_SETTINGS, excludedAppBundleIds: ['com.private'] },
      now: 300,
    })
  )
  assert.deepEqual(
    result.tasks.map((item: { id: string }) => item.id),
    ['allowed']
  )
  assert.equal(result.limits.tasksOmittedWithoutPermittedProvenance, 3)
  assert.ok(!JSON.stringify(result).includes('Excluded-derived title'))
  assert.equal(result.day.recentConversations, undefined)
})

test('short replies receive only current source-valid offers with exact task identity', () => {
  const task = {
    id: 'offer-task',
    title: 'Prepare plan',
    description: 'Current task',
    lifecycle: 'open' as const,
    status: 'todo' as const,
    dueAt: null,
    priority: 'none' as const,
    updatedAt: 100,
    returnPoint: { lastMove: '', unresolved: '', nextMove: '' },
    sources: [
      {
        id: 's',
        kind: 'observed' as const,
        label: 'Voice',
        detail: '',
        workdayId: 'day',
        conversationStartTime: null,
        observedAt: 100,
        confidence: 1,
      },
    ],
  }
  let deleted = false
  let excluded = false
  const input: Parameters<typeof residentAgentContext>[0] = {
    capture: {
      activeSessionId: 'day',
      status: 'recording',
      pausedSources: [],
      contextCaptureHealth: 'healthy',
      contextCaptureLastEventAt: 100,
      microphoneLastChunkAt: 100,
    },
    days: [],
    tasks: [task],
    evidence: [],
    settings: { ...DEFAULT_SETTINGS, excludedAppBundleIds: ['com.private'] },
    provenance: {
      hasTaskSources: () => true,
      taskSourceIds: () => ['s'],
      taskEvidence: () => (deleted ? [] : [{ kind: 'speech', text: 'Jan prepares the plan' }]),
    },
    suggestions: [
      {
        eventId: 'ambient-task:offer-task',
        taskId: 'offer-task',
        evidenceIds: ['speech:1'],
        text: 'Shall I prepare the plan?',
        provider: 'codex',
        createdAt: 101,
      },
    ],
    resolveSuggestionEvidence: () =>
      deleted
        ? null
        : excluded
          ? { kind: 'context', text: 'private', bundleId: 'com.private' }
          : { kind: 'speech', text: 'Jan prepares the plan' },
  }
  const read = () => JSON.parse(residentAgentContext(input)).recentTaskSuggestions
  assert.equal(read()[0]?.taskId, 'offer-task')
  assert.equal(read()[0]?.text, 'Shall I prepare the plan?')
  deleted = true
  assert.deepEqual(read(), [])
  deleted = false
  excluded = true
  assert.deepEqual(read(), [])
  excluded = false
  input.tasks = []
  assert.deepEqual(read(), [])
})
