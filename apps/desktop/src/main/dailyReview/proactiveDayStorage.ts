import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { deflateRawSync, inflateRawSync } from 'node:zlib'

const INLINE_LIMIT = 16_000
const PAYLOAD_LIMIT = 64 * 1024 * 1024
const FIELDS = ['lineage', 'provenance'] as const

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

/** Day projections share immutable provenance, rather than copying it on every task change. */
export class ProactiveDayStorage {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`CREATE TABLE IF NOT EXISTS proactive_day_payload (
      id TEXT PRIMARY KEY, compressed_json BLOB NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS proactive_day_storage_migration (
      id INTEGER PRIMARY KEY CHECK(id=1), after_rowid INTEGER
    ) STRICT;
    CREATE INDEX IF NOT EXISTS proactive_day_lineage_payload ON proactive_day_source (
      json_extract(snapshot_json,'$.lineage._payloadRef')
    );
    CREATE INDEX IF NOT EXISTS proactive_day_provenance_payload ON proactive_day_source (
      json_extract(snapshot_json,'$.provenance._payloadRef')
    );
    CREATE TRIGGER IF NOT EXISTS proactive_day_payload_immutable BEFORE UPDATE ON proactive_day_payload BEGIN
      SELECT RAISE(ABORT, 'proactive-day-payload-immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS proactive_day_payload_referenced BEFORE DELETE ON proactive_day_payload
    WHEN EXISTS (SELECT 1 FROM proactive_day_source WHERE
      json_extract(snapshot_json, '$.lineage._payloadRef') = OLD.id OR
      json_extract(snapshot_json, '$.provenance._payloadRef') = OLD.id)
    BEGIN SELECT RAISE(ABORT, 'proactive-day-payload-referenced'); END;
    CREATE TRIGGER IF NOT EXISTS proactive_day_payload_deleted_source AFTER DELETE ON proactive_day_source BEGIN
      DELETE FROM proactive_day_payload WHERE id IN (
        json_extract(OLD.snapshot_json,'$.lineage._payloadRef'),
        json_extract(OLD.snapshot_json,'$.provenance._payloadRef')
      ) AND NOT EXISTS (SELECT 1 FROM proactive_day_source WHERE
        json_extract(snapshot_json,'$.lineage._payloadRef')=proactive_day_payload.id OR
        json_extract(snapshot_json,'$.provenance._payloadRef')=proactive_day_payload.id);
    END;
    CREATE TRIGGER IF NOT EXISTS proactive_day_payload_updated_source AFTER UPDATE OF snapshot_json ON proactive_day_source BEGIN
      DELETE FROM proactive_day_payload WHERE id IN (
        json_extract(OLD.snapshot_json,'$.lineage._payloadRef'),
        json_extract(OLD.snapshot_json,'$.provenance._payloadRef')
      ) AND NOT EXISTS (SELECT 1 FROM proactive_day_source WHERE
        json_extract(snapshot_json,'$.lineage._payloadRef')=proactive_day_payload.id OR
        json_extract(snapshot_json,'$.provenance._payloadRef')=proactive_day_payload.id);
    END;`)
    if (
      !database
        .prepare('PRAGMA table_info(proactive_day_storage_migration)')
        .all()
        .some((row) => row.name === 'after_rowid')
    ) {
      database.exec('ALTER TABLE proactive_day_storage_migration ADD COLUMN after_rowid INTEGER')
    }
  }

  encode(snapshot: Record<string, unknown>) {
    const stored = { ...snapshot }
    for (const field of FIELDS) {
      const json = JSON.stringify(snapshot[field])
      if (json === undefined || json.length <= INLINE_LIMIT) continue
      if (Buffer.byteLength(json) > PAYLOAD_LIMIT) throw new Error('proactive-day-payload-too-large')
      const id = digest(json)
      if (!this.database.prepare('SELECT 1 FROM proactive_day_payload WHERE id=?').get(id)) {
        this.database
          .prepare('INSERT INTO proactive_day_payload(id,compressed_json) VALUES(?,?)')
          .run(id, deflateRawSync(json))
      }
      stored[field] = { _payloadRef: id }
    }
    return JSON.stringify(stored)
  }

  decode(json: string) {
    const snapshot = JSON.parse(json) as Record<string, unknown>
    for (const field of FIELDS) {
      const value = snapshot[field]
      if (!value || typeof value !== 'object' || !('_payloadRef' in value)) continue
      const id = value._payloadRef
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('proactive-day-payload-invalid')
      const row = this.database.prepare('SELECT compressed_json FROM proactive_day_payload WHERE id=?').get(id)
      if (!(row?.compressed_json instanceof Uint8Array)) throw new Error('proactive-day-payload-missing')
      const payload = inflateRawSync(row.compressed_json, { maxOutputLength: PAYLOAD_LIMIT }).toString('utf8')
      if (digest(payload) !== id) throw new Error('proactive-day-payload-corrupt')
      snapshot[field] = JSON.parse(payload)
    }
    return snapshot
  }

  /** Bounded lazy migration; updates keep the hydrated event revision exactly unchanged. */
  compactBatch(limit = 8) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new Error('invalid-day-compaction-limit')
    const progress = this.database.prepare('SELECT after_rowid FROM proactive_day_storage_migration WHERE id=1').get()
    if (progress && progress.after_rowid === null) return 0
    const ownsTransaction = !this.database.isTransaction
    if (ownsTransaction) this.database.exec('BEGIN IMMEDIATE')
    try {
      const rows = this.database
        .prepare(`SELECT rowid AS snapshot_rowid,id,snapshot_json FROM proactive_day_source
          WHERE rowid>? ORDER BY rowid LIMIT ?`)
        .all(Number(progress?.after_rowid ?? 0), limit)
      const update = this.database.prepare('UPDATE proactive_day_source SET snapshot_json=? WHERE id=?')
      for (const row of rows) {
        this.database.exec('SAVEPOINT proactive_day_compaction_row')
        try {
          const original = String(row.snapshot_json)
          const encoded = this.encode(this.decode(original))
          if (encoded !== original) update.run(encoded, String(row.id))
          this.database.exec('RELEASE proactive_day_compaction_row')
        } catch (error) {
          this.database.exec('ROLLBACK TO proactive_day_compaction_row; RELEASE proactive_day_compaction_row;')
          console.warn('[proactive] Day snapshot compaction skipped; original retained', {
            sourceId: String(row.id),
            failure: error instanceof Error ? error.name : 'unknown',
          })
        }
      }
      const cursor = rows.at(-1)?.snapshot_rowid
      const hasMore =
        cursor !== undefined &&
        this.database.prepare('SELECT 1 FROM proactive_day_source WHERE rowid>? LIMIT 1').get(cursor)
      this.database
        .prepare(`INSERT INTO proactive_day_storage_migration(id,after_rowid) VALUES(1,?)
        ON CONFLICT(id) DO UPDATE SET after_rowid=excluded.after_rowid`)
        .run(hasMore ? Number(cursor) : null)
      if (ownsTransaction) this.database.exec('COMMIT')
      return rows.length
    } catch (error) {
      if (ownsTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  /** Offline downgrade: expand every snapshot before letting a schema-17 binary open it. */
  restoreInline() {
    if (!this.database.isTransaction) throw new Error('proactive-transaction-required')
    this.database.exec('DELETE FROM proactive_day_storage_migration')
    const rows = this.database
      .prepare(`SELECT id,snapshot_json FROM proactive_day_source WHERE
      json_type(snapshot_json,'$.lineage._payloadRef') IS NOT NULL OR
      json_type(snapshot_json,'$.provenance._payloadRef') IS NOT NULL`)
      .all()
    const update = this.database.prepare('UPDATE proactive_day_source SET snapshot_json=? WHERE id=?')
    for (const row of rows) update.run(JSON.stringify(this.decode(String(row.snapshot_json))), String(row.id))
    this.database.exec('DELETE FROM proactive_day_payload')
    return rows.length
  }
}
