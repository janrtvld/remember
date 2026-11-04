import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, it } from 'node:test'
import { createDeliveryContent, hasMeaningfulRelayChanges } from '../continuityRelayDelivery'
import {
  createRelayStore,
  hashDeliveryPayload,
  type Lease,
  type RelayBatch,
  type RelayChange,
  type RelayDelivery,
  type RelayEmissionContext,
  serializeDeliveryFile,
} from '../continuityRelayStore'

const directories: string[] = []
const stores: ReturnType<typeof createRelayStore>[] = []
const profileId = 'synthetic-remember-profile'
const consumerId = 'synthetic-parent'

function fixture(shouldEmitBatch?: (context: RelayEmissionContext) => boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'remember-relay-store-'))
  directories.push(directory)
  const path = join(directory, 'relay.sqlite')
  const clock = { at: 10_000 }
  const open = () => {
    const store = createRelayStore({ path, profileId, consumerId, now: () => clock.at, shouldEmitBatch })
    stores.push(store)
    return store
  }
  return { path, clock, open, store: open() }
}

function claim(store: ReturnType<typeof createRelayStore>, owner = 'synthetic-worker', ttlMs = 60_000) {
  const lease = store.claimLease(owner, ttlMs)
  assert.ok(lease)
  return lease
}

function change(id: string, record: Record<string, unknown>, overrides: Partial<RelayChange> = {}): RelayChange {
  return {
    sourceRef: { kind: 'work_item', id },
    operation: 'updated',
    availability: 'available',
    record,
    readAt: 9_999,
    changeObservedAt: 9_998,
    readContentHash: createHash('sha256').update(JSON.stringify(record)).digest('hex'),
    historicalVersionGuaranteed: false,
    origin: 'source',
    eligibleForWorkUpdate: true,
    ...overrides,
  }
}

function enqueue(
  store: ReturnType<typeof createRelayStore>,
  lease: Lease,
  cursorBefore: string | null,
  cursorAfter: string,
  changes: RelayChange[],
  baseline = false
) {
  return store.enqueue(lease, {
    cursorBefore,
    cursorAfter,
    changes,
    synthetic: true,
    baseline,
    snapshot: {
      capture: { availability: 'unknown', reason: 'Synthetic fixture has no live capture' },
      latestEvidenceAt: 9_998,
      memoryCoveredThrough: 8_000,
    },
  })
}

function ack(batch: RelayBatch | RelayDelivery) {
  return { batchId: batch.batchId, sequence: batch.sequence, payloadHash: batch.payloadHash, consumerId }
}

function acknowledgePages(store: ReturnType<typeof createRelayStore>, delivery: RelayDelivery) {
  for (const page of store.prepareDeliveryPages(delivery)) {
    store.acknowledgeDeliveryPage({ ...ack(delivery), pageIndex: page.pageIndex, pageHash: page.pageHash })
  }
}

function fileAck(delivery: RelayDelivery) {
  const contents = serializeDeliveryFile(delivery)
  return {
    ...ack(delivery),
    fileSha256: createHash('sha256').update(contents, 'utf8').digest('hex'),
    fileSizeBytes: Buffer.byteLength(contents, 'utf8'),
  }
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('durable Remember relay store with synthetic evidence', () => {
  it('atomically captures a baseline while keeping source progress separate from delivery ACK', () => {
    const { store } = fixture()
    const lease = claim(store)
    const batch = enqueue(
      store,
      lease,
      null,
      'cursor-1',
      [change('item-1', { lifecycle: 'open', title: 'Fixture work' })],
      true
    )
    assert.ok(batch)
    assert.equal(batch.baseline, true)
    assert.equal(batch.synthetic, true)
    assert.deepEqual(batch.retractions, [])
    assert.equal(batch.sequence, 1)
    assert.equal(batch.state.open.length, 1)
    assert.deepEqual(batch.snapshot.capture, {
      availability: 'unknown',
      reason: 'Synthetic fixture has no live capture',
    })
    const saved = store.getStatus()
    assert.equal(saved.cursor, 'cursor-1')
    assert.equal(saved.pendingCount, 1)
    assert.equal(saved.appliedSequence, 0)
    assert.equal(saved.appliedState.open.length, 0)
    assert.deepEqual(store.offer(lease), batch)
    assert.equal(store.getStatus().appliedSequence, 0)
    store.acknowledge(ack(batch))
    assert.equal(store.getStatus().appliedSequence, 1)
    assert.equal(store.getStatus().appliedState.open.length, 1)
    assert.equal(store.getStatus().pendingCount, 0)
  })

  it('delivers two ordered updates and replaces completed work instead of retaining an old open item', () => {
    const { store } = fixture()
    const lease = claim(store)
    const first = enqueue(store, lease, null, 'cursor-1', [change('item-1', { lifecycle: 'open' })])
    const second = enqueue(store, lease, 'cursor-1', 'cursor-2', [
      change('item-1', { lifecycle: 'completed', title: 'Corrected title', status: 'idle' }),
    ])
    assert.ok(first)
    assert.ok(second)
    assert.equal(store.getStatus().projection.open.length, 0)
    assert.equal(store.getStatus().projection.completed.length, 1)
    assert.equal(store.offer(lease)?.batchId, first.batchId)
    store.acknowledge(ack(first))
    assert.equal(store.getStatus().appliedState.open.length, 1)
    assert.equal(store.offer(lease)?.batchId, second.batchId)
    store.acknowledge(ack(second))
    assert.equal(store.getStatus().appliedState.open.length, 0)
    assert.equal(store.getStatus().appliedState.completed[0].record?.title, 'Corrected title')
    assert.equal(store.getStatus().appliedSequence, 2)
  })

  it('replays exact persisted bytes after reopening and waits for retry without skipping the oldest batch', () => {
    const { store, clock, open } = fixture()
    const lease = claim(store)
    const batch = enqueue(store, lease, null, 'cursor-1', [change('item-1', { lifecycle: 'open' })])
    assert.ok(batch)
    enqueue(store, lease, 'cursor-1', 'cursor-2', [change('item-2', { lifecycle: 'open' })])
    const firstDelivery = store.offer(lease)
    assert.equal(JSON.stringify(firstDelivery), JSON.stringify(batch))
    assert.equal(store.offer(lease), null)
    assert.equal(store.getStatus().nextRetryAt, 11_000)
    store.releaseLease(lease)
    store.close()
    const reopened = open()
    const nextLease = claim(reopened, 'replacement-worker')
    assert.equal(reopened.offer(nextLease), null)
    clock.at = 11_000
    assert.equal(JSON.stringify(reopened.offer(nextLease)), JSON.stringify(firstDelivery))
    assert.equal(reopened.getStatus().nextRetryAt, 13_000)
    reopened.acknowledge(ack(batch))
    assert.equal(reopened.offer(nextLease)?.sequence, 2)
  })

  it('reads every pending batch in source order without changing retries, attempts or source progress', () => {
    const { store, path, open } = fixture()
    const lease = claim(store)
    const first = enqueue(store, lease, null, 'cursor-1', [change('item-1', { lifecycle: 'open' })])
    const second = enqueue(store, lease, 'cursor-1', 'cursor-2', [change('item-1', { lifecycle: 'completed' })])
    const third = enqueue(store, lease, 'cursor-2', 'cursor-3', [change('item-2', { lifecycle: 'open' })])
    assert.ok(first)
    assert.ok(second)
    assert.ok(third)
    store.offer(lease)
    const database = new DatabaseSync(path)
    const retryRows = () =>
      database.prepare('SELECT sequence, attempts, next_retry_at FROM relay_batch ORDER BY sequence').all()
    const before = retryRows()
    const status = store.getStatus()
    assert.deepEqual(store.pendingBatches(), [first, second, third])
    assert.deepEqual(retryRows(), before)
    assert.deepEqual(store.getStatus(), status)
    store.releaseLease(lease)
    store.close()
    const restarted = open()
    assert.deepEqual(restarted.pendingBatches(), [first, second, third])
    const deliveries = restarted
      .pendingBatches()
      .map((batch) => restarted.prepareDelivery(batch, { sourceCursorAfter: batch.sourceCursorAfter }))
    for (const delivery of deliveries) restarted.acknowledgeDeliveryFile(fileAck(delivery))
    assert.throws(() => restarted.acknowledgeDelivery(ack(deliveries[1])), /ack-out-of-order/)
    restarted.acknowledgeDelivery(ack(deliveries[0]))
    const remaining = restarted.pendingBatches()
    assert.deepEqual(remaining, [second, third])
    remaining[0].sourceCursorAfter = 'Caller mutation'
    assert.equal(restarted.pendingBatches()[0].sourceCursorAfter, 'cursor-2')
    restarted.acknowledgeDelivery(ack(deliveries[1]))
    restarted.acknowledgeDelivery(ack(deliveries[2]))
    assert.deepEqual(restarted.pendingBatches(), [])
    assert.equal(restarted.getStatus().appliedSequence, 3)
    assert.equal(restarted.getStatus().cursor, 'cursor-3')
    database.close()
  })

  it('fails a pending-batch read if a later persisted payload is corrupt instead of returning a partial backlog', () => {
    const { store, path } = fixture()
    const lease = claim(store)
    enqueue(store, lease, null, 'cursor-1', [change('item-1', { lifecycle: 'open' })])
    const second = enqueue(store, lease, 'cursor-1', 'cursor-2', [change('item-1', { lifecycle: 'completed' })])
    assert.ok(second)
    const database = new DatabaseSync(path)
    database
      .prepare('UPDATE relay_batch SET payload_json = ? WHERE sequence = 2')
      .run(JSON.stringify({ ...second, sourceCursorAfter: 'Tampered cursor' }))
    database.close()
    assert.throws(() => store.pendingBatches(), /persisted-batch-integrity-failed/)
    assert.equal(store.getStatus().pendingCount, 2)
    assert.equal(store.getStatus().appliedSequence, 0)
  })

  it('archives suppressed metadata and compares later changes with latest ingested state across restart without ACKing pending content', () => {
    const comparisons: RelayEmissionContext[] = []
    const { store, path, open } = fixture((context) => {
      comparisons.push(context)
      return context.input.changes.some(
        (source) =>
          source.record?.text !==
          context.previousState.sources[`${source.sourceRef.kind}:${source.sourceRef.id}`]?.record?.text
      )
    })
    const lease = claim(store)
    const sourceRef = { kind: 'context', id: 'context-1' }
    const initial = change(sourceRef.id, { text: 'Observed work', updatedAt: 1 }, { sourceRef })
    const first = enqueue(store, lease, null, 'cursor-1', [initial], true)
    assert.ok(first)
    const delivery = store.prepareDelivery(first, { text: 'Frozen initial content' })
    const metadata = change(
      sourceRef.id,
      { text: 'Observed work', updatedAt: 2 },
      { sourceRef, sourceDetails: { observedFacts: ['Unchanged fact'], fetchedAt: 2 } }
    )
    assert.equal(
      store.enqueue(lease, {
        cursorBefore: 'cursor-1',
        cursorAfter: 'cursor-2',
        snapshot: { observedAt: 2 },
        changes: [metadata],
        synthetic: true,
      }),
      null
    )
    const skipped = store.getStatus()
    assert.equal(skipped.cursor, 'cursor-2')
    assert.equal(skipped.sequence, 1)
    assert.equal(skipped.appliedSequence, 0)
    assert.equal(skipped.pendingCount, 1)
    assert.equal(skipped.appliedDelivery, null)
    assert.deepEqual(skipped.snapshot, { observedAt: 2 })
    const archived = skipped.projection.sources['context:context-1']
    assert.ok(archived.archiveVersionHash)
    const version = store.readArchive({ sourceRef, versionHash: archived.archiveVersionHash })
    assert.deepEqual(version.source?.record, metadata.record)
    assert.deepEqual(version.source?.sourceDetails, metadata.sourceDetails)
    assert.deepEqual(store.pendingBatches(), [first])
    assert.deepEqual(store.prepareDelivery(first, { changedProjector: true }), delivery)
    store.releaseLease(lease)
    store.close()
    const restarted = open()
    const nextLease = claim(restarted)
    assert.equal(
      enqueue(restarted, nextLease, 'cursor-2', 'cursor-3', [
        change(sourceRef.id, { text: 'Observed work', updatedAt: 3 }, { sourceRef }),
      ]),
      null
    )
    assert.equal(comparisons[1].previousState.sources['context:context-1'].record?.updatedAt, 2)
    assert.deepEqual(comparisons[1].previousSnapshot, { observedAt: 2 })
    const changed = enqueue(restarted, nextLease, 'cursor-3', 'cursor-4', [
      change(sourceRef.id, { text: 'Changed summary', updatedAt: 4 }, { sourceRef }),
    ])
    assert.ok(changed)
    assert.equal(changed.sequence, 2)
    assert.equal(changed.sourceCursorBefore, 'cursor-3')
    assert.equal(comparisons[2].previousState.sources['context:context-1'].record?.updatedAt, 3)
    assert.deepEqual(restarted.pendingBatches(), [first, changed])
    assert.equal(restarted.getStatus().appliedSequence, 0)
    const database = new DatabaseSync(path)
    for (const table of [
      'relay_receipt',
      'relay_delivery_receipt',
      'relay_delivery_file_receipt',
      'relay_delivery_page_receipt',
    ]) {
      assert.equal(database.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count, 0)
    }
    database.close()
  })

  it('always delivers baselines, lifecycle transitions, removals, restored sources and retractions despite suppression', () => {
    const { store } = fixture(() => false)
    const lease = claim(store)
    const context = change(
      'context-1',
      { text: 'Observed context' },
      { sourceRef: { kind: 'context', id: 'context-1' } }
    )
    const first = enqueue(store, lease, null, 'cursor-1', [change('work-1', { lifecycle: 'open' }), context], true)
    assert.ok(first)
    assert.equal(
      enqueue(store, lease, 'cursor-1', 'cursor-2', [change('work-1', { lifecycle: 'open', updatedAt: 2 })]),
      null
    )
    assert.ok(enqueue(store, lease, 'cursor-2', 'cursor-3', [change('work-1', { lifecycle: 'completed' })]))
    assert.ok(
      enqueue(store, lease, 'cursor-3', 'cursor-4', [
        { ...context, operation: 'deleted', record: null, readContentHash: null },
      ])
    )
    assert.ok(enqueue(store, lease, 'cursor-4', 'cursor-5', [context]))
    assert.ok(
      enqueue(store, lease, 'cursor-5', 'cursor-6', [
        { ...context, availability: 'not_found', record: null, readContentHash: null },
      ])
    )
    assert.ok(enqueue(store, lease, 'cursor-6', 'cursor-7', [context]))
    const retraction = enqueue(store, lease, 'cursor-7', 'cursor-8', [{ ...context, eligibleForWorkUpdate: false }])
    assert.deepEqual(retraction?.retractions, [{ sourceRef: context.sourceRef, reason: 'ineligible' }])
    assert.equal(store.getStatus().sequence, 7)
    assert.equal(store.getStatus().appliedSequence, 0)
  })

  it('rolls back archives and ingestion when the semantic policy throws or returns a nonboolean decision', () => {
    let failure: 'throw' | 'invalid' = 'throw'
    const { store, path } = fixture(() => {
      if (failure === 'throw') throw new Error('synthetic-policy-failure')
      return 'invalid' as unknown as boolean
    })
    const lease = claim(store)
    const sourceRef = { kind: 'context', id: 'context-1' }
    enqueue(store, lease, null, 'cursor-1', [change(sourceRef.id, { text: 'Original' }, { sourceRef })], true)
    const before = store.getStatus()
    const database = new DatabaseSync(path)
    const versionCount = database.prepare('SELECT count(*) AS count FROM relay_source_version').get()?.count
    const ingest = () =>
      enqueue(store, lease, 'cursor-1', 'cursor-2', [
        change(sourceRef.id, { text: 'New uncommitted version' }, { sourceRef }),
      ])
    assert.throws(ingest, /synthetic-policy-failure/)
    failure = 'invalid'
    assert.throws(ingest, /invalid-emission-decision/)
    assert.deepEqual(store.getStatus(), before)
    assert.equal(database.prepare('SELECT count(*) AS count FROM relay_source_version').get()?.count, versionCount)
    database.close()
  })

  it('lets a semantic policy compare health snapshots on empty pages and isolates its inputs from stored payloads', () => {
    const { store } = fixture((context) => {
      const changed = context.previousSnapshot.health !== context.input.snapshot.health
      context.input.snapshot.health = 'Policy mutated copy'
      context.input.cursorAfter = 'Policy mutated cursor'
      context.nextState.sources = {}
      return changed
    })
    const lease = claim(store)
    const first = store.enqueue(lease, {
      cursorBefore: null,
      cursorAfter: 'cursor-1',
      snapshot: { health: 'running', heartbeatAt: 1 },
      changes: [],
      synthetic: true,
      baseline: true,
    })
    assert.ok(first)
    assert.equal(
      store.enqueue(lease, {
        cursorBefore: 'cursor-1',
        cursorAfter: 'cursor-2',
        snapshot: { health: 'running', heartbeatAt: 2 },
        changes: [],
        synthetic: true,
      }),
      null
    )
    const changed = store.enqueue(lease, {
      cursorBefore: 'cursor-2',
      cursorAfter: 'cursor-3',
      snapshot: { health: 'failed', heartbeatAt: 3 },
      changes: [],
      synthetic: true,
    })
    assert.ok(changed)
    assert.deepEqual(changed.snapshot, { health: 'failed', heartbeatAt: 3 })
    assert.equal(changed.sourceCursorAfter, 'cursor-3')
    assert.equal(store.getStatus().cursor, 'cursor-3')
    assert.equal(store.getStatus().appliedSequence, 0)
  })

  it('retains only safe privacy identities across suppressed pages and restart without automatically clearing them', () => {
    const { store, open } = fixture(() => false)
    const lease = claim(store)
    const previewRef = { kind: 'context', id: 'private-preview' }
    const markerRef = { kind: 'context', id: 'private-marker' }
    store.enqueue(lease, {
      cursorBefore: null,
      cursorAfter: 'cursor-1',
      synthetic: true,
      baseline: true,
      changes: [],
      snapshot: {
        privacyOmissions: [
          {
            sourceRef: { ...previewRef, body: 'DO NOT RETAIN EXTRA REF FIELD' },
            reason: 'authentication_surface',
            detection: 'preview_metadata',
            text: 'DO NOT RETAIN EXTRA BODY',
          },
          {
            sourceRef: { kind: 'context', id: 'invalid' },
            reason: 'unrecognized_reason',
            detection: 'preview_metadata',
          },
        ],
      },
    })
    const marker = {
      ...change(
        markerRef.id,
        { contentOmitted: true, omissionReason: 'authentication_surface' },
        { sourceRef: markerRef, eligibleForWorkUpdate: false }
      ),
      redaction: {
        reason: 'authentication_surface',
        detection: 'source_metadata',
        omittedFields: ['DO NOT RETAIN EXTRA MARKER FIELD'],
      },
    }
    assert.equal(
      store.enqueue(lease, {
        cursorBefore: 'cursor-1',
        cursorAfter: 'cursor-2',
        snapshot: {},
        changes: [marker],
        synthetic: true,
      }),
      null
    )
    const expected = [
      { sourceRef: markerRef, reason: 'authentication_surface', detection: 'source_metadata' },
      { sourceRef: previewRef, reason: 'authentication_surface', detection: 'preview_metadata' },
    ]
    assert.deepEqual(store.getStatus().snapshot.privacyOmissions, expected)
    assert.equal(JSON.stringify(store.getStatus().snapshot).includes('DO NOT RETAIN'), false)
    assert.equal(store.getStatus().sequence, 1)
    assert.equal(store.getStatus().appliedSequence, 0)
    store.releaseLease(lease)
    store.close()
    const restarted = open()
    assert.equal(
      restarted.enqueue(claim(restarted), {
        cursorBefore: 'cursor-2',
        cursorAfter: 'cursor-3',
        snapshot: { privacyOmissions: [] },
        changes: [],
        synthetic: true,
      }),
      null
    )
    assert.deepEqual(restarted.getStatus().snapshot.privacyOmissions, expected)
    assert.equal(restarted.getStatus().cursor, 'cursor-3')
  })

  it('keeps unchanged derived private blockers excluded after an unrelated page, restart and a harmless same-ID read', () => {
    const { store, open } = fixture(hasMeaningfulRelayChanges)
    const lease = claim(store)
    const privateRef = { kind: 'context', id: 'authentication-context' }
    const derived = change(
      'derived-work',
      { lifecycle: 'open', title: 'SYNTHETIC PRIVATE DERIVED TITLE' },
      { sourceDetails: { sources: [{ sourceRef: privateRef }] } }
    )
    const blocker = change(
      'derived-blocker',
      {
        work_item_id: 'derived-work',
        kind: 'blocked',
        detail: 'SYNTHETIC PRIVATE BLOCKER',
        sourceRef: derived.sourceRef,
      },
      { sourceRef: { kind: 'work_item_observation', id: 'derived-blocker' } }
    )
    const baseline = enqueue(store, lease, null, 'cursor-1', [derived, blocker], true)
    assert.ok(baseline)
    const redacted = change(
      privateRef.id,
      { contentOmitted: true, omissionReason: 'authentication_surface' },
      { sourceRef: privateRef, eligibleForWorkUpdate: false }
    )
    const correction = enqueue(store, lease, 'cursor-1', 'cursor-2', [redacted])
    assert.ok(correction)
    assert.equal(store.getStatus().projection.sources['context:authentication-context'], undefined)
    function assertExcluded(batch: RelayBatch) {
      const content = createDeliveryContent(batch)
      assert.equal(JSON.stringify(content).includes('SYNTHETIC PRIVATE'), false)
      assert.deepEqual(content.blockers.active, [])
      for (const sourceRef of [privateRef, derived.sourceRef, blocker.sourceRef]) {
        assert.ok(
          content.privacyOmissions.some(
            (entry) => entry.sourceRef.kind === sourceRef.kind && entry.sourceRef.id === sourceRef.id
          )
        )
      }
    }
    assertExcluded(correction)
    const unrelated = enqueue(store, lease, 'cursor-2', 'cursor-3', [
      change(
        'ordinary-context',
        { text: 'Ordinary project activity', timestamp: 12_000 },
        { sourceRef: { kind: 'context', id: 'ordinary-context' } }
      ),
    ])
    assert.ok(unrelated)
    assertExcluded(unrelated)
    assert.deepEqual(unrelated.snapshot.privacyOmissions, correction.snapshot.privacyOmissions)
    store.releaseLease(lease)
    store.close()
    const restarted = open()
    const sameIdentity = enqueue(restarted, claim(restarted), 'cursor-3', 'cursor-4', [
      change(privateRef.id, { text: 'Later harmless source revision', timestamp: 13_000 }, { sourceRef: privateRef }),
    ])
    assert.ok(sameIdentity)
    assertExcluded(sameIdentity)
    assert.equal(JSON.stringify(createDeliveryContent(sameIdentity)).includes('Later harmless source revision'), false)
    assert.deepEqual(restarted.pendingBatches()[0], baseline)
    assert.equal(restarted.getStatus().appliedSequence, 0)
  })

  it('survives a producer process exiting without closing or releasing its lease', () => {
    const { path, store, clock, open } = fixture()
    store.close()
    const moduleURL = new URL('../continuityRelayStore.ts', import.meta.url).href
    const source = `
      import { createRelayStore } from ${JSON.stringify(moduleURL)};
      const store = createRelayStore({ ...${JSON.stringify({ path, profileId, consumerId })}, now: () => 10000 });
      const lease = store.claimLease('terminated-child', 1000);
      const batch = store.enqueue(lease, ${JSON.stringify({
        cursorBefore: null,
        cursorAfter: 'child-cursor',
        snapshot: { fixture: true },
        changes: [change('child-work', { lifecycle: 'open', title: 'Synthetic crash fixture' })],
        synthetic: true,
      })});
      process.stdout.write(JSON.stringify(batch));
      process.exit(0);
    `
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
      encoding: 'utf8',
      timeout: 10_000,
    })
    assert.equal(child.status, 0, child.stderr)
    const batch = JSON.parse(child.stdout) as RelayBatch
    clock.at = 12_000
    const restarted = open()
    const lease = claim(restarted, 'after-process-exit')
    assert.equal(restarted.getStatus().cursor, 'child-cursor')
    assert.deepEqual(restarted.offer(lease), batch)
    restarted.acknowledge(ack(batch))
    assert.equal(restarted.getStatus().appliedSequence, 1)
  })

  it('accepts repeated ACKs without applying a batch twice, including after restart and later ACKs', () => {
    const { store, open } = fixture()
    const lease = claim(store)
    const first = enqueue(store, lease, null, 'cursor-1', [change('item-1', { lifecycle: 'open' })])
    const second = enqueue(store, lease, 'cursor-1', 'cursor-2', [change('item-1', { lifecycle: 'completed' })])
    assert.ok(first)
    assert.ok(second)
    assert.equal(store.acknowledge(ack(first)).duplicate, false)
    assert.equal(store.acknowledge(ack(first)).duplicate, true)
    store.acknowledge(ack(second))
    store.close()
    const reopened = open()
    const duplicate = reopened.acknowledge(ack(first))
    assert.equal(duplicate.duplicate, true)
    assert.equal(duplicate.appliedSequence, 2)
    assert.equal(reopened.getStatus().appliedState.open.length, 0)
    assert.equal(reopened.getStatus().appliedState.completed.length, 1)
  })

  it('rejects wrong consumer, hash, sequence, unknown and out-of-order ACKs without advancing applied state', () => {
    const { store } = fixture()
    const lease = claim(store)
    const first = enqueue(store, lease, null, 'cursor-1', [change('item-1', { lifecycle: 'open' })])
    const second = enqueue(store, lease, 'cursor-1', 'cursor-2', [change('item-2', { lifecycle: 'open' })])
    assert.ok(first)
    assert.ok(second)
    assert.throws(() => store.acknowledge({ ...ack(first), consumerId: 'someone-else' }), /consumer-mismatch/)
    assert.throws(() => store.acknowledge({ ...ack(first), payloadHash: 'wrong-hash' }), /hash-mismatch/)
    assert.throws(() => store.acknowledge({ ...ack(first), sequence: 99 }), /sequence-mismatch/)
    assert.throws(() => store.acknowledge({ ...ack(first), batchId: 'missing' }), /batch-not-found/)
    assert.throws(() => store.acknowledge(ack(second)), /out-of-order/)
    assert.equal(store.getStatus().appliedSequence, 0)
    assert.equal(store.getStatus().pendingCount, 2)
  })

  it('rejects opening the same queue with a different profile or consumer', () => {
    const { path, store } = fixture()
    assert.throws(() => createRelayStore({ path, profileId: 'different', consumerId }), /profile-mismatch/)
    assert.throws(() => createRelayStore({ path, profileId, consumerId: 'different' }), /consumer-mismatch/)
    assert.equal(store.getStatus().profileId, profileId)
    assert.equal(store.getStatus().consumerId, consumerId)
  })

  it('fences expired owners across two connections and refuses stale source cursors', () => {
    const { store, open, clock } = fixture()
    const other = open()
    const firstLease = claim(store, 'first', 1_000)
    assert.equal(other.claimLease('second', 1_000), null)
    const renewed = store.renewLease(firstLease, 2_000)
    assert.equal(renewed.token, firstLease.token)
    clock.at = 11_001
    assert.equal(other.claimLease('second', 1_000), null)
    clock.at = 12_001
    const secondLease = claim(other, 'second', 2_000)
    assert.ok(secondLease.token > firstLease.token)
    assert.throws(() => store.renewLease(firstLease, 1_000), /lease-expired-or-replaced/)
    assert.throws(() => enqueue(store, firstLease, null, 'bad-cursor', []), /lease-expired-or-replaced/)
    assert.throws(() => store.offer(firstLease), /lease-expired-or-replaced/)
    assert.equal(store.releaseLease(firstLease), false)
    enqueue(other, secondLease, null, 'cursor-1', [])
    assert.throws(() => enqueue(other, secondLease, null, 'cursor-2', []), /source-cursor-mismatch/)
    assert.equal(other.getStatus().cursor, 'cursor-1')
  })

  it('rejects an expired lease even before a replacement has claimed it', () => {
    const { store, clock } = fixture()
    const lease = claim(store, 'expired', 5)
    clock.at += 5
    assert.throws(() => enqueue(store, lease, null, 'cursor-1', []), /lease-expired-or-replaced/)
    assert.throws(() => store.offer(lease), /lease-expired-or-replaced/)
    assert.throws(() => store.renewLease(lease, 1_000), /lease-expired-or-replaced/)
    assert.equal(store.getStatus().cursor, null)
  })

  it('advances empty or self-echo ingestion without creating work or incrementing delivery sequence', () => {
    const { store } = fixture()
    const lease = claim(store)
    const selfEcho = change(
      'relay-message',
      { content: 'Synthetic relay acknowledgement' },
      {
        sourceRef: { kind: 'agent_event', id: 'relay-message' },
        origin: 'relay',
        eligibleForWorkUpdate: false,
      }
    )
    assert.equal(enqueue(store, lease, null, 'cursor-1', [selfEcho]), null)
    assert.equal(enqueue(store, lease, 'cursor-1', 'cursor-2', []), null)
    assert.equal(store.getStatus().cursor, 'cursor-2')
    assert.equal(store.getStatus().sequence, 0)
    assert.equal(store.getStatus().pendingCount, 0)
    assert.deepEqual(store.getStatus().projection.sources, {})
    const real = enqueue(store, lease, 'cursor-2', 'cursor-3', [
      selfEcho,
      change('human-work', { lifecycle: 'open', title: 'Synthetic human request' }),
    ])
    assert.ok(real)
    assert.equal(real.sequence, 1)
    assert.equal(real.changes.length, 2)
    assert.equal(real.state.open.length, 1)
    assert.equal(Object.keys(real.state.sources).length, 1)
  })

  it('emits an empty explicit baseline and retains rich source records without mutability leaks', () => {
    const { store } = fixture()
    const lease = claim(store)
    const baseline = enqueue(store, lease, null, 'baseline-cursor', [], true)
    assert.ok(baseline)
    assert.equal(baseline.baseline, true)
    assert.deepEqual(baseline.retractions, [])
    const context = change(
      'raw-context',
      { text: 'Long original context '.repeat(100), nested: { original: true } },
      {
        sourceRef: { kind: 'context', id: 'raw-context' },
      }
    )
    const batch = enqueue(store, lease, 'baseline-cursor', 'cursor-1', [context])
    assert.ok(batch)
    assert.equal(batch.state.focus[0].record?.text, context.record?.text)
    assert.ok(context.record)
    context.record.text = 'Changed after enqueue'
    batch.changes[0].record = null
    const saved = store.getStatus()
    assert.notEqual(saved.projection.focus[0].record?.text, 'Changed after enqueue')
    saved.projection.focus[0].record = null
    assert.ok(store.getStatus().projection.focus[0].record)
    store.acknowledge(ack(baseline))
    assert.ok(store.offer(lease)?.changes[0].record)
  })

  for (const exclusion of [
    { origin: 'relay' as const, eligibleForWorkUpdate: true, reason: 'relay-origin' },
    { origin: 'source' as const, eligibleForWorkUpdate: false, reason: 'ineligible' },
  ]) {
    it(`retracts an accepted context reclassified as ${exclusion.reason}, then ignores repeated echo`, () => {
      const { store } = fixture()
      const lease = claim(store)
      const original = change(
        'reclassified-context',
        { text: 'Synthetic source initially interpreted as external work' },
        { sourceRef: { kind: 'context', id: 'reclassified-context' } }
      )
      const first = enqueue(store, lease, null, 'cursor-1', [original])
      assert.ok(first)
      store.acknowledge(ack(first))
      assert.equal(store.getStatus().appliedState.focus.length, 1)

      const excluded = { ...original, origin: exclusion.origin, eligibleForWorkUpdate: exclusion.eligibleForWorkUpdate }
      const correction = enqueue(store, lease, 'cursor-1', 'cursor-2', [excluded])
      assert.ok(correction)
      assert.equal(correction.sequence, 2)
      assert.deepEqual(correction.retractions, [{ sourceRef: original.sourceRef, reason: exclusion.reason }])
      assert.equal(correction.changes[0].operation, 'updated')
      assert.equal(correction.changes[0].availability, 'available')
      assert.deepEqual(correction.changes[0].record, original.record)
      assert.deepEqual(correction.state.sources, {})
      assert.deepEqual(correction.state.focus, [])
      assert.equal(store.getStatus().appliedState.focus.length, 1)
      store.acknowledge(ack(correction))
      assert.deepEqual(store.getStatus().appliedState.sources, {})
      assert.deepEqual(store.getStatus().appliedState.focus, [])

      assert.equal(enqueue(store, lease, 'cursor-2', 'cursor-3', [excluded]), null)
      assert.equal(store.getStatus().cursor, 'cursor-3')
      assert.equal(store.getStatus().sequence, 2)
      assert.equal(store.getStatus().pendingCount, 0)
      assert.equal(store.offer(lease), null)
    })
  }

  it('treats blocker observations as signals and removes obsolete blockers on completion and deletion', () => {
    const { store } = fixture()
    const lease = claim(store)
    const blocker = change(
      'blocker-1',
      { work_item_id: 'item-1', kind: 'blocked', detail: 'Synthetic missing input' },
      {
        sourceRef: { kind: 'work_item_observation', id: 'blocker-1' },
      }
    )
    enqueue(store, lease, null, 'cursor-1', [change('item-1', { lifecycle: 'open' }), blocker])
    assert.equal(store.getStatus().projection.blockers.length, 1)
    enqueue(store, lease, 'cursor-1', 'cursor-2', [change('item-1', { lifecycle: 'completed' })])
    assert.equal(store.getStatus().projection.blockers.length, 0)
    assert.ok(store.getStatus().projection.sources['work_item_observation:blocker-1'])
    enqueue(store, lease, 'cursor-2', 'cursor-3', [
      change('item-1', { lifecycle: 'open', title: 'Reopened by correction' }),
    ])
    assert.equal(store.getStatus().projection.open.length, 1)
    assert.equal(store.getStatus().projection.completed.length, 0)
    enqueue(store, lease, 'cursor-3', 'cursor-4', [{ ...blocker, record: { ...blocker.record, dismissed_at: 12_000 } }])
    assert.equal(store.getStatus().projection.blockers.length, 0)
    enqueue(store, lease, 'cursor-4', 'cursor-5', [
      change('item-1', {}, { operation: 'deleted', availability: 'not_found', record: null, readContentHash: null }),
    ])
    assert.equal(store.getStatus().projection.open.length, 0)
    assert.equal(store.getStatus().projection.sources['work_item:item-1'], undefined)
  })

  it('retracts a source that vanished between its change page and original-source read', () => {
    const { store } = fixture()
    const lease = claim(store)
    enqueue(store, lease, null, 'cursor-1', [change('item-1', { lifecycle: 'open' })])
    const missing = enqueue(store, lease, 'cursor-1', 'cursor-2', [
      change('item-1', {}, { availability: 'not_found', record: null, readContentHash: null }),
    ])
    assert.ok(missing)
    assert.equal(missing.changes[0].operation, 'updated')
    assert.equal(missing.state.open.length, 0)
    assert.equal(store.getStatus().cursor, 'cursor-2')
  })

  it('caps retry backoff and maintains the same batch identity', () => {
    const { store, clock } = fixture()
    let lease = claim(store)
    const batch = enqueue(store, lease, null, 'cursor-1', [change('item-1', { lifecycle: 'open' })])
    assert.ok(batch)
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      lease = store.renewLease(lease, 60_000)
      assert.equal(store.offer(lease)?.batchId, batch.batchId)
      assert.equal(store.getStatus().nextRetryAt, clock.at + delay)
      clock.at += delay
    }
  })

  it('detects persisted payload tampering before delivery or acknowledgement', () => {
    const { store, path } = fixture()
    const lease = claim(store)
    const batch = enqueue(store, lease, null, 'cursor-1', [change('item-1', { lifecycle: 'open' })])
    assert.ok(batch)
    const database = new DatabaseSync(path)
    database
      .prepare('UPDATE relay_batch SET payload_json = ? WHERE sequence = 1')
      .run(JSON.stringify({ ...batch, synthetic: false }))
    database.close()
    assert.throws(() => store.offer(lease), /integrity-failed/)
    assert.throws(() => store.acknowledge(ack(batch)), /integrity-failed/)
    assert.equal(store.getStatus().appliedSequence, 0)
  })

  it('rejects invalid source payloads before changing any cursor or queue state', () => {
    const { store } = fixture()
    const lease = claim(store)
    const invalid = change('item-1', { lifecycle: 'open' }, { availability: 'not_found' })
    assert.throws(() => enqueue(store, lease, null, 'cursor-1', [invalid]), /must-have-null-record/)
    assert.throws(
      () => enqueue(store, lease, null, 'cursor-1', [change('item-1', { value: Number.NaN })]),
      /must-be-json/
    )
    assert.equal(store.getStatus().cursor, null)
    assert.equal(store.getStatus().pendingCount, 0)
  })

  it('bounds historical context while preserving full deduplicated original versions and every open work item', () => {
    const { store, path } = fixture()
    const lease = claim(store)
    const contexts = Array.from({ length: 75 }, (_, index) =>
      change(
        `context-${index}`,
        {
          timestamp: index,
          text: `Synthetic complete context ${index} `.repeat(100),
        },
        { sourceRef: { kind: 'context', id: `context-${index}` }, sourceDetails: { sourceNote: 'Unabridged fixture' } }
      )
    )
    const openItems = Array.from({ length: 60 }, (_, index) => change(`item-${index}`, { lifecycle: 'open' }))
    const batch = enqueue(store, lease, null, 'cursor-1', [...contexts, ...openItems])
    assert.ok(batch)
    assert.equal(Object.values(batch.state.sources).filter((source) => source.sourceRef.kind === 'context').length, 50)
    assert.equal(batch.state.sources['context:context-0'], undefined)
    assert.equal(batch.state.open.length, 60)
    assert.equal(batch.state.projectionLimits?.historicalSourcesPerKind, 50)
    const archivedSource = batch.changes[0]
    assert.ok(archivedSource.archiveVersionHash)
    const original = store.readArchive({
      sourceRef: archivedSource.sourceRef,
      versionHash: archivedSource.archiveVersionHash,
    })
    assert.equal(original.availability, 'available')
    assert.equal(original.historical, true)
    assert.equal(original.isCurrent, false)
    assert.deepEqual(original.source?.record, contexts[0].record)
    assert.deepEqual(original.source?.sourceDetails, contexts[0].sourceDetails)
    enqueue(store, lease, 'cursor-1', 'cursor-2', [{ ...contexts[0], readAt: 11_000 }])
    const database = new DatabaseSync(path)
    const versions = database
      .prepare("SELECT count(*) AS count FROM relay_source_version WHERE source_key = 'context:context-0'")
      .get()
    database.close()
    assert.equal(versions?.count, 1)
  })

  it('distinguishes enriched source versions even when the original row hash stays the same', () => {
    const { store } = fixture()
    const lease = claim(store)
    const source = change(
      'conversation',
      { text: 'Synthetic original row' },
      {
        sourceRef: { kind: 'conversation', id: 'conversation' },
        sourceDetails: { analyses: ['Initial analysis'] },
      }
    )
    const first = enqueue(store, lease, null, 'cursor-1', [source])
    const second = enqueue(store, lease, 'cursor-1', 'cursor-2', [
      { ...source, sourceDetails: { analyses: ['Corrected analysis'] } },
    ])
    assert.ok(first)
    assert.ok(second)
    assert.equal(first.changes[0].readContentHash, second.changes[0].readContentHash)
    const firstHash = first.changes[0].archiveVersionHash
    const secondHash = second.changes[0].archiveVersionHash
    assert.ok(firstHash)
    assert.ok(secondHash)
    assert.notEqual(firstHash, secondHash)
    assert.deepEqual(store.readArchive({ sourceRef: source.sourceRef, versionHash: firstHash }).source?.sourceDetails, {
      analyses: ['Initial analysis'],
    })
    assert.deepEqual(
      store.readArchive({ sourceRef: source.sourceRef, versionHash: secondHash }).source?.sourceDetails,
      { analyses: ['Corrected analysis'] }
    )
  })

  it('marks archived deleted or excluded evidence retracted without presenting it as current', () => {
    const { store } = fixture()
    const lease = claim(store)
    const source = change('item-1', { lifecycle: 'open' })
    const batch = enqueue(store, lease, null, 'cursor-1', [source])
    assert.ok(batch)
    const versionHash = batch.changes[0].archiveVersionHash
    assert.ok(versionHash)
    enqueue(store, lease, 'cursor-1', 'cursor-2', [
      { ...source, operation: 'deleted', availability: 'not_found', record: null, readContentHash: null },
    ])
    const deleted = store.readArchive({ sourceRef: source.sourceRef, versionHash })
    assert.equal(deleted.availability, 'available')
    assert.equal(deleted.retracted, true)
    assert.equal(deleted.retractionReason, 'deleted')
    assert.equal(deleted.isCurrent, false)
    enqueue(store, lease, 'cursor-2', 'cursor-3', [{ ...source, origin: 'relay' }])
    const excluded = store.readArchive({ sourceRef: source.sourceRef, versionHash })
    assert.equal(excluded.retracted, true)
    assert.equal(excluded.retractionReason, 'relay-origin')
    assert.deepEqual(excluded.source?.record, source.record)
    const absent = store.readArchive({ sourceRef: source.sourceRef, versionHash: 'unknown-version' })
    assert.equal(absent.availability, 'missing_or_expired')
    assert.equal(absent.source, null)
  })

  it('emits a retraction for a previously accepted source even after it has aged out of the bounded projection', () => {
    const { store } = fixture()
    const lease = claim(store)
    const sources = Array.from({ length: 60 }, (_, timestamp) =>
      change(
        `context-${timestamp}`,
        { timestamp },
        {
          sourceRef: { kind: 'context', id: `context-${timestamp}` },
        }
      )
    )
    enqueue(store, lease, null, 'cursor-1', sources)
    assert.equal(store.getStatus().projection.sources['context:context-0'], undefined)
    const excluded = { ...sources[0], origin: 'relay' as const }
    const correction = enqueue(store, lease, 'cursor-1', 'cursor-2', [excluded])
    assert.ok(correction)
    assert.deepEqual(correction.retractions, [{ sourceRef: excluded.sourceRef, reason: 'relay-origin' }])
    assert.equal(enqueue(store, lease, 'cursor-2', 'cursor-3', [excluded]), null)
  })

  it('prunes acknowledged payloads and expired raw versions after 14 days while preserving pending delivery and durable receipts', () => {
    const { store, clock, path, open } = fixture()
    const lease = claim(store)
    const first = enqueue(store, lease, null, 'cursor-1', [change('item-1', { lifecycle: 'open' })])
    const second = enqueue(store, lease, 'cursor-1', 'cursor-2', [change('item-1', { lifecycle: 'completed' })])
    const pending = enqueue(store, lease, 'cursor-2', 'cursor-3', [change('item-2', { lifecycle: 'open' })])
    assert.ok(first)
    assert.ok(second)
    assert.ok(pending)
    store.acknowledge(ack(first))
    store.acknowledge(ack(second))
    const versionHash = first.changes[0].archiveVersionHash
    assert.ok(versionHash)
    clock.at += 14 * 24 * 60 * 60_000
    assert.deepEqual(store.prune(), { batches: 2, sourceVersions: 3 })
    const expired = store.readArchive({ sourceRef: first.changes[0].sourceRef, versionHash })
    assert.equal(expired.availability, 'missing_or_expired')
    assert.equal(expired.source, null)
    assert.equal(store.acknowledge(ack(first)).duplicate, true)
    assert.throws(() => store.acknowledge({ ...ack(first), payloadHash: 'wrong' }), /hash-mismatch/)
    assert.throws(() => store.acknowledge({ ...ack(first), sequence: 99 }), /sequence-mismatch/)
    assert.throws(() => store.acknowledge({ ...ack(first), consumerId: 'wrong' }), /consumer-mismatch/)
    const database = new DatabaseSync(path)
    assert.equal(database.prepare('SELECT count(*) AS count FROM relay_batch').get()?.count, 1)
    assert.equal(database.prepare('SELECT count(*) AS count FROM relay_receipt').get()?.count, 2)
    assert.equal(
      database.prepare("SELECT lifecycle FROM relay_source_state WHERE source_key = 'work_item:item-1'").get()
        ?.lifecycle,
      'completed'
    )
    database.close()
    store.close()
    const restarted = open()
    assert.equal(restarted.acknowledge(ack(first)).appliedSequence, 2)
    const renewed = claim(restarted, 'after-retention')
    assert.deepEqual(restarted.offer(renewed), pending)
    restarted.acknowledge(ack(pending))
    assert.equal(restarted.getStatus().appliedSequence, 3)
  })

  it('adds archive and receipt indexes to an existing queue without changing any saved batch bytes or hashes', () => {
    const { store, path, open } = fixture()
    const lease = claim(store)
    const first = enqueue(store, lease, null, 'cursor-1', [change('item-1', { lifecycle: 'open' })])
    const second = enqueue(store, lease, 'cursor-1', 'cursor-2', [change('item-1', { lifecycle: 'completed' })])
    assert.ok(first)
    assert.ok(second)
    store.acknowledge(ack(first))
    store.releaseLease(lease)
    store.close()
    const database = new DatabaseSync(path)
    const before = database
      .prepare('SELECT sequence, payload_json, payload_hash FROM relay_batch ORDER BY sequence')
      .all()
    database.exec(
      'DROP TABLE relay_source_version; DROP TABLE relay_source_state; DROP TABLE relay_receipt; DROP TABLE relay_storage_migration;'
    )
    database.close()
    const upgraded = open()
    const inspected = new DatabaseSync(path)
    assert.deepEqual(
      inspected.prepare('SELECT sequence, payload_json, payload_hash FROM relay_batch ORDER BY sequence').all(),
      before
    )
    assert.equal(inspected.prepare('SELECT count(*) AS count FROM relay_source_version').get()?.count, 2)
    assert.equal(inspected.prepare('SELECT count(*) AS count FROM relay_receipt').get()?.count, 1)
    inspected.close()
    assert.equal(upgraded.acknowledge(ack(first)).duplicate, true)
    assert.deepEqual(upgraded.offer(claim(upgraded)), second)
  })

  it('recovers legacy privacy labels without rewriting payloads or ACKs and durably queues one correction on next ingestion', () => {
    const { store, path, open } = fixture(() => false)
    const lease = claim(store)
    const first = enqueue(store, lease, null, 'cursor-1', [], true)
    assert.ok(first)
    const firstDelivery = store.prepareDelivery(first, { text: 'Synthetic acknowledged legacy baseline' })
    store.acknowledgeDeliveryFile(fileAck(firstDelivery))
    store.acknowledgeDelivery(ack(firstDelivery))
    const markerRef = { kind: 'context', id: 'legacy-marker' }
    const snapshotRef = { kind: 'context', id: 'legacy-preview' }
    const frozenRef = { kind: 'work_item', id: 'legacy-frozen-private' }
    const redacted = change(
      markerRef.id,
      { contentOmitted: true, omissionReason: 'authentication_surface' },
      { sourceRef: markerRef, eligibleForWorkUpdate: false }
    )
    const derived = change(
      'legacy-derived',
      { lifecycle: 'open', title: 'SYNTHETIC PRIVATE DERIVED' },
      { sourceDetails: { sources: [{ sourceRef: markerRef }] } }
    )
    const blocker = change(
      'legacy-blocker',
      {
        work_item_id: derived.sourceRef.id,
        kind: 'blocked',
        detail: 'SYNTHETIC PRIVATE BLOCKER',
        sourceRef: derived.sourceRef,
      },
      { sourceRef: { kind: 'work_item_observation', id: 'legacy-blocker' } }
    )
    const frozenPrivate = change(
      frozenRef.id,
      { lifecycle: 'open', title: 'SYNTHETIC PRIVATE FROZEN' },
      { sourceRef: frozenRef }
    )
    const pending = store.enqueue(lease, {
      cursorBefore: 'cursor-1',
      cursorAfter: 'cursor-2',
      changes: [redacted, derived, blocker, frozenPrivate],
      synthetic: true,
      snapshot: {
        privacyOmissions: [{ sourceRef: snapshotRef, reason: 'authentication_surface', detection: 'preview_metadata' }],
      },
    })
    assert.ok(pending)
    store.releaseLease(lease)
    store.close()

    // Construct a pre-registry fixture: the marker exists only in changes, not the snapshot.
    const database = new DatabaseSync(path)
    const row = database.prepare('SELECT payload_json FROM relay_batch WHERE sequence = 2').get() as {
      payload_json: string
    }
    const legacy = JSON.parse(row.payload_json) as RelayBatch
    legacy.snapshot.privacyOmissions = (
      legacy.snapshot.privacyOmissions as { sourceRef: RelayChange['sourceRef'] }[]
    ).filter((entry) => entry.sourceRef.id === snapshotRef.id)
    const { payloadHash: _oldHash, ...legacyPayload } = legacy
    // Existing canonical key order is preserved by parsing and deleting only one array entry.
    legacy.payloadHash = createHash('sha256').update(JSON.stringify(legacyPayload)).digest('hex')
    database
      .prepare('UPDATE relay_batch SET payload_json = ?, payload_hash = ? WHERE sequence = 2')
      .run(JSON.stringify(legacy), legacy.payloadHash)
    database.close()
    const prepared = open()
    assert.deepEqual(prepared.pendingBatches(), [legacy])
    const frozen = prepared.prepareDelivery(legacy, {
      privacyOmissions: [
        {
          sourceRef: frozenRef,
          reason: 'authentication_source_reference',
          detection: 'source_reference',
          unsafeExtra: 'DO NOT RETAIN LABEL BODY',
        },
      ],
    })
    prepared.close()

    const legacyDatabase = new DatabaseSync(path)
    legacyDatabase.exec(
      "UPDATE relay_metadata SET snapshot_json = '{}'; DELETE FROM relay_storage_migration WHERE id = 2;"
    )
    const preserved = () =>
      Object.fromEntries(
        ['relay_batch', 'relay_delivery', 'relay_receipt', 'relay_delivery_receipt', 'relay_delivery_file_receipt'].map(
          (table) => [table, legacyDatabase.prepare(`SELECT * FROM ${table} ORDER BY sequence`).all()]
        )
      )
    const before = preserved()
    const migrated = open()
    assert.deepEqual(preserved(), before)
    assert.equal(migrated.getStatus().sequence, 2)
    assert.equal(migrated.getStatus().appliedSequence, 1)
    assert.equal(migrated.getStatus().pendingCount, 1)
    assert.equal(migrated.getStatus().snapshot.privacyCorrectionPending, true)
    assert.deepEqual(
      (migrated.getStatus().snapshot.privacyOmissions as { sourceRef: RelayChange['sourceRef'] }[])
        .map((entry) => entry.sourceRef.id)
        .sort(),
      [markerRef.id, snapshotRef.id, frozenRef.id].sort()
    )
    assert.equal(JSON.stringify(migrated.getStatus().snapshot).includes('DO NOT RETAIN'), false)
    assert.deepEqual(migrated.prepareDelivery(legacy, {}), frozen)
    migrated.close()
    const restarted = open()
    assert.equal(restarted.getStatus().snapshot.privacyCorrectionPending, true)
    const currentLease = claim(restarted)
    assert.throws(() => enqueue(restarted, currentLease, 'wrong-cursor', 'cursor-3', []), /source-cursor-mismatch/)
    assert.equal(restarted.getStatus().snapshot.privacyCorrectionPending, true)
    assert.equal(restarted.getStatus().cursor, 'cursor-2')
    const correction = enqueue(restarted, currentLease, 'cursor-2', 'cursor-3', [])
    assert.ok(correction)
    assert.equal(correction.sequence, 3)
    assert.equal(restarted.getStatus().snapshot.privacyCorrectionPending, undefined)
    const content = createDeliveryContent(correction)
    assert.deepEqual(content.blockers.active, [])
    assert.equal(JSON.stringify(content).includes('SYNTHETIC PRIVATE'), false)
    for (const sourceRef of [markerRef, snapshotRef, frozenRef, derived.sourceRef, blocker.sourceRef]) {
      assert.ok(
        content.privacyOmissions.some(
          (entry) => entry.sourceRef.kind === sourceRef.kind && entry.sourceRef.id === sourceRef.id
        )
      )
    }
    assert.equal(enqueue(restarted, currentLease, 'cursor-3', 'cursor-4', []), null)
    assert.equal(restarted.getStatus().sequence, 3)
    assert.equal(restarted.getStatus().appliedSequence, 1)
    assert.deepEqual(restarted.pendingBatches(), [legacy, correction])
    assert.deepEqual(restarted.prepareDelivery(legacy, {}), frozen)
    legacyDatabase.close()
  })

  it('keeps active blocker signals beyond the historical observation limit and does not revive closed work from late facts', () => {
    const { store } = fixture()
    const lease = claim(store)
    const blockers = Array.from({ length: 60 }, (_, index) =>
      change(
        `blocker-${index}`,
        {
          work_item_id: 'item-1',
          kind: 'blocked',
          observed_at: index,
        },
        { sourceRef: { kind: 'work_item_observation', id: `blocker-${index}` } }
      )
    )
    enqueue(store, lease, null, 'cursor-1', [change('item-1', { lifecycle: 'open' }), ...blockers])
    assert.equal(store.getStatus().projection.blockers.length, 60)
    enqueue(store, lease, 'cursor-1', 'cursor-2', [change('item-1', { lifecycle: 'completed' })])
    assert.equal(store.getStatus().projection.blockers.length, 0)
    enqueue(store, lease, 'cursor-2', 'cursor-3', [
      change(
        'old-fact',
        {
          work_item_id: 'item-1',
          type: 'created',
          detail: 'Old synthetic task text',
        },
        { sourceRef: { kind: 'work_item_fact', id: 'old-fact' } }
      ),
    ])
    assert.equal(store.getStatus().projection.open.length, 0)
    assert.equal(store.getStatus().projection.completed.length, 1)
  })

  it('freezes the exact received delivery projection independently from the full source batch', () => {
    const { store, open } = fixture()
    const lease = claim(store)
    const batch = enqueue(store, lease, null, 'cursor-1', [
      change('item-1', { lifecycle: 'open', privateContext: 'Synthetic full source' }),
    ])
    assert.ok(batch)
    const content = { focus: 'Synthetic projected focus', omittedRawSources: 1, nested: { original: true } }
    const delivery = store.prepareDelivery(batch, content)
    assert.equal(delivery.kind, 'remember.context.delivery')
    assert.equal(delivery.hashAlgorithm, 'sha256-canonical-json-v1')
    assert.equal(delivery.sourcePayloadHash, batch.payloadHash)
    assert.notEqual(delivery.payloadHash, batch.payloadHash)
    const { payloadHash, ...envelope } = delivery
    assert.equal(hashDeliveryPayload(envelope), payloadHash)
    content.nested.original = false
    assert.deepEqual(store.prepareDelivery(batch, { focus: 'New projector result ignored' }), delivery)
    assert.equal(store.getStatus().appliedDelivery, null)
    assert.throws(() => store.acknowledgeDelivery(ack(batch)), /delivery-hash-mismatch/)
    assert.equal(store.getStatus().appliedSequence, 0)
    acknowledgePages(store, delivery)
    assert.equal(store.acknowledgeDelivery(ack(delivery)).duplicate, false)
    assert.deepEqual(store.getStatus().appliedDelivery, delivery)
    assert.equal(store.getStatus().appliedState.open[0].record?.privateContext, 'Synthetic full source')
    assert.equal(store.getStatus().appliedDelivery?.content.privateContext, undefined)
    store.close()
    const restarted = open()
    assert.deepEqual(restarted.prepareDelivery(batch, { focus: 'Changed after restart' }), delivery)
    assert.deepEqual(restarted.getStatus().appliedDelivery, delivery)
    assert.equal(restarted.acknowledgeDelivery(ack(delivery)).duplicate, true)
  })

  it('uses reproducible Unicode codepoint key ordering for delivery hashes without depending on host locale', () => {
    const input = {
      '😀': 'astral',
      '\uE000': 'private-use',
      é: 'accent',
      a: { z: 2, _: 1 },
      Z: 'upper',
      _: 'underscore',
    }
    const canonical =
      '{"Z":"upper","_":"underscore","a":{"_":1,"z":2},"é":"accent","\uE000":"private-use","😀":"astral"}'
    assert.equal(hashDeliveryPayload(input), createHash('sha256').update(canonical, 'utf8').digest('hex'))
  })

  it('requires an exact prepared delivery hash, consumer and sequence and applies successive projections in order', () => {
    const { store } = fixture()
    const lease = claim(store)
    const first = enqueue(store, lease, null, 'cursor-1', [change('item-1', { lifecycle: 'open' })])
    const second = enqueue(store, lease, 'cursor-1', 'cursor-2', [change('item-1', { lifecycle: 'completed' })])
    assert.ok(first)
    assert.ok(second)
    assert.throws(() => store.acknowledgeDelivery(ack(first)), /not-prepared/)
    const one = store.prepareDelivery(first, { open: ['item-1'], completed: [] })
    const two = store.prepareDelivery(second, { open: [], completed: ['item-1'] })
    acknowledgePages(store, one)
    acknowledgePages(store, two)
    assert.throws(() => store.acknowledgeDelivery({ ...ack(one), consumerId: 'wrong' }), /consumer-mismatch/)
    assert.throws(() => store.acknowledgeDelivery({ ...ack(one), sequence: 99 }), /delivery-sequence-mismatch/)
    assert.throws(() => store.acknowledgeDelivery({ ...ack(one), payloadHash: 'wrong' }), /delivery-hash-mismatch/)
    assert.throws(() => store.acknowledgeDelivery(ack(two)), /out-of-order/)
    assert.equal(store.getStatus().appliedDelivery, null)
    store.acknowledgeDelivery(ack(one))
    store.acknowledgeDelivery(ack(two))
    assert.deepEqual(store.getStatus().appliedDelivery?.content, { completed: ['item-1'], open: [] })
    assert.equal(store.acknowledgeDelivery(ack(one)).duplicate, true)
    assert.equal(store.getStatus().appliedSequence, 2)
    assert.equal(store.getStatus().appliedDelivery?.sequence, 2)
  })

  it('rolls back the raw-source ACK if persisting the delivery receipt fails', () => {
    const { store, path } = fixture()
    const lease = claim(store)
    const batch = enqueue(store, lease, null, 'cursor-1', [change('item-1', { lifecycle: 'open' })])
    assert.ok(batch)
    const delivery = store.prepareDelivery(batch, { focus: 'Synthetic receipt atomicity check' })
    acknowledgePages(store, delivery)
    const database = new DatabaseSync(path)
    database.exec(
      "CREATE TRIGGER fail_delivery_receipt BEFORE INSERT ON relay_delivery_receipt BEGIN SELECT RAISE(ABORT, 'synthetic-receipt-failure'); END"
    )
    assert.throws(() => store.acknowledgeDelivery(ack(delivery)), /synthetic-receipt-failure/)
    assert.equal(store.getStatus().appliedSequence, 0)
    assert.equal(store.getStatus().pendingCount, 1)
    assert.equal(store.getStatus().appliedDelivery, null)
    assert.equal(database.prepare('SELECT count(*) AS count FROM relay_receipt').get()?.count, 0)
    database.exec('DROP TRIGGER fail_delivery_receipt')
    database.close()
    store.acknowledgeDelivery(ack(delivery))
    assert.equal(store.getStatus().appliedSequence, 1)
    assert.deepEqual(store.getStatus().appliedDelivery, delivery)
  })

  it('retains a small delivery receipt after projection expiry and rejects a source-hash ACK after pruning', () => {
    const { store, clock, path, open } = fixture()
    const lease = claim(store)
    const batch = enqueue(store, lease, null, 'cursor-1', [change('item-1', { lifecycle: 'open' })])
    assert.ok(batch)
    const delivery = store.prepareDelivery(batch, { focus: 'Synthetic retained receipt' })
    acknowledgePages(store, delivery)
    store.acknowledgeDelivery(ack(delivery))
    clock.at += 14 * 24 * 60 * 60_000
    store.prune()
    assert.equal(store.getStatus().appliedDelivery, null)
    assert.equal(store.getStatus().appliedDeliveryReceipt?.payloadHash, delivery.payloadHash)
    assert.equal(store.getStatus().appliedDeliveryReceipt?.sourcePayloadHash, batch.payloadHash)
    assert.equal(store.acknowledgeDelivery(ack(delivery)).duplicate, true)
    assert.throws(() => store.acknowledgeDelivery(ack(batch)), /delivery-hash-mismatch/)
    const database = new DatabaseSync(path)
    assert.equal(database.prepare('SELECT count(*) AS count FROM relay_delivery').get()?.count, 0)
    assert.equal(database.prepare('SELECT count(*) AS count FROM relay_delivery_receipt').get()?.count, 1)
    database.close()
    store.close()
    const restarted = open()
    assert.equal(restarted.acknowledgeDelivery(ack(delivery)).duplicate, true)
    assert.equal(restarted.getStatus().appliedDeliveryReceipt?.payloadHash, delivery.payloadHash)
  })

  it('rejects changed source batches and detects projection corruption before recording an ACK', () => {
    const { store, path } = fixture()
    const lease = claim(store)
    const batch = enqueue(store, lease, null, 'cursor-1', [change('item-1', { lifecycle: 'open' })])
    assert.ok(batch)
    assert.throws(() => store.prepareDelivery({ ...batch, synthetic: false }, {}), /source-integrity-failed/)
    const delivery = store.prepareDelivery(batch, { focus: 'Original synthetic projection' })
    const database = new DatabaseSync(path)
    database
      .prepare('UPDATE relay_delivery SET payload_json = ? WHERE sequence = 1')
      .run(JSON.stringify({ ...delivery, content: { focus: 'Tampered projection' } }))
    database.close()
    assert.throws(() => store.prepareDelivery(batch, {}), /delivery-integrity-failed/)
    assert.throws(() => store.acknowledgeDelivery(ack(delivery)), /delivery-integrity-failed/)
    assert.equal(store.getStatus().appliedSequence, 0)
  })

  it('rejects a final ACK for an old frozen unpaged 50KB delivery without applying its source state', () => {
    const { store, open, path } = fixture()
    const batch = enqueue(store, claim(store), null, 'cursor-1', [change('item-1', { lifecycle: 'open' })])
    assert.ok(batch)
    const delivery = store.prepareDelivery(batch, { text: 'Synthetic unpaged content '.repeat(2100) })
    assert.ok(Buffer.byteLength(JSON.stringify(delivery), 'utf8') > 50_000)
    store.close()
    const restarted = open()
    assert.throws(() => restarted.acknowledgeDelivery(ack(delivery)), /pages-not-prepared/)
    assert.equal(restarted.getStatus().appliedSequence, 0)
    assert.equal(restarted.getStatus().appliedDelivery, null)
    assert.equal(restarted.getStatus().pendingCount, 1)
    const database = new DatabaseSync(path)
    assert.equal(database.prepare('SELECT count(*) AS count FROM relay_receipt').get()?.count, 0)
    assert.equal(database.prepare('SELECT count(*) AS count FROM relay_delivery_receipt').get()?.count, 0)
    database.close()
    acknowledgePages(restarted, delivery)
    restarted.acknowledgeDelivery(ack(delivery))
    assert.deepEqual(restarted.getStatus().appliedDelivery, delivery)
  })

  it('allows an existing durable final receipt to be repeated without retroactive page receipts', () => {
    const { store, path, open } = fixture()
    const batch = enqueue(store, claim(store), null, 'cursor-1', [change('item-1', { lifecycle: 'open' })])
    assert.ok(batch)
    const delivery = store.prepareDelivery(batch, { text: 'Synthetic legacy already-acknowledged delivery' })
    acknowledgePages(store, delivery)
    store.acknowledgeDelivery(ack(delivery))
    store.close()
    const database = new DatabaseSync(path)
    database.exec(
      'DELETE FROM relay_delivery_page_receipt; DELETE FROM relay_delivery_page; DELETE FROM relay_delivery_paging;'
    )
    database.close()
    const restarted = open()
    assert.equal(restarted.acknowledgeDelivery(ack(delivery)).duplicate, true)
    assert.equal(restarted.getStatus().appliedSequence, 1)
    assert.deepEqual(restarted.getStatus().appliedDelivery, delivery)
  })

  it('paginates the exact frozen delivery within 5500 UTF-8 bytes including Unicode escaping and envelope overhead', () => {
    const { store } = fixture()
    const lease = claim(store)
    const batch = enqueue(store, lease, null, 'cursor-1', [change('item-1', { lifecycle: 'open' })])
    assert.ok(batch)
    const delivery = store.prepareDelivery(batch, {
      original: 'Quote " and slash \\ newline\n emoji 😀 é nul\u0000 '.repeat(900),
    })
    const pages = store.prepareDeliveryPages(delivery)
    assert.ok(pages.length > 2)
    assert.deepEqual(JSON.parse(pages.map((page) => page.content).join('')), delivery)
    const { payloadHash, ...assembled } = JSON.parse(pages.map((page) => page.content).join(''))
    assert.equal(hashDeliveryPayload(assembled), payloadHash)
    for (const [index, page] of pages.entries()) {
      assert.equal(page.pageIndex, index + 1)
      assert.equal(page.pageCount, pages.length)
      assert.equal(page.deliveryPayloadHash, delivery.payloadHash)
      assert.equal(page.encoding, 'json-string-fragment')
      assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') <= 5500)
      assert.ok(JSON.stringify(page).length <= 5500)
      assert.equal(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(page.content), false)
      const { pageHash, ...payload } = page
      assert.equal(hashDeliveryPayload(payload), pageHash)
    }
    assert.deepEqual(store.prepareDeliveryPages(delivery), pages)
    assert.deepEqual(store.getNextDeliveryPage(delivery), pages[0])
    pages[0].content = 'Mutated caller copy'
    assert.notEqual(store.getNextDeliveryPage(delivery)?.content, 'Mutated caller copy')
  })

  it('requires ordered exact page ACKs followed by a separate whole-delivery ACK', () => {
    const { store, clock } = fixture()
    const lease = claim(store)
    const batch = enqueue(store, lease, null, 'cursor-1', [change('item-1', { lifecycle: 'open' })])
    assert.ok(batch)
    const delivery = store.prepareDelivery(batch, { text: 'Synthetic projection '.repeat(900) })
    assert.throws(() => store.getNextDeliveryPage(delivery), /pages-not-prepared/)
    const pages = store.prepareDeliveryPages(delivery)
    const firstAck = { ...ack(delivery), pageIndex: 1, pageHash: pages[0].pageHash }
    assert.throws(() => store.acknowledgeDelivery(ack(delivery)), /pages-not-acknowledged/)
    assert.throws(
      () => store.acknowledgeDeliveryPage({ ...firstAck, pageIndex: 2, pageHash: pages[1].pageHash }),
      /page-out-of-order/
    )
    assert.throws(() => store.acknowledgeDeliveryPage({ ...firstAck, pageHash: 'wrong' }), /page-hash-mismatch/)
    assert.throws(
      () => store.acknowledgeDeliveryPage({ ...firstAck, payloadHash: batch.payloadHash }),
      /delivery-hash-mismatch/
    )
    assert.throws(() => store.acknowledgeDeliveryPage({ ...firstAck, sequence: 99 }), /delivery-sequence-mismatch/)
    assert.throws(() => store.acknowledgeDeliveryPage({ ...firstAck, consumerId: 'wrong' }), /consumer-mismatch/)
    assert.throws(
      () => store.acknowledgeDeliveryPage({ ...firstAck, pageIndex: pages.length + 1 }),
      /page-out-of-range/
    )
    store.offer(lease)
    assert.equal(store.getStatus().nextRetryAt, clock.at + 1000)
    for (const page of pages) {
      assert.deepEqual(store.getNextDeliveryPage(delivery), page)
      const receipt = store.acknowledgeDeliveryPage({
        ...ack(delivery),
        pageIndex: page.pageIndex,
        pageHash: page.pageHash,
      })
      assert.equal(receipt.acknowledgedPages, page.pageIndex)
      assert.equal(receipt.readyForFinalAcknowledgement, page.pageIndex === pages.length)
      assert.equal(store.getStatus().nextRetryAt, clock.at)
      assert.equal(store.getStatus().appliedSequence, 0)
      assert.equal(store.getStatus().appliedDelivery, null)
    }
    assert.equal(store.getNextDeliveryPage(delivery), null)
    assert.equal(store.acknowledgeDeliveryPage(firstAck).duplicate, true)
    assert.equal(store.getStatus().pendingCount, 1)
    store.acknowledgeDelivery(ack(delivery))
    assert.equal(store.getStatus().pendingCount, 0)
    assert.deepEqual(store.getStatus().appliedDelivery, delivery)
  })

  it('resumes the first unacknowledged page after restart without changing page bytes or the frozen delivery', () => {
    const { store, open } = fixture()
    const lease = claim(store)
    const batch = enqueue(store, lease, null, 'cursor-1', [change('item-1', { lifecycle: 'open' })])
    assert.ok(batch)
    const delivery = store.prepareDelivery(batch, { text: 'Original page resume fixture '.repeat(600) })
    const pages = store.prepareDeliveryPages(delivery)
    const firstAck = { ...ack(delivery), pageIndex: 1, pageHash: pages[0].pageHash }
    store.acknowledgeDeliveryPage(firstAck)
    store.close()
    const restarted = open()
    assert.equal(restarted.acknowledgeDeliveryPage(firstAck).duplicate, true)
    assert.deepEqual(restarted.prepareDeliveryPages(delivery), pages)
    assert.equal(JSON.stringify(restarted.getNextDeliveryPage(delivery)), JSON.stringify(pages[1]))
    assert.deepEqual(restarted.prepareDelivery(batch, { changedProjector: true }), delivery)
    assert.throws(() => restarted.acknowledgeDelivery(ack(delivery)), /pages-not-acknowledged/)
  })

  it('detects tampered or missing page payloads and cannot acknowledge the delivery with a missing page', () => {
    const { store, path } = fixture()
    const lease = claim(store)
    const batch = enqueue(store, lease, null, 'cursor-1', [change('item-1', { lifecycle: 'open' })])
    assert.ok(batch)
    const delivery = store.prepareDelivery(batch, { text: 'Synthetic missing page '.repeat(600) })
    const pages = store.prepareDeliveryPages(delivery)
    const database = new DatabaseSync(path)
    database
      .prepare('UPDATE relay_delivery_page SET payload_json = ? WHERE page_index = 1')
      .run(JSON.stringify({ ...pages[0], content: 'Tampered' }))
    assert.throws(() => store.getNextDeliveryPage(delivery), /page-integrity-failed/)
    assert.throws(
      () => store.acknowledgeDeliveryPage({ ...ack(delivery), pageIndex: 1, pageHash: pages[0].pageHash }),
      /page-integrity-failed/
    )
    database.exec('DELETE FROM relay_delivery_page WHERE page_index = 1')
    database.close()
    assert.throws(() => store.getNextDeliveryPage(delivery), /page-missing-or-expired/)
    assert.throws(() => store.prepareDeliveryPages(delivery), /pages-missing-or-expired/)
    assert.throws(
      () => store.acknowledgeDeliveryPage({ ...ack(delivery), pageIndex: 1, pageHash: pages[0].pageHash }),
      /page-missing-or-expired/
    )
    assert.throws(() => store.acknowledgeDelivery(ack(delivery)), /pages-not-acknowledged/)
    assert.equal(store.getStatus().appliedSequence, 0)
  })

  it('retains pending pages and keeps idempotent page receipts after acknowledged page payloads expire', () => {
    const { store, clock, path } = fixture()
    const lease = claim(store)
    const batch = enqueue(store, lease, null, 'cursor-1', [change('item-1', { lifecycle: 'open' })])
    assert.ok(batch)
    const delivery = store.prepareDelivery(batch, { text: 'Synthetic retention page '.repeat(500) })
    const pages = store.prepareDeliveryPages(delivery)
    clock.at += 14 * 24 * 60 * 60_000
    store.prune()
    assert.deepEqual(store.getNextDeliveryPage(delivery), pages[0])
    for (const page of pages)
      store.acknowledgeDeliveryPage({ ...ack(delivery), pageIndex: page.pageIndex, pageHash: page.pageHash })
    store.acknowledgeDelivery(ack(delivery))
    clock.at += 14 * 24 * 60 * 60_000
    store.prune()
    const database = new DatabaseSync(path)
    assert.equal(database.prepare('SELECT count(*) AS count FROM relay_delivery_page').get()?.count, 0)
    assert.equal(
      database.prepare('SELECT count(*) AS count FROM relay_delivery_page_receipt').get()?.count,
      pages.length
    )
    database.close()
    const firstAck = { ...ack(delivery), pageIndex: 1, pageHash: pages[0].pageHash }
    assert.equal(store.acknowledgeDeliveryPage(firstAck).duplicate, true)
    assert.throws(() => store.acknowledgeDeliveryPage({ ...firstAck, pageHash: 'wrong' }), /page-hash-mismatch/)
    assert.equal(store.acknowledgeDelivery(ack(delivery)).duplicate, true)
    assert.throws(() => store.getNextDeliveryPage(delivery), /delivery-missing-or-expired/)
  })

  it('serializes an exact canonical delivery file including its delivery hash and one final LF', () => {
    const { store } = fixture()
    const batch = enqueue(store, claim(store), null, 'cursor-1', [change('item-1', { lifecycle: 'open' })])
    assert.ok(batch)
    const delivery = store.prepareDelivery(batch, { '😀': 'é', _first: 'Quote " newline\n', z: '\u0000' })
    const contents = serializeDeliveryFile(delivery)
    assert.equal(
      contents,
      `${store
        .prepareDeliveryPages(delivery)
        .map((page) => page.content)
        .join('')}\n`
    )
    assert.equal(contents.endsWith('\n\n'), false)
    assert.deepEqual(JSON.parse(contents), delivery)
    assert.ok(Buffer.byteLength(contents, 'utf8') > contents.length)
    assert.equal(
      serializeDeliveryFile({ ...delivery, content: { z: '\u0000', _first: 'Quote " newline\n', '😀': 'é' } }),
      contents
    )
    assert.notEqual(fileAck(delivery).fileSha256, delivery.payloadHash)
    assert.notEqual(fileAck(delivery).fileSha256, batch.payloadHash)
  })

  it('rejects wrong file bytes, size, delivery identity and consumer without creating a receipt', () => {
    const { store, path } = fixture()
    const batch = enqueue(store, claim(store), null, 'cursor-1', [change('item-1', { lifecycle: 'open' })])
    assert.ok(batch)
    const delivery = store.prepareDelivery(batch, { text: 'Synthetic exact file 😀' })
    const receipt = fileAck(delivery)
    assert.equal(store.hasDeliveryFileReceipt(delivery), false)
    assert.throws(
      () => store.acknowledgeDeliveryFile({ ...receipt, fileSha256: '0'.repeat(64) }),
      /file-sha256-mismatch/
    )
    assert.throws(
      () => store.acknowledgeDeliveryFile({ ...receipt, fileSizeBytes: receipt.fileSizeBytes + 1 }),
      /file-size-mismatch/
    )
    const withoutLF = serializeDeliveryFile(delivery).slice(0, -1)
    assert.throws(
      () =>
        store.acknowledgeDeliveryFile({
          ...receipt,
          fileSha256: createHash('sha256').update(withoutLF).digest('hex'),
          fileSizeBytes: Buffer.byteLength(withoutLF),
        }),
      /file-size-mismatch/
    )
    assert.throws(
      () => store.acknowledgeDeliveryFile({ ...receipt, payloadHash: batch.payloadHash }),
      /delivery-hash-mismatch/
    )
    assert.throws(() => store.acknowledgeDeliveryFile({ ...receipt, sequence: 99 }), /delivery-sequence-mismatch/)
    assert.throws(() => store.acknowledgeDeliveryFile({ ...receipt, consumerId: 'someone-else' }), /consumer-mismatch/)
    assert.throws(
      () => store.acknowledgeDeliveryFile({ ...receipt, batchId: 'unknown' }),
      /delivery-missing-or-expired/
    )
    assert.throws(() => store.acknowledgeDeliveryFile({ ...receipt, fileSizeBytes: 0 }), /invalid-delivery-file-size/)
    assert.throws(
      () => store.acknowledgeDeliveryFile({ ...receipt, fileSha256: 'invalid' }),
      /invalid-delivery-file-sha256/
    )
    assert.throws(() => store.acknowledgeDelivery(ack(delivery)), /pages-not-prepared/)
    assert.equal(store.getStatus().appliedSequence, 0)
    const database = new DatabaseSync(path)
    assert.equal(database.prepare('SELECT count(*) AS count FROM relay_delivery_file_receipt').get()?.count, 0)
    database.close()
  })

  it('accepts a durable exact file receipt and resets retries without inventing page or final ACKs', () => {
    const { store, clock, path, open } = fixture()
    const lease = claim(store)
    const batch = enqueue(store, lease, null, 'cursor-1', [change('item-1', { lifecycle: 'open' })])
    assert.ok(batch)
    const delivery = store.prepareDelivery(batch, { text: 'Synthetic mixed file and page transport 😀 '.repeat(500) })
    const pages = store.prepareDeliveryPages(delivery)
    store.acknowledgeDeliveryPage({ ...ack(delivery), pageIndex: 1, pageHash: pages[0].pageHash })
    store.offer(lease)
    assert.equal(store.getStatus().nextRetryAt, clock.at + 1000)
    const receipt = fileAck(delivery)
    const result = store.acknowledgeDeliveryFile(receipt)
    assert.equal(result.duplicate, false)
    assert.equal(result.readyForFinalAcknowledgement, true)
    assert.equal(store.getStatus().nextRetryAt, clock.at)
    assert.equal(store.getStatus().appliedSequence, 0)
    assert.equal(store.getStatus().pendingCount, 1)
    assert.equal(store.getStatus().appliedDelivery, null)
    assert.deepEqual(store.getNextDeliveryPage(delivery), pages[1])
    store.close()
    const restarted = open()
    assert.equal(restarted.hasDeliveryFileReceipt(delivery), true)
    assert.equal(restarted.acknowledgeDeliveryFile(receipt).duplicate, true)
    assert.deepEqual(restarted.prepareDelivery(batch, { changedProjector: true }), delivery)
    const database = new DatabaseSync(path)
    assert.equal(database.prepare('SELECT count(*) AS count FROM relay_delivery_page_receipt').get()?.count, 1)
    assert.equal(database.prepare('SELECT count(*) AS count FROM relay_delivery_receipt').get()?.count, 0)
    database.close()
    restarted.acknowledgeDelivery(ack(delivery))
    assert.equal(restarted.getStatus().appliedSequence, 1)
    assert.deepEqual(restarted.getStatus().appliedDelivery, delivery)
  })

  it('allows an unpaged file delivery to be finalized but still rejects final ACKs out of source order', () => {
    const { store } = fixture()
    const lease = claim(store)
    const first = enqueue(store, lease, null, 'cursor-1', [change('item-1', { lifecycle: 'open' })])
    const second = enqueue(store, lease, 'cursor-1', 'cursor-2', [change('item-1', { lifecycle: 'completed' })])
    assert.ok(first)
    assert.ok(second)
    const firstDelivery = store.prepareDelivery(first, { state: 'open' })
    const secondDelivery = store.prepareDelivery(second, { state: 'completed' })
    store.acknowledgeDeliveryFile(fileAck(secondDelivery))
    assert.throws(() => store.acknowledgeDelivery(ack(secondDelivery)), /ack-out-of-order/)
    assert.equal(store.getStatus().appliedSequence, 0)
    store.acknowledgeDeliveryFile(fileAck(firstDelivery))
    store.acknowledgeDelivery(ack(firstDelivery))
    store.acknowledgeDelivery(ack(secondDelivery))
    assert.equal(store.getStatus().appliedSequence, 2)
    assert.deepEqual(store.getStatus().appliedDelivery, secondDelivery)
  })

  it('retains file receipts after payload pruning and validates duplicate identity, size and SHA after restart', () => {
    const { store, clock, path, open } = fixture()
    const batch = enqueue(store, claim(store), null, 'cursor-1', [change('item-1', { lifecycle: 'open' })])
    assert.ok(batch)
    const delivery = store.prepareDelivery(batch, { text: 'Synthetic file retention fixture' })
    const receipt = fileAck(delivery)
    store.acknowledgeDeliveryFile(receipt)
    clock.at += 14 * 24 * 60 * 60_000
    store.prune()
    assert.equal(store.hasDeliveryFileReceipt(delivery), true)
    store.acknowledgeDelivery(ack(delivery))
    clock.at += 14 * 24 * 60 * 60_000
    store.prune()
    store.close()
    const restarted = open()
    assert.equal(restarted.hasDeliveryFileReceipt(delivery), true)
    assert.equal(restarted.acknowledgeDeliveryFile(receipt).duplicate, true)
    assert.equal(restarted.acknowledgeDelivery(ack(delivery)).duplicate, true)
    assert.throws(
      () => restarted.acknowledgeDeliveryFile({ ...receipt, fileSizeBytes: receipt.fileSizeBytes - 1 }),
      /file-size-mismatch/
    )
    assert.throws(
      () => restarted.acknowledgeDeliveryFile({ ...receipt, fileSha256: '0'.repeat(64) }),
      /file-sha256-mismatch/
    )
    assert.throws(
      () => restarted.acknowledgeDeliveryFile({ ...receipt, payloadHash: batch.payloadHash }),
      /delivery-hash-mismatch/
    )
    assert.throws(
      () => restarted.hasDeliveryFileReceipt({ ...delivery, content: { altered: true } }),
      /file-receipt-mismatch/
    )
    const database = new DatabaseSync(path)
    assert.equal(database.prepare('SELECT count(*) AS count FROM relay_delivery').get()?.count, 0)
    assert.equal(database.prepare('SELECT count(*) AS count FROM relay_delivery_file_receipt').get()?.count, 1)
    assert.equal(database.prepare('SELECT count(*) AS count FROM relay_delivery_page_receipt').get()?.count, 0)
    database.close()
  })
})
