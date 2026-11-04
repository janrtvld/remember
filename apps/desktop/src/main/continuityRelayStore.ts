import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type Lease = { owner: string; token: number; expiresAt: number }

export type RelayChange = {
  sourceRef: { kind: string; id: string }
  operation: 'created' | 'updated' | 'deleted'
  availability: 'available' | 'not_found'
  record: Record<string, unknown> | null
  sourceDetails?: Record<string, unknown>
  archiveVersionHash?: string
  readAt: number
  changeObservedAt: number
  readContentHash: string | null
  historicalVersionGuaranteed: false
  origin: 'source' | 'relay'
  eligibleForWorkUpdate: boolean
}

export type RelayState = {
  sources: Record<string, RelayChange>
  focus: RelayChange[]
  open: RelayChange[]
  completed: RelayChange[]
  abandoned: RelayChange[]
  superseded: RelayChange[]
  blockers: RelayChange[]
  uncertainties: string[]
  projectionLimits?: { historicalSourcesPerKind: number; allOpenWorkItems: true; allActiveBlockers: true }
}

export type RelayRetraction = {
  sourceRef: RelayChange['sourceRef']
  reason: 'relay-origin' | 'ineligible'
}

export type RelayBatch = {
  schemaVersion: 1
  kind: 'remember.context.batch'
  profileId: string
  consumerId: string
  batchId: string
  sequence: number
  createdAt: number
  sourceCursorBefore: string | null
  sourceCursorAfter: string
  baseline: boolean
  synthetic: boolean
  changes: RelayChange[]
  // Persisted batches created before reclassification support have no retractions field.
  retractions?: RelayRetraction[]
  snapshot: Record<string, unknown>
  state: RelayState
  payloadHash: string
}

export type RelayInput = {
  cursorBefore: string | null
  cursorAfter: string
  snapshot: Record<string, unknown>
  changes: RelayChange[]
  synthetic: boolean
  baseline?: boolean
}

export type RelayEmissionContext = {
  previousState: RelayState
  nextState: RelayState
  previousSnapshot: Record<string, unknown>
  input: RelayInput
}

export type RelayDelivery = {
  schemaVersion: 1
  kind: 'remember.context.delivery'
  hashAlgorithm: 'sha256-canonical-json-v1'
  batchId: string
  sequence: number
  consumerId: string
  sourcePayloadHash: string
  content: Record<string, unknown>
  payloadHash: string
}

export type RelayDeliveryPage = {
  schemaVersion: 1
  kind: 'remember.context.delivery-page'
  batchId: string
  sequence: number
  consumerId: string
  deliveryPayloadHash: string
  pageIndex: number
  pageCount: number
  encoding: 'json-string-fragment'
  content: string
  pageHash: string
}

type Acknowledgement = { batchId: string; payloadHash: string; sequence: number; consumerId: string }
export type RelayDeliveryFileAcknowledgement = Acknowledgement & { fileSha256: string; fileSizeBytes: number }
type FileReceiptRow = {
  batch_id: string
  sequence: number
  delivery_payload_hash: string
  file_sha256: string
  file_size_bytes: number
  acknowledged_at: number
}
type PagingRow = {
  batch_id: string
  sequence: number
  consumer_id: string
  delivery_payload_hash: string
  page_count: number
}
type PageRow = { batch_id: string; page_index: number; page_hash: string; payload_json: string }
type DeliveryRow = {
  sequence: number
  batch_id: string
  source_payload_hash: string
  payload_hash: string
  payload_json: string
  acknowledged_at: number | null
}

type MetadataRow = {
  schema_version: number
  profile_id: string
  consumer_id: string
  cursor: string | null
  sequence: number
  applied_sequence: number
  ingested_state_json: string
  applied_state_json: string
  snapshot_json: string
}

type LeaseRow = { owner: string | null; token: number; expires_at: number }
type BatchRow = {
  sequence: number
  batch_id: string
  payload_hash: string
  payload_json: string
  attempts: number
  next_retry_at: number
  acknowledged_at: number | null
}

const SCHEMA_VERSION = 1
const INITIAL_RETRY_MS = 1_000
const MAX_RETRY_MS = 30_000
const RETENTION_MS = 14 * 24 * 60 * 60_000
const EPHEMERAL_LIMIT = 50
const DELIVERY_PAGE_BYTES = 5_500

export function createRelayStore(options: {
  path: string
  profileId: string
  consumerId: string
  now?: () => number
  shouldEmitBatch?: (context: RelayEmissionContext) => boolean
}) {
  requireText(options.profileId, 'profile-id')
  requireText(options.consumerId, 'consumer-id')
  requireText(options.path, 'database-path')
  rejectUnsafeFile(options.path)
  mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 })
  const database = new DatabaseSync(options.path)
  const now = options.now ?? Date.now
  let closed = false

  function transaction<T>(operation: () => T) {
    database.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      database.exec('COMMIT')
      return result
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  function metadata() {
    return database.prepare('SELECT * FROM relay_metadata WHERE id = 1').get() as MetadataRow
  }

  function leaseRow() {
    return database.prepare('SELECT * FROM relay_lease WHERE id = 1').get() as LeaseRow
  }

  function requireLease(lease: Lease, at: number) {
    const current = leaseRow()
    if (!current.owner || current.owner !== lease.owner || current.token !== lease.token || current.expires_at <= at) {
      throw new Error('relay-lease-expired-or-replaced')
    }
    return current
  }

  function sourceStatus(change: RelayChange) {
    if (change.origin === 'relay') return 'relay-origin'
    if (!change.eligibleForWorkUpdate) return 'ineligible'
    if (change.operation === 'deleted') return 'deleted'
    return change.availability
  }

  function archiveChange(change: RelayChange, at: number) {
    const status = sourceStatus(change)
    const key = sourceKey(change)
    let archived = change
    if (status === 'available') {
      const versionHash = hashPayload({ record: change.record, sourceDetails: change.sourceDetails ?? {} })
      archived = { ...change, archiveVersionHash: versionHash }
      database
        .prepare(`INSERT INTO relay_source_version (source_key, version_hash, source_json, archived_at, expires_at)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT (source_key, version_hash) DO UPDATE SET expires_at = excluded.expires_at`)
        .run(key, versionHash, canonicalJSON(archived), at, at + RETENTION_MS)
    }
    database
      .prepare(`INSERT INTO relay_source_state (source_key, status, lifecycle, updated_at)
        VALUES (?, ?, ?, ?) ON CONFLICT (source_key) DO UPDATE SET
        status = excluded.status, lifecycle = excluded.lifecycle, updated_at = excluded.updated_at`)
      .run(key, status, typeof change.record?.lifecycle === 'string' ? change.record.lifecycle : null, at)
    return archived
  }

  function pruneInside(at: number) {
    const batches = database
      .prepare('DELETE FROM relay_batch WHERE acknowledged_at IS NOT NULL AND acknowledged_at <= ?')
      .run(at - RETENTION_MS).changes
    const sourceVersions = database.prepare('DELETE FROM relay_source_version WHERE expires_at <= ?').run(at).changes
    database
      .prepare(`DELETE FROM relay_delivery_page WHERE batch_id IN (
      SELECT batch_id FROM relay_delivery WHERE acknowledged_at IS NOT NULL AND acknowledged_at <= ?)`)
      .run(at - RETENTION_MS)
    database
      .prepare('DELETE FROM relay_delivery WHERE acknowledged_at IS NOT NULL AND acknowledged_at <= ?')
      .run(at - RETENTION_MS)
    return { batches: Number(batches), sourceVersions: Number(sourceVersions) }
  }

  try {
    chmodSync(options.path, 0o600)
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS relay_metadata (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL,
        profile_id TEXT NOT NULL,
        consumer_id TEXT NOT NULL,
        cursor TEXT,
        sequence INTEGER NOT NULL DEFAULT 0,
        applied_sequence INTEGER NOT NULL DEFAULT 0,
        ingested_state_json TEXT NOT NULL,
        applied_state_json TEXT NOT NULL,
        snapshot_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS relay_lease (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        owner TEXT,
        token INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS relay_batch (
        sequence INTEGER PRIMARY KEY,
        batch_id TEXT NOT NULL UNIQUE,
        payload_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER NOT NULL,
        acknowledged_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS relay_batch_pending ON relay_batch(acknowledged_at, sequence);
      CREATE TABLE IF NOT EXISTS relay_source_version (
        source_key TEXT NOT NULL,
        version_hash TEXT NOT NULL,
        source_json TEXT NOT NULL,
        archived_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (source_key, version_hash)
      );
      CREATE INDEX IF NOT EXISTS relay_source_expiry ON relay_source_version(expires_at);
      CREATE TABLE IF NOT EXISTS relay_source_state (
        source_key TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        lifecycle TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS relay_receipt (
        sequence INTEGER PRIMARY KEY,
        batch_id TEXT NOT NULL UNIQUE,
        payload_hash TEXT NOT NULL,
        acknowledged_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS relay_storage_migration (id INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS relay_delivery (
        sequence INTEGER PRIMARY KEY,
        batch_id TEXT NOT NULL UNIQUE,
        source_payload_hash TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        acknowledged_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS relay_delivery_receipt (
        sequence INTEGER PRIMARY KEY,
        batch_id TEXT NOT NULL UNIQUE,
        source_payload_hash TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        acknowledged_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS relay_delivery_paging (
        batch_id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL,
        consumer_id TEXT NOT NULL,
        delivery_payload_hash TEXT NOT NULL,
        page_count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS relay_delivery_page (
        batch_id TEXT NOT NULL,
        page_index INTEGER NOT NULL,
        page_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (batch_id, page_index)
      );
      CREATE TABLE IF NOT EXISTS relay_delivery_page_receipt (
        batch_id TEXT NOT NULL,
        page_index INTEGER NOT NULL,
        delivery_payload_hash TEXT NOT NULL,
        page_hash TEXT NOT NULL,
        acknowledged_at INTEGER NOT NULL,
        PRIMARY KEY (batch_id, page_index)
      );
      CREATE TABLE IF NOT EXISTS relay_delivery_file_receipt (
        batch_id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL,
        delivery_payload_hash TEXT NOT NULL,
        file_sha256 TEXT NOT NULL,
        file_size_bytes INTEGER NOT NULL,
        acknowledged_at INTEGER NOT NULL
      );
    `)
    transaction(() => {
      const saved = metadata()
      if (saved) {
        if (saved.schema_version !== SCHEMA_VERSION) throw new Error('relay-schema-version-mismatch')
        if (saved.profile_id !== options.profileId) throw new Error('relay-profile-mismatch')
        if (saved.consumer_id !== options.consumerId) throw new Error('relay-consumer-mismatch')
      } else {
        const emptyState = canonicalJSON(projectState({}))
        database
          .prepare(`INSERT INTO relay_metadata
            (id, schema_version, profile_id, consumer_id, ingested_state_json, applied_state_json, snapshot_json)
            VALUES (1, ?, ?, ?, ?, ?, '{}')`)
          .run(SCHEMA_VERSION, options.profileId, options.consumerId, emptyState, emptyState)
        database.prepare('INSERT INTO relay_lease (id) VALUES (1)').run()
      }
      if (!database.prepare('SELECT id FROM relay_storage_migration WHERE id = 1').get()) {
        // Seed additive indexes without rewriting previously delivered payloads or their hashes.
        for (const row of database.prepare('SELECT * FROM relay_batch ORDER BY sequence').iterate()) {
          const batch = readBatch(row as BatchRow)
          for (const change of batch.changes) archiveChange(change, batch.createdAt)
        }
        database.exec(`INSERT OR IGNORE INTO relay_receipt
          SELECT sequence, batch_id, payload_hash, acknowledged_at FROM relay_batch WHERE acknowledged_at IS NOT NULL`)
        database.prepare('INSERT INTO relay_storage_migration (id) VALUES (1)').run()
      }
      if (!database.prepare('SELECT id FROM relay_storage_migration WHERE id = 2').get()) {
        // Recover known safe labels from retained payloads before pruning. Never rewrite a frozen batch or delivery.
        const snapshot = JSON.parse(metadata().snapshot_json) as Record<string, unknown>
        const previous = retainPrivacyOmissions({}, snapshot, [])
        let recovered = previous
        for (const row of database.prepare('SELECT * FROM relay_batch ORDER BY sequence').iterate()) {
          const batch = readBatch(row as BatchRow)
          recovered = retainPrivacyOmissions(
            recovered,
            { privacyOmissions: batch.snapshot.privacyOmissions ?? [] },
            batch.changes
          )
        }
        for (const row of database.prepare('SELECT * FROM relay_delivery ORDER BY sequence').iterate()) {
          const delivery = readDelivery(row as DeliveryRow)
          recovered = retainPrivacyOmissions(
            recovered,
            { privacyOmissions: delivery.content.privacyOmissions ?? [] },
            []
          )
        }
        const merged = retainPrivacyOmissions(recovered, snapshot, [])
        if (canonicalJSON(previous.privacyOmissions ?? []) !== canonicalJSON(merged.privacyOmissions ?? [])) {
          merged.privacyCorrectionPending = true
        }
        database.prepare('UPDATE relay_metadata SET snapshot_json = ? WHERE id = 1').run(canonicalJSON(merged))
        database.prepare('INSERT INTO relay_storage_migration (id) VALUES (2)').run()
      }
      pruneInside(now())
    })
  } catch (error) {
    database.close()
    throw error
  }

  function getStatus() {
    return transaction(() => {
      const saved = metadata()
      const lease = leaseRow()
      const pending = database
        .prepare('SELECT count(*) AS count FROM relay_batch WHERE acknowledged_at IS NULL')
        .get() as { count: number }
      const oldest = database
        .prepare('SELECT next_retry_at FROM relay_batch WHERE acknowledged_at IS NULL ORDER BY sequence LIMIT 1')
        .get() as { next_retry_at: number } | undefined
      const received = database
        .prepare(`SELECT r.*, d.payload_json FROM relay_delivery_receipt r
        LEFT JOIN relay_delivery d ON d.sequence = r.sequence ORDER BY r.sequence DESC LIMIT 1`)
        .get() as (DeliveryRow & { payload_json: string | null }) | undefined
      return {
        schemaVersion: SCHEMA_VERSION,
        profileId: saved.profile_id,
        consumerId: saved.consumer_id,
        cursor: saved.cursor,
        sequence: saved.sequence,
        pendingCount: pending.count,
        appliedSequence: saved.applied_sequence,
        nextRetryAt: oldest?.next_retry_at ?? null,
        lease: lease.owner ? { owner: lease.owner, token: lease.token, expiresAt: lease.expires_at } : null,
        projection: JSON.parse(saved.ingested_state_json) as RelayState,
        appliedState: JSON.parse(saved.applied_state_json) as RelayState,
        appliedStateMeaning:
          'Internal source state acknowledged by transport; appliedDelivery is the exact content received by the parent.',
        appliedDelivery: received?.payload_json ? readDelivery(received as DeliveryRow) : null,
        appliedDeliveryReceipt: received
          ? {
              batchId: received.batch_id,
              sequence: received.sequence,
              payloadHash: received.payload_hash,
              sourcePayloadHash: received.source_payload_hash,
              acknowledgedAt: received.acknowledged_at,
            }
          : null,
        snapshot: JSON.parse(saved.snapshot_json) as Record<string, unknown>,
        retention: {
          sourceVersionsMs: RETENTION_MS,
          acknowledgedPayloadsMs: RETENTION_MS,
          ephemeralPerKind: EPHEMERAL_LIMIT,
        },
      }
    })
  }

  function claimLease(owner: string, ttlMs: number) {
    requireText(owner, 'lease-owner')
    requirePositiveInteger(ttlMs, 'lease-ttl')
    return transaction(() => {
      const at = now()
      const current = leaseRow()
      if (current.owner && current.expires_at > at) return null
      const lease: Lease = { owner, token: current.token + 1, expiresAt: at + ttlMs }
      database
        .prepare('UPDATE relay_lease SET owner = ?, token = ?, expires_at = ? WHERE id = 1')
        .run(lease.owner, lease.token, lease.expiresAt)
      return lease
    })
  }

  function renewLease(lease: Lease, ttlMs: number) {
    requirePositiveInteger(ttlMs, 'lease-ttl')
    return transaction(() => {
      const at = now()
      const current = requireLease(lease, at)
      const renewed: Lease = { owner: lease.owner, token: current.token, expiresAt: at + ttlMs }
      database.prepare('UPDATE relay_lease SET expires_at = ? WHERE id = 1').run(renewed.expiresAt)
      return renewed
    })
  }

  function releaseLease(lease: Lease) {
    return transaction(() => {
      const current = leaseRow()
      if (current.owner !== lease.owner || current.token !== lease.token) return false
      database.prepare('UPDATE relay_lease SET owner = NULL, expires_at = 0 WHERE id = 1').run()
      return true
    })
  }

  function enqueue(lease: Lease, input: RelayInput) {
    validateInput(input)
    return transaction(() => {
      const at = now()
      requireLease(lease, at)
      const saved = metadata()
      if (saved.cursor !== input.cursorBefore) throw new Error('relay-source-cursor-mismatch')
      const previous = JSON.parse(saved.ingested_state_json) as RelayState
      const previousSnapshot = JSON.parse(saved.snapshot_json) as Record<string, unknown>
      const snapshot = retainPrivacyOmissions(previousSnapshot, input.snapshot, input.changes)
      delete snapshot.privacyCorrectionPending
      const sources = { ...previous.sources }
      const retractions: RelayRetraction[] = []
      const archivedChanges: RelayChange[] = []
      let relevantCount = 0
      let requiresDelivery = input.baseline === true || previousSnapshot.privacyCorrectionPending === true
      for (const change of input.changes) {
        const key = sourceKey(change)
        const prior = database
          .prepare('SELECT status, lifecycle FROM relay_source_state WHERE source_key = ?')
          .get(key) as { status: string; lifecycle: string | null } | undefined
        const archived = archiveChange(change, at)
        archivedChanges.push(archived)
        if (change.origin === 'relay' || !change.eligibleForWorkUpdate) {
          if (Object.hasOwn(sources, key) || prior?.status === 'available') {
            delete sources[key]
            retractions.push({
              sourceRef: change.sourceRef,
              reason: change.origin === 'relay' ? 'relay-origin' : 'ineligible',
            })
          }
          continue
        }
        relevantCount += 1
        if (
          change.operation === 'deleted' ||
          change.availability === 'not_found' ||
          (prior && prior.status !== 'available') ||
          (change.sourceRef.kind === 'work_item' && (prior?.lifecycle ?? null) !== (change.record?.lifecycle ?? null))
        )
          requiresDelivery = true
        if (change.operation === 'deleted' || change.availability === 'not_found') delete sources[key]
        else sources[key] = archived
      }
      const state = projectState(boundedSources(sources))
      const stateJSON = canonicalJSON(state)
      const snapshotJSON = canonicalJSON(snapshot)
      let shouldEmit = requiresDelivery || retractions.length > 0
      if (!shouldEmit && (relevantCount > 0 || options.shouldEmitBatch)) {
        // A pure synchronous policy may suppress metadata-only pages. Keep its inputs detached from stored payloads.
        shouldEmit = options.shouldEmitBatch
          ? options.shouldEmitBatch(
              structuredClone({
                previousState: previous,
                nextState: state,
                previousSnapshot,
                input: { ...input, snapshot },
              })
            )
          : true
        if (typeof shouldEmit !== 'boolean') throw new Error('relay-invalid-emission-decision')
      }
      pruneInside(at)
      if (!shouldEmit) {
        database
          .prepare('UPDATE relay_metadata SET cursor = ?, ingested_state_json = ?, snapshot_json = ? WHERE id = 1')
          .run(input.cursorAfter, stateJSON, snapshotJSON)
        return null
      }

      // Source reads are current rows, not necessarily the version observed by the frozen changes page.
      const payload: Omit<RelayBatch, 'payloadHash'> = {
        schemaVersion: 1,
        kind: 'remember.context.batch',
        profileId: options.profileId,
        consumerId: options.consumerId,
        batchId: randomUUID(),
        sequence: saved.sequence + 1,
        createdAt: at,
        sourceCursorBefore: input.cursorBefore,
        sourceCursorAfter: input.cursorAfter,
        baseline: input.baseline ?? false,
        synthetic: input.synthetic,
        changes: archivedChanges,
        retractions,
        snapshot,
        state,
      }
      const batch: RelayBatch = { ...payload, payloadHash: hashPayload(payload) }
      const serialized = canonicalJSON(batch)
      database
        .prepare(`INSERT INTO relay_batch (sequence, batch_id, payload_hash, payload_json, next_retry_at)
          VALUES (?, ?, ?, ?, ?)`)
        .run(batch.sequence, batch.batchId, batch.payloadHash, serialized, at)
      database
        .prepare(`UPDATE relay_metadata
          SET cursor = ?, sequence = ?, ingested_state_json = ?, snapshot_json = ? WHERE id = 1`)
        .run(input.cursorAfter, batch.sequence, stateJSON, snapshotJSON)
      return JSON.parse(serialized) as RelayBatch
    })
  }

  function pendingBatches(): RelayBatch[] {
    return transaction(() => {
      const rows = database
        .prepare('SELECT * FROM relay_batch WHERE acknowledged_at IS NULL ORDER BY sequence')
        .all() as BatchRow[]
      return rows.map((row) => {
        const batch = readBatch(row)
        if (batch.profileId !== options.profileId || batch.consumerId !== options.consumerId) {
          throw new Error('relay-persisted-batch-identity-mismatch')
        }
        return batch
      })
    })
  }

  function offer(lease: Lease) {
    return transaction(() => {
      const at = now()
      requireLease(lease, at)
      const row = database
        .prepare('SELECT * FROM relay_batch WHERE acknowledged_at IS NULL ORDER BY sequence LIMIT 1')
        .get() as BatchRow | undefined
      if (!row || row.next_retry_at > at) return null
      const batch = readBatch(row)
      const delay = Math.min(INITIAL_RETRY_MS * 2 ** Math.min(row.attempts, 5), MAX_RETRY_MS)
      database
        .prepare('UPDATE relay_batch SET attempts = attempts + 1, next_retry_at = ? WHERE sequence = ?')
        .run(at + delay, row.sequence)
      return batch
    })
  }

  function validateAcknowledgement(ack: Acknowledgement) {
    requireText(ack.batchId, 'ack-batch-id')
    requireText(ack.payloadHash, 'ack-payload-hash')
    requirePositiveInteger(ack.sequence, 'ack-sequence')
    if (ack.consumerId !== options.consumerId) throw new Error('relay-ack-consumer-mismatch')
  }

  function acknowledge(ack: Acknowledgement) {
    validateAcknowledgement(ack)
    return transaction(() => acknowledgeInside(ack))
  }

  function acknowledgeInside(ack: Acknowledgement) {
    const row = database.prepare('SELECT * FROM relay_batch WHERE batch_id = ?').get(ack.batchId) as
      | BatchRow
      | undefined
    if (!row) {
      const receipt = database.prepare('SELECT * FROM relay_receipt WHERE batch_id = ?').get(ack.batchId) as
        | { sequence: number; payload_hash: string }
        | undefined
      if (!receipt) throw new Error('relay-ack-batch-not-found')
      if (receipt.payload_hash !== ack.payloadHash) throw new Error('relay-ack-payload-hash-mismatch')
      if (receipt.sequence !== ack.sequence) throw new Error('relay-ack-sequence-mismatch')
      return {
        acknowledged: true as const,
        duplicate: true,
        batchId: ack.batchId,
        sequence: ack.sequence,
        appliedSequence: metadata().applied_sequence,
      }
    }
    if (row.payload_hash !== ack.payloadHash) throw new Error('relay-ack-payload-hash-mismatch')
    if (row.sequence !== ack.sequence) throw new Error('relay-ack-sequence-mismatch')
    const batch = readBatch(row)
    const saved = metadata()
    if (row.acknowledged_at !== null) {
      return {
        acknowledged: true as const,
        duplicate: true,
        batchId: batch.batchId,
        sequence: batch.sequence,
        appliedSequence: saved.applied_sequence,
      }
    }
    if (row.sequence !== saved.applied_sequence + 1) throw new Error('relay-ack-out-of-order')
    database.prepare('UPDATE relay_batch SET acknowledged_at = ? WHERE sequence = ?').run(now(), row.sequence)
    database
      .prepare('INSERT INTO relay_receipt (sequence, batch_id, payload_hash, acknowledged_at) VALUES (?, ?, ?, ?)')
      .run(row.sequence, row.batch_id, row.payload_hash, now())
    database
      .prepare('UPDATE relay_metadata SET applied_sequence = ?, applied_state_json = ? WHERE id = 1')
      .run(row.sequence, canonicalJSON(batch.state))
    pruneInside(now())
    return {
      acknowledged: true as const,
      duplicate: false,
      batchId: batch.batchId,
      sequence: batch.sequence,
      appliedSequence: batch.sequence,
    }
  }

  function prepareDelivery(batch: RelayBatch, content: Record<string, unknown>) {
    if (!isRecord(content)) throw new Error('relay-invalid-delivery-content')
    canonicalJSON(content)
    const { payloadHash, ...sourcePayload } = batch
    if (hashPayload(sourcePayload) !== payloadHash) throw new Error('relay-delivery-source-integrity-failed')
    return transaction(() => {
      const existing = database.prepare('SELECT * FROM relay_delivery WHERE batch_id = ?').get(batch.batchId) as
        | DeliveryRow
        | undefined
      if (existing) {
        const delivery = readDelivery(existing)
        if (
          delivery.sourcePayloadHash !== payloadHash ||
          delivery.sequence !== batch.sequence ||
          delivery.consumerId !== batch.consumerId
        ) {
          throw new Error('relay-delivery-source-mismatch')
        }
        return delivery
      }
      const stored = database.prepare('SELECT * FROM relay_batch WHERE batch_id = ?').get(batch.batchId) as
        | BatchRow
        | undefined
      if (
        !stored ||
        stored.payload_hash !== payloadHash ||
        stored.sequence !== batch.sequence ||
        batch.consumerId !== options.consumerId
      ) {
        throw new Error('relay-delivery-source-mismatch')
      }
      readBatch(stored)
      if (stored.acknowledged_at !== null) throw new Error('relay-delivery-source-already-acknowledged')
      const payload: Omit<RelayDelivery, 'payloadHash'> = {
        schemaVersion: 1,
        kind: 'remember.context.delivery',
        hashAlgorithm: 'sha256-canonical-json-v1',
        batchId: batch.batchId,
        sequence: batch.sequence,
        consumerId: batch.consumerId,
        sourcePayloadHash: batch.payloadHash,
        content,
      }
      const delivery: RelayDelivery = { ...payload, payloadHash: hashDeliveryPayload(payload) }
      const serialized = canonicalJSON(delivery, true)
      database
        .prepare(`INSERT INTO relay_delivery (sequence, batch_id, source_payload_hash, payload_hash, payload_json)
        VALUES (?, ?, ?, ?, ?)`)
        .run(delivery.sequence, delivery.batchId, delivery.sourcePayloadHash, delivery.payloadHash, serialized)
      return JSON.parse(serialized) as RelayDelivery
    })
  }

  function acknowledgeDelivery(ack: Acknowledgement) {
    validateAcknowledgement(ack)
    return transaction(() => {
      const receipt = database.prepare('SELECT * FROM relay_delivery_receipt WHERE batch_id = ?').get(ack.batchId) as
        | { sequence: number; payload_hash: string; source_payload_hash: string }
        | undefined
      const row = database.prepare('SELECT * FROM relay_delivery WHERE batch_id = ?').get(ack.batchId) as
        | DeliveryRow
        | undefined
      const expected = receipt ?? row
      if (!expected) throw new Error('relay-delivery-not-prepared')
      if (expected.payload_hash !== ack.payloadHash) throw new Error('relay-delivery-hash-mismatch')
      if (expected.sequence !== ack.sequence) throw new Error('relay-delivery-sequence-mismatch')
      if (row) readDelivery(row)
      if (receipt)
        return {
          acknowledged: true as const,
          duplicate: true,
          batchId: ack.batchId,
          sequence: ack.sequence,
          appliedSequence: metadata().applied_sequence,
          sourcePayloadHash: receipt.source_payload_hash,
        }
      const paging = database.prepare('SELECT * FROM relay_delivery_paging WHERE batch_id = ?').get(ack.batchId) as
        | PagingRow
        | undefined
      const fileReceipt = database
        .prepare('SELECT * FROM relay_delivery_file_receipt WHERE batch_id = ?')
        .get(ack.batchId) as FileReceiptRow | undefined
      if (fileReceipt) {
        if (!row || fileReceipt.sequence !== ack.sequence || fileReceipt.delivery_payload_hash !== ack.payloadHash) {
          throw new Error('relay-delivery-file-receipt-mismatch')
        }
        requireFileMatches(readDelivery(row), fileReceipt.file_sha256, fileReceipt.file_size_bytes)
      } else {
        if (!paging) throw new Error('relay-delivery-pages-not-prepared')
        if (pageReceiptCount(ack.batchId) !== paging.page_count)
          throw new Error('relay-delivery-pages-not-acknowledged')
      }
      const result = acknowledgeInside({ ...ack, payloadHash: expected.source_payload_hash })
      database.prepare('UPDATE relay_delivery SET acknowledged_at = ? WHERE sequence = ?').run(now(), ack.sequence)
      database
        .prepare(`INSERT INTO relay_delivery_receipt
        (sequence, batch_id, source_payload_hash, payload_hash, acknowledged_at) VALUES (?, ?, ?, ?, ?)`)
        .run(ack.sequence, ack.batchId, expected.source_payload_hash, ack.payloadHash, now())
      return { ...result, duplicate: false, sourcePayloadHash: expected.source_payload_hash }
    })
  }

  function acknowledgeDeliveryFile(ack: RelayDeliveryFileAcknowledgement) {
    validateAcknowledgement(ack)
    if (!/^[a-f0-9]{64}$/.test(ack.fileSha256)) throw new Error('relay-invalid-delivery-file-sha256')
    requirePositiveInteger(ack.fileSizeBytes, 'delivery-file-size')
    return transaction(() => {
      const receipt = database
        .prepare('SELECT * FROM relay_delivery_file_receipt WHERE batch_id = ?')
        .get(ack.batchId) as FileReceiptRow | undefined
      const row = database.prepare('SELECT * FROM relay_delivery WHERE batch_id = ?').get(ack.batchId) as
        | DeliveryRow
        | undefined
      if (!receipt && !row) throw new Error('relay-delivery-missing-or-expired')
      if ((receipt?.delivery_payload_hash ?? row?.payload_hash) !== ack.payloadHash)
        throw new Error('relay-delivery-hash-mismatch')
      if ((receipt?.sequence ?? row?.sequence) !== ack.sequence) throw new Error('relay-delivery-sequence-mismatch')
      if (row) requireFileMatches(readDelivery(row), ack.fileSha256, ack.fileSizeBytes)
      if (receipt) {
        if (receipt.file_sha256 !== ack.fileSha256) throw new Error('relay-delivery-file-sha256-mismatch')
        if (receipt.file_size_bytes !== ack.fileSizeBytes) throw new Error('relay-delivery-file-size-mismatch')
      } else {
        database
          .prepare(`INSERT INTO relay_delivery_file_receipt
          (batch_id, sequence, delivery_payload_hash, file_sha256, file_size_bytes, acknowledged_at)
          VALUES (?, ?, ?, ?, ?, ?)`)
          .run(ack.batchId, ack.sequence, ack.payloadHash, ack.fileSha256, ack.fileSizeBytes, now())
        database
          .prepare(
            'UPDATE relay_batch SET next_retry_at = ?, attempts = 0 WHERE batch_id = ? AND acknowledged_at IS NULL'
          )
          .run(now(), ack.batchId)
      }
      return {
        acknowledged: true as const,
        duplicate: !!receipt,
        batchId: ack.batchId,
        sequence: ack.sequence,
        payloadHash: ack.payloadHash,
        fileSha256: ack.fileSha256,
        fileSizeBytes: ack.fileSizeBytes,
        readyForFinalAcknowledgement: true as const,
      }
    })
  }

  function hasDeliveryFileReceipt(delivery: RelayDelivery) {
    const { payloadHash, ...payload } = delivery
    if (hashDeliveryPayload(payload) !== payloadHash || delivery.consumerId !== options.consumerId) {
      throw new Error('relay-delivery-file-receipt-mismatch')
    }
    return transaction(() => {
      const receipt = database
        .prepare('SELECT * FROM relay_delivery_file_receipt WHERE batch_id = ?')
        .get(delivery.batchId) as FileReceiptRow | undefined
      if (!receipt) return false
      if (receipt.sequence !== delivery.sequence || receipt.delivery_payload_hash !== payloadHash) {
        throw new Error('relay-delivery-file-receipt-mismatch')
      }
      requireFileMatches(delivery, receipt.file_sha256, receipt.file_size_bytes)
      return true
    })
  }

  function requireStoredDelivery(delivery: RelayDelivery) {
    const { payloadHash, ...payload } = delivery
    const row = database.prepare('SELECT * FROM relay_delivery WHERE batch_id = ?').get(delivery.batchId) as
      | DeliveryRow
      | undefined
    if (!row) throw new Error('relay-delivery-missing-or-expired')
    const stored = readDelivery(row)
    if (
      hashDeliveryPayload(payload) !== payloadHash ||
      payloadHash !== stored.payloadHash ||
      delivery.sequence !== stored.sequence ||
      delivery.consumerId !== options.consumerId
    ) {
      throw new Error('relay-delivery-paging-mismatch')
    }
    return { row, delivery: stored }
  }

  function pageReceiptCount(batchId: string) {
    return (
      database.prepare('SELECT count(*) AS count FROM relay_delivery_page_receipt WHERE batch_id = ?').get(batchId) as {
        count: number
      }
    ).count
  }

  function prepareDeliveryPages(delivery: RelayDelivery) {
    return transaction(() => {
      const stored = requireStoredDelivery(delivery)
      const paging = database.prepare('SELECT * FROM relay_delivery_paging WHERE batch_id = ?').get(delivery.batchId) as
        | PagingRow
        | undefined
      if (paging) {
        const rows = database
          .prepare('SELECT * FROM relay_delivery_page WHERE batch_id = ? ORDER BY page_index')
          .all(delivery.batchId) as PageRow[]
        if (rows.length !== paging.page_count) throw new Error('relay-delivery-pages-missing-or-expired')
        return rows.map((row) => readDeliveryPage(row, paging))
      }
      if (stored.row.acknowledged_at !== null) throw new Error('relay-delivery-already-acknowledged')
      const pages = splitDelivery(stored.delivery)
      database
        .prepare(`INSERT INTO relay_delivery_paging
        (batch_id, sequence, consumer_id, delivery_payload_hash, page_count) VALUES (?, ?, ?, ?, ?)`)
        .run(delivery.batchId, delivery.sequence, delivery.consumerId, delivery.payloadHash, pages.length)
      const insert = database.prepare(
        'INSERT INTO relay_delivery_page (batch_id, page_index, page_hash, payload_json) VALUES (?, ?, ?, ?)'
      )
      for (const page of pages) insert.run(page.batchId, page.pageIndex, page.pageHash, canonicalJSON(page, true))
      return pages.map((page) => JSON.parse(canonicalJSON(page, true)) as RelayDeliveryPage)
    })
  }

  function getNextDeliveryPage(delivery: RelayDelivery) {
    return transaction(() => {
      requireStoredDelivery(delivery)
      const paging = database.prepare('SELECT * FROM relay_delivery_paging WHERE batch_id = ?').get(delivery.batchId) as
        | PagingRow
        | undefined
      if (!paging) throw new Error('relay-delivery-pages-not-prepared')
      const next = pageReceiptCount(delivery.batchId) + 1
      if (next > paging.page_count) return null
      const row = database
        .prepare('SELECT * FROM relay_delivery_page WHERE batch_id = ? AND page_index = ?')
        .get(delivery.batchId, next) as PageRow | undefined
      if (!row) throw new Error('relay-delivery-page-missing-or-expired')
      return readDeliveryPage(row, paging)
    })
  }

  function acknowledgeDeliveryPage(ack: Acknowledgement & { pageIndex: number; pageHash: string }) {
    validateAcknowledgement(ack)
    requirePositiveInteger(ack.pageIndex, 'page-index')
    requireText(ack.pageHash, 'page-hash')
    return transaction(() => {
      const paging = database.prepare('SELECT * FROM relay_delivery_paging WHERE batch_id = ?').get(ack.batchId) as
        | PagingRow
        | undefined
      if (!paging) throw new Error('relay-delivery-pages-not-prepared')
      if (paging.delivery_payload_hash !== ack.payloadHash) throw new Error('relay-delivery-hash-mismatch')
      if (paging.sequence !== ack.sequence) throw new Error('relay-delivery-sequence-mismatch')
      if (ack.pageIndex > paging.page_count) throw new Error('relay-delivery-page-out-of-range')
      const receipt = database
        .prepare('SELECT page_hash FROM relay_delivery_page_receipt WHERE batch_id = ? AND page_index = ?')
        .get(ack.batchId, ack.pageIndex) as { page_hash: string } | undefined
      const row = database
        .prepare('SELECT * FROM relay_delivery_page WHERE batch_id = ? AND page_index = ?')
        .get(ack.batchId, ack.pageIndex) as PageRow | undefined
      if (!receipt && !row) throw new Error('relay-delivery-page-missing-or-expired')
      if ((receipt?.page_hash ?? row?.page_hash) !== ack.pageHash) throw new Error('relay-delivery-page-hash-mismatch')
      if (row) readDeliveryPage(row, paging)
      let received = pageReceiptCount(ack.batchId)
      if (!receipt) {
        if (ack.pageIndex !== received + 1) throw new Error('relay-delivery-page-out-of-order')
        database
          .prepare(`INSERT INTO relay_delivery_page_receipt
          (batch_id, page_index, delivery_payload_hash, page_hash, acknowledged_at) VALUES (?, ?, ?, ?, ?)`)
          .run(ack.batchId, ack.pageIndex, ack.payloadHash, ack.pageHash, now())
        database
          .prepare(
            'UPDATE relay_batch SET next_retry_at = ?, attempts = 0 WHERE batch_id = ? AND acknowledged_at IS NULL'
          )
          .run(now(), ack.batchId)
        received += 1
      }
      return {
        acknowledged: true as const,
        duplicate: !!receipt,
        batchId: ack.batchId,
        sequence: ack.sequence,
        pageIndex: ack.pageIndex,
        pageCount: paging.page_count,
        acknowledgedPages: received,
        nextPageIndex: received < paging.page_count ? received + 1 : null,
        readyForFinalAcknowledgement: received === paging.page_count,
      }
    })
  }

  function readArchive(request: { sourceRef: RelayChange['sourceRef']; versionHash: string }) {
    requireText(request.sourceRef.kind, 'archive-source-kind')
    requireText(request.sourceRef.id, 'archive-source-id')
    requireText(request.versionHash, 'archive-version-hash')
    return transaction(() => {
      const key = `${request.sourceRef.kind}:${request.sourceRef.id}`
      const latest = database
        .prepare('SELECT status, updated_at FROM relay_source_state WHERE source_key = ?')
        .get(key) as { status: string; updated_at: number } | undefined
      const row = database
        .prepare(`SELECT * FROM relay_source_version
        WHERE source_key = ? AND version_hash = ? AND expires_at > ?`)
        .get(key, request.versionHash, now()) as
        | { source_json: string; archived_at: number; expires_at: number }
        | undefined
      const source = row ? (JSON.parse(row.source_json) as RelayChange) : null
      if (
        source &&
        hashPayload({ record: source.record, sourceDetails: source.sourceDetails ?? {} }) !== request.versionHash
      ) {
        throw new Error('relay-archive-integrity-failed')
      }
      return {
        kind: 'remember.context.archived-source' as const,
        historical: true as const,
        isCurrent: false as const,
        sourceRef: request.sourceRef,
        versionHash: request.versionHash,
        availability: row ? ('available' as const) : ('missing_or_expired' as const),
        retracted: latest !== undefined && latest.status !== 'available',
        retractionReason: latest && latest.status !== 'available' ? latest.status : null,
        latestKnownAt: latest?.updated_at ?? null,
        archivedAt: row?.archived_at ?? null,
        expiresAt: row?.expires_at ?? null,
        source,
      }
    })
  }

  function prune() {
    return transaction(() => pruneInside(now()))
  }

  function close() {
    if (closed) return
    database.close()
    closed = true
  }

  return {
    getStatus,
    claimLease,
    renewLease,
    releaseLease,
    enqueue,
    pendingBatches,
    offer,
    acknowledge,
    prepareDelivery,
    acknowledgeDelivery,
    acknowledgeDeliveryFile,
    hasDeliveryFileReceipt,
    prepareDeliveryPages,
    getNextDeliveryPage,
    acknowledgeDeliveryPage,
    readArchive,
    prune,
    close,
  }
}

function retainPrivacyOmissions(
  previousSnapshot: Record<string, unknown>,
  currentSnapshot: Record<string, unknown>,
  changes: RelayChange[]
) {
  type Omission = {
    sourceRef: RelayChange['sourceRef']
    reason: 'authentication_surface' | 'authentication_source_reference'
    detection: 'preview_metadata' | 'source_metadata' | 'delivery_metadata' | 'source_reference'
  }
  const omissions = new Map<string, Omission>()
  function retain(value: unknown) {
    if (!isRecord(value)) return
    const entry = value as Record<string, unknown>
    if (!isRecord(entry.sourceRef)) return
    const sourceRef = entry.sourceRef as Record<string, unknown>
    if (
      typeof sourceRef.kind !== 'string' ||
      !sourceRef.kind.trim() ||
      typeof sourceRef.id !== 'string' ||
      !sourceRef.id.trim()
    )
      return
    if (entry.reason !== 'authentication_surface' && entry.reason !== 'authentication_source_reference') return
    const detection =
      entry.detection === 'preview_metadata' ||
      entry.detection === 'source_metadata' ||
      entry.detection === 'delivery_metadata' ||
      entry.detection === 'source_reference'
        ? entry.detection
        : entry.reason === 'authentication_source_reference'
          ? 'source_reference'
          : 'delivery_metadata'
    const identity = { kind: sourceRef.kind, id: sourceRef.id }
    const key = JSON.stringify([identity.kind, identity.id])
    if (!omissions.has(key)) omissions.set(key, { sourceRef: identity, reason: entry.reason, detection })
  }
  // Identity-only history has no automatic expiry or clear: a later harmless read cannot declassify old derived text.
  for (const snapshot of [previousSnapshot, currentSnapshot]) {
    for (const entry of Array.isArray(snapshot.privacyOmissions) ? snapshot.privacyOmissions : []) retain(entry)
  }
  for (const change of changes) {
    const redaction = (change as RelayChange & { redaction?: Record<string, unknown> }).redaction
    if (isRecord(redaction)) retain({ ...redaction, sourceRef: change.sourceRef })
    retain({ sourceRef: change.sourceRef, reason: change.record?.omissionReason, detection: 'delivery_metadata' })
  }
  const snapshot = { ...currentSnapshot }
  delete snapshot.privacyOmissions
  if (omissions.size > 0)
    snapshot.privacyOmissions = [...omissions.values()].sort((a, b) =>
      compareCodepoints(JSON.stringify(a.sourceRef), JSON.stringify(b.sourceRef))
    )
  return snapshot
}

function boundedSources(sources: Record<string, RelayChange>) {
  const counts = new Map<string, number>()
  const entries = Object.entries(sources).sort(([, a], [, b]) => sourceTime(b) - sourceTime(a))
  const openIds = new Set(
    entries
      .filter(([, change]) => change.sourceRef.kind === 'work_item' && change.record?.lifecycle === 'open')
      .map(([, change]) => change.sourceRef.id)
  )
  const retained = entries.filter(([, change]) => {
    if (change.sourceRef.kind === 'work_item' && change.record?.lifecycle === 'open') return true
    if (
      change.sourceRef.kind === 'work_item_observation' &&
      change.record?.kind === 'blocked' &&
      change.record.dismissed_at == null &&
      change.record.dismissedAt == null &&
      openIds.has(String(change.record.work_item_id ?? change.record.workItemId))
    )
      return true
    const group =
      change.sourceRef.kind === 'work_item' ? `work_item:${String(change.record?.lifecycle)}` : change.sourceRef.kind
    const count = counts.get(group) ?? 0
    counts.set(group, count + 1)
    return count < EPHEMERAL_LIMIT
  })
  return Object.fromEntries(retained)
}

function projectState(sources: Record<string, RelayChange>): RelayState {
  const all = Object.values(sources)
  const workItems = all.filter((change) => change.sourceRef.kind === 'work_item')
  const byLifecycle = (lifecycle: string) => workItems.filter((change) => change.record?.lifecycle === lifecycle)
  const open = byLifecycle('open')
  const openIds = new Set(open.map((change) => change.sourceRef.id))
  const blockers = all.filter((change) => {
    if (change.sourceRef.kind !== 'work_item_observation' || change.record?.kind !== 'blocked') return false
    if (change.record.dismissed_at != null || change.record.dismissedAt != null) return false
    const parent = change.record.work_item_id ?? change.record.workItemId
    return typeof parent === 'string' && openIds.has(parent)
  })
  return {
    sources,
    focus: all
      .filter((change) => ['context', 'focus'].includes(change.sourceRef.kind))
      .sort((a, b) => sourceTime(b) - sourceTime(a) || sourceKey(a).localeCompare(sourceKey(b)))
      .slice(0, 12),
    open,
    completed: byLifecycle('completed'),
    abandoned: byLifecycle('abandoned'),
    superseded: byLifecycle('superseded'),
    blockers,
    uncertainties: [
      'Focus contains observed activity; it does not establish a current intention or completed result.',
      'Inbox lifecycle and blocker observations are evidence, not independently confirmed personal instructions.',
      'The source feed observes net snapshots; source reads may be newer than the corresponding change page.',
      'Historical sources are bounded in this projection; omission is not deletion. Archived versions expire after 14 days.',
    ],
    projectionLimits: { historicalSourcesPerKind: EPHEMERAL_LIMIT, allOpenWorkItems: true, allActiveBlockers: true },
  }
}

function sourceTime(change: RelayChange) {
  const timestamp =
    change.record?.timestamp ??
    change.record?.started_at ??
    change.record?.startedAt ??
    change.record?.observed_at ??
    change.record?.updated_at
  return typeof timestamp === 'number' ? timestamp : change.changeObservedAt
}

function sourceKey(change: RelayChange) {
  return `${change.sourceRef.kind}:${change.sourceRef.id}`
}

function readBatch(row: BatchRow) {
  const batch = JSON.parse(row.payload_json) as RelayBatch
  const { payloadHash, ...payload } = batch
  if (
    row.payload_hash !== payloadHash ||
    hashPayload(payload) !== payloadHash ||
    batch.sequence !== row.sequence ||
    batch.batchId !== row.batch_id
  ) {
    throw new Error('relay-persisted-batch-integrity-failed')
  }
  return batch
}

function readDelivery(row: DeliveryRow) {
  const delivery = JSON.parse(row.payload_json) as RelayDelivery
  const { payloadHash, ...payload } = delivery
  if (
    payloadHash !== row.payload_hash ||
    hashDeliveryPayload(payload) !== payloadHash ||
    delivery.batchId !== row.batch_id ||
    delivery.sequence !== row.sequence ||
    delivery.sourcePayloadHash !== row.source_payload_hash
  ) {
    throw new Error('relay-delivery-integrity-failed')
  }
  return delivery
}

function splitDelivery(delivery: RelayDelivery) {
  const characters = Array.from(canonicalJSON(delivery, true))
  const metadata = {
    schemaVersion: 1 as const,
    kind: 'remember.context.delivery-page' as const,
    batchId: delivery.batchId,
    sequence: delivery.sequence,
    consumerId: delivery.consumerId,
    deliveryPayloadHash: delivery.payloadHash,
    encoding: 'json-string-fragment' as const,
  }
  const fragments: string[] = []
  let offset = 0
  while (offset < characters.length) {
    let low = 1
    let high = characters.length - offset
    let accepted = 0
    while (low <= high) {
      const length = Math.floor((low + high) / 2)
      const candidate = {
        ...metadata,
        pageIndex: Number.MAX_SAFE_INTEGER,
        pageCount: Number.MAX_SAFE_INTEGER,
        content: characters.slice(offset, offset + length).join(''),
        pageHash: '0'.repeat(64),
      }
      if (Buffer.byteLength(canonicalJSON(candidate, true), 'utf8') <= DELIVERY_PAGE_BYTES) {
        accepted = length
        low = length + 1
      } else high = length - 1
    }
    if (accepted === 0) throw new Error('relay-delivery-page-header-too-large')
    fragments.push(characters.slice(offset, offset + accepted).join(''))
    offset += accepted
  }
  return fragments.map((content, index): RelayDeliveryPage => {
    const payload = { ...metadata, pageIndex: index + 1, pageCount: fragments.length, content }
    return { ...payload, pageHash: hashDeliveryPayload(payload) }
  })
}

function readDeliveryPage(row: PageRow, paging: PagingRow) {
  const page = JSON.parse(row.payload_json) as RelayDeliveryPage
  const { pageHash, ...payload } = page
  if (
    pageHash !== row.page_hash ||
    hashDeliveryPayload(payload) !== pageHash ||
    page.batchId !== row.batch_id ||
    page.pageIndex !== row.page_index ||
    page.batchId !== paging.batch_id ||
    page.sequence !== paging.sequence ||
    page.consumerId !== paging.consumer_id ||
    page.deliveryPayloadHash !== paging.delivery_payload_hash ||
    page.pageCount !== paging.page_count ||
    page.encoding !== 'json-string-fragment' ||
    Buffer.byteLength(canonicalJSON(page, true), 'utf8') > DELIVERY_PAGE_BYTES
  ) {
    throw new Error('relay-delivery-page-integrity-failed')
  }
  return page
}

function hashPayload(value: unknown) {
  return createHash('sha256').update(canonicalJSON(value)).digest('hex')
}

export function hashDeliveryPayload(value: unknown) {
  return createHash('sha256').update(canonicalJSON(value, true)).digest('hex')
}

export function serializeDeliveryFile(delivery: RelayDelivery) {
  return `${canonicalJSON(delivery, true)}\n`
}

function requireFileMatches(delivery: RelayDelivery, fileSha256: string, fileSizeBytes: number) {
  const contents = serializeDeliveryFile(delivery)
  if (Buffer.byteLength(contents, 'utf8') !== fileSizeBytes) throw new Error('relay-delivery-file-size-mismatch')
  if (createHash('sha256').update(contents, 'utf8').digest('hex') !== fileSha256) {
    throw new Error('relay-delivery-file-sha256-mismatch')
  }
}

function canonicalJSON(value: unknown, ordinalKeys = false): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((child) => canonicalJSON(child, ordinalKeys)).join(',')}]`
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (ordinalKeys ? compareCodepoints(left, right) : left.localeCompare(right)))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJSON(child, ordinalKeys)}`)
      .join(',')}}`
  }
  throw new Error('relay-payload-must-be-json')
}

function compareCodepoints(left: string, right: string) {
  const a = Array.from(left, (character) => character.codePointAt(0) ?? 0)
  const b = Array.from(right, (character) => character.codePointAt(0) ?? 0)
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return a.length - b.length
}

function validateInput(input: RelayInput) {
  if (input.cursorBefore !== null) requireText(input.cursorBefore, 'source-cursor-before')
  requireText(input.cursorAfter, 'source-cursor-after')
  if (typeof input.synthetic !== 'boolean') throw new Error('relay-synthetic-flag-required')
  if (input.baseline !== undefined && typeof input.baseline !== 'boolean') throw new Error('relay-invalid-baseline')
  if (!isRecord(input.snapshot) || !Array.isArray(input.changes)) throw new Error('relay-invalid-input')
  for (const change of input.changes) {
    requireText(change.sourceRef?.kind, 'source-kind')
    requireText(change.sourceRef?.id, 'source-id')
    if (!['created', 'updated', 'deleted'].includes(change.operation)) throw new Error('relay-invalid-operation')
    if (!['available', 'not_found'].includes(change.availability)) throw new Error('relay-invalid-availability')
    if (!['source', 'relay'].includes(change.origin)) throw new Error('relay-invalid-origin')
    if (typeof change.eligibleForWorkUpdate !== 'boolean') throw new Error('relay-invalid-eligibility')
    if (change.historicalVersionGuaranteed !== false) throw new Error('relay-invalid-history-guarantee')
    if (!Number.isFinite(change.readAt) || !Number.isFinite(change.changeObservedAt)) {
      throw new Error('relay-invalid-source-time')
    }
    if (change.operation === 'deleted' || change.availability === 'not_found') {
      if (change.record !== null) throw new Error('relay-unavailable-source-must-have-null-record')
    } else if (!isRecord(change.record)) throw new Error('relay-available-source-must-have-record')
    if (change.readContentHash !== null) requireText(change.readContentHash, 'source-content-hash')
  }
  canonicalJSON({ ...input, baseline: input.baseline ?? false })
}

function isRecord(value: unknown) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function requireText(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`relay-invalid-${field}`)
}

function requirePositiveInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`relay-invalid-${field}`)
}

function rejectUnsafeFile(path: string) {
  try {
    const file = lstatSync(path)
    if (!file.isFile() || file.isSymbolicLink()) throw new Error('relay-database-must-be-regular-file')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
