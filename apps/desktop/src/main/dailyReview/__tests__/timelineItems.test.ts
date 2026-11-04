import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CalendarBlock, DailyReviewSession, DayMemory } from '@remember/shared'
import {
  hideTimelineMemoryItem,
  hydrateTimelineItems,
  reconcileTimelineItems,
  showHiddenTimelineMemoryItems,
  timelineEvidenceReferences,
  updateTimelineMemoryItem,
} from '../timelineItems'

const startedAt = new Date(2026, 7, 14, 8).getTime()

function memory(timeline: CalendarBlock[]): DayMemory {
  return {
    summary: '',
    currentFocus: null,
    outcomes: [],
    decisions: [],
    openLoops: [],
    conversations: [],
    timeline,
    knowledgeSuggestions: [],
    refreshedAt: startedAt,
    coveredThrough: startedAt,
  }
}

function session(dayMemory: DayMemory | null = null): DailyReviewSession {
  return {
    id: 'day-1',
    startedAt,
    endedAt: startedAt + 4 * 60 * 60_000,
    activeDurationMs: 4 * 60 * 60_000,
    moments: [
      {
        id: 'audio-1',
        sessionId: 'day-1',
        source: 'system',
        startedAt: startedAt + 35 * 60_000,
        durationMs: 10 * 60_000,
        status: 'ready',
        transcript: 'We should preserve provenance.',
      },
    ],
    appActivity: [
      {
        id: 'app-1',
        appName: 'Codex',
        bundleId: 'com.openai.codex',
        startedAt: startedAt + 20 * 60_000,
        endedAt: startedAt + 90 * 60_000,
      },
    ],
    contextMoments: [
      {
        id: 'context-1',
        timestamp: startedAt + 30 * 60_000,
        appName: 'Codex',
        bundleId: 'com.openai.codex',
        windowTitle: 'Remember',
        text: 'Timeline provenance implementation',
        textSource: 'accessibility',
        trigger: 'content-change',
        monitorName: 'Main',
        screenshotPath: '',
      },
    ],
    memory: dayMemory,
    refresh: {
      status: 'idle',
      reason: null,
      targetThrough: null,
      error: null,
      progress: null,
      run: null,
    },
  }
}

describe('Timeline item provenance', () => {
  it('hydrates legacy blocks with a deterministic id and exact source references', () => {
    const hydrated = hydrateTimelineItems(
      session(memory([{ startTime: '08:20', endTime: '09:30', title: 'Timeline', description: 'Built it.' }]))
    )
    const block = hydrated.memory?.timeline[0]

    assert.match(block?.id ?? '', /^timeline:day-1:[a-f0-9]{16}$/)
    assert.deepEqual(block?.sourceRefs, [
      { kind: 'app', id: 'app-1' },
      { kind: 'context', id: 'context-1' },
      { kind: 'audio', id: 'audio-1' },
    ])
  })

  it('keeps identity and user wording when refreshed boundaries and generated copy change', () => {
    const first = hydrateTimelineItems(
      session(memory([{ startTime: '08:20', endTime: '09:30', title: 'Timeline', description: 'Built it.' }]))
    )
    const block = first.memory?.timeline[0]
    assert.ok(block?.id)
    const corrected = updateTimelineMemoryItem(first.memory as DayMemory, block.id, {
      title: 'Timeline provenance',
      description: 'Connected every block to local evidence.',
    })
    const refreshed = reconcileTimelineItems(
      session(corrected),
      [{ startTime: '08:25', endTime: '09:20', title: 'Generated wording', description: 'Different wording.' }],
      corrected
    )

    assert.equal(refreshed[0]?.id, block.id)
    assert.equal(refreshed[0]?.title, 'Timeline provenance')
    assert.equal(refreshed[0]?.description, 'Connected every block to local evidence.')
  })

  it('preserves earlier non-overlapping blocks when an incremental refresh returns only new activity', () => {
    const previous = hydrateTimelineItems(
      session(memory([{ startTime: '08:20', endTime: '09:30', title: 'Earlier work', description: 'Keep me.' }]))
    )
    const previousMemory = previous.memory as DayMemory
    const refreshed = reconcileTimelineItems(
      session(previousMemory),
      [{ startTime: '10:00', endTime: '10:30', title: 'New work', description: 'Just generated.' }],
      previousMemory
    )

    assert.deepEqual(
      refreshed.map((block) => block.title),
      ['Earlier work', 'New work']
    )
  })

  it('does not retain duplicate old lanes when one generated block replaces their shared interval', () => {
    const previous = hydrateTimelineItems(
      session(
        memory([
          { startTime: '08:20', endTime: '08:50', title: 'First fragment', description: '' },
          { startTime: '08:50', endTime: '09:20', title: 'Second fragment', description: '' },
        ])
      )
    )
    const previousMemory = previous.memory as DayMemory
    const refreshed = reconcileTimelineItems(
      session(previousMemory),
      [{ startTime: '08:20', endTime: '09:20', title: 'Combined work', description: '' }],
      previousMemory
    )

    assert.equal(refreshed.length, 1)
    assert.equal(refreshed[0]?.title, 'Combined work')
  })

  it('does not retain a broad old session around smaller regenerated blocks', () => {
    const previous = hydrateTimelineItems(
      session(
        memory([
          {
            startTime: '14:21',
            endTime: '15:05',
            title: 'Printerondersteuning voor Huib',
            description: '',
          },
        ])
      )
    )
    const previousMemory = previous.memory as DayMemory
    const refreshed = reconcileTimelineItems(
      session(previousMemory),
      [
        { startTime: '14:53', endTime: '15:05', title: 'Printer onderzocht', description: '' },
        { startTime: '15:06', endTime: '15:11', title: 'Printerstoring opgelost', description: '' },
      ],
      previousMemory
    )

    assert.deepEqual(
      refreshed.map(({ startTime, endTime, title }) => ({ startTime, endTime, title })),
      [
        { startTime: '14:53', endTime: '15:05', title: 'Printer onderzocht' },
        { startTime: '15:06', endTime: '15:11', title: 'Printerstoring opgelost' },
      ]
    )
  })

  it('persists a hidden item separately from its evidence-backed block', () => {
    const hydrated = hydrateTimelineItems(
      session(memory([{ startTime: '08:20', endTime: '09:30', title: 'Timeline', description: 'Built it.' }]))
    )
    const block = hydrated.memory?.timeline[0]
    assert.ok(block?.id)

    const hidden = hideTimelineMemoryItem(hydrated.memory as DayMemory, block.id)
    assert.deepEqual(hidden.hiddenTimelineItemIds, [block.id])
    assert.equal(hidden.timeline.length, 1)
    assert.deepEqual(showHiddenTimelineMemoryItems(hidden).hiddenTimelineItemIds, [])
  })

  it('supports overnight blocks and rejects malformed clock values', () => {
    const overnightStart = new Date(2026, 7, 14, 23, 50).getTime()
    const overnight = session()
    overnight.contextMoments = [
      {
        ...overnight.contextMoments[0],
        id: 'after-midnight',
        timestamp: overnightStart + 20 * 60_000,
      },
    ]

    const hydrated = hydrateTimelineItems({
      ...overnight,
      memory: memory([
        { startTime: '23:50', endTime: '00:30', title: 'Overnight work', description: '' },
        { startTime: '29:00', endTime: '30:00', title: 'Invalid work', description: '' },
      ]),
    })

    assert.deepEqual(hydrated.memory?.timeline[0]?.sourceRefs, [{ kind: 'context', id: 'after-midnight' }])
    assert.deepEqual(hydrated.memory?.timeline[1]?.sourceRefs, [])
  })

  it('keeps context, audio, and app provenance represented when a block has many sources', () => {
    const crowded = session()
    crowded.contextMoments = Array.from({ length: 40 }, (_, index) => ({
      ...crowded.contextMoments[0],
      id: `context-${index}`,
      timestamp: startedAt + (20 + index) * 60_000,
    }))
    crowded.moments = Array.from({ length: 20 }, (_, index) => ({
      ...crowded.moments[0],
      id: `audio-${index}`,
      startedAt: startedAt + (20 + index) * 60_000,
    }))
    crowded.appActivity = Array.from({ length: 20 }, (_, index) => ({
      ...crowded.appActivity[0],
      id: `app-${index}`,
      startedAt: startedAt + (20 + index) * 60_000,
      endedAt: startedAt + (21 + index) * 60_000,
    }))
    crowded.memory = memory([{ startTime: '08:20', endTime: '09:30', title: 'Crowded', description: '' }])

    const references = hydrateTimelineItems(crowded).memory?.timeline[0]?.sourceRefs ?? []
    assert.equal(references.length, 32)
    assert.deepEqual(
      references.reduce<Record<string, number>>((counts, reference) => {
        counts[reference.kind] = (counts[reference.kind] ?? 0) + 1
        return counts
      }, {}),
      { context: 16, audio: 8, app: 8 }
    )
    assert.equal(timelineEvidenceReferences(crowded, crowded.memory.timeline[0] as CalendarBlock).length, 80)
  })

  it('preserves first duplicate identity, cross-kind timestamps and stable ties without retaining an index', () => {
    const data = session(memory([{ startTime: '08:20', endTime: '09:30', title: 'Mixed sources', description: '' }]))
    data.contextMoments = [
      { ...data.contextMoments[0], id: 'shared', timestamp: startedAt + 30 * 60_000 },
      { ...data.contextMoments[0], id: 'middle', timestamp: startedAt + 40 * 60_000 },
      { ...data.contextMoments[0], id: 'shared', timestamp: startedAt + 50 * 60_000 },
    ]
    data.moments = [
      { ...data.moments[0], id: 'shared', startedAt: startedAt + 35 * 60_000 },
      { ...data.moments[0], id: 'tie', startedAt: startedAt + 30 * 60_000 },
    ]
    data.appActivity = [{ ...data.appActivity[0], id: 'shared', startedAt: startedAt + 25 * 60_000 }]
    const block = data.memory?.timeline[0]
    assert.ok(block)
    const expected = [
      { kind: 'app', id: 'shared' },
      { kind: 'context', id: 'shared' },
      { kind: 'context', id: 'shared' },
      { kind: 'audio', id: 'tie' },
      { kind: 'audio', id: 'shared' },
      { kind: 'context', id: 'middle' },
    ]
    assert.deepEqual(timelineEvidenceReferences(data, block), expected)
    assert.deepEqual(hydrateTimelineItems(data).memory?.timeline[0]?.sourceRefs, expected)
    const firstContext = data.contextMoments[0]
    assert.ok(firstContext)
    firstContext.timestamp = startedAt + 60 * 60_000
    assert.deepEqual(timelineEvidenceReferences(data, block), [
      expected[0],
      expected[3],
      expected[4],
      expected[5],
      expected[1],
      expected[2],
    ])
  })

  it('assigns distinct identities to overlapping blocks with the same source anchor', () => {
    const hydrated = hydrateTimelineItems(
      session(
        memory([
          { startTime: '08:20', endTime: '09:30', title: 'First lane', description: '' },
          { startTime: '08:20', endTime: '09:30', title: 'Second lane', description: '' },
        ])
      )
    )

    assert.notEqual(hydrated.memory?.timeline[0]?.id, hydrated.memory?.timeline[1]?.id)
  })

  it('rejects oversized user overrides outside the renderer limits', () => {
    const hydrated = hydrateTimelineItems(
      session(memory([{ startTime: '08:20', endTime: '09:30', title: 'Timeline', description: '' }]))
    )
    const block = hydrated.memory?.timeline[0]
    assert.ok(block?.id)

    assert.throws(
      () =>
        updateTimelineMemoryItem(hydrated.memory as DayMemory, block.id as string, {
          title: 'x'.repeat(121),
          description: '',
        }),
      /invalid-timeline-item/
    )
  })
})
