import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { DayAnalysisProvenance, DayMemory, WorkItem } from '@remember/shared'
import { AMBIENT_BATCH_CHARACTERS, type AmbientEvidence } from './ambientTaskStore'
import { ProactiveDayStorage } from './proactiveDayStorage'
import { readWorkdayMemory } from './workdayMemory'

type Row = Record<string, unknown>
export type DaySourceLineage = DayAnalysisProvenance['rawSources'][number]
export type DayReviewContext = { slotId: string; reason: string; checkedAt: number }
type Task = ReturnType<typeof compactTaskEvidence>
type DayState = ReturnType<typeof compactDay>
type Snapshot = {
  id: string
  workdayId: string
  observedAt: number
  revision: string
  semanticRevision?: string
  deletionRevision: number
  day: DayState
  tasks: Task[]
  taskRevision: string
  taskSources: { id: string; revision: string }[]
  taskClaims?: { table: 'work_item_fact' | 'work_item_observation'; id: string; revision: string }[]
  review?: DayReviewContext
  lineage: DaySourceLineage[]
  provenance: DayAnalysisProvenance | null
  text: string
}

function hash(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(value) ?? 'undefined')
    .digest('hex')
}
function text(value: unknown, limit: number) {
  return typeof value === 'string' ? value.slice(0, limit) : ''
}
function list(value: unknown, limit = 8) {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === 'string')
        .slice(0, limit)
        .map((entry) => entry.slice(0, 600))
    : []
}
function compactDay(memory: DayMemory, date: string) {
  const state = {
    date,
    summary: text(memory.summary, 6_000),
    currentFocus: text(memory.currentFocus, 1_000),
    outcomes: list(memory.outcomes),
    decisions: list(memory.decisions),
    openLoops: list(memory.openLoops),
    ...(memory.projectAttention?.length
      ? {
          projectAttention: {
            basis: 'model-estimated-project-attention-not-measured-work-hours',
            coverageThrough: memory.coveredThrough,
            refreshedAt: memory.refreshedAt,
            projects: memory.projectAttention.slice(0, 5).map(({ project, durationMinutes }) => ({
              project: text(project, 60),
              durationMinutes,
            })),
          },
        }
      : {}),
  }
  for (const values of [state.outcomes, state.decisions, state.openLoops]) {
    while (values.length && JSON.stringify(state).length > 16_000) values.pop()
  }
  return state
}
export function compactTaskEvidence(item: WorkItem, evidence: AmbientEvidence[]) {
  const userFacts = item.facts.filter((fact) => fact.actor === 'user').sort((a, b) => b.at - a.at)
  const adoption = userFacts.find((fact) => ['created', 'edited', 'reopened'].includes(fact.type))
  const userOwned = item.sources.some((source) => source.kind === 'manual') || Boolean(adoption)
  const observations = item.observations
    .filter((entry) => entry.dismissedAt === null)
    .sort((a, b) => b.observedAt - a.observedAt)
  const completion = observations.find((entry) => entry.kind === 'completion_candidate')
  const completionUnresolved = Boolean(completion && (!adoption || adoption.at <= completion.observedAt))
  const origins = [
    ...new Set(evidence.map((entry) => (isRememberSource(entry) ? 'remember' : entry.appName || entry.kind))),
  ]
  if (item.sources.some((source) => source.kind === 'manual')) origins.push('user-created-task')
  if (item.sources.some((source) => source.kind === 'meeting')) origins.push('derived-conversation')
  const onlyRemember = origins.length > 0 && origins.every((origin) => origin === 'remember')
  return {
    id: item.id,
    title: text(item.title, 240),
    description: text(item.description, 400),
    lifecycle: item.lifecycle,
    status: item.status,
    priority: item.priority,
    dueAt: item.dueAt,
    attention: item.attention,
    updatedAt: item.updatedAt,
    userOwned,
    claimKind: userOwned ? 'user-adopted-task' : 'derived-task-unconfirmed-ownership',
    proactiveEligible: item.lifecycle === 'open' && !(onlyRemember && !userOwned) && !completionUnresolved,
    uncertainty:
      onlyRemember && !userOwned
        ? 'self-observation-without-user-adoption'
        : completionUnresolved
          ? 'completion-observed-but-lifecycle-open'
          : userOwned
            ? null
            : 'open-state-does-not-establish-a-promise',
    sourceOrigins: origins.length ? origins : ['unknown'],
    lastSourceAt: Math.max(0, ...item.sources.map((source) => source.observedAt)),
    userFacts: userFacts.slice(0, 2).map(({ type, summary, at }) => ({ type, summary: text(summary, 160), at })),
    observations: [
      ...new Map([...(completion ? [completion] : []), ...observations].map((entry) => [entry.id, entry])).values(),
    ]
      .slice(0, 3)
      .map(({ kind, observedAt }) => ({ kind, observedAt })),
    sourceExcerpts: [...evidence]
      .sort((a, b) => b.observedAt - a.observedAt)
      .slice(0, 1)
      .map((entry) => ({
        evidenceId: entry.evidenceId,
        observedAt: entry.observedAt,
        app: entry.appName,
        attribution: 'observed-surface-text-not-verified-user-authorship',
        excerpt: text(entry.text, 300),
      })),
  }
}

function isRememberSource(source: Pick<AmbientEvidence, 'appName' | 'bundleId'>) {
  return /^Remember(?:\s|$)/i.test(source.appName) || /^computer\.remember(?:\.|$)/i.test(source.bundleId)
}

function retainsProvenance(previous: DayAnalysisProvenance | null, next: DayAnalysisProvenance | null) {
  if (!previous) return true
  if (!next) return false
  const rawSources = new Set(next.rawSources.map(hash))
  const agentMessages = new Set(next.agentMessages.map(hash))
  const wikiPages = new Set(next.wikiPages.map(hash))
  const taskIds = new Set(next.taskIds)
  return (
    previous.rawSources.every((source) => rawSources.has(hash(source))) &&
    previous.agentMessages.every((source) => agentMessages.has(hash(source))) &&
    previous.wikiPages.every((source) => wikiPages.has(hash(source))) &&
    previous.taskIds.every((id) => taskIds.has(id))
  )
}

/** Immutable projections of a completed Day sync. Sources remain independently revocable. */
export class ProactiveDaySources {
  private readonly storage: ProactiveDayStorage
  private reads: Map<string, Snapshot | null> | null = null
  private resolutions: Map<string, ReturnType<ProactiveDaySources['resolveUncached']>> | null = null
  private taskReads: Map<string, string | null> | null = null
  private readonly snapshots = new Map<string, { token: string; value: Snapshot; characters: number }>()
  private snapshotCharacters = 0
  private readonly snapshotHashes = new WeakMap<Snapshot, string>()

  /** Reuse immutable projections only within a synchronous, read-only access check. */
  withReads<T>(operation: () => T): T {
    const previousReads = this.reads
    const previousResolutions = this.resolutions
    const previousTasks = this.taskReads
    this.reads = new Map()
    this.resolutions = new Map()
    this.taskReads = new Map()
    try {
      const result = operation()
      if (result && typeof (result as { then?: unknown }).then === 'function')
        throw new Error('day-source-reads-must-be-synchronous')
      return result
    } finally {
      this.reads = previousReads
      this.resolutions = previousResolutions
      this.taskReads = previousTasks
    }
  }

  constructor(
    private readonly database: DatabaseSync,
    private readonly sources: {
      resolve(references: DaySourceLineage[]): AmbientEvidence[] | null
      current?(references: DaySourceLineage[]): boolean
      collect(workdayId: string, evidenceIds: string[]): DaySourceLineage[]
    }
  ) {
    database.exec(`CREATE TABLE IF NOT EXISTS proactive_day_source (
      id TEXT PRIMARY KEY, workday_id TEXT NOT NULL REFERENCES workday(id) ON DELETE CASCADE,
      observed_at INTEGER NOT NULL, revision TEXT NOT NULL, snapshot_json TEXT NOT NULL,
      UNIQUE(workday_id, revision)
    );
    CREATE INDEX IF NOT EXISTS proactive_day_semantic ON proactive_day_source (
      workday_id, COALESCE(json_extract(snapshot_json, '$.semanticRevision'), revision), observed_at DESC
    );
    CREATE TABLE IF NOT EXISTS proactive_day_revision (source_id TEXT PRIMARY KEY, revision TEXT NOT NULL) STRICT;
    CREATE TRIGGER IF NOT EXISTS proactive_day_insert AFTER INSERT ON proactive_day_source BEGIN
      INSERT OR REPLACE INTO proactive_day_revision VALUES (NEW.id, hex(randomblob(16)));
    END;
    CREATE TRIGGER IF NOT EXISTS proactive_day_update AFTER UPDATE ON proactive_day_source BEGIN
      DELETE FROM proactive_day_revision WHERE source_id=OLD.id;
      INSERT INTO proactive_day_revision VALUES (NEW.id, hex(randomblob(16)));
    END;
    CREATE TRIGGER IF NOT EXISTS proactive_day_delete AFTER DELETE ON proactive_day_source BEGIN
      DELETE FROM proactive_day_revision WHERE source_id=OLD.id;
    END;`)
    this.storage = new ProactiveDayStorage(database)
  }

  maintainStorage() {
    this.database.exec('SAVEPOINT proactive_day_storage_maintenance')
    try {
      const count = this.storage.compactBatch(1)
      this.database.exec('RELEASE proactive_day_storage_maintenance')
      return count
    } catch (error) {
      this.database.exec('ROLLBACK TO proactive_day_storage_maintenance; RELEASE proactive_day_storage_maintenance;')
      console.warn('[proactive] Day storage maintenance deferred', {
        failure: error instanceof Error ? error.name : 'unknown',
      })
      return 0
    }
  }

  private day(workdayId: string) {
    const row = this.database.prepare('SELECT * FROM workday WHERE id = ?').get(workdayId)
    if (row?.refresh_status !== 'idle' || typeof row.memory_json !== 'string') return null
    const memory = readWorkdayMemory(this.database, row.memory_json)
    if (!Number.isSafeInteger(memory.refreshedAt) || !Number.isSafeInteger(memory.coveredThrough)) return null
    return { memory, state: compactDay(memory, String(row.local_day)) }
  }

  private taskRevision() {
    return hash({
      items: this.database
        .prepare(
          'SELECT id,title,description,prompt,context,return_last_move,return_unresolved,return_next_move,lifecycle,status,priority,due_at,attention,updated_at,user_edited_title,user_edited_description FROM work_item ORDER BY id'
        )
        .all(),
      facts: this.database.prepare("SELECT * FROM work_item_fact WHERE actor='user' ORDER BY id").all(),
      observations: this.database.prepare('SELECT * FROM work_item_observation ORDER BY id').all(),
      sources: this.database.prepare('SELECT * FROM work_item_source ORDER BY id').all(),
    })
  }

  private taskLineage(item: WorkItem) {
    const references: DaySourceLineage[] = []
    for (const source of item.sources) {
      if (!source.workdayId) continue
      const canonical = this.database
        .prepare('SELECT kind,source_id FROM ambient_task_source WHERE work_item_id=? AND work_item_source_id=?')
        .get(item.id, source.id)
      const ids = canonical
        ? [canonical.kind === 'speech' ? `speech:${canonical.source_id}` : String(canonical.source_id)]
        : source.kind === 'observed'
          ? this.database
              .prepare('SELECT id FROM context_evidence WHERE workday_id=? AND timestamp=?')
              .all(source.workdayId, source.observedAt)
              .map((row) => String(row.id))
          : []
      references.push(...this.sources.collect(source.workdayId, ids))
    }
    return [...new Map(references.map((reference) => [`${reference.kind}:${reference.sourceId}`, reference])).values()]
  }

  private deletionRevision() {
    return Number(this.database.prepare('SELECT revision FROM evidence_privacy WHERE id = 1').get()?.revision ?? 0)
  }

  private read(id: string): Snapshot | null {
    if (this.reads?.has(id)) return this.reads.get(id) ?? null
    const version = this.database
      .prepare(`SELECT d.revision, r.revision AS changed_revision FROM proactive_day_source d
      LEFT JOIN proactive_day_revision r ON r.source_id=d.id WHERE d.id=?`)
      .get(id)
    const token = JSON.stringify(version)
    const cached = this.snapshots.get(id)
    if (cached && version && cached.token === token) {
      this.snapshots.delete(id)
      this.snapshots.set(id, cached)
      this.reads?.set(id, cached.value)
      return cached.value
    }
    if (cached) {
      this.snapshotCharacters -= cached.characters
      this.snapshots.delete(id)
    }
    const row = this.database.prepare('SELECT snapshot_json FROM proactive_day_source WHERE id = ?').get(id)
    const snapshot = row ? (this.storage.decode(String(row.snapshot_json)) as Snapshot) : null
    if (snapshot) {
      const characters = JSON.stringify(snapshot).length
      if (characters <= 40_000_000) {
        this.snapshots.set(id, { token, value: snapshot, characters })
        this.snapshotCharacters += characters
      }
      while (this.snapshotCharacters > 40_000_000) {
        const oldest = this.snapshots.entries().next().value
        if (!oldest) break
        this.snapshotCharacters -= oldest[1].characters
        this.snapshots.delete(oldest[0])
      }
    }
    this.reads?.set(id, snapshot)
    return snapshot
  }

  completedSince(since: number) {
    return this.database
      .prepare(
        "SELECT id FROM workday WHERE refresh_status = 'idle' AND memory_refreshed_at >= ? ORDER BY memory_refreshed_at"
      )
      .all(since)
      .map((row) => String(row.id))
  }

  latestId(workdayId: string, asOf = Number.MAX_SAFE_INTEGER) {
    const row = this.database
      .prepare(
        'SELECT id FROM proactive_day_source WHERE workday_id = ? AND observed_at <= ? ORDER BY observed_at DESC, rowid DESC LIMIT 1'
      )
      .get(workdayId, asOf)
    return row ? String(row.id) : null
  }

  /** The caller owns the same transaction as proactive_event publication. */
  reconcile(workdayId: string, items: WorkItem[], enabledAt: number, now: number, review?: DayReviewContext) {
    if (!this.database.isTransaction) throw new Error('proactive-transaction-required')
    const day = this.day(workdayId)
    if (!day || (!review && day.memory.refreshedAt < enabledAt) || day.memory.refreshedAt > now) return null
    if (
      review &&
      (!review.slotId ||
        !Number.isSafeInteger(review.checkedAt) ||
        review.checkedAt > now ||
        review.checkedAt < enabledAt)
    )
      return null
    const priorities = { none: 0, low: 1, medium: 2, high: 3, urgent: 4 }
    const candidates = [...items]
    candidates.sort(
      (a, b) =>
        Number(b.lifecycle === 'open') - Number(a.lifecycle === 'open') ||
        priorities[b.priority] - priorities[a.priority] ||
        (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) ||
        Math.max(0, ...b.sources.map((source) => source.observedAt)) -
          Math.max(0, ...a.sources.map((source) => source.observedAt)) ||
        a.id.localeCompare(b.id)
    )
    const tasks: Task[] = []
    const taskLineage: DaySourceLineage[] = []
    const pool = [
      ...candidates.filter((item) => item.lifecycle === 'open'),
      ...candidates.filter((item) => item.lifecycle !== 'open').slice(0, 24),
    ]
    const projected = pool
      .flatMap((item, rank) => {
        const references = this.taskLineage(item)
        const evidence = this.sources.resolve(references)
        return !evidence ? [] : [{ task: compactTaskEvidence(item, evidence), references, rank }]
      })
      .sort((a, b) => Number(b.task.proactiveEligible) - Number(a.task.proactiveEligible) || a.rank - b.rank)
    for (const { task, references } of projected) {
      if (tasks.length >= 60) break
      if (JSON.stringify(tasks).length + JSON.stringify(task).length > 24_000) continue
      tasks.push(task)
      taskLineage.push(...references)
    }
    const provenance =
      day.memory.analysisProvenance?.version === 1 && (!review || now - day.memory.refreshedAt <= 24 * 60 * 60_000)
        ? day.memory.analysisProvenance
        : null
    const lineage = [
      ...new Map(
        [...(provenance?.rawSources ?? []), ...taskLineage].map((entry) => [`${entry.kind}:${entry.sourceId}`, entry])
      ).values(),
    ]
    // Old summaries without their synthesis inputs remain visible in My Day, but do not become agent evidence.
    const state = provenance ? day.state : compactDay({} as DayMemory, day.state.date)
    const semanticRevision = hash({ day: state, tasks })
    const existing = this.database
      .prepare(
        `SELECT d.id FROM proactive_day_source d
         WHERE d.workday_id = ? AND COALESCE(json_extract(d.snapshot_json, '$.semanticRevision'), d.revision) = ?
         AND (json_extract(d.snapshot_json, '$.review.slotId') IS ? OR (? IS NULL AND EXISTS (
           SELECT 1 FROM proactive_event e JOIN proactive_considered c ON c.event_id=e.event_id
           JOIN proactive_decision decision ON decision.id=c.decision_id AND decision.consumer=c.consumer
           JOIN proactive_consumer consumer ON consumer.name=c.consumer
           WHERE e.kind='day' AND e.source_id=d.id AND decision.invalidated_at IS NULL
           AND consumer.enabled=1 AND decision.generation=consumer.generation
           AND e.sequence>consumer.after_sequence AND e.accepted_at>=consumer.enabled_at
         ))) ORDER BY d.observed_at DESC,d.rowid DESC LIMIT 1`
      )
      .get(workdayId, semanticRevision, review?.slotId ?? null, review?.slotId ?? null)
    const prior = existing ? this.read(String(existing.id)) : null
    if (
      prior &&
      (!review || now - prior.observedAt <= 24 * 60 * 60_000) &&
      retainsProvenance(prior.provenance, provenance) &&
      (review || !prior.review || this.current(prior.id))
    ) {
      const resolved = this.resolve(prior.id)
      if (resolved) return resolved
    }
    if (!this.sources.resolve(lineage)) return null
    const revision = prior
      ? hash([semanticRevision, prior.id, provenance, this.deletionRevision(), review?.slotId])
      : review
        ? hash([semanticRevision, review.slotId])
        : semanticRevision
    const previousRow = this.database
      .prepare(
        'SELECT snapshot_json FROM proactive_day_source WHERE workday_id = ? ORDER BY observed_at DESC, rowid DESC LIMIT 1'
      )
      .get(workdayId)
    const previous = previousRow ? (JSON.parse(String(previousRow.snapshot_json)) as Snapshot) : null
    const oldTasks = new Map(previous?.tasks.map((task) => [task.id, task]) ?? [])
    const delta = {
      firstSnapshot: !previous,
      changedDayFields: Object.keys(state).filter(
        (key) => hash(state[key as keyof DayState]) !== hash(previous?.day[key as keyof DayState])
      ),
      addedTaskIds: tasks.filter((task) => !oldTasks.has(task.id)).map((task) => task.id),
      changedTaskIds: tasks
        .filter((task) => oldTasks.has(task.id) && hash(task) !== hash(oldTasks.get(task.id)))
        .map((task) => task.id),
      removedTaskIds: (previous?.tasks ?? [])
        .filter((task) => !tasks.some((entry) => entry.id === task.id))
        .map((task) => task.id),
    }
    const content = JSON.stringify({
      kind: 'derived-day-state',
      day: state,
      tasks,
      omittedTaskCount: candidates.length - tasks.length,
      changesSincePreviousSync: delta,
      coverageThrough: day.memory.coveredThrough,
      refreshedAt: day.memory.refreshedAt,
      ...(review ? { review, taskStateCheckedAt: review.checkedAt, daySummaryOmitted: !provenance } : {}),
      sourceEvidenceIds: lineage
        .filter((entry) => entry.sourceId.length <= 120)
        .slice(0, 20)
        .map((entry) => (entry.kind === 'context' ? entry.sourceId : `${entry.kind}:${entry.sourceId}`)),
      sourceEvidenceCount: lineage.length,
    })
    if (content.length > AMBIENT_BATCH_CHARACTERS) throw new Error('proactive-day-exceeds-budget')
    const taskSources = tasks.flatMap((task) =>
      this.database
        .prepare('SELECT * FROM work_item_source WHERE work_item_id = ? ORDER BY id')
        .all(task.id)
        .map((row) => ({ id: String(row.id), revision: hash(row) }))
    )
    const taskClaims = tasks.flatMap((task) =>
      (['work_item_fact', 'work_item_observation'] as const).flatMap((table) =>
        this.database
          .prepare(
            `SELECT * FROM ${table} WHERE work_item_id=? ${table === 'work_item_fact' ? "AND actor='user'" : 'AND dismissed_at IS NULL'} ORDER BY id`
          )
          .all(task.id)
          .map((row) => ({ table, id: String(row.id), revision: hash(row) }))
      )
    )
    const snapshot: Snapshot = {
      id: `day-sync:${hash([workdayId, revision])}`,
      workdayId,
      observedAt: review?.checkedAt ?? day.memory.refreshedAt,
      revision,
      semanticRevision,
      deletionRevision: this.deletionRevision(),
      day: state,
      tasks,
      taskRevision: this.taskRevision(),
      taskSources,
      taskClaims,
      ...(review ? { review } : {}),
      lineage,
      provenance,
      text: content,
    }
    if (
      this.database
        .prepare('INSERT INTO proactive_day_source(id,workday_id,observed_at,revision,snapshot_json) VALUES(?,?,?,?,?)')
        .run(snapshot.id, workdayId, snapshot.observedAt, revision, this.storage.encode(snapshot)).changes !== 1
    )
      throw new Error('proactive-write-not-persisted')
    return this.resolve(snapshot.id)
  }

  evidence(id: string) {
    const lineage = this.lineage(id)
    return lineage === null ? null : this.sources.resolve(lineage)
  }

  lineage(id: string) {
    const snapshot = this.read(id)
    if (!snapshot || snapshot.deletionRevision !== this.deletionRevision()) return null
    return snapshot.lineage
  }

  taskIds(id: string) {
    const snapshot = this.read(id)
    return [...new Set([...(snapshot?.tasks.map((task) => task.id) ?? []), ...(snapshot?.provenance?.taskIds ?? [])])]
  }

  provenance(id: string) {
    return this.read(id)?.provenance ?? null
  }

  retains(previousId: string, nextId: string) {
    const previous = this.read(previousId)
    const next = this.read(nextId)
    return Boolean(previous && next && retainsProvenance(previous.provenance, next.provenance))
  }

  current(id: string) {
    const snapshot = this.read(id)
    if (!snapshot || !this.resolve(id)) return false
    const day = this.day(snapshot.workdayId)
    const state = snapshot.provenance ? day?.state : day && compactDay({} as DayMemory, day.state.date)
    const comparableState = { ...state }
    // Older projections made no claim about project-time estimates.
    if (!('projectAttention' in snapshot.day)) delete comparableState.projectAttention
    return Boolean(day && hash(comparableState) === hash(snapshot.day) && this.taskRevision() === snapshot.taskRevision)
  }

  resolve(id: string) {
    if (this.resolutions?.has(id)) return this.resolutions.get(id) ?? null
    const resolved = this.resolveUncached(id)
    this.resolutions?.set(id, resolved)
    return resolved
  }

  private taskRowCurrent(
    table: 'work_item' | 'work_item_source' | 'work_item_fact' | 'work_item_observation',
    id: string,
    revision?: string
  ) {
    const key = `${table}:${id}`
    let current = this.taskReads?.get(key)
    if (current === undefined) {
      const row = this.database.prepare(`SELECT ${table === 'work_item' ? 'id' : '*'} FROM ${table} WHERE id=?`).get(id)
      current = row ? hash(row) : null
      this.taskReads?.set(key, current)
    }
    return revision === undefined ? current !== null : current === revision
  }

  private resolveUncached(id: string) {
    const snapshot = this.read(id)
    const lineage = this.lineage(id)
    if (
      !snapshot ||
      lineage === null ||
      !(this.sources.current ? this.sources.current(lineage) : this.sources.resolve(lineage) !== null) ||
      !this.database.prepare('SELECT id FROM workday WHERE id=?').get(snapshot.workdayId)
    )
      return null
    for (const task of snapshot.tasks) if (!this.taskRowCurrent('work_item', task.id)) return null
    for (const source of snapshot.taskSources) {
      if (!this.taskRowCurrent('work_item_source', source.id, source.revision)) return null
    }
    for (const claim of snapshot.taskClaims ?? []) {
      if (claim.table !== 'work_item_fact' && claim.table !== 'work_item_observation') return null
      if (!this.taskRowCurrent(claim.table, claim.id, claim.revision)) return null
    }
    let eventRevision = this.snapshotHashes.get(snapshot)
    if (!eventRevision) {
      eventRevision = hash(snapshot)
      this.snapshotHashes.set(snapshot, eventRevision)
    }
    return {
      sourceId: snapshot.id,
      row: {
        text: snapshot.text,
        observed_at: snapshot.observedAt,
        source: snapshot.review ? 'day-review' : 'day-sync',
        app_name: 'Remember',
        bundle_id: '',
        window_title: snapshot.day.date,
        url: '',
      } as Row,
      chunks: [],
      provenance: {
        speaker: 'unknown' as const,
        mediaPlayback: 'unknown' as const,
        inputRoute: snapshot.review ? 'day-review' : 'day-sync',
      },
      eventRevision,
      contentKey: snapshot.review
        ? hash([snapshot.semanticRevision ?? snapshot.revision, snapshot.review.slotId])
        : (snapshot.semanticRevision ?? snapshot.revision),
    }
  }
}
