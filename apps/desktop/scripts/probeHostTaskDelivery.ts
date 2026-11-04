import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { EvidenceStore } from '../src/main/dailyReview/evidenceStore'
import {
  type HostTaskEnvelopeV1,
  type HostTaskOutcome,
  hostTaskDefinition,
  hostTaskSessionReceipt,
  validateHostTaskEnvelope,
  validateHostTaskOutcome,
} from '../src/main/hostTaskProtocol'
import { ResidentAgentStore } from '../src/main/residentAgentStore'

const script = fileURLToPath(import.meta.url)
function stores(root: string) {
  const resident = new ResidentAgentStore(join(root, 'conversation.sqlite'))
  const evidence = new EvidenceStore(join(root, 'evidence.sqlite'))
  return {
    resident,
    evidence,
    close() {
      resident.close()
      evidence.close()
    },
  }
}
function record(root: string, data: unknown) {
  appendFileSync(join(root, 'events.jsonl'), `${JSON.stringify({ pid: process.pid, at: Date.now(), data })}\n`)
}
function fixtureEnvelope(
  root: string,
  item: ReturnType<EvidenceStore['createWorkItem']>,
  suffix: string
): HostTaskEnvelopeV1 {
  return {
    version: 1,
    actionId: `action-${suffix}`,
    workItemId: item.id,
    sessionId: `session-${suffix}`,
    jobId: `job-${suffix}`,
    userMessageId: `user-${suffix}`,
    assistantMessageId: `assistant-${suffix}`,
    provider: 'codex',
    instruction: `Prepare synthetic ${suffix}; task remains open`,
    targetId: 'isolated-fake-target',
    taskDefinition: hostTaskDefinition(item),
    policyFingerprint: 'synthetic-policy',
    sources: [],
    startedAt: Date.now(),
    preparedInput: {
      prompt: `Synthetic ${suffix} task context`,
      systemPrompt: 'Local fixture only',
      model: 'fake-model',
      effort: 'low',
      threadId: null,
      tools: [],
      workspace: join(root, `workspace-${suffix}`),
    },
  }
}
function readRows(root: string, file: string, sql: string) {
  const db = new DatabaseSync(join(root, file), { readOnly: true })
  try {
    return JSON.parse(JSON.stringify(db.prepare(sql).all())) as Record<string, unknown>[]
  } finally {
    db.close()
  }
}
function child(root: string, stage: string) {
  const data = JSON.parse(readFileSync(join(root, 'inputs.json'), 'utf8')) as {
    a: HostTaskEnvelopeV1
    outcome: HostTaskOutcome
  }
  const s = stores(root)
  if (stage === 'intent') {
    s.resident.createHostTaskIntent(data.a)
    record(root, { stage, committed: 'intent+messages' })
    process.exit(71)
  }
  if (stage === 'session') {
    const receipt = s.evidence.acceptHostTaskSession(data.a)
    record(root, { stage, receipt, committed: 'session+receipt+fact' })
    process.exit(72)
  }
  if (stage === 'session-ack') {
    s.resident.acknowledgeHostTaskSession(data.a.actionId, s.evidence.acceptHostTaskSession(data.a))
  } else if (stage === 'outcome') {
    s.resident.recordHostTaskOutcome(data.a.actionId, data.outcome)
    record(root, { stage, committed: 'outcome+message' })
    process.exit(73)
  } else if (stage === 'projection') {
    const receipt = s.evidence.applyHostTaskOutcome(data.a, data.outcome)
    record(root, { stage, receipt, committed: 'session-terminal+fact+receipt' })
    process.exit(74)
  } else if (stage === 'projection-ack') {
    s.resident.acknowledgeHostTaskOutcome(data.a.actionId, s.evidence.applyHostTaskOutcome(data.a, data.outcome))
  } else throw Error(`unsupported-stage:${stage}`)
  s.close()
  record(root, { stage, closed: true })
}
function main() {
  const root = mkdtempSync('/private/tmp/r-e072-')
  const proof: {
    root: string
    pid: number
    status: string
    boundary: string
    checks: string[]
    children: { stage: string; pid: number; status: number | null; signal: string | null }[]
    error?: string
    [key: string]: unknown
  } = {
    root,
    pid: process.pid,
    status: 'running',
    boundary:
      'Actual local store processes and injected typed metadata only. No provider/host/IPC/native/UI/capture/cloud/Mini execution. No Task deletion case in this process probe.',
    checks: [],
    children: [],
  }
  const save = () => writeFileSync(join(root, 'report.json'), JSON.stringify(proof, null, 2))
  const check = (label: string, value: unknown) => {
    assert(value, label)
    proof.checks.push(label)
    save()
  }
  const run = (stage: string, expected: number) => {
    const result = spawnSync(process.execPath, [...process.execArgv, script, '--child', root, stage], {
      encoding: 'utf8',
      timeout: 10000,
    })
    writeFileSync(join(root, `child-${stage}.log`), result.stdout + result.stderr)
    proof.children.push({ stage, pid: result.pid, status: result.status, signal: result.signal })
    save()
    assert.ifError(result.error)
    assert.equal(result.status, expected)
    assert.equal(result.signal, null)
    const phase = {
      stage,
      afterExit: expected,
      messages: readRows(root, 'conversation.sqlite', 'SELECT * FROM assistant_message ORDER BY id'),
      intents: readRows(root, 'conversation.sqlite', 'SELECT * FROM assistant_task_run ORDER BY action_id'),
      hostBindings: readRows(root, 'conversation.sqlite', 'SELECT * FROM assistant_host_run'),
      tasks: readRows(root, 'evidence.sqlite', 'SELECT * FROM work_item ORDER BY id'),
      sessions: readRows(root, 'evidence.sqlite', 'SELECT * FROM work_item_agent_session ORDER BY id'),
      receipts: readRows(root, 'evidence.sqlite', 'SELECT * FROM work_item_host_receipt ORDER BY action_id'),
      facts: readRows(root, 'evidence.sqlite', 'SELECT * FROM work_item_fact ORDER BY id'),
    }
    writeFileSync(join(root, `phase-${stage}.json`), JSON.stringify(phase, null, 2))
  }
  let active: ReturnType<typeof stores> | null = null
  const open = () => {
    assert.equal(active, null)
    active = stores(root)
    return active
  }
  const close = () => {
    active?.close()
    active = null
  }
  try {
    let s = open()
    const taskA = s.evidence.createWorkItem('Synthetic A', 'Keep this task open')
    const taskB = s.evidence.createWorkItem('Synthetic B', 'Separate explicit task')
    const a = fixtureEnvelope(root, taskA, 'a')
    const b = fixtureEnvelope(root, taskB, 'b')
    const outcome: HostTaskOutcome = {
      version: 1,
      status: 'completed',
      response: 'Synthetic A result; done means only agent answer.',
      steps: [],
      completedAt: a.startedAt + 100,
      durationMs: 100,
    }
    writeFileSync(join(root, 'inputs.json'), JSON.stringify({ a, b, outcome }, null, 2))
    const aFields = readRows(root, 'evidence.sqlite', 'SELECT * FROM work_item ORDER BY id')
    writeFileSync(join(root, 'initial-task-rows.json'), JSON.stringify(aFields, null, 2))
    close()
    run('intent', 71)
    check(
      'intent process persisted exactly two messages',
      readRows(root, 'conversation.sqlite', 'SELECT * FROM assistant_message').length === 2
    )
    check(
      'no receipt before delivery',
      readRows(root, 'evidence.sqlite', 'SELECT * FROM work_item_host_receipt').length === 0
    )
    s = open()
    check('intent reopen has no implicit host binding', s.resident.hostRun() === null)
    check('intent has no receipt ACK', s.resident.getHostTaskIntent(a.actionId)?.sessionReceipt === null)
    close()
    run('session', 72)
    s = open()
    check(
      'host-owned session survives real process restart',
      s.evidence.getWorkItem(a.workItemId)?.agentSessions[0]?.status === 'running'
    )
    check(
      'session ACK still absent after receiver crash',
      s.resident.getHostTaskIntent(a.actionId)?.sessionReceipt === null
    )
    check(
      'definition remains current after own session delivery',
      s.evidence.validateHostTaskForDispatch(a.actionId, validateHostTaskEnvelope(a).envelopeHash).state === 'current'
    )
    close()
    run('session-ack', 0)
    check(
      'one session despite lost receipt ACK',
      readRows(root, 'evidence.sqlite', 'SELECT * FROM work_item_agent_session').length === 1
    )
    check(
      'one started fact despite lost receipt ACK',
      readRows(root, 'evidence.sqlite', "SELECT * FROM work_item_fact WHERE type='agent_started'").length === 1
    )
    run('outcome', 73)
    s = open()
    check(
      'typed outcome survives before projection',
      s.resident.getHostTaskIntent(a.actionId)?.outcome?.response === outcome.response
    )
    check('Task projection pending', s.evidence.getWorkItem(a.workItemId)?.agentSessions[0]?.status === 'running')
    close()
    run('projection', 74)
    s = open()
    check(
      'outcome ACK absent after projection commit',
      s.resident.getHostTaskIntent(a.actionId)?.outcomeReceipt === null
    )
    check('Task session completed', s.evidence.getWorkItem(a.workItemId)?.agentSessions[0]?.status === 'completed')
    close()
    run('projection-ack', 0)
    s = open()
    check(
      'one terminal fact after lost ACK',
      readRows(root, 'evidence.sqlite', "SELECT * FROM work_item_fact WHERE type='agent_completed'").length === 1
    )
    assert.deepEqual(readRows(root, 'evidence.sqlite', 'SELECT * FROM work_item ORDER BY id'), aFields)
    check('Task rows unchanged by all A metadata delivery', true)
    s.resident.createHostTaskIntent(b)
    s.resident.acknowledgeHostTaskSession(b.actionId, s.evidence.acceptHostTaskSession(b))
    s.resident.claimToolCall('late-a', 'hash-a', { messageId: a.assistantMessageId, toolName: 'remember_memory' })
    s.resident.finishToolCall('late-a', {
      kind: 'saved-page',
      saved: true,
      proposed: false,
      spaceId: 'personal',
      slug: 'synthetic-a',
      revision: 'fixture-r1',
      title: 'A',
    })
    s.resident.claimToolCall('unknown-a', 'hash-unknown', {
      messageId: a.assistantMessageId,
      toolName: 'remember_memory',
    })
    s.resident.claimToolCall('proposal-b', 'hash-b', { messageId: b.assistantMessageId, toolName: 'remember_memory' })
    s.resident.finishToolCall('proposal-b', {
      kind: 'saved-page',
      saved: false,
      proposed: true,
      spaceId: 'personal',
      slug: 'synthetic-b',
      revision: 'fixture-r1',
    })
    assert.throws(() =>
      s.resident.claimToolCall('late-a', 'hash-a', { messageId: b.assistantMessageId, toolName: 'remember_memory' })
    )
    check(
      'late A result stays A with B current',
      s.resident.hostTaskResults(a.actionId).length === 1 && s.resident.hostTaskResults(b.actionId).length === 0
    )
    assert.throws(() => s.resident.start('', 'codex', b.assistantMessageId))
    const privateOutcome = {
      ...outcome,
      response: 'Must not import after revocation',
      completedAt: b.startedAt + 200,
      durationMs: 200,
    }
    s.resident.resetContext()
    assert.throws(() => s.resident.recordHostTaskOutcome(b.actionId, privateOutcome))
    check(
      'revoked B imports no private outcome',
      s.resident.getHostTaskIntent(b.actionId)?.outcome === null && s.resident.get(b.assistantMessageId)?.text === ''
    )
    const stopped: HostTaskOutcome = {
      version: 1,
      status: 'stopped',
      response: '',
      steps: [],
      completedAt: b.startedAt + 300,
      durationMs: 300,
    }
    s.resident.recordHostTaskOutcome(b.actionId, stopped)
    s.resident.acknowledgeHostTaskOutcome(b.actionId, s.evidence.applyHostTaskOutcome(b, stopped))
    assert.throws(() => s.resident.recordHostTaskOutcome(b.actionId, privateOutcome))
    assert.deepEqual(readRows(root, 'evidence.sqlite', 'SELECT * FROM work_item ORDER BY id'), aFields)
    check('sanitized Stop B keeps user task status unchanged', true)
    close()
    s = open()
    for (const [envelope, expectedOutcome] of [
      [a, outcome],
      [b, stopped],
    ] as const) {
      const intent = s.resident.getHostTaskIntent(envelope.actionId)
      assert(intent)
      assert.deepEqual(intent.envelope, envelope)
      assert.equal(intent.envelopeHash, validateHostTaskEnvelope(envelope).envelopeHash)
      assert.deepEqual(intent.sessionReceipt, hostTaskSessionReceipt(envelope))
      assert.deepEqual(intent.outcome, expectedOutcome)
      assert.deepEqual(intent.outcomeReceipt, {
        ...hostTaskSessionReceipt(envelope),
        outcomeHash: validateHostTaskOutcome(expectedOutcome).outcomeHash,
        projection: 'applied',
      })
      const session = s.evidence
        .getWorkItem(envelope.workItemId)
        ?.agentSessions.find((entry) => entry.id === envelope.sessionId)
      assert(session)
      const persistedSession = readRows(
        root,
        'evidence.sqlite',
        'SELECT id, work_item_id FROM work_item_agent_session'
      ).find((row) => row.id === envelope.sessionId)
      assert.equal(persistedSession?.work_item_id, envelope.workItemId)
      assert.equal(session?.instruction, envelope.preparedInput.prompt)
    }
    check(
      'A and B identities/outcomes survive final reopen',
      s.resident.getHostTaskIntent(a.actionId)?.outcome?.status === 'completed' &&
        s.resident.getHostTaskIntent(b.actionId)?.outcome?.status === 'stopped'
    )
    check(
      'saved result remains bound after reopen',
      s.resident.hostTaskResults(a.actionId)[0]?.slug === 'synthetic-a' &&
        s.resident.hostTaskResults(b.actionId).length === 0
    )
    proof.finalIntents = [s.resident.getHostTaskIntent(a.actionId), s.resident.getHostTaskIntent(b.actionId)]
    proof.finalTasks = [s.evidence.getWorkItem(a.workItemId), s.evidence.getWorkItem(b.workItemId)]
    close()
    proof.status = 'passed'
  } catch (error) {
    proof.status = 'failed'
    proof.error = error instanceof Error ? error.stack : String(error)
  } finally {
    close()
    save()
    process.stdout.write(`${JSON.stringify({ status: proof.status, report: join(root, 'report.json') })}\n`)
  }
  if (proof.status !== 'passed') process.exitCode = 1
}
const [mode, root, stage] = process.argv.slice(2)
if (mode === '--child' && root && stage && process.argv.length === 5) child(root, stage)
else if (mode === '--run' && process.argv.length === 3) main()
else throw Error('Use --run for this isolated local store experiment')
