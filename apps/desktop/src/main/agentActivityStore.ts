import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AgentProvider } from '@remember/shared'
import {
  type AgentActivityCursor,
  type AgentActivityMessage,
  type AgentActivityRead,
  type AgentActivitySource,
  activityContentHash,
} from './agentActivitySources'

export type AgentActivityEvent = AgentActivityMessage & { id: string; recordedAt: number }
export type AgentActivitySpan = AgentActivityEvent & {
  spanId: string
  partIndex: number
  partCount: number
  content: string
}
export type AgentActivityStore = ReturnType<typeof createAgentActivityStore>

type Row = Record<string, string | number | null>
type EventWindow = { after?: number; through?: number; providers?: AgentProvider[] }
const SPAN_CHARACTERS = 8_000
const CONTEXT_MESSAGES = 8
const CONTEXT_CHARACTERS = 12_000
const RETENTION_MS = 30 * 24 * 60 * 60_000

export function createAgentActivityStore(filename: string) {
  mkdirSync(path.dirname(filename), { recursive: true })
  const database = new DatabaseSync(filename)
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS activity_source (
      path TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      cursor_json TEXT,
      checked_at INTEGER,
      selected_at INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      malformed_records INTEGER NOT NULL DEFAULT 0,
      unsupported_records INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS activity_event (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      session_id TEXT NOT NULL,
      project_path TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      provider_event_id TEXT,
      turn_id TEXT,
      representation TEXT NOT NULL,
      source_path TEXT NOT NULL,
      source_offset INTEGER NOT NULL,
      recorded_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS activity_event_origin ON activity_event(provider, session_id, role, content_hash, observed_at);
    CREATE INDEX IF NOT EXISTS activity_event_time ON activity_event(observed_at,provider);
    CREATE INDEX IF NOT EXISTS activity_event_session_time ON activity_event(provider,session_id,observed_at,source_offset);
    CREATE TABLE IF NOT EXISTS activity_span (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES activity_event(id),
      part_index INTEGER NOT NULL,
      part_count INTEGER NOT NULL,
      start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at INTEGER NOT NULL DEFAULT 0,
      completed_at INTEGER,
      reason TEXT
    );
    CREATE INDEX IF NOT EXISTS activity_span_pending ON activity_span(status, available_at);
    CREATE INDEX IF NOT EXISTS activity_span_event ON activity_span(event_id, status, completed_at);
    CREATE TABLE IF NOT EXISTS activity_exclusion (
      provider TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      PRIMARY KEY(provider, started_at)
    );
    CREATE TABLE IF NOT EXISTS activity_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `)

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

  function cursor(sourcePath: string) {
    const row = database.prepare('SELECT cursor_json FROM activity_source WHERE path = ?').get(sourcePath) as
      | Row
      | undefined
    return row?.cursor_json ? (JSON.parse(String(row.cursor_json)) as AgentActivityCursor) : null
  }

  function capturePolicy(allowedProviders: AgentProvider[], now: number) {
    transaction(() => {
      for (const provider of ['codex', 'claude'] as const) {
        const pending = database
          .prepare('SELECT started_at FROM activity_exclusion WHERE provider = ? AND ended_at IS NULL')
          .get(provider)
        if (allowedProviders.includes(provider)) {
          database
            .prepare('UPDATE activity_exclusion SET ended_at = ? WHERE provider = ? AND ended_at IS NULL')
            .run(now, provider)
        } else if (!pending) {
          database.prepare('INSERT INTO activity_exclusion(provider, started_at) VALUES (?, ?)').run(provider, now)
        }
      }
    })
  }

  function recordRead(source: AgentActivitySource, read: AgentActivityRead, enabledSince: number, recordedAt: number) {
    return transaction(() => {
      let added = 0
      const excluded = database.prepare(
        'SELECT 1 FROM activity_exclusion WHERE provider = ? AND started_at <= ? AND (ended_at IS NULL OR ended_at > ?) LIMIT 1'
      )
      const sameOrigin = database.prepare(`
        SELECT id FROM activity_event WHERE provider = ? AND role = ? AND content_hash = ?
          AND ((provider_event_id IS NOT NULL AND provider_event_id = ?) OR observed_at = ?
            OR (session_id = ? AND representation != ? AND
              ((turn_id IS NOT NULL AND turn_id = ?) OR observed_at BETWEEN ? AND ?)))
        ORDER BY ABS(observed_at - ?) LIMIT 1
      `)
      for (const message of read.messages) {
        if (message.observedAt < enabledSince || excluded.get(message.provider, message.observedAt, message.observedAt))
          continue
        const hash = activityContentHash(message.text)
        const duplicate = sameOrigin.get(
          message.provider,
          message.role,
          hash,
          message.providerEventId,
          message.observedAt,
          message.sessionId,
          message.representation,
          message.turnId,
          message.observedAt - 2_000,
          message.observedAt + 2_000,
          message.observedAt
        )
        if (duplicate) continue
        const identity = message.providerEventId ?? `${message.observedAt}:${hash}`
        const id = createHash('sha256')
          .update(`${message.provider}:${message.sessionId}:${message.role}:${identity}`)
          .digest('hex')
        const inserted = database
          .prepare(`
          INSERT OR IGNORE INTO activity_event(id, provider, session_id, project_path, role, content, content_hash, observed_at, provider_event_id, turn_id, representation, source_path, source_offset, recorded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
          .run(
            id,
            message.provider,
            message.sessionId,
            message.projectPath,
            message.role,
            message.text,
            hash,
            message.observedAt,
            message.providerEventId,
            message.turnId,
            message.representation,
            message.sourcePath,
            message.sourceOffset,
            recordedAt
          )
        if (!inserted.changes) continue
        added += 1
        const partCount = Math.ceil(message.text.length / SPAN_CHARACTERS)
        for (let index = 0; index < partCount; index++) {
          database
            .prepare(
              'INSERT INTO activity_span(id,event_id,part_index,part_count,start_offset,end_offset,available_at) VALUES (?,?,?,?,?,?,?)'
            )
            .run(
              `${id}:${index}`,
              id,
              index,
              partCount,
              index * SPAN_CHARACTERS,
              Math.min(message.text.length, (index + 1) * SPAN_CHARACTERS),
              message.observedAt > recordedAt ? message.observedAt : 0
            )
        }
      }
      database
        .prepare(`
        INSERT INTO activity_source(path,provider,cursor_json,checked_at,malformed_records,unsupported_records) VALUES (?,?,?,?,?,?)
        ON CONFLICT(path) DO UPDATE SET cursor_json=excluded.cursor_json,checked_at=excluded.checked_at,error=NULL,
          malformed_records=activity_source.malformed_records+excluded.malformed_records,
          unsupported_records=activity_source.unsupported_records+excluded.unsupported_records
      `)
        .run(
          source.path,
          source.provider,
          JSON.stringify(read.cursor),
          recordedAt,
          read.malformedRecords,
          read.unsupportedRecords
        )
      return added
    })
  }

  function sourceError(source: AgentActivitySource, error: string, now: number) {
    database
      .prepare(`
      INSERT INTO activity_source(path,provider,checked_at,error) VALUES (?,?,?,?)
      ON CONFLICT(path) DO UPDATE SET checked_at=excluded.checked_at,error=excluded.error
    `)
      .run(source.path, source.provider, now, error)
  }

  function pendingBatch(options: {
    now: number
    allowedProviders: AgentProvider[]
    maxCharacters?: number
    maxSpans?: number
  }) {
    if (!options.allowedProviders.length) return []
    const maxCharacters = options.maxCharacters ?? 40_000
    const maxSpans = options.maxSpans ?? 32
    const sources = database
      .prepare(`
      SELECT DISTINCT e.source_path, s.selected_at FROM activity_span p JOIN activity_event e ON e.id=p.event_id
      JOIN activity_source s ON s.path=e.source_path
      WHERE p.status='pending' AND p.available_at<=? AND e.provider IN (${options.allowedProviders.map(() => '?').join(',')})
      ORDER BY s.selected_at, e.source_path LIMIT ?
    `)
      .all(options.now, ...options.allowedProviders, maxSpans) as Row[]
    const queues = sources
      .map(
        (source) =>
          database
            .prepare(`
      SELECT e.id,e.provider,e.session_id,e.project_path,e.role,e.observed_at,e.provider_event_id,
                 e.turn_id,e.representation,e.source_path,e.source_offset,e.recorded_at,
                 p.id AS span_id,p.part_index,p.part_count,p.start_offset,p.end_offset
      FROM activity_span p JOIN activity_event e ON e.id=p.event_id
      WHERE e.source_path=? AND p.status='pending' AND p.available_at<=?
      ORDER BY e.observed_at,e.source_offset,p.part_index LIMIT ?
    `)
            .all(source.source_path, options.now, maxSpans) as Row[]
      )
      .filter((rows) => rows.length && options.allowedProviders.includes(String(rows[0]?.provider) as AgentProvider))
    const result: AgentActivitySpan[] = []
    const contents = new Map<string, string>()
    let characters = 0
    const blocked = new Set<number>()
    const selectedProjects = new Map<string, Row['project_path']>()
    for (let round = 0; result.length < maxSpans; round++) {
      let found = false
      for (const [queueIndex, queue] of queues.entries()) {
        if (blocked.has(queueIndex)) continue
        const row = queue[round]
        if (!row) continue
        found = true
        const sessionKey = `${row.provider}:${row.session_id}`
        if (selectedProjects.has(sessionKey) && selectedProjects.get(sessionKey) !== row.project_path) {
          blocked.add(queueIndex)
          continue
        }
        const eventId = String(row.id)
        let fullText = contents.get(eventId)
        if (fullText === undefined) {
          const event = database.prepare('SELECT content FROM activity_event WHERE id=?').get(eventId) as Row
          fullText = String(event.content)
          contents.set(eventId, fullText)
        }
        const content = fullText.slice(Number(row.start_offset), Number(row.end_offset))
        if (characters + content.length > maxCharacters || result.length >= maxSpans) {
          blocked.add(queueIndex)
          continue
        }
        selectedProjects.set(sessionKey, row.project_path)
        result.push({
          ...presentEvent({ ...row, content: fullText }),
          spanId: String(row.span_id),
          partIndex: Number(row.part_index),
          partCount: Number(row.part_count),
          content,
        })
        characters += content.length
      }
      if (!found) break
    }
    transaction(() => {
      for (const sourcePath of new Set(result.map((span) => span.sourcePath))) {
        database.prepare('UPDATE activity_source SET selected_at=? WHERE path=?').run(options.now, sourcePath)
      }
    })
    return result
  }

  function acknowledge(spanIds: string[], now: number) {
    transaction(() => {
      for (const id of spanIds)
        database
          .prepare(
            "UPDATE activity_span SET status='processed',completed_at=?,reason=NULL WHERE id=? AND status='pending'"
          )
          .run(now, id)
    })
  }

  function conversationContext(options: {
    provider: AgentProvider
    sessionId: string
    beforeEventId: string
    enabledSince: number
  }) {
    const rows = database
      .prepare(`
        SELECT e.* FROM activity_event e
        JOIN activity_event anchor ON anchor.id=? AND anchor.provider=e.provider AND anchor.session_id=e.session_id
        WHERE e.provider=? AND e.session_id=? AND e.observed_at>=? AND e.content<>'' AND length(e.content)<=?
          AND (e.observed_at<anchor.observed_at OR
            (e.observed_at=anchor.observed_at AND e.source_path=anchor.source_path AND e.source_offset<anchor.source_offset))
          AND NOT EXISTS (
            SELECT 1 FROM activity_exclusion x WHERE x.provider=e.provider AND x.started_at<=e.observed_at
              AND (x.ended_at IS NULL OR x.ended_at>e.observed_at)
          )
        ORDER BY e.observed_at DESC,e.source_offset DESC,e.id DESC LIMIT ?
      `)
      .all(
        options.beforeEventId,
        options.provider,
        options.sessionId,
        options.enabledSince,
        CONTEXT_CHARACTERS,
        CONTEXT_MESSAGES
      ) as Row[]
    const events: AgentActivityEvent[] = []
    let characters = 0
    for (const row of rows) {
      const event = presentEvent(row)
      if (event.text.length > CONTEXT_CHARACTERS) continue
      if (characters + event.text.length > CONTEXT_CHARACTERS) break
      events.push(event)
      characters += event.text.length
    }
    return events.reverse()
  }

  function defer(spanIds: string[], reason: string, now: number) {
    transaction(() => {
      for (const id of spanIds) {
        database
          .prepare(`
          UPDATE activity_span SET attempts=attempts+1,reason=?,available_at=? + MIN(1800000,30000 * (1 << MIN(attempts,6)))
          WHERE id=? AND status='pending'
        `)
          .run(reason, now, id)
      }
    })
  }

  function eventWindow(options: EventWindow) {
    const providers = options.providers ?? ['codex', 'claude']
    return {
      where: `observed_at>? AND observed_at<=? AND content<>'' AND provider IN (${providers.map(() => '?').join(',')})`,
      parameters: [options.after ?? 0, options.through ?? Number.MAX_SAFE_INTEGER, ...providers],
      empty: providers.length === 0,
    }
  }

  function listEvents(options: EventWindow & { limit?: number } = {}) {
    const window = eventWindow(options)
    if (window.empty || options.limit === 0) return []
    const limit =
      options.limit !== undefined && Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : null
    const rows = database
      .prepare(
        `SELECT * FROM activity_event WHERE ${window.where} ORDER BY observed_at ${limit === null ? 'ASC' : 'DESC'},source_offset ${limit === null ? 'ASC' : 'DESC'}${limit === null ? '' : ' LIMIT ?'}`
      )
      .all(...window.parameters, ...(limit === null ? [] : [limit])) as Row[]
    return (limit === null ? rows : rows.reverse()).map(presentEvent)
  }

  function readEvent(id: string, options: EventWindow = {}) {
    const window = eventWindow(options)
    if (window.empty) return null
    const row = database
      .prepare(`SELECT * FROM activity_event WHERE id=? AND ${window.where}
        AND NOT EXISTS (SELECT 1 FROM activity_exclusion x WHERE x.provider=activity_event.provider
          AND x.started_at<=activity_event.observed_at AND (x.ended_at IS NULL OR x.ended_at>activity_event.observed_at))`)
      .get(id, ...window.parameters) as Row | undefined
    return row ? presentEvent(row) : null
  }

  function latestEventAt(options: EventWindow = {}) {
    const window = eventWindow(options)
    if (window.empty) return null
    const row = database
      .prepare(`SELECT MAX(observed_at) AS latest FROM activity_event WHERE ${window.where}`)
      .get(...window.parameters) as Row
    return nullableNumber(row.latest)
  }

  function latestRecordedAt(options: EventWindow = {}) {
    const window = eventWindow(options)
    if (window.empty) return null
    const row = database
      .prepare(`SELECT MAX(recorded_at) AS latest FROM activity_event WHERE ${window.where}`)
      .get(...window.parameters) as Row
    return nullableNumber(row.latest)
  }

  function expire(now: number) {
    // Every span must have been processed for 30 days before removing raw text. Pending evidence is never expired.
    // Retain identity/hash tombstones so provider files cannot recreate the removed text on replay.
    return database
      .prepare(`
      UPDATE activity_event SET content='' WHERE content<>''
        AND NOT EXISTS (SELECT 1 FROM activity_span WHERE event_id=activity_event.id AND status='pending')
        AND (SELECT MAX(completed_at) FROM activity_span WHERE event_id=activity_event.id)<?
    `)
      .run(now - RETENTION_MS).changes
  }

  function status() {
    const row = database
      .prepare(`
      SELECT COUNT(*) AS events,MAX(recorded_at) AS last_recorded_at FROM activity_event
    `)
      .get() as Row
    const queue = database
      .prepare(`
      SELECT COUNT(*) AS pending,MIN(e.observed_at) AS oldest_pending_at,
        SUM(CASE WHEN p.attempts>0 THEN 1 ELSE 0 END) AS deferred
      FROM activity_span p JOIN activity_event e ON e.id=p.event_id WHERE p.status='pending'
    `)
      .get() as Row
    const lastProcessed = database
      .prepare("SELECT MAX(completed_at) AS value FROM activity_span WHERE status='processed'")
      .get() as Row
    const sources = database
      .prepare(
        'SELECT provider,COUNT(*) AS sources,MAX(checked_at) AS checked_at,SUM(malformed_records) AS malformed,SUM(unsupported_records) AS unsupported FROM activity_source GROUP BY provider'
      )
      .all() as Row[]
    const errors = database
      .prepare(
        'SELECT provider,path,error FROM activity_source WHERE error IS NOT NULL ORDER BY checked_at DESC LIMIT 8'
      )
      .all() as Row[]
    return {
      eventCount: Number(row.events),
      pendingSpans: Number(queue.pending),
      deferredSpans: Number(queue.deferred ?? 0),
      oldestPendingAt: nullableNumber(queue.oldest_pending_at),
      lastRecordedAt: nullableNumber(row.last_recorded_at),
      lastProcessedAt: nullableNumber(lastProcessed.value),
      providers: sources.map((source) => ({
        provider: String(source.provider) as AgentProvider,
        sourceCount: Number(source.sources),
        lastCheckedAt: nullableNumber(source.checked_at),
        malformedRecords: Number(source.malformed),
        unsupportedRecords: Number(source.unsupported),
      })),
      errors: errors.map((error) => ({
        provider: String(error.provider) as AgentProvider,
        path: String(error.path),
        error: String(error.error),
      })),
    }
  }

  function state(key: string) {
    const row = database.prepare('SELECT value FROM activity_state WHERE key=?').get(key) as Row | undefined
    return row ? String(row.value) : null
  }

  function setState(key: string, value: string) {
    database
      .prepare('INSERT INTO activity_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, value)
  }

  return {
    cursor,
    capturePolicy,
    recordRead,
    sourceError,
    pendingBatch,
    conversationContext,
    acknowledge,
    defer,
    listEvents,
    readEvent,
    latestEventAt,
    latestRecordedAt,
    expire,
    status,
    state,
    setState,
    close: () => database.close(),
  }
}

function presentEvent(row: Row): AgentActivityEvent {
  return {
    id: String(row.id),
    recordedAt: Number(row.recorded_at),
    provider: String(row.provider) as AgentProvider,
    sessionId: String(row.session_id),
    projectPath: row.project_path === null ? null : String(row.project_path),
    role: String(row.role) as 'user' | 'assistant',
    text: String(row.content),
    observedAt: Number(row.observed_at),
    providerEventId: row.provider_event_id === null ? null : String(row.provider_event_id),
    turnId: row.turn_id === null ? null : String(row.turn_id),
    representation: String(row.representation),
    sourcePath: String(row.source_path),
    sourceOffset: Number(row.source_offset),
  }
}

function nullableNumber(value: Row[string]) {
  return value === null ? null : Number(value)
}
