import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { wikiMutationDayId } from '../wikiDayAttribution'

describe('Wiki mutation Day attribution', () => {
  const days = [
    { id: 'day-22', startedAt: new Date(2026, 8, 22, 9).getTime() },
    { id: 'day-23', startedAt: new Date(2026, 8, 23, 9).getTime() },
  ]

  it('uses the local mutation date even when background learning finishes outside capture hours', () => {
    assert.equal(wikiMutationDayId('agent-learning://batch', new Date(2026, 8, 22, 23, 59).getTime(), days), 'day-22')
    assert.equal(wikiMutationDayId('agent-learning://batch', new Date(2026, 8, 23, 0, 1).getTime(), days), 'day-23')
  })

  it('preserves explicit Day ownership and never assigns unrelated or missing-day history', () => {
    const timestamp = new Date(2026, 8, 23, 10).getTime()
    assert.equal(wikiMutationDayId('daily-review://day-22/timeline/item', timestamp, days), 'day-22')
    assert.equal(wikiMutationDayId('agent-import://batch', timestamp, days), null)
    assert.equal(wikiMutationDayId('editor', timestamp, days), null)
    assert.equal(wikiMutationDayId('agent-learning://batch', timestamp, []), null)
    assert.equal(wikiMutationDayId('agent-learning://batch', new Date(2026, 8, 24, 10).getTime(), days), null)
  })
})
