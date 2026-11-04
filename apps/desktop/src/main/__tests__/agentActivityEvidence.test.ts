import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentActivityEvidence } from '../agentActivityEvidence'
import type { AgentActivityEvent } from '../agentActivityStore'
import { compactContextEvidence, partitionEvidence } from '../dailyReview/analysisContext'
import { prepareAnalysisEvidence } from '../dailyReview/analysisPrivacy'
import { wikiSuggestionSources } from '../dailyReview/wikiSuggestionPolicy'

function event(id: string, text: string, observedAt: number, role: 'user' | 'assistant' = 'user'): AgentActivityEvent {
  return {
    id,
    provider: 'codex',
    sessionId: 'project-task',
    projectPath: '/projects/remember',
    role,
    text,
    observedAt,
    recordedAt: observedAt,
    providerEventId: id,
    turnId: 'turn-1',
    representation: 'response_item',
    sourcePath: '/agent/source.jsonl',
    sourceOffset: observedAt,
  }
}

test('Day evidence retains all middle messages and original roles inside the requested window', () => {
  const messages = Array.from({ length: 20 }, (_, index) =>
    event(`event-${index}`, `Original statement ${index}`, 100 + index, index % 2 ? 'assistant' : 'user')
  )
  const evidence = agentActivityEvidence([...messages, ...messages.slice(5, 6)], { after: 101, through: 118 })
  assert.equal(evidence.length, 17)
  assert.equal(evidence[0]?.text, 'Original statement 2')
  assert.equal(evidence.at(-1)?.text, 'Original statement 18')
  assert.equal(evidence.find((entry) => entry.text === 'Original statement 9')?.agentMessage?.role, 'assistant')
  assert.equal(evidence.find((entry) => entry.text === 'Original statement 10')?.agentMessage?.role, 'user')
  assert.ok(evidence.every((entry) => entry.kind === 'agent-message' && entry.endedAt === undefined))
})

test('long original messages are fully preserved across bounded Unicode-safe entries', () => {
  const text = `A substantive explanation: ${'🧠 knowledge matters. '.repeat(1200)}`
  const evidence = agentActivityEvidence([event('long', text, 200)], {
    after: 0,
    through: 300,
    maxCharactersPerEntry: 257,
  })
  assert.ok(evidence.length > 12)
  assert.ok(evidence.every((entry) => entry.text.length <= 257))
  assert.equal(evidence.map((entry) => entry.text).join(''), text)
  assert.ok(evidence.every((entry) => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(entry.text)))
  assert.equal(new Set(evidence.map((entry) => entry.evidenceId)).size, evidence.length)
  assert.ok(evidence.every((entry) => entry.agentMessage?.partCount === evidence.length))
})

test('agent messages clarify work without creating audio conversations or overriding foreground time', () => {
  const foreground = { kind: 'app-period' as const, timestamp: 100, endedAt: 200, app: 'Editor', text: '' }
  const agent = agentActivityEvidence(
    [
      event('request', 'Research how colleagues can use what I learned.', 120),
      event('claim', 'I deployed a complete production system and all tests passed.', 190, 'assistant'),
    ],
    { after: 100, through: 200 }
  )
  const evidence = prepareAnalysisEvidence({
    allEvidence: [foreground, ...agent],
    conversationSummaries: [],
    after: null,
  })
  const shards = partitionEvidence(compactContextEvidence(evidence), { maxCharacters: 4000, timeWindowMs: 60_000 })
  const entries = shards.flatMap((shard) => shard.entries)
  assert.deepEqual(
    entries.find((entry) => entry.kind === 'app-period'),
    foreground
  )
  assert.equal(entries.filter((entry) => entry.kind === 'transcript').length, 0)
  const claim = entries.find((entry) => entry.agentMessage?.eventId === 'claim')
  assert.equal(claim?.agentMessage?.role, 'assistant')
  assert.match(claim?.source ?? '', /claims are not verified actions/)
  assert.equal(claim?.endedAt, undefined)
})

test('Day Wiki review leaves original agent learning to the independent worker', () => {
  const messages = agentActivityEvidence([event('correction', 'Use pnpm.', 120)], { after: 100, through: 200 })
  const captured = {
    kind: 'screen-context' as const,
    evidenceId: 'original-capture',
    timestamp: 130,
    text: 'Independent captured work evidence.',
  }
  assert.deepEqual(wikiSuggestionSources(messages, [], 100, 200), [])
  assert.deepEqual(
    wikiSuggestionSources([...messages, captured], [], 100, 200).map((source) => source.id),
    ['original-capture']
  )
})

test('late-discovered original messages bypass the old Day time watermark once without changing their timestamp', () => {
  const late = { ...event('late', 'A correction in a record that finished writing later.', 150), recordedAt: 250 }
  const normalized = agentActivityEvidence([late], { after: 100, through: 200, recordedThrough: 300 })
  assert.equal(normalized[0]?.timestamp, 150)
  const first = prepareAnalysisEvidence({ allEvidence: normalized, conversationSummaries: [], after: 200 })
  assert.equal(first.length, 1)
  assert.equal(first[0]?.timestamp, 150)
  assert.equal(first[0]?.endedAt, undefined)
  const next = prepareAnalysisEvidence({ allEvidence: normalized, conversationSummaries: [], after: 300 })
  assert.equal(next.length, 0)
  assert.deepEqual(agentActivityEvidence([late], { after: 100, through: 200, recordedThrough: 249 }), [])
  assert.deepEqual(agentActivityEvidence([late], { after: 200, through: 400, recordedThrough: 300 }), [])
})
