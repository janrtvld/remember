import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { setImmediate } from 'node:timers/promises'
import type { WorkItem } from '@remember/shared'
import type { DictationHistorySnapshot } from '../dictation/historySource'
import {
  AMBIENT_BATCH_CHARACTERS,
  AMBIENT_BATCH_RECORDS,
  type AmbientEvidence,
  type AmbientEvidenceKind,
  ambientEvidenceRevision,
} from './ambientTaskStore'
import { contextualTopicKey, dayContextSupportsQuote } from './proactiveDayGrounding'
import { type DaySourceLineage, ProactiveDaySources } from './proactiveDaySources'
import { NOTE_SOURCE_UNAVAILABLE, ProactiveNoteSources } from './proactiveNoteSources'

export const PROACTIVE_CONSUMER = 'proactive-rpa1.v1'
export const PROACTIVE_MAX_AGE_MS = 120_000
const DEDUPE_WINDOW = 30 * 60_000
export const PROACTIVE_DAY_REVIEW_INTERVAL_MS = 3 * 60 * 60_000
export const PROACTIVE_DAY_TASK_INTERVAL_MS = 24 * 60 * 60_000
const DAY_REVIEW_INTERVAL = PROACTIVE_DAY_REVIEW_INTERVAL_MS
const DAY_REVIEW_RETRY = 5 * 60_000
const FOLLOW_UP_LIMIT = 7 * 24 * 60 * 60_000
type Row = Record<string, unknown>

export type ProactiveFollowUp = { taskId: string; note: string; nextReviewAt: number }
export type ProactiveDayAssessment = {
  createdAt: number
  topicKey?: string
  text: string
  taskIds: string[]
  followUps: ProactiveFollowUp[]
  delivered: boolean
}

function daytime(timestamp: number) {
  const date = new Date(timestamp)
  if (date.getHours() < 8) date.setHours(8, 0, 0, 0)
  else if (date.getHours() >= 22) {
    date.setDate(date.getDate() + 1)
    date.setHours(8, 0, 0, 0)
  }
  return date.getTime()
}

export type ProactiveSourceKind = AmbientEvidenceKind | 'note' | 'day'
export function proactiveSourceMaxAgeMs(source: Pick<ProactiveSource, 'kind'>) {
  return source.kind === 'day' ? 24 * 60 * 60_000 : PROACTIVE_MAX_AGE_MS
}
export interface ProactiveSource extends Omit<AmbientEvidence, 'kind'> {
  kind: ProactiveSourceKind
  eventId: string
  sequence: number
  eventRevision: string
  acceptedAt: number
  contentKey: string
  provenance: { speaker: 'unknown'; mediaPlayback: 'recorded' | 'unknown'; inputRoute: string }
}
export type ProactiveSourceRef = { bundleId?: string } & Pick<
  ProactiveSource,
  | 'eventId'
  | 'kind'
  | 'sourceId'
  | 'evidenceId'
  | 'workdayId'
  | 'eventRevision'
  | 'revision'
  | 'contentKey'
  | 'observedAt'
  | 'appName'
  | 'windowTitle'
  | 'url'
>
export type ProactiveDecisionInput = {
  id: string
  kind: 'silent' | 'observe' | 'clarify' | 'offer' | 'prepare'
  text: string
  topicKey: string
  /** Canonical evidence IDs selected from this batch, not caller-created IDs. */
  sourceIds: string[]
  supportingQuotes: { sourceId: string; quote: string }[]
  createdAt: number
  expiresAt: number
  policyToken: string
  conversationGeneration: number
  reason?: 'interpreted' | 'analysis-error' | 'user-interaction'
  taskIds?: string[]
  followUps?: ProactiveFollowUp[]
}
export type ProactiveCommit = {
  consumerGeneration: number
  sources: ProactiveSource[]
  decision: ProactiveDecisionInput
}
export type ProactiveDecision = ProactiveDecisionInput & {
  inputHash: string
  sourceRefs: ProactiveSourceRef[]
  consumerGeneration: number
  deletionRevision: number
  deliveredMessageId: string | null
  invalidatedAt: number | null
}

function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
function finiteTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}
function ref(source: ProactiveSource): ProactiveSourceRef {
  return {
    eventId: source.eventId,
    kind: source.kind,
    sourceId: source.sourceId,
    workdayId: source.workdayId,
    eventRevision: source.eventRevision,
    contentKey: source.contentKey,
    evidenceId: source.evidenceId,
    revision: source.revision,
    observedAt: source.observedAt,
    appName: source.appName,
    windowTitle: source.windowTitle,
    url: source.url,
    ...(source.bundleId ? { bundleId: source.bundleId } : {}),
  }
}

/** The source journal and consumer receipts share the canonical Evidence database. */
export class ProactiveStore {
  private readonly notes: ProactiveNoteSources
  private readonly days: ProactiveDaySources
  private dayLineageReads: Map<string, AmbientEvidence | null> | null = null
  private contextVersionReads: Map<string, { workdayId: string; token: string } | null> | null = null
  private readonly contextChecks = new Map<
    string,
    {
      token: string
      revision: string
      observedAt: number
      policy?: string
      permitted?: boolean
    }
  >()

  constructor(
    private readonly database: DatabaseSync,
    options: { noteSnapshot?: () => DictationHistorySnapshot } = {}
  ) {
    this.notes = new ProactiveNoteSources(database, options.noteSnapshot)
    this.days = new ProactiveDaySources(database, {
      resolve: (references) => this.dayAnalysisSourceEvidence(references),
      current: (references) => this.checkDaySources(references),
      collect: (workdayId, evidenceIds) => this.dayAnalysisSources(workdayId, evidenceIds),
    })
    const hadQueue = Boolean(
      database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='proactive_queue'").get()
    )
    database.exec(`
      CREATE TABLE IF NOT EXISTS proactive_context_revision (source_id TEXT PRIMARY KEY, revision TEXT NOT NULL) STRICT;
      CREATE TRIGGER IF NOT EXISTS proactive_context_insert AFTER INSERT ON context_evidence BEGIN
        INSERT OR REPLACE INTO proactive_context_revision VALUES (NEW.id, hex(randomblob(16)));
      END;
      CREATE TRIGGER IF NOT EXISTS proactive_context_update AFTER UPDATE ON context_evidence BEGIN
        DELETE FROM proactive_context_revision WHERE source_id=OLD.id;
        INSERT INTO proactive_context_revision VALUES (NEW.id, hex(randomblob(16)));
      END;
      CREATE TRIGGER IF NOT EXISTS proactive_context_delete AFTER DELETE ON context_evidence BEGIN
        DELETE FROM proactive_context_revision WHERE source_id=OLD.id;
      END;
      CREATE TABLE IF NOT EXISTS proactive_event (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL, source_id TEXT NOT NULL, workday_id TEXT NOT NULL,
        event_revision TEXT NOT NULL, content_key TEXT NOT NULL,
        observed_at INTEGER NOT NULL, accepted_at INTEGER NOT NULL, available_at INTEGER NOT NULL,
        UNIQUE(kind, source_id, event_revision)
      );
      CREATE TABLE IF NOT EXISTS proactive_consumer (
        name TEXT PRIMARY KEY, generation INTEGER NOT NULL, enabled INTEGER NOT NULL, enabled_at INTEGER NOT NULL,
        after_sequence INTEGER NOT NULL DEFAULT 0, scan_after_sequence INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS proactive_decision (
        id TEXT PRIMARY KEY, consumer TEXT NOT NULL, generation INTEGER NOT NULL,
        input_hash TEXT NOT NULL, decision_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        delivered_message_id TEXT, delivered_at INTEGER, invalidated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS proactive_considered (
        consumer TEXT NOT NULL, event_id TEXT NOT NULL, decision_id TEXT,
        state TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(consumer, event_id)
      );
      CREATE TABLE IF NOT EXISTS proactive_queue (
        consumer TEXT NOT NULL REFERENCES proactive_consumer(name) ON DELETE CASCADE,
        event_id TEXT NOT NULL REFERENCES proactive_event(event_id) ON DELETE CASCADE,
        PRIMARY KEY(consumer,event_id)
      );
      CREATE INDEX IF NOT EXISTS proactive_delivery_pending ON proactive_decision(consumer,created_at,id)
        WHERE delivered_message_id IS NULL AND invalidated_at IS NULL AND json_extract(decision_json,'$.kind') <> 'silent';
      CREATE INDEX IF NOT EXISTS proactive_pending ON proactive_event(available_at, sequence);
      CREATE TABLE IF NOT EXISTS proactive_day_schedule (
        consumer TEXT PRIMARY KEY, generation INTEGER NOT NULL, next_review_at INTEGER NOT NULL,
        next_attempt_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS proactive_day_review (
        slot_id TEXT PRIMARY KEY, consumer TEXT NOT NULL, generation INTEGER NOT NULL,
        checked_at INTEGER NOT NULL, event_id TEXT, decision_id TEXT, attempt INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS proactive_follow_up (
        consumer TEXT NOT NULL, task_id TEXT NOT NULL, generation INTEGER NOT NULL,
        decision_id TEXT NOT NULL, note TEXT NOT NULL, next_review_at INTEGER NOT NULL,
        PRIMARY KEY(consumer, task_id)
      );
    `)
    if (
      !database
        .prepare('PRAGMA table_info(proactive_day_review)')
        .all()
        .some((column) => column.name === 'attempt')
    )
      database.exec('ALTER TABLE proactive_day_review ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0')
    if (
      !database
        .prepare('PRAGMA table_info(proactive_consumer)')
        .all()
        .some((column) => column.name === 'after_sequence')
    )
      database.exec('ALTER TABLE proactive_consumer ADD COLUMN after_sequence INTEGER NOT NULL DEFAULT 0')
    database
      .prepare('INSERT OR IGNORE INTO proactive_consumer(name,generation,enabled,enabled_at) VALUES (?, 0, 0, 0)')
      .run(PROACTIVE_CONSUMER)
    if (
      !database
        .prepare('PRAGMA table_info(proactive_consumer)')
        .all()
        .some((column) => column.name === 'scan_after_sequence')
    )
      database.exec('ALTER TABLE proactive_consumer ADD COLUMN scan_after_sequence INTEGER NOT NULL DEFAULT 0')
    database.exec(
      'UPDATE proactive_consumer SET scan_after_sequence=after_sequence WHERE scan_after_sequence<after_sequence'
    )
    if (!hadQueue) database.exec('UPDATE proactive_consumer SET scan_after_sequence=after_sequence')
    database.exec(`DELETE FROM proactive_queue WHERE
      EXISTS(SELECT 1 FROM proactive_considered c WHERE c.consumer=proactive_queue.consumer AND c.event_id=proactive_queue.event_id)
      OR EXISTS(SELECT 1 FROM proactive_event e JOIN proactive_consumer c ON c.name=proactive_queue.consumer
        WHERE e.event_id=proactive_queue.event_id AND (e.sequence<=c.after_sequence OR e.accepted_at<c.enabled_at));`)
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  private consumer() {
    const row = this.database.prepare('SELECT * FROM proactive_consumer WHERE name = ?').get(PROACTIVE_CONSUMER)
    if (!row) throw new Error('proactive-consumer-unavailable')
    return {
      generation: Number(row.generation),
      enabled: row.enabled === 1,
      enabledAt: Number(row.enabled_at),
      afterSequence: Number(row.after_sequence),
      scanAfterSequence: Number(row.scan_after_sequence),
    }
  }

  generation() {
    return this.consumer().generation
  }

  private ensureDaySchedule(now: number) {
    const consumer = this.consumer()
    if (!consumer.enabled) return
    this.database
      .prepare(`INSERT INTO proactive_day_schedule(consumer,generation,next_review_at,next_attempt_at)
        VALUES(?,?,?,?) ON CONFLICT(consumer) DO UPDATE SET generation=excluded.generation,
        next_review_at=excluded.next_review_at,next_attempt_at=excluded.next_attempt_at
        WHERE generation<>excluded.generation`)
      .run(PROACTIVE_CONSUMER, consumer.generation, daytime(now), daytime(now))
  }

  dayReviewDue(now = Date.now()) {
    if (!finiteTime(now) || daytime(now) !== now) return false
    const consumer = this.consumer()
    if (!consumer.enabled) return false
    const schedule = this.database
      .prepare('SELECT next_review_at,next_attempt_at FROM proactive_day_schedule WHERE consumer=? AND generation=?')
      .get(PROACTIVE_CONSUMER, consumer.generation)
    return Boolean(schedule && Number(schedule.next_review_at) <= now && Number(schedule.next_attempt_at) <= now)
  }

  reconcileDayReview(items: WorkItem[], now = Date.now()) {
    if (!this.dayReviewDue(now)) return null
    try {
      return this.transaction(() => {
        if (!this.dayReviewDue(now)) return null
        const consumer = this.consumer()
        const schedule = this.database
          .prepare('SELECT next_review_at FROM proactive_day_schedule WHERE consumer=?')
          .get(PROACTIVE_CONSUMER)!
        const slotId = `day-review:${hash([consumer.generation, Number(schedule.next_review_at)])}`
        const delayed = this.database
          .prepare('UPDATE proactive_day_schedule SET next_attempt_at=? WHERE consumer=? AND generation=?')
          .run(daytime(now + DAY_REVIEW_RETRY), PROACTIVE_CONSUMER, consumer.generation)
        if (delayed.changes !== 1) throw new Error('proactive-write-not-persisted')
        const row = this.database
          .prepare(
            "SELECT id FROM workday WHERE refresh_status='idle' AND memory_json IS NOT NULL ORDER BY started_at DESC LIMIT 1"
          )
          .get()
        if (!row) return null
        const ordinary = this.database
          .prepare(`SELECT e.source_id FROM proactive_event e JOIN proactive_day_source d ON d.id=e.source_id
            WHERE e.kind='day' AND e.workday_id=? AND e.accepted_at>=? AND e.sequence>?
            AND e.available_at<=? AND e.observed_at BETWEEN ? AND ?
            AND json_extract(d.snapshot_json,'$.review') IS NULL
            AND NOT EXISTS(SELECT 1 FROM proactive_considered c WHERE c.consumer=? AND c.event_id=e.event_id)
            ORDER BY e.sequence DESC LIMIT 1`)
          .get(
            row.id,
            consumer.enabledAt,
            consumer.afterSequence,
            now,
            now - proactiveSourceMaxAgeMs({ kind: 'day' }),
            now,
            PROACTIVE_CONSUMER
          )
        if (ordinary && this.days.current(String(ordinary.source_id))) return null
        this.database
          .prepare('INSERT OR IGNORE INTO proactive_day_review(slot_id,consumer,generation,checked_at) VALUES(?,?,?,?)')
          .run(slotId, PROACTIVE_CONSUMER, consumer.generation, now)
        const review = this.database
          .prepare('SELECT checked_at,decision_id,event_id,attempt FROM proactive_day_review WHERE slot_id=?')
          .get(slotId)!
        if (review.decision_id !== null) return null
        let attempt = Number(review.attempt)
        if (review.event_id !== null) {
          const event = this.database
            .prepare('SELECT observed_at FROM proactive_event WHERE event_id=?')
            .get(String(review.event_id))
          const terminal = this.database
            .prepare('SELECT decision_id FROM proactive_considered WHERE consumer=? AND event_id=?')
            .get(PROACTIVE_CONSUMER, String(review.event_id))
          if (
            !event ||
            Number(event.observed_at) < now - proactiveSourceMaxAgeMs({ kind: 'day' }) ||
            (terminal && terminal.decision_id === null)
          ) {
            attempt++
            this.database
              .prepare('UPDATE proactive_day_review SET attempt=?,checked_at=?,event_id=NULL WHERE slot_id=?')
              .run(attempt, now, slotId)
          }
        }
        const canonical = this.days.reconcile(String(row.id), items, consumer.enabledAt, now, {
          slotId: `${slotId}:${attempt}`,
          reason: 'scheduled-task-review',
          checkedAt: now,
        })
        if (!canonical) return null
        this.enqueueCanonical('day', canonical.sourceId, String(row.id), canonical, now)
        this.days.maintainStorage()
        const event = this.database
          .prepare('SELECT * FROM proactive_event WHERE kind=? AND source_id=? AND event_revision=?')
          .get('day', canonical.sourceId, canonical.eventRevision)
        if (!event) throw new Error('proactive-write-not-persisted')
        const bound = this.database
          .prepare('UPDATE proactive_day_review SET event_id=? WHERE slot_id=? AND decision_id IS NULL')
          .run(String(event.event_id), slotId)
        if (bound.changes !== 1) throw new Error('proactive-write-not-persisted')
        return this.resolveCurrent(this.eventRef(event))
      })
    } catch (error) {
      this.database
        .prepare('UPDATE proactive_day_schedule SET next_attempt_at=? WHERE consumer=? AND generation=?')
        .run(daytime(now + DAY_REVIEW_RETRY), PROACTIVE_CONSUMER, this.consumer().generation)
      throw error
    }
  }

  recentDayAssessments(now: number, accept: (source: ProactiveSource) => boolean): ProactiveDayAssessment[] {
    return this.withDaySourceReads(() => this.readRecentDayAssessments(now, accept))
  }

  /** Share immutable lineage reads only inside one synchronous, read-only operation. */
  withDaySourceReads<T>(operation: () => T): T {
    const previousReads = this.dayLineageReads
    const previousVersions = this.contextVersionReads
    this.dayLineageReads = new Map()
    this.contextVersionReads = new Map()
    try {
      const result = this.days.withReads(operation)
      if (result && typeof (result as { then?: unknown }).then === 'function')
        throw new Error('day-source-reads-must-be-synchronous')
      return result
    } finally {
      this.dayLineageReads = previousReads
      this.contextVersionReads = previousVersions
    }
  }

  private readRecentDayAssessments(now: number, accept: (source: ProactiveSource) => boolean) {
    if (!finiteTime(now)) throw new Error('invalid-proactive-time')
    const result: ProactiveDayAssessment[] = []
    const seenTasks = new Set<string>()
    const seenTopics = new Set<string>()
    const access = new Map<string, boolean>()
    let checkedDecisions = 0
    const rows = this.database
      .prepare(
        'SELECT id FROM proactive_decision WHERE consumer=? AND created_at>=? AND invalidated_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 80'
      )
      .all(PROACTIVE_CONSUMER, now - FOLLOW_UP_LIMIT)
    for (const row of rows) {
      if (checkedDecisions === 6) break
      const decision = this.get(String(row.id))
      if (!decision?.sourceRefs.length || decision.sourceRefs.some((source) => source.kind !== 'day')) continue
      if (!decision.text && !decision.followUps?.length) continue
      const followUps = (decision.followUps ?? []).filter((followUp) =>
        this.database.prepare("SELECT id FROM work_item WHERE id=? AND lifecycle='open'").get(followUp.taskId)
      )
      const ids = [...(decision.taskIds ?? []), ...followUps.map((entry) => entry.taskId)]
      if (ids.length ? ids.every((id) => seenTasks.has(id)) : !decision.text || seenTopics.has(decision.topicKey))
        continue
      for (const id of ids) seenTasks.add(id)
      seenTopics.add(decision.topicKey)
      checkedDecisions++
      try {
        if (
          decision.sourceRefs.some((reference) => {
            const key = JSON.stringify([reference.eventId, reference.eventRevision, reference.sourceId])
            if (!access.has(key)) {
              const source = this.resolve(reference)
              access.set(key, Boolean(source && accept(source)))
            }
            return access.get(key) !== true
          })
        )
          continue
      } catch {
        continue
      }
      result.push({
        createdAt: decision.createdAt,
        topicKey: decision.topicKey,
        text: decision.text.slice(0, 800),
        taskIds: decision.taskIds ?? [],
        followUps,
        delivered: decision.deliveredMessageId !== null,
      })
    }
    return result.reverse()
  }

  private nextDayReview(now: number) {
    const consumer = this.consumer()
    let next = now + DAY_REVIEW_INTERVAL
    const followUp = this.database
      .prepare(`SELECT MIN(f.next_review_at) AS next FROM proactive_follow_up f JOIN work_item t ON t.id=f.task_id
        WHERE f.consumer=? AND f.generation=? AND t.lifecycle='open' AND f.next_review_at>?`)
      .get(PROACTIVE_CONSUMER, consumer.generation, now)
    if (followUp?.next !== null && followUp?.next !== undefined) next = Math.min(next, Number(followUp.next))
    const dueTasks = this.database.prepare("SELECT due_at FROM work_item WHERE lifecycle='open' AND due_at>?").all(now)
    for (const task of dueTasks) {
      for (const offset of [24 * 60 * 60_000, DAY_REVIEW_INTERVAL, 0]) {
        const milestone = Number(task.due_at) - offset
        if (milestone > now) next = Math.min(next, milestone)
      }
    }
    return daytime(next)
  }

  private recordDayAssessment(decision: ProactiveDecisionInput, sources: ProactiveSource[]) {
    if (!sources.every((source) => source.kind === 'day')) return
    const consumer = this.consumer()
    this.ensureDaySchedule(decision.createdAt)
    let scheduled = false
    for (const source of sources) {
      const updated = this.database
        .prepare(
          'UPDATE proactive_day_review SET decision_id=? WHERE event_id=? AND generation=? AND decision_id IS NULL'
        )
        .run(decision.id, source.eventId, consumer.generation)
      scheduled ||= updated.changes > 0
    }
    if (!scheduled) {
      const pending = this.database
        .prepare(
          'SELECT 1 FROM proactive_day_review WHERE consumer=? AND generation=? AND event_id IS NOT NULL AND decision_id IS NULL LIMIT 1'
        )
        .get(PROACTIVE_CONSUMER, consumer.generation)
      const schedule = this.database
        .prepare('SELECT next_review_at FROM proactive_day_schedule WHERE consumer=?')
        .get(PROACTIVE_CONSUMER)
      scheduled = !pending && Number(schedule?.next_review_at) <= decision.createdAt
    }
    this.database
      .prepare(`DELETE FROM proactive_follow_up WHERE consumer=? AND
        (generation<>? OR next_review_at<=? OR NOT EXISTS(SELECT 1 FROM work_item t WHERE t.id=task_id AND t.lifecycle='open'))`)
      .run(PROACTIVE_CONSUMER, consumer.generation, decision.createdAt)
    for (const followUp of decision.followUps ?? []) {
      const saved = this.database
        .prepare(`INSERT INTO proactive_follow_up(consumer,task_id,generation,decision_id,note,next_review_at) VALUES(?,?,?,?,?,?)
          ON CONFLICT(consumer,task_id) DO UPDATE SET generation=excluded.generation,decision_id=excluded.decision_id,
          note=excluded.note,next_review_at=excluded.next_review_at`)
        .run(
          PROACTIVE_CONSUMER,
          followUp.taskId,
          consumer.generation,
          decision.id,
          followUp.note,
          followUp.nextReviewAt
        )
      if (saved.changes !== 1) throw new Error('proactive-write-not-persisted')
    }
    const next = this.nextDayReview(decision.createdAt)
    const scheduledNext = this.database
      .prepare(`UPDATE proactive_day_schedule SET next_review_at=${scheduled ? '?' : 'MIN(next_review_at,?)'},
        next_attempt_at=${scheduled ? '?' : 'MIN(next_attempt_at,?)'} WHERE consumer=? AND generation=?`)
      .run(next, next, PROACTIVE_CONSUMER, consumer.generation)
    if (scheduledNext.changes !== 1) throw new Error('proactive-write-not-persisted')
  }

  latestSequence() {
    return Number(
      this.database.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM proactive_event').get()?.sequence
    )
  }

  hasNoteSources() {
    return this.notes.hasSources()
  }

  notesAvailable() {
    return this.notes.snapshot() !== null
  }

  reconcileNotes(now = Date.now()) {
    if (!finiteTime(now)) throw new Error('invalid-proactive-time')
    const snapshot = this.notes.snapshot()
    if (!snapshot) return false
    this.transaction(() => {
      this.notes.reconcile(snapshot)
      for (const entry of snapshot.notes) {
        const canonical = this.notes.canonical(snapshot, entry)
        if (canonical) this.enqueueCanonical('note', entry.note.id, '', canonical, now)
      }
    })
    return true
  }

  reconcileDaySync(workdayId: string, items: WorkItem[], now = Date.now()) {
    if (!finiteTime(now)) throw new Error('invalid-proactive-time')
    const consumer = this.consumer()
    if (!consumer.enabled) return null
    return this.transaction(() => {
      const canonical = this.days.reconcile(workdayId, items, consumer.enabledAt, now)
      if (!canonical) return null
      const id = canonical.sourceId
      this.enqueueCanonical('day', id, workdayId, canonical, now)
      this.days.maintainStorage()
      const row = this.database
        .prepare('SELECT * FROM proactive_event WHERE kind = ? AND source_id = ? AND event_revision = ?')
        .get('day', id, canonical.eventRevision)
      return row ? this.resolveCurrent(this.eventRef(row)) : null
    })
  }

  reconcileDaySyncs(items: WorkItem[], now = Date.now()) {
    const consumer = this.consumer()
    if (!consumer.enabled) return []
    return this.days.completedSince(Math.max(consumer.enabledAt, now - 24 * 60 * 60_000)).flatMap((id) => {
      const source = this.reconcileDaySync(id, items, now)
      return source ? [source] : []
    })
  }

  latestDaySync(workdayId: string, asOf?: number) {
    const id = this.days.latestId(workdayId, asOf)
    if (!id) return null
    const row = this.database
      .prepare("SELECT * FROM proactive_event WHERE kind = 'day' AND source_id = ? ORDER BY sequence DESC LIMIT 1")
      .get(id)
    return row ? this.resolveCurrent(this.eventRef(row)) : null
  }

  daySourceEvidence(source: Pick<ProactiveSource, 'kind' | 'sourceId'>) {
    return source.kind === 'day' ? this.days.evidence(source.sourceId) : null
  }

  daySourceTaskIds(source: Pick<ProactiveSource, 'kind' | 'sourceId'>) {
    return source.kind === 'day' ? this.days.taskIds(source.sourceId) : []
  }

  daySourceCurrent(source: Pick<ProactiveSource, 'kind' | 'sourceId'>) {
    return source.kind !== 'day' || this.days.current(source.sourceId)
  }

  daySourceProvenance(source: Pick<ProactiveSource, 'kind' | 'sourceId'>) {
    return source.kind === 'day' ? this.days.provenance(source.sourceId) : null
  }

  dayAnalysisSources(workdayId: string, evidenceIds: string[]): DaySourceLineage[] {
    const sources = [...new Set(evidenceIds)].map((id) => {
      const prefix = /^(speech|audio|app):(.+)$/.exec(id)
      const kind = prefix ? (prefix[1] as DaySourceLineage['kind']) : 'context'
      return { kind, sourceId: prefix?.[2] ?? id }
    })
    const versions = this.readContextVersions(
      sources.filter((source) => source.kind === 'context').map((source) => source.sourceId)
    )
    const retained = new Map(
      sources.flatMap(({ kind, sourceId }) => {
        const version = versions.get(sourceId)
        const cached = this.contextChecks.get(sourceId)
        return kind === 'context' && version?.workdayId === workdayId && cached?.token === version.token
          ? [[sourceId, cached.revision] as const]
          : []
      })
    )
    const contexts = this.readDayContexts(
      sources
        .filter((source) => source.kind === 'context' && !retained.has(source.sourceId))
        .map((source) => source.sourceId)
    )
    return sources.flatMap(({ kind, sourceId }) => {
      const revision = retained.get(sourceId)
      if (kind === 'context' && revision) return [{ kind, sourceId, workdayId, revision }]
      const context = contexts.get(sourceId)
      const row = kind === 'context' ? (context?.workdayId === workdayId ? context.row : null) : undefined
      const canonical = this.dayCanonical(kind, sourceId, workdayId, row)
      return canonical ? [{ kind, sourceId, workdayId, revision: canonical.eventRevision }] : []
    })
  }

  private readDayContexts(sourceIds: string[]) {
    const contexts = new Map<string, { workdayId: string; row: Row }>()
    if (sourceIds.length) {
      const rows = this.database
        .prepare(`SELECT c.id AS lookup_id, c.workday_id AS lookup_day,
        c.text, c.timestamp AS observed_at, c.window_title, c.url, c.text_source,
        c.trigger, c.focused_element_json, a.display_name AS app_name, a.bundle_id
        FROM context_evidence c JOIN application a ON a.id = c.application_id
        WHERE c.id IN (SELECT value FROM json_each(?))`)
        .all(JSON.stringify(sourceIds))
      for (const { lookup_id, lookup_day, ...row } of rows)
        contexts.set(String(lookup_id), { workdayId: String(lookup_day), row: row as Row })
    }
    return contexts
  }

  daySourceLineagePermitted(
    source: Pick<ProactiveSource, 'kind' | 'sourceId'>,
    policy: string,
    accept: (evidence: AmbientEvidence) => boolean
  ) {
    if (source.kind !== 'day') return false
    const lineage = this.days.lineage(source.sourceId)
    return lineage !== null && this.dayAnalysisSourcesPermitted(lineage, policy, accept)
  }

  dayAnalysisSourcesPermitted(
    sources: DaySourceLineage[],
    policy: string,
    accept: (evidence: AmbientEvidence) => boolean
  ) {
    return this.checkDaySources(sources, { key: policy, accept })
  }

  async warmDayAnalysisSources(
    workdayId: string,
    evidenceIds: string[],
    policy: string,
    accept: (evidence: AmbientEvidence) => boolean
  ) {
    for (let offset = 0; offset < evidenceIds.length; offset += 64) {
      this.withDaySourceReads(() => {
        const sources = this.dayAnalysisSources(workdayId, evidenceIds.slice(offset, offset + 64))
        this.checkDaySources(sources, { key: policy, accept })
      })
      await setImmediate()
    }
  }

  /** Cache only canonical revisions and policy outcomes; always read current revision tokens and offline periods. */
  async warmDaySource(id: string, policy: string, accept: (evidence: AmbientEvidence) => boolean, signal: AbortSignal) {
    signal.throwIfAborted()
    const lineage = this.days.lineage(id)
    if (!lineage) return
    const contexts = lineage.filter((source) => source.kind === 'context')
    for (let offset = 0; offset < contexts.length; offset += 200) {
      signal.throwIfAborted()
      this.withDaySourceReads(() => {
        const batch = contexts.slice(offset, offset + 200)
        this.checkDaySources(batch)
        this.dayAnalysisSourcesPermitted(batch, policy, accept)
      })
      await setImmediate(undefined, { signal })
    }
  }

  private readContextVersions(ids: string[]) {
    const versions = this.contextVersionReads ?? new Map<string, { workdayId: string; token: string } | null>()
    const missing = [...new Set(ids)].filter((id) => !versions.has(id))
    if (missing.length) {
      const rows = this.database
        .prepare(`SELECT c.id, c.workday_id, r.revision AS source_revision, a.display_name, a.bundle_id
        FROM context_evidence c JOIN application a ON a.id=c.application_id
        LEFT JOIN proactive_context_revision r ON r.source_id=c.id
        WHERE c.id IN (SELECT value FROM json_each(?))`)
        .all(JSON.stringify(missing))
      for (const id of missing) versions.set(id, null)
      for (const row of rows)
        versions.set(String(row.id), { workdayId: String(row.workday_id), token: JSON.stringify(row) })
    }
    return versions
  }

  private checkDaySources(
    sources: DaySourceLineage[],
    policy?: { key: string; accept: (evidence: AmbientEvidence) => boolean }
  ) {
    const contexts = sources.filter((source) => source.kind === 'context')
    const versions = this.readContextVersions(contexts.map((source) => source.sourceId))
    if (
      contexts.some((source) => {
        const version = versions.get(source.sourceId)
        const cached = this.contextChecks.get(source.sourceId)
        return (
          !version ||
          version.workdayId !== source.workdayId ||
          (cached?.token === version.token &&
            (cached.revision !== source.revision ||
              (policy && cached.policy === policy.key && cached.permitted === false)))
        )
      })
    )
      return false
    const missing = contexts.filter((source) => {
      const cached = this.contextChecks.get(source.sourceId)
      return (
        !cached || cached.token !== versions.get(source.sourceId)?.token || (policy && cached.policy !== policy.key)
      )
    })
    const raw = this.readDayContexts([...new Set(missing.map((source) => source.sourceId))])
    const offline = this.database.prepare('SELECT started_at, ended_at FROM offline_period').all()
    return sources.every((source) => {
      if (source.kind !== 'context') {
        const evidence = this.resolveDayLineage(source)
        return evidence !== null && (!policy || policy.accept(evidence))
      }
      const version = versions.get(source.sourceId)
      if (!version || version.workdayId !== source.workdayId) {
        this.contextChecks.delete(source.sourceId)
        return false
      }
      const token = version.token
      let cached = this.contextChecks.get(source.sourceId)
      if (!cached || cached.token !== token || (policy && cached.policy !== policy.key)) {
        const context = raw.get(source.sourceId)
        if (!context || context.workdayId !== source.workdayId) return false
        const canonical = this.dayCanonical('context', source.sourceId, source.workdayId, context.row)
        if (!canonical) return false
        const observedAt = Number(canonical.row.observed_at)
        const evidence: AmbientEvidence = {
          ...source,
          kind: 'context',
          revision: ambientEvidenceRevision(String(context.row.text)),
          observedAt,
          evidenceId: source.sourceId,
          text: String(context.row.text),
          source: 'screen',
          appName: String(context.row.app_name ?? ''),
          bundleId: String(context.row.bundle_id ?? ''),
          windowTitle: String(context.row.window_title ?? ''),
          url: String(context.row.url ?? ''),
        }
        cached = {
          token,
          revision: canonical.eventRevision,
          observedAt,
          ...(policy ? { policy: policy.key, permitted: policy.accept(evidence) } : {}),
        }
        this.contextChecks.delete(source.sourceId)
        this.contextChecks.set(source.sourceId, cached)
        while (this.contextChecks.size > 50_000) {
          const oldest = this.contextChecks.keys().next().value
          if (oldest === undefined) break
          this.contextChecks.delete(oldest)
        }
      }
      return (
        cached.revision === source.revision &&
        (!policy || cached.permitted === true) &&
        !offline.some(
          (period) =>
            Number(period.started_at) <= cached.observedAt &&
            (period.ended_at === null || Number(period.ended_at) > cached.observedAt)
        )
      )
    })
  }

  dayAnalysisSourceEvidence(sources: DaySourceLineage[]) {
    const contexts = this.readDayContexts(
      sources
        .filter((source) => source.kind === 'context' && !this.dayLineageReads?.has(JSON.stringify(source)))
        .map((source) => source.sourceId)
    )
    const evidence = sources.map((source) => {
      if (source.kind !== 'context') return this.resolveDayLineage(source)
      const key = JSON.stringify(source)
      if (this.dayLineageReads?.has(key)) return this.dayLineageReads.get(key) ?? null
      const context = contexts.get(source.sourceId)
      const evidence = this.readDayLineage(source, context?.workdayId === source.workdayId ? context.row : null)
      this.dayLineageReads?.set(key, evidence)
      return evidence
    })
    return evidence.some((source) => !source) ? null : (evidence as AmbientEvidence[])
  }

  private dayCanonical(kind: DaySourceLineage['kind'], sourceId: string, workdayId: string, contextRow?: Row | null) {
    if (kind === 'context' || kind === 'speech') return this.canonical(kind, sourceId, workdayId, contextRow)
    const row =
      kind === 'app'
        ? this.database
            .prepare(
              "SELECT s.id, s.started_at AS observed_at, a.display_name AS app_name, a.bundle_id, '' AS text FROM focus_segment s JOIN application a ON a.id = s.application_id WHERE s.id = ? AND s.workday_id = ?"
            )
            .get(sourceId, workdayId)
        : this.database
            .prepare(
              "SELECT id, started_at, started_at + duration_ms AS observed_at, source, transcript AS text FROM audio_evidence WHERE id = ? AND workday_id = ? AND status = 'ready' AND transcript <> ''"
            )
            .get(sourceId, workdayId)
    return row ? { row: row as Row, eventRevision: hash([kind, sourceId, workdayId, row]) } : null
  }

  private resolveDayLineage(reference: DaySourceLineage): AmbientEvidence | null {
    if (!this.dayLineageReads) return this.readDayLineage(reference)
    const key = JSON.stringify(reference)
    if (!this.dayLineageReads.has(key)) this.dayLineageReads.set(key, this.readDayLineage(reference))
    return this.dayLineageReads.get(key) ?? null
  }

  private readDayLineage(reference: DaySourceLineage, contextRow?: Row | null): AmbientEvidence | null {
    const current = this.dayCanonical(reference.kind, reference.sourceId, reference.workdayId, contextRow)
    if (!current || current.eventRevision !== reference.revision) return null
    const row = current.row
    const observedAt = Number(row.observed_at)
    if (
      this.database
        .prepare('SELECT 1 FROM offline_period WHERE started_at <= ? AND (ended_at IS NULL OR ended_at > ?) LIMIT 1')
        .get(observedAt, Number(row.started_at ?? observedAt))
    )
      return null
    return {
      ...reference,
      kind: reference.kind === 'app' ? 'context' : reference.kind === 'audio' ? 'speech' : reference.kind,
      revision: ambientEvidenceRevision(String(row.text)),
      observedAt,
      evidenceId: reference.kind === 'context' ? reference.sourceId : `${reference.kind}:${reference.sourceId}`,
      text: String(row.text),
      source: String(row.source ?? 'screen'),
      appName: String(row.app_name ?? ''),
      bundleId: String(row.bundle_id ?? ''),
      windowTitle: String(row.window_title ?? ''),
      url: String(row.url ?? ''),
    }
  }

  configureConsumer(enabled: boolean, now = Date.now()) {
    if (!finiteTime(now)) throw new Error('invalid-proactive-time')
    return this.transaction(() => {
      const current = this.consumer()
      if (current.enabled === enabled) {
        this.ensureDaySchedule(now)
        return current.generation
      }
      const update = this.database
        .prepare(
          'UPDATE proactive_consumer SET enabled = ?, generation = generation + 1, enabled_at = ?, after_sequence = (SELECT COALESCE(MAX(sequence),0) FROM proactive_event), scan_after_sequence = (SELECT COALESCE(MAX(sequence),0) FROM proactive_event) WHERE name = ?'
        )
        .run(Number(enabled), now, PROACTIVE_CONSUMER)
      if (update.changes !== 1) throw new Error('proactive-write-not-persisted')
      this.clearQueue()
      this.invalidateDecisions(now)
      this.ensureDaySchedule(now)
      return current.generation + 1
    })
  }

  invalidate(now = Date.now()) {
    if (!finiteTime(now)) throw new Error('invalid-proactive-time')
    return this.transaction(() => {
      if (
        this.database
          .prepare(
            'UPDATE proactive_consumer SET generation = generation + 1, enabled_at = ?, after_sequence = (SELECT COALESCE(MAX(sequence),0) FROM proactive_event), scan_after_sequence = (SELECT COALESCE(MAX(sequence),0) FROM proactive_event) WHERE name = ?'
          )
          .run(now, PROACTIVE_CONSUMER).changes !== 1
      )
        throw new Error('proactive-write-not-persisted')
      this.clearQueue()
      this.invalidateDecisions(now)
      this.ensureDaySchedule(now)
      return this.generation()
    })
  }

  private invalidateDecisions(now: number) {
    this.database
      .prepare(
        'UPDATE proactive_decision SET invalidated_at = ? WHERE consumer = ? AND delivered_message_id IS NULL AND invalidated_at IS NULL'
      )
      .run(now, PROACTIVE_CONSUMER)
    if (
      this.database
        .prepare(
          'SELECT id FROM proactive_decision WHERE consumer = ? AND delivered_message_id IS NULL AND invalidated_at IS NULL LIMIT 1'
        )
        .get(PROACTIVE_CONSUMER)
    )
      throw new Error('proactive-write-not-persisted')
  }

  private clearQueue() {
    this.database.prepare('DELETE FROM proactive_queue WHERE consumer=?').run(PROACTIVE_CONSUMER)
    if (this.database.prepare('SELECT 1 FROM proactive_queue WHERE consumer=? LIMIT 1').get(PROACTIVE_CONSUMER))
      throw new Error('proactive-write-not-persisted')
  }

  private canonical(kind: ProactiveSourceKind, sourceId: string, workdayId: string, contextRow?: Row | null) {
    if (kind === 'note') return workdayId === '' ? this.notes.resolve(sourceId) : null
    if (kind === 'day') return this.days.resolve(sourceId)
    if (kind !== 'context' && kind !== 'speech') return null
    const row =
      kind === 'context'
        ? contextRow !== undefined
          ? contextRow
          : this.database
              .prepare(`SELECT c.text, c.timestamp AS observed_at, c.window_title, c.url, c.text_source,
          c.trigger, c.focused_element_json, a.display_name AS app_name, a.bundle_id
          FROM context_evidence c JOIN application a ON a.id = c.application_id WHERE c.id = ? AND c.workday_id = ?`)
              .get(sourceId, workdayId)
        : this.database
            .prepare(`SELECT text, source, started_at, ended_at AS observed_at, chunk_id, chunk_ids_json,
          detected_language, accepted_language, rejection_reason, transcription_outcome, vad_started_at, vad_ended_at,
          asr_window_index, asr_window_count FROM speech_segment WHERE id = ? AND workday_id = ?`)
            .get(sourceId, workdayId)
    if (!row || typeof row.text !== 'string' || !row.text.trim()) return null
    if (kind === 'speech' && (row.rejection_reason !== null || row.transcription_outcome !== 'transcribed')) return null
    const chunks =
      kind === 'speech'
        ? this.database
            .prepare(`SELECT a.id, a.source, a.started_at, a.duration_ms, a.media_playback_json,
      a.capture_epoch_id, a.capture_sequence, a.captured_sample_count, a.capture_sample_time, a.capture_outcome
      FROM (SELECT ? AS id UNION SELECT value FROM json_each(?)) chunks
      CROSS JOIN audio_evidence a ON a.id = chunks.id
      WHERE a.workday_id = ? AND a.source = ? ORDER BY a.id`)
            .all(String(row.chunk_id), String(row.chunk_ids_json), workdayId, String(row.source))
        : []
    const recorded = chunks.some((chunk) => {
      if (
        Number(chunk.started_at) >= Number(row.observed_at) ||
        Number(chunk.started_at) + Number(chunk.duration_ms) <= Number(row.started_at)
      )
        return false
      try {
        return JSON.parse(String(chunk.media_playback_json ?? 'null'))?.isPlaying === true
      } catch {
        return false
      }
    })
    const provenance: ProactiveSource['provenance'] = {
      speaker: 'unknown',
      mediaPlayback: recorded ? 'recorded' : 'unknown',
      inputRoute: String(row.source ?? 'screen'),
    }
    const eventRevision = hash({ kind, sourceId, workdayId, row, chunks })
    const contentKey = hash([
      kind,
      row.text.trim().replace(/\s+/g, ' '),
      row.app_name ?? '',
      row.bundle_id ?? '',
      row.window_title ?? '',
      row.url ?? '',
      row.text_source ?? '',
      provenance,
    ])
    return {
      row,
      chunks,
      provenance,
      eventRevision,
      contentKey,
    }
  }

  /** Called within the source writer's transaction, after its canonical row is saved. */
  enqueue(kind: AmbientEvidenceKind, sourceId: string, workdayId: string, now = Date.now()) {
    const source = this.canonical(kind, sourceId, workdayId)
    if (!source) return
    this.enqueueCanonical(kind, sourceId, workdayId, source, now)
  }

  private enqueueCanonical(
    kind: ProactiveSourceKind,
    sourceId: string,
    workdayId: string,
    source: NonNullable<ReturnType<ProactiveStore['canonical']>>,
    now: number
  ) {
    const eventId = `proactive:${hash([kind, sourceId, source.eventRevision])}`
    const result = this.database
      .prepare(`INSERT OR IGNORE INTO proactive_event
      (event_id,kind,source_id,workday_id,event_revision,content_key,observed_at,accepted_at,available_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(
        eventId,
        kind,
        sourceId,
        workdayId,
        source.eventRevision,
        source.contentKey,
        Number(source.row.observed_at),
        now,
        now + (kind === 'note' || kind === 'day' ? 0 : kind === 'speech' ? 2_000 : 10_000)
      )
    if (
      result.changes !== 1 &&
      !this.database.prepare('SELECT event_id FROM proactive_event WHERE event_id = ?').get(eventId)
    )
      throw new Error('proactive-write-not-persisted')
  }

  resolve(
    reference: Pick<ProactiveSourceRef, 'eventId' | 'kind' | 'sourceId' | 'workdayId' | 'eventRevision' | 'contentKey'>
  ): ProactiveSource | null {
    try {
      return this.resolveCurrent(reference)
    } catch (error) {
      if (error instanceof Error && error.message === NOTE_SOURCE_UNAVAILABLE) return null
      throw error
    }
  }

  private resolveCurrent(
    reference: Pick<ProactiveSourceRef, 'eventId' | 'kind' | 'sourceId' | 'workdayId' | 'eventRevision' | 'contentKey'>
  ): ProactiveSource | null {
    const event = this.database.prepare('SELECT * FROM proactive_event WHERE event_id = ?').get(reference.eventId)
    if (
      !event ||
      event.kind !== reference.kind ||
      event.source_id !== reference.sourceId ||
      event.workday_id !== reference.workdayId ||
      event.event_revision !== reference.eventRevision ||
      event.content_key !== reference.contentKey
    )
      return null
    const source = this.canonical(reference.kind, reference.sourceId, reference.workdayId)
    if (!source || source.eventRevision !== reference.eventRevision) return null
    const { row, provenance } = source
    const startedAt = Number(row.started_at ?? row.observed_at)
    if (
      reference.kind !== 'note' &&
      reference.kind !== 'day' &&
      this.database
        .prepare('SELECT 1 FROM offline_period WHERE started_at <= ? AND (ended_at IS NULL OR ended_at > ?) LIMIT 1')
        .get(Number(row.observed_at), startedAt)
    )
      return null
    return {
      ...reference,
      sequence: Number(event.sequence),
      acceptedAt: Number(event.accepted_at),
      revision: ambientEvidenceRevision(String(row.text)),
      observedAt: Number(row.observed_at),
      evidenceId: reference.kind === 'context' ? reference.sourceId : `${reference.kind}:${reference.sourceId}`,
      text: String(row.text),
      source: String(row.source ?? 'screen'),
      appName: String(row.app_name ?? ''),
      bundleId: String(row.bundle_id ?? ''),
      windowTitle: String(row.window_title ?? ''),
      url: String(row.url ?? ''),
      provenance,
    }
  }

  private eventRef(row: Row) {
    return {
      eventId: String(row.event_id),
      kind: row.kind as ProactiveSourceKind,
      sourceId: String(row.source_id),
      workdayId: String(row.workday_id),
      eventRevision: String(row.event_revision),
      contentKey: String(row.content_key),
    }
  }

  private considered(eventId: string, decisionId: string | null, state: string, at: number) {
    const operation = () => {
      const result = this.database
        .prepare('INSERT OR IGNORE INTO proactive_considered(consumer,event_id,decision_id,state,at) VALUES(?,?,?,?,?)')
        .run(PROACTIVE_CONSUMER, eventId, decisionId, state, at)
      if (result.changes !== 1) {
        const previous = this.database
          .prepare('SELECT * FROM proactive_considered WHERE consumer = ? AND event_id = ?')
          .get(PROACTIVE_CONSUMER, eventId)
        if (!previous || previous.decision_id !== decisionId || previous.state !== state)
          throw new Error('proactive-write-not-persisted')
      }
      this.database
        .prepare('DELETE FROM proactive_queue WHERE consumer=? AND event_id=?')
        .run(PROACTIVE_CONSUMER, eventId)
      if (
        this.database
          .prepare('SELECT 1 FROM proactive_queue WHERE consumer=? AND event_id=?')
          .get(PROACTIVE_CONSUMER, eventId)
      )
        throw new Error('proactive-write-not-persisted')
    }
    if (this.database.isTransaction) operation()
    else this.transaction(operation)
  }

  private fillQueue() {
    const consumer = this.consumer()
    if (!consumer.enabled) return consumer
    const head = Number(
      this.database.prepare('SELECT COALESCE(MAX(sequence),0) AS head FROM proactive_event').get()?.head ?? 0
    )
    if (head <= consumer.scanAfterSequence) return consumer
    const operation = () => {
      const current = this.consumer()
      if (!current.enabled) return current
      this.database
        .prepare(`INSERT OR IGNORE INTO proactive_queue(consumer,event_id)
        SELECT ?,e.event_id FROM proactive_event e WHERE e.sequence>? AND e.sequence<=? AND e.accepted_at>=?
        AND NOT EXISTS(SELECT 1 FROM proactive_considered c WHERE c.consumer=? AND c.event_id=e.event_id)`)
        .run(PROACTIVE_CONSUMER, current.scanAfterSequence, head, current.enabledAt, PROACTIVE_CONSUMER)
      if (
        this.database
          .prepare(`SELECT 1 FROM proactive_event e WHERE e.sequence>? AND e.sequence<=? AND e.accepted_at>=?
        AND NOT EXISTS(SELECT 1 FROM proactive_considered c WHERE c.consumer=? AND c.event_id=e.event_id)
        AND NOT EXISTS(SELECT 1 FROM proactive_queue q WHERE q.consumer=? AND q.event_id=e.event_id) LIMIT 1`)
          .get(current.scanAfterSequence, head, current.enabledAt, PROACTIVE_CONSUMER, PROACTIVE_CONSUMER)
      )
        throw new Error('proactive-write-not-persisted')
      this.database
        .prepare('UPDATE proactive_consumer SET scan_after_sequence=MAX(scan_after_sequence,?) WHERE name=?')
        .run(head, PROACTIVE_CONSUMER)
      const updated = this.consumer()
      if (updated.scanAfterSequence < head) throw new Error('proactive-write-not-persisted')
      return updated
    }
    return this.database.isTransaction ? operation() : this.transaction(operation)
  }

  batch(now: number, allowed: (kind: ProactiveSourceKind) => boolean, accept: (source: ProactiveSource) => boolean) {
    const consumer = this.fillQueue()
    if (!consumer.enabled) return []
    const selected: ProactiveSource[] = []
    let characters = 0
    const rows = this.database
      .prepare(`SELECT e.* FROM proactive_queue q CROSS JOIN proactive_event e ON e.event_id=q.event_id
      WHERE q.consumer=? AND e.accepted_at>=? AND e.sequence>? AND e.available_at<=?
      AND NOT EXISTS(SELECT 1 FROM proactive_considered c WHERE c.consumer=q.consumer AND c.event_id=e.event_id)
      ORDER BY CASE WHEN e.kind='speech' AND e.observed_at>=? THEN 0 ELSE 1 END,e.available_at,e.sequence LIMIT 200`)
      .all(PROACTIVE_CONSUMER, consumer.enabledAt, consumer.afterSequence, now, now - 120_000)
    for (const row of rows) {
      let source: ProactiveSource | null
      try {
        source = this.resolveCurrent(this.eventRef(row))
      } catch (error) {
        if (error instanceof Error && error.message === NOTE_SOURCE_UNAVAILABLE) continue
        throw error
      }
      if (!source) {
        this.considered(String(row.event_id), null, 'invalidated', now)
        continue
      }
      if (!allowed(source.kind) || !accept(source)) {
        this.considered(source.eventId, null, 'excluded', now)
        continue
      }
      if (
        source.kind === 'context' &&
        (/^computer\.remember(?:\.|$)/i.test(source.bundleId) || /^Remember(?:\s|$)/i.test(source.appName))
      ) {
        this.considered(source.eventId, null, 'own-output', now)
        continue
      }
      if (
        source.observedAt < now - proactiveSourceMaxAgeMs(source) ||
        source.observedAt > now ||
        (source.kind === 'note' && source.observedAt < consumer.enabledAt)
      ) {
        this.considered(source.eventId, null, 'stale', now)
        continue
      }
      const duplicate = this.database
        .prepare(`SELECT c.decision_id FROM proactive_considered c JOIN proactive_event e ON e.event_id = c.event_id
        WHERE c.consumer = ? AND e.content_key = ? AND c.decision_id IS NOT NULL AND c.at >= ? ORDER BY c.at DESC LIMIT 1`)
        .get(PROACTIVE_CONSUMER, source.contentKey, now - DEDUPE_WINDOW)
      const duplicateDecision = duplicate && source.kind === 'day' ? this.get(String(duplicate.decision_id)) : null
      if (
        duplicate &&
        (source.kind !== 'day' ||
          (duplicateDecision?.invalidatedAt === null &&
            duplicateDecision.sourceRefs.every(
              (reference) =>
                this.resolve(reference) &&
                (reference.kind !== 'day' || this.days.retains(reference.sourceId, source.sourceId))
            )))
      ) {
        this.considered(source.eventId, String(duplicate.decision_id), 'equivalent', now)
        continue
      }
      if (selected.some((entry) => entry.contentKey === source.contentKey)) continue
      if (source.text.length > AMBIENT_BATCH_CHARACTERS) throw new Error('proactive-evidence-exceeds-budget')
      if (
        selected.length &&
        (selected[0]?.workdayId !== source.workdayId ||
          (selected[0]?.kind === 'note') !== (source.kind === 'note') ||
          (selected[0]?.kind === 'day') !== (source.kind === 'day') ||
          characters + source.text.length > AMBIENT_BATCH_CHARACTERS)
      )
        break
      selected.push(source)
      characters += source.text.length
      if (selected.length === AMBIENT_BATCH_RECORDS) break
    }
    return selected
  }

  commit(input: ProactiveCommit) {
    return this.transaction(() => this.commitInTransaction(input))
  }

  commitInTransaction(input: ProactiveCommit): ProactiveDecision {
    if (!this.database.isTransaction) throw new Error('proactive-transaction-required')
    const consumer = this.consumer()
    if (!consumer.enabled || consumer.generation !== input.consumerGeneration)
      throw new Error('proactive-generation-changed')
    const decision = structuredClone(input.decision)
    const noteBatch = input.sources.some((source) => source.kind === 'note')
    const dayBatch = input.sources.some((source) => source.kind === 'day')
    if (
      !decision ||
      !['silent', 'observe', 'clarify', 'offer', 'prepare'].includes(decision.kind) ||
      typeof decision.id !== 'string' ||
      !decision.id ||
      decision.id.length > 200 ||
      typeof decision.text !== 'string' ||
      decision.text.length > 20_000 ||
      typeof decision.topicKey !== 'string' ||
      (decision.kind !== 'silent' && !decision.topicKey) ||
      decision.topicKey.length > 300 ||
      typeof decision.policyToken !== 'string' ||
      !decision.policyToken ||
      decision.policyToken.length > 20_000 ||
      !finiteTime(decision.createdAt) ||
      !finiteTime(decision.expiresAt) ||
      decision.expiresAt <= decision.createdAt ||
      !finiteTime(decision.conversationGeneration) ||
      !Array.isArray(decision.sourceIds) ||
      !Array.isArray(decision.supportingQuotes) ||
      (decision.reason !== undefined &&
        !['interpreted', 'analysis-error', 'user-interaction'].includes(decision.reason)) ||
      (decision.reason !== undefined && decision.reason !== 'interpreted' && decision.kind !== 'silent') ||
      !input.sources.length ||
      (noteBatch && (decision.kind === 'prepare' || input.sources.some((source) => source.kind !== 'note'))) ||
      (dayBatch && (decision.kind === 'prepare' || input.sources.some((source) => source.kind !== 'day'))) ||
      input.sources.length > AMBIENT_BATCH_RECORDS ||
      new Set(input.sources.map((source) => source.eventId)).size !== input.sources.length ||
      new Set(decision.sourceIds).size !== decision.sourceIds.length ||
      decision.sourceIds.some((id) => !input.sources.some((source) => source.evidenceId === id)) ||
      decision.supportingQuotes.some(
        (entry) =>
          !entry ||
          typeof entry.quote !== 'string' ||
          !entry.quote.trim() ||
          entry.quote.length > 4000 ||
          !decision.sourceIds.includes(entry.sourceId) ||
          !input.sources.find((source) => source.evidenceId === entry.sourceId)?.text.includes(entry.quote)
      ) ||
      (decision.kind !== 'silent' &&
        decision.sourceIds.some((id) => !decision.supportingQuotes.some((entry) => entry.sourceId === id))) ||
      (decision.kind !== 'silent' &&
        (!decision.text.trim() ||
          !decision.sourceIds.length ||
          input.sources.some(
            (source) =>
              source.observedAt > decision.createdAt ||
              source.observedAt < decision.createdAt - proactiveSourceMaxAgeMs(source)
          )))
    )
      throw new Error('invalid-proactive-decision')
    if (!dayBatch && (decision.taskIds !== undefined || decision.followUps !== undefined))
      throw new Error('invalid-proactive-day-metadata')
    if (dayBatch) {
      const tasksFor = (sources: ProactiveSource[]) =>
        new Set(
          sources.flatMap((source) => {
            const state = JSON.parse(source.text) as {
              tasks?: { id?: unknown; lifecycle?: unknown; proactiveEligible?: unknown }[]
            }
            return (state.tasks ?? []).flatMap((task) =>
              typeof task.id === 'string' && task.lifecycle === 'open' && task.proactiveEligible !== false
                ? [task.id]
                : []
            )
          })
        )
      const allTaskIds = tasksFor(input.sources)
      const citedTaskIds = tasksFor(input.sources.filter((source) => decision.sourceIds.includes(source.evidenceId)))
      const taskIds = decision.taskIds
      const followUps = decision.followUps
      if (
        !Array.isArray(taskIds) ||
        taskIds.length > (decision.kind === 'silent' ? 0 : 1) ||
        (decision.kind !== 'silent' &&
          (taskIds.length
            ? !citedTaskIds.has(taskIds[0]) ||
              decision.topicKey !== `task:${taskIds[0]}` ||
              !decision.supportingQuotes.some((support) => {
                const source = input.sources.find((entry) => entry.evidenceId === support.sourceId)
                const task =
                  source && JSON.parse(source.text).tasks?.find((entry: { id: string }) => entry.id === taskIds[0])
                return task && JSON.stringify(task).includes(support.quote)
              })
            : decision.topicKey !== contextualTopicKey(decision.topicKey) ||
              !decision.supportingQuotes.some((support) => {
                const source = input.sources.find((entry) => entry.evidenceId === support.sourceId)
                return source && dayContextSupportsQuote(source.text, support.quote)
              }))) ||
        !Array.isArray(followUps) ||
        followUps.length > 8 ||
        new Set(followUps.map((entry) => entry?.taskId)).size !== followUps.length ||
        followUps.some(
          (entry) =>
            !entry ||
            Object.keys(entry).sort().join(',') !== 'nextReviewAt,note,taskId' ||
            typeof entry.taskId !== 'string' ||
            !allTaskIds.has(entry.taskId) ||
            typeof entry.note !== 'string' ||
            !entry.note.trim() ||
            entry.note.length > 320 ||
            !finiteTime(entry.nextReviewAt) ||
            entry.nextReviewAt <= decision.createdAt ||
            entry.nextReviewAt > decision.createdAt + FOLLOW_UP_LIMIT
        ) ||
        [...taskIds, ...followUps.map((entry) => entry.taskId)].some(
          (id) =>
            this.database.prepare("SELECT id FROM work_item WHERE id=? AND lifecycle='open'").get(id) === undefined
        )
      )
        throw new Error('invalid-proactive-day-metadata')
      decision.followUps = followUps.map((entry) => ({
        ...entry,
        nextReviewAt: Math.max(decision.createdAt + DAY_REVIEW_INTERVAL, entry.nextReviewAt),
      }))
    }
    const sourceRefs = input.sources.map(ref)
    const deletionRevision = Number(
      this.database.prepare('SELECT revision FROM evidence_privacy WHERE id = 1').get()?.revision ?? 0
    )
    const payload = { ...decision, sourceRefs, consumerGeneration: input.consumerGeneration, deletionRevision }
    const inputHash = hash(payload)
    const existing = this.get(decision.id)
    if (existing) {
      if (existing.inputHash !== inputHash) throw new Error('proactive-decision-conflict')
      return existing
    }
    for (const source of input.sources) {
      const current = this.resolve(source)
      if (
        !current ||
        !this.daySourceCurrent(source) ||
        JSON.stringify(current) !== JSON.stringify(source) ||
        source.acceptedAt < consumer.enabledAt ||
        (source.kind === 'note' && source.observedAt < consumer.enabledAt) ||
        source.sequence <= consumer.afterSequence
      )
        throw new Error('proactive-source-changed')
      if (
        this.database
          .prepare('SELECT 1 FROM proactive_considered WHERE consumer = ? AND event_id = ?')
          .get(PROACTIVE_CONSUMER, source.eventId)
      )
        throw new Error('proactive-source-already-considered')
    }
    const insert = this.database
      .prepare(
        'INSERT INTO proactive_decision(id,consumer,generation,input_hash,decision_json,created_at) VALUES(?,?,?,?,?,?)'
      )
      .run(
        decision.id,
        PROACTIVE_CONSUMER,
        input.consumerGeneration,
        inputHash,
        JSON.stringify(payload),
        decision.createdAt
      )
    if (insert.changes !== 1) throw new Error('proactive-write-not-persisted')
    for (const source of input.sources) this.considered(source.eventId, decision.id, 'decided', decision.createdAt)
    this.recordDayAssessment(decision, input.sources)
    return { ...payload, inputHash, deliveredMessageId: null, invalidatedAt: null }
  }

  get(id: string): ProactiveDecision | null {
    const row = this.database
      .prepare('SELECT * FROM proactive_decision WHERE id = ? AND consumer = ?')
      .get(id, PROACTIVE_CONSUMER)
    return row
      ? {
          ...JSON.parse(String(row.decision_json)),
          inputHash: String(row.input_hash),
          deliveredMessageId: row.delivered_message_id === null ? null : String(row.delivered_message_id),
          invalidatedAt: row.invalidated_at === null ? null : Number(row.invalidated_at),
        }
      : null
  }

  pendingDeliveries(now: number, eligible: (decision: ProactiveDecision) => boolean = () => true): ProactiveDecision[] {
    const consumer = this.consumer()
    if (!consumer.enabled) return []
    const deletionRevision = Number(
      this.database.prepare('SELECT revision FROM evidence_privacy WHERE id = 1').get()?.revision ?? 0
    )
    const rows = this.database
      .prepare(
        "SELECT id FROM proactive_decision WHERE consumer = ? AND delivered_message_id IS NULL AND invalidated_at IS NULL AND json_extract(decision_json,'$.kind') <> 'silent' ORDER BY created_at,id"
      )
      .all(PROACTIVE_CONSUMER)
    return rows.flatMap((row) => {
      const decision = this.get(String(row.id))
      if (!decision) throw new Error('proactive-decision-unavailable')
      const invalidate = () => {
        if (
          this.database
            .prepare('UPDATE proactive_decision SET invalidated_at = ? WHERE id = ? AND invalidated_at IS NULL')
            .run(now, decision.id).changes !== 1
        )
          throw new Error('proactive-write-not-persisted')
      }
      if (
        decision.consumerGeneration !== consumer.generation ||
        decision.deletionRevision !== deletionRevision ||
        decision.expiresAt <= now
      ) {
        invalidate()
        return []
      }
      // Undeliverable proposals do not need to hydrate thousands of retained sources every tick.
      // Full source validation still runs immediately before any eligible delivery.
      if (!eligible(decision)) return []
      let unavailable = false
      const sourceInvalid = decision.sourceRefs.some((reference) => {
        try {
          return reference.observedAt < now - proactiveSourceMaxAgeMs(reference) || !this.resolveCurrent(reference)
        } catch (error) {
          if (!(error instanceof Error) || error.message !== NOTE_SOURCE_UNAVAILABLE) throw error
          unavailable = true
          return false
        }
      })
      if (sourceInvalid) {
        invalidate()
        return []
      }
      if (unavailable) return []
      return [decision]
    })
  }

  acknowledgeDelivery(id: string, inputHash: string, messageId: string, now = Date.now()) {
    return this.transaction(() => {
      const decision = this.get(id)
      if (
        !decision ||
        decision.inputHash !== inputHash ||
        !messageId ||
        messageId.length > 200 ||
        decision.invalidatedAt !== null ||
        decision.kind === 'silent' ||
        (decision.deliveredMessageId !== null && decision.deliveredMessageId !== messageId)
      )
        throw new Error('proactive-delivery-conflict')
      if (decision.deliveredMessageId !== null) return
      if (
        this.database
          .prepare(
            'UPDATE proactive_decision SET delivered_message_id = ?, delivered_at = ? WHERE id = ? AND delivered_message_id IS NULL AND invalidated_at IS NULL'
          )
          .run(messageId, now, id).changes !== 1
      )
        throw new Error('proactive-write-not-persisted')
    })
  }
}
