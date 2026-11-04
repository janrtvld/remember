import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ConversationSummary, Day } from '@remember/shared'
import { canMergeConversationHistory, conversationHistory, limitConversationHistory } from '../conversationHistory'

function conversation(startTime: string, title: string): ConversationSummary {
  return { startTime, endTime: startTime, title, description: `${title} description` }
}

function day(id: string, startedAt: number, conversations: ConversationSummary[]): Day {
  return {
    id,
    startedAt,
    endedAt: null,
    activeDurationMs: 0,
    moments: [],
    appActivity: [],
    contextMoments: [],
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
    memory: {
      summary: '',
      currentFocus: null,
      outcomes: [],
      decisions: [],
      openLoops: [],
      conversations,
      timeline: [],
      knowledgeSuggestions: [],
      refreshedAt: startedAt,
      coveredThrough: startedAt,
    },
  }
}

describe('conversation history', () => {
  it('groups sessions from the same local date and orders days and conversations newest first', () => {
    const augustNineMorning = new Date(2026, 7, 9, 9).getTime()
    const augustNineAfternoon = new Date(2026, 7, 9, 15).getTime()
    const augustTen = new Date(2026, 7, 10, 9).getTime()

    const groups = conversationHistory([
      day('morning', augustNineMorning, [conversation('09:30', 'Stand-up')]),
      day('today', augustTen, [conversation('10:00', 'Planning')]),
      day('afternoon', augustNineAfternoon, [conversation('15:30', 'Review')]),
    ])

    assert.equal(groups.length, 2)
    assert.deepEqual(
      groups.map((group) => group.items.map((item) => item.conversation.title)),
      [['Planning'], ['Review', 'Stand-up']]
    )
  })

  it('only offers merging when one persisted Day has two eligible conversations', () => {
    const first = day('morning', new Date(2026, 7, 10, 9).getTime(), [
      { ...conversation('09:00', '09:30'), episodeId: 'morning-episode' },
    ])
    const second = day('afternoon', new Date(2026, 7, 10, 14).getTime(), [
      { ...conversation('14:00', '14:30'), episodeId: 'afternoon-episode' },
    ])
    assert.equal(canMergeConversationHistory(conversationHistory([first, second])), false)

    first.memory?.conversations.push({ ...conversation('10:00', '10:30'), episodeId: 'second-morning-episode' })
    assert.equal(canMergeConversationHistory(conversationHistory([first, second])), true)
  })

  it('omits days without recognized conversations', () => {
    const groups = conversationHistory([day('empty', new Date(2026, 7, 10, 9).getTime(), [])])
    assert.deepEqual(groups, [])
  })

  it('limits the total conversations while preserving date groups', () => {
    const augustNine = new Date(2026, 7, 9, 9).getTime()
    const augustTen = new Date(2026, 7, 10, 9).getTime()
    const groups = conversationHistory([
      day('older', augustNine, [conversation('09:30', 'Stand-up')]),
      day('newer', augustTen, [conversation('10:00', 'Planning'), conversation('09:00', 'Preparation')]),
    ])

    assert.deepEqual(
      limitConversationHistory(groups, 2).map((group) => group.items.map((item) => item.conversation.title)),
      [['Planning', 'Preparation']]
    )
    assert.deepEqual(
      limitConversationHistory(groups, 3).map((group) => group.items.map((item) => item.conversation.title)),
      [['Planning', 'Preparation'], ['Stand-up']]
    )
  })
})
