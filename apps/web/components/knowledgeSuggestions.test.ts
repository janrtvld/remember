import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { KnowledgeSuggestion, WikiChangeLogEntry, WikiSpace } from '@remember/shared'
import {
  groupedPersonalWikiChangesForDay,
  personalWikiChangesForDay,
  presentedKnowledgeSuggestions,
} from './knowledgeSuggestions'

const financeSpace: WikiSpace = {
  id: 'finance',
  name: 'Finance Wiki',
  description: '',
  icon: 'bank',
  color: 'green',
  maintenanceMode: 'suggest',
}

function stored(status: KnowledgeSuggestion['status']): KnowledgeSuggestion {
  return {
    id: 'day-1:decisions/cloud-costs',
    dayId: 'day-1',
    dayStartedAt: 1,
    slug: 'decisions/cloud-costs',
    title: 'Cloud costs',
    content: 'Hosting costs increased after the migration.',
    summary: 'Hosting costs increased after the migration.',
    baseRevision: null,
    sourceId: 'daily-review://day-1',
    suggestedSpaceId: 'finance',
    status,
    destinationSpaceId: null,
    appliedAt: null,
  }
}

describe('presented Knowledge suggestions', () => {
  it('shows a durable pending proposal with its exact destination', () => {
    assert.deepEqual(presentedKnowledgeSuggestions('day-1', [financeSpace], [stored('pending')]), [
      { suggestion: stored('pending'), destinationSpace: financeSpace },
    ])
    assert.equal(presentedKnowledgeSuggestions('day-2', [financeSpace], [stored('pending')]).length, 0)
    assert.equal(presentedKnowledgeSuggestions('day-1', [], [stored('pending')]).length, 0)
  })

  it('removes applied and dismissed suggestions from the review queue', () => {
    assert.equal(presentedKnowledgeSuggestions('day-1', [financeSpace], [stored('applied')]).length, 0)
    assert.equal(presentedKnowledgeSuggestions('day-1', [financeSpace], [stored('dismissed')]).length, 0)
  })
})

describe('Personal Wiki change history', () => {
  it('keeps only persistent log entries that belong to the selected Day', () => {
    const changes: WikiChangeLogEntry[] = [
      {
        id: 'one',
        timestamp: 2,
        sourceId: 'daily-review://day-1',
        source: 'day',
        dayId: 'day-1',
        changes: [{ slug: 'projects/remember', title: 'Remember', type: 'updated' }],
      },
      {
        id: 'two',
        timestamp: 1,
        sourceId: 'agent-import://bootstrap',
        source: 'import',
        dayId: null,
        changes: [{ slug: 'projects/woub', title: 'Woub', type: 'created' }],
      },
    ]

    assert.deepEqual(personalWikiChangesForDay('day-1', changes), [changes[0]])
  })

  it('groups repeated page updates and orders pages and updates by their latest timestamp', () => {
    const changes: WikiChangeLogEntry[] = [
      {
        id: 'first',
        timestamp: 10,
        sourceId: 'daily-review://day-1',
        source: 'day',
        dayId: 'day-1',
        changes: [
          { slug: 'projects/remember', title: 'Remember (old)', type: 'updated' },
          { slug: 'projects/woub', title: 'Woub', type: 'updated' },
        ],
      },
      {
        id: 'latest',
        timestamp: 30,
        sourceId: 'daily-review://day-1',
        source: 'day',
        dayId: 'day-1',
        changes: [{ slug: 'projects/remember', title: 'Remember', type: 'updated' }],
      },
      {
        id: 'middle',
        timestamp: 20,
        sourceId: 'daily-review://day-1',
        source: 'day',
        dayId: 'day-1',
        changes: [{ slug: 'projects/remember', title: 'Remember (middle)', type: 'updated' }],
      },
      {
        id: 'other-day',
        timestamp: 40,
        sourceId: 'daily-review://day-2',
        source: 'day',
        dayId: 'day-2',
        changes: [{ slug: 'projects/remember', title: 'Remember tomorrow', type: 'updated' }],
      },
    ]

    assert.deepEqual(groupedPersonalWikiChangesForDay('day-1', changes), [
      {
        slug: 'projects/remember',
        title: 'Remember',
        updates: [
          { id: 'latest:0', timestamp: 30 },
          { id: 'middle:0', timestamp: 20 },
          { id: 'first:0', timestamp: 10 },
        ],
      },
      {
        slug: 'projects/woub',
        title: 'Woub',
        updates: [{ id: 'first:1', timestamp: 10 }],
      },
    ])
  })
})
