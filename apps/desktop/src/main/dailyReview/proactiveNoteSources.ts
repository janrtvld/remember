import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { type DictationHistorySnapshot, getDictationHistorySnapshot } from '../dictation/historySource'

type Available = Extract<DictationHistorySnapshot, { state: 'available' }>
type Entry = Available['notes'][number]

function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export const NOTE_SOURCE_UNAVAILABLE = 'proactive-note-source-unavailable'

/** Metadata projection only. Every source body still comes from the canonical history reader. */
export class ProactiveNoteSources {
  constructor(
    private readonly database: DatabaseSync,
    private readonly read: () => DictationHistorySnapshot = getDictationHistorySnapshot
  ) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS proactive_note_source (
        source_id TEXT PRIMARY KEY, metadata_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS proactive_note_state (
        id INTEGER PRIMARY KEY CHECK(id = 1), epoch TEXT NOT NULL, sequence INTEGER NOT NULL
      );
    `)
  }

  snapshot(): Available | null {
    try {
      const value = this.read()
      return value.state === 'available' ? structuredClone(value) : null
    } catch {
      return null
    }
  }

  hasSources() {
    return Boolean(this.database.prepare('SELECT 1 FROM proactive_note_state WHERE id = 1').get())
  }

  metadata(snapshot: Available, entry: Entry) {
    return {
      state: 'present',
      epoch: snapshot.epoch,
      incarnation: entry.incarnation,
      revision: entry.revision,
      contentHash: entry.contentHash,
      textHash: createHash('sha256').update(entry.note.text).digest('hex'),
      completedAt: entry.completedAt,
      id: entry.note.id,
      status: entry.note.status,
      createdAt: entry.note.createdAt,
      durationMs: entry.note.durationMs,
    }
  }

  canonical(snapshot: Available, entry: Entry) {
    if (
      entry.note.status !== 'completed' ||
      !entry.note.text.trim() ||
      entry.completedAt === null ||
      !Number.isSafeInteger(entry.completedAt) ||
      entry.completedAt < 0
    )
      return null
    const provenance = { speaker: 'unknown' as const, mediaPlayback: 'unknown' as const, inputRoute: 'saved-note' }
    return {
      row: {
        text: entry.note.text,
        observed_at: entry.completedAt,
        source: 'saved-note',
        app_name: '',
        bundle_id: '',
        window_title: '',
        url: '',
      } as Record<string, unknown>,
      chunks: [],
      provenance,
      eventRevision: hash(this.metadata(snapshot, entry)),
      contentKey: hash(['note', entry.note.text.trim().replace(/\s+/g, ' '), provenance]),
    }
  }

  resolve(sourceId: string) {
    const snapshot = this.snapshot()
    if (!snapshot) throw new Error(NOTE_SOURCE_UNAVAILABLE)
    const entry = snapshot.notes.find((value) => value.note.id === sourceId)
    if (!entry) return null
    const row = this.database
      .prepare('SELECT metadata_json FROM proactive_note_source WHERE source_id = ?')
      .get(sourceId)
    if (!row || row.metadata_json !== JSON.stringify(this.metadata(snapshot, entry))) return null
    return this.canonical(snapshot, entry)
  }

  /** Caller owns the same transaction as proactive_event publication. */
  reconcile(snapshot: Available) {
    if (!this.database.isTransaction) throw new Error('proactive-transaction-required')
    const records = new Map<string, unknown>()
    for (const entry of snapshot.notes) records.set(entry.note.id, this.metadata(snapshot, entry))
    for (const [sourceId, tombstone] of Object.entries(snapshot.tombstones)) {
      if (!records.has(sourceId)) records.set(sourceId, { state: 'deleted', epoch: snapshot.epoch, ...tombstone })
    }
    for (const row of this.database.prepare('SELECT source_id FROM proactive_note_source').all()) {
      if (!records.has(String(row.source_id)))
        records.set(String(row.source_id), { state: 'absent', epoch: snapshot.epoch })
    }
    for (const [sourceId, metadata] of records) {
      const json = JSON.stringify(metadata)
      const previous = this.database
        .prepare('SELECT metadata_json FROM proactive_note_source WHERE source_id = ?')
        .get(sourceId)
      if (previous?.metadata_json === json) continue
      if (
        this.database
          .prepare(`INSERT INTO proactive_note_source(source_id,metadata_json) VALUES (?,?)
          ON CONFLICT(source_id) DO UPDATE SET metadata_json=excluded.metadata_json`)
          .run(sourceId, json).changes !== 1
      )
        throw new Error('proactive-write-not-persisted')
    }
    const state = this.database.prepare('SELECT epoch,sequence FROM proactive_note_state WHERE id=1').get()
    if (state?.epoch === snapshot.epoch && state.sequence === snapshot.sequence) return
    if (
      this.database
        .prepare(`INSERT INTO proactive_note_state(id,epoch,sequence) VALUES (1,?,?)
        ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch,sequence=excluded.sequence`)
        .run(snapshot.epoch, snapshot.sequence).changes !== 1
    )
      throw new Error('proactive-write-not-persisted')
  }
}
