import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createDeliveryContent, hasMeaningfulRelayChanges } from '../continuityRelayDelivery'
import type { RelayBatch, RelayChange } from '../continuityRelayStore'

const dayStart = Date.UTC(2026, 9, 16)

function change(
  kind: string,
  id: string,
  record: Record<string, unknown>,
  extra: Partial<RelayChange> = {}
): RelayChange {
  return {
    sourceRef: { kind, id },
    operation: 'updated',
    availability: 'available',
    record,
    readAt: dayStart + 10_000,
    changeObservedAt: dayStart + 9_000,
    readContentHash: `synthetic-hash-${id}`,
    archiveVersionHash: `synthetic-archive-${id}`,
    historicalVersionGuaranteed: false,
    origin: 'source',
    eligibleForWorkUpdate: true,
    ...extra,
  }
}

function day() {
  return change('day', 'today', {
    local_day: '2026-10-16',
    started_at: dayStart,
    memory_covered_through: dayStart + 5_000,
    memory_refreshed_at: dayStart + 7_000,
    refresh_status: 'refreshing',
    refresh_target_through: dayStart + 9_000,
    memory_json: JSON.stringify({
      summary: 'A source-generated interpretation, not a relay summary.',
      currentFocus: null,
      outcomes: [{ text: 'Source outcome', sourceRef: { kind: 'context', id: 'context-1' } }],
      decisions: [],
      openLoops: ['Source open loop'],
      timeline: [{ text: 'Older timeline omitted from this projection.' }],
    }),
  })
}

function batch(changes: RelayChange[], stateSources: RelayChange[] = changes): RelayBatch {
  return {
    schemaVersion: 1,
    kind: 'remember.context.batch',
    batchId: 'synthetic-batch',
    sequence: 1,
    profileId: 'synthetic-profile',
    consumerId: 'synthetic-parent',
    createdAt: dayStart + 11_000,
    sourceCursorBefore: null,
    sourceCursorAfter: 'synthetic-cursor',
    baseline: true,
    synthetic: true,
    changes,
    snapshot: {
      observedAt: dayStart + 9_000,
      capture: { status: 'recording', context: { health: 'healthy', lastEventAt: dayStart + 8_000 } },
      processing: { live: { dayRefreshIntervalMinutes: 1 }, persisted: { olderDays: [] } },
      continuity: { historicalEventLog: false, wikiIncluded: false },
    },
    state: {
      sources: Object.fromEntries(
        stateSources.map((source) => [`${source.sourceRef.kind}:${source.sourceRef.id}`, source])
      ),
      open: [],
      completed: [],
      abandoned: [],
      superseded: [],
      blockers: [],
      focus: [],
      uncertainties: ['Synthetic source uncertainty.'],
    },
    payloadHash: 'synthetic-original-batch-hash',
  }
}

function meaningfulChanges(previous: RelayChange[], changes: RelayChange[], snapshot?: Record<string, unknown>) {
  const before = batch(previous)
  const after = batch(changes, [...previous, ...changes])
  return hasMeaningfulRelayChanges({
    previousState: before.state,
    nextState: after.state,
    previousSnapshot: before.snapshot,
    input: {
      cursorBefore: 'previous',
      cursorAfter: 'next',
      changes,
      snapshot: snapshot ?? after.snapshot,
      synthetic: true,
      baseline: false,
    },
  })
}

describe('Remember faithful delivery projection', () => {
  it('preserves exact selected day interpretation and coverage with explicit projection-only acknowledgement scope', () => {
    const today = day()
    const yesterday = change('day', 'yesterday', { local_day: '2026-10-15', memory_json: '{"summary":"Old day"}' })
    const original = batch([yesterday, today])
    const projection = createDeliveryContent(original)
    assert.equal(projection.scope.acknowledges, 'this-projection-only')
    assert.equal(projection.scope.rawRecordsFullyReadByRecipient, false)
    assert.equal(projection.scope.originalsAvailable, true)
    assert.equal(projection.sourceBatch.payloadHash, original.payloadHash)
    assert.ok(!Object.hasOwn(projection, 'payloadHash'))
    assert.deepEqual(projection.coverage.capture, original.snapshot.capture)
    assert.deepEqual(projection.coverage.processing, { live: { dayRefreshIntervalMinutes: 1 } })
    assert.equal(projection.coverage.currentDay?.sourceRef.id, 'today')
    assert.equal(projection.coverage.currentDay?.record.memory_covered_through, dayStart + 5_000)
    assert.deepEqual(projection.dayMemory?.memory, {
      summary: 'A source-generated interpretation, not a relay summary.',
      currentFocus: null,
      outcomes: [{ text: 'Source outcome', sourceRef: { kind: 'context', id: 'context-1' } }],
      decisions: [],
      openLoops: ['Source open loop'],
    })
    assert.equal(projection.dayMemory?.parseStatus, 'parsed')
    assert.equal(projection.omissions.countsByReason['older-day'], 1)
    assert.ok('groups' in projection.omissions)
    assert.deepEqual(projection.omissions.groups, [
      {
        kind: 'day',
        reason: 'older-day',
        sources: [{ id: 'yesterday', archiveVersionHash: 'synthetic-archive-yesterday' }],
      },
    ])
  })

  it('deduplicates source identities while preserving every full fragment, equal-time evidence and window', () => {
    const fullText = `  ${'Full original text.\n'.repeat(10_000)}  `
    const record = { application_id: 'app', window_title: 'Project', url: 'https://example.test', timestamp: dayStart }
    const older = change('context', 'older', { ...record, text: 'Previous text' })
    const newest = change('context', 'newest', { ...record, timestamp: dayStart + 2, text: fullText })
    const empty = change('context', 'empty', { ...record, timestamp: dayStart + 3, text: ' \n' })
    const otherWindow = change('context', 'other-window', { ...record, window_title: 'Other', text: 'Other work' })
    const sameTime = change('context', 'z-tie', { ...newest.record, text: 'Equal-time source evidence is retained.' })
    const projection = createDeliveryContent(batch([newest, older, newest, empty, otherWindow, sameTime]))
    assert.deepEqual(
      projection.activities.map((source) => source.sourceRef.id),
      ['older', 'other-window', 'newest', 'z-tie', 'empty']
    )
    assert.equal(projection.activities[2].text, fullText)
    assert.equal(projection.activities[2].readContentHash, newest.readContentHash)
    assert.equal(projection.activities[2].readAt, newest.readAt)
    assert.equal(projection.activities[4].fragmentKind, 'metadata-only')
    assert.deepEqual(projection.omissions.countsByReason, {})
    assert.equal(projection.scope.sourceRecordCount, 5)
    assert.equal(projection.scope.batchChangeRecordCount, 6)
  })

  it('retains the full captured snapshot before short added-line UI fragments in event order', () => {
    const metadata = {
      workday_id: 'today',
      application_id: 1,
      window_title: 'ChatGPT',
      url: 'app://-/index.html',
      focus_segment_id: 'focus',
      text_source: 'accessibility',
    }
    const texts = ['Full source context.\n'.repeat(1_000), 'A later interface update', 'Loading', 'Reconnecting']
    const fragments = texts.map((text, index) =>
      change('context', `fragment-${index}`, {
        ...metadata,
        timestamp: dayStart + index,
        trigger: index === 0 ? 'app-change' : 'content-change:new-visible-text',
        text,
      })
    )
    const projection = createDeliveryContent(batch([...fragments].reverse()))
    assert.deepEqual(
      projection.activities.map((source) => source.text),
      texts
    )
    assert.deepEqual(
      projection.activities.map((source) => source.fragmentKind),
      ['checkpoint-or-unmarked', 'added-visible-lines', 'added-visible-lines', 'added-visible-lines']
    )
    assert.deepEqual(
      projection.contextChains[0].orderedSourceRefs,
      fragments.map((source) => source.sourceRef)
    )
    assert.deepEqual(projection.contextChains[0].initialBase, {
      status: 'unverified-checkpoint-or-unmarked',
      sourceRef: fragments[0].sourceRef,
    })
    assert.equal(projection.contextChains[0].completeHistory, false)
    assert.equal(projection.contextChains[0].currentScreenReconstructed, false)
    assert.ok(projection.activities.every((source) => source.captureMetadata.focus_segment_id === 'focus'))
    assert.ok(projection.activities.every((source) => !Object.hasOwn(source, 'selfEcho')))
    assert.deepEqual(
      projection.activities.map((source) => source.archiveVersionHash),
      fragments.map((source) => source.archiveVersionHash)
    )
  })

  it('carries retained base and earlier fragments across batches while keeping each URL and raw body', () => {
    const record = {
      workday_id: 'today',
      application_id: 1,
      window_title: 'Project',
      text_source: 'accessibility',
      trigger: 'content-change:new-visible-text',
    }
    const base = change('context', 'base', {
      ...record,
      timestamp: dayStart,
      trigger: 'app-change',
      url: 'https://example.test/first',
      text: 'Full retained base.\n'.repeat(1_000),
    })
    const earlier = change('context', 'earlier', {
      ...record,
      timestamp: dayStart + 1,
      url: 'https://example.test/second',
      text: 'Earlier new lines.',
    })
    const latest = change('context', 'latest', {
      ...record,
      timestamp: dayStart + 2,
      url: 'https://example.test/second',
      text: 'Reconnecting',
    })
    const otherDay = change('context', 'other-day', { ...base.record, workday_id: 'yesterday', text: 'Old day.' })
    const previous = createDeliveryContent(batch([base, earlier]))
    const next = batch([latest], [latest, earlier, base, otherDay])
    next.baseline = false
    next.sequence = 2
    next.state.projectionLimits = { historicalSourcesPerKind: 50, allOpenWorkItems: true, allActiveBlockers: true }
    const projection = createDeliveryContent(next)
    assert.deepEqual(
      projection.activities.map((source) => source.text),
      [base.record?.text, earlier.record?.text, latest.record?.text]
    )
    assert.deepEqual(
      projection.activities.map((source) => source.changedInBatch),
      [false, false, true]
    )
    assert.deepEqual(projection.activities[0].sourceRef, previous.activities[0].sourceRef)
    assert.equal(projection.activities[0].archiveVersionHash, previous.activities[0].archiveVersionHash)
    assert.deepEqual(
      projection.activities.map((source) => source.url),
      ['https://example.test/first', 'https://example.test/second', 'https://example.test/second']
    )
    assert.equal(projection.contextChains.length, 1)
    assert.equal(projection.contextChains[0].retainedSourceLimitPerKind, 50)
    assert.equal(projection.contextChains[0].retentionGapsPossible, true)
    assert.equal(projection.activities[0].chronology.canAdvanceObservedFocus, false)
    assert.equal(projection.activities[2].chronology.canAdvanceObservedFocus, true)
  })

  it('reports missing bases and excludes private or retracted retained fragments from cross-batch context', () => {
    const metadata = { workday_id: 'today', application_id: 1, window_title: 'Project', timestamp: dayStart }
    const privateBase = change('context', 'private-base', { ...metadata, trigger: 'app-change', text: 'PRIVATE BASE' })
    const retracted = change('context', 'retracted-fragment', {
      ...metadata,
      timestamp: dayStart + 1,
      trigger: 'content-change:new-visible-text',
      text: 'RETRACTED FRAGMENT',
    })
    const latest = change('context', 'latest', {
      ...metadata,
      timestamp: dayStart + 2,
      trigger: 'content-change:new-visible-text',
      text: 'Still eligible fragment.',
    })
    const next = batch([latest], [privateBase, retracted, latest])
    next.baseline = false
    next.retractions = [{ sourceRef: retracted.sourceRef, reason: 'ineligible' }]
    next.snapshot.privacyOmissions = [
      { sourceRef: privateBase.sourceRef, reason: 'authentication_surface', detection: 'preview_metadata' },
    ]
    const projection = createDeliveryContent(next)
    assert.deepEqual(
      projection.activities.map((source) => source.sourceRef.id),
      ['latest']
    )
    assert.deepEqual(projection.contextChains[0].initialBase, { status: 'not-retained', sourceRef: null })
    assert.equal(projection.contextChains[0].retentionGapsPossible, true)
    assert.equal(projection.contextChains[0].completeHistory, false)
    assert.ok(!JSON.stringify(projection).includes('PRIVATE BASE'))
    assert.ok(!JSON.stringify(projection).includes('RETRACTED FRAGMENT'))
    assert.deepEqual(projection.retractions, next.retractions)
    assert.equal(projection.privacyOmissions[0].sourceRef.id, 'private-base')
    const evictedBase = batch([latest])
    evictedBase.baseline = false
    assert.deepEqual(createDeliveryContent(evictedBase).contextChains[0].initialBase, {
      status: 'not-retained',
      sourceRef: null,
    })
  })

  it('preserves self-echo provenance labels without suppressing raw context or treating them as authorship', () => {
    const original = change('context', 'parent-surface', {
      application_id: 1,
      window_title: 'ChatGPT',
      timestamp: dayStart,
      text: 'Full mixed user and assistant evidence.\n'.repeat(1_000),
    })
    const selfEcho = {
      classification: 'uncertain',
      basis: 'no_exact_thread_identity',
      scope: 'surface_provenance_only',
    }
    const labeled = { ...original, selfEcho }
    const focus = {
      ...change('focus', 'parent-focus', { started_at: dayStart }),
      selfEcho: { ...selfEcho, classification: 'confirmed', basis: 'exact_thread_metadata', threadId: 'parent' },
    }
    const projection = createDeliveryContent(batch([labeled, focus]))
    assert.equal(projection.activities[0].text, original.record?.text)
    assert.deepEqual(projection.activities[0].selfEcho, selfEcho)
    assert.deepEqual(projection.focusChanges[0].selfEcho, focus.selfEcho)
    assert.equal(projection.scope.selectedSourceRecordCount, 2)
    assert.equal(meaningfulChanges([original], [labeled]), true)
  })

  it('delivers changed closed work items and blocker corrections without resending unchanged open candidates', () => {
    const previouslyOpen = change('work_item', 'closed', { title: 'Earlier title', lifecycle: 'open', status: 'todo' })
    const closed = change(
      'work_item',
      'closed',
      {
        title: 'Corrected title',
        description: 'Exact description',
        lifecycle: 'completed',
        status: 'done',
        updated_at: 12,
      },
      { readAt: previouslyOpen.readAt + 1 }
    )
    const unchangedOpen = change('work_item', 'open', { title: 'Current candidate', lifecycle: 'open', due_at: null })
    const historicalClosed = change('work_item', 'old', { title: 'Older completed item', lifecycle: 'completed' })
    const blocked = change('work_item_observation', 'blocked', {
      kind: 'blocked',
      work_item_id: 'open',
      dismissed_at: null,
      detail: 'A source observed a blocker.',
    })
    const dismissed = change('work_item_observation', 'dismissed', {
      kind: 'blocked',
      work_item_id: 'closed',
      dismissed_at: 12,
    })
    const original = batch([closed, dismissed], [previouslyOpen, unchangedOpen, historicalClosed, blocked])
    original.baseline = false
    const projection = createDeliveryContent(original)
    assert.equal(projection.workItems.length, 1)
    assert.deepEqual(projection.workItems[0].record, closed.record)
    assert.equal(projection.workItems[0].candidateOnly, true)
    assert.equal(projection.workItems[0].changedInBatch, true)
    assert.equal(projection.mode, 'delta')
    assert.equal(projection.baseSequence, original.sequence - 1)
    assert.equal(projection.blockers.activeScope, 'all-current-observed-open-items')
    assert.deepEqual(
      projection.blockers.active.map((item) => item.sourceRef.id),
      ['blocked']
    )
    assert.deepEqual(
      projection.blockers.changes.map((item) => item.sourceRef.id),
      ['dismissed']
    )
  })

  it('does not present stale agent messages as current work and retains full latest genuine session content', () => {
    const stale = change('agent_event', 'stale', { observed_at: dayStart - 1, content: 'Old claim', session_id: 'old' })
    const earlier = change('agent_event', 'earlier', {
      observed_at: dayStart + 1,
      content: 'Earlier',
      session_id: 'new',
    })
    const latest = change('agent_event', 'latest', {
      observed_at: dayStart + 2,
      content: 'Full current event.\n'.repeat(1_000),
      session_id: 'new',
      role: 'assistant',
    })
    const source = change('agent_source', 'source', { checked_at: dayStart + 3 })
    const relay = change('agent_event', 'relay', latest.record ?? {}, { origin: 'relay', eligibleForWorkUpdate: false })
    const projection = createDeliveryContent(batch([day(), latest, stale, earlier, source, relay]))
    assert.equal(projection.agentEvents.length, 1)
    assert.deepEqual(projection.agentEvents[0].record, latest.record)
    assert.equal(projection.omissions.countsByReason['agent-event-before-current-day'], 1)
    assert.equal(projection.omissions.countsByReason['older-agent-event-in-session'], 1)
    assert.equal(projection.omissions.countsByReason['relay-origin'], 1)
    assert.equal(projection.omissions.countsByReason['deeper-lookup-available'], 1)
    assert.equal(createDeliveryContent(batch([latest])).omissions.countsByReason['agent-event-date-window-unknown'], 1)
  })

  it('delivers every deletion, unavailable read and retraction, suppressing retracted cached work', () => {
    const deleted = change(
      'work_item',
      'deleted',
      {},
      { operation: 'deleted', availability: 'not_found', record: null }
    )
    const missing = change('context', 'missing', {}, { availability: 'not_found', record: null })
    const cached = change('work_item', 'retracted', { lifecycle: 'open', title: 'No longer eligible' })
    const original = batch([deleted, missing], [cached])
    original.retractions = [{ sourceRef: cached.sourceRef, reason: 'relay-origin' }]
    const projection = createDeliveryContent(original)
    assert.deepEqual(
      projection.removals.map((item) => item.sourceRef.id),
      ['missing', 'deleted']
    )
    assert.deepEqual(projection.retractions, original.retractions)
    assert.deepEqual(projection.workItems, [])
    assert.equal(projection.scope.omittedSourceRecordCount, 0)
  })

  it('is deterministic across input ordering and distinguishes malformed or absent day memory', () => {
    const first = change('context', 'first', { timestamp: dayStart, application_id: 'one', text: 'One' })
    const second = change('context', 'second', { timestamp: dayStart, application_id: 'two', text: 'Two' })
    const sources = [day(), first, second]
    const forward = createDeliveryContent(batch(sources))
    const reverse = createDeliveryContent(batch([...sources].reverse()))
    assert.equal(JSON.stringify(forward), JSON.stringify(reverse))
    assert.equal(
      forward.scope.selectedSourceRecordCount + forward.scope.omittedSourceRecordCount,
      forward.scope.sourceRecordCount
    )
    const malformed = change('day', 'bad', { local_day: '2026-10-16', memory_json: 'not-json' })
    assert.equal(createDeliveryContent(batch([malformed])).dayMemory?.parseStatus, 'invalid')
    assert.equal(createDeliveryContent(batch([change('day', 'empty', {})])).dayMemory?.parseStatus, 'absent')
  })

  it('keeps a removal observation even when the same source becomes available later in the batch', () => {
    const missing = change('work_item', 'returned', {}, { availability: 'not_found', record: null })
    const returned = change(
      'work_item',
      'returned',
      { lifecycle: 'open', title: 'Available again' },
      { readAt: missing.readAt + 1 }
    )
    const projection = createDeliveryContent(batch([missing, returned, missing]))
    assert.equal(projection.removals.length, 1)
    assert.equal(projection.removals[0].readAt, missing.readAt)
    assert.equal(projection.workItems.length, 1)
    assert.equal(projection.workItems[0].readAt, returned.readAt)
    assert.equal(projection.scope.sourceRecordCount, 1)
  })

  it('makes historical closed baseline items explicit lifecycle projections while retaining open context', () => {
    const closed = change('work_item', 'closed', {
      title: 'Completed item',
      lifecycle: 'completed',
      status: 'done',
      updated_at: dayStart,
      context: 'Full historical context is available by source lookup.',
    })
    const open = change('work_item', 'open', {
      title: 'Open candidate',
      lifecycle: 'open',
      context: 'Full current context.',
    })
    const projection = createDeliveryContent(batch([closed, open]))
    assert.equal(projection.workItems[0].detail, 'lifecycle-only')
    assert.deepEqual(projection.workItems[0].record, {
      title: 'Completed item',
      lifecycle: 'completed',
      status: 'done',
      updated_at: dayStart,
    })
    assert.equal(projection.workItems[1].detail, 'current-fields')
    assert.equal(projection.workItems[1].record.context, 'Full current context.')
  })

  it('retains unchanged day memory by explicit marker and provides a queryable delta omission manifest', () => {
    const unchangedDay = day()
    const unchangedOpen = change('work_item', 'open', { title: 'Still open', lifecycle: 'open' })
    const current = change('context', 'current', { timestamp: dayStart + 10, text: 'Full changed context.' })
    const original = batch([current], [unchangedDay, unchangedOpen, current])
    original.baseline = false
    original.sequence = 2
    const projection = createDeliveryContent(original)
    assert.deepEqual(projection.dayMemory, { mode: 'unchanged', baseSequence: 1, sourceRef: unchangedDay.sourceRef })
    assert.equal(projection.coverage.currentDay?.record.memory_covered_through, dayStart + 5_000)
    assert.deepEqual(projection.workItems, [])
    assert.equal(projection.activities[0].text, current.record?.text)
    assert.equal(projection.omissionIsDeletion, false)
    assert.ok(!Object.hasOwn(projection.omissions, 'groups'))
    assert.ok('locallyQueryableManifest' in projection.omissions)
    assert.equal(projection.omissions.locallyQueryableManifest.sourceBatchId, original.batchId)
    assert.equal(projection.omissions.locallyQueryableManifest.sourcePayloadHash, original.payloadHash)
    const updatedDay = createDeliveryContent({ ...original, changes: [unchangedDay, current] })
    assert.equal(updatedDay.dayMemory?.parseStatus, 'parsed')
    assert.equal(updatedDay.dayMemory?.memory?.summary, 'A source-generated interpretation, not a relay summary.')
  })

  it('omits authentication metadata surfaces without excluding ordinary work in the same application', () => {
    const auth = change('context', 'auth', {
      application_id: 1,
      window_title: 'Login',
      text: 'SYNTHETIC PRIVATE AUTHENTICATION BODY',
      timestamp: dayStart,
    })
    const ordinary = change('context', 'engineering', {
      application_id: 1,
      window_title: 'Implement login form',
      url: 'https://example.test/project',
      text: 'Ordinary engineering discussion mentions password hints.',
      timestamp: dayStart + 1,
    })
    const focus = change('focus', 'auth-focus', {
      window_title: 'Account',
      url: 'https://example.test/oauth/authorize',
      text: 'SYNTHETIC PRIVATE FOCUS BODY',
    })
    const projection = createDeliveryContent(batch([auth, ordinary, focus]))
    assert.deepEqual(
      projection.activities.map((source) => source.sourceRef.id),
      ['engineering']
    )
    assert.equal(projection.activities[0].text, ordinary.record?.text)
    assert.deepEqual(projection.focusChanges, [])
    assert.equal(projection.scope.privacyOmittedSourceRecordCount, 2)
    assert.deepEqual(
      projection.privacyOmissions.map((source) => source.sourceRef.id),
      ['auth', 'auth-focus']
    )
    assert.ok(projection.privacyOmissions.every((source) => source.reason === 'authentication_surface'))
    assert.ok(!JSON.stringify(projection).includes('SYNTHETIC PRIVATE'))
    assert.ok(!JSON.stringify(projection).includes('/oauth/authorize'))
  })

  it('keeps source-redacted privacy omissions explicit and suppresses directly linked derived sources', () => {
    const redacted = change(
      'context',
      'redacted',
      {
        id: 'redacted',
        timestamp: dayStart,
        contentOmitted: true,
        omissionReason: 'authentication_surface',
      },
      { eligibleForWorkUpdate: false }
    )
    const derived = change(
      'work_item',
      'derived',
      {
        lifecycle: 'open',
        title: 'SYNTHETIC PRIVATE DERIVED TITLE',
        description: 'Should not be relayed.',
      },
      { sourceDetails: { sources: [{ sourceRef: redacted.sourceRef }] } }
    )
    const transitive = change('work_item_observation', 'derived-blocker', {
      work_item_id: 'derived',
      kind: 'blocked',
      sourceRef: derived.sourceRef,
      detail: 'SYNTHETIC PRIVATE BLOCKER',
    })
    const original = batch([redacted, derived, transitive])
    original.baseline = false
    original.sequence = 3
    const projection = createDeliveryContent(original)
    assert.deepEqual(projection.workItems, [])
    assert.deepEqual(projection.blockers.changes, [])
    assert.equal(projection.scope.privacyOmittedSourceRecordCount, 3)
    assert.equal(projection.scope.originalsAvailable, false)
    assert.equal(projection.omissions.countsByReason.authentication_surface, 1)
    assert.equal(projection.omissions.countsByReason.authentication_source_reference, 2)
    assert.equal(projection.privacyOmissions[0].sourceRef.id, 'redacted')
    assert.ok(!JSON.stringify(projection).includes('SYNTHETIC PRIVATE'))
    assert.equal(projection.policy.privacy.bodyKeywordScanning, false)
  })

  it('preserves privacy omissions discovered only in the current preview and excludes linked projections', () => {
    const privateRef = { kind: 'context', id: 'preview-only' }
    const linked = change('work_item', 'linked-preview', {
      lifecycle: 'open',
      title: 'SYNTHETIC PRIVATE PREVIEW DERIVATIVE',
      sourceRef: privateRef,
    })
    const original = batch([linked])
    original.snapshot.privacyOmissions = [
      { sourceRef: privateRef, reason: 'authentication_surface', detection: 'preview_metadata' },
    ]
    const projection = createDeliveryContent(original)
    assert.deepEqual(projection.workItems, [])
    assert.equal(projection.scope.sourceRecordCount, 1)
    assert.equal(projection.scope.privacyOmittedSourceRecordCount, 1)
    assert.equal(projection.scope.privacyOmittedPreviewReferenceCount, 1)
    assert.equal(projection.privacyOmissions.length, 2)
    assert.ok(!JSON.stringify(projection).includes('SYNTHETIC PRIVATE'))
  })

  it('marks older context and focus backfill without promoting late arrival over newer retained activity', () => {
    const newer = change('context', 'newer', {
      timestamp: dayStart + 5_000,
      window_title: 'Newer work',
      text: 'Newer.',
    })
    const older = change(
      'context',
      'older-backfill',
      {
        timestamp: dayStart + 1_000,
        window_title: 'Earlier work',
        text: 'Complete older context.\n'.repeat(1_000),
      },
      { readAt: dayStart + 50_000 }
    )
    const olderFocus = change(
      'focus',
      'older-focus',
      { started_at: dayStart + 2_000, ended_at: dayStart + 3_000 },
      { readAt: dayStart + 51_000 }
    )
    const original = batch([older, olderFocus], [older, olderFocus, newer])
    original.baseline = false
    original.sequence = 4
    const projection = createDeliveryContent(original)
    assert.equal(projection.activityMerge.knownActivityWatermark?.sourceRef.id, 'newer')
    assert.equal(projection.activityMerge.knownActivityWatermark?.eventAt, dayStart + 5_000)
    assert.equal(projection.activityMerge.deliverySequenceIsActivityTime, false)
    assert.equal(projection.activityMerge.readAtIsActivityTime, false)
    assert.equal(projection.activities[0].chronology.relationToKnown, 'older-than-known')
    assert.equal(projection.activities[0].chronology.canAdvanceObservedFocus, false)
    assert.equal(projection.activities[0].text, older.record?.text)
    assert.equal(projection.focusChanges[0].chronology.timeField, 'started_at')
    assert.equal(projection.focusChanges[0].chronology.canAdvanceObservedFocus, false)
  })

  it('never substitutes read or arrival time for a missing activity timestamp', () => {
    const known = change('context', 'known', {
      timestamp: dayStart,
      window_title: 'Same',
      text: 'Known activity time.',
    })
    const unknown = change(
      'context',
      'unknown',
      { window_title: 'Same', text: 'Unknown time.' },
      { readAt: dayStart + 100_000 }
    )
    const unknownWindow = change('context', 'other-unknown', { window_title: 'Other', text: 'Full undated context.' })
    const unknownFocus = change('focus', 'unknown-focus', { ended_at: dayStart + 50_000 })
    const projection = createDeliveryContent(batch([known, unknown, unknownWindow, unknownFocus]))
    assert.deepEqual(
      projection.activities.map((source) => source.sourceRef.id),
      ['known', 'other-unknown', 'unknown']
    )
    assert.equal(projection.activities[1].chronology.eventAt, null)
    assert.equal(projection.activities[1].chronology.relationToKnown, 'unknown')
    assert.equal(projection.activities[1].chronology.canAdvanceObservedFocus, false)
    assert.deepEqual(
      projection.contextChains
        .flatMap((chain) => chain.unknownTimestampSourceRefs)
        .map((source) => source.id)
        .sort(),
      ['other-unknown', 'unknown']
    )
    assert.equal(projection.focusChanges[0].chronology.eventAt, null)
    assert.equal(projection.focusChanges[0].chronology.canAdvanceObservedFocus, false)
  })

  it('uses a later source read for corrections without turning its old event time into fresh activity', () => {
    const originalSource = change('context', 'corrected', { timestamp: dayStart + 8_000, text: 'Earlier version.' })
    const corrected = change(
      'context',
      'corrected',
      { timestamp: dayStart + 1_000, text: 'Corrected old observation.' },
      { readAt: originalSource.readAt + 1 }
    )
    const newer = change('focus', 'newer-focus', { started_at: dayStart + 7_000 })
    const original = batch([corrected], [originalSource, newer])
    original.baseline = false
    const projection = createDeliveryContent(original)
    assert.equal(projection.activities[0].text, corrected.record?.text)
    assert.equal(projection.activities[0].chronology.relationToKnown, 'older-than-known')
    assert.equal(projection.activityMerge.knownActivityWatermark?.sourceRef.id, 'newer-focus')
  })
})

describe('Remember meaningful delivery gate', () => {
  it('suppresses identical parsed day memory despite refresh, coverage, provenance and formatting changes', () => {
    const previous = day()
    const memory = JSON.parse(String(previous.record?.memory_json))
    const current = change(
      'day',
      'today',
      {
        ...previous.record,
        updated_at: dayStart + 20_000,
        memory_covered_through: dayStart + 18_000,
        memory_refreshed_at: dayStart + 19_000,
        refresh_status: 'idle',
        refresh_target_through: dayStart + 20_000,
        memory_json: JSON.stringify(Object.fromEntries(Object.entries(memory).reverse()), null, 2),
      },
      {
        readAt: dayStart + 21_000,
        changeObservedAt: dayStart + 20_000,
        archiveVersionHash: 'new-archive',
        readContentHash: 'new-read-hash',
      }
    )
    assert.equal(meaningfulChanges([previous], [current]), false)
    for (const field of ['summary', 'currentFocus', 'outcomes', 'decisions', 'openLoops']) {
      const changedMemory = {
        ...memory,
        [field]: field === 'summary' || field === 'currentFocus' ? 'A changed meaning.' : ['Changed'],
      }
      assert.equal(
        meaningfulChanges(
          [previous],
          [{ ...current, record: { ...current.record, memory_json: JSON.stringify(changedMemory) } }]
        ),
        true,
        field
      )
    }
  })

  it('preserves source details, work closures, corrections, due dates and blocker dismissals', () => {
    const previous = change('work_item', 'work', {
      title: 'Task',
      lifecycle: 'open',
      status: 'todo',
      due_at: 100,
      updated_at: 10,
    })
    assert.equal(
      meaningfulChanges(
        [previous],
        [{ ...previous, record: { ...previous.record, updated_at: 20, day_synced_at: 30 } }]
      ),
      false
    )
    for (const patch of [
      { lifecycle: 'completed' },
      { status: 'in_progress' },
      { title: 'Corrected task' },
      { due_at: 200 },
    ]) {
      assert.equal(meaningfulChanges([previous], [{ ...previous, record: { ...previous.record, ...patch } }]), true)
    }
    assert.equal(
      meaningfulChanges([previous], [{ ...previous, sourceDetails: { facts: [{ text: 'New supporting evidence' }] } }]),
      true
    )
    const blocked = change('work_item_observation', 'blocked', {
      kind: 'blocked',
      work_item_id: 'work',
      dismissed_at: null,
    })
    assert.equal(meaningfulChanges([blocked], [{ ...blocked, record: { ...blocked.record, dismissed_at: 200 } }]), true)
  })

  it('keeps genuine raw observations meaningful even with identical text while ignoring read provenance', () => {
    const previous = change('context', 'context', { text: 'Same text.', timestamp: 100, content_hash: 'old' })
    assert.equal(
      meaningfulChanges(
        [previous],
        [
          {
            ...previous,
            readAt: previous.readAt + 1,
            readContentHash: 'different',
            record: { ...previous.record, content_hash: 'new' },
          },
        ]
      ),
      false
    )
    assert.equal(
      meaningfulChanges([previous], [{ ...previous, sourceRef: { kind: 'context', id: 'new-observation' } }]),
      true
    )
    assert.equal(meaningfulChanges([previous], [{ ...previous, record: { ...previous.record, timestamp: 200 } }]), true)
    const focus = change('focus', 'focus', { started_at: 100, ended_at: null })
    assert.equal(meaningfulChanges([focus], [{ ...focus, record: { ...focus.record, ended_at: 200 } }]), true)
  })

  it('retains availability, privacy and eligibility changes and conservatively treats unknown content as meaningful', () => {
    const previous = change('context', 'context', { text: 'Ordinary work', window_title: 'Project', timestamp: 100 })
    assert.equal(
      meaningfulChanges([previous], [{ ...previous, operation: 'deleted', availability: 'not_found', record: null }]),
      true
    )
    assert.equal(meaningfulChanges([previous], [{ ...previous, availability: 'not_found', record: null }]), true)
    assert.equal(meaningfulChanges([previous], [{ ...previous, origin: 'relay', eligibleForWorkUpdate: false }]), true)
    assert.equal(
      meaningfulChanges([previous], [{ ...previous, record: { ...previous.record, window_title: 'Login' } }]),
      true
    )
    assert.equal(meaningfulChanges([], [change('future_source', 'new', { unknown_domain_field: 'Value' })]), true)
    assert.equal(
      meaningfulChanges(
        [],
        [change('context', 'echo', { text: 'Protocol' }, { origin: 'relay', eligibleForWorkUpdate: false })]
      ),
      false
    )
  })

  it('ignores capture heartbeat and agent polling metadata but keeps actual health and pause changes', () => {
    const before = batch([]).snapshot
    const heartbeat = {
      ...before,
      observedAt: dayStart + 50_000,
      capture: {
        ...(before.capture as Record<string, unknown>),
        observedAt: dayStart + 50_000,
        context: { health: 'healthy', status: 'available', lastEventAt: dayStart + 49_000 },
      },
      processing: { live: { pendingCount: 99, refreshStatus: 'refreshing' } },
    }
    const previousCapture = before.capture as Record<string, unknown>
    heartbeat.capture.context = {
      ...(previousCapture.context as { health: string; status: string; lastEventAt: number }),
      lastEventAt: dayStart + 49_000,
    }
    assert.equal(meaningfulChanges([], [], heartbeat), false)
    assert.equal(
      meaningfulChanges([], [], {
        ...heartbeat,
        capture: { ...heartbeat.capture, status: 'paused', pausedUntil: dayStart + 100_000 },
      }),
      true
    )
    assert.equal(
      meaningfulChanges([], [], { ...heartbeat, capture: { ...heartbeat.capture, error: 'Capture unavailable' } }),
      true
    )
    const previous = change('agent_source', 'agent', {
      provider: 'codex',
      path: '/synthetic/path',
      checked_at: 100,
      cursor_json: '{}',
      malformed_records: 0,
    })
    assert.equal(
      meaningfulChanges(
        [previous],
        [
          {
            ...previous,
            record: { ...previous.record, checked_at: 200, selected_at: 300, cursor_json: '{"offset":2}' },
          },
        ]
      ),
      false
    )
    assert.equal(
      meaningfulChanges([previous], [{ ...previous, record: { ...previous.record, malformed_records: 1 } }]),
      true
    )
  })

  it('always emits a baseline and treats malformed day-memory changes conservatively', () => {
    const original = batch([])
    assert.equal(
      hasMeaningfulRelayChanges({
        previousState: original.state,
        nextState: original.state,
        previousSnapshot: original.snapshot,
        input: {
          cursorBefore: null,
          cursorAfter: 'baseline',
          changes: [],
          snapshot: original.snapshot,
          synthetic: true,
          baseline: true,
        },
      }),
      true
    )
    const previous = change('day', 'bad', { memory_json: 'invalid earlier' })
    assert.equal(meaningfulChanges([previous], [{ ...previous, record: { memory_json: 'invalid changed' } }]), true)
  })

  it('emits changed privacy lineage for an unchanged previously delivered derived source', () => {
    const privateRef = { kind: 'context', id: 'new-auth' }
    const held = change('work_item', 'held', { lifecycle: 'open', title: 'Held source', sources: [privateRef] })
    const auth = change(
      'context',
      'new-auth',
      { contentOmitted: true, omissionReason: 'authentication_surface' },
      { eligibleForWorkUpdate: false }
    )
    assert.equal(meaningfulChanges([held], [auth]), true)
    const previous = batch([held])
    const privacySnapshot = {
      ...previous.snapshot,
      privacyOmissions: [{ sourceRef: privateRef, reason: 'authentication_surface', detection: 'preview_metadata' }],
    }
    assert.equal(
      hasMeaningfulRelayChanges({
        previousState: previous.state,
        nextState: previous.state,
        previousSnapshot: previous.snapshot,
        input: {
          cursorBefore: 'old',
          cursorAfter: 'next',
          changes: [],
          snapshot: privacySnapshot,
          synthetic: true,
          baseline: false,
        },
      }),
      true
    )
    assert.equal(
      hasMeaningfulRelayChanges({
        previousState: previous.state,
        nextState: previous.state,
        previousSnapshot: privacySnapshot,
        input: {
          cursorBefore: 'old',
          cursorAfter: 'next',
          changes: [],
          snapshot: privacySnapshot,
          synthetic: true,
          baseline: false,
        },
      }),
      false
    )
  })

  it('retains day identity and start-time corrections as meaningful chronology', () => {
    const previous = day()
    assert.equal(
      meaningfulChanges([previous], [{ ...previous, record: { ...previous.record, local_day: '2026-10-15' } }]),
      true
    )
    assert.equal(
      meaningfulChanges([previous], [{ ...previous, record: { ...previous.record, started_at: dayStart - 1_000 } }]),
      true
    )
  })

  it('normalizes only known nested source-read provenance and preserves changed agent evidence', () => {
    const event = change('agent_event', 'event', { content: 'Same event', observed_at: 100, content_hash: 'old' })
    const span = change(
      'agent_span',
      'span',
      { event_id: 'event', started_at: 100 },
      { sourceDetails: { agentEvent: event } }
    )
    const reread = {
      ...span,
      sourceDetails: {
        agentEvent: {
          ...event,
          readAt: event.readAt + 1,
          readContentHash: 'new-hash',
          record: { ...event.record, content_hash: 'new' },
        },
      },
    }
    assert.equal(meaningfulChanges([span], [reread]), false)
    assert.equal(
      meaningfulChanges(
        [span],
        [
          {
            ...reread,
            sourceDetails: {
              agentEvent: { ...event, record: { ...event.record, content: 'Corrected agent evidence' } },
            },
          },
        ]
      ),
      true
    )
  })

  it('retains durable derived-source privacy exclusions after direct authentication evidence is absent', () => {
    const held = change('work_item', 'held-private', { lifecycle: 'open', title: 'Private derived item' })
    const original = batch([held])
    original.snapshot.privacyOmissions = [
      { sourceRef: held.sourceRef, reason: 'authentication_source_reference', detection: 'source_reference' },
    ]
    const projection = createDeliveryContent(original)
    assert.deepEqual(projection.workItems, [])
    assert.deepEqual(projection.privacyOmissions, original.snapshot.privacyOmissions)
  })

  it('withdraws prior private content and claims through an otherwise empty correction delta without claiming deletion', () => {
    const privateRef = { kind: 'context', id: 'recovered-auth' }
    const held = change('work_item', 'held-derived', {
      lifecycle: 'open',
      title: 'Previously retained derived item',
      sources: [privateRef],
    })
    const correction = batch([], [held])
    correction.baseline = false
    correction.sequence = 2
    correction.snapshot.privacyOmissions = [
      { sourceRef: privateRef, reason: 'authentication_surface', detection: 'preview_metadata' },
    ]
    const projection = createDeliveryContent(correction)
    assert.equal(projection.mode, 'delta')
    assert.equal(projection.scope.batchChangeRecordCount, 0)
    assert.deepEqual(projection.removals, [])
    assert.deepEqual(projection.workItems, [])
    assert.equal(projection.omissionIsDeletion, false)
    assert.deepEqual(projection.privacyOmissions, [
      { sourceRef: privateRef, reason: 'authentication_surface', detection: 'preview_metadata' },
      { sourceRef: held.sourceRef, reason: 'authentication_source_reference', detection: 'source_reference' },
    ])
    assert.deepEqual(projection.policy.privacy.recipientMerge, {
      action: 'withdraw-retained-content-and-claims',
      identities: 'every-privacyOmissions-sourceRef',
      includesDerivedExclusions: true,
      appliesWithoutSourceChanges: true,
      beforeOrdinaryDeltaMerge: true,
      sourceDeletionClaimed: false,
    })
  })
})
