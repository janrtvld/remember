import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createConversationReader } from '../conversationReadProtocol'

function fixture() {
  const transcript = 'Hello 🌍. '.repeat(2000)
  const records = [
    {
      id: 'imported',
      date: '2026-11-03',
      text: transcript,
      revision: 'one',
      source: 'revinote',
      transcriptAvailable: true,
      sourceRef: { kind: 'conversation', id: 'imported' },
    },
    { id: 'local', date: '2026-11-02', text: '', revision: 'two', source: 'conversation', transcriptAvailable: false },
  ]
  const reader = createConversationReader({
    dates: () => ['2026-11-04', '2026-11-03', '2026-11-02'],
    archive: async (args) => ({
      dataDirectory: '/test',
      timezone: 'Europe/Amsterdam',
      items: records.filter((row) => row.date === args[1]),
      nextOffset: null,
    }),
    now: () => 100,
  })
  const read = (input: unknown) => reader(input, new AbortController().signal)
  return { read, records, transcript }
}

describe('bounded canonical conversation reads', () => {
  it('finds latest records across empty days, then pages older conversations without dumping transcripts', async () => {
    const { read } = fixture()
    const first = await read({ limit: 1 })
    assert('items' in first)
    assert.equal(first.items[0]?.id, 'imported')
    assert.equal(first.nextOffset, 1)
    assert(JSON.stringify(first).length < 2000)
    const next = await read({ limit: 1, offset: first.nextOffset })
    assert('items' in next)
    assert.equal(next.items[0]?.id, 'local')
    assert.equal(next.nextOffset, null)
    assert.equal(next.items[0]?.transcriptAvailable, false)
  })

  it('reassembles exact Unicode transcript pages and rejects a revision change or deleted source', async () => {
    const { read, transcript, records } = fixture()
    const request = { view: 'transcript', date: '2026-11-03', id: 'imported', revision: 'one' }
    let offset: number | null = 0
    let text = ''
    while (offset !== null) {
      const page = await read({ ...request, offset })
      assert('text' in page)
      assert(Array.from(page.text).length <= 6000)
      text += page.text
      offset = page.nextOffset
    }
    assert.equal(text, transcript)
    records[0].revision = 'changed'
    await assert.rejects(read(request), /revision-conflict/)
    records.shift()
    const missing = await read(request)
    assert.equal(missing.availability, 'not_found')
    assert('record' in missing && missing.record === null)
  })

  it('keeps missing text distinct from an empty query and validates untrusted parameters', async () => {
    const { read } = fixture()
    assert.equal(
      (await read({ view: 'transcript', date: '2026-11-02', id: 'local', revision: 'two' })).availability,
      'transcript_unavailable'
    )
    for (const input of [
      { date: '2026-02-30' },
      { limit: 21 },
      { offset: -1 },
      { view: 'delete' },
      { view: 'transcript' },
      { action: 'task.complete' },
    ])
      await assert.rejects(read(input))
  })
})
