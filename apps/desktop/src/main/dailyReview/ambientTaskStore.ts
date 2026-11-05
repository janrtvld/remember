import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export type AmbientEvidenceKind = 'context' | 'speech'
export interface AmbientEvidenceRef {
  kind: AmbientEvidenceKind
  sourceId: string
  revision: string
  workdayId: string
  observedAt: number
}
export interface AmbientEvidence extends AmbientEvidenceRef {
  evidenceId: string
  text: string
  source: string
  appName: string
  bundleId: string
  windowTitle: string
  url: string
}

export const AMBIENT_BATCH_CHARACTERS = 48_000
export const AMBIENT_BATCH_RECORDS = 12

export function ambientEvidenceRevision(text: string) {
  return createHash('sha256').update(text).digest('hex')
}

/** The cursor is one acknowledged revision per source, including late ASR results. */
export class AmbientTaskStore {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS ambient_task_evidence (
        kind TEXT NOT NULL, source_id TEXT NOT NULL, revision TEXT NOT NULL,
        workday_id TEXT NOT NULL REFERENCES workday(id) ON DELETE CASCADE,
        observed_at INTEGER NOT NULL, available_at INTEGER NOT NULL, completed_at INTEGER,
        PRIMARY KEY(kind, source_id)
      );
      CREATE INDEX IF NOT EXISTS ambient_task_pending ON ambient_task_evidence(completed_at, available_at);
      CREATE TABLE IF NOT EXISTS ambient_task_notification (
        work_item_id TEXT PRIMARY KEY REFERENCES work_item(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL, delivered_at INTEGER, chat_recorded_at INTEGER, suppressed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS ambient_task_identity (
        identity TEXT NOT NULL, workday_id TEXT NOT NULL,
        work_item_id TEXT NOT NULL REFERENCES work_item(id) ON DELETE CASCADE,
        PRIMARY KEY(identity, workday_id)
      );
      CREATE TABLE IF NOT EXISTS ambient_task_source (
        work_item_id TEXT NOT NULL REFERENCES work_item(id) ON DELETE CASCADE,
        work_item_source_id TEXT NOT NULL,
        kind TEXT NOT NULL, source_id TEXT NOT NULL, revision TEXT NOT NULL,
        PRIMARY KEY(work_item_id, work_item_source_id)
      );
    `)
    const notificationColumns = database.prepare('PRAGMA table_info(ambient_task_notification)').all()
    if (!notificationColumns.some((column) => column.name === 'suppressed_at')) {
      database.exec('ALTER TABLE ambient_task_notification ADD COLUMN suppressed_at INTEGER')
    }
  }

  enqueue(
    kind: AmbientEvidenceKind,
    sourceId: string,
    workdayId: string,
    text: string,
    observedAt: number,
    now = Date.now()
  ) {
    if (!text.trim()) return
    this.database
      .prepare(`
      INSERT INTO ambient_task_evidence(kind, source_id, revision, workday_id, observed_at, available_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind, source_id) DO UPDATE SET revision = excluded.revision,
        observed_at = excluded.observed_at, available_at = excluded.available_at, completed_at = NULL
      WHERE ambient_task_evidence.revision != excluded.revision
    `)
      .run(
        kind,
        sourceId,
        ambientEvidenceRevision(text),
        workdayId,
        observedAt,
        now + (kind === 'speech' ? 2_000 : 30_000)
      )
  }

  resolve(ref: AmbientEvidenceRef): AmbientEvidence | null {
    const row =
      ref.kind === 'context'
        ? this.database
            .prepare(`SELECT c.text, c.window_title, c.url, a.display_name AS app_name, a.bundle_id,
          c.timestamp AS observed_at FROM context_evidence c JOIN application a ON a.id = c.application_id
          WHERE c.id = ? AND c.workday_id = ?`)
            .get(ref.sourceId, ref.workdayId)
        : this.database
            .prepare(`SELECT text, source, ended_at AS observed_at FROM speech_segment
          WHERE id = ? AND workday_id = ? AND rejection_reason IS NULL AND transcription_outcome = 'transcribed'
          AND NOT EXISTS (SELECT 1 FROM offline_period p WHERE p.started_at < speech_segment.ended_at
            AND (p.ended_at IS NULL OR p.ended_at > speech_segment.started_at))`)
            .get(ref.sourceId, ref.workdayId)
    if (!row || typeof row.text !== 'string' || ambientEvidenceRevision(row.text) !== ref.revision) return null
    if (ref.kind === 'speech' && this.hasRecordedPlayback(ref.sourceId, ref.workdayId)) return null
    if (
      this.database
        .prepare(`SELECT 1 FROM offline_period WHERE started_at <= ?
        AND (ended_at IS NULL OR ended_at > ?) LIMIT 1`)
        .get(ref.observedAt, ref.observedAt)
    )
      return null
    return {
      ...ref,
      evidenceId: ref.kind === 'speech' ? `speech:${ref.sourceId}` : ref.sourceId,
      text: row.text,
      source: String(row.source ?? 'screen'),
      appName: String(row.app_name ?? ''),
      bundleId: String(row.bundle_id ?? ''),
      windowTitle: String(row.window_title ?? ''),
      url: String(row.url ?? ''),
    }
  }

  private hasRecordedPlayback(sourceId: string, workdayId: string) {
    const chunks = this.database
      .prepare(`SELECT a.media_playback_json FROM speech_segment s JOIN audio_evidence a
        ON a.workday_id = s.workday_id AND a.source = s.source
        AND (a.id = s.chunk_id OR a.id IN (SELECT value FROM json_each(s.chunk_ids_json)))
        WHERE s.id = ? AND s.workday_id = ?
        AND a.started_at < s.ended_at AND a.started_at + a.duration_ms > s.started_at`)
      .all(sourceId, workdayId)
    return chunks.some((chunk) => {
      try {
        const playback = JSON.parse(String(chunk.media_playback_json ?? 'null'))
        // The native snapshot is saved before these chunks reach ASR. A live call
        // cannot disambiguate speech mixed with explicitly recorded media playback.
        return playback?.isPlaying === true
      } catch {
        return false
      }
    })
  }

  resolveSource(evidenceId: string): AmbientEvidence | null {
    const kind = evidenceId.startsWith('speech:') ? 'speech' : 'context'
    const sourceId = kind === 'speech' ? evidenceId.slice('speech:'.length) : evidenceId
    const row = this.database
      .prepare(
        kind === 'speech'
          ? 'SELECT text, workday_id, ended_at AS observed_at FROM speech_segment WHERE id = ?'
          : 'SELECT text, workday_id, timestamp AS observed_at FROM context_evidence WHERE id = ?'
      )
      .get(sourceId)
    if (!row || typeof row.text !== 'string' || !row.text.trim()) return null
    return this.resolve({
      kind,
      sourceId,
      workdayId: String(row.workday_id),
      observedAt: Number(row.observed_at),
      revision: ambientEvidenceRevision(row.text),
    })
  }

  bootstrap(now: number) {
    // Catch pre-upgrade evidence without replaying the entire archive.
    const rows = this.database
      .prepare(`
      SELECT 'context' AS kind, id, workday_id, text, timestamp AS observed_at FROM context_evidence c
      WHERE timestamp >= ? AND length(trim(text)) > 0 AND NOT EXISTS (SELECT 1 FROM ambient_task_evidence a WHERE a.kind = 'context' AND a.source_id = c.id)
      UNION ALL
      SELECT 'speech' AS kind, id, workday_id, text, ended_at AS observed_at FROM speech_segment s
      WHERE ended_at >= ? AND rejection_reason IS NULL AND transcription_outcome = 'transcribed' AND length(trim(text)) > 0
        AND NOT EXISTS (SELECT 1 FROM ambient_task_evidence a WHERE a.kind = 'speech' AND a.source_id = s.id)
      ORDER BY observed_at DESC LIMIT 200
    `)
      .all(now - 24 * 60 * 60_000, now - 24 * 60 * 60_000)
    for (const row of rows) {
      this.enqueue(
        row.kind as AmbientEvidenceKind,
        String(row.id),
        String(row.workday_id),
        String(row.text),
        Number(row.observed_at),
        now
      )
    }
    return rows.length
  }

  pending(now: number, allowed: (kind: AmbientEvidenceKind) => boolean): AmbientEvidenceRef[] {
    const rows = this.database
      .prepare(`SELECT * FROM ambient_task_evidence WHERE completed_at IS NULL
        AND available_at <= ? AND ((kind = 'speech' AND ? = 1) OR (kind = 'context' AND ? = 1))
        ORDER BY CASE WHEN kind = 'speech' AND observed_at >= ? THEN 0 ELSE 1 END,
          available_at, observed_at LIMIT 200`)
      .all(now, Number(allowed('speech')), Number(allowed('context')), now - 120_000)
    return rows.flatMap((row) => {
      const kind = row.kind as AmbientEvidenceKind
      return allowed(kind)
        ? [
            {
              kind,
              sourceId: String(row.source_id),
              revision: String(row.revision),
              workdayId: String(row.workday_id),
              observedAt: Number(row.observed_at),
            },
          ]
        : []
    })
  }

  batch(now: number, allowed: (kind: AmbientEvidenceKind) => boolean, accept: (evidence: AmbientEvidence) => boolean) {
    const selected: AmbientEvidence[] = []
    let characters = 0
    for (const ref of this.pending(now, allowed)) {
      const evidence = this.resolve(ref)
      if (!evidence || !accept(evidence)) {
        this.acknowledge([ref], now)
        continue
      }
      if (
        selected.length &&
        (selected[0]?.workdayId !== evidence.workdayId || characters + evidence.text.length > AMBIENT_BATCH_CHARACTERS)
      )
        break
      // Native context is capped at 40k. Never acknowledge a larger future source by silently clipping it.
      if (evidence.text.length > AMBIENT_BATCH_CHARACTERS) throw new Error('ambient-evidence-exceeds-budget')
      selected.push(evidence)
      characters += evidence.text.length
      if (selected.length === AMBIENT_BATCH_RECORDS) break
    }
    return selected
  }

  acknowledge(refs: AmbientEvidenceRef[], at: number) {
    const update = this.database.prepare(`UPDATE ambient_task_evidence SET completed_at = ?
      WHERE kind = ? AND source_id = ? AND revision = ?`)
    for (const ref of refs) update.run(at, ref.kind, ref.sourceId, ref.revision)
  }

  enqueueNotification(itemId: string, at: number) {
    this.database
      .prepare('INSERT OR IGNORE INTO ambient_task_notification(work_item_id, created_at) VALUES (?, ?)')
      .run(itemId, at)
  }

  commitmentIdentity(title: string, description: string, ref: AmbientEvidenceRef) {
    const evidence = this.resolve(ref)
    if (!evidence) throw new Error('ambient-evidence-changed')
    let surface = evidence.bundleId || evidence.appName || evidence.kind
    if (evidence.url) {
      try {
        const url = new URL(evidence.url)
        surface += `:${url.origin}${url.pathname}`
      } catch {
        surface += `:${evidence.windowTitle}`
      }
    }
    return ambientEvidenceRevision(
      JSON.stringify([title, description, surface].map((part) => part.trim().replace(/\s+/g, ' ').toLocaleLowerCase()))
    )
  }

  commitmentItem(identity: string, ref: AmbientEvidenceRef) {
    const row = this.database
      .prepare(`SELECT a.work_item_id FROM ambient_task_identity a JOIN work_item w ON w.id = a.work_item_id
        WHERE a.identity = ? AND (a.workday_id = ? OR w.lifecycle = 'open'
          OR (? = 'context' AND EXISTS (
            SELECT 1 FROM ambient_task_source s
            WHERE s.work_item_id = w.id AND s.kind = 'context' AND s.revision = ?
          )))
        ORDER BY CASE WHEN a.workday_id = ? THEN 0 WHEN w.lifecycle = 'open' THEN 1 ELSE 2 END,
          w.updated_at DESC LIMIT 1`)
      .get(identity, ref.workdayId, ref.kind, ref.revision, ref.workdayId)
    return row ? String(row.work_item_id) : null
  }

  recordCommitment(identity: string, workdayId: string, itemId: string) {
    this.database
      .prepare('INSERT OR IGNORE INTO ambient_task_identity(identity, workday_id, work_item_id) VALUES (?, ?, ?)')
      .run(identity, workdayId, itemId)
  }

  recordTaskSource(itemId: string, workItemSourceId: string, ref: AmbientEvidenceRef) {
    this.database
      .prepare(`INSERT INTO ambient_task_source(work_item_id, work_item_source_id, kind, source_id, revision) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(work_item_id, work_item_source_id) DO UPDATE SET revision = excluded.revision`)
      .run(itemId, workItemSourceId, ref.kind, ref.sourceId, ref.revision)
  }

  taskEvidence(itemId: string) {
    const rows = this.database
      .prepare(`SELECT s.kind, s.source_id, s.revision, a.revision AS current_revision, a.workday_id, a.observed_at
      FROM ambient_task_source s LEFT JOIN ambient_task_evidence a
      ON a.kind = s.kind AND a.source_id = s.source_id WHERE s.work_item_id = ?`)
      .all(itemId)
    const sources: AmbientEvidence[] = []
    for (const row of rows) {
      if (typeof row.workday_id !== 'string' || row.current_revision !== row.revision) return []
      const evidence = this.resolve({
        kind: row.kind as AmbientEvidenceKind,
        sourceId: String(row.source_id),
        revision: String(row.revision),
        workdayId: String(row.workday_id),
        observedAt: Number(row.observed_at),
      })
      if (!evidence) return []
      sources.push(evidence)
    }
    return sources
  }

  hasTaskSources(itemId: string) {
    return Boolean(
      this.database.prepare('SELECT 1 FROM ambient_task_source WHERE work_item_id = ? LIMIT 1').get(itemId)
    )
  }

  taskSourceIds(itemId: string) {
    return this.database
      .prepare('SELECT work_item_source_id FROM ambient_task_source WHERE work_item_id = ?')
      .all(itemId)
      .map((row) => String(row.work_item_source_id))
  }

  takeNotification(now: number, expectedId?: string) {
    const id = this.nextAttention('delivered_at', now)
    if (!id || (expectedId !== undefined && expectedId !== id)) return null
    // Reserve at most one OS attempt; this legacy field is not proof of visible delivery.
    this.database.prepare('UPDATE ambient_task_notification SET delivered_at = ? WHERE work_item_id = ?').run(now, id)
    return id
  }

  nextNotification(now: number) {
    return this.nextAttention('delivered_at', now)
  }

  suppressAttention(itemId: string, at: number) {
    this.database
      .prepare('UPDATE ambient_task_notification SET suppressed_at = ? WHERE work_item_id = ?')
      .run(at, itemId)
  }

  nextSuggestion(now: number) {
    return this.nextAttention('chat_recorded_at', now)
  }

  private nextAttention(channel: 'delivered_at' | 'chat_recorded_at', now: number) {
    const row = this.database
      .prepare(`SELECT n.work_item_id FROM ambient_task_notification n JOIN work_item w ON w.id = n.work_item_id
        WHERE n.${channel} IS NULL AND n.suppressed_at IS NULL AND n.created_at >= ? AND w.lifecycle = 'open'
          AND NOT EXISTS (
            SELECT 1 FROM ambient_task_notification recent
            WHERE recent.work_item_id != n.work_item_id
              AND (recent.delivered_at > ? OR recent.chat_recorded_at > ?)
          )
        ORDER BY n.created_at LIMIT 1`)
      .get(now - 30 * 60_000, now - 60_000, now - 60_000)
    return row ? String(row.work_item_id) : null
  }

  acknowledgeSuggestion(itemId: string, at: number) {
    this.database
      .prepare('UPDATE ambient_task_notification SET chat_recorded_at = ? WHERE work_item_id = ?')
      .run(at, itemId)
  }
}
