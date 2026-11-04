import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import type {
  AgentProvider,
  AgentTurnStep,
  AssistantConversation,
  AssistantMessage,
  AssistantMessageStatus,
  AssistantResult,
  RemoteAgentComputer,
  SendAssistantMessageInput,
} from '@remember/shared'
import { redactSensitiveCaptureText } from '@remember/shared'
import type { CodexRemoteCheckpoint } from './codexRemoteRecovery'
import {
  PROACTIVE_DAY_REVIEW_INTERVAL_MS,
  PROACTIVE_DAY_TASK_INTERVAL_MS,
  type ProactiveDecision,
} from './dailyReview/proactiveStore'
import { HostInitiativeStore } from './hostInitiativeStore'
import {
  type HostTaskHostObservation,
  type HostTaskObservation,
  type HostTaskPrepared,
  type HostTaskTerminalReceipt,
  validateHostTaskObservation,
  validateHostTaskPrepared,
  validateHostTaskReceivedAt,
} from './hostTaskExecutionProtocol'
import {
  canonicalHostTaskJson,
  type HostTaskEnvelopeV1,
  type HostTaskOutcome,
  type HostTaskOutcomeReceipt,
  type HostTaskSessionReceipt,
  hostTaskSessionReceipt,
  validateHostTaskEnvelope,
  validateHostTaskOutcome,
} from './hostTaskProtocol'
import type { ResidentMemoryReference } from './residentAgentMemory'
import type { ResidentTaskSuggestion } from './residentAgentSuggestions'
import {
  commandCheckpoint,
  commandInput,
  commandPatch,
  commandTerminal,
  type ResidentCommand,
  type ResidentCommandConfirmation,
  type ResidentCommandPatch,
} from './residentCommandProtocol'
import type { ProactiveConversationState } from './residentProactive'
import {
  type BriefingReplyReference,
  isInitiativeReplyReference,
  MAX_RESIDENT_REPLY_REFERENCES,
  type ResidentReplyReference,
  sameReplyReference,
} from './residentReplyContext'

export type ResidentRemoteRun = CodexRemoteCheckpoint & { messageId: string; contextInvalidated?: boolean }
export type ResidentHostRun = NonNullable<AssistantConversation['hostJob']> & {
  jobId: string
  endpoint: string
  cursor: number
  contextInvalidated?: boolean
}
export type SavedMemoryReceipt = Omit<AssistantResult, 'id'> & { saved: true; proposed: false }
export interface ResidentHostTaskIntent {
  envelope: HostTaskEnvelopeV1
  envelopeHash: string
  sessionReceipt: HostTaskSessionReceipt | null
  outcome: HostTaskOutcome | null
  outcomeReceipt: HostTaskOutcomeReceipt | null
  invalidated: boolean
}

export interface ResidentTaskExecution {
  intent: ResidentHostTaskIntent
  prepared: HostTaskPrepared
  preparedHash: string
  state:
    | 'prepared'
    | 'registered'
    | 'dispatch-intent'
    | 'cancelled-unsubmitted'
    | HostTaskHostObservation['job']['phase']
  observation: HostTaskObservation | null
  cursor: number | null
  receivedAt: number | null
  terminal: HostTaskTerminalReceipt | null
  terminalReceivedAt: number | null
  cancellation: { kind: 'unsubmitted'; at: number } | null
  sources: HostTaskEnvelopeV1['sources']
}

type MessagePatch = { text: string; steps: AgentTurnStep[]; status: AssistantMessageStatus; error?: string | null }

export function isResidentHostTerminal(run: ResidentHostRun) {
  return run.phase === 'completed' || run.phase === 'stopped'
}

const PAGE_SIZE = 40

type Row = Record<string, unknown>

function replyReferences(input: unknown): ResidentReplyReference[] {
  const identifier = (value: unknown): value is string =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    value === value.trim() &&
    ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_RESIDENT_REPLY_REFERENCES)
    throw new Error('assistant-reply-context-invalid')
  const references: ResidentReplyReference[] = input.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('assistant-reply-context-invalid')
    if (entry.kind === 'initiative') {
      if (
        Object.keys(entry).sort().join(',') !== 'decisionId,inputHash,kind,messageId' ||
        !identifier(entry.decisionId) ||
        !identifier(entry.messageId) ||
        !hash(entry.inputHash)
      )
        throw new Error('assistant-reply-context-invalid')
      return {
        kind: 'initiative',
        decisionId: entry.decisionId,
        messageId: entry.messageId,
        inputHash: entry.inputHash,
      }
    }
    if (
      Object.keys(entry).sort().join(',') !== 'actionId,messageId,resultHash,resultId' ||
      !identifier(entry.actionId) ||
      !identifier(entry.messageId) ||
      !identifier(entry.resultId) ||
      !hash(entry.resultHash)
    )
      throw new Error('assistant-reply-context-invalid')
    return {
      actionId: entry.actionId,
      messageId: entry.messageId,
      resultId: entry.resultId,
      resultHash: entry.resultHash,
    }
  })
  const keys = references.map((ref) =>
    isInitiativeReplyReference(ref) ? `initiative:${ref.decisionId}` : `briefing:${ref.actionId}`
  )
  const briefing = references.filter((ref): ref is BriefingReplyReference => !isInitiativeReplyReference(ref))
  if (
    new Set(keys).size !== references.length ||
    new Set(references.map((ref) => ref.messageId)).size !== references.length ||
    new Set(briefing.map((ref) => ref.resultId)).size !== briefing.length
  )
    throw new Error('assistant-reply-context-invalid')
  return references.sort((a, b) => {
    const left = isInitiativeReplyReference(a) ? `initiative:${a.decisionId}` : a.actionId
    const right = isInitiativeReplyReference(b) ? `initiative:${b.decisionId}` : b.actionId
    return left < right ? -1 : left > right ? 1 : 0
  })
}

function proactivePayload(decision: ProactiveDecision) {
  const bounded = (value: unknown, max: number, empty = false): value is string =>
    typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0)
  const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
  if (
    !decision ||
    !bounded(decision.id, 200) ||
    !['observe', 'clarify', 'offer', 'prepare'].includes(decision.kind) ||
    !bounded(decision.text, 20_000) ||
    !bounded(decision.topicKey, 300) ||
    !bounded(decision.policyToken, 20_000) ||
    !/^[a-f0-9]{64}$/.test(decision.inputHash) ||
    ![
      decision.createdAt,
      decision.expiresAt,
      decision.conversationGeneration,
      decision.consumerGeneration,
      decision.deletionRevision,
    ].every(integer) ||
    decision.expiresAt <= decision.createdAt ||
    !Array.isArray(decision.sourceIds) ||
    !decision.sourceIds.length ||
    decision.sourceIds.length > 12 ||
    new Set(decision.sourceIds).size !== decision.sourceIds.length ||
    !Array.isArray(decision.sourceRefs) ||
    decision.sourceRefs.length > 12 ||
    !Array.isArray(decision.supportingQuotes) ||
    decision.supportingQuotes.length > 24 ||
    decision.sourceIds.some(
      (id) => !bounded(id, 500) || decision.sourceRefs.filter((source) => source.evidenceId === id).length !== 1
    ) ||
    decision.supportingQuotes.some(
      (entry) => !entry || !decision.sourceIds.includes(entry.sourceId) || !bounded(entry.quote, 4000)
    ) ||
    decision.sourceIds.some((id) => !decision.supportingQuotes.some((entry) => entry.sourceId === id)) ||
    decision.sourceRefs.some(
      (source) =>
        !source ||
        !['context', 'speech', 'note', 'day'].includes(source.kind) ||
        (source.kind === 'note'
          ? source.workdayId !== '' || source.evidenceId !== `note:${source.sourceId}`
          : !bounded(source.workdayId, 500)) ||
        (source.kind === 'day' && source.evidenceId !== `day:${source.sourceId}`) ||
        ![
          source.eventId,
          source.sourceId,
          source.evidenceId,
          source.eventRevision,
          source.revision,
          source.contentKey,
        ].every((value) => bounded(value, 500)) ||
        !integer(source.observedAt) ||
        ![source.appName, source.windowTitle, source.url].every((value) => bounded(value, 8000, true))
    ) ||
    (decision.sourceRefs.some((source) => source.kind === 'note' || source.kind === 'day') &&
      decision.kind === 'prepare') ||
    (decision.reason !== undefined && decision.reason !== 'interpreted')
  )
    throw new Error('invalid-proactive-initiative')
  const { deliveredMessageId: _delivered, invalidatedAt: _invalidated, ...payload } = decision
  const json = canonicalHostTaskJson(payload)
  return { json, hash: createHash('sha256').update(json).digest('hex') }
}

function savedPageResult(id: string, value: unknown): AssistantResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const result = value as Record<string, unknown>
  if (result.kind !== 'saved-page' || result.saved !== true || result.proposed !== false) return null
  const fields = new Set(['kind', 'saved', 'proposed', 'spaceId', 'slug', 'revision', 'title'])
  if (Object.keys(result).some((key) => !fields.has(key))) return null
  if (
    ![result.spaceId, result.slug, result.revision].every(
      (part) =>
        typeof part === 'string' &&
        part.length > 0 &&
        part === part.trim() &&
        [...part].every((character) => character.charCodeAt(0) >= 32)
    )
  )
    return null
  return {
    id,
    kind: 'saved-page',
    spaceId: result.spaceId as string,
    slug: result.slug as string,
    revision: result.revision as string,
    title: typeof result.title === 'string' && result.title.trim() ? result.title : (result.slug as string),
  }
}

function message(row: Row, results: AssistantResult[] = []): AssistantMessage {
  return {
    id: String(row.id),
    role: row.role as AssistantMessage['role'],
    text: String(row.text),
    provider: row.provider as AgentProvider,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    status: row.status as AssistantMessageStatus,
    replyTo: row.reply_to == null ? null : String(row.reply_to),
    error: row.error == null ? null : String(row.error),
    steps: JSON.parse(String(row.steps_json)),
    results,
  }
}

export class ResidentAgentStore {
  private database: DatabaseSync
  private now: () => number
  readonly initiatives: HostInitiativeStore

  constructor(file: string, options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    this.database = new DatabaseSync(file)
    chmodSync(file, 0o600)
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS assistant_message (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        text TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        reply_to TEXT,
        error TEXT,
        steps_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS assistant_queued_message (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, text TEXT NOT NULL, execution_key TEXT NOT NULL, retired_at INTEGER);
      CREATE TABLE IF NOT EXISTS assistant_submission (id TEXT PRIMARY KEY, input_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assistant_queue_discard (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS assistant_state (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS assistant_policy (id INTEGER PRIMARY KEY CHECK(id = 1), fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assistant_command (
        message_id TEXT PRIMARY KEY, user_message_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL, value_json TEXT NOT NULL, terminal_json TEXT, retired_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS assistant_remote_run (id INTEGER PRIMARY KEY CHECK(id = 1), checkpoint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assistant_retired_remote_run (
        checkpoint_hash TEXT PRIMARY KEY, message_id TEXT NOT NULL, checkpoint TEXT NOT NULL, retired_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS assistant_retired_remote_run_message ON assistant_retired_remote_run(message_id);
      CREATE TABLE IF NOT EXISTS assistant_host_run (
        job_id TEXT PRIMARY KEY, message_id TEXT NOT NULL UNIQUE, binding TEXT NOT NULL, retired_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS assistant_memory_source (space_id TEXT NOT NULL, slug TEXT NOT NULL, reference_json TEXT NOT NULL, PRIMARY KEY(space_id, slug));
      CREATE TABLE IF NOT EXISTS assistant_task_suggestion (
        event_id TEXT PRIMARY KEY, message_id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL, evidence_ids TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS assistant_proactive_initiative (
        decision_id TEXT PRIMARY KEY, message_id TEXT NOT NULL UNIQUE,
        input_hash TEXT NOT NULL, payload_hash TEXT NOT NULL, payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS assistant_proactive_dismissal (
        topic_key TEXT PRIMARY KEY, dismissed_at INTEGER NOT NULL, expires_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS assistant_reply_context (
        message_id TEXT PRIMARY KEY, references_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS assistant_tool_call (
        id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, result_json TEXT,
        message_id TEXT, tool_name TEXT
      );
      CREATE TABLE IF NOT EXISTS assistant_task_run (
        action_id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL,
        session_id TEXT NOT NULL UNIQUE,
        job_id TEXT NOT NULL UNIQUE,
        user_message_id TEXT NOT NULL UNIQUE,
        assistant_message_id TEXT NOT NULL UNIQUE,
        envelope_hash TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        session_receipt_json TEXT,
        outcome_json TEXT,
        outcome_hash TEXT,
        outcome_receipt_json TEXT,
        invalidated INTEGER NOT NULL DEFAULT 0,
        retired_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS assistant_task_execution (
        action_id TEXT PRIMARY KEY,
        prepared_json TEXT NOT NULL, prepared_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        observation_json TEXT, cursor INTEGER, received_at INTEGER,
        terminal_json TEXT, terminal_received_at INTEGER, cancellation_json TEXT
      );
      CREATE TABLE IF NOT EXISTS assistant_task_memory_source (
        action_id TEXT NOT NULL, space_id TEXT NOT NULL, slug TEXT NOT NULL,
        reference_json TEXT NOT NULL, PRIMARY KEY(action_id, space_id, slug)
      );
      CREATE TABLE IF NOT EXISTS assistant_thread (
        provider TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL
      );
    `)
    for (const table of ['assistant_command', 'assistant_queued_message', 'assistant_host_run', 'assistant_task_run']) {
      const columns = this.database.prepare(`PRAGMA table_info(${table})`).all()
      if (!columns.some((row) => row.name === 'retired_at'))
        this.database.exec(`ALTER TABLE ${table} ADD COLUMN retired_at INTEGER`)
    }
    this.initiatives = new HostInitiativeStore(this.database)
    this.database.exec(`
      INSERT OR IGNORE INTO assistant_state(key,value)
      SELECT 'read_through_sequence',COALESCE(MAX(sequence),0) FROM assistant_message
      WHERE role='assistant' AND status IN ('completed','failed','interrupted')
      AND NOT EXISTS (SELECT 1 FROM assistant_command WHERE message_id=assistant_message.id
        AND retired_at IS NULL AND state IN ('reserved','dispatching','running'));
      CREATE INDEX IF NOT EXISTS assistant_unread ON assistant_message(sequence)
      WHERE role='assistant' AND (status IN ('failed','interrupted') OR (status='completed' AND text<>''));
    `)
    const toolColumns = new Set(
      this.database
        .prepare('PRAGMA table_info(assistant_tool_call)')
        .all()
        .map((row) => row.name)
    )
    for (const column of ['message_id', 'tool_name']) {
      if (!toolColumns.has(column)) this.database.exec(`ALTER TABLE assistant_tool_call ADD COLUMN ${column} TEXT`)
    }
    this.database.exec('CREATE INDEX IF NOT EXISTS assistant_tool_call_message ON assistant_tool_call(message_id)')
    // A stopped process cannot resume an in-flight tool or its approval safely.
    this.database
      .prepare(
        `UPDATE assistant_message SET status = 'interrupted', error = 'assistant-interrupted'
        WHERE status = 'streaming' AND NOT EXISTS (
          SELECT 1 FROM assistant_host_run WHERE message_id = assistant_message.id
        ) AND NOT EXISTS (
          SELECT 1 FROM assistant_task_execution AS execution
          JOIN assistant_task_run AS task ON task.action_id = execution.action_id
          WHERE task.assistant_message_id = assistant_message.id
        ) AND NOT EXISTS (
          SELECT 1 FROM assistant_initiative_action WHERE assistant_message_id = assistant_message.id
        ) AND NOT EXISTS (SELECT 1 FROM assistant_command WHERE message_id = assistant_message.id)`
      )
      .run()
    this.database.exec(`UPDATE assistant_host_run
      SET binding = json_set(binding, '$.connection', 'disconnected') WHERE retired_at IS NULL`)
    for (const command of this.unresolvedCommands()) {
      if (command.state === 'dispatching' || command.state === 'running')
        this.finishCommand(
          command.messageId,
          {
            text: command.contextInvalidated ? '' : (this.get(command.messageId)?.text ?? ''),
            steps: command.contextInvalidated ? [] : (this.get(command.messageId)?.steps ?? []),
            status: 'interrupted',
            error: 'assistant-command-unknown',
          },
          'unknown'
        )
    }
  }

  retireRemoteExecution() {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const at = this.now()
      const commands = this.database
        .prepare('SELECT message_id,state FROM assistant_command WHERE retired_at IS NULL')
        .all()
      const interrupt = this.database.prepare(`UPDATE assistant_message
        SET status='interrupted',error='assistant-remote-retired',updated_at=MAX(updated_at,?)
        WHERE id=? AND role='assistant'`)
      const retire = this.database.prepare(
        'UPDATE assistant_command SET retired_at=? WHERE message_id=? AND retired_at IS NULL'
      )
      for (const command of commands) {
        if (!['completed', 'stopped', 'cancelled'].includes(String(command.state)))
          this.requireChanged(interrupt.run(at, command.message_id))
        this.requireChanged(retire.run(at, command.message_id))
      }
      for (const [table, key, message] of [
        ['assistant_host_run', 'job_id', 'message_id'],
        ['assistant_task_run', 'action_id', 'assistant_message_id'],
      ]) {
        const rows = this.database
          .prepare(`SELECT ${key} AS id,${message} AS message_id FROM ${table} WHERE retired_at IS NULL`)
          .all()
        const retireExecution = this.database.prepare(
          `UPDATE ${table} SET retired_at=? WHERE ${key}=? AND retired_at IS NULL`
        )
        for (const row of rows) {
          const original = this.database.prepare('SELECT status FROM assistant_message WHERE id=?').get(row.message_id)
          if (original?.status === 'streaming') this.requireChanged(interrupt.run(at, row.message_id))
          this.requireChanged(retireExecution.run(at, row.id))
        }
      }
      const remote = this.database.prepare('SELECT checkpoint FROM assistant_remote_run WHERE id=1').get()
      if (remote) {
        const checkpoint = String(remote.checkpoint)
        const value = JSON.parse(checkpoint) as ResidentRemoteRun
        if (typeof value.messageId !== 'string' || !value.messageId) throw new Error('assistant-remote-retire-invalid')
        const hash = createHash('sha256').update(checkpoint).digest('hex')
        this.database
          .prepare(`INSERT OR IGNORE INTO assistant_retired_remote_run
          (checkpoint_hash,message_id,checkpoint,retired_at) VALUES (?,?,?,?)`)
          .run(hash, value.messageId, checkpoint, at)
        const archived = this.database
          .prepare('SELECT checkpoint FROM assistant_retired_remote_run WHERE checkpoint_hash=?')
          .get(hash)
        if (archived?.checkpoint !== checkpoint) throw new Error('assistant-remote-retire-not-persisted')
        const message = this.database.prepare('SELECT status FROM assistant_message WHERE id=?').get(value.messageId)
        if (message && !['completed', 'cancelled'].includes(String(message.status)))
          this.requireChanged(interrupt.run(at, value.messageId))
        this.requireChanged(this.database.prepare('DELETE FROM assistant_remote_run WHERE id=1').run())
      }
      const queued = this.database
        .prepare(`SELECT id FROM assistant_queued_message WHERE retired_at IS NULL
        AND CASE WHEN json_valid(execution_key) THEN COALESCE(json_extract(execution_key,'$.kind'),'unknown') ELSE 'unknown' END != 'local'`)
        .all()
      const pause = this.database.prepare(
        'UPDATE assistant_queued_message SET retired_at=? WHERE id=? AND retired_at IS NULL'
      )
      for (const entry of queued) this.requireChanged(pause.run(at, entry.id))
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  close() {
    this.database.close()
  }

  conversation(activeTurnId: string | null, beforeMessageId?: string): AssistantConversation {
    const hostRun = this.hostRun()
    const remoteRun = this.remoteRun()
    const before = beforeMessageId
      ? this.database.prepare('SELECT sequence FROM assistant_message WHERE id = ?').get(beforeMessageId)?.sequence
      : null
    if (beforeMessageId && before == null) throw new Error('assistant-message-not-found')
    const rows = this.database
      .prepare(
        `SELECT * FROM assistant_message ${before == null ? '' : 'WHERE sequence < ?'} ORDER BY sequence DESC LIMIT ?`
      )
      .all(...(before == null ? [PAGE_SIZE + 1] : [Number(before), PAGE_SIZE + 1])) as Row[]
    return {
      messages: rows
        .slice(0, PAGE_SIZE)
        .reverse()
        .map((row) => this.messageWithResults(row)),
      activeTurnId: activeTurnId ?? (hostRun && !isResidentHostTerminal(hostRun) ? hostRun.messageId : null),
      hasEarlier: rows.length > PAGE_SIZE,
      execution: 'local',
      remoteRecoveryRequired: remoteRun !== null && remoteRun.messageId !== activeTurnId,
      remoteRecoveryMessageId: remoteRun?.messageId ?? null,
      ...(hostRun
        ? {
            hostJob: {
              messageId: hostRun.messageId,
              phase: hostRun.phase,
              connection: hostRun.connection,
              ...(hostRun.stopRequested ? { stopRequested: true } : {}),
              ...(hostRun.stopReason ? { stopReason: hostRun.stopReason } : {}),
            },
          }
        : {}),
    }
  }

  hasUnreadMessages() {
    return Boolean(
      this.database
        .prepare(`SELECT 1 FROM assistant_message
      WHERE role='assistant' AND (status IN ('failed','interrupted') OR (status='completed' AND text<>''))
      AND sequence>(SELECT value FROM assistant_state WHERE key='read_through_sequence')
      AND NOT EXISTS (SELECT 1 FROM assistant_command WHERE message_id=assistant_message.id
        AND retired_at IS NULL AND state IN ('reserved','dispatching','running')) LIMIT 1`)
        .get()
    )
  }

  markRead(messageId: string) {
    const command = this.command(messageId)
    if (command && ['reserved', 'dispatching', 'running'].includes(command.state))
      throw new Error('assistant-read-invalid')
    const message = this.database
      .prepare(
        "SELECT sequence FROM assistant_message WHERE id=? AND role='assistant' AND status IN ('completed','failed','interrupted')"
      )
      .get(messageId)
    if (!message) throw new Error('assistant-read-invalid')
    this.database
      .prepare("UPDATE assistant_state SET value=MAX(value,?) WHERE key='read_through_sequence'")
      .run(Number(message.sequence))
  }

  get(id: string) {
    const row = this.database.prepare('SELECT * FROM assistant_message WHERE id = ?').get(id)
    return row ? this.messageWithResults(row) : null
  }

  precedingConversationMessage(messageId: string) {
    const row = this.database
      .prepare(`SELECT prior.* FROM assistant_message prior
      WHERE prior.sequence < (SELECT user.sequence FROM assistant_message current
        JOIN assistant_message user ON user.id=current.reply_to AND user.role='user'
        WHERE current.id=? AND current.role='assistant')
      AND prior.sequence > COALESCE((SELECT value FROM assistant_state WHERE key='context-reset'),0)
      ORDER BY prior.sequence DESC LIMIT 1`)
      .get(messageId)
    return row ? this.messageWithResults(row) : null
  }

  replyContext(messageId: string): ResidentReplyReference[] {
    const row = this.database
      .prepare('SELECT references_json FROM assistant_reply_context WHERE message_id = ?')
      .get(messageId)
    if (!row) return []
    try {
      return replyReferences(JSON.parse(String(row.references_json)))
    } catch {
      throw new Error('assistant-reply-context-invalid')
    }
  }

  recordReplyContext(messageId: string, references: ResidentReplyReference[], extend = false): void {
    const incoming = replyReferences(references)
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const canonical = extend
        ? replyReferences(
            [...this.replyContext(messageId), ...incoming].filter(
              (reference, index, all) => all.findIndex((other) => sameReplyReference(reference, other)) === index
            )
          )
        : incoming
      const serialized = canonicalHostTaskJson(canonical)
      const ordinary = this.database
        .prepare(`SELECT m.id FROM assistant_message m
          JOIN assistant_message u ON u.id = m.reply_to AND u.role = 'user'
          WHERE m.id = ? AND m.role = 'assistant'
          AND NOT EXISTS (SELECT 1 FROM assistant_task_run WHERE assistant_message_id = m.id OR user_message_id = m.id)
          AND NOT EXISTS (SELECT 1 FROM assistant_initiative_action WHERE assistant_message_id = m.id)
          AND NOT EXISTS (SELECT 1 FROM assistant_proactive_initiative WHERE message_id = m.id)
          AND NOT EXISTS (SELECT 1 FROM assistant_task_suggestion WHERE message_id = m.id)
          AND NOT EXISTS (SELECT 1 FROM assistant_host_run WHERE message_id = m.id)`)
        .get(messageId)
      if (!ordinary) throw new Error('assistant-reply-context-message')
      const previous = this.database
        .prepare('SELECT references_json FROM assistant_reply_context WHERE message_id = ?')
        .get(messageId)
      if (!extend && previous && previous.references_json !== serialized)
        throw new Error('assistant-reply-context-conflict')
      for (const reference of canonical) {
        if (isInitiativeReplyReference(reference)) {
          const decision = this.proactiveDecision(reference.messageId)
          if (
            !decision ||
            decision.id !== reference.decisionId ||
            decision.inputHash !== reference.inputHash ||
            !decision.sourceRefs.length ||
            decision.kind === 'prepare'
          )
            throw new Error('assistant-reply-context-reference')
          continue
        }
        const action = this.initiatives.action(reference.actionId)
        if (
          !action ||
          action.invalidated ||
          action.state !== 'completed' ||
          action.publication !== 'published' ||
          action.terminal?.phase !== 'completed' ||
          action.terminal.completion !== 'briefing' ||
          action.envelope.actionId !== reference.actionId ||
          action.envelope.assistantMessageId !== reference.messageId ||
          !action.result ||
          action.result.receipt.actionId !== reference.actionId ||
          action.result.receipt.resultId !== reference.resultId ||
          action.resultHash !== reference.resultHash ||
          createHash('sha256').update(canonicalHostTaskJson(action.result)).digest('hex') !== reference.resultHash
        )
          throw new Error('assistant-reply-context-reference')
      }
      if (!previous || previous.references_json !== serialized) {
        const inserted = this.database
          .prepare(
            'INSERT INTO assistant_reply_context(message_id, references_json) VALUES (?, ?) ON CONFLICT(message_id) DO UPDATE SET references_json=excluded.references_json'
          )
          .run(messageId, serialized)
        if (Number(inserted.changes) !== 1) throw new Error('assistant-reply-context-write-not-persisted')
      }
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  getHostTaskIntent(actionId: string): ResidentHostTaskIntent | null {
    const row = this.database
      .prepare('SELECT * FROM assistant_task_run WHERE action_id = ? AND retired_at IS NULL')
      .get(actionId)
    if (!row) return null
    return {
      envelope: JSON.parse(String(row.envelope_json)),
      envelopeHash: String(row.envelope_hash),
      sessionReceipt: row.session_receipt_json == null ? null : JSON.parse(String(row.session_receipt_json)),
      outcome: row.outcome_json == null ? null : JSON.parse(String(row.outcome_json)),
      outcomeReceipt: row.outcome_receipt_json == null ? null : JSON.parse(String(row.outcome_receipt_json)),
      invalidated: Boolean(row.invalidated),
    }
  }

  private requireHostTaskIntent(actionId: string) {
    const intent = this.getHostTaskIntent(actionId)
    if (!intent) throw new Error('host-task-intent-not-found')
    return intent
  }

  private requireChanged(result: { changes: number | bigint }) {
    if (Number(result.changes) !== 1) throw new Error('host-task-write-not-persisted')
  }

  private preparedActionForMessage(messageId: string) {
    const row = this.database
      .prepare(`SELECT task.action_id FROM assistant_task_run AS task
      JOIN assistant_task_execution AS execution ON execution.action_id = task.action_id
      WHERE task.assistant_message_id = ?`)
      .get(messageId)
    return row ? String(row.action_id) : null
  }

  private assertNotPreparedMessage(messageId: string) {
    if (
      this.database
        .prepare('SELECT 1 FROM assistant_command WHERE message_id=? OR user_message_id=?')
        .get(messageId, messageId)
    )
      throw new Error('assistant-command-owned')
    if (this.commandRecord(messageId)?.retired) throw new Error('assistant-remote-retired')
    if (this.initiatives.ownsMessage(messageId)) throw new Error('initiative-execution-owned')
    if (
      this.database
        .prepare(`SELECT task.action_id FROM assistant_task_run AS task
      JOIN assistant_task_execution AS execution ON execution.action_id = task.action_id
      WHERE task.assistant_message_id = ? OR task.user_message_id = ?`)
        .get(messageId, messageId)
    )
      throw new Error('host-task-execution-owned')
  }

  hostTaskExecution(actionId: string): ResidentTaskExecution | null {
    const row = this.database
      .prepare(`SELECT execution.* FROM assistant_task_execution execution
      JOIN assistant_task_run task ON task.action_id=execution.action_id
      WHERE execution.action_id=? AND task.retired_at IS NULL`)
      .get(actionId)
    if (!row) return null
    return {
      intent: this.requireHostTaskIntent(actionId),
      prepared: JSON.parse(String(row.prepared_json)),
      preparedHash: String(row.prepared_hash),
      state: row.state as ResidentTaskExecution['state'],
      observation: row.observation_json == null ? null : JSON.parse(String(row.observation_json)),
      cursor: row.cursor == null ? null : Number(row.cursor),
      receivedAt: row.received_at == null ? null : Number(row.received_at),
      terminal: row.terminal_json == null ? null : JSON.parse(String(row.terminal_json)),
      terminalReceivedAt: row.terminal_received_at == null ? null : Number(row.terminal_received_at),
      cancellation: row.cancellation_json == null ? null : JSON.parse(String(row.cancellation_json)),
      sources: this.taskMemorySources(actionId),
    }
  }

  hostTaskExecutionForMessage(messageId: string): ResidentTaskExecution | null {
    const actionId = this.preparedActionForMessage(messageId)
    return actionId ? this.hostTaskExecution(actionId) : null
  }

  ownsHostTaskMessage(messageId: string): boolean {
    return Boolean(
      this.database
        .prepare(`SELECT 1 FROM assistant_task_run
        WHERE user_message_id = ? OR assistant_message_id = ? LIMIT 1`)
        .get(messageId, messageId)
    )
  }

  hostTaskExecutionForJob(jobId: string): ResidentTaskExecution | null {
    const row = this.database.prepare('SELECT action_id FROM assistant_task_run WHERE job_id = ?').get(jobId)
    return row ? this.hostTaskExecution(String(row.action_id)) : null
  }

  hasUnresolvedHostTaskMemoryClaim(actionId: string): boolean {
    const execution = this.requireTaskExecution(actionId)
    return Boolean(
      this.database
        .prepare(`SELECT 1 FROM assistant_tool_call
      WHERE message_id = ? AND tool_name = 'remember_memory' AND result_json IS NULL LIMIT 1`)
        .get(execution.intent.envelope.assistantMessageId)
    )
  }

  unresolvedHostTaskExecutions(): ResidentTaskExecution[] {
    return this.database
      .prepare(`SELECT execution.action_id FROM assistant_task_execution AS execution
      JOIN assistant_task_run AS task ON task.action_id = execution.action_id
      WHERE task.retired_at IS NULL AND execution.state != 'cancelled-unsubmitted'
        AND (task.outcome_json IS NULL OR task.outcome_receipt_json IS NULL)
      ORDER BY execution.rowid`)
      .all()
      .map((row) => this.requireTaskExecution(String(row.action_id)))
  }

  invalidateHostTaskAction(actionId: string) {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.requireTaskExecution(actionId)
      this.requireChanged(
        this.database.prepare('UPDATE assistant_task_run SET invalidated = 1 WHERE action_id = ?').run(actionId)
      )
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  private requireTaskExecution(actionId: string) {
    const execution = this.hostTaskExecution(actionId)
    if (!execution) throw new Error('host-task-execution-not-found')
    return execution
  }

  createPreparedHostTaskIntent(input: unknown, preparedInput: unknown): ResidentTaskExecution {
    const { envelope, envelopeHash, serialized } = validateHostTaskEnvelope(input)
    const prepared = validateHostTaskPrepared(envelope, preparedInput)
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const previous = this.hostTaskExecution(envelope.actionId)
      if (previous) {
        if (
          previous.intent.envelopeHash !== envelopeHash ||
          canonicalHostTaskJson(previous.intent.envelope) !== serialized ||
          previous.preparedHash !== prepared.preparedHash ||
          canonicalHostTaskJson(previous.prepared) !== prepared.serialized
        )
          throw new Error('host-task-binding-conflict')
      } else {
        if (this.getHostTaskIntent(envelope.actionId)) throw new Error('host-task-legacy-intent-owned')
        this.initiatives.assertTaskSlotAvailable()
        this.insertHostTaskIntent(envelope, envelopeHash, serialized, true)
        this.requireChanged(
          this.database
            .prepare(`INSERT INTO assistant_task_execution
          (action_id, prepared_json, prepared_hash, state) VALUES (?, ?, ?, 'prepared')`)
            .run(envelope.actionId, prepared.serialized, prepared.preparedHash)
        )
        this.insertTaskMemorySources(envelope.actionId, envelope.sources)
      }
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    return this.requireTaskExecution(envelope.actionId)
  }

  taskMemorySources(actionId: string): HostTaskEnvelopeV1['sources'] {
    if (!this.database.prepare('SELECT action_id FROM assistant_task_execution WHERE action_id = ?').get(actionId))
      throw new Error('host-task-execution-not-found')
    return this.database
      .prepare(`SELECT reference_json FROM assistant_task_memory_source
      WHERE action_id = ? ORDER BY space_id, slug`)
      .all(actionId)
      .map((row) => JSON.parse(String(row.reference_json)))
  }

  private insertTaskMemorySources(actionId: string, sources: HostTaskEnvelopeV1['sources']) {
    for (const source of sources) {
      const previous = this.database
        .prepare(`SELECT reference_json FROM assistant_task_memory_source
        WHERE action_id = ? AND space_id = ? AND slug = ?`)
        .get(actionId, source.spaceId, source.slug)
      if (previous) {
        if (canonicalHostTaskJson(JSON.parse(String(previous.reference_json))) !== canonicalHostTaskJson(source))
          throw new Error('host-task-source-conflict')
      } else
        this.requireChanged(
          this.database
            .prepare(`INSERT INTO assistant_task_memory_source
        (action_id, space_id, slug, reference_json) VALUES (?, ?, ?, ?)`)
            .run(actionId, source.spaceId, source.slug, canonicalHostTaskJson(source))
        )
    }
    const count = this.database
      .prepare('SELECT count(*) AS count FROM assistant_task_memory_source WHERE action_id = ?')
      .get(actionId)
    if (Number(count?.count) > 100) throw new Error('host-task-source-limit')
  }

  recordTaskMemorySources(actionId: string, sources: unknown) {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const execution = this.requireTaskExecution(actionId)
      if (execution.intent.invalidated) throw new Error('host-task-context-invalidated')
      if (execution.cancellation || execution.terminal) throw new Error('host-task-execution-terminal')
      const valid = validateHostTaskEnvelope({ ...execution.intent.envelope, sources }).envelope.sources
      this.insertTaskMemorySources(actionId, valid)
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  commitHostTaskObservation(actionId: string, input: unknown): ResidentTaskExecution {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const previous = this.requireTaskExecution(actionId)
      const { envelope } = previous.intent
      const valid = validateHostTaskObservation(envelope, previous.prepared, input)
      const observation = valid.observation
      if (previous.observation && canonicalHostTaskJson(previous.observation) === valid.serialized) {
        this.database.exec('COMMIT')
        return this.requireTaskExecution(actionId)
      }

      let state: ResidentTaskExecution['state'] = previous.state
      let cursor = previous.cursor
      let receivedAt = previous.receivedAt
      let terminal = previous.terminal
      let terminalReceivedAt = previous.terminalReceivedAt
      let cancellation = previous.cancellation
      let patch: MessagePatch | null = null
      let outcome: ReturnType<typeof validateHostTaskOutcome> | null = null
      const currentMessage = this.get(envelope.assistantMessageId)
      if (!currentMessage || currentMessage.role !== 'assistant' || currentMessage.replyTo !== envelope.userMessageId)
        throw new Error('host-task-binding-conflict')

      if (observation.kind === 'admission') {
        if (previous.intent.invalidated) throw new Error('host-task-context-invalidated')
        this.requireTaskSessionReceipt(previous.intent)
        const expected = observation.state === 'registered' ? 'prepared' : 'registered'
        if (previous.state !== expected) throw new Error('host-task-admission-conflict')
        state = observation.state
      } else if (observation.kind === 'cancelled-unsubmitted') {
        if (!['prepared', 'registered'].includes(previous.state)) throw new Error('host-task-cancellation-conflict')
        state = 'cancelled-unsubmitted'
        cancellation = observation.cancellation
        patch = {
          text: currentMessage.text,
          steps: currentMessage.steps,
          status: 'interrupted',
          error: 'assistant-host-task-not-started',
        }
      } else {
        this.requireTaskSessionReceipt(previous.intent)
        if (
          observation.delivery.kind === 'withheld' &&
          observation.delivery.reason === 'context-invalidated' &&
          !previous.intent.invalidated
        )
          throw new Error('host-task-invalidation-required')
        if (previous.state !== 'dispatch-intent' && previous.observation?.kind !== 'host')
          throw new Error('host-task-admission-conflict')
        const last = previous.observation?.kind === 'host' ? previous.observation : null
        if (last) this.validateTaskHostContinuation(last, observation)
        if (terminal && canonicalHostTaskJson(terminal) !== canonicalHostTaskJson(valid.terminal))
          throw new Error('host-task-terminal-conflict')
        const sanitizedStop =
          observation.job.phase === 'stopped' &&
          observation.delivery.kind === 'content' &&
          observation.delivery.response === '' &&
          observation.delivery.steps.length === 0 &&
          previous.intent.invalidated
        if (previous.intent.outcome) {
          if (
            observation.delivery.kind !== 'content' ||
            observation.delivery.response !== previous.intent.outcome.response ||
            canonicalHostTaskJson(observation.delivery.steps) !== canonicalHostTaskJson(previous.intent.outcome.steps)
          )
            throw new Error('host-task-terminal-conflict')
        } else {
          if (previous.intent.invalidated && observation.delivery.kind === 'content' && !sanitizedStop)
            throw new Error('host-task-context-invalidated')
          if (observation.delivery.kind === 'content' && !sanitizedStop)
            this.validateTaskSteps(currentMessage.steps, observation.delivery.steps)
        }
        const release =
          last?.delivery.kind === 'withheld' &&
          last.job.phase === 'completed' &&
          observation.delivery.kind === 'content' &&
          Boolean(terminal) &&
          !previous.intent.invalidated
        const terminalReplay =
          last &&
          terminal &&
          canonicalHostTaskJson({ ...last, coordinatorSessionId: observation.coordinatorSessionId }) ===
            valid.serialized
        if (last && observation.cursor === last.cursor && !release && !terminalReplay)
          throw new Error('host-task-cursor-conflict')

        if (!terminal && valid.terminal) {
          terminalReceivedAt = validateHostTaskReceivedAt(envelope, this.now())
          terminal = valid.terminal
        }
        receivedAt = terminalReceivedAt ?? validateHostTaskReceivedAt(envelope, this.now())
        if (previous.receivedAt !== null && receivedAt < previous.receivedAt)
          throw new Error('host-task-received-at-regression')
        state = observation.job.phase
        cursor = observation.cursor
        if (!previous.intent.outcome) {
          if (observation.delivery.kind === 'withheld') {
            patch = {
              text: currentMessage.text,
              steps: currentMessage.steps,
              status: 'interrupted',
              error:
                previous.intent.invalidated || observation.delivery.reason === 'context-invalidated'
                  ? 'assistant-host-context-invalidated'
                  : 'assistant-host-context-unavailable',
            }
          } else {
            const stopped = observation.job.phase === 'stopped'
            patch = {
              text: observation.delivery.response,
              steps: observation.delivery.steps,
              status: stopped ? 'cancelled' : terminal ? 'completed' : 'streaming',
              error:
                stopped && observation.job.stopReason === 'request-expired'
                  ? 'assistant-host-request-expired'
                  : stopped && previous.intent.invalidated
                    ? 'assistant-host-context-invalidated'
                    : observation.job.phase === 'recovery-required'
                      ? 'assistant-host-recovery-required'
                      : null,
            }
            if (terminal) {
              if (terminalReceivedAt === null) throw new Error('host-task-terminal-conflict')
              outcome = validateHostTaskOutcome({
                version: 1,
                status: terminal.phase,
                response: patch.text,
                steps: patch.steps,
                completedAt: terminalReceivedAt,
                durationMs: terminal.durationMs,
              })
            }
          }
        }
      }

      this.requireChanged(
        this.database
          .prepare(`UPDATE assistant_task_execution
        SET state = ?, observation_json = ?, cursor = ?, received_at = ?, terminal_json = ?, terminal_received_at = ?, cancellation_json = ?
        WHERE action_id = ?`)
          .run(
            state,
            valid.serialized,
            cursor,
            receivedAt,
            terminal ? canonicalHostTaskJson(terminal) : null,
            terminalReceivedAt,
            cancellation ? canonicalHostTaskJson(cancellation) : null,
            actionId
          )
      )
      if (patch)
        this.requireChanged(
          this.database
            .prepare(`UPDATE assistant_message
        SET text = ?, steps_json = ?, status = ?, error = ?, updated_at = ?
        WHERE id = ? AND role = 'assistant' AND reply_to = ?`)
            .run(
              patch.text,
              JSON.stringify(patch.steps),
              patch.status,
              patch.error ?? null,
              receivedAt ?? currentMessage.updatedAt,
              envelope.assistantMessageId,
              envelope.userMessageId
            )
        )
      if (outcome)
        this.requireChanged(
          this.database
            .prepare(`UPDATE assistant_task_run
        SET outcome_json = ?, outcome_hash = ? WHERE action_id = ? AND outcome_json IS NULL`)
            .run(outcome.serialized, outcome.outcomeHash, actionId)
        )
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    return this.requireTaskExecution(actionId)
  }

  private requireTaskSessionReceipt(intent: ResidentHostTaskIntent) {
    if (
      !intent.sessionReceipt ||
      canonicalHostTaskJson(intent.sessionReceipt) !== canonicalHostTaskJson(hostTaskSessionReceipt(intent.envelope))
    )
      throw new Error('host-task-receipt-not-found')
  }

  private validateTaskHostContinuation(previous: HostTaskHostObservation, next: HostTaskHostObservation) {
    if (next.cursor < previous.cursor) throw new Error('host-task-cursor-regression')
    if (
      next.job.createdAt !== previous.job.createdAt ||
      next.job.updatedAt < previous.job.updatedAt ||
      (previous.job.threadId !== null && next.job.threadId !== previous.job.threadId) ||
      (previous.job.turnId !== null && next.job.turnId !== previous.job.turnId) ||
      (previous.job.stopReason === 'request-expired' && next.job.stopReason !== 'request-expired')
    )
      throw new Error('host-task-host-identity-conflict')
    const before = ['thread-start-intent', 'thread-bound', 'turn-start-intent']
    const previousIndex = before.indexOf(previous.job.phase)
    const nextIndex = before.indexOf(next.job.phase)
    if (
      (previousIndex >= 0 && nextIndex >= 0 && nextIndex < previousIndex) ||
      (['running', 'waiting', 'completed', 'stopped'].includes(previous.job.phase) && nextIndex >= 0) ||
      (previous.job.phase === 'recovery-required' &&
        !['recovery-required', 'completed', 'stopped'].includes(next.job.phase))
    )
      throw new Error('host-task-host-phase-regression')
  }

  private validateTaskSteps(previous: AgentTurnStep[], next: AgentTurnStep[]) {
    for (const [index, step] of previous.entries()) {
      const current = next[index]
      if (!current || current.id !== step.id || current.kind !== step.kind || current.at !== step.at)
        throw new Error('host-task-step-conflict')
    }
  }

  private insertHostTaskIntent(e: HostTaskEnvelopeV1, envelopeHash: string, serialized: string, checked = false) {
    const existing = this.getHostTaskIntent(e.actionId)
    if (existing) {
      if (existing.envelopeHash !== envelopeHash || canonicalHostTaskJson(existing.envelope) !== serialized)
        throw new Error('host-task-binding-conflict')
      return
    }
    this.initiatives.assertTaskSlotAvailable()
    this.initiatives.assertTaskIdentityAvailable(e)
    const conflict = this.database
      .prepare(`SELECT action_id FROM assistant_task_run WHERE session_id = ? OR job_id = ?
        UNION ALL SELECT job_id FROM assistant_host_run WHERE job_id = ?
        UNION ALL SELECT id FROM assistant_message WHERE id IN (?, ?)`)
      .get(e.sessionId, e.jobId, e.jobId, e.userMessageId, e.assistantMessageId)
    if (conflict) throw new Error('host-task-binding-conflict')
    const writes = [
      this.database
        .prepare(`INSERT INTO assistant_message (id, role, text, provider, created_at, updated_at, status)
        VALUES (?, 'user', ?, ?, ?, ?, 'completed')`)
        .run(e.userMessageId, e.instruction, e.provider, e.startedAt, e.startedAt),
      this.database
        .prepare(`INSERT INTO assistant_message (id, role, text, provider, created_at, updated_at, status, reply_to, error)
        VALUES (?, 'assistant', '', ?, ?, ?, 'interrupted', ?, 'assistant-host-task-not-submitted')`)
        .run(e.assistantMessageId, e.provider, e.startedAt, e.startedAt, e.userMessageId),
      this.database
        .prepare(`INSERT INTO assistant_task_run (action_id, work_item_id, session_id, job_id, user_message_id,
        assistant_message_id, envelope_hash, envelope_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          e.actionId,
          e.workItemId,
          e.sessionId,
          e.jobId,
          e.userMessageId,
          e.assistantMessageId,
          envelopeHash,
          serialized
        ),
    ]
    if (checked) for (const result of writes) this.requireChanged(result)
  }

  createHostTaskIntent(input: unknown): ResidentHostTaskIntent {
    const { envelope, envelopeHash, serialized } = validateHostTaskEnvelope(input)
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.insertHostTaskIntent(envelope, envelopeHash, serialized)
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    return this.requireHostTaskIntent(envelope.actionId)
  }

  acknowledgeHostTaskSession(actionId: string, receipt: unknown): ResidentHostTaskIntent {
    const serialized = canonicalHostTaskJson(receipt)
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const intent = this.requireHostTaskIntent(actionId)
      if (serialized !== canonicalHostTaskJson(hostTaskSessionReceipt(intent.envelope)))
        throw new Error('host-task-receipt-conflict')
      if (intent.sessionReceipt && serialized !== canonicalHostTaskJson(intent.sessionReceipt))
        throw new Error('host-task-receipt-conflict')
      if (!intent.sessionReceipt) {
        const updated = this.database
          .prepare('UPDATE assistant_task_run SET session_receipt_json = ? WHERE action_id = ?')
          .run(serialized, actionId)
        if (this.hostTaskExecution(actionId)) this.requireChanged(updated)
      }
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    return this.requireHostTaskIntent(actionId)
  }

  recordHostTaskOutcome(actionId: string, input: unknown): ResidentHostTaskIntent {
    if (this.hostTaskExecution(actionId)) throw new Error('host-task-execution-owned')
    const { outcome, outcomeHash, serialized } = validateHostTaskOutcome(input)
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const intent = this.requireHostTaskIntent(actionId)
      if (
        !intent.sessionReceipt ||
        canonicalHostTaskJson(intent.sessionReceipt) !== canonicalHostTaskJson(hostTaskSessionReceipt(intent.envelope))
      )
        throw new Error('host-task-receipt-not-found')
      if (intent.outcome) {
        if (canonicalHostTaskJson(intent.outcome) !== serialized) throw new Error('host-task-outcome-conflict')
      } else {
        if (
          intent.invalidated &&
          (outcome.status !== 'stopped' || outcome.response !== '' || outcome.steps.length !== 0)
        )
          throw new Error('host-task-context-invalidated')
        if (outcome.completedAt < intent.envelope.startedAt) throw new Error('host-task-outcome-conflict')
        const updated = this.database
          .prepare(`UPDATE assistant_message SET text = ?, steps_json = ?, status = ?, error = ?, updated_at = ?
            WHERE id = ? AND role = 'assistant' AND reply_to = ?`)
          .run(
            outcome.response,
            JSON.stringify(outcome.steps),
            outcome.status === 'completed' ? 'completed' : 'cancelled',
            intent.invalidated ? 'assistant-host-context-invalidated' : null,
            outcome.completedAt,
            intent.envelope.assistantMessageId,
            intent.envelope.userMessageId
          )
        if (updated.changes !== 1) throw new Error('host-task-binding-conflict')
        this.database
          .prepare('UPDATE assistant_task_run SET outcome_json = ?, outcome_hash = ? WHERE action_id = ?')
          .run(serialized, outcomeHash, actionId)
      }
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    return this.requireHostTaskIntent(actionId)
  }

  acknowledgeHostTaskOutcome(actionId: string, receipt: unknown): ResidentHostTaskIntent {
    const serialized = canonicalHostTaskJson(receipt)
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const intent = this.requireHostTaskIntent(actionId)
      if (!intent.sessionReceipt || !intent.outcome) throw new Error('host-task-outcome-not-found')
      const { outcomeHash } = validateHostTaskOutcome(intent.outcome)
      const matches = ['applied', 'orphaned'].some(
        (projection) =>
          serialized === canonicalHostTaskJson({ ...hostTaskSessionReceipt(intent.envelope), outcomeHash, projection })
      )
      if (!matches || (intent.outcomeReceipt && serialized !== canonicalHostTaskJson(intent.outcomeReceipt)))
        throw new Error('host-task-outcome-receipt-conflict')
      if (!intent.outcomeReceipt) {
        const updated = this.database
          .prepare('UPDATE assistant_task_run SET outcome_receipt_json = ? WHERE action_id = ?')
          .run(serialized, actionId)
        if (this.hostTaskExecution(actionId)) this.requireChanged(updated)
      }
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    return this.requireHostTaskIntent(actionId)
  }

  hostTaskResults(actionId: string): AssistantResult[] {
    const intent = this.requireHostTaskIntent(actionId)
    return this.get(intent.envelope.assistantMessageId)?.results ?? []
  }

  private messageWithResults(row: Row) {
    const results =
      row.role === 'assistant'
        ? this.database
            .prepare(
              "SELECT id, result_json FROM assistant_tool_call WHERE message_id = ? AND tool_name = 'remember_memory' AND result_json IS NOT NULL ORDER BY rowid"
            )
            .all(String(row.id))
            .flatMap((receipt) => {
              try {
                const result = savedPageResult(String(receipt.id), JSON.parse(String(receipt.result_json)))
                return result ? [result] : []
              } catch {
                return []
              }
            })
        : []
    const value = message(row, results)
    const commandRecord = this.commandRecord(value.id)
    const orphanedRemoteFailure =
      !commandRecord &&
      value.error?.startsWith('codex-remote-') &&
      !this.database
        .prepare(`SELECT 1 FROM assistant_remote_run WHERE json_extract(checkpoint,'$.messageId')=?
          UNION ALL SELECT 1 FROM assistant_host_run WHERE message_id=?
          UNION ALL SELECT 1 FROM assistant_task_run WHERE assistant_message_id=? LIMIT 1`)
        .get(value.id, value.id, value.id)
    if (
      (commandRecord?.retired || orphanedRemoteFailure) &&
      ['failed', 'cancelled', 'interrupted'].includes(value.status)
    )
      value.error = value.status === 'cancelled' ? 'assistant-remote-retired-cancelled' : 'assistant-remote-retired'
    const command = commandRecord?.retired ? null : commandRecord?.command
    if (command)
      Object.assign(value, {
        command: {
          state: command.state,
          targetLabel: command.targetLabel,
          stopRequested: command.stopRequested,
          canStop: !commandTerminal(command) && (command.state === 'reserved' || command.checkpoint !== null),
        },
      })
    const receipt = this.database
      .prepare('SELECT payload_json FROM assistant_proactive_initiative WHERE message_id = ?')
      .get(value.id)
    if (receipt) {
      const decision = JSON.parse(String(receipt.payload_json)) as ProactiveDecision
      value.initiative = {
        kind:
          decision.kind === 'offer' || decision.kind === 'prepare'
            ? 'offer'
            : decision.kind === 'clarify'
              ? 'clarify'
              : 'observe',
        taskIds: decision.taskIds ?? [],
        decisionId: decision.id,
        topicKey: decision.topicKey,
        dismissed: this.proactiveDismissedTopics().some((topic) => topic.topicKey === decision.topicKey),
        sources: decision.supportingQuotes.map((entry) => {
          const source = decision.sourceRefs.find((reference) => reference.evidenceId === entry.sourceId)
          if (!source) throw new Error('proactive-source-binding-missing')
          return {
            id: entry.sourceId,
            quote: entry.quote,
            kind: source.kind,
            ...(source.kind === 'note' ? { noteId: source.sourceId } : {}),
            ...(source.kind === 'day' ? { dayId: source.workdayId } : {}),
            observedAt: source.observedAt,
            appName: redactSensitiveCaptureText(source.appName),
            windowTitle: redactSensitiveCaptureText(source.windowTitle),
          }
        }),
      }
    }
    return value
  }

  proactiveDecision(messageId: string): ProactiveDecision | null {
    const row = this.database
      .prepare('SELECT payload_json FROM assistant_proactive_initiative WHERE message_id = ?')
      .get(messageId)
    return row ? (JSON.parse(String(row.payload_json)) as ProactiveDecision) : null
  }

  proactiveConversationGeneration() {
    return Number(
      this.database.prepare("SELECT value FROM assistant_state WHERE key = 'proactive-generation'").get()?.value ?? 0
    )
  }

  noteConversationInput() {
    this.advanceProactiveGeneration()
  }

  private advanceProactiveGeneration() {
    const result = this.database
      .prepare(`INSERT INTO assistant_state(key,value) VALUES ('proactive-generation',1)
      ON CONFLICT(key) DO UPDATE SET value = value + 1`)
      .run()
    if (result.changes !== 1) throw new Error('proactive-write-not-persisted')
  }

  proactiveConversationContext(): Omit<ProactiveConversationState, 'available'> {
    const recentMessages = this.history().map(({ id, role, text, createdAt }) => ({
      id,
      role,
      text: text.slice(0, 2000),
      createdAt,
    }))
    const recentInitiatives = this.database
      .prepare(`SELECT i.decision_id, i.payload_json, m.created_at
      FROM assistant_proactive_initiative i JOIN assistant_message m ON m.id = i.message_id
      ORDER BY m.sequence DESC LIMIT 30`)
      .all()
      .map((row) => ({
        decisionId: String(row.decision_id),
        topicKey: String(JSON.parse(String(row.payload_json)).topicKey),
        createdAt: Number(row.created_at),
      }))
    return {
      generation: this.proactiveConversationGeneration(),
      recentMessages,
      recentInitiatives,
      dismissedTopics: this.proactiveDismissedTopics(),
    }
  }

  private proactiveDismissedTopics(): ProactiveConversationState['dismissedTopics'] {
    return this.database
      .prepare(
        'SELECT * FROM assistant_proactive_dismissal WHERE expires_at IS NULL OR expires_at > ? ORDER BY dismissed_at DESC'
      )
      .all(this.now())
      .map((row) => ({
        topicKey: String(row.topic_key),
        dismissedAt: Number(row.dismissed_at),
        expiresAt: row.expires_at === null ? null : Number(row.expires_at),
      }))
  }

  deliveredProactiveInitiative(id: string, inputHash: string): string | null {
    const receipt = this.database.prepare('SELECT * FROM assistant_proactive_initiative WHERE decision_id = ?').get(id)
    if (!receipt) return null
    if (receipt.input_hash !== inputHash) throw new Error('proactive-initiative-conflict')
    return String(receipt.message_id)
  }

  existingProactiveInitiative(decision: ProactiveDecision): string | null {
    const payload = proactivePayload(decision)
    const receipt = this.database
      .prepare('SELECT * FROM assistant_proactive_initiative WHERE decision_id = ?')
      .get(decision.id)
    if (!receipt) return null
    if (receipt.payload_hash !== payload.hash || receipt.payload_json !== payload.json)
      throw new Error('proactive-initiative-conflict')
    return String(receipt.message_id)
  }

  appendProactiveInitiative(decision: ProactiveDecision): string | null {
    const payload = proactivePayload(decision)
    const existing = this.existingProactiveInitiative(decision)
    if (existing) return existing
    const receivedAt = this.now()
    if (
      decision.invalidatedAt !== null ||
      decision.deliveredMessageId !== null ||
      decision.createdAt > receivedAt ||
      decision.expiresAt <= receivedAt ||
      decision.conversationGeneration !== this.proactiveConversationGeneration() ||
      this.proactiveDismissedTopics().some((topic) => topic.topicKey === decision.topicKey)
    )
      return null
    if (decision.sourceRefs.every((source) => source.kind === 'day')) {
      const recent = this.database
        .prepare(`SELECT i.payload_json, m.created_at
        FROM assistant_proactive_initiative i JOIN assistant_message m ON m.id = i.message_id
        WHERE m.created_at > ?`)
        .all(receivedAt - PROACTIVE_DAY_TASK_INTERVAL_MS)
      if (
        recent.some(
          (row) =>
            receivedAt - Number(row.created_at) < PROACTIVE_DAY_REVIEW_INTERVAL_MS ||
            JSON.parse(String(row.payload_json)).topicKey === decision.topicKey
        )
      )
        return null
    }
    const id = randomUUID()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      if (decision.conversationGeneration !== this.proactiveConversationGeneration()) {
        this.database.exec('ROLLBACK')
        return null
      }
      const inserted = this.database
        .prepare(`INSERT INTO assistant_message(id,role,text,provider,created_at,updated_at,status)
        VALUES (?,'assistant',?,'codex',?,?,'completed')`)
        .run(id, decision.text, receivedAt, receivedAt)
      if (inserted.changes !== 1) throw new Error('proactive-write-not-persisted')
      const receipt = this.database
        .prepare('INSERT INTO assistant_proactive_initiative VALUES (?,?,?,?,?)')
        .run(decision.id, id, decision.inputHash, payload.hash, payload.json)
      if (receipt.changes !== 1) throw new Error('proactive-write-not-persisted')
      this.database.exec('COMMIT')
      return id
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  latestProactiveOffer() {
    const row = this.database.prepare('SELECT * FROM assistant_message ORDER BY sequence DESC LIMIT 1').get()
    if (row?.role !== 'assistant' || row.status !== 'completed') return null
    const value = this.messageWithResults(row)
    if (!value.initiative || value.initiative.dismissed || this.now() - value.createdAt > 86_400_000) return null
    return this.proactiveDecision(value.id)?.kind === 'offer' ? value : null
  }

  dismissProactiveInitiative(
    messageId: string,
    reply?: { text: string; provider: AgentProvider; acknowledgement: string; submission?: SendAssistantMessageInput }
  ) {
    const receipt = this.database
      .prepare('SELECT payload_json FROM assistant_proactive_initiative WHERE message_id = ?')
      .get(messageId)
    if (!receipt) throw new Error('proactive-initiative-not-found')
    const decision = JSON.parse(String(receipt.payload_json)) as ProactiveDecision
    if (this.proactiveDismissedTopics().some((topic) => topic.topicKey === decision.topicKey)) return
    const now = this.now()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      if (reply) {
        if (
          this.latestProactiveOffer()?.id !== messageId ||
          !reply.text.trim() ||
          reply.text.length > 20_000 ||
          !['codex', 'claude'].includes(reply.provider) ||
          !reply.acknowledgement.trim()
        )
          throw new Error('proactive-dismissal-reply-invalid')
        const userId = reply.submission?.clientMessageId ?? randomUUID()
        const user = this.database
          .prepare(`INSERT INTO assistant_message(id,role,text,provider,created_at,updated_at,status)
          VALUES (?,'user',?,?,?,?,'completed')`)
          .run(userId, reply.text, reply.provider, now, now)
        const acknowledgement = this.database
          .prepare(`INSERT INTO assistant_message(id,role,text,provider,created_at,updated_at,status,reply_to)
          VALUES (?,'assistant',?,?,?,?,'completed',?)`)
          .run(randomUUID(), reply.acknowledgement, reply.provider, now, now, userId)
        if (user.changes !== 1 || acknowledgement.changes !== 1) throw new Error('proactive-write-not-persisted')
        this.recordSubmission(reply.submission)
      }
      const result = this.database
        .prepare(`INSERT INTO assistant_proactive_dismissal VALUES (?,?,?)
        ON CONFLICT(topic_key) DO UPDATE SET dismissed_at = excluded.dismissed_at, expires_at = excluded.expires_at`)
        .run(
          decision.topicKey,
          now,
          now +
            (decision.sourceRefs.every((source) => source.kind === 'day')
              ? PROACTIVE_DAY_TASK_INTERVAL_MS
              : 30 * 60_000)
        )
      if (result.changes !== 1) throw new Error('proactive-write-not-persisted')
      this.advanceProactiveGeneration()
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  appendTaskSuggestion(input: ResidentTaskSuggestion) {
    if (this.database.prepare('SELECT event_id FROM assistant_task_suggestion WHERE event_id = ?').get(input.eventId))
      return true
    if (
      !input.eventId ||
      !input.taskId ||
      !input.evidenceIds.length ||
      !input.text.trim() ||
      input.text.length > 20_000
    )
      throw new Error('invalid-assistant-suggestion')
    const id = randomUUID()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database
        .prepare(`INSERT INTO assistant_message (id, role, text, provider, created_at, updated_at, status)
        VALUES (?, 'assistant', ?, ?, ?, ?, 'completed')`)
        .run(id, input.text, input.provider, input.createdAt, input.createdAt)
      this.database
        .prepare(
          'INSERT INTO assistant_task_suggestion (event_id, message_id, task_id, evidence_ids) VALUES (?, ?, ?, ?)'
        )
        .run(input.eventId, id, input.taskId, JSON.stringify(input.evidenceIds))
      this.database.exec('COMMIT')
      return true
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  recentTaskSuggestions(): ResidentTaskSuggestion[] {
    return this.database
      .prepare(`SELECT suggestion.*, message.text, message.provider, message.created_at
      FROM assistant_task_suggestion AS suggestion
      JOIN assistant_message AS message ON message.id = suggestion.message_id
      ORDER BY message.sequence DESC LIMIT 3`)
      .all()
      .map((row) => ({
        eventId: String(row.event_id),
        taskId: String(row.task_id),
        evidenceIds: JSON.parse(String(row.evidence_ids)),
        text: String(row.text),
        provider: row.provider as AgentProvider,
        createdAt: Number(row.created_at),
      }))
  }

  claimToolCall(
    id: string,
    requestHash: string,
    binding?: { messageId: string; toolName: 'remember_memory' | 'remember_task'; actionId?: string }
  ): { existing: boolean; result: unknown | null } {
    if (binding && this.initiatives.ownsMessage(binding.messageId)) throw new Error('initiative-execution-owned')
    const preparedAction = binding ? this.preparedActionForMessage(binding.messageId) : null
    if (binding && (preparedAction || binding.actionId) && preparedAction !== binding.actionId)
      throw new Error('host-task-tool-binding-conflict')
    const existing = this.database
      .prepare('SELECT request_hash, result_json, message_id, tool_name FROM assistant_tool_call WHERE id = ?')
      .get(id)
    if (existing) {
      const ownedAction =
        existing.message_id == null ? null : this.preparedActionForMessage(String(existing.message_id))
      if (ownedAction && (!binding || binding.actionId !== ownedAction || binding.messageId !== existing.message_id))
        throw new Error('host-task-tool-binding-conflict')
      if (existing.request_hash !== requestHash) throw new Error('assistant-tool-call-mismatch')
      if (binding && (existing.message_id !== binding.messageId || existing.tool_name !== binding.toolName))
        throw new Error('assistant-tool-call-binding-mismatch')
      return { existing: true, result: existing.result_json == null ? null : JSON.parse(String(existing.result_json)) }
    }
    if (binding && this.get(binding.messageId)?.role !== 'assistant') throw new Error('assistant-tool-message-invalid')
    if (preparedAction) {
      const execution = this.requireTaskExecution(preparedAction)
      if (execution.intent.invalidated) throw new Error('host-task-context-invalidated')
      if (execution.terminal || execution.cancellation) throw new Error('host-task-execution-terminal')
    }
    const inserted = this.database
      .prepare('INSERT INTO assistant_tool_call (id, request_hash, message_id, tool_name) VALUES (?, ?, ?, ?)')
      .run(id, requestHash, binding?.messageId ?? null, binding?.toolName ?? null)
    if (preparedAction) this.requireChanged(inserted)
    return { existing: false, result: null }
  }

  finishToolCall(id: string, result: unknown, sourceRevision?: { expectedRevision: string; actionId?: string }) {
    const existing = this.database
      .prepare('SELECT result_json, message_id, tool_name FROM assistant_tool_call WHERE id = ?')
      .get(id)
    if (!existing) throw new Error('assistant-tool-call-not-claimed')
    const actionId = existing.message_id == null ? null : this.preparedActionForMessage(String(existing.message_id))
    if (sourceRevision?.actionId && sourceRevision.actionId !== actionId)
      throw new Error('host-task-tool-binding-conflict')
    if (existing.result_json != null) {
      if (!isDeepStrictEqual(JSON.parse(String(existing.result_json)), result))
        throw new Error('assistant-tool-result-mismatch')
      return
    }
    const saved = sourceRevision ? savedPageResult(id, result) : null
    if (sourceRevision && !saved) throw new Error('assistant-tool-source-receipt-invalid')
    if (actionId && savedPageResult(id, result) && (!sourceRevision || sourceRevision.actionId !== actionId))
      throw new Error('host-task-tool-source-required')
    this.database.exec('BEGIN IMMEDIATE')
    try {
      if (actionId) {
        const execution = this.requireTaskExecution(actionId)
        if (execution.intent.invalidated) throw new Error('host-task-context-invalidated')
        if (execution.cancellation) throw new Error('host-task-execution-terminal')
        if (existing.tool_name !== 'remember_memory') throw new Error('host-task-tool-binding-conflict')
        canonicalHostTaskJson(result)
      }
      const updated = this.database
        .prepare('UPDATE assistant_tool_call SET result_json = ? WHERE id = ? AND result_json IS NULL')
        .run(JSON.stringify(result), id)
      if (actionId) this.requireChanged(updated)
      if (sourceRevision && saved) {
        if (actionId)
          this.requireChanged(
            this.database
              .prepare(`UPDATE assistant_task_memory_source SET reference_json = json_set(reference_json, '$.revision', ?)
            WHERE action_id = ? AND space_id = ? AND slug = ? AND json_extract(reference_json, '$.revision') = ?`)
              .run(saved.revision, actionId, saved.spaceId, saved.slug, sourceRevision.expectedRevision)
          )
        else
          this.database
            .prepare(`UPDATE assistant_memory_source SET reference_json = json_set(reference_json, '$.revision', ?)
            WHERE space_id = ? AND slug = ? AND json_extract(reference_json, '$.revision') = ?`)
            .run(saved.revision, saved.spaceId, saved.slug, sourceRevision.expectedRevision)
      }
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  memorySources(): ResidentMemoryReference[] {
    return this.database
      .prepare('SELECT reference_json FROM assistant_memory_source')
      .all()
      .map((row) => JSON.parse(String(row.reference_json)))
  }

  recordMemorySources(sources: ResidentMemoryReference[]) {
    for (const { spaceId, slug, revision, explicit } of sources)
      this.database
        .prepare('INSERT OR IGNORE INTO assistant_memory_source (space_id, slug, reference_json) VALUES (?, ?, ?)')
        .run(spaceId, slug, JSON.stringify({ spaceId, slug, revision, explicit }))
  }

  remoteRun(): ResidentRemoteRun | null {
    const row = this.database.prepare('SELECT checkpoint FROM assistant_remote_run WHERE id = 1').get()
    return row ? JSON.parse(String(row.checkpoint)) : null
  }

  setRemoteRun(checkpoint: ResidentRemoteRun | null) {
    if (checkpoint && this.command(checkpoint.messageId)) throw new Error('assistant-command-owned')
    if (this.unresolvedCommands().length) throw new Error('assistant-command-effect-slot-occupied')
    if (!checkpoint) {
      this.database.prepare('DELETE FROM assistant_remote_run WHERE id = 1').run()
      return
    }
    this.assertNotPreparedMessage(checkpoint.messageId)
    const previous = this.remoteRun()
    const value =
      previous?.contextInvalidated && previous.threadId === checkpoint.threadId
        ? { ...checkpoint, contextInvalidated: true }
        : checkpoint
    this.database
      .prepare(`INSERT INTO assistant_remote_run (id, checkpoint) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET checkpoint = excluded.checkpoint`)
      .run(JSON.stringify(value))
  }

  hostRun(): ResidentHostRun | null {
    const row = this.database
      .prepare('SELECT binding FROM assistant_host_run WHERE retired_at IS NULL ORDER BY rowid DESC LIMIT 1')
      .get()
    return row ? JSON.parse(String(row.binding)) : null
  }

  persistHostRun(binding: ResidentHostRun, patch: MessagePatch) {
    this.assertNotPreparedMessage(binding.messageId)
    if (this.unresolvedCommands().length) throw new Error('assistant-command-effect-slot-occupied')
    if (this.initiatives.ownsJob(binding.jobId)) throw new Error('initiative-execution-owned')
    if (
      this.database
        .prepare(`SELECT task.action_id FROM assistant_task_run AS task
      JOIN assistant_task_execution AS execution ON execution.action_id = task.action_id WHERE task.job_id = ?`)
        .get(binding.jobId)
    )
      throw new Error('host-task-execution-owned')
    const row = this.database.prepare('SELECT binding FROM assistant_host_run WHERE job_id = ?').get(binding.jobId)
    const previous: ResidentHostRun | null = row ? JSON.parse(String(row.binding)) : null
    const latest = this.hostRun()
    if (
      !binding.jobId ||
      !binding.endpoint ||
      !Number.isSafeInteger(binding.cursor) ||
      binding.cursor < 0 ||
      this.get(binding.messageId)?.role !== 'assistant'
    )
      throw new Error('assistant-host-binding-invalid')
    if (
      (previous && (previous.messageId !== binding.messageId || previous.endpoint !== binding.endpoint)) ||
      (latest && latest.jobId !== binding.jobId && !isResidentHostTerminal(latest))
    )
      throw new Error('assistant-host-binding-mismatch')
    if (
      binding.stopReason !== undefined &&
      binding.stopReason !== 'request-expired' &&
      binding.stopReason !== 'context-invalidated'
    )
      throw new Error('assistant-host-stop-reason-invalid')
    if (previous && binding.cursor < previous.cursor) throw new Error('assistant-host-cursor-regression')
    if (previous && isResidentHostTerminal(previous) && binding.phase !== previous.phase)
      throw new Error('assistant-host-terminal-mismatch')
    if (
      (binding.phase === 'completed' && patch.status !== 'completed') ||
      (binding.phase === 'stopped' && patch.status !== 'cancelled')
    )
      throw new Error('assistant-host-result-not-persisted')
    const stopReason =
      previous?.stopReason === 'request-expired' || binding.stopReason === 'request-expired'
        ? 'request-expired'
        : (previous?.stopReason ?? binding.stopReason)
    const value: ResidentHostRun = {
      ...binding,
      ...(previous?.contextInvalidated ? { contextInvalidated: true } : {}),
      ...(previous?.stopRequested ? { stopRequested: true } : {}),
      ...(stopReason ? { stopReason } : {}),
    }
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const taskBindings = this.database
        .prepare(
          'SELECT job_id, assistant_message_id FROM assistant_task_run WHERE job_id = ? OR assistant_message_id = ?'
        )
        .all(binding.jobId, binding.messageId)
      if (taskBindings.some((task) => task.job_id !== binding.jobId || task.assistant_message_id !== binding.messageId))
        throw new Error('host-task-binding-conflict')
      this.update(binding.messageId, {
        ...patch,
        ...(value.phase === 'stopped' && value.stopReason === 'request-expired'
          ? { error: 'assistant-host-request-expired' }
          : value.phase === 'stopped' && value.stopReason === 'context-invalidated'
            ? { error: 'assistant-host-context-invalidated' }
            : {}),
      })
      this.database
        .prepare(`INSERT INTO assistant_host_run (job_id, message_id, binding) VALUES (?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET binding = excluded.binding`)
        .run(binding.jobId, binding.messageId, JSON.stringify(value))
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  private commandRecord(messageId: string) {
    const row = this.database
      .prepare(`SELECT state,value_json,retired_at FROM assistant_command WHERE message_id=?
        UNION ALL SELECT NULL,NULL,retired_at FROM assistant_retired_remote_run WHERE message_id=?
        UNION ALL SELECT NULL,NULL,retired_at FROM assistant_host_run WHERE message_id=? AND retired_at IS NOT NULL
        UNION ALL SELECT NULL,NULL,retired_at FROM assistant_task_run WHERE assistant_message_id=? AND retired_at IS NOT NULL LIMIT 1`)
      .get(messageId, messageId, messageId, messageId)
    if (!row) return null
    if (row.value_json === null) return { command: null, retired: true }
    const command = JSON.parse(String(row.value_json)) as ResidentCommand
    if (command.messageId !== messageId || command.state !== row.state)
      throw new Error('assistant-command-storage-conflict')
    return { command, retired: row.retired_at !== null }
  }

  command(messageId: string): ResidentCommand | null {
    const record = this.commandRecord(messageId)
    return record && !record.retired ? record.command : null
  }

  unresolvedCommands(): ResidentCommand[] {
    return this.database
      .prepare(
        "SELECT message_id FROM assistant_command WHERE retired_at IS NULL AND state NOT IN ('completed','stopped','cancelled') ORDER BY rowid"
      )
      .all()
      .map((row) => this.requireCommand(String(row.message_id)))
  }

  private requireCommand(id: string) {
    const command = this.command(id)
    if (!command) throw new Error('assistant-command-missing')
    return command
  }

  private commandTime(previous?: ResidentCommand) {
    const now = this.now()
    if (!Number.isSafeInteger(now) || now < 0 || (previous && now < previous.updatedAt))
      throw new Error('assistant-command-clock-regression')
    return now
  }

  private commandChanged(result: { changes: number | bigint }) {
    if (Number(result.changes) !== 1) throw new Error('assistant-command-write-not-persisted')
  }

  private commandTransaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const value = operation()
      this.database.exec('COMMIT')
      return value
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  private writeCommand(command: ResidentCommand) {
    this.commandChanged(
      this.database
        .prepare('UPDATE assistant_command SET state=?,value_json=? WHERE message_id=?')
        .run(command.state, canonicalHostTaskJson(command), command.messageId)
    )
  }

  private writeCommandMessage(id: string, patch: ResidentCommandPatch, at: number) {
    this.commandChanged(
      this.database
        .prepare(
          "UPDATE assistant_message SET text=?,steps_json=?,status=?,error=?,updated_at=? WHERE id=? AND role='assistant'"
        )
        .run(patch.text, JSON.stringify(patch.steps), patch.status, patch.error ?? null, at, id)
    )
  }

  queuedMessages() {
    return this.database
      .prepare(
        'SELECT id, text, execution_key FROM assistant_queued_message WHERE retired_at IS NULL ORDER BY sequence'
      )
      .all()
      .map((row) => ({ id: String(row.id), text: String(row.text), executionKey: String(row.execution_key) }))
  }

  hasSubmission(input: SendAssistantMessageInput) {
    if (!input.clientMessageId) return false
    const receipt = this.database
      .prepare('SELECT input_hash FROM assistant_submission WHERE id=?')
      .get(input.clientMessageId)
    if (!receipt) {
      if (
        this.get(input.clientMessageId) ||
        this.database.prepare('SELECT id FROM assistant_queued_message WHERE id=?').get(input.clientMessageId) ||
        this.database.prepare('SELECT id FROM assistant_queue_discard WHERE id=?').get(input.clientMessageId)
      )
        throw new Error('assistant-message-id-conflict')
      return false
    }
    if (receipt.input_hash !== this.submissionHash(input)) throw new Error('assistant-message-id-conflict')
    return true
  }

  private submissionHash(input: SendAssistantMessageInput) {
    return createHash('sha256')
      .update(JSON.stringify([input.text.trim(), input.provider, input.mode ?? null, input.queue ?? false]))
      .digest('hex')
  }

  private recordSubmission(input?: SendAssistantMessageInput) {
    if (!input?.clientMessageId) return
    this.commandChanged(
      this.database
        .prepare('INSERT INTO assistant_submission(id,input_hash) VALUES (?,?)')
        .run(input.clientMessageId, this.submissionHash(input))
    )
  }

  queueMessage(text: string, executionKey: string, submission?: SendAssistantMessageInput) {
    if (!text.trim() || text.length > 20_000 || this.queuedMessages().length >= 20)
      throw new Error('assistant-queue-limit')
    return this.commandTransaction(() => {
      const id = submission?.clientMessageId ?? randomUUID()
      this.database
        .prepare('INSERT INTO assistant_queued_message(id,text,execution_key) VALUES (?,?,?)')
        .run(id, text.trim(), executionKey)
      this.recordSubmission(submission)
      return id
    })
  }

  discardQueuedMessage(id: string) {
    return this.commandTransaction(() => {
      if (this.database.prepare('SELECT id FROM assistant_queue_discard WHERE id=?').get(id)) return true
      if (!this.removeQueuedMessage(id)) return false
      this.commandChanged(this.database.prepare('INSERT INTO assistant_queue_discard(id) VALUES (?)').run(id))
      return true
    })
  }

  private removeQueuedMessage(id: string) {
    return this.database.prepare('DELETE FROM assistant_queued_message WHERE id=?').run(id).changes === 1
  }

  startCommand(
    text: string,
    computer: RemoteAgentComputer,
    proactive = false,
    targetLabel = 'Mini',
    queuedId?: string,
    submission?: SendAssistantMessageInput
  ) {
    const input = commandInput(text, computer, targetLabel)
    return this.commandTransaction(() => {
      this.initiatives.assertCommandSlotAvailable()
      if (queuedId) {
        const queued = this.queuedMessages().find((entry) => entry.id === queuedId)
        if (!queued || queued.text !== input.instruction || queued.executionKey !== input.executionKey)
          throw new Error('assistant-queue-mismatch')
        if (!this.removeQueuedMessage(queuedId)) throw new Error('assistant-queue-missing')
      }
      const now = this.commandTime(),
        id = randomUUID(),
        userMessageId = queuedId ?? submission?.clientMessageId ?? randomUUID()
      const command: ResidentCommand = {
        messageId: id,
        userMessageId,
        instructionHash: input.instructionHash,
        computer: input.computer,
        executionKey: input.executionKey,
        targetLabel: input.targetLabel,
        state: 'reserved',
        stopRequested: false,
        contextInvalidated: false,
        checkpoint: null,
        settled: false,
        createdAt: now,
        updatedAt: now,
      }
      if (proactive) this.advanceProactiveGeneration()
      this.commandChanged(
        this.database
          .prepare(
            "INSERT INTO assistant_message (id,role,text,provider,created_at,updated_at,status) VALUES (?,'user',?,'codex',?,?,'completed')"
          )
          .run(userMessageId, input.instruction, now, now)
      )
      this.commandChanged(
        this.database
          .prepare(
            "INSERT INTO assistant_message (id,role,text,provider,created_at,updated_at,status,reply_to,error) VALUES (?,'assistant','','codex',?,?,'interrupted',?,'assistant-command-not-submitted')"
          )
          .run(id, now, now, userMessageId)
      )
      this.commandChanged(
        this.database
          .prepare('INSERT INTO assistant_command (message_id,user_message_id,state,value_json) VALUES (?,?,?,?)')
          .run(id, userMessageId, command.state, canonicalHostTaskJson(command))
      )
      this.recordSubmission(submission)
      return { id, provider: 'codex' as const, instruction: input.instruction, command }
    })
  }

  markCommandDispatch(messageId: string) {
    return this.commandTransaction(() => {
      const command = this.requireCommand(messageId)
      if (command.contextInvalidated) throw new Error('assistant-command-context-invalidated')
      if (command.stopRequested) throw new Error('assistant-command-stop-requested')
      if (command.state !== 'reserved') throw new Error('assistant-command-dispatch-already-intended')
      const value: ResidentCommand = { ...command, state: 'dispatching', updatedAt: this.commandTime(command) }
      this.writeCommand(value)
      this.writeCommandMessage(messageId, { text: '', steps: [], status: 'streaming' }, value.updatedAt)
      return value
    })
  }

  recordCommandCheckpoint(messageId: string, checkpoint: ResidentRemoteRun | null) {
    return this.commandTransaction(() => {
      const command = this.requireCommand(messageId)
      if (commandTerminal(command)) throw new Error('assistant-command-terminal')
      if (command.state === 'reserved') throw new Error('assistant-command-checkpoint-before-dispatch')
      if (checkpoint === null && !command.checkpoint) throw new Error('assistant-command-checkpoint-missing')
      const next = checkpoint === null ? command.checkpoint : commandCheckpoint(command, checkpoint)
      if (
        command.settled &&
        checkpoint !== null &&
        canonicalHostTaskJson(next) !== canonicalHostTaskJson(command.checkpoint)
      )
        throw new Error('assistant-command-checkpoint-settled')
      const legacy = this.remoteRun()
      if (legacy && legacy.messageId !== messageId) throw new Error('assistant-command-effect-slot-occupied')
      const value: ResidentCommand = {
        ...command,
        checkpoint: next,
        settled: checkpoint === null || command.settled,
        state: command.state === 'unknown' ? 'unknown' : 'running',
        updatedAt: this.commandTime(command),
      }
      this.writeCommand(value)
      this.commandChanged(
        this.database
          .prepare(`INSERT INTO assistant_remote_run (id,checkpoint) VALUES (1,?)
        ON CONFLICT(id) DO UPDATE SET checkpoint=excluded.checkpoint`)
          .run(canonicalHostTaskJson(next))
      )
      return value
    })
  }

  updateCommand(messageId: string, input: ResidentCommandPatch) {
    const patch = commandPatch(input)
    if (patch.status !== 'streaming') throw new Error('assistant-command-patch-invalid')
    this.commandTransaction(() => {
      const command = this.requireCommand(messageId)
      if (command.contextInvalidated) throw new Error('assistant-command-context-invalidated')
      if (command.stopRequested) throw new Error('assistant-command-stop-requested')
      if (!['dispatching', 'running'].includes(command.state)) throw new Error('assistant-command-not-running')
      const at = this.commandTime(command)
      this.writeCommand({ ...command, updatedAt: at })
      this.writeCommandMessage(messageId, patch, at)
    })
  }

  requestCommandStop(messageId: string) {
    return this.commandTransaction(() => {
      const command = this.requireCommand(messageId)
      if (commandTerminal(command) || command.stopRequested) return command
      const value = { ...command, stopRequested: true, updatedAt: this.commandTime(command) }
      this.writeCommand(value)
      return value
    })
  }

  finishCommand(messageId: string, input: ResidentCommandPatch, confirmation: ResidentCommandConfirmation) {
    const patch = commandPatch(input)
    if (!['completed', 'stopped', 'unsubmitted', 'unknown'].includes(confirmation))
      throw new Error('assistant-command-confirmation-invalid')
    const terminalJson = canonicalHostTaskJson({ patch, confirmation })
    return this.commandTransaction(() => {
      const command = this.requireCommand(messageId)
      const previous = this.database
        .prepare('SELECT terminal_json FROM assistant_command WHERE message_id=?')
        .get(messageId)
      if (!previous) throw new Error('assistant-command-missing')
      if (commandTerminal(command)) {
        if (previous.terminal_json !== terminalJson) throw new Error('assistant-command-terminal-conflict')
        return command
      }
      if (confirmation === 'unsubmitted' && command.state !== 'reserved')
        throw new Error('assistant-command-dispatch-already-intended')
      if ((confirmation === 'completed' || confirmation === 'stopped') && (!command.checkpoint || !command.settled))
        throw new Error('assistant-command-terminal-unconfirmed')
      if (confirmation === 'completed' && (!command.checkpoint?.turnId || patch.status !== 'completed'))
        throw new Error('assistant-command-terminal-unconfirmed')
      if ((confirmation === 'stopped' || confirmation === 'unsubmitted') && patch.status !== 'cancelled')
        throw new Error('assistant-command-patch-invalid')
      if (confirmation === 'unknown' && !['interrupted', 'failed'].includes(patch.status))
        throw new Error('assistant-command-patch-invalid')
      if (command.contextInvalidated && (patch.text || patch.steps.length || confirmation === 'completed'))
        throw new Error('assistant-command-context-invalidated')
      const state: ResidentCommand['state'] = confirmation === 'unsubmitted' ? 'cancelled' : confirmation
      const value = { ...command, state, updatedAt: this.commandTime(command) }
      this.writeCommand(value)
      this.writeCommandMessage(messageId, patch, value.updatedAt)
      if (confirmation !== 'unknown') {
        this.commandChanged(
          this.database
            .prepare('UPDATE assistant_command SET terminal_json=? WHERE message_id=?')
            .run(terminalJson, messageId)
        )
        const legacy = this.remoteRun()
        if (legacy?.messageId === messageId)
          this.commandChanged(
            this.database
              .prepare("DELETE FROM assistant_remote_run WHERE id=1 AND json_extract(checkpoint,'$.messageId')=?")
              .run(messageId)
          )
        else if (command.checkpoint) throw new Error('assistant-command-checkpoint-conflict')
      }
      return value
    })
  }

  start(
    text: string,
    provider: AgentProvider,
    retryOf?: string,
    proactive = false,
    submission?: SendAssistantMessageInput
  ) {
    const previous = retryOf ? this.get(retryOf) : null
    if (
      retryOf &&
      (previous?.role !== 'assistant' ||
        this.database.prepare('SELECT action_id FROM assistant_task_run WHERE assistant_message_id = ?').get(retryOf) ||
        this.initiatives.ownsMessage(retryOf) ||
        this.database.prepare('SELECT 1 FROM assistant_command WHERE message_id=?').get(retryOf) ||
        previous.error?.startsWith('assistant-remote-retired') ||
        previous.error === 'assistant-host-request-expired' ||
        previous.error === 'assistant-host-context-invalidated' ||
        !['failed', 'cancelled', 'interrupted'].includes(previous.status))
    ) {
      throw new Error('assistant-message-not-retryable')
    }
    const user = previous?.replyTo ? this.get(previous.replyTo) : null
    if (retryOf && !user) throw new Error('assistant-message-not-found')
    const now = Date.now()
    const userId = user?.id ?? submission?.clientMessageId ?? randomUUID()
    const replyId = randomUUID()
    const instruction = user?.text ?? text
    const selectedProvider = previous?.provider ?? provider
    this.database.exec('BEGIN IMMEDIATE')
    try {
      if (proactive) this.advanceProactiveGeneration()
      if (!user)
        this.database
          .prepare(
            "INSERT INTO assistant_message (id, role, text, provider, created_at, updated_at, status) VALUES (?, 'user', ?, ?, ?, ?, 'completed')"
          )
          .run(userId, instruction, selectedProvider, now, now)
      this.database
        .prepare(
          "INSERT INTO assistant_message (id, role, text, provider, created_at, updated_at, status, reply_to) VALUES (?, 'assistant', '', ?, ?, ?, 'streaming', ?)"
        )
        .run(replyId, selectedProvider, now, now, userId)
      this.recordSubmission(submission)
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    return { id: replyId, instruction, provider: selectedProvider }
  }

  update(id: string, patch: MessagePatch, clearRemoteRun = false) {
    this.assertNotPreparedMessage(id)
    if (this.database.prepare('SELECT 1 FROM assistant_proactive_initiative WHERE message_id = ?').get(id))
      throw new Error('proactive-initiative-immutable')
    if (clearRemoteRun) this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database
        .prepare(
          'UPDATE assistant_message SET text = ?, steps_json = ?, status = ?, error = ?, updated_at = ? WHERE id = ?'
        )
        .run(patch.text, JSON.stringify(patch.steps), patch.status, patch.error ?? null, Date.now(), id)
      if (clearRemoteRun) {
        this.setRemoteRun(null)
        this.database.exec('COMMIT')
      }
    } catch (error) {
      if (clearRemoteRun) this.database.exec('ROLLBACK')
      throw error
    }
  }

  isConversationHistoryMessage(id: string, userId: string) {
    return Boolean(
      this.database
        .prepare(`SELECT 1 FROM assistant_message m
      WHERE m.id=? AND m.sequence < (SELECT sequence FROM assistant_message WHERE id=?)
      AND m.sequence > COALESCE((SELECT value FROM assistant_state WHERE key='context-reset'),0)`)
        .get(id, userId)
    )
  }

  history(
    includeCommands = false,
    options: { limit?: number; before?: string; through?: string; messageId?: string; excludeId?: string } = {}
  ) {
    const limit = options.limit ?? 8
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('assistant-history-limit-invalid')
    if (options.before && !this.get(options.before)) throw new Error('assistant-history-cursor-invalid')
    const rows = this.database
      .prepare(`SELECT * FROM assistant_message
      WHERE sequence > COALESCE((SELECT value FROM assistant_state WHERE key = 'context-reset'), 0)
      AND (? IS NULL OR sequence < (SELECT sequence FROM assistant_message WHERE id = ?))
      AND (? IS NULL OR sequence < (SELECT sequence FROM assistant_message WHERE id = ?))
      AND (? IS NULL OR id = ?)
      AND (? IS NULL OR id <> ?)
      AND NOT EXISTS (SELECT 1 FROM assistant_task_suggestion WHERE message_id = assistant_message.id)
      AND NOT EXISTS (SELECT 1 FROM assistant_task_run
        WHERE user_message_id = assistant_message.id OR assistant_message_id = assistant_message.id)
      AND NOT EXISTS (SELECT 1 FROM assistant_initiative_action WHERE assistant_message_id = assistant_message.id)
      AND NOT EXISTS (SELECT 1 FROM assistant_retired_remote_run AS retired
        LEFT JOIN assistant_message AS original ON original.id=retired.message_id
        WHERE retired.message_id=assistant_message.id OR original.reply_to=assistant_message.id)
      AND NOT EXISTS (SELECT 1 FROM assistant_host_run AS retired
        LEFT JOIN assistant_message AS original ON original.id=retired.message_id
        WHERE retired.retired_at IS NOT NULL
        AND (retired.message_id=assistant_message.id OR original.reply_to=assistant_message.id))
      AND NOT EXISTS (SELECT 1 FROM assistant_message AS failed_remote
        WHERE failed_remote.error GLOB 'codex-remote-*'
        AND failed_remote.status IN ('failed','cancelled','interrupted')
        AND (failed_remote.id=assistant_message.id OR failed_remote.reply_to=assistant_message.id))
      AND (? = 1 OR NOT EXISTS (SELECT 1 FROM assistant_command WHERE message_id = assistant_message.id OR user_message_id = assistant_message.id))
      ORDER BY sequence DESC LIMIT ?`)
      .all(
        options.before ?? null,
        options.before ?? null,
        options.through ?? null,
        options.through ?? null,
        options.messageId ?? null,
        options.messageId ?? null,
        options.excludeId ?? null,
        options.excludeId ?? null,
        Number(includeCommands),
        limit
      ) as Row[]
    return rows.reverse().map((row) => message(row))
  }

  synchronizePolicy(fingerprint: string) {
    const previous = this.database.prepare('SELECT fingerprint FROM assistant_policy WHERE id = 1').get()
    if (previous?.fingerprint === fingerprint) return false
    if (previous) this.resetContext()
    this.database
      .prepare(
        'INSERT INTO assistant_policy (id, fingerprint) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET fingerprint = excluded.fingerprint'
      )
      .run(fingerprint)
    return Boolean(previous)
  }

  resetContext() {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.initiatives.invalidateAllWithinTransaction(this.now())
      for (const command of this.unresolvedCommands()) {
        this.writeCommand({
          ...command,
          contextInvalidated: true,
          checkpoint: command.checkpoint ? { ...command.checkpoint, contextInvalidated: true } : null,
          updatedAt: this.commandTime(command),
        })
      }
      this.advanceProactiveGeneration()
      this.database.exec(`
      DELETE FROM assistant_thread;
      DELETE FROM assistant_memory_source;
      UPDATE assistant_task_run SET invalidated = 1 WHERE retired_at IS NULL AND (outcome_json IS NULL
        OR action_id IN (SELECT action_id FROM assistant_task_execution));
      UPDATE assistant_remote_run SET checkpoint = json_set(checkpoint, '$.contextInvalidated', json('true'));
      UPDATE assistant_host_run SET binding = json_set(
        CASE WHEN json_extract(binding, '$.phase') NOT IN ('completed', 'stopped')
          AND COALESCE(json_extract(binding, '$.stopReason'), '') != 'request-expired'
          THEN json_set(binding, '$.stopReason', 'context-invalidated') ELSE binding END,
        '$.contextInvalidated', json('true')) WHERE retired_at IS NULL;
      INSERT INTO assistant_state (key, value) VALUES ('context-reset', (SELECT COALESCE(MAX(sequence), 0) FROM assistant_message))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;`)
      if (
        this.database
          .prepare(`SELECT task.action_id FROM assistant_task_run AS task
        JOIN assistant_task_execution AS execution ON execution.action_id = task.action_id
        WHERE task.retired_at IS NULL AND task.invalidated != 1 LIMIT 1`)
          .get()
      )
        throw new Error('host-task-write-not-persisted')
      const remote = this.remoteRun()
      if (
        this.unresolvedCommands().some(
          (command) =>
            command.checkpoint &&
            (!remote || canonicalHostTaskJson(remote) !== canonicalHostTaskJson(command.checkpoint))
        )
      )
        throw new Error('assistant-command-write-not-persisted')
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  thread(provider: AgentProvider) {
    const row = this.database.prepare('SELECT thread_id FROM assistant_thread WHERE provider = ?').get(provider)
    return row ? String(row.thread_id) : null
  }

  setThread(provider: AgentProvider, threadId: string) {
    if (!threadId.trim() || threadId.length > 200) throw new Error('invalid-agent-thread-id')
    this.database
      .prepare(
        'INSERT INTO assistant_thread (provider, thread_id) VALUES (?, ?) ON CONFLICT(provider) DO UPDATE SET thread_id = excluded.thread_id'
      )
      .run(provider, threadId)
  }
}
