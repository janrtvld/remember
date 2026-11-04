import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { after, afterEach, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createAgentActivityStore } from '../agentActivityStore'
import { EvidenceStore } from '../dailyReview/evidenceStore'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type RecordValue = { [key: string]: Json }
type Change = {
  kind: string
  id: string
  operation: 'created' | 'updated' | 'deleted'
  sourceRef: Json
  record: RecordValue | null
}
type Changes = {
  baseline: boolean
  changes: Change[]
  hasMore: boolean
  nextCursor: string
  checkpoint: string | null
}

const timestamp = Date.parse('2026-10-16T08:00:00Z')
const roots: string[] = []
const connections: DatabaseSync[] = []
let buildRoot = ''
let executable = ''

function invoke(root: string, args: string[], input?: string) {
  return spawnSync(executable, args, {
    encoding: 'utf8',
    input,
    timeout: 15_000,
    env: { ...process.env, REMEMBER_DATA_DIR: root, REMEMBER_CONTINUITY_DIR: join(root, '.continuity') },
  })
}

function cli<T = RecordValue>(root: string, ...args: string[]): T {
  const result = invoke(root, [...args, '--json'])
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout) as T
}

function sql(root: string, statement: string, ...values: SQLInputValue[]) {
  const database = new DatabaseSync(join(root, 'evidence.sqlite'))
  try {
    database.prepare(statement).run(...values)
  } finally {
    database.close()
  }
}

function context(root: string, id: string, text: string, at = timestamp) {
  sql(
    root,
    `INSERT INTO context_evidence
      (id, workday_id, application_id, timestamp, window_title, text, text_source, content_hash)
     VALUES (?, 'day-1', 1, ?, 'Continuity implementation', ?, 'accessibility', ?)`,
    id,
    at,
    text,
    id
  )

  sql(
    root,
    `INSERT INTO evidence_fts (kind, evidence_id, workday_id, application, window_title, text)
     VALUES ('context', ?, 'day-1', 'Editor', 'Continuity implementation', ?)`,
    id,
    text
  )
}

function fixture(keepOpen = true) {
  const root = mkdtempSync(join(tmpdir(), 'remember-continuity-profile-'))
  roots.push(root)
  new EvidenceStore(join(root, 'evidence.sqlite')).close()

  if (keepOpen) {
    // Keep the WAL connection alive, as Remember does, while the CLI accesses this profile.
    const connection = new DatabaseSync(join(root, 'evidence.sqlite'))
    connections.push(connection)
    connection.prepare('SELECT id FROM workday LIMIT 1').all()
  }

  sql(
    root,
    `INSERT INTO workday
      (id, local_day, started_at, created_at, updated_at, memory_covered_through, refresh_status, refresh_error)
     VALUES ('day-1', '2026-10-16', ?, ?, ?, ?, 'failed', 'Synthetic processing failure')`,
    timestamp,
    timestamp,
    timestamp,
    timestamp - 60_000
  )
  sql(root, "INSERT INTO application (id, bundle_id, display_name) VALUES (1, 'example.editor', 'Editor')")
  context(root, 'context-1', 'Original architecture context')
  sql(
    root,
    `INSERT INTO work_item
      (id, title, description, lifecycle, status, attention, created_at, updated_at, lifecycle_updated_at)
     VALUES ('item-1', 'Connect the dot', 'Verify original evidence', 'open', 'in_progress', 'idle', ?, ?, ?)`,
    timestamp,
    timestamp,
    timestamp
  )
  sql(
    root,
    `INSERT INTO work_item_source (id, work_item_id, kind, label, detail, workday_id, observed_at)
     VALUES ('source-1', 'item-1', 'observed', 'Editor evidence', 'Original architecture context', 'day-1', ?)`,
    timestamp
  )
  sql(
    root,
    `INSERT INTO audio_evidence
      (id, workday_id, source, started_at, duration_ms, status, transcript, capture_outcome)
     VALUES ('audio-1', 'day-1', 'microphone', ?, 1000, 'ready', 'We agreed to read original sources.', 'transcribed')`,
    timestamp
  )
  sql(
    root,
    `INSERT INTO conversation_episode
      (id, workday_id, started_at, ended_at, state, boundary_reason)
     VALUES ('conversation-1', 'day-1', ?, ?, 'final', 'speech-gap')`,
    timestamp,
    timestamp + 1000
  )
  sql(
    root,
    `INSERT INTO episode_analysis
      (id, episode_id, workday_id, started_at, ended_at, classification, confidence, reason,
       title, summary, source_hash, provider, model, prompt_version, schema_version, generated_at)
     VALUES ('analysis-1', 'conversation-1', 'day-1', ?, ?, 'conversation', 'high', 'Two speakers',
       'Review the connection', 'Read original evidence before acting.', 'hash-1', 'codex', 'fixture', 1, 1, ?)`,
    timestamp,
    timestamp + 1000,
    timestamp + 2000
  )
  sql(
    root,
    'UPDATE workday SET memory_json = ? WHERE id = ?',
    JSON.stringify({
      conversations: [
        {
          episodeId: 'conversation-1',
          startTime: '10:00',
          endTime: '10:01',
          title: 'Review the connection',
          summary: 'Read original evidence before acting.',
        },
      ],
    }),
    'day-1'
  )
  return root
}

function changeKeys(result: Changes) {
  return result.changes.map(({ kind, id, operation }) => `${kind}:${id}:${operation}`).sort()
}

function conversation(root: string, id: string, startedAt: number, workdayId = 'day-1') {
  sql(
    root,
    `INSERT INTO conversation_episode
      (id, workday_id, started_at, ended_at, state, boundary_reason)
     VALUES (?, ?, ?, ?, 'final', 'speech-gap')`,
    id,
    workdayId,
    startedAt,
    startedAt + 1000
  )
  sql(
    root,
    `INSERT INTO episode_analysis
      (id, episode_id, workday_id, started_at, ended_at, classification, confidence, reason,
       title, summary, source_hash, provider, model, prompt_version, schema_version, generated_at)
     VALUES (?, ?, ?, ?, ?, 'conversation', 'high', 'Fixture', ?, 'Recorded conversation summary',
       ?, 'codex', 'fixture', 1, 1, ?)`,
    `analysis-${id}`,
    id,
    workdayId,
    startedAt,
    startedAt + 1000,
    `Conversation ${id}`,
    `hash-${id}`,
    startedAt + 2000
  )
}

function stable(value: Json): Json {
  if (Array.isArray(value)) return value.map(stable)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'observedAt')
      .map(([key, child]) => [key, stable(child)])
  )
}

describe('compiled Remember continuity CLI', { skip: process.platform !== 'darwin' }, () => {
  before(() => {
    buildRoot = mkdtempSync(join(tmpdir(), 'remember-continuity-build-'))
    executable = join(buildRoot, 'remember')
    const source = fileURLToPath(new URL('../../../native/remember-cli.swift', import.meta.url))
    const compilation = spawnSync(
      'xcrun',
      ['swiftc', '-module-cache-path', join(buildRoot, 'modules'), '-lsqlite3', source, '-o', executable],
      { encoding: 'utf8', timeout: 120_000 }
    )
    assert.equal(compilation.error, undefined)
    assert.equal(compilation.status, 0, compilation.stderr)
  })

  afterEach(() => {
    for (const connection of connections.splice(0)) connection.close()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  after(() => {
    if (buildRoot) rmSync(buildRoot, { recursive: true, force: true })
  })

  it('reads closed evidence and agent WAL databases without changing either source database', () => {
    const root = fixture(false)
    const agentPath = join(root, 'agent-activity.sqlite')
    createAgentActivityStore(agentPath).close()
    const agentDatabase = new DatabaseSync(agentPath)
    try {
      agentDatabase
        .prepare(
          `INSERT INTO activity_event
            (id, provider, session_id, role, content, content_hash, observed_at, representation,
             source_path, source_offset, recorded_at)
           VALUES ('agent-event-1', 'codex', 'session-1', 'assistant', 'The source has been corrected.',
             'content-hash', ?, 'text', '/synthetic/session.jsonl', 0, ?)`
        )
        .run(timestamp, timestamp)
    } finally {
      agentDatabase.close()
    }

    assert.deepEqual(readdirSync(root).sort(), ['agent-activity.sqlite', 'evidence.sqlite'])
    const paths = [join(root, 'evidence.sqlite'), agentPath]
    const hashes = () => paths.map((path) => createHash('sha256').update(readFileSync(path)).digest('hex'))
    const before = hashes()
    const now = cli(root, 'now')
    assert.equal((now.recentActivity as RecordValue[])[0].id, 'context-1')
    assert.equal((now.recentAgentMessages as RecordValue[])[0].id, 'agent-event-1')
    assert.equal((now.capture as RecordValue).availability, 'unknown')
    const source = cli(root, 'source', 'read', 'agent_event', 'agent-event-1')
    assert.equal((source.record as RecordValue).content, 'The source has been corrected.')
    assert.equal(cli<Changes>(root, 'changes').baseline, true)
    assert.deepEqual(hashes(), before)
  })

  it('reads committed WAL records without checkpointing the main database when no writer remains', () => {
    const sourceRoot = fixture()
    const root = mkdtempSync(join(tmpdir(), 'remember-continuity-wal-'))
    roots.push(root)
    const path = join(root, 'evidence.sqlite')
    cpSync(join(sourceRoot, 'evidence.sqlite'), path)
    cpSync(join(sourceRoot, 'evidence.sqlite-wal'), `${path}-wal`)
    assert.ok(statSync(`${path}-wal`).size > 0)
    assert.deepEqual(readdirSync(root).sort(), ['evidence.sqlite', 'evidence.sqlite-wal'])
    const digest = () => createHash('sha256').update(readFileSync(path)).digest('hex')
    const before = digest()

    const source = cli(root, 'source', 'read', 'context', 'context-1')
    assert.equal((source.record as RecordValue).text, 'Original architecture context')
    assert.equal(digest(), before)
  })

  it('returns bounded recent context, persisted processing boundaries, and retrievable original sources', () => {
    const root = fixture()
    context(root, 'context-older', 'Earlier work on another topic', timestamp - 1000)
    const now = cli(root, 'now', '--limit', '1')
    assert.equal(now.schemaVersion, 1)
    assert.equal(now.dataDirectory, root)
    assert.equal((now.capture as RecordValue).availability, 'unknown')
    const activity = now.recentActivity as RecordValue[]
    assert.equal(activity.length, 1)
    assert.equal(activity[0].id, 'context-1')
    assert.ok(activity[0].sourceRef)
    assert.ok(JSON.stringify(activity[0]).includes(String(timestamp)))
    const conversations = now.recentConversations as RecordValue[]
    assert.equal(conversations.length, 1)
    assert.equal(conversations[0].id, 'conversation-1')
    assert.ok(conversations[0].sourceRef)
    const persisted = (now.processing as RecordValue).persisted as RecordValue
    const day = (persisted.days as RecordValue[]).find((item) => item.id === 'day-1')
    assert.equal(day?.memoryCoveredThrough, timestamp - 60_000)
    assert.equal(day?.refreshStatus, 'failed')
    assert.equal(day?.refreshError, 'Synthetic processing failure')
    const original = cli(root, 'source', 'read', 'context', 'context-1')
    assert.deepEqual(original.sourceRef, activity[0].sourceRef)
    assert.equal((original.record as RecordValue).text, 'Original architecture context')
    assert.equal((original.record as RecordValue).timestamp, timestamp)
    const matches = cli<RecordValue[]>(root, 'search', 'architecture', '--limit', '1')
    assert.equal(matches.length, 1)
    assert.equal(matches[0].id, 'context-1')
    assert.deepEqual(matches[0].sourceRef, original.sourceRef)

    const completeContext = 'A detail beyond a compact preview. '.repeat(500)
    sql(root, 'UPDATE context_evidence SET text = ? WHERE id = ?', completeContext, 'context-1')
    const expanded = cli(root, 'source', 'read', 'context', 'context-1')
    assert.equal((expanded.record as RecordValue).text, completeContext)
  })

  it('keeps lifecycle corrections and blocking observations separate and preserves their history', () => {
    const root = fixture()
    const store = new EvidenceStore(join(root, 'evidence.sqlite'))
    store.setWorkItemLifecycle('item-1', 'completed')
    store.close()
    assert.equal(cli(root, 'inbox', 'read', 'item-1').lifecycle, 'completed')
    assert.equal(cli(root, 'inbox', 'list', '--lifecycle', 'completed').count, 1)

    const reopened = new EvidenceStore(join(root, 'evidence.sqlite'))
    reopened.setWorkItemLifecycle('item-1', 'open')
    reopened.close()
    sql(
      root,
      `INSERT INTO work_item_observation
        (id, work_item_id, kind, summary, confidence, observed_at)
       VALUES ('blocked-1', 'item-1', 'blocked', 'Waiting for a source correction', 0.8, ?)`,
      timestamp
    )
    const item = cli(root, 'inbox', 'read', 'item-1')
    assert.equal(item.lifecycle, 'open')
    assert.equal(item.status, 'in_progress')
    const facts = item.facts as RecordValue[]
    assert.ok(facts.some((fact) => fact.type === 'completed'))
    assert.ok(facts.some((fact) => fact.type === 'reopened'))
    assert.ok((item.sources as RecordValue[]).some((source) => source.id === 'source-1'))
    assert.ok((item.observations as RecordValue[]).some((observation) => observation.id === 'blocked-1'))
    assert.equal(((item.signals as RecordValue).blocked as RecordValue[])[0].id, 'blocked-1')

    const checkpoint = cli<Changes>(root, 'changes').checkpoint
    assert.ok(checkpoint)
    sql(root, 'UPDATE work_item_observation SET dismissed_at = ? WHERE id = ?', timestamp + 1, 'blocked-1')
    const changes = cli<Changes>(root, 'changes', '--since', checkpoint)
    assert.deepEqual(changeKeys(changes), ['work_item_observation:blocked-1:updated'])
    const corrected = cli(root, 'inbox', 'read', 'item-1')
    assert.equal(corrected.lifecycle, 'open')
    assert.equal((corrected.observations as RecordValue[])[0].dismissedAt, timestamp + 1)
    assert.deepEqual((corrected.signals as RecordValue).blocked, [])
  })

  it('detects late corrections, physical deletions, and inserts sharing an old timestamp', () => {
    const root = fixture()
    const baseline = cli<Changes>(root, 'changes')
    assert.equal(baseline.baseline, true)
    assert.deepEqual(baseline.changes, [])
    assert.equal(baseline.hasMore, false)
    assert.equal(baseline.checkpoint, baseline.nextCursor)
    sql(root, 'UPDATE context_evidence SET text = ? WHERE id = ?', 'Corrected context', 'context-1')
    sql(root, 'DELETE FROM audio_evidence WHERE id = ?', 'audio-1')
    context(root, 'context-2', 'Another source at exactly the same timestamp')
    const changed = cli<Changes>(root, 'changes', '--since', baseline.nextCursor)
    assert.deepEqual(changeKeys(changed), [
      'audio:audio-1:deleted',
      'context:context-1:updated',
      'context:context-2:created',
    ])
    assert.equal(changed.changes.find((change) => change.operation === 'deleted')?.record, null)
    for (const change of changed.changes) assert.ok(change.sourceRef)
    const deletedSource = cli(root, 'source', 'read', 'audio', 'audio-1')
    assert.equal(deletedSource.availability, 'not_found')
    assert.equal(deletedSource.record, null)
    const unchanged = cli<Changes>(root, 'changes', '--since', changed.nextCursor)
    assert.deepEqual(unchanged.changes, [])
  })

  it('replays frozen pages without losing writes made while a change batch is being drained', () => {
    const root = fixture()
    const baseline = cli<Changes>(root, 'changes')
    for (const id of ['context-2', 'context-3', 'context-4']) context(root, id, id)
    const first = cli<Changes>(root, 'changes', '--since', baseline.nextCursor, '--limit', '1')
    assert.equal(first.changes.length, 1)
    assert.equal(first.hasMore, true)
    assert.equal(first.checkpoint, null)

    context(root, 'context-later', 'Arrived after the immutable batch was created')
    const second = cli<Changes>(root, 'changes', '--since', first.nextCursor, '--limit', '1')
    const replay = cli<Changes>(root, 'changes', '--since', first.nextCursor, '--limit', '1')
    assert.deepEqual(replay, second)
    assert.equal(second.hasMore, true)
    assert.equal(second.checkpoint, null)
    const third = cli<Changes>(root, 'changes', '--since', second.nextCursor, '--limit', '1')
    assert.equal(third.hasMore, false)
    assert.equal(third.checkpoint, third.nextCursor)
    assert.deepEqual([...first.changes, ...second.changes, ...third.changes].map((change) => change.id).sort(), [
      'context-2',
      'context-3',
      'context-4',
    ])
    const later = cli<Changes>(root, 'changes', '--since', third.nextCursor)
    assert.deepEqual(changeKeys(later), ['context:context-later:created'])
  })

  it('rejects invalid and foreign-profile cursors and never treats its own polling as new evidence', () => {
    const root = fixture()
    const baseline = cli<Changes>(root, 'changes')
    const before = readFileSync(join(root, 'evidence.sqlite'))
    for (const args of [['now'], ['inbox', 'list'], ['source', 'read', 'context', 'context-1']]) {
      cli(root, ...args)
    }
    const noChanges = cli<Changes>(root, 'changes', '--since', baseline.nextCursor)
    assert.deepEqual(noChanges.changes, [])
    assert.deepEqual(readFileSync(join(root, 'evidence.sqlite')), before)

    for (const cursor of ['../../evidence.sqlite', 'not-a-cursor', '11111111-1111-4111-8111-111111111111']) {
      const result = invoke(root, ['changes', '--since', cursor, '--json'])
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /cursor/i)
      assert.equal(result.stdout.trim(), '')
    }
    const otherProfile = fixture()
    cpSync(join(root, '.continuity'), join(otherProfile, '.continuity'), { recursive: true })
    const foreign = invoke(otherProfile, ['changes', '--since', baseline.nextCursor, '--json'])
    assert.notEqual(foreign.status, 0)
    assert.match(foreign.stderr, /cursor|profile/i)
    const privateDirectory = join(root, '.continuity')
    assert.equal(statSync(privateDirectory).mode & 0o777, 0o700)
    for (const entry of readdirSync(privateDirectory, { withFileTypes: true })) {
      if (entry.isFile()) assert.equal(statSync(join(privateDirectory, entry.name)).mode & 0o777, 0o600)
    }
  })

  it('exposes equivalent read tools through stdio MCP and rejects unsupported tool arguments', () => {
    const root = fixture()
    const baseline = cli<Changes>(root, 'changes')
    context(root, 'context-2', 'First change')
    context(root, 'context-3', 'Second change')
    const firstPage = cli<Changes>(root, 'changes', '--since', baseline.nextCursor, '--limit', '1')
    assert.equal(firstPage.hasMore, true)
    const calls = [
      { name: 'remember_now', arguments: { limit: 1 }, cli: ['now', '--limit', '1'] },
      { name: 'remember_inbox', arguments: { action: 'read', id: 'item-1' }, cli: ['inbox', 'read', 'item-1'] },
      {
        name: 'remember_source',
        arguments: { kind: 'context', id: 'context-1' },
        cli: ['source', 'read', 'context', 'context-1'],
      },
      {
        name: 'remember_changes',
        arguments: { since: firstPage.nextCursor, limit: 1 },
        cli: ['changes', '--since', firstPage.nextCursor, '--limit', '1'],
      },
    ]
    const requests = calls.map(({ name, arguments: args }, index) => ({
      jsonrpc: '2.0',
      id: index + 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }))
    const result = invoke(root, ['mcp'], `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`)
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stderr)
    const responses = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(responses.length, calls.length)
    for (const [index, response] of responses.entries()) {
      assert.equal(response.result.isError, false, JSON.stringify(response))
      assert.deepEqual(stable(JSON.parse(response.result.content[0].text)), stable(cli(root, ...calls[index].cli)))
    }
    const invalid = invoke(
      root,
      ['mcp'],
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 'invalid',
        method: 'tools/call',
        params: { name: 'remember_now', arguments: { limit: true } },
      })}\n`
    )
    assert.equal(JSON.parse(invalid.stdout).result.isError, true)
  })

  it('lists only currently accepted conversations with confirmed, dismissed and deletion parity', () => {
    const root = fixture()
    for (const [index, id] of ['confirmed', 'dismissed', 'deleted', 'window-deleted', 'media'].entries()) {
      conversation(root, id, timestamp + (index + 1) * 60_000)
    }
    for (const id of ['confirmed', 'media']) {
      sql(
        root,
        `INSERT INTO episode_analysis
          (id, episode_id, workday_id, started_at, ended_at, classification, confidence, reason,
           title, summary, source_hash, provider, model, prompt_version, schema_version, generated_at)
         SELECT id || '-latest', episode_id, workday_id, started_at, ended_at, 'media', confidence, reason,
           title, summary, source_hash || '-latest', provider, model, prompt_version, schema_version, generated_at + 1000
         FROM episode_analysis WHERE episode_id = ?`,
        id
      )
    }
    for (const [id, decision] of [
      ['confirmed', 'confirmed'],
      ['dismissed', 'dismissed'],
    ]) {
      sql(
        root,
        'INSERT INTO conversation_episode_decision (episode_id, decision, decided_at) VALUES (?, ?, ?)',
        id,
        decision,
        timestamp
      )
    }
    sql(root, 'UPDATE conversation_episode SET deleted_at = ? WHERE id = ?', timestamp, 'deleted')
    sql(
      root,
      'UPDATE workday SET memory_json = ? WHERE id = ?',
      JSON.stringify({ deletedConversationWindows: [{ episodeId: 'window-deleted' }] }),
      'day-1'
    )
    const page = cli(root, 'conversations', '2026-10-16', '--page')
    assert.equal(page.availability, 'available')
    assert.equal(page.sourceKind, 'local-audio-episodes')
    assert.deepEqual(page.coverage, { localAudioEpisodes: true, importedConversations: false })
    assert.equal(page.count, 2)
    const items = page.items as RecordValue[]
    assert.deepEqual(
      items.map((item) => item.id),
      ['conversation-1', 'confirmed']
    )
    assert.equal(items[0].acceptance, 'classified')
    assert.equal(items[1].acceptance, 'confirmed')
    assert.equal(items[0].date, '2026-10-16')
    assert.equal(items[0].startedAt, timestamp)
    assert.equal(items[0].endedAt, timestamp + 1000)
    assert.match(String(items[0].revision), /^[a-f0-9]{64}$/)
    assert.equal(items[1].transcriptAvailable, false)
    assert.equal(items[1].text, '')
    for (const item of items) {
      assert.equal(cli(root, 'source', 'read', 'conversation', String(item.id)).availability, 'available')
    }
    for (const id of ['dismissed', 'deleted', 'window-deleted', 'media']) {
      assert.equal(cli(root, 'source', 'read', 'conversation', id).availability, 'not_found')
    }
  })

  it('exposes deliberate manual recordings without requiring AI classification, while preserving dismissal', () => {
    const root = fixture()
    sql(
      root,
      "UPDATE conversation_episode SET provider = 'manual', surface_key = 'manual:user-recording' WHERE id = 'conversation-1'"
    )
    sql(root, "DELETE FROM episode_analysis WHERE episode_id = 'conversation-1'")
    const records = cli<RecordValue[]>(root, 'conversations', 'day-1')
    assert.equal(records[0].acceptance, 'recorded')
    assert.equal(records[0].transcriptAvailable, true)
    sql(
      root,
      "INSERT INTO conversation_episode_decision (episode_id, decision, decided_at) VALUES ('conversation-1', 'dismissed', ?)",
      timestamp
    )
    assert.deepEqual(cli(root, 'conversations', 'day-1'), [])
  })

  it('uses ordered exact speech references without chunk duplication or rejected-text fallback', () => {
    const root = fixture()
    sql(
      root,
      'UPDATE conversation_episode SET ended_at = ?, segment_ids_json = ? WHERE id = ?',
      timestamp + 3000,
      JSON.stringify(['speech-2', 'speech-rejected', 'speech-1', 'speech-1']),
      'conversation-1'
    )
    for (const [id, text, at, rejection] of [
      ['speech-2', 'Second exact segment.', timestamp + 1000, null],
      ['speech-1', 'First exact segment.', timestamp, null],
      ['speech-rejected', 'Rejected hallucination.', timestamp + 2000, 'likely-hallucination'],
    ] as const) {
      sql(
        root,
        `INSERT INTO speech_segment
        (id, workday_id, chunk_id, source, started_at, ended_at, text, rejection_reason)
        VALUES (?, 'day-1', 'audio-1', 'microphone', ?, ?, ?, ?)`,
        id,
        at,
        at + 1000,
        text,
        rejection
      )
    }
    const items = cli<RecordValue[]>(root, 'conversations', '2026-10-16')
    assert.equal(items[0].text, 'First exact segment.\nSecond exact segment.')
    assert.deepEqual(
      (items[0].transcriptSources as RecordValue[]).map((source) => source.id),
      ['speech-1', 'speech-2']
    )
    const original = cli(root, 'source', 'read', 'conversation', 'conversation-1')
    assert.deepEqual(
      (original.speechSegments as RecordValue[]).map((source) => source.id),
      ['speech-1', 'speech-2']
    )
    sql(
      root,
      'UPDATE conversation_episode SET segment_ids_json = ? WHERE id = ?',
      JSON.stringify(['speech-rejected']),
      'conversation-1'
    )
    const rejected = cli<RecordValue[]>(root, 'conversations', '2026-10-16')[0]
    assert.equal(rejected.text, '')
    assert.equal(rejected.transcriptAvailable, false)
    assert.deepEqual(rejected.transcriptSources, [])
  })

  it('pages every matching local-date episode across workdays with exact midnight boundaries', () => {
    const root = fixture()
    const localStart = new Date(2026, 9, 16).getTime()
    sql(
      root,
      `INSERT INTO workday (id, local_day, started_at, created_at, updated_at)
      VALUES ('day-2', '2026-10-15', ?, ?, ?)`,
      timestamp + 5000,
      timestamp,
      timestamp
    )
    conversation(root, 'earlier-boundary', localStart - 1, 'day-2')
    conversation(root, 'on-boundary', localStart, 'day-2')
    conversation(root, 'second-workday', timestamp + 6000, 'day-2')
    conversation(root, 'next-boundary', new Date(2026, 9, 17).getTime(), 'day-2')
    const first = cli(root, 'conversations', '2026-10-16', '--limit', '2', '--page')
    assert.equal(first.count, 3)
    assert.equal(first.hasMore, true)
    assert.equal(first.nextOffset, 2)
    assert.deepEqual(
      (first.items as RecordValue[]).map((item) => item.id),
      ['on-boundary', 'conversation-1']
    )
    const second = cli(root, 'conversations', '2026-10-16', '--limit', '2', '--offset', '2', '--page')
    assert.equal(second.hasMore, false)
    assert.equal(second.nextOffset, null)
    assert.deepEqual(
      (second.items as RecordValue[]).map((item) => item.id),
      ['second-workday']
    )
    assert.deepEqual(
      cli<RecordValue[]>(root, 'conversations', 'day-1').map((item) => item.id),
      ['conversation-1']
    )
    const empty = cli(root, 'conversations', '2026-10-15', '--page')
    assert.equal(empty.count, 1)
    assert.equal(cli(root, 'conversations', '2026-10-14', '--page').count, 0)
    const missing = cli(root, 'conversations', 'missing-workday', '--page')
    assert.equal(missing.availability, 'not_found')
    for (const args of [['2026-02-30'], ['2026-10-16', '--offset', '-1'], ['2026-10-16', '--limit', 'invalid']]) {
      const invalid = invoke(root, ['conversations', ...args, '--page', '--json'])
      assert.notEqual(invalid.status, 0)
      assert.equal(invalid.stdout.trim(), '')
    }
  })

  it('exposes the same paged conversation contract through MCP', () => {
    const root = fixture()
    const result = invoke(
      root,
      ['mcp'],
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 'conversation-page',
        method: 'tools/call',
        params: {
          name: 'remember_conversations',
          arguments: { selector: '2026-10-16', page: true, offset: 0, limit: 1 },
        },
      })}\n`
    )
    assert.equal(result.status, 0, result.stderr)
    const response = JSON.parse(result.stdout)
    assert.equal(response.result.isError, false, JSON.stringify(response))
    assert.deepEqual(
      JSON.parse(response.result.content[0].text),
      cli(root, 'conversations', '2026-10-16', '--page', '--offset', '0', '--limit', '1')
    )
  })

  it('pins the full source revision across page shapes and changes it after source or decision edits', () => {
    const root = fixture()
    const initial = cli<RecordValue[]>(root, 'conversations', 'day-1')[0]
    const repeated = (cli(root, 'conversations', '2026-10-16', '--page', '--limit', '1').items as RecordValue[])[0]
    assert.equal(repeated.revision, initial.revision)
    assert.equal(repeated.text, initial.text)
    sql(root, 'UPDATE audio_evidence SET transcript = ? WHERE id = ?', 'A corrected source transcript.', 'audio-1')
    const corrected = cli<RecordValue[]>(root, 'conversations', 'day-1')[0]
    assert.notEqual(corrected.revision, initial.revision)
    assert.equal(corrected.text, 'A corrected source transcript.')
    sql(
      root,
      `INSERT INTO conversation_episode_decision (episode_id, decision, decided_at)
      VALUES ('conversation-1', 'confirmed', ?)`,
      timestamp
    )
    const confirmed = cli<RecordValue[]>(root, 'conversations', 'day-1')[0]
    assert.notEqual(confirmed.revision, corrected.revision)
    assert.equal(confirmed.acceptance, 'confirmed')
  })

  it('does not widen a legacy conversation to partial chunks or chunks already represented by speech', () => {
    const root = fixture()
    sql(root, 'UPDATE audio_evidence SET duration_ms = 2000 WHERE id = ?', 'audio-1')
    assert.equal(cli<RecordValue[]>(root, 'conversations', 'day-1')[0].transcriptAvailable, false)
    sql(root, 'UPDATE audio_evidence SET duration_ms = 1000 WHERE id = ?', 'audio-1')
    sql(
      root,
      `INSERT INTO speech_segment
      (id, workday_id, chunk_id, source, started_at, ended_at, text, rejection_reason)
      VALUES ('unlinked-speech', 'day-1', 'audio-1', 'microphone', ?, ?, 'Unlinked text.', NULL)`,
      timestamp,
      timestamp + 1000
    )
    const legacy = cli<RecordValue[]>(root, 'conversations', 'day-1')[0]
    assert.equal(legacy.transcriptAvailable, false)
    assert.equal(legacy.text, '')
  })

  it('uses one deterministic latest analysis when generation timestamps tie', () => {
    const root = fixture()
    sql(
      root,
      `INSERT INTO episode_analysis
        (id, episode_id, workday_id, started_at, ended_at, classification, confidence, reason,
         title, summary, source_hash, provider, model, prompt_version, schema_version, generated_at)
       SELECT 'z-latest-media', episode_id, workday_id, started_at, ended_at, 'media', confidence, reason,
         title, summary, source_hash || '-tie', provider, model, prompt_version, schema_version, generated_at
       FROM episode_analysis WHERE id = 'analysis-1'`
    )
    assert.deepEqual(cli<RecordValue[]>(root, 'conversations', 'day-1'), [])
    assert.equal(cli(root, 'source', 'read', 'conversation', 'conversation-1').availability, 'not_found')
  })
})
