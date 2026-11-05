import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { setImmediate } from 'node:timers/promises'
import type {
  CallSignal,
  ConversationEpisode,
  ConversationSummary,
  DailyReviewAppActivity,
  DailyReviewContextMoment,
  DailyReviewMoment,
  DailyReviewSession,
  DayMemory,
  DayRefresh,
  DayTaskRecord,
  ManualMeeting,
  PersistedEpisodeAnalysis,
  SpeechSegment,
  WorkItem,
  WorkItemAgentSession,
  WorkItemFact,
  WorkItemLifecycle,
  WorkItemObservation,
  WorkItemPriority,
  WorkItemSource,
  WorkItemStatus,
} from '@remember/shared'
import {
  conversationActionPointItems,
  conversationReference,
  isMacosSystemActivity,
  parseInboxResult,
  resolveConversationReference,
} from '@remember/shared'
import {
  type HostTaskEnvelopeV1,
  type HostTaskOutcome,
  type HostTaskOutcomeReceipt,
  type HostTaskSessionReceipt,
  hostTaskDefinition,
  hostTaskDefinitionHash,
  hostTaskSessionReceipt,
  validateHostTaskEnvelope,
  validateHostTaskOutcome,
} from '../hostTaskProtocol'
import { type AmbientEvidenceRef, AmbientTaskStore } from './ambientTaskStore'
import type { AnalysisEvidenceEntry } from './analysisContext'
import { localDayKey, sessionLocalDay } from './dayLifecycle'
import { type ProactiveCommit, ProactiveStore } from './proactiveStore'
import { prepareWorkdayMemory, pruneWorkdayProvenance, readWorkdayMemory } from './workdayMemory'
import type { AnalyzedWorkItemPlan } from './workItemAnalysis'

const SCHEMA_VERSION = 18

type DatabaseRow = Record<string, SQLInputValue>

function contextMomentFromRow(row: DatabaseRow): DailyReviewContextMoment {
  return {
    id: stringValue(row.id),
    timestamp: numberValue(row.timestamp),
    appName: stringValue(row.display_name),
    bundleId: stringValue(row.bundle_id),
    windowTitle: stringValue(row.window_title),
    url: stringValue(row.url) || undefined,
    ...focusedElementFromRow(row),
    text: stringValue(row.text),
    textSource: stringValue(row.text_source) as DailyReviewContextMoment['textSource'],
    trigger: stringValue(row.trigger),
    monitorName: stringValue(row.monitor_name),
    screenshotPath: '',
  }
}

function numberValue(value: SQLInputValue) {
  return typeof value === 'number' ? value : Number(value)
}

function nullableNumber(value: SQLInputValue) {
  return value == null ? null : numberValue(value)
}

function stringValue(value: SQLInputValue) {
  return typeof value === 'string' ? value : String(value ?? '')
}

function normalizedWorkItemIdentity(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
}

function analyzedWorkItemId(parts: string[]) {
  return `wi_${createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 24)}`
}

function analyzedSourceId(itemId: string, parts: string[]) {
  return `${itemId}:source:${createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 20)}`
}

function dayTaskRecords(memory: DayMemory, fallbackTimestamp: number): DayTaskRecord[] {
  const records = [...(memory.taskRecords ?? [])]
  const recordedIds = new Set(records.map((record) => record.task.id ?? record.id))
  for (const task of memory.openTasks ?? []) {
    const legacyId = task.id ?? `open-${createHash('sha256').update(task.title).digest('hex').slice(0, 16)}`
    if (recordedIds.has(legacyId)) continue
    const timestamp = memory.refreshedAt || fallbackTimestamp
    records.push({
      id: legacyId,
      task,
      state: task.completed ? 'completed' : 'open',
      createdAt: timestamp,
      updatedAt: timestamp,
      events: [],
    })
  }
  return records
}

function focusedElementFromRow(
  row: DatabaseRow
): Pick<DailyReviewContextMoment, 'focusedElement'> | Record<string, never> {
  if (typeof row.focused_element_json !== 'string' || !row.focused_element_json) return {}
  try {
    const parsed = JSON.parse(row.focused_element_json) as DailyReviewContextMoment['focusedElement']
    return parsed && typeof parsed.role === 'string' ? { focusedElement: parsed } : {}
  } catch {
    return {}
  }
}

function focusedElementText(moment: Pick<DailyReviewContextMoment, 'focusedElement'>) {
  const focused = moment.focusedElement
  return focused ? [focused.role, focused.title, focused.description, focused.value].filter(Boolean).join(' ') : ''
}

function ftsMatchQuery(query: string) {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(' AND ')
}

function mediaPlaybackFromRow(row: DatabaseRow): Pick<DailyReviewMoment, 'mediaPlayback'> | Record<string, never> {
  try {
    const parsed = JSON.parse(stringValue(row.media_playback_json)) as Partial<
      NonNullable<DailyReviewMoment['mediaPlayback']>
    >
    if (
      typeof parsed.isPlaying !== 'boolean' ||
      typeof parsed.bundleIdentifier !== 'string' ||
      typeof parsed.applicationName !== 'string'
    ) {
      return {}
    }
    return {
      mediaPlayback: {
        isPlaying: parsed.isPlaying,
        bundleIdentifier: parsed.bundleIdentifier,
        applicationName: parsed.applicationName,
      },
    }
  } catch {
    return {}
  }
}

function isNonWorkApplication(displayName: string, bundleId: string) {
  return isMacosSystemActivity({ appName: displayName, bundleId })
}

function transaction(database: DatabaseSync, operation: () => void) {
  database.exec('BEGIN IMMEDIATE')
  try {
    operation()
    database.exec('COMMIT')
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // SQLite can end a failed transaction itself. Preserve the initiating error.
    }
    throw error
  }
}

function createSchema(database: DatabaseSync) {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS workday (
      id TEXT PRIMARY KEY,
      local_day TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      active_duration_ms INTEGER NOT NULL DEFAULT 0,
      memory_json TEXT,
      memory_refreshed_at INTEGER,
      memory_covered_through INTEGER,
      refresh_status TEXT NOT NULL DEFAULT 'idle',
      refresh_reason TEXT,
      refresh_target_through INTEGER,
      refresh_error TEXT,
      refresh_progress_json TEXT,
      refresh_run_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS application (
      id INTEGER PRIMARY KEY,
      bundle_id TEXT NOT NULL DEFAULT '',
      display_name TEXT NOT NULL,
      UNIQUE(bundle_id, display_name)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS focus_segment (
      id TEXT PRIMARY KEY,
      workday_id TEXT NOT NULL REFERENCES workday(id) ON DELETE CASCADE,
      application_id INTEGER NOT NULL REFERENCES application(id),
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    ) STRICT;
    CREATE INDEX IF NOT EXISTS focus_segment_workday_time
      ON focus_segment(workday_id, started_at, ended_at);

    CREATE TABLE IF NOT EXISTS context_evidence (
      id TEXT PRIMARY KEY,
      workday_id TEXT NOT NULL REFERENCES workday(id) ON DELETE CASCADE,
      application_id INTEGER NOT NULL REFERENCES application(id),
      focus_segment_id TEXT REFERENCES focus_segment(id) ON DELETE SET NULL,
      timestamp INTEGER NOT NULL,
      window_title TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      focused_element_json TEXT,
      text TEXT NOT NULL DEFAULT '',
      text_source TEXT NOT NULL CHECK(text_source IN ('accessibility', 'ocr')),
      trigger TEXT NOT NULL DEFAULT '',
      monitor_name TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL,
      UNIQUE(workday_id, content_hash)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS context_evidence_workday_time_id
      ON context_evidence(workday_id, timestamp, id, application_id);
    DROP INDEX IF EXISTS context_evidence_workday_time;

    CREATE TABLE IF NOT EXISTS audio_evidence (
      id TEXT PRIMARY KEY,
      workday_id TEXT NOT NULL REFERENCES workday(id) ON DELETE CASCADE,
      source TEXT NOT NULL CHECK(source IN ('microphone', 'system')),
      started_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      average_level REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('transcribing', 'ready', 'empty', 'failed')),
      transcript TEXT NOT NULL DEFAULT '',
      media_playback_json TEXT,
      capture_epoch_id TEXT,
      capture_sequence INTEGER,
      captured_sample_count INTEGER,
      capture_sample_time REAL,
      capture_outcome TEXT NOT NULL DEFAULT 'pending' CHECK(capture_outcome IN (
        'pending', 'transcribed', 'vad-empty', 'asr-empty', 'quarantined', 'music-gated', 'too-short', 'failed'
      ))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS audio_evidence_workday_time
      ON audio_evidence(workday_id, started_at);

    CREATE TABLE IF NOT EXISTS speech_segment (
      id TEXT PRIMARY KEY,
      workday_id TEXT NOT NULL REFERENCES workday(id) ON DELETE CASCADE,
      chunk_id TEXT NOT NULL REFERENCES audio_evidence(id) ON DELETE CASCADE,
      chunk_ids_json TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL CHECK(source IN ('microphone', 'system')),
      started_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL,
      vad_started_at INTEGER,
      vad_ended_at INTEGER,
      asr_window_index INTEGER NOT NULL DEFAULT 0,
      asr_window_count INTEGER NOT NULL DEFAULT 1,
      transcription_outcome TEXT NOT NULL DEFAULT 'transcribed' CHECK(transcription_outcome IN (
        'transcribed', 'asr-empty'
      )),
      text TEXT NOT NULL,
      detected_language TEXT,
      accepted_language TEXT CHECK(accepted_language IS NULL OR accepted_language IN ('nl', 'en')),
      rejection_reason TEXT CHECK(rejection_reason IS NULL OR rejection_reason IN (
        'unsupported-language', 'cross-language-short', 'cross-language-unconfirmed', 'likely-hallucination'
      )),
      CHECK(ended_at >= started_at)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS speech_segment_workday_time
      ON speech_segment(workday_id, started_at, ended_at);

    CREATE TABLE IF NOT EXISTS call_signal (
      id TEXT PRIMARY KEY,
      workday_id TEXT NOT NULL REFERENCES workday(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      surface_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('active', 'ended')),
      observed_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS call_signal_workday_time
      ON call_signal(workday_id, observed_at);

    CREATE TABLE IF NOT EXISTS manual_meeting (
      id TEXT PRIMARY KEY,
      workday_id TEXT NOT NULL REFERENCES workday(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      episode_id TEXT,
      started_at INTEGER NOT NULL,
      confirmed_at INTEGER NOT NULL,
      available_from_at INTEGER NOT NULL,
      ended_at INTEGER,
      paused_at INTEGER,
      paused_ms INTEGER NOT NULL DEFAULT 0,
      automatic_revinote_processing_blocked INTEGER NOT NULL DEFAULT 0
        CHECK(automatic_revinote_processing_blocked IN (0, 1)),
      system_audio_available INTEGER NOT NULL DEFAULT 1
        CHECK(system_audio_available IN (0, 1)),
      status TEXT NOT NULL CHECK(status IN ('recording', 'processing', 'completed'))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS manual_meeting_workday_time
      ON manual_meeting(workday_id, started_at, ended_at);

    CREATE TABLE IF NOT EXISTS offline_period (
      id TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      CHECK(ended_at IS NULL OR ended_at >= started_at)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS offline_period_time
      ON offline_period(started_at, ended_at);

    CREATE TABLE IF NOT EXISTS conversation_episode (
      id TEXT PRIMARY KEY,
      workday_id TEXT NOT NULL REFERENCES workday(id) ON DELETE CASCADE,
      started_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('provisional', 'final')),
      surface_key TEXT,
      provider TEXT,
      boundary_reason TEXT NOT NULL CHECK(boundary_reason IN (
        'open', 'call-surface-changed', 'call-ended', 'speech-gap', 'capture-paused', 'day-ended', 'manual-merge'
      )),
      segment_ids_json TEXT NOT NULL DEFAULT '[]',
      deleted_at INTEGER,
      automatic_revinote_processing_blocked INTEGER NOT NULL DEFAULT 0
        CHECK(automatic_revinote_processing_blocked IN (0, 1)),
      CHECK(ended_at >= started_at)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS conversation_episode_workday_time
      ON conversation_episode(workday_id, started_at, ended_at);

    CREATE TABLE IF NOT EXISTS conversation_episode_decision (
      episode_id TEXT PRIMARY KEY REFERENCES conversation_episode(id) ON DELETE CASCADE,
      decision TEXT NOT NULL CHECK(decision IN ('confirmed', 'dismissed')),
      decided_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS episode_analysis (
      id TEXT PRIMARY KEY,
      episode_id TEXT NOT NULL REFERENCES conversation_episode(id) ON DELETE CASCADE,
      workday_id TEXT NOT NULL REFERENCES workday(id) ON DELETE CASCADE,
      started_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL,
      classification TEXT NOT NULL CHECK(classification IN ('conversation', 'media', 'insufficient')),
      confidence TEXT NOT NULL CHECK(confidence IN ('high', 'medium', 'low')),
      reason TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      action_points_json TEXT NOT NULL DEFAULT '[]',
      source_hash TEXT NOT NULL,
      provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude')),
      model TEXT NOT NULL,
      prompt_version INTEGER NOT NULL,
      schema_version INTEGER NOT NULL,
      generated_at INTEGER NOT NULL,
      UNIQUE(episode_id, source_hash, provider, model, prompt_version, schema_version)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS episode_analysis_workday_time
      ON episode_analysis(workday_id, started_at, ended_at);

    CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(
      kind UNINDEXED,
      evidence_id UNINDEXED,
      workday_id UNINDEXED,
      application,
      window_title,
      text,
      tokenize = 'porter unicode61 remove_diacritics 2'
    );

    CREATE TABLE IF NOT EXISTS artifact (
      id TEXT PRIMARY KEY,
      workday_id TEXT REFERENCES workday(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      generated_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS artifact_source (
      artifact_id TEXT NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
      evidence_kind TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      PRIMARY KEY(artifact_id, evidence_kind, evidence_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS work_item (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL DEFAULT '',
      context TEXT NOT NULL DEFAULT '',
      return_last_move TEXT NOT NULL DEFAULT '',
      return_unresolved TEXT NOT NULL DEFAULT '',
      return_next_move TEXT NOT NULL DEFAULT '',
      lifecycle TEXT NOT NULL CHECK(lifecycle IN ('open', 'completed', 'abandoned', 'superseded')),
      status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo', 'in_progress')),
      priority TEXT NOT NULL DEFAULT 'none' CHECK(priority IN ('none', 'low', 'medium', 'high', 'urgent')),
      due_at INTEGER,
      attention TEXT NOT NULL CHECK(attention IN ('idle', 'user_active', 'agent_running', 'waiting_on_user')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      closed_at INTEGER,
      user_edited_title INTEGER NOT NULL DEFAULT 0 CHECK(user_edited_title IN (0, 1)),
      user_edited_description INTEGER NOT NULL DEFAULT 0 CHECK(user_edited_description IN (0, 1)),
      day_synced_at INTEGER NOT NULL DEFAULT 0,
      lifecycle_updated_at INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE INDEX IF NOT EXISTS work_item_lifecycle_updated
      ON work_item(lifecycle, updated_at DESC);

    CREATE TABLE IF NOT EXISTS work_item_source (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL REFERENCES work_item(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('manual', 'meeting', 'observed', 'legacy')),
      label TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      workday_id TEXT,
      conversation_reference TEXT,
      conversation_action_id TEXT,
      conversation_start_time TEXT,
      observed_at INTEGER NOT NULL,
      confidence REAL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS work_item_source_item ON work_item_source(work_item_id, observed_at);
    CREATE TABLE IF NOT EXISTS work_item_fact (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL REFERENCES work_item(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('created', 'edited', 'completed', 'reopened', 'abandoned', 'superseded', 'agent_started', 'agent_completed', 'agent_failed')),
      actor TEXT NOT NULL CHECK(actor IN ('user', 'agent', 'system')),
      summary TEXT NOT NULL,
      at INTEGER NOT NULL,
      agent_session_id TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS work_item_fact_item ON work_item_fact(work_item_id, at);

    CREATE TABLE IF NOT EXISTS work_item_observation (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL REFERENCES work_item(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('progress', 'blocked', 'completion_candidate')),
      summary TEXT NOT NULL,
      confidence REAL NOT NULL,
      workday_id TEXT,
      observed_at INTEGER NOT NULL,
      dismissed_at INTEGER,
      dedupe_key TEXT UNIQUE
    ) STRICT;
    CREATE INDEX IF NOT EXISTS work_item_observation_item ON work_item_observation(work_item_id, observed_at);

    CREATE TABLE IF NOT EXISTS work_item_agent_session (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL REFERENCES work_item(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude')),
      status TEXT NOT NULL CHECK(status IN ('running', 'waiting_on_user', 'completed', 'failed', 'cancelled', 'stale')),
      instruction TEXT NOT NULL,
      message TEXT NOT NULL,
      response TEXT NOT NULL DEFAULT '',
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      duration_ms INTEGER,
      steps_json TEXT NOT NULL DEFAULT '[]'
    ) STRICT;
    CREATE INDEX IF NOT EXISTS work_item_agent_session_item
      ON work_item_agent_session(work_item_id, started_at);

    CREATE TABLE IF NOT EXISTS work_item_host_receipt (
      action_id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      session_id TEXT NOT NULL UNIQUE,
      job_id TEXT NOT NULL UNIQUE,
      user_message_id TEXT NOT NULL UNIQUE,
      assistant_message_id TEXT NOT NULL UNIQUE,
      envelope_hash TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      outcome_hash TEXT,
      outcome_json TEXT,
      outcome_projection TEXT CHECK(outcome_projection IN ('applied', 'orphaned'))
    ) STRICT;

    CREATE TABLE IF NOT EXISTS legacy_work_item_import (
      workday_id TEXT NOT NULL,
      legacy_record_id TEXT NOT NULL,
      work_item_id TEXT NOT NULL REFERENCES work_item(id) ON DELETE CASCADE,
      PRIMARY KEY(workday_id, legacy_record_id)
    ) STRICT;

    DROP TABLE IF EXISTS conversation_summary;
    DROP TABLE IF EXISTS conversation_analysis;
    PRAGMA user_version = ${SCHEMA_VERSION};
  `)
}

function ensureLocalDayInvariant(database: DatabaseSync) {
  const columns = database.prepare('PRAGMA table_info(workday)').all() as DatabaseRow[]
  if (!columns.some((column) => stringValue(column.name) === 'local_day')) {
    database.exec('ALTER TABLE workday ADD COLUMN local_day TEXT')
  }

  const rows = database
    .prepare("SELECT id, started_at FROM workday WHERE local_day IS NULL OR local_day = ''")
    .all() as DatabaseRow[]
  if (rows.length > 0) {
    database.exec('DROP INDEX IF EXISTS workday_local_day')
    const updateLocalDay = database.prepare('UPDATE workday SET local_day = ? WHERE id = ?')
    for (const row of rows) updateLocalDay.run(localDayKey(numberValue(row.started_at)), stringValue(row.id))
  }

  const duplicateDays = database
    .prepare('SELECT local_day FROM workday GROUP BY local_day HAVING COUNT(*) > 1')
    .all() as DatabaseRow[]
  let consolidated = false
  for (const duplicateDay of duplicateDays) {
    const localDay = stringValue(duplicateDay.local_day)
    const workdays = database
      .prepare(
        `SELECT id, started_at, ended_at, active_duration_ms, memory_refreshed_at, created_at, updated_at
         FROM workday WHERE local_day = ?
         ORDER BY COALESCE(memory_refreshed_at, 0) DESC, updated_at DESC`
      )
      .all(localDay) as DatabaseRow[]
    const canonical = workdays[0]
    if (!canonical) continue
    const canonicalId = stringValue(canonical.id)

    transaction(database, () => {
      for (const duplicate of workdays.slice(1)) {
        const duplicateId = stringValue(duplicate.id)
        database
          .prepare(
            `DELETE FROM context_evidence
             WHERE workday_id = ? AND content_hash IN (
               SELECT content_hash FROM context_evidence WHERE workday_id = ?
             )`
          )
          .run(duplicateId, canonicalId)
        database.prepare('UPDATE focus_segment SET workday_id = ? WHERE workday_id = ?').run(canonicalId, duplicateId)
        database
          .prepare('UPDATE context_evidence SET workday_id = ? WHERE workday_id = ?')
          .run(canonicalId, duplicateId)
        database.prepare('UPDATE audio_evidence SET workday_id = ? WHERE workday_id = ?').run(canonicalId, duplicateId)
        database.prepare('UPDATE speech_segment SET workday_id = ? WHERE workday_id = ?').run(canonicalId, duplicateId)
        database.prepare('UPDATE call_signal SET workday_id = ? WHERE workday_id = ?').run(canonicalId, duplicateId)
        database.prepare('UPDATE manual_meeting SET workday_id = ? WHERE workday_id = ?').run(canonicalId, duplicateId)
        database
          .prepare('UPDATE conversation_episode SET workday_id = ? WHERE workday_id = ?')
          .run(canonicalId, duplicateId)
        database
          .prepare('UPDATE episode_analysis SET workday_id = ? WHERE workday_id = ?')
          .run(canonicalId, duplicateId)
        database.prepare('UPDATE artifact SET workday_id = ? WHERE workday_id = ?').run(canonicalId, duplicateId)
        database.prepare('DELETE FROM workday WHERE id = ?').run(duplicateId)
      }

      const startedAt = Math.min(...workdays.map((row) => numberValue(row.started_at)))
      const endedValues = workdays.map((row) => nullableNumber(row.ended_at))
      const endedAt = endedValues.some((value) => value == null)
        ? null
        : Math.max(...endedValues.filter((value): value is number => value != null))
      const activeDurationMs = Math.max(...workdays.map((row) => numberValue(row.active_duration_ms)))
      const createdAt = Math.min(...workdays.map((row) => numberValue(row.created_at)))
      const updatedAt = Math.max(...workdays.map((row) => numberValue(row.updated_at)))
      database
        .prepare(
          `UPDATE workday
           SET started_at = ?, ended_at = ?, active_duration_ms = ?, created_at = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(startedAt, endedAt, activeDurationMs, createdAt, updatedAt, canonicalId)
    })
    consolidated = true
  }

  if (consolidated) {
    database.exec(`
      DELETE FROM evidence_fts;
      INSERT INTO evidence_fts (kind, evidence_id, workday_id, application, window_title, text)
      SELECT 'context', c.id, c.workday_id, a.display_name, c.window_title,
             trim(c.url || char(10) || coalesce(c.focused_element_json, '') || char(10) || c.text)
      FROM context_evidence c JOIN application a ON a.id = c.application_id;
      INSERT INTO evidence_fts (kind, evidence_id, workday_id, application, window_title, text)
      SELECT 'audio', id, workday_id, '', '', transcript
      FROM audio_evidence WHERE status = 'ready' AND transcript <> '';
    `)
  }
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS workday_local_day ON workday(local_day)')
}

function ensureAudioMediaPlaybackColumn(database: DatabaseSync) {
  const columns = database.prepare('PRAGMA table_info(audio_evidence)').all() as DatabaseRow[]
  if (!columns.some((column) => stringValue(column.name) === 'media_playback_json')) {
    database.exec('ALTER TABLE audio_evidence ADD COLUMN media_playback_json TEXT')
  }
}

function ensureAudioCaptureContinuityColumns(database: DatabaseSync) {
  const audioColumns = new Set(
    (database.prepare('PRAGMA table_info(audio_evidence)').all() as DatabaseRow[]).map((column) =>
      stringValue(column.name)
    )
  )
  if (!audioColumns.has('capture_epoch_id')) {
    database.exec('ALTER TABLE audio_evidence ADD COLUMN capture_epoch_id TEXT')
  }
  if (!audioColumns.has('capture_sequence')) {
    database.exec('ALTER TABLE audio_evidence ADD COLUMN capture_sequence INTEGER')
  }
  if (!audioColumns.has('captured_sample_count')) {
    database.exec('ALTER TABLE audio_evidence ADD COLUMN captured_sample_count INTEGER')
  }
  if (!audioColumns.has('capture_sample_time')) {
    database.exec('ALTER TABLE audio_evidence ADD COLUMN capture_sample_time REAL')
  }
  if (!audioColumns.has('capture_outcome')) {
    database.exec(
      `ALTER TABLE audio_evidence ADD COLUMN capture_outcome TEXT NOT NULL DEFAULT 'pending' CHECK(capture_outcome IN (
        'pending', 'transcribed', 'vad-empty', 'asr-empty', 'quarantined', 'music-gated', 'too-short', 'failed'
      ))`
    )
  }

  const speechColumns = new Set(
    (database.prepare('PRAGMA table_info(speech_segment)').all() as DatabaseRow[]).map((column) =>
      stringValue(column.name)
    )
  )
  if (!speechColumns.has('vad_started_at')) {
    database.exec('ALTER TABLE speech_segment ADD COLUMN vad_started_at INTEGER')
  }
  if (!speechColumns.has('chunk_ids_json')) {
    database.exec("ALTER TABLE speech_segment ADD COLUMN chunk_ids_json TEXT NOT NULL DEFAULT '[]'")
  }
  if (!speechColumns.has('vad_ended_at')) {
    database.exec('ALTER TABLE speech_segment ADD COLUMN vad_ended_at INTEGER')
  }
  if (!speechColumns.has('asr_window_index')) {
    database.exec('ALTER TABLE speech_segment ADD COLUMN asr_window_index INTEGER NOT NULL DEFAULT 0')
  }
  if (!speechColumns.has('asr_window_count')) {
    database.exec('ALTER TABLE speech_segment ADD COLUMN asr_window_count INTEGER NOT NULL DEFAULT 1')
  }
  if (!speechColumns.has('transcription_outcome')) {
    database.exec(
      `ALTER TABLE speech_segment ADD COLUMN transcription_outcome TEXT NOT NULL DEFAULT 'transcribed'
       CHECK(transcription_outcome IN ('transcribed', 'asr-empty'))`
    )
  }
}

function ensureManualMeetingColumns(database: DatabaseSync) {
  const columns = new Set(
    (database.prepare('PRAGMA table_info(manual_meeting)').all() as DatabaseRow[]).map((column) =>
      stringValue(column.name)
    )
  )
  if (!columns.has('paused_at')) database.exec('ALTER TABLE manual_meeting ADD COLUMN paused_at INTEGER')
  if (!columns.has('paused_ms')) {
    database.exec('ALTER TABLE manual_meeting ADD COLUMN paused_ms INTEGER NOT NULL DEFAULT 0')
  }
  if (!columns.has('episode_id')) database.exec('ALTER TABLE manual_meeting ADD COLUMN episode_id TEXT')
  if (!columns.has('automatic_revinote_processing_blocked')) {
    database.exec(
      'ALTER TABLE manual_meeting ADD COLUMN automatic_revinote_processing_blocked INTEGER NOT NULL DEFAULT 0 CHECK(automatic_revinote_processing_blocked IN (0, 1))'
    )
  }
  if (!columns.has('confirmed_at')) {
    database.exec('ALTER TABLE manual_meeting ADD COLUMN confirmed_at INTEGER')
    database.exec('UPDATE manual_meeting SET confirmed_at = started_at WHERE confirmed_at IS NULL')
  }
  if (!columns.has('available_from_at')) {
    database.exec('ALTER TABLE manual_meeting ADD COLUMN available_from_at INTEGER')
    database.exec('UPDATE manual_meeting SET available_from_at = started_at WHERE available_from_at IS NULL')
  }
  if (!columns.has('system_audio_available')) {
    database.exec(
      'ALTER TABLE manual_meeting ADD COLUMN system_audio_available INTEGER NOT NULL DEFAULT 1 CHECK(system_audio_available IN (0, 1))'
    )
  }
}

function ensureWorkItemContinuityColumns(database: DatabaseSync) {
  const itemColumns = new Set(
    (database.prepare('PRAGMA table_info(work_item)').all() as DatabaseRow[]).map((column) => stringValue(column.name))
  )
  const additions = [
    ['prompt', "TEXT NOT NULL DEFAULT ''"],
    ['ai_suggestion', 'TEXT'],
    ['context', "TEXT NOT NULL DEFAULT ''"],
    ['return_last_move', "TEXT NOT NULL DEFAULT ''"],
    ['return_unresolved', "TEXT NOT NULL DEFAULT ''"],
    ['return_next_move', "TEXT NOT NULL DEFAULT ''"],
    ['status', "TEXT NOT NULL DEFAULT 'todo'"],
    ['priority', "TEXT NOT NULL DEFAULT 'none'"],
    ['due_at', 'INTEGER'],
    ['day_synced_at', 'INTEGER NOT NULL DEFAULT 0'],
    ['lifecycle_updated_at', 'INTEGER NOT NULL DEFAULT 0'],
  ] as const
  for (const [name, definition] of additions) {
    if (!itemColumns.has(name)) database.exec(`ALTER TABLE work_item ADD COLUMN ${name} ${definition}`)
  }
  if (!itemColumns.has('day_synced_at')) {
    database.exec('UPDATE work_item SET day_synced_at = updated_at WHERE day_synced_at = 0')
  }
  if (!itemColumns.has('lifecycle_updated_at')) {
    database.exec('UPDATE work_item SET lifecycle_updated_at = updated_at WHERE lifecycle_updated_at = 0')
  }

  const sourceColumns = new Set(
    (database.prepare('PRAGMA table_info(work_item_source)').all() as DatabaseRow[]).map((column) =>
      stringValue(column.name)
    )
  )
  if (!sourceColumns.has('conversation_start_time')) {
    database.exec('ALTER TABLE work_item_source ADD COLUMN conversation_start_time TEXT')
  }
  if (!sourceColumns.has('conversation_reference')) {
    database.exec('ALTER TABLE work_item_source ADD COLUMN conversation_reference TEXT')
  }
  if (!sourceColumns.has('conversation_action_id')) {
    database.exec('ALTER TABLE work_item_source ADD COLUMN conversation_action_id TEXT')
  }
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS work_item_source_conversation_action
      ON work_item_source(conversation_reference, conversation_action_id)
      WHERE conversation_reference IS NOT NULL AND conversation_action_id IS NOT NULL
  `)
}

function workItemConversationReference(memory: DayMemory, startTime?: string) {
  if (!startTime) return null
  try {
    const conversation = resolveConversationReference(memory.conversations ?? [], startTime)
    return conversation ? conversationReference(conversation) : null
  } catch {
    return null
  }
}

function ensureContextUrlColumn(database: DatabaseSync) {
  const columns = database.prepare('PRAGMA table_info(context_evidence)').all() as DatabaseRow[]
  if (!columns.some((column) => stringValue(column.name) === 'url')) {
    database.exec("ALTER TABLE context_evidence ADD COLUMN url TEXT NOT NULL DEFAULT ''")
  }
}

function ensureContextFocusedElementColumn(database: DatabaseSync) {
  const columns = database.prepare('PRAGMA table_info(context_evidence)').all() as DatabaseRow[]
  if (!columns.some((column) => stringValue(column.name) === 'focused_element_json')) {
    database.exec('ALTER TABLE context_evidence ADD COLUMN focused_element_json TEXT')
  }
}

function ensureManualConversationMergeBoundary(database: DatabaseSync) {
  const tableSql = stringValue(
    (
      database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversation_episode'").get() as
        | DatabaseRow
        | undefined
    )?.sql ?? ''
  )
  if (tableSql.includes("'manual-merge'")) return

  database.exec('PRAGMA foreign_keys = OFF')
  try {
    transaction(database, () => {
      database.exec(`
        CREATE TABLE conversation_episode_new (
          id TEXT PRIMARY KEY,
          workday_id TEXT NOT NULL REFERENCES workday(id) ON DELETE CASCADE,
          started_at INTEGER NOT NULL,
          ended_at INTEGER NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('provisional', 'final')),
          surface_key TEXT,
          provider TEXT,
          boundary_reason TEXT NOT NULL CHECK(boundary_reason IN (
            'open', 'call-surface-changed', 'call-ended', 'speech-gap', 'capture-paused', 'day-ended', 'manual-merge'
          )),
          segment_ids_json TEXT NOT NULL DEFAULT '[]',
          deleted_at INTEGER,
          CHECK(ended_at >= started_at)
        ) STRICT;
        INSERT INTO conversation_episode_new
        SELECT * FROM conversation_episode;
        DROP TABLE conversation_episode;
        ALTER TABLE conversation_episode_new RENAME TO conversation_episode;
        CREATE INDEX conversation_episode_workday_time
          ON conversation_episode(workday_id, started_at, ended_at);
      `)
    })
  } finally {
    database.exec('PRAGMA foreign_keys = ON')
  }
}

function ensureAutomaticRevinoteProcessingBlockedColumn(database: DatabaseSync) {
  const columns = database.prepare('PRAGMA table_info(conversation_episode)').all() as DatabaseRow[]
  if (!columns.some((column) => stringValue(column.name) === 'automatic_revinote_processing_blocked')) {
    database.exec(
      'ALTER TABLE conversation_episode ADD COLUMN automatic_revinote_processing_blocked INTEGER NOT NULL DEFAULT 0 CHECK(automatic_revinote_processing_blocked IN (0, 1))'
    )
  }
}

export class EvidenceStore {
  private readonly database: DatabaseSync
  private taskContextStatement?: StatementSync
  private readonly deletionListeners = new Set<(revision: number) => void>()
  readonly ambientTasks: AmbientTaskStore
  readonly proactive: ProactiveStore

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    if (existsSync(path) && statSync(path).size === 0) throw new Error('evidence-archive-zero-byte')
    this.database = new DatabaseSync(path)
    const version = numberValue(this.database.prepare('PRAGMA user_version').get()?.user_version ?? 0)
    if (![0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, SCHEMA_VERSION].includes(version)) {
      throw new Error(`unsupported-evidence-schema:${version}`)
    }
    createSchema(this.database)
    this.database.exec(`CREATE TABLE IF NOT EXISTS workday_analysis_provenance (
      id TEXT PRIMARY KEY, provenance_json TEXT NOT NULL
    ) STRICT;`)
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS evidence_privacy (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO evidence_privacy(id, revision) VALUES (1, 0);
    `)
    this.ambientTasks = new AmbientTaskStore(this.database)
    this.proactive = new ProactiveStore(this.database)
    ensureManualConversationMergeBoundary(this.database)
    ensureAutomaticRevinoteProcessingBlockedColumn(this.database)
    ensureContextUrlColumn(this.database)
    ensureContextFocusedElementColumn(this.database)
    ensureAudioMediaPlaybackColumn(this.database)
    ensureAudioCaptureContinuityColumns(this.database)
    ensureManualMeetingColumns(this.database)
    ensureWorkItemContinuityColumns(this.database)
    ensureLocalDayInvariant(this.database)
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS audio_search_row (
          evidence_id TEXT PRIMARY KEY REFERENCES audio_evidence(id) ON DELETE CASCADE,
          fts_rowid INTEGER NOT NULL UNIQUE
      ) STRICT;
    `)
    // Check indexed row IDs before scanning the much larger context-text corpus.
    // Older app versions can replace FTS rows without updating this lookup.
    const missingAudioSearchRow = this.database
      .prepare(`
      SELECT 1 FROM audio_evidence a
      LEFT JOIN audio_search_row r ON r.evidence_id = a.id
      LEFT JOIN evidence_fts f ON f.rowid = r.fts_rowid
      WHERE a.status = 'ready' AND trim(a.transcript) <> ''
        AND (f.rowid IS NULL OR f.kind <> 'audio' OR f.evidence_id <> a.id)
      LIMIT 1
    `)
      .get()
    const staleAudioSearchRow = this.database
      .prepare(`
      SELECT 1 FROM audio_search_row r
      LEFT JOIN evidence_fts f ON f.rowid = r.fts_rowid
      WHERE f.rowid IS NULL OR f.kind <> 'audio' OR f.evidence_id <> r.evidence_id
      LIMIT 1
    `)
      .get()
    if (missingAudioSearchRow || staleAudioSearchRow)
      transaction(this.database, () => {
        this.database.exec(`
        DELETE FROM audio_search_row;
        INSERT INTO audio_search_row(evidence_id, fts_rowid)
        SELECT evidence_id, rowid FROM evidence_fts WHERE kind = 'audio';
      `)
      })
    this.migrateLegacyWorkItems()
    this.recoverInterruptedWorkItemAgentSessions()
  }

  close() {
    this.deletionListeners.clear()
    this.database.close()
  }

  deletionRevision() {
    return Number(this.database.prepare('SELECT revision FROM evidence_privacy WHERE id = 1').get()?.revision ?? 0)
  }

  subscribeEvidenceDeletion(listener: (revision: number) => void) {
    this.deletionListeners.add(listener)
    return () => {
      this.deletionListeners.delete(listener)
    }
  }

  private advanceDeletionRevision() {
    this.database.prepare('UPDATE evidence_privacy SET revision = revision + 1 WHERE id = 1').run()
  }

  private emitEvidenceDeletion() {
    const revision = this.deletionRevision()
    for (const listener of this.deletionListeners) listener(revision)
  }

  listWorkItems(): WorkItem[] {
    const rows = this.database
      .prepare('SELECT * FROM work_item ORDER BY updated_at DESC, created_at DESC')
      .all() as DatabaseRow[]
    const relations = this.workItemRelations()
    return rows.map((row) => this.hydrateWorkItem(row, relations))
  }

  applyAnalyzedWorkItems(input: {
    workdayId: string
    plan: AnalyzedWorkItemPlan
    conversations: ConversationSummary[]
    analysisStartedAt: number
    observedAt: number
    ambientBatch?: { evidence: AmbientEvidenceRef[]; notifyTitles: string[] }
    proactiveBatch?: ProactiveCommit
  }) {
    if (input.ambientBatch && input.proactiveBatch) throw new Error('analysis-consumer-conflict')
    if (input.proactiveBatch?.sources.some((source) => source.kind === 'note'))
      throw new Error('proactive-note-task-authority')
    if (input.proactiveBatch?.sources.some((ref) => !this.proactive.resolve(ref)))
      throw new Error('proactive-source-changed')
    if (input.ambientBatch?.evidence.some((ref) => !this.ambientTasks.resolve(ref))) {
      throw new Error('ambient-evidence-changed')
    }
    const result = { created: 0, updated: 0, closed: 0 }
    if (input.proactiveBatch && this.proactive.get(input.proactiveBatch.decision.id)) {
      this.proactive.commit(input.proactiveBatch)
      return result
    }
    const sourceBatch =
      input.proactiveBatch?.sources.map((source): AmbientEvidenceRef => {
        if (source.kind === 'note' || source.kind === 'day') throw new Error('proactive-derived-task-authority')
        return { ...source, kind: source.kind }
      }) ?? input.ambientBatch?.evidence
    const items = new Map(this.listWorkItems().map((item) => [item.id, item]))
    const conversationActionPoints = new Map(
      input.conversations.map((conversation) => [
        conversationReference(conversation),
        conversationActionPointItems(conversation),
      ])
    )
    const conversationReferenceAt = (startTime?: string) => {
      if (!startTime) return null
      try {
        const conversation = resolveConversationReference(input.conversations, startTime)
        return conversation ? conversationReference(conversation) : null
      } catch {
        return null
      }
    }
    const resolveSource = (task: AnalyzedWorkItemPlan['proposed'][number]) => {
      const source = task.source
      const label = typeof source?.label === 'string' ? source.label.trim() : ''
      const detail = typeof source?.detail === 'string' ? source.detail.trim() : ''
      if (!source || !label || !detail) return null

      if (source.kind === 'conversation') {
        const startTime =
          typeof source.conversationStartTime === 'string' ? source.conversationStartTime.trim() : undefined
        const reference = conversationReferenceAt(startTime)
        if (!startTime || !reference) return null
        const actionPoints = conversationActionPoints.get(reference) ?? []
        const matchingActionPoint =
          actionPoints.find(
            (actionPoint) => normalizedWorkItemIdentity(actionPoint.text) === normalizedWorkItemIdentity(task.title)
          ) ?? (actionPoints.length === 1 ? actionPoints[0] : null)
        if (actionPoints.length > 0 && !matchingActionPoint) return null
        return {
          kind: 'meeting' as const satisfies WorkItemSource['kind'],
          label,
          detail,
          startTime,
          reference,
          actionId: matchingActionPoint?.id ?? null,
          observedAt: input.observedAt,
          identity: reference,
          ambientRef: null,
        }
      }

      if (source.kind !== 'task') return null
      const evidenceId = typeof source.evidenceId === 'string' ? source.evidenceId.trim() : ''
      if (!evidenceId) return null
      if (
        sourceBatch &&
        !sourceBatch.some(
          (ref) =>
            ref.workdayId === input.workdayId &&
            (ref.kind === 'speech' ? `speech:${ref.sourceId}` : ref.sourceId) === evidenceId
        )
      )
        return null
      const batchRef = sourceBatch?.find(
        (ref) => (ref.kind === 'speech' ? `speech:${ref.sourceId}` : ref.sourceId) === evidenceId
      )
      const evidence = batchRef
        ? this.ambientTasks.resolve(batchRef)
        : sourceBatch
          ? null
          : this.ambientTasks.resolveSource(evidenceId)
      if (!evidence || evidence.workdayId !== input.workdayId || (!sourceBatch && evidence.kind !== 'context'))
        return null
      // Rendered Remember output is derived context, not a new user commitment.
      if (
        evidence.kind === 'context' &&
        (/^computer\.remember(?:\.|$)/i.test(evidence.bundleId) || /^Remember(?:\s|$)/i.test(evidence.appName))
      )
        return null
      return {
        kind: 'observed' as const satisfies WorkItemSource['kind'],
        label,
        detail,
        startTime: null,
        reference: null,
        actionId: null,
        observedAt: evidence.observedAt,
        identity: evidenceId,
        ambientRef: evidence,
      }
    }
    const addSource = (itemId: string, source: NonNullable<ReturnType<typeof resolveSource>>) => {
      const id = analyzedSourceId(itemId, [
        input.workdayId,
        source.kind,
        source.identity,
        normalizedWorkItemIdentity(source.label),
        normalizedWorkItemIdentity(source.detail),
      ])
      const inserted = this.database
        .prepare(
          `INSERT OR IGNORE INTO work_item_source
           (id, work_item_id, kind, label, detail, workday_id, conversation_reference,
            conversation_action_id, conversation_start_time, observed_at, confidence)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
        )
        .run(
          id,
          itemId,
          source.kind,
          source.label,
          source.detail,
          input.workdayId,
          source.reference,
          source.actionId,
          source.startTime,
          source.observedAt
        )
      if (source.ambientRef) this.ambientTasks.recordTaskSource(itemId, id, source.ambientRef)
      return inserted.changes > 0
    }
    const linkedItemId = (source: NonNullable<ReturnType<typeof resolveSource>>) => {
      if (!source.reference || !source.actionId) return null
      const row = this.database
        .prepare(
          `SELECT work_item_id FROM work_item_source
           WHERE conversation_reference = ? AND conversation_action_id = ?`
        )
        .get(source.reference, source.actionId) as DatabaseRow | undefined
      return row ? stringValue(row.work_item_id) : null
    }
    const hasNewerUserEdit = (item: WorkItem) =>
      item.facts.some((fact) => fact.actor === 'user' && fact.type === 'edited' && fact.at > input.analysisStartedAt)
    transaction(this.database, () => {
      for (const task of input.plan.proposed) {
        const title = task.title.trim()
        const description = task.description.trim()
        const source = resolveSource(task)
        if (!title || !source) continue
        const actionItemId = linkedItemId(source)
        if (actionItemId && actionItemId !== task.id) continue

        if (!task.id) {
          const ambientRef = source.ambientRef
          const commitment = ambientRef ? this.ambientTasks.commitmentIdentity(title, description, ambientRef) : null
          const priorItemId = commitment && ambientRef ? this.ambientTasks.commitmentItem(commitment, ambientRef) : null
          const equivalent =
            commitment && !priorItemId
              ? [...items.values()].filter(
                  (item) =>
                    normalizedWorkItemIdentity(item.title) === normalizedWorkItemIdentity(title) &&
                    normalizedWorkItemIdentity(item.description) === normalizedWorkItemIdentity(description) &&
                    item.sources.some((entry) => entry.kind === 'manual' || entry.workdayId === input.workdayId)
                )
              : []
          const priorItem = priorItemId ? items.get(priorItemId) : equivalent.length === 1 ? equivalent[0] : undefined
          if (priorItem) {
            if (priorItem.lifecycle === 'open') {
              if (commitment) this.ambientTasks.recordCommitment(commitment, input.workdayId, priorItem.id)
              addSource(priorItem.id, source)
            }
            continue
          }
          const itemId = analyzedWorkItemId([
            input.workdayId,
            normalizedWorkItemIdentity(title),
            normalizedWorkItemIdentity(description),
            source.kind,
            source.identity,
            normalizedWorkItemIdentity(source.label),
            normalizedWorkItemIdentity(source.detail),
          ])
          if (items.has(itemId)) continue
          const inserted = this.database
            .prepare(
              `INSERT OR IGNORE INTO work_item
               (id, title, description, prompt, ai_suggestion, context, return_last_move, return_unresolved, return_next_move,
                lifecycle, attention, created_at, updated_at, closed_at, user_edited_title, user_edited_description,
                day_synced_at, lifecycle_updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 'idle', ?, ?, NULL, 0, 0, ?, ?)`
            )
            .run(
              itemId,
              title,
              description,
              task.prompt?.trim() ?? '',
              task.aiSuggestion?.trim() || null,
              task.context?.trim() ?? '',
              task.returnPoint?.lastMove.trim() ?? '',
              task.returnPoint?.unresolved.trim() ?? '',
              task.returnPoint?.nextMove.trim() ?? '',
              input.observedAt,
              input.observedAt,
              input.observedAt,
              input.observedAt
            )
          if (inserted.changes !== 1) throw new Error('work-item-write-not-persisted')
          addSource(itemId, source)
          if (commitment) this.ambientTasks.recordCommitment(commitment, input.workdayId, itemId)
          this.insertWorkItemFact(
            itemId,
            'created',
            'system',
            'Remember herkende dit als open werk.',
            input.observedAt,
            null,
            `${itemId}:analysis:${input.workdayId}:created`
          )
          const created = this.requireWorkItem(itemId)
          items.set(itemId, created)
          result.created += 1
          if (input.ambientBatch?.notifyTitles.includes(title)) {
            this.ambientTasks.enqueueNotification(itemId, source.observedAt)
          }
          continue
        }

        const existing = items.get(task.id)
        if (existing?.lifecycle !== 'open') continue
        if (hasNewerUserEdit(existing)) continue
        if (
          existing.observations.some(
            (observation) =>
              observation.kind === 'completion_candidate' &&
              observation.dismissedAt === null &&
              observation.observedAt > input.analysisStartedAt
          )
        )
          continue
        const syncRow = this.database.prepare('SELECT day_synced_at FROM work_item WHERE id = ?').get(existing.id) as
          | DatabaseRow
          | undefined
        if (!syncRow || numberValue(syncRow.day_synced_at) > input.analysisStartedAt) continue

        const nextTitle = !existing.userEditedTitle && task.titleChangeReason === 'outcome' ? title : existing.title
        const nextDescription = existing.userEditedDescription ? existing.description : description
        const nextPrompt = task.prompt === undefined ? existing.prompt : task.prompt.trim()
        const nextAiSuggestion =
          task.aiSuggestion === undefined ? (existing.aiSuggestion ?? null) : task.aiSuggestion?.trim() || null
        const nextContext = task.context?.trim() || existing.context
        const nextReturnPoint = {
          lastMove: task.returnPoint?.lastMove.trim() || existing.returnPoint.lastMove,
          unresolved: task.returnPoint?.unresolved.trim() || existing.returnPoint.unresolved,
          nextMove: task.returnPoint?.nextMove.trim() || existing.returnPoint.nextMove,
        }
        const contentChanged =
          nextTitle !== existing.title ||
          nextDescription !== existing.description ||
          nextPrompt !== existing.prompt ||
          nextAiSuggestion !== existing.aiSuggestion ||
          nextContext !== existing.context ||
          nextReturnPoint.lastMove !== existing.returnPoint.lastMove ||
          nextReturnPoint.unresolved !== existing.returnPoint.unresolved ||
          nextReturnPoint.nextMove !== existing.returnPoint.nextMove
        const sourceAdded = addSource(existing.id, source)
        this.database
          .prepare(
            `UPDATE work_item
             SET title = ?, description = ?, prompt = ?, ai_suggestion = ?, context = ?, return_last_move = ?,
                 return_unresolved = ?, return_next_move = ?, day_synced_at = ?,
                 updated_at = CASE WHEN ? = 1 THEN MAX(updated_at + 1, ?) ELSE updated_at END
             WHERE id = ?`
          )
          .run(
            nextTitle,
            nextDescription,
            nextPrompt,
            nextAiSuggestion,
            nextContext,
            nextReturnPoint.lastMove,
            nextReturnPoint.unresolved,
            nextReturnPoint.nextMove,
            input.observedAt,
            contentChanged || sourceAdded ? 1 : 0,
            input.observedAt,
            existing.id
          )
        if (contentChanged) {
          this.insertWorkItemFact(
            existing.id,
            'edited',
            'system',
            'Remember verwerkte nieuwere onderbouwde context.',
            input.observedAt,
            null,
            `${existing.id}:analysis:${input.workdayId}:${input.observedAt}:edited`
          )
        }
        if (contentChanged || sourceAdded) {
          const updated = this.requireWorkItem(existing.id)
          items.set(existing.id, updated)
          result.updated += 1
        }
      }

      for (const change of input.plan.changes) {
        const existing = items.get(change.id)
        if (existing?.lifecycle !== 'open') continue
        if (hasNewerUserEdit(existing)) continue
        const syncRow = this.database
          .prepare('SELECT lifecycle_updated_at FROM work_item WHERE id = ?')
          .get(existing.id) as DatabaseRow | undefined
        if (!syncRow || numberValue(syncRow.lifecycle_updated_at) > input.analysisStartedAt) continue
        const observationKind: WorkItemObservation['kind'] =
          change.type === 'completed' ? 'completion_candidate' : change.type === 'superseded' ? 'progress' : 'blocked'
        const observationId = `analysis-observation:${createHash('sha256')
          .update(JSON.stringify([existing.id, input.workdayId, change.type, change.reason.trim()]))
          .digest('hex')}`
        this.database
          .prepare(
            `INSERT OR IGNORE INTO work_item_observation
             (id, work_item_id, kind, summary, confidence, workday_id, observed_at, dismissed_at, dedupe_key)
             VALUES (?, ?, ?, ?, 1, ?, ?, NULL, ?)`
          )
          .run(
            observationId,
            existing.id,
            observationKind,
            change.reason.trim(),
            input.workdayId,
            input.observedAt,
            observationId
          )
        if (!this.database.prepare('SELECT id FROM work_item_observation WHERE id = ?').get(observationId))
          throw new Error('work-item-write-not-persisted')
        items.set(existing.id, this.requireWorkItem(existing.id))
      }
      if (input.ambientBatch) this.ambientTasks.acknowledge(input.ambientBatch.evidence, input.observedAt)
      if (input.proactiveBatch) this.proactive.commitInTransaction(input.proactiveBatch)
    })
    return result
  }

  synchronizeConversationActionPoints(input: {
    workdayId: string
    conversations: ConversationSummary[]
    observedAt: number
    createMissing?: boolean
  }) {
    const result = { created: 0, linked: 0, updated: 0 }

    transaction(this.database, () => {
      for (const conversation of input.conversations) {
        const reference = conversationReference(conversation)
        const actionPoints = conversationActionPointItems(conversation)
        if (!actionPoints.length) continue

        const candidates = this.database
          .prepare(
            `SELECT source.id AS source_id, source.work_item_id, source.conversation_action_id,
                    item.title, item.description, item.lifecycle, item.user_edited_title
             FROM work_item_source source
             JOIN work_item item ON item.id = source.work_item_id
             WHERE source.kind = 'meeting' AND source.conversation_reference = ?
             ORDER BY source.observed_at, source.id`
          )
          .all(reference) as DatabaseRow[]
        this.database
          .prepare(
            `UPDATE work_item_source SET conversation_action_id = NULL
             WHERE kind = 'meeting' AND conversation_reference = ? AND conversation_action_id IS NOT NULL`
          )
          .run(reference)
        const claimedItemIds = new Set<string>()
        const matchedCandidates = new Map<string, DatabaseRow>()
        const claimCandidate = (actionId: string, candidate: DatabaseRow | undefined) => {
          if (!candidate) return
          matchedCandidates.set(actionId, candidate)
          claimedItemIds.add(stringValue(candidate.work_item_id))
        }

        // Resolve text across the whole list first, so a reordered action keeps its task
        // before an edited action can claim the provider's old positional identity.
        for (const actionPoint of actionPoints) {
          const matchingText = candidates.filter(
            (candidate) =>
              normalizedWorkItemIdentity(stringValue(candidate.title)) ===
                normalizedWorkItemIdentity(actionPoint.text) && !claimedItemIds.has(stringValue(candidate.work_item_id))
          )
          claimCandidate(
            actionPoint.id,
            matchingText.find((candidate) => stringValue(candidate.conversation_action_id) === actionPoint.id) ??
              matchingText[0]
          )
        }
        for (const actionPoint of actionPoints) {
          if (matchedCandidates.has(actionPoint.id)) continue
          // Imported tasks retain their deterministic identity even if older synchronization
          // cleared the source link after analysis renamed the task.
          const originalItemId = analyzedWorkItemId(['conversation-action', input.workdayId, reference, actionPoint.id])
          claimCandidate(
            actionPoint.id,
            candidates.find(
              (candidate) =>
                stringValue(candidate.conversation_action_id) === actionPoint.id &&
                !claimedItemIds.has(stringValue(candidate.work_item_id))
            ) ??
              candidates.find(
                (candidate) =>
                  stringValue(candidate.work_item_id) === originalItemId && !claimedItemIds.has(originalItemId)
              )
          )
        }

        // A task can accumulate multiple meeting sources as its title evolves. Count
        // distinct tasks and only recover a missing identity when one pairing remains.
        const unmatchedActions = actionPoints.filter((actionPoint) => !matchedCandidates.has(actionPoint.id))
        const remainingCandidates = new Map(
          candidates
            .filter((candidate) => !claimedItemIds.has(stringValue(candidate.work_item_id)))
            .map((candidate) => [stringValue(candidate.work_item_id), candidate])
        )
        if (unmatchedActions.length === 1 && remainingCandidates.size === 1) {
          claimCandidate(unmatchedActions[0].id, remainingCandidates.values().next().value)
        }

        for (const actionPoint of actionPoints) {
          const candidate = matchedCandidates.get(actionPoint.id)

          if (candidate) {
            const itemId = stringValue(candidate.work_item_id)
            if (stringValue(candidate.conversation_action_id) !== actionPoint.id) {
              result.linked += 1
            }
            this.database
              .prepare(
                `UPDATE work_item_source
                 SET conversation_action_id = ?, label = ?, workday_id = ?, conversation_start_time = ?
                 WHERE id = ?`
              )
              .run(
                actionPoint.id,
                conversation.title.trim(),
                input.workdayId,
                conversation.startTime,
                stringValue(candidate.source_id)
              )
            if (numberValue(candidate.user_edited_title) === 0 && stringValue(candidate.title) !== actionPoint.text) {
              this.database
                .prepare('UPDATE work_item SET title = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ?')
                .run(actionPoint.text, input.observedAt, itemId)
              result.updated += 1
            }
            continue
          }

          if (input.createMissing === false) continue

          const itemId = analyzedWorkItemId(['conversation-action', input.workdayId, reference, actionPoint.id])
          const lifecycle: WorkItemLifecycle = actionPoint.completed ? 'completed' : 'open'
          const closedAt = lifecycle === 'completed' ? input.observedAt : null
          this.database
            .prepare(
              `INSERT OR IGNORE INTO work_item
               (id, title, description, prompt, context, return_last_move, return_unresolved, return_next_move,
                lifecycle, attention, created_at, updated_at, closed_at, user_edited_title, user_edited_description,
                day_synced_at, lifecycle_updated_at)
               VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, 'idle', ?, ?, ?, 0, 0, ?, ?)`
            )
            .run(
              itemId,
              actionPoint.text,
              conversation.description.trim(),
              actionPoint.text,
              conversation.summary?.trim() || conversation.description.trim(),
              actionPoint.text,
              actionPoint.text,
              lifecycle,
              input.observedAt,
              input.observedAt,
              closedAt,
              input.observedAt,
              input.observedAt
            )
          this.database
            .prepare(
              `INSERT OR IGNORE INTO work_item_source
               (id, work_item_id, kind, label, detail, workday_id, conversation_reference,
                conversation_action_id, conversation_start_time, observed_at, confidence)
               VALUES (?, ?, 'meeting', ?, ?, ?, ?, ?, ?, ?, 1)`
            )
            .run(
              analyzedSourceId(itemId, [input.workdayId, reference, actionPoint.id]),
              itemId,
              conversation.title.trim(),
              'Actiepunt uit gesprek.',
              input.workdayId,
              reference,
              actionPoint.id,
              conversation.startTime,
              input.observedAt
            )
          this.insertWorkItemFact(
            itemId,
            lifecycle === 'completed' ? 'completed' : 'created',
            'system',
            lifecycle === 'completed'
              ? 'Als afgerond geïmporteerd uit het gesprek.'
              : 'Remember herkende een expliciet actiepunt uit het gesprek.',
            input.observedAt,
            null,
            `${itemId}:conversation-action:created`
          )
          claimedItemIds.add(itemId)
          result.created += 1
        }
      }
    })

    return result
  }

  getWorkItem(id: string): WorkItem | null {
    const row = this.database.prepare('SELECT * FROM work_item WHERE id = ?').get(id) as DatabaseRow | undefined
    return row ? this.hydrateWorkItem(row) : null
  }

  createWorkItem(title: string, description: string): WorkItem {
    const id = randomUUID()
    const now = Date.now()
    transaction(this.database, () => {
      this.database
        .prepare(
          `INSERT INTO work_item
           (id, title, description, prompt, context, return_last_move, return_unresolved, return_next_move,
            lifecycle, attention, created_at, updated_at, closed_at, user_edited_title, user_edited_description,
            day_synced_at, lifecycle_updated_at)
           VALUES (?, ?, ?, '', '', 'Door jou aan Inbox toegevoegd.', ?, '', 'open', 'idle', ?, ?, NULL, 1, ?, 0, ?)`
        )
        .run(id, title.trim(), description.trim(), description.trim(), now, now, description.trim() ? 1 : 0, now)
      this.database
        .prepare(
          `INSERT INTO work_item_source
           (id, work_item_id, kind, label, detail, workday_id, conversation_reference,
            conversation_start_time, observed_at, confidence)
           VALUES (?, ?, 'manual', 'Handmatig toegevoegd', 'Door jou aan de Inbox toegevoegd.', NULL, NULL, NULL, ?, NULL)`
        )
        .run(randomUUID(), id, now)
      this.insertWorkItemFact(id, 'created', 'user', 'Handmatig als werkitem toegevoegd.', now, null)
    })
    return this.requireWorkItem(id)
  }

  updateWorkItem(id: string, title: string, description: string, expectedUpdatedAt?: number): WorkItem {
    const existing = this.requireWorkItem(id)
    if (expectedUpdatedAt !== undefined && existing.updatedAt !== expectedUpdatedAt)
      throw new Error('work-item-revision-conflict')
    const normalizedTitle = title.trim()
    const normalizedDescription = description.trim()
    if (existing.title === normalizedTitle && existing.description === normalizedDescription) return existing
    const now = Math.max(Date.now(), existing.updatedAt + 1)
    const titleChanged = existing.title !== normalizedTitle
    const descriptionChanged = existing.description !== normalizedDescription
    transaction(this.database, () => {
      if (expectedUpdatedAt !== undefined && this.requireWorkItem(id).updatedAt !== expectedUpdatedAt)
        throw new Error('work-item-revision-conflict')
      const shouldUpdateReturnPoint =
        existing.sources[0]?.kind === 'manual' && existing.returnPoint.unresolved === existing.description
      this.database
        .prepare(
          `UPDATE work_item
           SET title = ?, description = ?, prompt = '', ai_suggestion = NULL,
               return_unresolved = CASE WHEN ? = 1 THEN ? ELSE return_unresolved END,
               updated_at = MAX(updated_at + 1, ?),
               user_edited_title = CASE WHEN ? = 1 THEN 1 ELSE user_edited_title END,
               user_edited_description = CASE WHEN ? = 1 THEN 1 ELSE user_edited_description END
           WHERE id = ?`
        )
        .run(
          normalizedTitle,
          normalizedDescription,
          shouldUpdateReturnPoint ? 1 : 0,
          normalizedDescription,
          now,
          titleChanged ? 1 : 0,
          descriptionChanged ? 1 : 0,
          id
        )
      this.insertWorkItemFact(id, 'edited', 'user', 'Titel of beschrijving bijgewerkt.', now, null)
    })
    return this.requireWorkItem(id)
  }

  updateWorkItemMetadata(
    id: string,
    input: { status: WorkItemStatus; priority: WorkItemPriority; dueAt: number | null },
    expectedUpdatedAt?: number
  ): WorkItem {
    const existing = this.requireWorkItem(id)
    if (expectedUpdatedAt !== undefined && existing.updatedAt !== expectedUpdatedAt)
      throw new Error('work-item-revision-conflict')
    if (existing.status === input.status && existing.priority === input.priority && existing.dueAt === input.dueAt) {
      return existing
    }
    const now = Math.max(Date.now(), existing.updatedAt + 1)
    const changes = [
      existing.status !== input.status ? `Status: ${input.status === 'in_progress' ? 'bezig' : 'te doen'}.` : '',
      existing.priority !== input.priority ? `Prioriteit: ${input.priority}.` : '',
      existing.dueAt !== input.dueAt ? (input.dueAt == null ? 'Deadline verwijderd.' : 'Deadline bijgewerkt.') : '',
    ]
      .filter(Boolean)
      .join(' ')
    transaction(this.database, () => {
      if (expectedUpdatedAt !== undefined && this.requireWorkItem(id).updatedAt !== expectedUpdatedAt)
        throw new Error('work-item-revision-conflict')
      this.database
        .prepare(
          'UPDATE work_item SET status = ?, priority = ?, due_at = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ?'
        )
        .run(input.status, input.priority, input.dueAt, now, id)
      this.insertWorkItemFact(id, 'edited', 'user', changes, now, null)
    })
    return this.requireWorkItem(id)
  }

  setWorkItemLifecycle(id: string, lifecycle: WorkItemLifecycle, expectedUpdatedAt?: number): WorkItem {
    const existing = this.requireWorkItem(id)
    if (expectedUpdatedAt !== undefined && existing.updatedAt !== expectedUpdatedAt)
      throw new Error('work-item-revision-conflict')
    if (existing.lifecycle === lifecycle) return existing
    const now = Math.max(Date.now(), existing.updatedAt + 1)
    const factType = lifecycle === 'open' ? 'reopened' : lifecycle
    const summary =
      lifecycle === 'open'
        ? 'Werkitem opnieuw geopend.'
        : lifecycle === 'completed'
          ? 'Werkitem afgerond.'
          : lifecycle === 'superseded'
            ? 'Werkitem vervangen door nieuwer werk.'
            : 'Werkitem niet meer actief.'
    transaction(this.database, () => {
      if (expectedUpdatedAt !== undefined && this.requireWorkItem(id).updatedAt !== expectedUpdatedAt)
        throw new Error('work-item-revision-conflict')
      this.database
        .prepare(
          `UPDATE work_item
           SET lifecycle = ?, attention = 'idle', updated_at = MAX(updated_at + 1, ?), closed_at = ?, lifecycle_updated_at = ?
           WHERE id = ?`
        )
        .run(lifecycle, now, lifecycle === 'open' ? null : now, now, id)
      this.insertWorkItemFact(id, factType, 'user', summary, now, null)
    })
    return this.requireWorkItem(id)
  }

  hostTaskReceipt(actionId: string): HostTaskSessionReceipt | null {
    const row = this.database.prepare('SELECT * FROM work_item_host_receipt WHERE action_id = ?').get(actionId)
    if (!row) return null
    const validated = validateHostTaskEnvelope(JSON.parse(stringValue(row.envelope_json)))
    if (validated.envelopeHash !== row.envelope_hash) throw new Error('host-task-binding-conflict')
    return hostTaskSessionReceipt(validated.envelope)
  }

  acceptHostTaskSession(input: HostTaskEnvelopeV1): HostTaskSessionReceipt {
    const { envelope, serialized, envelopeHash } = validateHostTaskEnvelope(input)
    const receipt = hostTaskSessionReceipt(envelope)

    transaction(this.database, () => {
      const existing = this.database
        .prepare('SELECT * FROM work_item_host_receipt WHERE action_id = ?')
        .get(envelope.actionId)
      if (existing) {
        if (existing.envelope_json !== serialized || existing.envelope_hash !== envelopeHash)
          throw new Error('host-task-binding-conflict')
        return
      }
      const conflict = this.database
        .prepare(
          `SELECT action_id FROM work_item_host_receipt
           WHERE session_id = ? OR job_id = ? OR user_message_id IN (?, ?) OR assistant_message_id IN (?, ?)`
        )
        .get(
          envelope.sessionId,
          envelope.jobId,
          envelope.userMessageId,
          envelope.assistantMessageId,
          envelope.userMessageId,
          envelope.assistantMessageId
        )
      if (
        conflict ||
        this.database.prepare('SELECT id FROM work_item_agent_session WHERE id = ?').get(envelope.sessionId)
      )
        throw new Error('host-task-binding-conflict')

      const item = this.requireWorkItem(envelope.workItemId)
      if (item.lifecycle !== 'open') throw new Error('host-task-not-open')
      if (hostTaskDefinitionHash(hostTaskDefinition(item)) !== hostTaskDefinitionHash(envelope.taskDefinition))
        throw new Error('host-task-definition-changed')

      this.database
        .prepare(
          `INSERT INTO work_item_host_receipt
           (action_id, work_item_id, session_id, job_id, user_message_id, assistant_message_id, envelope_hash, envelope_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          envelope.actionId,
          envelope.workItemId,
          envelope.sessionId,
          envelope.jobId,
          envelope.userMessageId,
          envelope.assistantMessageId,
          envelopeHash,
          serialized
        )
      this.database
        .prepare(
          `INSERT INTO work_item_agent_session
           (id, work_item_id, provider, status, instruction, message, response, started_at, updated_at, completed_at, duration_ms, steps_json)
           VALUES (?, ?, ?, 'running', ?, ?, '', ?, ?, NULL, NULL, '[]')`
        )
        .run(
          envelope.sessionId,
          envelope.workItemId,
          envelope.provider,
          envelope.preparedInput.prompt,
          envelope.instruction,
          envelope.startedAt,
          envelope.startedAt
        )
      this.database
        .prepare(
          `INSERT INTO work_item_fact (id, work_item_id, type, actor, summary, at, agent_session_id)
           VALUES (?, ?, 'agent_started', 'user', 'Opdracht gekoppeld aan de agentsessie.', ?, ?)`
        )
        .run(`host-task:${envelope.actionId}:started`, envelope.workItemId, envelope.startedAt, envelope.sessionId)
    })
    return receipt
  }

  validateHostTaskForDispatch(
    actionId: string,
    envelopeHash: string
  ): { state: 'current' | 'missing' | 'closed' | 'changed' } {
    const row = this.database.prepare('SELECT * FROM work_item_host_receipt WHERE action_id = ?').get(actionId)
    if (!row) throw new Error('host-task-receipt-not-found')
    const prepared = validateHostTaskEnvelope(JSON.parse(stringValue(row.envelope_json)))
    if (row.envelope_hash !== envelopeHash || prepared.envelopeHash !== envelopeHash)
      throw new Error('host-task-binding-conflict')
    const current = this.getWorkItem(prepared.envelope.workItemId)
    if (!current) return { state: 'missing' }
    if (current.lifecycle !== 'open') return { state: 'closed' }
    return {
      state:
        hostTaskDefinitionHash(hostTaskDefinition(current)) === hostTaskDefinitionHash(prepared.envelope.taskDefinition)
          ? 'current'
          : 'changed',
    }
  }

  applyHostTaskOutcome(input: HostTaskEnvelopeV1, terminal: HostTaskOutcome): HostTaskOutcomeReceipt {
    const { envelope, serialized, envelopeHash } = validateHostTaskEnvelope(input)
    const { outcome, serialized: outcomeJson, outcomeHash } = validateHostTaskOutcome(terminal)
    if (outcome.completedAt < envelope.startedAt) throw new Error('host-task-invalid-data')
    let projection: HostTaskOutcomeReceipt['projection'] = 'applied'

    transaction(this.database, () => {
      const row = this.database
        .prepare('SELECT * FROM work_item_host_receipt WHERE action_id = ?')
        .get(envelope.actionId)
      if (!row) throw new Error('host-task-receipt-not-found')
      if (row.envelope_json !== serialized || row.envelope_hash !== envelopeHash)
        throw new Error('host-task-binding-conflict')
      if (row.outcome_json !== null) {
        if (row.outcome_json !== outcomeJson || row.outcome_hash !== outcomeHash)
          throw new Error('host-task-outcome-conflict')
        if (row.outcome_projection !== 'applied' && row.outcome_projection !== 'orphaned')
          throw new Error('host-task-outcome-conflict')
        projection = row.outcome_projection
        return
      }

      const item = this.getWorkItem(envelope.workItemId)
      projection = item ? 'applied' : 'orphaned'
      if (item) {
        const result = this.database
          .prepare(
            `UPDATE work_item_agent_session
             SET status = ?, response = ?, updated_at = ?, completed_at = ?, duration_ms = ?, steps_json = ?
             WHERE id = ? AND work_item_id = ? AND status IN ('running', 'waiting_on_user')`
          )
          .run(
            outcome.status === 'completed' ? 'completed' : 'cancelled',
            outcome.response,
            outcome.completedAt,
            outcome.completedAt,
            outcome.durationMs,
            JSON.stringify(outcome.steps),
            envelope.sessionId,
            envelope.workItemId
          )
        if (Number(result.changes) !== 1) throw new Error('host-task-outcome-conflict')
        this.database
          .prepare(
            `INSERT INTO work_item_fact (id, work_item_id, type, actor, summary, at, agent_session_id)
             VALUES (?, ?, ?, 'agent', ?, ?, ?)`
          )
          .run(
            `host-task:${envelope.actionId}:terminal`,
            envelope.workItemId,
            outcome.status === 'completed' ? 'agent_completed' : 'agent_failed',
            outcome.status === 'completed' ? 'Agent heeft een antwoord geleverd.' : 'Agentsessie gestopt.',
            outcome.completedAt,
            envelope.sessionId
          )
      }
      this.database
        .prepare(
          `UPDATE work_item_host_receipt SET outcome_hash = ?, outcome_json = ?, outcome_projection = ?
           WHERE action_id = ?`
        )
        .run(outcomeHash, outcomeJson, projection, envelope.actionId)
    })
    return { ...hostTaskSessionReceipt(envelope), outcomeHash, projection }
  }

  private assertLegacyWorkItemSession(sessionId: string) {
    if (this.database.prepare('SELECT action_id FROM work_item_host_receipt WHERE session_id = ?').get(sessionId))
      throw new Error('host-task-session-owned')
  }

  recordWorkItemAgentSession(
    itemId: string,
    input: {
      sessionId: string
      provider: 'codex' | 'claude'
      prompt: string
      message: string
      response: string
      durationMs: number
      steps: unknown[]
      startedAt: number
    }
  ): WorkItem {
    this.requireWorkItem(itemId)
    const completedAt = Math.max(input.startedAt, input.startedAt + Math.max(0, input.durationMs))
    transaction(this.database, () => {
      this.assertLegacyWorkItemSession(input.sessionId)
      this.database
        .prepare(
          `INSERT INTO work_item_agent_session
           (id, work_item_id, provider, status, instruction, message, response, started_at, updated_at, completed_at, duration_ms, steps_json)
           VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             status = excluded.status, response = excluded.response, updated_at = excluded.updated_at,
             completed_at = excluded.completed_at, duration_ms = excluded.duration_ms, steps_json = excluded.steps_json`
        )
        .run(
          input.sessionId,
          itemId,
          input.provider,
          input.prompt,
          input.message,
          input.response,
          input.startedAt,
          completedAt,
          completedAt,
          Math.max(0, input.durationMs),
          JSON.stringify(input.steps)
        )
      this.insertWorkItemFact(
        itemId,
        'agent_started',
        'user',
        `${input.provider === 'claude' ? 'Claude' : 'Codex'} gestart.`,
        input.startedAt,
        input.sessionId
      )
      this.insertWorkItemFact(
        itemId,
        'agent_completed',
        'agent',
        'Agent heeft een update geleverd.',
        completedAt,
        input.sessionId
      )
      this.database
        .prepare("UPDATE work_item SET attention = 'idle', updated_at = MAX(updated_at + 1, ?) WHERE id = ?")
        .run(completedAt, itemId)
    })
    return this.requireWorkItem(itemId)
  }

  startWorkItemAgentSession(
    itemId: string,
    input: {
      sessionId: string
      provider: 'codex' | 'claude'
      prompt: string
      message: string
      startedAt: number
    }
  ): WorkItem {
    const existing = this.requireWorkItem(itemId)
    const itemUpdatedAt = Math.max(input.startedAt, existing.updatedAt + 1)
    transaction(this.database, () => {
      this.assertLegacyWorkItemSession(input.sessionId)
      this.database
        .prepare(
          `INSERT INTO work_item_agent_session
           (id, work_item_id, provider, status, instruction, message, response, started_at, updated_at, completed_at, duration_ms, steps_json)
           VALUES (?, ?, ?, 'running', ?, ?, '', ?, ?, NULL, NULL, '[]')`
        )
        .run(input.sessionId, itemId, input.provider, input.prompt, input.message, input.startedAt, input.startedAt)
      this.insertWorkItemFact(
        itemId,
        'agent_started',
        'user',
        `${input.provider === 'claude' ? 'Claude' : 'Codex'} gestart.`,
        input.startedAt,
        input.sessionId,
        `${input.sessionId}:started`
      )
      this.database
        .prepare("UPDATE work_item SET attention = 'agent_running', updated_at = MAX(updated_at + 1, ?) WHERE id = ?")
        .run(itemUpdatedAt, itemId)
    })
    return this.requireWorkItem(itemId)
  }

  finishWorkItemAgentSession(
    itemId: string,
    sessionId: string,
    input: { response: string; durationMs: number; steps: unknown[] }
  ): WorkItem {
    this.assertLegacyWorkItemSession(sessionId)
    const existing = this.requireWorkItem(itemId)
    if (existing.agentSessions.some((session) => session.id === sessionId && session.status === 'completed'))
      return existing
    const session = this.database
      .prepare('SELECT started_at FROM work_item_agent_session WHERE id = ? AND work_item_id = ?')
      .get(sessionId, itemId) as DatabaseRow | undefined
    if (!session) throw new Error('work-item-agent-session-not-found')
    const result = parseInboxResult(input.response)
    const completedAt = numberValue(session.started_at) + Math.max(0, input.durationMs)
    const itemUpdatedAt = Math.max(completedAt, existing.updatedAt + 1)
    transaction(this.database, () => {
      this.assertLegacyWorkItemSession(sessionId)
      this.database
        .prepare(
          `UPDATE work_item_agent_session
           SET status = 'completed', response = ?, updated_at = ?, completed_at = ?, duration_ms = ?, steps_json = ?
           WHERE id = ? AND work_item_id = ?`
        )
        .run(
          result.response,
          completedAt,
          completedAt,
          Math.max(0, input.durationMs),
          JSON.stringify(input.steps),
          sessionId,
          itemId
        )
      this.insertWorkItemFact(
        itemId,
        'agent_completed',
        'agent',
        result.update?.summary ?? 'Agent heeft een update geleverd.',
        completedAt,
        sessionId,
        `${sessionId}:completed`
      )
      if (result.update) {
        this.database
          .prepare(
            'UPDATE work_item SET return_last_move = ?, return_unresolved = ?, return_next_move = ? WHERE id = ?'
          )
          .run(result.update.summary, result.update.remaining, result.update.nextStep, itemId)
      }
      this.database
        .prepare('UPDATE work_item SET attention = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ?')
        .run(result.update?.needsUser ? 'waiting_on_user' : 'idle', itemUpdatedAt, itemId)
    })
    return this.requireWorkItem(itemId)
  }

  failWorkItemAgentSession(itemId: string, sessionId: string, status: 'failed' | 'cancelled' = 'failed'): WorkItem {
    this.requireWorkItem(itemId)
    const now = Date.now()
    transaction(this.database, () => {
      this.assertLegacyWorkItemSession(sessionId)
      const result = this.database
        .prepare(
          `UPDATE work_item_agent_session
           SET status = ?, updated_at = ?, completed_at = ?
           WHERE id = ? AND work_item_id = ? AND status = 'running'`
        )
        .run(status, now, now, sessionId, itemId)
      if (Number(result.changes) === 0) throw new Error('work-item-agent-session-not-found')
      this.insertWorkItemFact(
        itemId,
        'agent_failed',
        'agent',
        status === 'cancelled' ? 'Agent gestopt.' : 'Agent kon het werk niet afronden.',
        now,
        sessionId,
        `${sessionId}:failed`
      )
      this.database
        .prepare("UPDATE work_item SET attention = 'idle', updated_at = MAX(updated_at + 1, ?) WHERE id = ?")
        .run(now, itemId)
    })
    return this.requireWorkItem(itemId)
  }

  upsertSession(session: DailyReviewSession) {
    const now = Date.now()
    const memory = session.memory
    const refresh = session.refresh
    const stored = prepareWorkdayMemory(memory)
    transaction(this.database, () => {
      const previousReference = this.database
        .prepare("SELECT json_extract(memory_json, '$._analysisProvenanceRef') AS reference FROM workday WHERE id = ?")
        .get(session.id)?.reference
      if (
        stored.provenance &&
        !this.database.prepare('SELECT 1 FROM workday_analysis_provenance WHERE id = ?').get(stored.provenance.id)
      ) {
        this.database
          .prepare('INSERT OR IGNORE INTO workday_analysis_provenance(id, provenance_json) VALUES (?, ?)')
          .run(stored.provenance.id, stored.provenance.json)
      }
      this.database
        .prepare(
          `INSERT INTO workday (
          id, local_day, started_at, ended_at, active_duration_ms, memory_json,
          memory_refreshed_at, memory_covered_through, refresh_status, refresh_reason,
          refresh_target_through, refresh_error, refresh_progress_json, refresh_run_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          started_at = excluded.started_at,
          ended_at = excluded.ended_at,
          active_duration_ms = excluded.active_duration_ms,
          memory_json = excluded.memory_json,
          memory_refreshed_at = excluded.memory_refreshed_at,
          memory_covered_through = excluded.memory_covered_through,
          refresh_status = excluded.refresh_status,
          refresh_reason = excluded.refresh_reason,
          refresh_target_through = excluded.refresh_target_through,
          refresh_error = excluded.refresh_error,
          refresh_progress_json = excluded.refresh_progress_json,
          refresh_run_json = excluded.refresh_run_json,
          updated_at = excluded.updated_at`
        )
        .run(
          session.id,
          sessionLocalDay(session),
          session.startedAt,
          session.endedAt,
          session.activeDurationMs,
          stored.json,
          memory?.refreshedAt ?? null,
          memory?.coveredThrough ?? null,
          refresh.status,
          refresh.reason,
          refresh.targetThrough,
          refresh.error,
          refresh.progress ? JSON.stringify(refresh.progress) : null,
          refresh.run ? JSON.stringify(refresh.run) : null,
          now,
          now
        )
      if (previousReference !== stored.provenance?.id) pruneWorkdayProvenance(this.database, previousReference)
    })
  }

  checkpointWorkday(workdayId: string, activeDurationMs: number) {
    this.database
      .prepare('UPDATE workday SET active_duration_ms = ?, updated_at = ? WHERE id = ?')
      .run(activeDurationMs, Date.now(), workdayId)
  }

  appendAudioMoment(moment: DailyReviewMoment, averageLevel = 0) {
    transaction(this.database, () => {
      this.database
        .prepare(
          `INSERT INTO audio_evidence (
            id, workday_id, source, started_at, duration_ms, average_level, status, transcript, media_playback_json,
            capture_epoch_id, capture_sequence, captured_sample_count, capture_sample_time, capture_outcome
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            status = excluded.status,
            transcript = excluded.transcript,
            average_level = excluded.average_level,
            media_playback_json = excluded.media_playback_json,
            capture_epoch_id = excluded.capture_epoch_id,
            capture_sequence = excluded.capture_sequence,
            captured_sample_count = excluded.captured_sample_count,
            capture_sample_time = excluded.capture_sample_time,
            capture_outcome = excluded.capture_outcome`
        )
        .run(
          moment.id,
          moment.sessionId,
          moment.source,
          moment.startedAt,
          moment.durationMs,
          averageLevel,
          moment.status,
          moment.transcript,
          moment.mediaPlayback ? JSON.stringify(moment.mediaPlayback) : null,
          moment.captureEpochId ?? null,
          moment.captureSequence ?? null,
          moment.capturedSampleCount ?? null,
          moment.captureSampleTime ?? null,
          moment.captureOutcome ?? 'pending'
        )
      this.indexAudio(moment)
      const linked = this.database
        .prepare(`SELECT id FROM speech_segment WHERE workday_id = ? AND source = ?
        AND (chunk_id = ? OR EXISTS (SELECT 1 FROM json_each(chunk_ids_json) WHERE value = ?))`)
        .all(moment.sessionId, moment.source, moment.id, moment.id)
      for (const segment of linked) this.proactive.enqueue('speech', String(segment.id), moment.sessionId)
    })
  }

  updateAudioMoment(sessionId: string, momentId: string, update: Partial<DailyReviewMoment>) {
    const current = this.database
      .prepare('SELECT * FROM audio_evidence WHERE id = ? AND workday_id = ?')
      .get(momentId, sessionId) as DatabaseRow | undefined
    if (!current) return
    const moment: DailyReviewMoment = {
      id: momentId,
      sessionId,
      source: stringValue(current.source) as DailyReviewMoment['source'],
      startedAt: numberValue(current.started_at),
      durationMs: numberValue(current.duration_ms),
      status: stringValue(current.status) as DailyReviewMoment['status'],
      transcript: stringValue(current.transcript),
      ...mediaPlaybackFromRow(current),
      ...(current.capture_epoch_id == null ? {} : { captureEpochId: stringValue(current.capture_epoch_id) }),
      ...(current.capture_sequence == null ? {} : { captureSequence: numberValue(current.capture_sequence) }),
      ...(current.captured_sample_count == null
        ? {}
        : { capturedSampleCount: numberValue(current.captured_sample_count) }),
      ...(current.capture_sample_time == null ? {} : { captureSampleTime: numberValue(current.capture_sample_time) }),
      captureOutcome: stringValue(current.capture_outcome) as DailyReviewMoment['captureOutcome'],
      ...update,
    }
    this.appendAudioMoment(moment, numberValue(current.average_level))
  }

  appendSpeechSegments(segments: SpeechSegment[]) {
    if (segments.length === 0) return
    const insert = this.database.prepare(
      `INSERT INTO speech_segment (
        id, workday_id, chunk_id, chunk_ids_json, source, started_at, ended_at, text,
        detected_language, accepted_language, rejection_reason, vad_started_at, vad_ended_at,
        asr_window_index, asr_window_count, transcription_outcome
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        chunk_ids_json = excluded.chunk_ids_json,
        text = excluded.text,
        detected_language = excluded.detected_language,
        accepted_language = excluded.accepted_language,
        rejection_reason = excluded.rejection_reason,
        vad_started_at = excluded.vad_started_at,
        vad_ended_at = excluded.vad_ended_at,
        asr_window_index = excluded.asr_window_index,
        asr_window_count = excluded.asr_window_count,
        transcription_outcome = excluded.transcription_outcome`
    )
    transaction(this.database, () => {
      for (const segment of segments) {
        insert.run(
          segment.id,
          segment.workdayId,
          segment.chunkId,
          JSON.stringify(segment.chunkIds ?? [segment.chunkId]),
          segment.source,
          segment.startedAt,
          segment.endedAt,
          segment.text,
          segment.detectedLanguage,
          segment.acceptedLanguage,
          segment.rejectionReason,
          segment.vadStartedAt ?? null,
          segment.vadEndedAt ?? null,
          segment.asrWindowIndex ?? 0,
          segment.asrWindowCount ?? 1,
          segment.transcriptionOutcome ?? 'transcribed'
        )
        if (!segment.rejectionReason && segment.transcriptionOutcome !== 'asr-empty') {
          this.ambientTasks.enqueue('speech', segment.id, segment.workdayId, segment.text, segment.endedAt)
          this.proactive.enqueue('speech', segment.id, segment.workdayId)
        }
      }
    })
  }

  listSpeechSegments(workdayId: string): SpeechSegment[] {
    const rows = this.database
      .prepare('SELECT * FROM speech_segment WHERE workday_id = ? ORDER BY started_at, id')
      .all(workdayId) as DatabaseRow[]
    return rows.map((row) => ({
      id: stringValue(row.id),
      workdayId,
      chunkId: stringValue(row.chunk_id),
      chunkIds: (() => {
        try {
          const value = JSON.parse(stringValue(row.chunk_ids_json)) as unknown
          return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string')
            ? value
            : [stringValue(row.chunk_id)]
        } catch {
          return [stringValue(row.chunk_id)]
        }
      })(),
      source: stringValue(row.source) as SpeechSegment['source'],
      startedAt: numberValue(row.started_at),
      endedAt: numberValue(row.ended_at),
      ...(row.vad_started_at == null ? {} : { vadStartedAt: numberValue(row.vad_started_at) }),
      ...(row.vad_ended_at == null ? {} : { vadEndedAt: numberValue(row.vad_ended_at) }),
      asrWindowIndex: numberValue(row.asr_window_index),
      asrWindowCount: numberValue(row.asr_window_count),
      transcriptionOutcome: stringValue(row.transcription_outcome) as SpeechSegment['transcriptionOutcome'],
      text: stringValue(row.text),
      detectedLanguage: row.detected_language == null ? null : stringValue(row.detected_language),
      acceptedLanguage:
        row.accepted_language == null
          ? null
          : (stringValue(row.accepted_language) as SpeechSegment['acceptedLanguage']),
      rejectionReason:
        row.rejection_reason == null ? null : (stringValue(row.rejection_reason) as SpeechSegment['rejectionReason']),
    }))
  }

  promoteQuarantinedSpeechSegments(
    workdayId: string,
    source: SpeechSegment['source'],
    language: 'nl' | 'en',
    at: number
  ) {
    const from = at - 2 * 60_000
    const rows = this.database
      .prepare(
        `SELECT id, chunk_id, text, ended_at FROM speech_segment
         WHERE workday_id = ? AND source = ? AND started_at >= ? AND started_at <= ?
           AND rejection_reason IN ('cross-language-short', 'cross-language-unconfirmed')
           AND lower(substr(detected_language, 1, 2)) = ?`
      )
      .all(workdayId, source, from, at, language) as DatabaseRow[]
    transaction(this.database, () => {
      this.database
        .prepare(
          `UPDATE speech_segment
         SET accepted_language = ?, rejection_reason = NULL
         WHERE workday_id = ? AND source = ? AND started_at >= ? AND started_at <= ?
           AND rejection_reason IN ('cross-language-short', 'cross-language-unconfirmed')
           AND lower(substr(detected_language, 1, 2)) = ?`
        )
        .run(language, workdayId, source, from, at, language)
      for (const row of rows) {
        this.ambientTasks.enqueue(
          'speech',
          stringValue(row.id),
          workdayId,
          stringValue(row.text),
          numberValue(row.ended_at)
        )
        this.proactive.enqueue('speech', stringValue(row.id), workdayId)
      }
    })
    return [...new Set(rows.map((row) => stringValue(row.chunk_id)))]
  }

  appendCallSignal(signal: CallSignal) {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO call_signal
         (id, workday_id, provider, surface_key, state, observed_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(signal.id, signal.workdayId, signal.provider, signal.surfaceKey, signal.state, signal.observedAt)
  }

  listCallSignals(workdayId: string): CallSignal[] {
    const rows = this.database
      .prepare('SELECT * FROM call_signal WHERE workday_id = ? ORDER BY observed_at, id')
      .all(workdayId) as DatabaseRow[]
    return rows.map((row) => ({
      id: stringValue(row.id),
      workdayId,
      provider: stringValue(row.provider),
      surfaceKey: stringValue(row.surface_key),
      state: stringValue(row.state) as CallSignal['state'],
      observedAt: numberValue(row.observed_at),
    }))
  }

  createManualMeeting(
    workdayId: string,
    title: string,
    startedAt: number,
    confirmedAt = startedAt,
    availableFromAt = startedAt,
    systemAudioAvailable = true
  ): ManualMeeting {
    const id = randomUUID()
    this.database
      .prepare(
        `INSERT INTO manual_meeting (
           id, workday_id, title, notes, started_at, confirmed_at, available_from_at,
           ended_at, system_audio_available, status
         ) VALUES (?, ?, ?, '', ?, ?, ?, NULL, ?, 'recording')`
      )
      .run(
        id,
        workdayId,
        title.trim(),
        startedAt,
        Math.max(startedAt, confirmedAt),
        Math.min(startedAt, availableFromAt),
        systemAudioAvailable ? 1 : 0
      )
    return this.requireManualMeeting(id)
  }

  markManualMeetingSystemAudioAvailable(id: string): ManualMeeting {
    this.database
      .prepare("UPDATE manual_meeting SET system_audio_available = 1 WHERE id = ? AND status = 'recording'")
      .run(id)
    return this.requireManualMeeting(id)
  }

  updateManualMeetingDetails(id: string, title: string, notes: string): ManualMeeting {
    const meeting = this.requireManualMeeting(id)
    if (meeting.status !== 'recording') throw new Error('manual-meeting-not-active')
    if (typeof title !== 'string' || title.length > 120 || typeof notes !== 'string' || notes.length > 100_000)
      throw new Error('invalid-meeting-details')
    this.database
      .prepare('UPDATE manual_meeting SET title = ?, notes = ? WHERE id = ?')
      .run(title.trim() || 'Nieuw gesprek', notes, id)
    return this.requireManualMeeting(id)
  }

  updateManualMeetingStart(id: string, startedAt: number): ManualMeeting {
    const meeting = this.requireManualMeeting(id)
    if (meeting.status !== 'recording') throw new Error('manual-meeting-not-active')
    const availableFromAt = meeting.availableFromAt ?? meeting.startedAt
    const confirmedAt = meeting.confirmedAt ?? meeting.startedAt
    if (!Number.isFinite(startedAt) || startedAt < availableFromAt || startedAt > confirmedAt) {
      throw new Error('manual-meeting-start-invalid')
    }
    this.database.prepare('UPDATE manual_meeting SET started_at = ? WHERE id = ?').run(startedAt, id)
    return this.requireManualMeeting(id)
  }

  finishManualMeeting(id: string, endedAt: number, automaticRevinoteProcessingBlocked = false): ManualMeeting {
    const meeting = this.requireManualMeeting(id)
    const finishedAt = Math.max(meeting.startedAt, meeting.pausedAt ?? 0, endedAt)
    const pausedMs = meeting.pausedMs + (meeting.pausedAt == null ? 0 : finishedAt - meeting.pausedAt)
    this.database
      .prepare(
        `UPDATE manual_meeting
         SET ended_at = ?, paused_at = NULL, paused_ms = ?, status = 'processing',
             automatic_revinote_processing_blocked = MAX(automatic_revinote_processing_blocked, ?)
         WHERE id = ?`
      )
      .run(finishedAt, pausedMs, automaticRevinoteProcessingBlocked ? 1 : 0, id)
    return this.requireManualMeeting(id)
  }

  completeManualMeeting(id: string): ManualMeeting {
    this.database.prepare("UPDATE manual_meeting SET status = 'completed' WHERE id = ?").run(id)
    return this.requireManualMeeting(id)
  }

  setManualMeetingEpisode(id: string, episodeId: string): ManualMeeting {
    this.database.prepare('UPDATE manual_meeting SET episode_id = ? WHERE id = ?').run(episodeId, id)
    return this.requireManualMeeting(id)
  }

  pauseManualMeeting(id: string, pausedAt: number): ManualMeeting {
    const meeting = this.requireManualMeeting(id)
    if (meeting.pausedAt != null) return meeting
    const startedAt = Math.max(meeting.startedAt, pausedAt)
    this.database.prepare('UPDATE manual_meeting SET paused_at = ? WHERE id = ?').run(startedAt, id)
    return this.requireManualMeeting(id)
  }

  resumeManualMeeting(id: string, resumedAt: number): ManualMeeting {
    const meeting = this.requireManualMeeting(id)
    if (meeting.pausedAt == null) return meeting
    const endedAt = Math.max(meeting.pausedAt, resumedAt)
    const pausedMs = meeting.pausedMs + endedAt - meeting.pausedAt
    this.database.prepare('UPDATE manual_meeting SET paused_at = NULL, paused_ms = ? WHERE id = ?').run(pausedMs, id)
    return this.requireManualMeeting(id)
  }

  discardManualMeeting(id: string, discardedAt: number): ManualMeeting {
    const meeting = this.requireManualMeeting(id)
    if (meeting.status !== 'recording') throw new Error('manual-meeting-not-active')
    const endedAt = Math.max(meeting.startedAt, discardedAt)
    transaction(this.database, () => {
      this.database
        .prepare(
          `DELETE FROM evidence_fts
           WHERE kind = 'audio' AND evidence_id IN (
             SELECT id FROM audio_evidence
             WHERE workday_id = ? AND started_at < ? AND started_at + duration_ms > ?
           )`
        )
        .run(meeting.workdayId, endedAt, meeting.startedAt)
      this.database
        .prepare(
          `DELETE FROM speech_segment
           WHERE workday_id = ? AND started_at < ? AND ended_at > ?`
        )
        .run(meeting.workdayId, endedAt, meeting.startedAt)
      this.database
        .prepare(
          `DELETE FROM audio_evidence
           WHERE workday_id = ? AND started_at < ? AND started_at + duration_ms > ?`
        )
        .run(meeting.workdayId, endedAt, meeting.startedAt)
      this.database
        .prepare('DELETE FROM call_signal WHERE workday_id = ? AND surface_key = ?')
        .run(meeting.workdayId, `manual:${id}`)
      this.database
        .prepare(
          `DELETE FROM conversation_episode
           WHERE workday_id = ? AND started_at < ? AND ended_at > ?`
        )
        .run(meeting.workdayId, endedAt, meeting.startedAt)
      this.database.prepare('DELETE FROM manual_meeting WHERE id = ?').run(id)
      this.advanceDeletionRevision()
    })
    this.emitEvidenceDeletion()
    return meeting
  }

  activeManualMeeting(): ManualMeeting | null {
    const row = this.database
      .prepare("SELECT * FROM manual_meeting WHERE status = 'recording' ORDER BY started_at DESC LIMIT 1")
      .get() as DatabaseRow | undefined
    return row ? this.hydrateManualMeeting(row) : null
  }

  processingManualMeeting(): ManualMeeting | null {
    const row = this.database
      .prepare("SELECT * FROM manual_meeting WHERE status = 'processing' ORDER BY started_at DESC LIMIT 1")
      .get() as DatabaseRow | undefined
    return row ? this.hydrateManualMeeting(row) : null
  }

  processingManualMeetings(): ManualMeeting[] {
    const rows = this.database
      .prepare("SELECT * FROM manual_meeting WHERE status = 'processing' ORDER BY started_at")
      .all() as DatabaseRow[]
    return rows.map((row) => this.hydrateManualMeeting(row))
  }

  listManualMeetings(workdayId: string): ManualMeeting[] {
    return (
      this.database
        .prepare('SELECT * FROM manual_meeting WHERE workday_id = ? ORDER BY started_at')
        .all(workdayId) as DatabaseRow[]
    ).map((row) => this.hydrateManualMeeting(row))
  }

  beginOfflinePeriod(startedAt = Date.now()) {
    const active = this.database.prepare('SELECT id FROM offline_period WHERE ended_at IS NULL LIMIT 1').get()
    if (active) return false
    this.database
      .prepare('INSERT INTO offline_period (id, started_at, ended_at) VALUES (?, ?, NULL)')
      .run(randomUUID(), startedAt)
    return true
  }

  endOfflinePeriod(endedAt = Date.now()) {
    const result = this.database
      .prepare('UPDATE offline_period SET ended_at = MAX(started_at, ?) WHERE ended_at IS NULL')
      .run(endedAt)
    return result.changes > 0
  }

  wasOfflineAt(timestamp: number) {
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 FROM offline_period
           WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)
           LIMIT 1`
        )
        .get(timestamp, timestamp)
    )
  }

  syncConversationEpisodes(workdayId: string, episodes: ConversationEpisode[]) {
    const upsert = this.database.prepare(
      `INSERT INTO conversation_episode (
        id, workday_id, started_at, ended_at, state, surface_key, provider,
        boundary_reason, segment_ids_json, deleted_at, automatic_revinote_processing_blocked
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        ended_at = excluded.ended_at,
        state = excluded.state,
        surface_key = excluded.surface_key,
        provider = excluded.provider,
        boundary_reason = excluded.boundary_reason,
        segment_ids_json = excluded.segment_ids_json,
        deleted_at = COALESCE(conversation_episode.deleted_at, excluded.deleted_at),
        automatic_revinote_processing_blocked = MAX(
          conversation_episode.automatic_revinote_processing_blocked,
          excluded.automatic_revinote_processing_blocked
        )
      WHERE conversation_episode.state <> 'final'`
    )
    transaction(this.database, () => {
      this.database
        .prepare("DELETE FROM conversation_episode WHERE workday_id = ? AND state = 'provisional'")
        .run(workdayId)
      for (const episode of episodes) {
        upsert.run(
          episode.id,
          workdayId,
          episode.startedAt,
          episode.endedAt,
          episode.state,
          episode.surfaceKey,
          episode.provider,
          episode.boundaryReason,
          JSON.stringify(episode.segmentIds),
          episode.deletedAt,
          episode.automaticRevinoteProcessingBlocked ? 1 : 0
        )
      }
    })
  }

  upsertManualMeetingEpisode(episode: ConversationEpisode) {
    if (!episode.surfaceKey?.startsWith('manual:') || episode.state !== 'final') {
      throw new Error('manual-meeting-episode-invalid')
    }
    transaction(this.database, () => {
      const source = this.database
        .prepare(
          `SELECT MAX(automatic_revinote_processing_blocked) AS blocked
           FROM conversation_episode
           WHERE workday_id = ? AND surface_key = ? AND deleted_at IS NULL`
        )
        .get(episode.workdayId, episode.surfaceKey) as DatabaseRow
      const automaticRevinoteProcessingBlocked =
        episode.automaticRevinoteProcessingBlocked || numberValue(source.blocked ?? 0) === 1
      this.database
        .prepare(
          `UPDATE conversation_episode
           SET deleted_at = ?
           WHERE workday_id = ? AND id <> ? AND deleted_at IS NULL
             AND started_at < ? AND ended_at > ?`
        )
        .run(episode.endedAt, episode.workdayId, episode.id, episode.endedAt, episode.startedAt)
      this.database
        .prepare(
          `INSERT INTO conversation_episode (
            id, workday_id, started_at, ended_at, state, surface_key, provider,
            boundary_reason, segment_ids_json, deleted_at, automatic_revinote_processing_blocked
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
          ON CONFLICT(id) DO UPDATE SET
            started_at = excluded.started_at,
            ended_at = excluded.ended_at,
            state = excluded.state,
            surface_key = excluded.surface_key,
            provider = excluded.provider,
            boundary_reason = excluded.boundary_reason,
            segment_ids_json = excluded.segment_ids_json,
            deleted_at = NULL,
            automatic_revinote_processing_blocked = MAX(
              conversation_episode.automatic_revinote_processing_blocked,
              excluded.automatic_revinote_processing_blocked
            )`
        )
        .run(
          episode.id,
          episode.workdayId,
          episode.startedAt,
          episode.endedAt,
          episode.state,
          episode.surfaceKey,
          episode.provider,
          episode.boundaryReason,
          JSON.stringify(episode.segmentIds),
          automaticRevinoteProcessingBlocked ? 1 : 0
        )
    })
    return this.listConversationEpisodes(episode.workdayId).find((candidate) => candidate.id === episode.id) ?? null
  }

  listConversationEpisodes(workdayId: string, options: { recoverableAfter?: number } = {}): ConversationEpisode[] {
    const recoveryFilter =
      options.recoverableAfter == null
        ? ''
        : "AND conversation_episode.deleted_at IS NULL AND (conversation_episode.state = 'provisional' OR conversation_episode.ended_at > ?)"
    const rows = this.database
      .prepare(
        `SELECT conversation_episode.*, conversation_episode_decision.decision AS user_decision
         FROM conversation_episode
         LEFT JOIN conversation_episode_decision ON conversation_episode_decision.episode_id = conversation_episode.id
         WHERE conversation_episode.workday_id = ?
         ${recoveryFilter}
         ORDER BY conversation_episode.started_at, conversation_episode.id`
      )
      .all(workdayId, ...(options.recoverableAfter == null ? [] : [options.recoverableAfter])) as DatabaseRow[]
    return rows.map((row) => {
      let segmentIds: string[] = []
      try {
        const parsed = JSON.parse(stringValue(row.segment_ids_json)) as unknown
        if (Array.isArray(parsed)) segmentIds = parsed.filter((value): value is string => typeof value === 'string')
      } catch {
        // A malformed derived row is repaired on the next episode sync.
      }
      return {
        id: stringValue(row.id),
        workdayId,
        startedAt: numberValue(row.started_at),
        endedAt: numberValue(row.ended_at),
        state: stringValue(row.state) as ConversationEpisode['state'],
        surfaceKey: row.surface_key == null ? null : stringValue(row.surface_key),
        provider: row.provider == null ? null : stringValue(row.provider),
        boundaryReason: stringValue(row.boundary_reason) as ConversationEpisode['boundaryReason'],
        segmentIds,
        deletedAt: nullableNumber(row.deleted_at),
        automaticRevinoteProcessingBlocked: numberValue(row.automatic_revinote_processing_blocked) === 1,
        userDecision:
          row.user_decision == null ? null : (stringValue(row.user_decision) as ConversationEpisode['userDecision']),
      }
    })
  }

  decideConversationEpisode(episodeId: string, decision: 'confirmed' | 'dismissed', decidedAt = Date.now()) {
    const episode = this.database.prepare('SELECT id FROM conversation_episode WHERE id = ?').get(episodeId)
    if (!episode) throw new Error('conversation-episode-not-found')
    this.database
      .prepare(
        `INSERT INTO conversation_episode_decision (episode_id, decision, decided_at)
         VALUES (?, ?, ?)
         ON CONFLICT(episode_id) DO UPDATE SET decision = excluded.decision, decided_at = excluded.decided_at`
      )
      .run(episodeId, decision, decidedAt)
  }

  deleteConversationEpisode(episodeId: string, deletedAt = Date.now()) {
    transaction(this.database, () => {
      this.database.prepare('UPDATE conversation_episode SET deleted_at = ? WHERE id = ?').run(deletedAt, episodeId)
      this.advanceDeletionRevision()
    })
    this.emitEvidenceDeletion()
  }

  mergeConversationEpisodes(mergedEpisode: ConversationEpisode, sourceEpisodeIds: string[], deletedAt = Date.now()) {
    const sourceIds = [...new Set(sourceEpisodeIds)]
    if (sourceIds.length < 2) throw new Error('conversation-merge-needs-two-sources')
    transaction(this.database, () => {
      const placeholders = sourceIds.map(() => '?').join(', ')
      const sources = this.database
        .prepare(
          `SELECT id, automatic_revinote_processing_blocked FROM conversation_episode
           WHERE workday_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`
        )
        .all(mergedEpisode.workdayId, ...sourceIds) as DatabaseRow[]
      if (sources.length !== sourceIds.length) throw new Error('conversation-merge-source-not-found')
      const automaticRevinoteProcessingBlocked =
        mergedEpisode.automaticRevinoteProcessingBlocked ||
        sources.some((source) => numberValue(source.automatic_revinote_processing_blocked) === 1)
      this.database
        .prepare(
          `INSERT INTO conversation_episode (
            id, workday_id, started_at, ended_at, state, surface_key, provider,
            boundary_reason, segment_ids_json, deleted_at, automatic_revinote_processing_blocked
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          mergedEpisode.id,
          mergedEpisode.workdayId,
          mergedEpisode.startedAt,
          mergedEpisode.endedAt,
          mergedEpisode.state,
          mergedEpisode.surfaceKey,
          mergedEpisode.provider,
          mergedEpisode.boundaryReason,
          JSON.stringify(mergedEpisode.segmentIds),
          mergedEpisode.deletedAt,
          automaticRevinoteProcessingBlocked ? 1 : 0
        )
      const sourceReferences = sourceIds.map((episodeId) => `episode:${episodeId}`)
      this.database
        .prepare(
          `UPDATE work_item_source
           SET conversation_reference = ?
           WHERE workday_id = ? AND conversation_reference IN (${placeholders})`
        )
        .run(`episode:${mergedEpisode.id}`, mergedEpisode.workdayId, ...sourceReferences)
      this.database
        .prepare(`UPDATE conversation_episode SET deleted_at = ? WHERE id IN (${placeholders})`)
        .run(deletedAt, ...sourceIds)
    })
  }

  listEpisodeAnalyses(workdayId: string): PersistedEpisodeAnalysis[] {
    const rows = this.database
      .prepare('SELECT * FROM episode_analysis WHERE workday_id = ? ORDER BY started_at, id')
      .all(workdayId) as DatabaseRow[]
    return rows.map((row) => {
      let actionPoints: string[] = []
      try {
        const parsed = JSON.parse(stringValue(row.action_points_json)) as unknown
        if (Array.isArray(parsed)) actionPoints = parsed.filter((value): value is string => typeof value === 'string')
      } catch {
        // Invalid cached output is treated as having no action points.
      }
      return {
        id: stringValue(row.id),
        episodeId: stringValue(row.episode_id),
        workdayId,
        startedAt: numberValue(row.started_at),
        endedAt: numberValue(row.ended_at),
        classification: stringValue(row.classification) as PersistedEpisodeAnalysis['classification'],
        confidence: stringValue(row.confidence) as PersistedEpisodeAnalysis['confidence'],
        reason: stringValue(row.reason),
        title: stringValue(row.title),
        description: stringValue(row.description),
        summary: stringValue(row.summary),
        actionPoints,
        sourceHash: stringValue(row.source_hash),
        provider: stringValue(row.provider) as PersistedEpisodeAnalysis['provider'],
        model: stringValue(row.model),
        promptVersion: numberValue(row.prompt_version),
        schemaVersion: numberValue(row.schema_version),
        generatedAt: numberValue(row.generated_at),
      }
    })
  }

  upsertEpisodeAnalysis(analysis: PersistedEpisodeAnalysis) {
    this.database
      .prepare(
        `INSERT INTO episode_analysis (
          id, episode_id, workday_id, started_at, ended_at, classification, confidence, reason,
          title, description, summary, action_points_json, source_hash, provider, model,
          prompt_version, schema_version, generated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(episode_id, source_hash, provider, model, prompt_version, schema_version) DO UPDATE SET
          classification = excluded.classification,
          confidence = excluded.confidence,
          reason = excluded.reason,
          title = excluded.title,
          description = excluded.description,
          summary = excluded.summary,
          action_points_json = excluded.action_points_json,
          generated_at = excluded.generated_at`
      )
      .run(
        analysis.id,
        analysis.episodeId,
        analysis.workdayId,
        analysis.startedAt,
        analysis.endedAt,
        analysis.classification,
        analysis.confidence,
        analysis.reason,
        analysis.title,
        analysis.description,
        analysis.summary,
        JSON.stringify(analysis.actionPoints),
        analysis.sourceHash,
        analysis.provider,
        analysis.model,
        analysis.promptVersion,
        analysis.schemaVersion,
        analysis.generatedAt
      )
  }

  appendContextMoment(
    sessionId: string,
    moment: DailyReviewContextMoment,
    focusSegmentId: string | null,
    bundleId = ''
  ) {
    const applicationId = this.applicationId(moment.appName, bundleId)
    const hash = createHash('sha256')
      .update(
        JSON.stringify([
          moment.timestamp,
          applicationId,
          moment.windowTitle,
          moment.url ?? '',
          moment.focusedElement ?? null,
          moment.text,
          moment.textSource,
          moment.trigger,
        ])
      )
      .digest('hex')
    let inserted = false
    transaction(this.database, () => {
      const result = this.database
        .prepare(
          `INSERT OR IGNORE INTO context_evidence (
            id, workday_id, application_id, focus_segment_id, timestamp, window_title, url, focused_element_json,
            text, text_source, trigger, monitor_name, content_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          moment.id,
          sessionId,
          applicationId,
          focusSegmentId,
          moment.timestamp,
          moment.windowTitle,
          moment.url ?? '',
          moment.focusedElement ? JSON.stringify(moment.focusedElement) : null,
          moment.text,
          moment.textSource,
          moment.trigger,
          moment.monitorName,
          hash
        )
      if (result.changes === 0) return
      this.database
        .prepare(
          `INSERT INTO evidence_fts (
            kind, evidence_id, workday_id, application, window_title, text
          ) VALUES ('context', ?, ?, ?, ?, ?)`
        )
        .run(
          moment.id,
          sessionId,
          moment.appName,
          moment.windowTitle,
          [moment.url?.trim(), focusedElementText(moment), moment.text].filter(Boolean).join('\n')
        )
      inserted = true
      this.ambientTasks.enqueue('context', moment.id, sessionId, moment.text, moment.timestamp)
      this.proactive.enqueue('context', moment.id, sessionId)
    })
    return inserted
  }

  upsertAppActivity(sessionId: string, activity: DailyReviewAppActivity) {
    const applicationId = this.applicationId(activity.appName, activity.bundleId)
    this.database
      .prepare(
        `INSERT INTO focus_segment (id, workday_id, application_id, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET ended_at = excluded.ended_at`
      )
      .run(activity.id, sessionId, applicationId, activity.startedAt, activity.endedAt)
  }

  deleteSession(sessionId: string) {
    transaction(this.database, () => {
      const reference = this.database
        .prepare("SELECT json_extract(memory_json, '$._analysisProvenanceRef') AS reference FROM workday WHERE id = ?")
        .get(sessionId)?.reference
      this.database.prepare('DELETE FROM evidence_fts WHERE workday_id = ?').run(sessionId)
      this.database.prepare('DELETE FROM workday WHERE id = ?').run(sessionId)
      pruneWorkdayProvenance(this.database, reference)
      this.advanceDeletionRevision()
    })
    this.emitEvidenceDeletion()
  }

  deleteEvidenceSince(cutoff: number) {
    const affectedRows = this.database
      .prepare(
        `SELECT id FROM workday
         WHERE EXISTS (SELECT 1 FROM context_evidence WHERE workday_id = workday.id AND timestamp >= ?)
            OR EXISTS (
              SELECT 1 FROM audio_evidence
              WHERE workday_id = workday.id AND started_at + duration_ms > ?
            )
            OR EXISTS (
              SELECT 1 FROM speech_segment
              WHERE workday_id = workday.id AND ended_at > ?
            )
            OR EXISTS (
              SELECT 1 FROM focus_segment
              WHERE workday_id = workday.id AND (started_at >= ? OR ended_at IS NULL OR ended_at > ?)
            )
            OR EXISTS (
              SELECT 1 FROM manual_meeting
              WHERE workday_id = workday.id AND (ended_at IS NULL OR ended_at > ?)
            )`
      )
      .all(cutoff, cutoff, cutoff, cutoff, cutoff, cutoff) as DatabaseRow[]
    const affectedIds = affectedRows.map((row) => stringValue(row.id))
    if (!affectedIds.length) return []

    transaction(this.database, () => {
      this.database
        .prepare(
          `DELETE FROM evidence_fts
           WHERE kind = 'context' AND evidence_id IN (
             SELECT id FROM context_evidence WHERE timestamp >= ?
           )`
        )
        .run(cutoff)
      this.database
        .prepare(
          `DELETE FROM evidence_fts
           WHERE kind = 'audio' AND evidence_id IN (
             SELECT id FROM audio_evidence WHERE started_at + duration_ms > ?
           )`
        )
        .run(cutoff)
      this.database.prepare('DELETE FROM context_evidence WHERE timestamp >= ?').run(cutoff)
      this.database.prepare('DELETE FROM ambient_task_evidence WHERE observed_at >= ?').run(cutoff)
      this.database.prepare('DELETE FROM call_signal WHERE observed_at >= ?').run(cutoff)
      this.database
        .prepare(
          `DELETE FROM call_signal
           WHERE surface_key IN (
             SELECT 'manual:' || id FROM manual_meeting
             WHERE ended_at IS NULL OR ended_at > ?
           )`
        )
        .run(cutoff)
      this.database.prepare('DELETE FROM speech_segment WHERE ended_at > ?').run(cutoff)
      this.database.prepare('DELETE FROM audio_evidence WHERE started_at + duration_ms > ?').run(cutoff)
      this.database.prepare('DELETE FROM conversation_episode WHERE ended_at > ?').run(cutoff)
      this.database.prepare('DELETE FROM focus_segment WHERE started_at >= ?').run(cutoff)
      this.database
        .prepare('UPDATE focus_segment SET ended_at = ? WHERE ended_at IS NULL OR ended_at > ?')
        .run(cutoff, cutoff)
      this.database.prepare('DELETE FROM manual_meeting WHERE ended_at IS NULL OR ended_at > ?').run(cutoff)
      const removeArtifacts = this.database.prepare('DELETE FROM artifact WHERE workday_id = ?')
      // Upgraded archives can still hold captured content from the removed Skills feature.
      const removeLegacySkills = this.database
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'timeline_skill_request'")
        .get()
        ? this.database.prepare('DELETE FROM timeline_skill_request WHERE workday_id = ?')
        : null
      for (const sessionId of affectedIds) {
        removeArtifacts.run(sessionId)
        removeLegacySkills?.run(sessionId)
      }
      this.advanceDeletionRevision()
    })
    this.emitEvidenceDeletion()
    return affectedIds
  }

  readSessionHeaders() {
    const rows = this.database
      .prepare('SELECT id,local_day,started_at,ended_at FROM workday ORDER BY started_at DESC')
      .all() as DatabaseRow[]
    return rows.map((row) => ({
      id: stringValue(row.id),
      localDay: stringValue(row.local_day),
      startedAt: numberValue(row.started_at),
      endedAt: nullableNumber(row.ended_at),
    }))
  }

  readConversationSessions(localDay?: string) {
    const rows = this.database
      .prepare(`SELECT * FROM workday ${localDay === undefined ? '' : 'WHERE local_day=?'} ORDER BY started_at DESC`)
      .all(...(localDay === undefined ? [] : [localDay])) as DatabaseRow[]
    return rows.map((row) => ({
      id: stringValue(row.id),
      localDay: stringValue(row.local_day),
      startedAt: numberValue(row.started_at),
      memory: this.readMemory(row),
    }))
  }

  readSessions(): DailyReviewSession[] {
    const workdays = this.database.prepare('SELECT * FROM workday ORDER BY started_at DESC').all() as DatabaseRow[]
    return workdays.map((row) => {
      const id = stringValue(row.id)
      return {
        id,
        localDay: stringValue(row.local_day),
        startedAt: numberValue(row.started_at),
        endedAt: nullableNumber(row.ended_at),
        activeDurationMs: numberValue(row.active_duration_ms),
        moments: this.readAudioMoments(id),
        appActivity: this.readAppActivity(id),
        contextMoments: this.database
          .prepare(`SELECT c.id, c.timestamp, a.bundle_id
          FROM context_evidence c JOIN application a ON a.id = c.application_id
          WHERE c.workday_id = ? ORDER BY c.timestamp`)
          .all(id)
          .map((row) => ({
            id: stringValue(row.id),
            timestamp: numberValue(row.timestamp),
            bundleId: stringValue(row.bundle_id),
          })),
        memory: this.readMemory(row),
        refresh: this.readRefresh(row),
      }
    })
  }

  readTaskContextEvidence(workdayId: string, observedAt: number) {
    this.taskContextStatement ??= this.database.prepare(
      `SELECT c.window_title, c.url, a.display_name, a.bundle_id
         FROM context_evidence c
         JOIN application a ON a.id = c.application_id
         WHERE c.workday_id = ? AND c.timestamp = ?`
    )
    const rows = this.taskContextStatement.all(workdayId, observedAt) as DatabaseRow[]
    return rows.map((row) => ({
      kind: 'context' as const,
      appName: stringValue(row.display_name),
      bundleId: stringValue(row.bundle_id),
      windowTitle: stringValue(row.window_title),
      url: stringValue(row.url) || undefined,
      text: '',
    }))
  }

  async readAnalysisEvidence(sessionId: string): Promise<AnalysisEvidenceEntry[]> {
    const appPeriods = this.database
      .prepare(
        `SELECT s.id, s.started_at, s.ended_at, a.display_name, a.bundle_id
         FROM focus_segment s
         JOIN application a ON a.id = s.application_id
         WHERE s.workday_id = ?
         ORDER BY s.started_at`
      )
      .all(sessionId) as DatabaseRow[]
    const context: AnalysisEvidenceEntry[] = []
    for await (const batch of this.contextEvidenceBatches(sessionId)) {
      context.push(
        ...batch
          .filter((row) => !isNonWorkApplication(stringValue(row.display_name), stringValue(row.bundle_id)))
          .map((row) => ({
            evidenceId: stringValue(row.id),
            timestamp: numberValue(row.timestamp),
            kind: 'screen-context' as const,
            app: stringValue(row.display_name),
            bundleId: stringValue(row.bundle_id),
            window: stringValue(row.window_title),
            url: stringValue(row.url) || undefined,
            ...focusedElementFromRow(row),
            source: stringValue(row.text_source),
            text: stringValue(row.text),
          }))
      )
    }
    const audio = this.database
      .prepare(
        `SELECT 'speech:' || s.id AS evidence_id, s.started_at, s.ended_at, s.source, s.text AS transcript
         FROM speech_segment s
         WHERE s.workday_id = ? AND s.rejection_reason IS NULL AND s.text <> ''
         UNION ALL
         SELECT 'audio:' || a.id AS evidence_id, a.started_at, a.started_at + a.duration_ms AS ended_at, a.source, a.transcript
         FROM audio_evidence a
         WHERE a.workday_id = ? AND a.status = 'ready' AND a.transcript <> ''
           AND NOT EXISTS (SELECT 1 FROM speech_segment s WHERE s.chunk_id = a.id)
         ORDER BY started_at`
      )
      .all(sessionId, sessionId) as DatabaseRow[]

    return [
      ...appPeriods
        .filter((row) => !isNonWorkApplication(stringValue(row.display_name), stringValue(row.bundle_id)))
        .map((row) => ({
          evidenceId: `app:${stringValue(row.id)}`,
          timestamp: numberValue(row.started_at),
          endedAt: nullableNumber(row.ended_at),
          kind: 'app-period' as const,
          app: stringValue(row.display_name),
          bundleId: stringValue(row.bundle_id),
          text: '',
        })),
      ...context,
      ...audio.map((row) => ({
        evidenceId: stringValue(row.evidence_id),
        timestamp: numberValue(row.started_at),
        endedAt: numberValue(row.ended_at),
        kind: 'transcript' as const,
        source: stringValue(row.source),
        text: stringValue(row.transcript),
      })),
    ].sort((first, second) => first.timestamp - second.timestamp)
  }

  search(query: string, limit = 50) {
    const match = ftsMatchQuery(query)
    if (!match) return []
    return this.database
      .prepare(
        `SELECT kind, evidence_id, workday_id, application, window_title,
                snippet(evidence_fts, 5, '‹', '›', '…', 24) AS snippet
         FROM evidence_fts
         WHERE evidence_fts MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(match, limit)
  }

  recordArtifact(workdayId: string, kind: string, path: string, generatedAt: number) {
    const artifactId = `${kind}:${workdayId}`
    transaction(this.database, () => {
      this.database
        .prepare(
          `INSERT INTO artifact (id, workday_id, kind, path, generated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET path = excluded.path, generated_at = excluded.generated_at`
        )
        .run(artifactId, workdayId, kind, path, generatedAt)
      this.database.prepare('DELETE FROM artifact_source WHERE artifact_id = ?').run(artifactId)
      const insertSource = this.database.prepare(
        'INSERT INTO artifact_source (artifact_id, evidence_kind, evidence_id) VALUES (?, ?, ?)'
      )
      const contextRows = this.database
        .prepare('SELECT id FROM context_evidence WHERE workday_id = ?')
        .all(workdayId) as DatabaseRow[]
      const audioRows = this.database
        .prepare("SELECT id FROM audio_evidence WHERE workday_id = ? AND status = 'ready'")
        .all(workdayId) as DatabaseRow[]
      for (const row of contextRows) insertSource.run(artifactId, 'context', stringValue(row.id))
      for (const row of audioRows) insertSource.run(artifactId, 'audio', stringValue(row.id))
    })
  }

  private requireWorkItem(id: string) {
    const item = this.getWorkItem(id)
    if (!item) throw new Error('work-item-not-found')
    return item
  }

  private recoverInterruptedWorkItemAgentSessions() {
    const sessions = this.database
      .prepare(
        `SELECT id, work_item_id, started_at, updated_at
         FROM work_item_agent_session
         WHERE status = 'running' AND NOT EXISTS (
           SELECT 1 FROM work_item_host_receipt
           WHERE session_id = work_item_agent_session.id AND work_item_id = work_item_agent_session.work_item_id
         )
         ORDER BY started_at, id`
      )
      .all() as DatabaseRow[]
    if (sessions.length === 0) return

    const recoveredAt = Date.now()
    transaction(this.database, () => {
      for (const session of sessions) {
        const sessionId = stringValue(session.id)
        const itemId = stringValue(session.work_item_id)
        const completedAt = Math.max(recoveredAt, numberValue(session.started_at), numberValue(session.updated_at))
        const result = this.database
          .prepare(
            `UPDATE work_item_agent_session
             SET status = 'stale', updated_at = ?, completed_at = ?, duration_ms = MAX(0, ? - started_at)
             WHERE id = ? AND work_item_id = ? AND status = 'running'`
          )
          .run(completedAt, completedAt, completedAt, sessionId, itemId)
        if (Number(result.changes) === 0) continue

        this.insertWorkItemFact(
          itemId,
          'agent_failed',
          'system',
          'Agentsessie onderbroken door een herstart van Remember.',
          completedAt,
          sessionId,
          `${sessionId}:stale`
        )
        this.database
          .prepare(
            `UPDATE work_item
             SET attention = 'idle', updated_at = MAX(updated_at + 1, ?)
             WHERE id = ? AND attention = 'agent_running'`
          )
          .run(completedAt, itemId)
      }
    })
  }

  private requireManualMeeting(id: string) {
    const row = this.database.prepare('SELECT * FROM manual_meeting WHERE id = ?').get(id) as DatabaseRow | undefined
    if (!row) throw new Error('manual-meeting-not-found')
    return this.hydrateManualMeeting(row)
  }

  private hydrateManualMeeting(row: DatabaseRow): ManualMeeting {
    return {
      id: stringValue(row.id),
      workdayId: stringValue(row.workday_id),
      ...(row.episode_id ? { episodeId: stringValue(row.episode_id) } : {}),
      title: stringValue(row.title),
      notes: stringValue(row.notes),
      startedAt: numberValue(row.started_at),
      confirmedAt: numberValue(row.confirmed_at ?? row.started_at),
      availableFromAt: numberValue(row.available_from_at ?? row.started_at),
      endedAt: nullableNumber(row.ended_at),
      pausedAt: nullableNumber(row.paused_at),
      pausedMs: numberValue(row.paused_ms ?? 0),
      status: stringValue(row.status) as ManualMeeting['status'],
      automaticRevinoteProcessingBlocked: numberValue(row.automatic_revinote_processing_blocked ?? 0) === 1,
      systemAudioAvailable: numberValue(row.system_audio_available ?? 1) === 1,
    }
  }

  private insertWorkItemFact(
    itemId: string,
    type: WorkItemFact['type'],
    actor: WorkItemFact['actor'],
    summary: string,
    at: number,
    agentSessionId: string | null,
    id: string = randomUUID()
  ) {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO work_item_fact
         (id, work_item_id, type, actor, summary, at, agent_session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, itemId, type, actor, summary, at, agentSessionId)
  }

  private workItemRelations() {
    return {
      sources: this.database.prepare('SELECT * FROM work_item_source WHERE work_item_id = ? ORDER BY observed_at'),
      facts: this.database.prepare('SELECT * FROM work_item_fact WHERE work_item_id = ? ORDER BY at, id'),
      observations: this.database.prepare(
        'SELECT * FROM work_item_observation WHERE work_item_id = ? ORDER BY observed_at, id'
      ),
      sessions: this.database.prepare(
        'SELECT * FROM work_item_agent_session WHERE work_item_id = ? ORDER BY started_at, id'
      ),
    }
  }

  private hydrateWorkItem(row: DatabaseRow, relations = this.workItemRelations()): WorkItem {
    const id = stringValue(row.id)
    const sourceRows = relations.sources.all(id) as DatabaseRow[]
    const factRows = relations.facts.all(id) as DatabaseRow[]
    const observationRows = relations.observations.all(id) as DatabaseRow[]
    const sessionRows = relations.sessions.all(id) as DatabaseRow[]

    const sources: WorkItemSource[] = sourceRows.map((source) => ({
      id: stringValue(source.id),
      kind: stringValue(source.kind) as WorkItemSource['kind'],
      label: stringValue(source.label),
      detail: stringValue(source.detail),
      workdayId: source.workday_id == null ? null : stringValue(source.workday_id),
      conversationReference: source.conversation_reference == null ? null : stringValue(source.conversation_reference),
      conversationActionId: source.conversation_action_id == null ? null : stringValue(source.conversation_action_id),
      conversationStartTime:
        source.conversation_start_time == null ? null : stringValue(source.conversation_start_time),
      observedAt: numberValue(source.observed_at),
      confidence: source.confidence == null ? null : numberValue(source.confidence),
    }))
    const facts: WorkItemFact[] = factRows.map((fact) => ({
      id: stringValue(fact.id),
      type: stringValue(fact.type) as WorkItemFact['type'],
      actor: stringValue(fact.actor) as WorkItemFact['actor'],
      summary: stringValue(fact.summary),
      at: numberValue(fact.at),
      agentSessionId: fact.agent_session_id == null ? null : stringValue(fact.agent_session_id),
    }))
    const observations: WorkItemObservation[] = observationRows.map((observation) => ({
      id: stringValue(observation.id),
      kind: stringValue(observation.kind) as WorkItemObservation['kind'],
      summary: stringValue(observation.summary),
      confidence: numberValue(observation.confidence),
      workdayId: observation.workday_id == null ? null : stringValue(observation.workday_id),
      observedAt: numberValue(observation.observed_at),
      dismissedAt: nullableNumber(observation.dismissed_at),
    }))
    const agentSessions: WorkItemAgentSession[] = sessionRows.map((session) => ({
      id: stringValue(session.id),
      provider: stringValue(session.provider) as WorkItemAgentSession['provider'],
      status: stringValue(session.status) as WorkItemAgentSession['status'],
      instruction: stringValue(session.instruction),
      message: stringValue(session.message),
      response: stringValue(session.response),
      startedAt: numberValue(session.started_at),
      updatedAt: numberValue(session.updated_at),
      completedAt: nullableNumber(session.completed_at),
      durationMs: nullableNumber(session.duration_ms),
      steps: JSON.parse(stringValue(session.steps_json)) as WorkItemAgentSession['steps'],
    }))
    const completionUnresolved = observations.some(
      (observation) =>
        observation.kind === 'completion_candidate' &&
        observation.dismissedAt === null &&
        observation.observedAt >= Math.max(numberValue(row.day_synced_at), numberValue(row.lifecycle_updated_at))
    )

    return {
      id,
      title: stringValue(row.title),
      description: stringValue(row.description),
      prompt: completionUnresolved ? '' : stringValue(row.prompt),
      aiSuggestion: completionUnresolved ? null : stringValue(row.ai_suggestion) || null,
      context: stringValue(row.context),
      returnPoint: {
        lastMove: stringValue(row.return_last_move),
        unresolved: stringValue(row.return_unresolved),
        nextMove: stringValue(row.return_next_move),
      },
      lifecycle: stringValue(row.lifecycle) as WorkItem['lifecycle'],
      status: (stringValue(row.status) || 'todo') as WorkItem['status'],
      priority: (stringValue(row.priority) || 'none') as WorkItem['priority'],
      dueAt: nullableNumber(row.due_at),
      attention: stringValue(row.attention) as WorkItem['attention'],
      createdAt: numberValue(row.created_at),
      updatedAt: numberValue(row.updated_at),
      closedAt: nullableNumber(row.closed_at),
      userEditedTitle: numberValue(row.user_edited_title) === 1,
      userEditedDescription: numberValue(row.user_edited_description) === 1,
      sources,
      facts,
      observations,
      agentSessions,
    }
  }

  private migrateLegacyWorkItems() {
    const rows = this.database
      .prepare('SELECT id, memory_json, started_at FROM workday WHERE memory_json IS NOT NULL ORDER BY started_at')
      .all() as DatabaseRow[]

    for (const row of rows) {
      const workdayId = stringValue(row.id)
      let memory: DayMemory
      try {
        memory = readWorkdayMemory(this.database, stringValue(row.memory_json))
      } catch {
        continue
      }
      const records = dayTaskRecords(memory, numberValue(row.started_at))
      for (const record of records) {
        const observedAt = Math.max(memory.refreshedAt, record.updatedAt)
        const sourceReference = workItemConversationReference(memory, record.task.source?.conversationStartTime)
        const imported = this.database
          .prepare('SELECT work_item_id FROM legacy_work_item_import WHERE workday_id = ? AND legacy_record_id = ?')
          .get(workdayId, record.id) as DatabaseRow | undefined
        if (imported) continue

        const durableIdentity = this.database.prepare('SELECT id FROM work_item WHERE id = ?').get(record.id) as
          | DatabaseRow
          | undefined
        if (durableIdentity) {
          transaction(this.database, () => {
            this.database
              .prepare(
                `INSERT OR IGNORE INTO work_item_source
                 (id, work_item_id, kind, label, detail, workday_id, conversation_reference,
                  conversation_start_time, observed_at, confidence)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
              )
              .run(
                `${record.id}:source:${workdayId}`,
                record.id,
                record.task.source?.kind === 'conversation' ? 'meeting' : 'observed',
                record.task.source?.label ?? 'Daganalyse',
                record.task.source?.detail ?? 'Nieuwere context voor bestaand werk.',
                workdayId,
                sourceReference,
                record.task.source?.conversationStartTime ?? null,
                record.updatedAt
              )
            this.database
              .prepare(
                'INSERT INTO legacy_work_item_import (workday_id, legacy_record_id, work_item_id) VALUES (?, ?, ?)'
              )
              .run(workdayId, record.id, record.id)
          })
          continue
        }

        const itemId = `wi_${createHash('sha256').update(`${workdayId}:${record.id}`).digest('hex').slice(0, 24)}`
        const delegatedEvents = record.events.filter((event) => event.type === 'delegated')
        const lifecycle: WorkItemLifecycle =
          record.state === 'completed'
            ? 'completed'
            : record.state === 'superseded'
              ? 'superseded'
              : record.state === 'dismissed'
                ? 'abandoned'
                : record.state === 'removed' && delegatedEvents.length === 0
                  ? 'abandoned'
                  : 'open'
        const attention = 'idle'
        const closedAt = lifecycle === 'open' ? null : record.updatedAt
        const sourceKind: WorkItemSource['kind'] =
          record.task.source?.label === 'Handmatig toegevoegd'
            ? 'manual'
            : record.task.source?.kind === 'conversation'
              ? 'meeting'
              : record.task.source
                ? 'observed'
                : 'legacy'

        transaction(this.database, () => {
          this.database
            .prepare(
              `INSERT INTO work_item
               (id, title, description, prompt, context, return_last_move, return_unresolved, return_next_move,
                lifecycle, attention, created_at, updated_at, closed_at, user_edited_title, user_edited_description,
                day_synced_at, lifecycle_updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              itemId,
              record.task.title,
              record.task.description,
              record.task.prompt ?? '',
              record.task.context ?? '',
              record.task.returnPoint?.lastMove ?? '',
              record.task.returnPoint?.unresolved ?? '',
              record.task.returnPoint?.nextMove ?? '',
              lifecycle,
              attention,
              record.createdAt,
              record.updatedAt,
              closedAt,
              sourceKind === 'manual' ? 1 : 0,
              sourceKind === 'manual' && record.task.description ? 1 : 0,
              observedAt,
              observedAt
            )
          this.database
            .prepare(
              `INSERT INTO work_item_source
               (id, work_item_id, kind, label, detail, workday_id, conversation_reference,
                conversation_start_time, observed_at, confidence)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              `${itemId}:source`,
              itemId,
              sourceKind,
              record.task.source?.label ?? 'Eerdere daganalyse',
              record.task.source?.detail ?? 'Geimporteerd uit de bestaande daggebonden taakgeschiedenis.',
              workdayId,
              sourceReference,
              record.task.source?.conversationStartTime ?? null,
              record.createdAt,
              sourceKind === 'manual' ? null : 1
            )
          this.insertWorkItemFact(
            itemId,
            'created',
            sourceKind === 'manual' ? 'user' : 'system',
            sourceKind === 'manual' ? 'Handmatig als werkitem toegevoegd.' : 'Remember herkende dit als open werk.',
            record.createdAt,
            null,
            `${itemId}:created`
          )

          for (const event of record.events) {
            if (event.type === 'created') continue
            if (event.type === 'delegated' && event.provider && event.response) {
              const sessionId = `${itemId}:legacy-session:${event.id}`
              this.database
                .prepare(
                  `INSERT OR IGNORE INTO work_item_agent_session
                   (id, work_item_id, provider, status, instruction, message, response, started_at, updated_at, completed_at, duration_ms, steps_json)
                   VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?)`
                )
                .run(
                  sessionId,
                  itemId,
                  event.provider,
                  event.prompt ?? '',
                  event.message ?? '',
                  event.response,
                  event.at,
                  event.at + Math.max(0, event.durationMs ?? 0),
                  event.at + Math.max(0, event.durationMs ?? 0),
                  Math.max(0, event.durationMs ?? 0),
                  JSON.stringify(event.steps ?? [])
                )
              this.insertWorkItemFact(
                itemId,
                'agent_started',
                'user',
                `${event.provider === 'claude' ? 'Claude' : 'Codex'} gestart.`,
                event.at,
                sessionId,
                `${itemId}:fact:${event.id}:start`
              )
              this.insertWorkItemFact(
                itemId,
                'agent_completed',
                'agent',
                'Agent heeft een update geleverd.',
                event.at + Math.max(0, event.durationMs ?? 0),
                sessionId,
                `${itemId}:fact:${event.id}:complete`
              )
              continue
            }
            const mappedType: WorkItemFact['type'] | null =
              event.type === 'revised'
                ? 'edited'
                : event.type === 'dismissed' || event.type === 'removed'
                  ? 'abandoned'
                  : event.type === 'completed' || event.type === 'reopened' || event.type === 'superseded'
                    ? event.type
                    : null
            if (mappedType && !(mappedType === 'abandoned' && lifecycle === 'open'))
              this.insertWorkItemFact(
                itemId,
                mappedType,
                'system',
                event.reason,
                event.at,
                null,
                `${itemId}:fact:${event.id}`
              )
          }
          this.database
            .prepare(
              'INSERT INTO legacy_work_item_import (workday_id, legacy_record_id, work_item_id) VALUES (?, ?, ?)'
            )
            .run(workdayId, record.id, itemId)
        })
        this.syncLegacyWorkItemObservations(itemId, workdayId, record)
      }
    }
  }

  private syncLegacyWorkItemObservations(itemId: string, workdayId: string, record: DayTaskRecord) {
    this.database
      .prepare("DELETE FROM work_item_fact WHERE work_item_id = ? AND type = 'abandoned' AND id LIKE ?")
      .run(itemId, `${itemId}:fact:%`)
    let latestObservedAt = 0
    for (const event of record.events) {
      if (
        event.type !== 'revised' &&
        event.type !== 'removed' &&
        event.type !== 'completed' &&
        event.type !== 'superseded'
      ) {
        continue
      }
      const kind: WorkItemObservation['kind'] =
        event.type === 'completed'
          ? 'completion_candidate'
          : event.type === 'removed' && !/(bezig|behandeld|agent|delegat|uitvoer)/i.test(event.reason)
            ? 'blocked'
            : 'progress'
      const dedupeKey = `legacy:${workdayId}:${record.id}:${event.id}`
      this.database
        .prepare(
          `INSERT OR IGNORE INTO work_item_observation
           (id, work_item_id, kind, summary, confidence, workday_id, observed_at, dismissed_at, dedupe_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`
        )
        .run(`${itemId}:observation:${event.id}`, itemId, kind, event.reason, 1, workdayId, event.at, dedupeKey)
      latestObservedAt = Math.max(latestObservedAt, event.at)
    }
    if (latestObservedAt) {
      this.database
        .prepare("UPDATE work_item SET updated_at = MAX(updated_at, ?) WHERE id = ? AND lifecycle = 'open'")
        .run(latestObservedAt, itemId)
    }
  }

  private applicationId(displayName: string, bundleId: string) {
    this.database
      .prepare('INSERT OR IGNORE INTO application (bundle_id, display_name) VALUES (?, ?)')
      .run(bundleId, displayName)
    const row = this.database
      .prepare('SELECT id FROM application WHERE bundle_id = ? AND display_name = ?')
      .get(bundleId, displayName)
    if (!row) throw new Error('application-index-failed')
    return numberValue(row.id)
  }

  private indexAudio(moment: DailyReviewMoment) {
    this.database
      .prepare('DELETE FROM evidence_fts WHERE rowid IN (SELECT fts_rowid FROM audio_search_row WHERE evidence_id = ?)')
      .run(moment.id)
    this.database.prepare('DELETE FROM audio_search_row WHERE evidence_id = ?').run(moment.id)
    if (moment.status !== 'ready' || !moment.transcript.trim()) return
    const indexed = this.database
      .prepare(
        `INSERT INTO evidence_fts (
          kind, evidence_id, workday_id, application, window_title, text
        ) VALUES ('audio', ?, ?, '', '', ?)`
      )
      .run(moment.id, moment.sessionId, moment.transcript)
    this.database
      .prepare('INSERT INTO audio_search_row(evidence_id, fts_rowid) VALUES (?, ?)')
      .run(moment.id, indexed.lastInsertRowid)
  }

  private readAudioMoments(sessionId: string): DailyReviewMoment[] {
    const rows = this.database
      .prepare('SELECT * FROM audio_evidence WHERE workday_id = ? ORDER BY started_at')
      .all(sessionId) as DatabaseRow[]
    return rows.map((row) => ({
      id: stringValue(row.id),
      sessionId,
      source: stringValue(row.source) as DailyReviewMoment['source'],
      startedAt: numberValue(row.started_at),
      durationMs: numberValue(row.duration_ms),
      status: stringValue(row.status) as DailyReviewMoment['status'],
      transcript: stringValue(row.transcript),
      ...mediaPlaybackFromRow(row),
      ...(row.capture_epoch_id == null ? {} : { captureEpochId: stringValue(row.capture_epoch_id) }),
      ...(row.capture_sequence == null ? {} : { captureSequence: numberValue(row.capture_sequence) }),
      ...(row.captured_sample_count == null ? {} : { capturedSampleCount: numberValue(row.captured_sample_count) }),
      ...(row.capture_sample_time == null ? {} : { captureSampleTime: numberValue(row.capture_sample_time) }),
      captureOutcome: stringValue(row.capture_outcome) as DailyReviewMoment['captureOutcome'],
    }))
  }

  private readAppActivity(sessionId: string): DailyReviewAppActivity[] {
    const rows = this.database
      .prepare(
        `SELECT s.id, s.started_at, s.ended_at, a.display_name, a.bundle_id
         FROM focus_segment s
         JOIN application a ON a.id = s.application_id
         WHERE s.workday_id = ?
         ORDER BY s.started_at`
      )
      .all(sessionId) as DatabaseRow[]
    return rows.map((row) => ({
      id: stringValue(row.id),
      appName: stringValue(row.display_name),
      bundleId: stringValue(row.bundle_id),
      startedAt: numberValue(row.started_at),
      endedAt: nullableNumber(row.ended_at),
    }))
  }

  private async *contextEvidenceBatches(sessionId: string) {
    const deletionRevision = this.deletionRevision()
    const read = this.database.prepare(
      `SELECT c.*, a.display_name, a.bundle_id
       FROM context_evidence c JOIN application a ON a.id = c.application_id
       WHERE c.workday_id = ? AND (c.timestamp, c.id) > (?, ?)
       ORDER BY c.timestamp, c.id LIMIT 64`
    )
    let after = Number.MIN_SAFE_INTEGER
    let afterId = ''
    for (;;) {
      if (this.deletionRevision() !== deletionRevision) throw new Error('analysis-invalidated-by-deletion')
      const batch = read.all(sessionId, after, afterId) as DatabaseRow[]
      yield batch
      if (this.deletionRevision() !== deletionRevision) throw new Error('analysis-invalidated-by-deletion')
      if (batch.length < 64) break
      const last = batch[batch.length - 1]
      after = numberValue(last.timestamp)
      afterId = stringValue(last.id)
      await setImmediate()
    }
  }

  async readContextMomentsAsync(sessionId: string): Promise<DailyReviewContextMoment[]> {
    const moments: DailyReviewContextMoment[] = []
    for await (const batch of this.contextEvidenceBatches(sessionId)) {
      moments.push(...batch.map(contextMomentFromRow))
    }
    return moments
  }

  readContextMoments(sessionId: string): DailyReviewContextMoment[] {
    const rows = this.database
      .prepare(
        `SELECT c.*, a.display_name, a.bundle_id
         FROM context_evidence c
         JOIN application a ON a.id = c.application_id
         WHERE c.workday_id = ?
         ORDER BY c.timestamp`
      )
      .all(sessionId) as DatabaseRow[]
    return rows.map(contextMomentFromRow)
  }

  private readMemory(row: DatabaseRow): DayMemory | null {
    if (typeof row.memory_json !== 'string') return null
    return readWorkdayMemory(this.database, row.memory_json)
  }

  private readRefresh(row: DatabaseRow): DayRefresh {
    return {
      status: stringValue(row.refresh_status) as DayRefresh['status'],
      reason: row.refresh_reason == null ? null : (stringValue(row.refresh_reason) as DayRefresh['reason']),
      targetThrough: nullableNumber(row.refresh_target_through),
      error: row.refresh_error == null ? null : stringValue(row.refresh_error),
      progress: typeof row.refresh_progress_json === 'string' ? JSON.parse(row.refresh_progress_json) : null,
      run: typeof row.refresh_run_json === 'string' ? JSON.parse(row.refresh_run_json) : null,
    }
  }
}
