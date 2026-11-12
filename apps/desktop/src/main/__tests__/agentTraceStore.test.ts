import assert from 'node:assert/strict'
import { appendFileSync, statSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  appendAgentTraceAt,
  compactAgentTraceAt,
  createAgentTraceReader,
  readAgentTraceAt,
  recoverInterruptedAgentTraceAt,
} from '../agentTraceStore'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('agent trace store', () => {
  it('preserves agent learning logs and recovers interrupted learning after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remember-agent-trace-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'trace.ndjson')
    const event = {
      id: 'agent-learning:batch-1',
      action: 'agent-learning' as const,
      provider: 'codex' as const,
      status: 'running' as const,
      startedAt: 100,
      completedAt: null,
      dayId: null,
      reason: null,
      error: null,
      logs: [{ timestamp: 100, message: 'Nieuwe agentgesprekken verwerken.' }],
    }
    appendAgentTraceAt(path, event)
    assert.deepEqual(readAgentTraceAt(path), [{ ...event, diagnostics: [] }])
    assert.equal(recoverInterruptedAgentTraceAt(path, 200), 1)
    const [recovered] = readAgentTraceAt(path)
    assert.equal(recovered.action, 'agent-learning')
    assert.equal(recovered.status, 'failed')
    assert.equal(recovered.error, 'agent-interrupted')
    assert.equal(recovered.logs[0].message, event.logs[0].message)
    assert.equal(recoverInterruptedAgentTraceAt(path, 300), 0)
  })

  it('recovers only events still running from before this launch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remember-agent-trace-'))
    const path = join(directory, 'trace.ndjson')
    const running = {
      action: 'agent-learning' as const,
      provider: 'codex' as const,
      status: 'running' as const,
      completedAt: null,
      dayId: null,
      reason: null,
      error: null,
      logs: [],
    }
    appendAgentTraceAt(path, { ...running, id: 'finished', startedAt: 100 })
    appendAgentTraceAt(path, { ...running, id: 'interrupted', startedAt: 110 })
    // A finished event that merely mentions another id must not hide that event's running state.
    appendAgentTraceAt(path, {
      ...running,
      id: 'finished',
      startedAt: 100,
      status: 'completed',
      completedAt: 150,
      logs: [{ timestamp: 150, message: 'Ran after "interrupted"' }],
    })
    appendAgentTraceAt(path, { ...running, id: 'this-launch', startedAt: 300 })

    assert.equal(recoverInterruptedAgentTraceAt(path, 400, 200), 1)
    const statuses = Object.fromEntries(readAgentTraceAt(path).map((event) => [event.id, event.status]))
    assert.deepEqual(statuses, { finished: 'completed', interrupted: 'failed', 'this-launch': 'running' })
  })

  it('keeps the latest snapshot for each event', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remember-agent-trace-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'trace.ndjson')
    const running = {
      id: 'refresh-1',
      action: 'day-refresh' as const,
      provider: 'codex' as const,
      status: 'running' as const,
      startedAt: 100,
      completedAt: null,
      dayId: 'day-1',
      reason: 'manual' as const,
      error: null,
      logs: [{ timestamp: 100, message: 'Started' }],
    }
    appendAgentTraceAt(path, running)
    appendAgentTraceAt(path, { ...running, status: 'completed', completedAt: 200 })

    assert.deepEqual(readAgentTraceAt(path), [{ ...running, status: 'completed', completedAt: 200, diagnostics: [] }])
  })

  it('normalizes optional fields omitted by the native CLI', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remember-agent-trace-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'trace.ndjson')
    await writeFile(
      path,
      `${JSON.stringify({ id: 'cli-1', action: 'cli-search', provider: 'claude', status: 'completed', startedAt: 300 })}\n`
    )

    assert.deepEqual(readAgentTraceAt(path), [
      {
        id: 'cli-1',
        action: 'cli-search',
        provider: 'claude',
        status: 'completed',
        startedAt: 300,
        completedAt: null,
        dayId: null,
        reason: null,
        error: null,
        logs: [],
        diagnostics: [],
      },
    ])
  })

  it('drops retired local-analysis day refreshes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remember-agent-trace-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'trace.ndjson')
    await writeFile(
      path,
      `${JSON.stringify({ id: 'local-1', action: 'day-refresh', provider: 'local', status: 'completed', startedAt: 300 })}\n`
    )

    assert.deepEqual(readAgentTraceAt(path), [])
  })

  it('terminalizes events left running by a previous process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remember-agent-trace-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'trace.ndjson')
    appendAgentTraceAt(path, {
      id: 'refresh-interrupted',
      action: 'day-refresh',
      provider: 'codex',
      status: 'running',
      startedAt: 100,
      completedAt: null,
      dayId: 'day-1',
      reason: 'active-interval',
      error: null,
      logs: [{ timestamp: 100, message: 'Started' }],
    })

    assert.equal(recoverInterruptedAgentTraceAt(path, 500), 1)
    assert.deepEqual(readAgentTraceAt(path), [
      {
        id: 'refresh-interrupted',
        action: 'day-refresh',
        provider: 'codex',
        status: 'failed',
        startedAt: 100,
        completedAt: 500,
        dayId: 'day-1',
        reason: 'active-interval',
        error: 'agent-interrupted',
        logs: [
          { timestamp: 100, message: 'Started' },
          { timestamp: 500, message: 'Onderbroken doordat Remember opnieuw startte' },
        ],
        diagnostics: [],
      },
    ])
    assert.equal(recoverInterruptedAgentTraceAt(path, 600), 0)
  })

  it('retains raw failed invocation diagnostics for copying', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remember-agent-trace-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'trace.ndjson')
    const diagnostic = {
      provider: 'claude' as const,
      phase: 'final' as const,
      shardIndex: null,
      shardCount: 1,
      attempt: 2 as const,
      executable: '/Users/example/.local/bin/claude',
      launchExecutable: '/Users/example/.bun/bin/bun',
      arguments: ['/Users/example/.local/bin/claude', '--print', '--output-format', 'json'],
      workingDirectory: '/Users/example/Library/Application Support/Remember',
      version: '2.1.221 (Claude Code)',
      model: 'sonnet',
      effort: 'high',
      outputFormat: 'json' as const,
      environment: {
        home: '/Users/example',
        path: '/Users/example/.local/bin:/usr/bin',
        shell: '/bin/zsh',
        bunInstall: '/Users/example/.bun',
        claudeCode: null,
      },
      exitCode: 0,
      startedAt: 400,
      completedAt: 500,
      promptBytes: 1_000,
      stdoutBytes: 26,
      stderrBytes: 15,
      stdout: '{"incomplete":"response"}',
      stderr: 'schema mismatch',
      systemPrompt: 'Return one JSON object.',
      schema: '{"type":"object"}',
      prompt: 'Analyze this evidence.',
      truncated: false,
      error: 'agent-invalid-response\nMissing required fields: summary',
    }
    appendAgentTraceAt(path, {
      id: 'refresh-2',
      action: 'day-refresh',
      provider: 'claude',
      status: 'failed',
      startedAt: 400,
      completedAt: 500,
      dayId: 'day-2',
      reason: 'manual',
      error: 'agent-invalid-response',
      logs: [],
      diagnostics: [diagnostic],
    })

    assert.deepEqual(readAgentTraceAt(path)[0]?.diagnostics, [diagnostic])
  })

  it('lists appended activity incrementally without diagnostics or unfinished lines', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remember-agent-trace-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'trace.ndjson')
    const list = createAgentTraceReader(path, 2)
    assert.deepEqual(list(), [])
    const event = (id: string, startedAt: number, status: 'running' | 'completed' = 'completed') => ({
      id,
      action: 'day-refresh' as const,
      provider: 'codex' as const,
      status,
      startedAt,
      completedAt: status === 'completed' ? startedAt + 1 : null,
      dayId: 'day-1',
      reason: 'manual' as const,
      error: null,
      logs: [],
    })
    appendAgentTraceAt(path, { ...event('first', 100, 'running'), diagnostics: [{ prompt: 'private' } as never] })
    assert.deepEqual(list(), [{ ...event('first', 100, 'running'), diagnostics: [] }])

    const second = JSON.stringify(event('second', 200))
    appendFileSync(path, second.slice(0, 20))
    assert.deepEqual(
      list().map((entry) => entry.id),
      ['first']
    )
    appendFileSync(path, `${second.slice(20)}\n`)
    appendAgentTraceAt(path, event('first', 100))
    appendAgentTraceAt(path, event('third', 300))
    assert.deepEqual(
      list().map((entry) => [entry.id, entry.status]),
      [
        ['third', 'completed'],
        ['second', 'completed'],
      ]
    )
  })

  it('compacts superseded lines and keeps listing after the rewrite', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remember-agent-trace-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'trace.ndjson')
    const event = (id: string, startedAt: number, message: string) => ({
      id,
      action: 'agent-learning' as const,
      provider: 'codex' as const,
      status: 'completed' as const,
      startedAt,
      completedAt: startedAt + 1,
      dayId: null,
      reason: null,
      error: null,
      logs: [{ timestamp: startedAt, message }],
    })
    appendAgentTraceAt(path, event('kept', 2, 'latest'))
    assert.equal(compactAgentTraceAt(path), false)
    for (let index = 0; index < 900; index += 1) appendAgentTraceAt(path, event('repeated', 1, `update ${index}`))
    const list = createAgentTraceReader(path)
    assert.equal(list().length, 2)
    const sizeBefore = statSync(path).size

    assert.equal(compactAgentTraceAt(path), true)
    assert.ok(statSync(path).size < sizeBefore / 100)
    const expected = [
      { ...event('kept', 2, 'latest'), diagnostics: [] },
      { ...event('repeated', 1, 'update 899'), diagnostics: [] },
    ]
    assert.deepEqual(readAgentTraceAt(path), expected)
    appendAgentTraceAt(path, event('new', 3, 'after'))
    assert.deepEqual(list(), [{ ...event('new', 3, 'after'), diagnostics: [] }, ...expected])
  })
})
