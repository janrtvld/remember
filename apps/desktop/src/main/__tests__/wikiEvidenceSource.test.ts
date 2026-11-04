import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WikiSuggestionEvidence } from '@remember/shared'
import type { AgentActivityEvent } from '../agentActivityStore'
import { resolveWikiEvidenceSource } from '../wikiEvidenceSource'

const source: WikiSuggestionEvidence = {
  sourceId: 'codex:session:session:event:0',
  kind: 'agent-session',
  provider: 'codex',
  eventId: 'event',
  documentSourceId: 'session',
  role: 'user',
  observedAt: 100,
  quote: 'Alex and I build this product together.',
}
const event: AgentActivityEvent = {
  id: 'event',
  provider: 'codex',
  sessionId: 'session',
  role: 'user',
  observedAt: 100,
  text: source.quote,
  recordedAt: 100,
  projectPath: null,
  providerEventId: null,
  turnId: null,
  representation: 'response_item',
  sourcePath: '/test/source.jsonl',
  sourceOffset: 0,
}

test('Wiki agent evidence resolves the original event and preserves provider context', () => {
  const result = resolveWikiEvidenceSource(source, { agentEvent: () => event, captured: () => null })
  assert.equal(result?.text, event.text)
  assert.equal(result?.bundleId, 'com.openai.codex')
})

test('a saved quote cannot replace expired, excluded or mismatched original agent evidence', () => {
  const resolve = (current: AgentActivityEvent | null) =>
    resolveWikiEvidenceSource(source, {
      agentEvent: () => current,
      captured: () => ({ kind: 'context', text: source.quote }),
    })
  assert.equal(resolve(null), null)
  for (const change of [
    { role: 'assistant' as const },
    { sessionId: 'other' },
    { provider: 'claude' as const },
    { observedAt: 101 },
    { text: '' },
  ])
    assert.equal(resolve({ ...event, ...change }), null)
})

test('captured evidence continues to use the existing capture resolver', () => {
  const capture = { kind: 'context' as const, text: 'An observed source.' }
  assert.equal(
    resolveWikiEvidenceSource(
      { sourceId: 'capture', kind: 'screen-context', observedAt: 100, quote: capture.text },
      {
        agentEvent: () => {
          throw new Error('must not read the journal')
        },
        captured: (id) => (id === 'capture' ? capture : null),
      }
    ),
    capture
  )
})
