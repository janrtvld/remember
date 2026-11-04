import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { contextSourceCheckpoints, prepareContextDocumentChanges } from '../contextImportChanges'
import { type AgentContextDocument, discoverAgentContextAt, discoverAgentProjectsAt } from '../contextImportSources'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function testHome() {
  const directory = mkdtempSync(path.join(tmpdir(), `remember-context-${randomUUID()}-`))
  directories.push(directory)
  return directory
}

function writeFixture(filePath: string, content: string, modifiedAt: number) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, content)
  const date = new Date(modifiedAt)
  utimesSync(filePath, date, date)
}

describe('agent context discovery', () => {
  it('discovers durable memories and bounded recent sessions from Codex and Claude', async () => {
    const now = Date.UTC(2026, 7, 11, 10)
    const home = testHome()
    const project = path.join(home, 'Developer', 'remember')
    writeFixture(path.join(home, '.codex', 'memories', 'memory_summary.md'), '# Memory\n\nKeep decisions durable.', now)
    writeFixture(path.join(home, '.codex', 'AGENTS.md'), 'Prefer focused changes.', now)
    writeFixture(path.join(project, 'AGENTS.md'), 'Use pnpm.', now)
    writeFixture(
      path.join(home, '.codex', 'sessions', '2026', '08', '11', 'codex-session.jsonl'),
      [
        { type: 'session_meta', payload: { cwd: project } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'Finish the calling research.' } },
        { type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'do not import this' } },
        {
          type: 'event_msg',
          payload: { type: 'task_complete', last_agent_message: 'The Mac route needs validation.' },
        },
      ]
        .map((value) => JSON.stringify(value))
        .join('\n'),
      now
    )

    const claudeProject = path.join(home, '.claude', 'projects', '-Users-test-Developer-remember')
    writeFixture(
      path.join(claudeProject, 'memory', 'MEMORY.md'),
      '# Project memory\n\nCalling research is active.',
      now
    )
    writeFixture(path.join(project, 'CLAUDE.md'), 'Preserve the current Wiki decisions.', now)
    writeFixture(
      path.join(claudeProject, '8c1ab9c7-cf47-486e-89c5-b530eeda2f8b.jsonl'),
      [
        { type: 'user', cwd: project, message: { role: 'user', content: 'Continue the calling feature.' } },
        {
          type: 'assistant',
          cwd: project,
          message: { role: 'assistant', content: [{ type: 'text', text: 'The Wiki is the handoff.' }] },
        },
        {
          type: 'assistant',
          cwd: project,
          message: { role: 'assistant', content: [{ type: 'tool_use', input: 'do not import this' }] },
        },
      ]
        .map((value) => JSON.stringify(value))
        .join('\n'),
      now
    )

    const discovery = discoverAgentContextAt(home, now)
    assert.deepEqual(
      discovery.preview.providers.map(({ provider, available, sessionCount }) => ({
        provider,
        available,
        sessionCount,
      })),
      [
        { provider: 'codex', available: true, sessionCount: 1 },
        { provider: 'claude', available: true, sessionCount: 1 },
      ]
    )
    assert.ok(discovery.documents.some((document) => document.kind === 'memory' && document.provider === 'codex'))
    assert.ok(discovery.documents.some((document) => document.kind === 'memory' && document.provider === 'claude'))
    const importedText = discovery.documents.map((document) => document.content).join('\n')
    assert.match(importedText, /Finish the calling research/)
    assert.match(importedText, /The Wiki is the handoff/)
    assert.doesNotMatch(importedText, /do not import this/)

    assert.deepEqual(await discoverAgentProjectsAt(home, now), [
      {
        id: realpathSync(project),
        name: 'remember',
        path: realpathSync(project),
        providers: ['codex', 'claude'],
        lastUsedAt: now,
      },
    ])
  })

  it('ignores sessions older than the thirty-day bootstrap window', () => {
    const now = Date.UTC(2026, 7, 11, 10)
    const home = testHome()
    const oldTimestamp = now - 31 * 24 * 60 * 60_000
    writeFixture(
      path.join(home, '.codex', 'sessions', 'old.jsonl'),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Stale session' } }),
      oldTimestamp
    )

    const discovery = discoverAgentContextAt(home, now)
    assert.equal(discovery.preview.providers.find((provider) => provider.provider === 'codex')?.available, false)
    assert.doesNotMatch(discovery.documents.map((document) => document.content).join('\n'), /Stale session/)
  })

  it('discovers project metadata asynchronously without requiring transcript messages', async () => {
    const home = testHome()
    const project = path.join(home, 'Developer', 'current')
    const oldProject = path.join(home, 'Developer', 'initial')
    mkdirSync(project, { recursive: true })
    mkdirSync(oldProject, { recursive: true })
    const now = Date.UTC(2026, 8, 16, 10)
    writeFixture(
      path.join(home, '.codex', 'sessions', 'metadata.jsonl'),
      [
        JSON.stringify({ type: 'session_meta', payload: { cwd: oldProject } }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'function_call_output', output: 'x'.repeat(3_000_000) },
        }),
        JSON.stringify({ type: 'turn_context', payload: { cwd: project } }),
        '{unfinished',
      ].join('\n'),
      now
    )
    writeFixture(
      path.join(home, '.codex', 'sessions', 'stale.jsonl'),
      JSON.stringify({ type: 'session_meta', payload: { cwd: oldProject } }),
      now - 31 * 24 * 60 * 60_000
    )
    writeFixture(
      path.join(home, '.claude', 'projects', 'project', '8c1ab9c7-cf47-486e-89c5-b530eeda2f8b.jsonl'),
      JSON.stringify({ type: 'system', cwd: project }),
      now
    )

    let yielded = false
    setImmediate(() => {
      yielded = true
    })
    const projects = await discoverAgentProjectsAt(home, now)
    assert.equal(yielded, true)
    assert.deepEqual(projects, [
      {
        id: realpathSync(project),
        name: 'current',
        path: realpathSync(project),
        providers: ['codex', 'claude'],
        lastUsedAt: now,
      },
    ])
  })

  it('only imports new timestamped messages when an old Codex conversation resumes', () => {
    const home = testHome()
    const now = Date.UTC(2026, 8, 8, 10)
    writeFixture(
      path.join(home, '.codex/sessions/resumed.jsonl'),
      [
        {
          timestamp: new Date(now - 100_000).toISOString(),
          type: 'event_msg',
          payload: { type: 'user_message', message: 'Our old USA itinerary went through Death Valley.' },
        },
        {
          timestamp: new Date(now - 1_000).toISOString(),
          type: 'event_msg',
          payload: { type: 'user_message', message: 'The hotel checkout is now confirmed for September 30.' },
        },
        { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Undated old plan recap.' } },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n'),
      now
    )
    const documents = discoverAgentContextAt(home, now).documents
    const prepared = prepareContextDocumentChanges(documents, now - 5_000, now, [])
    assert.equal(prepared.documents.length, 1)
    assert.match(prepared.documents[0]?.content ?? '', /checkout is now confirmed/)
    assert.doesNotMatch(prepared.documents[0]?.content ?? '', /Death Valley|Undated/)
    assert.equal(prepareContextDocumentChanges(documents, now, now + 1000, prepared.checkpoints).documents.length, 0)
    // A failed Wiki write keeps the initial baseline, even if the Day advanced.
    assert.equal(prepareContextDocumentChanges(documents, now, now + 1000, prepared.baselines).documents.length, 1)
  })

  it('does not mistake a touched memory or a reintroduced old paragraph for new knowledge', () => {
    const document: AgentContextDocument = {
      provider: 'codex',
      kind: 'memory',
      sourceId: 'memory',
      project: 'USA',
      updatedAt: 100,
      content: 'Existing itinerary.\n\nConfirmed hotel.',
    }
    const baseline = prepareContextDocumentChanges([document], 50, 100, [])
    assert.deepEqual(baseline.documents, [])
    const touched = { ...document, updatedAt: 200 }
    assert.deepEqual(prepareContextDocumentChanges([touched], 100, 200, baseline.checkpoints).documents, [])
    const changed = { ...document, updatedAt: 300, content: 'Existing itinerary.\n\nCheckout is September 30.' }
    const delta = prepareContextDocumentChanges([changed], 200, 300, baseline.checkpoints)
    assert.equal(delta.documents[0]?.content, 'Checkout is September 30.')
    assert.deepEqual(
      prepareContextDocumentChanges([{ ...document, updatedAt: 400 }], 300, 400, delta.checkpoints).documents,
      []
    )
  })

  it('keeps same-named project memories independent and honors the source boundary', () => {
    const home = testHome()
    const now = Date.UTC(2026, 8, 8, 10)
    for (const project of ['first', 'second'])
      writeFixture(path.join(home, '.claude/projects', project, 'memory/MEMORY.md'), `${project} context`, now)
    const documents = discoverAgentContextAt(home, now).documents
    assert.equal(new Set(documents.map((document) => document.sourceId)).size, 2)
    const seeded = contextSourceCheckpoints(documents, now)
    assert.deepEqual(prepareContextDocumentChanges(documents, now, now + 1000, seeded).documents, [])
    assert.deepEqual(prepareContextDocumentChanges(documents, now - 1000, now - 1, []).checkpoints, [])
  })
})
