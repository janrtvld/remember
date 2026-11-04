import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentTraceEvent } from '@remember/shared'
import type { AgentActivityTrackingStatus } from '../agentActivityTracking'
import { createAgentLearningStatusTrace } from '../agentLearningTrace'

const watching: AgentActivityTrackingStatus = {
  state: 'watching',
  lastCheckedAt: 100,
  error: null,
  eventCount: 0,
  pendingSpans: 0,
  deferredSpans: 0,
  oldestPendingAt: null,
  lastRecordedAt: null,
  lastProcessedAt: null,
  providers: [],
  errors: [],
}
const enabled = { enabled: true, paused: false, cloudAnalysisConsent: true, offlineMode: false }

test('background trace stays quiet for healthy polls and changing queue counts', () => {
  const events: AgentTraceEvent[] = []
  const changed = createAgentLearningStatusTrace(
    (event) => events.push(event),
    () => 100
  )
  changed(watching, enabled, 'codex')
  changed({ ...watching, lastCheckedAt: 200, pendingSpans: 622 }, enabled, 'codex')
  changed({ ...watching, state: 'processing', pendingSpans: 622 }, enabled, 'codex')
  changed({ ...watching, lastProcessedAt: 300 }, enabled, 'codex')
  assert.equal(events.length, 0)
})

test('background trace logs blocked transitions and recovery once', () => {
  const events: AgentTraceEvent[] = []
  const changed = createAgentLearningStatusTrace(
    (event) => events.push(event),
    () => 100
  )
  const offline = { ...enabled, offlineMode: true }
  changed(watching, offline, 'codex')
  changed({ ...watching, state: 'waiting', lastCheckedAt: 200, pendingSpans: 622 }, offline, 'codex')
  assert.equal(events.length, 1)
  assert.match(events[0].logs[0].message, /offline-modus/)

  changed(watching, { ...enabled, cloudAnalysisConsent: false }, 'codex')
  changed(watching, { ...enabled, paused: true }, 'codex')
  changed(watching, enabled, 'codex')
  changed({ ...watching, state: 'processing' }, enabled, 'codex')
  assert.equal(events.length, 4)
  assert.match(events[1].logs[0].message, /toestemming/)
  assert.match(events[2].logs[0].message, /gepauzeerd/)
  assert.match(events[3].logs[0].message, /hervat/)
  assert.equal(new Set(events.map((event) => event.id)).size, events.length)
})

test('source read failures remain visible during inference without repeating on each scan', () => {
  const events: AgentTraceEvent[] = []
  const changed = createAgentLearningStatusTrace(
    (event) => events.push(event),
    () => 100
  )
  const errors = [
    { provider: 'codex' as const, path: '/sessions/a.jsonl', error: 'Permission denied' },
    { provider: 'claude' as const, path: '/sessions/b.jsonl', error: 'Read failed' },
  ]
  changed({ ...watching, state: 'processing', errors, error: errors[0].error }, enabled, 'claude')
  changed(
    { ...watching, state: 'processing', errors: [...errors].reverse(), error: errors[1].error, lastCheckedAt: 200 },
    enabled,
    'claude'
  )
  assert.equal(events.length, 1)
  assert.equal(events[0].status, 'failed')
  assert.equal(events[0].provider, 'claude')
  assert.match(events[0].error ?? '', /Permission denied/)
  assert.match(events[0].error ?? '', /Read failed/)
  assert.match(events[0].logs[0].message, /automatisch opnieuw/)

  changed({ ...watching, state: 'processing' }, enabled, 'claude')
  assert.equal(events.length, 2)
  assert.equal(events[1].status, 'completed')
})

test('disabling learning silences stale errors and resets transition state', () => {
  const events: AgentTraceEvent[] = []
  const changed = createAgentLearningStatusTrace(
    (event) => events.push(event),
    () => 100
  )
  const failure = { ...watching, state: 'error' as const, error: 'Source discovery failed' }
  changed(failure, enabled, 'codex')
  changed(failure, { ...enabled, enabled: false }, 'codex')
  changed(watching, enabled, 'codex')
  assert.equal(events.length, 1)
  changed(failure, enabled, 'codex')
  assert.equal(events.length, 2)
})
