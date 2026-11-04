import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AnalysisEvidenceEntry } from '../analysisContext'
import { compactContextEvidence, partitionEvidence } from '../analysisContext'

const HOUR_MS = 60 * 60_000

describe('partitionEvidence', () => {
  it('counts JSON escaping, commas and brackets exactly at a shard boundary', () => {
    const entries: AnalysisEvidenceEntry[] = [
      { timestamp: 0, kind: 'transcript', text: 'quote " and newline\n and slash \\' },
      { timestamp: 1, kind: 'transcript', text: 'emoji 🎉' },
      { timestamp: 2, kind: 'transcript', text: 'third' },
    ]
    const budget = JSON.stringify(entries.slice(0, 2)).length
    const shards = partitionEvidence(entries, { maxCharacters: budget, timeWindowMs: HOUR_MS })
    assert.deepEqual(
      shards.map((shard) => shard.entries),
      [entries.slice(0, 2), entries.slice(2)]
    )
    assert.equal(JSON.stringify(shards[0].entries).length, budget)
  })

  it('keeps every character while splitting large evidence across bounded shards', () => {
    const evidence: AnalysisEvidenceEntry[] = Array.from({ length: 642 }, (_, index) => ({
      timestamp: index * 30_000,
      kind: 'screen-context',
      app: 'Browser',
      window: `Window ${index}`,
      text: `${index}:${'x'.repeat(4_750)}`,
    }))

    const shards = partitionEvidence(evidence, {
      maxCharacters: 320_000,
      timeWindowMs: 2 * HOUR_MS,
    })
    const reconstructed = shards.flatMap((shard) => shard.entries).map((entry) => entry.text)

    assert.ok(shards.length > 1)
    assert.ok(shards.every((shard) => JSON.stringify(shard.entries).length <= 320_000))
    assert.deepEqual(
      reconstructed,
      evidence.map((entry) => entry.text)
    )
  })

  it('uses two-hour boundaries even when the character budget has room', () => {
    const evidence: AnalysisEvidenceEntry[] = [
      { timestamp: 0, kind: 'transcript', text: 'morning' },
      { timestamp: 3 * HOUR_MS, kind: 'transcript', text: 'afternoon' },
    ]

    const shards = partitionEvidence(evidence, {
      maxCharacters: 320_000,
      timeWindowMs: 2 * HOUR_MS,
    })

    assert.equal(shards.length, 2)
    assert.deepEqual(
      shards.map((shard) => shard.entries.map((entry) => entry.text)),
      [['morning'], ['afternoon']]
    )
  })

  it('splits one oversized entry without dropping its text', () => {
    const text = 'context'.repeat(100)
    const shards = partitionEvidence([{ timestamp: 0, kind: 'screen-context', text }], {
      maxCharacters: 200,
      timeWindowMs: 2 * HOUR_MS,
    })

    assert.equal(
      shards
        .flatMap((shard) => shard.entries)
        .map((entry) => entry.text)
        .join(''),
      text
    )
    assert.ok(shards.every((shard) => JSON.stringify(shard.entries).length <= 200))
  })
})

describe('compactContextEvidence', () => {
  it('keeps transcripts and new visible context while removing repeated window text', () => {
    const evidence: AnalysisEvidenceEntry[] = [
      { timestamp: 0, kind: 'screen-context', app: 'Editor', window: 'Feature', text: 'Header\nDecision A' },
      {
        timestamp: 1_000,
        kind: 'screen-context',
        app: 'Editor',
        window: 'Feature',
        text: 'Header\nDecision A\nConstraint B',
      },
      {
        timestamp: 2_000,
        kind: 'screen-context',
        app: 'Editor',
        window: 'Feature',
        text: 'Header\nDecision A\nConstraint B',
      },
      { timestamp: 3_000, kind: 'transcript', text: 'Keep this complete conversation.' },
    ]

    assert.deepEqual(
      compactContextEvidence(evidence).map((entry) => entry.text),
      ['Header\nDecision A', 'Constraint B', 'Keep this complete conversation.']
    )
  })
})
