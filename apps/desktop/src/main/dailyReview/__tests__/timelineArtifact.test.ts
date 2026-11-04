import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { DailyReviewSession } from '@remember/shared'
import { writeTimelineArtifacts } from '../timelineArtifact'
import { renderTimelineMarkdown } from '../timelineMarkdown'

describe('Timeline Markdown artifacts', () => {
  it('renders a searchable summary, detailed activity record, applications, and local evidence citation', () => {
    const startedAt = new Date(2026, 7, 25, 9).getTime()
    const session: DailyReviewSession = {
      id: 'day-1',
      startedAt,
      endedAt: null,
      activeDurationMs: 60_000,
      moments: [],
      appActivity: [
        {
          id: 'app-1',
          appName: 'Codex',
          bundleId: 'com.openai.codex',
          startedAt,
          endedAt: startedAt + 30 * 60_000,
        },
      ],
      contextMoments: [],
      memory: {
        summary: 'Remember gained a durable middle layer for observed activity.',
        currentFocus: null,
        outcomes: [],
        decisions: [],
        openLoops: [],
        conversations: [],
        timeline: [
          {
            id: 'timeline-1',
            startTime: '09:00',
            endTime: '09:30',
            title: 'Rebuilt Timeline memory',
            description: 'Preserved useful continuity between raw evidence and the Day summary.',
            details: [{ at: '09:12', text: 'Added private Markdown interval summaries.' }],
          },
        ],
        knowledgeSuggestions: [],
        refreshedAt: startedAt + 30 * 60_000,
        coveredThrough: startedAt + 30 * 60_000,
      },
      refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
    }

    const markdown = renderTimelineMarkdown(
      session,
      session.memory?.timeline ?? [],
      { startedAt, endedAt: startedAt + 30 * 60_000 },
      '/private/evidence.sqlite'
    )

    assert.match(markdown, /applications: \["com\.openai\.codex"\]/)
    assert.match(markdown, /# Activity record/)
    assert.match(markdown, /09:12 Added private Markdown interval summaries\./)
    assert.match(markdown, /\/private\/evidence\.sqlite/)
  })

  it('writes private minute, six-hour, and day memories with retrieval instructions', () => {
    const dataDirectory = join(tmpdir(), `remember-timeline-${randomUUID()}`)
    const startedAt = new Date(2026, 7, 25, 9).getTime()
    const coveredThrough = startedAt + 90 * 60_000
    const session: DailyReviewSession = {
      id: 'day-files',
      startedAt,
      endedAt: null,
      activeDurationMs: 60_000,
      moments: [],
      appActivity: [],
      contextMoments: [],
      memory: {
        summary: 'A broad account of the day.',
        currentFocus: null,
        outcomes: [],
        decisions: [],
        openLoops: [],
        conversations: [],
        timeline: [
          {
            id: 'timeline-files',
            startTime: '09:00',
            endTime: '10:30',
            title: 'Kept the activity record',
            description: 'Preserved the useful state between raw evidence and the broad day account.',
            details: [{ at: '09:45', text: 'Wrote the local interval memory.' }],
          },
        ],
        knowledgeSuggestions: [],
        refreshedAt: coveredThrough,
        coveredThrough,
      },
      refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
    }

    try {
      writeTimelineArtifacts(session, { startedAt, endedAt: coveredThrough }, dataDirectory)
      const root = join(dataDirectory, 'timeline')
      const resources = join(root, 'resources')
      const filenames = [
        `${new Date(startedAt).toISOString().replaceAll(':', '-').replaceAll('.', '-')}-90min-timeline-summary.md`,
        `${new Date(startedAt).toISOString().replaceAll(':', '-').replaceAll('.', '-')}-6h-timeline-summary.md`,
      ]
      const dayFile = join(root, '2026-08-25.md')
      const interval = readFileSync(join(resources, filenames[0]), 'utf8')

      assert.match(readFileSync(join(root, 'instructions.md'), 'utf8'), /untrusted observed evidence/)
      assert.match(readFileSync(dayFile, 'utf8'), /A broad account of the day\./)
      assert.match(interval, /Kept the activity record: Preserved the useful state/)
      assert.match(readFileSync(join(resources, filenames[1]), 'utf8'), /Wrote the local interval memory\./)
      assert.equal(statSync(root).mode & 0o777, 0o700)
      assert.equal(statSync(dayFile).mode & 0o777, 0o600)
    } finally {
      rmSync(dataDirectory, { recursive: true, force: true })
    }
  })
})
