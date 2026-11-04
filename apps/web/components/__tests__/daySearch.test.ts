import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type Day, prepareRememberSearch, type WikiPage, type WikiSpace } from '@remember/shared'
import {
  conversationSearchHref,
  daySearchHref,
  searchRemember,
  searchWikiPages,
  timelineSearchHref,
} from '../daySearch'

const startedAt = new Date(2026, 6, 14, 8).getTime()

const day: Day = {
  id: 'day/2026-07-14',
  startedAt,
  endedAt: null,
  activeDurationMs: 1,
  moments: [
    {
      id: 'inside-conversation',
      sessionId: 'day/2026-07-14',
      source: 'microphone',
      startedAt: new Date(2026, 6, 14, 11, 32).getTime(),
      durationMs: 60_000,
      status: 'ready',
      transcript: 'We agreed that the zephyr launch should happen on Friday.',
    },
    {
      id: 'outside-conversation',
      sessionId: 'day/2026-07-14',
      source: 'system',
      startedAt: new Date(2026, 6, 14, 15).getTime(),
      durationMs: 60_000,
      status: 'ready',
      transcript: 'Private unrelated capture fragment.',
    },
  ],
  appActivity: [],
  contextMoments: [
    {
      id: 'raw-context',
      timestamp: new Date(2026, 6, 14, 9, 15).getTime(),
      appName: 'Editor',
      windowTitle: 'Hidden evidence',
      text: 'arbitrary underlying capture',
      textSource: 'accessibility',
      trigger: 'test',
      monitorName: 'Display',
      screenshotPath: '',
    },
  ],
  memory: {
    summary: 'Focused on making local search useful.',
    currentFocus: 'Search quality',
    outcomes: ['Shipped keyboard navigation'],
    decisions: ['Keep all matching on-device'],
    openLoops: ['Review the empty state'],
    openTasks: [{ title: 'Polish result snippets', description: 'Keep the interface calm.' }],
    projectAttention: [{ project: 'Remember', durationMinutes: 90, description: 'Built search.' }],
    conversations: [
      {
        startTime: '11:30',
        endTime: '12:00',
        title: 'Launch planning',
        description: 'Chose a release window.',
        summary: 'Reviewed launch constraints and rollout timing.',
        actionPoints: ['Send the release plan'],
      },
    ],
    timeline: [
      {
        id: 'timeline-search',
        startTime: '09:00',
        endTime: '10:00',
        title: 'Search implementation',
        description: 'Added ranking.',
        details: [{ at: '09:20', text: 'Indexed complete activity intervals.' }],
        sourceRefs: [{ kind: 'context', id: 'raw-context' }],
      },
    ],
    knowledgeSuggestions: [],
    refreshedAt: startedAt,
    coveredThrough: startedAt,
  },
  refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
}

describe('Remember search', () => {
  it('matches meaningful day memory fields', () => {
    const results = searchRemember([day], 'keyboard navigation')
    assert.equal(results.days.length, 1)
    assert.match(results.days[0]?.snippet ?? '', /keyboard navigation/i)
    assert.equal(results.conversations.length, 0)
  })

  it('formats day results in the active interface locale', () => {
    assert.match(searchRemember([day], 'keyboard navigation', 'en-US').days[0]?.title ?? '', /Tuesday, July 14/)
    assert.match(searchRemember([day], 'keyboard navigation', 'nl-NL').days[0]?.title ?? '', /Dinsdag 14 juli/)
  })

  it('matches conversation metadata and transcript text inside its time range', () => {
    const titleResults = searchRemember([day], 'rollout timing')
    assert.equal(titleResults.conversations[0]?.conversation.startTime, '11:30')

    const transcriptResults = searchRemember([day], 'zephyr')
    assert.equal(transcriptResults.conversations[0]?.transcriptMatch, true)
    assert.match(transcriptResults.conversations[0]?.snippet ?? '', /zephyr/i)
  })

  it('keeps raw evidence attached to its Timeline block instead of exposing standalone capture results', () => {
    const grouped = searchRemember([day], 'search')
    assert.deepEqual(Object.keys(grouped), ['days', 'conversations', 'timeline'])

    const rawContext = searchRemember([day], 'arbitrary underlying capture')
    assert.equal(rawContext.timeline[0]?.block.id, 'timeline-search')
    assert.match(rawContext.timeline[0]?.snippet ?? '', /arbitrary underlying capture/i)

    const unassociatedTranscript = searchRemember([day], 'Private unrelated capture')
    assert.deepEqual(unassociatedTranscript, { days: [], conversations: [], timeline: [] })
  })

  it('does not expose unrecognized audio merely because it overlaps a visible Timeline block', () => {
    const rejectedAudioDay: Day = {
      ...day,
      moments: [
        ...day.moments,
        {
          ...day.moments[1],
          id: 'rejected-media-audio',
          startedAt: new Date(2026, 6, 14, 9, 30).getTime(),
          transcript: 'Hidden media oracle velvet-platypus.',
        },
      ],
    }

    assert.deepEqual(searchRemember([rejectedAudioDay], 'velvet-platypus'), {
      days: [],
      conversations: [],
      timeline: [],
    })
  })

  it('redacts OAuth callback secrets before matching or presenting captured evidence', () => {
    const callbackDay: Day = {
      ...day,
      contextMoments: [
        {
          ...day.contextMoments[0],
          text: 'Callback http://localhost/callback?code=secret-code&state=secret-state&org_id=org-secret&project_id=project-secret&plan_type=private-plan completed',
        },
      ],
    }

    assert.deepEqual(searchRemember([callbackDay], 'secret-code'), {
      days: [],
      conversations: [],
      timeline: [],
    })
    const results = searchRemember([callbackDay], 'callback')
    assert.match(results.timeline[0]?.snippet ?? '', /code=\[redacted\]/)
    assert.doesNotMatch(results.timeline[0]?.snippet ?? '', /secret-(?:code|state)/)
    assert.doesNotMatch(results.timeline[0]?.snippet ?? '', /(?:org|project)-secret|private-plan/)
  })

  it('matches the structured activity record behind a Timeline summary', () => {
    const results = searchRemember([day], 'complete activity intervals')
    assert.equal(results.timeline[0]?.block.id, 'timeline-search')
    assert.match(results.timeline[0]?.snippet ?? '', /complete activity intervals/i)
  })

  it('keeps hidden Timeline wording and evidence out of every search group', () => {
    const hiddenDay: Day = {
      ...day,
      memory: day.memory
        ? {
            ...day.memory,
            hiddenTimelineItemIds: ['timeline-search'],
          }
        : null,
    }

    assert.deepEqual(searchRemember([hiddenDay], 'Search implementation'), {
      days: [],
      conversations: [],
      timeline: [],
    })
    assert.deepEqual(searchRemember([hiddenDay], 'arbitrary underlying capture'), {
      days: [],
      conversations: [],
      timeline: [],
    })
  })

  it('ranks a Timeline summary match above incidental raw evidence from another block', () => {
    const noisyDay: Day = {
      ...day,
      contextMoments: [
        ...day.contextMoments,
        {
          ...day.contextMoments[0],
          id: 'incidental-context',
          text: 'Added ranking while switching windows.',
        },
      ],
      memory: day.memory
        ? {
            ...day.memory,
            timeline: [
              {
                id: 'unrelated-block',
                startTime: '08:00',
                endTime: '08:30',
                title: 'Unrelated work',
                description: 'Worked on another subject.',
                sourceRefs: [{ kind: 'context', id: 'incidental-context' }],
              },
              ...day.memory.timeline,
            ],
          }
        : null,
    }

    assert.equal(searchRemember([noisyDay], 'Added ranking').timeline[0]?.block.id, 'timeline-search')
  })

  it('builds day and selected-item deep links', () => {
    const now = new Date('2026-07-20T12:00:00+02:00').getTime()
    const conversation = day.memory?.conversations[0]
    const timelineItem = day.memory?.timeline[0]
    assert.ok(conversation)
    assert.ok(timelineItem)
    assert.equal(daySearchHref(day, now), '/day/?id=day%2F2026-07-14')
    assert.equal(
      conversationSearchHref(day, conversation, now),
      '/day/conversation/?id=day%2F2026-07-14&conversation=window%3A11%3A30-12%3A00'
    )
    assert.equal(
      timelineSearchHref(day, timelineItem, now),
      '/day/timeline/?id=day%2F2026-07-14&timelineItem=timeline-search'
    )
  })

  it('finds cached Wiki content in existing local Spaces', () => {
    const space: WikiSpace = {
      id: 'team',
      name: 'Team Wiki',
      description: '',
      icon: 'building',
      color: 'slate',
      maintenanceMode: 'suggest',
    }
    const page: WikiPage = {
      slug: 'projects/atlas-launch',
      title: 'Atlas Launch Ledger',
      content: '<!-- remember:managed:start -->\nOwner: Noor\n<!-- remember:managed:end -->',
      excerpt: 'Owner: Noor',
      updatedAt: 10,
      revision: 'revision-1',
      sourceCount: 1,
    }

    assert.equal(searchWikiPages([space], { team: [page] }, 'Atlas Launch Ledger')[0]?.page.slug, page.slug)
    assert.equal(searchWikiPages([space], { team: [page] }, 'remember managed start')[0]?.page.slug, page.slug)
    assert.deepEqual(
      searchWikiPages([space], { team: [{ ...page, slug: 'index', title: 'System index' }] }, 'System index'),
      []
    )
    assert.deepEqual(searchWikiPages([], { team: [page] }, 'Noor'), [])
  })
})

it('prepares search in interruptible steps and never caches a cancelled partial index', async () => {
  const fresh = structuredClone(day)
  let yields = 0
  await assert.rejects(
    prepareRememberSearch(fresh, 'nl-NL', async () => {
      yields++
      throw new Error('cancelled')
    }),
    /cancelled/
  )
  assert.equal(yields, 1)
  const expected = searchRemember([structuredClone(day)], 'zephyr')
  assert.deepEqual(searchRemember([fresh], 'zephyr'), expected)
  const prepared = structuredClone(day)
  await prepareRememberSearch(prepared, 'nl-NL', async () => {
    yields++
  })
  assert(yields > 1)
  assert.deepEqual(searchRemember([prepared], 'zephyr'), expected)
})
