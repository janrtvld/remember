import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Codex } from '@openai/codex-sdk'
import {
  INTENT_SHADOW_V4_SCHEMA,
  type IntentShadowV4Snapshot,
  prepareIntentShadowV4,
} from '../../../experiments/always-on-agent/intent-shadow-v4'
import { bundledCodexExecutablePath } from '../src/main/codexRuntimePaths'
import type { AmbientEvidence } from '../src/main/dailyReview/ambientTaskStore'
import { buildCodexSdkConfiguration } from '../src/main/dailyReview/codexAgentSdk'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const planPath = path.join(root, 'experiments/always-on-agent/intent-shadow-v4-baseline.json')
const promptPath = path.join(root, 'experiments/always-on-agent/intent-shadow-v4-prompt.txt')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const read = (file: string) => readFileSync(path.join(root, file), 'utf8')

type Input = { language: string; userName: string; workItems: unknown[]; evidence: AmbientEvidence[] }
type Plan = {
  files: Record<string, string>
  schemaHash: string
  oldCases: Array<{ id: string; input: string; parsed: string }>
  contrasts: string[]
  casesPerRound: number
  model: string
  effort: string
}

async function main() {
  const round = process.argv.includes('--round=1') ? 1 : process.argv.includes('--round=2') ? 2 : null
  assert(
    round && process.argv.length === 4 && process.argv.includes('--live'),
    'Use --live --round=1 or --live --round=2'
  )
  const planText = readFileSync(planPath, 'utf8')
  const plan: Plan = JSON.parse(planText)
  for (const [file, expected] of Object.entries(plan.files))
    assert.equal(hash(read(file)), expected, `Frozen file changed: ${file}`)
  assert.equal(hash(JSON.stringify(INTENT_SHADOW_V4_SCHEMA)), plan.schemaHash, 'Frozen schema changed')
  const systemPrompt = readFileSync(promptPath, 'utf8')
  const cases: Array<{ id: string; input: Input; baseline?: unknown; expected?: unknown }> = [
    ...plan.oldCases.map((entry) => ({
      id: entry.id,
      input: JSON.parse(read(entry.input)),
      baseline: JSON.parse(read(entry.parsed)),
    })),
    ...plan.contrasts.flatMap((file) =>
      read(file)
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    ),
  ]
  assert.equal(cases.length, 21)
  assert.equal(cases.length, plan.casesPerRound)
  assert.equal(new Set(cases.map((entry) => entry.id)).size, cases.length)
  for (const entry of cases) {
    assert.deepEqual(Object.keys(entry.input).sort(), ['evidence', 'language', 'userName', 'workItems'])
    assert.equal(entry.input.workItems.length, 0)
    assert.equal(entry.input.evidence.filter((source) => source.kind === 'speech').length, 1)
    for (const source of entry.input.evidence) assert.equal(source.revision, hash(source.text))
  }
  const preparedCases = cases.map((entry) => {
    const speech = entry.input.evidence.find((source) => source.kind === 'speech')
    assert(speech, 'A caller-selected speech source is required')
    const reference = {
      evidenceId: speech.evidenceId,
      sourceId: speech.sourceId,
      revision: speech.revision,
    }
    const snapshot: IntentShadowV4Snapshot = {
      sources: entry.input.evidence.map((source) => ({ ...source })),
      userName: entry.input.userName,
      language: entry.input.language,
      policyEpoch: 'E03.5-fixed-synthetic-policy-v1',
      allowed: true,
    }
    return {
      ...entry,
      reference,
      snapshot,
      request: prepareIntentShadowV4(reference, snapshot),
      preparedAt: new Date().toISOString(),
    }
  })
  const settings = JSON.parse(
    readFileSync(path.join(homedir(), 'Library/Application Support/Remember/settings.json'), 'utf8')
  )
  assert.equal(typeof settings.codexAnalysisModel, 'string')
  assert.equal(typeof settings.codexAnalysisEffort, 'string')
  assert.equal(settings.codexAnalysisModel, plan.model, 'Frozen model changed')
  assert.equal(settings.codexAnalysisEffort, plan.effort, 'Frozen effort changed')
  const executable = bundledCodexExecutablePath({
    isPackaged: false,
    appPath: path.join(root, 'apps/desktop'),
    resourcesPath: '',
  })
  assert(executable)
  const directory = path.join(
    '/private/tmp/remember-intent-shadow-v4/runs',
    `${new Date().toISOString().replace(/:/g, '-')}-round${round}`
  )
  mkdirSync(directory, { recursive: true })
  const write = (file: string, value: unknown) =>
    writeFileSync(path.join(directory, file), JSON.stringify(value, null, 2))
  const manifest = {
    variant: 'E03.5-v4',
    round,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    completedAt: null as string | null,
    executionStatus: 'running',
    semanticAssessment: 'pending_independent_review',
    model: settings.codexAnalysisModel,
    effort: settings.codexAnalysisEffort,
    baselineSHA256: hash(planText),
    frozenFiles: plan.files,
    schemaHash: plan.schemaHash,
    gitRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    toolsDisabled: true,
    applicationRetries: 0,
    timeoutMsPerCase: 180_000,
    boundaries: [
      'synthetic text only',
      'existing local provider login',
      'no task or application writes',
      'no native latency or app restart claim',
      'all source provenance unknown',
      'fixed synthetic current snapshot, not a live native source or policy resolver',
      'strict JSON only; no fenced or prefixed response extraction',
      'runtime directory removal is not independent proof of provider process exit',
    ],
    cases: [] as Array<Record<string, unknown>>,
  }
  write('manifest.json', manifest)
  write('schema.json', INTENT_SHADOW_V4_SCHEMA)
  writeFileSync(path.join(directory, 'system-prompt.txt'), systemPrompt)
  console.log(`Shadow artifacts: ${directory}`)
  for (const entry of preparedCases) {
    write(`${entry.id}.input.json`, entry.input)
    write(`${entry.id}.comparison-only.json`, {
      baseline: entry.baseline ?? null,
      expected: entry.expected ?? null,
      projectedToModel: false,
    })
    write(`${entry.id}.caller-reference.json`, entry.reference)
    write(`${entry.id}.snapshot.json`, entry.snapshot)
    write(`${entry.id}.offered-input.json`, entry.request.input)
    const providerInput = `${systemPrompt}\n\n${JSON.stringify(entry.request.input)}`
    writeFileSync(path.join(directory, `${entry.id}.provider-input.txt`), providerInput)
    const runtime = mkdtempSync(path.join(tmpdir(), 'remember-intent-shadow-v4-'))
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), manifest.timeoutMsPerCase)
    const started = performance.now()
    const result: Record<string, unknown> = {
      id: entry.id,
      status: 'running',
      preparedAt: entry.preparedAt,
      providerStartedAt: null,
      runtimeDirectory: runtime,
      callerReference: entry.reference,
      snapshotMode: 'fixed_synthetic_fixture',
      semanticAssessment: 'pending_independent_review',
    }
    write(`${entry.id}.result.json`, result)
    const eventPath = path.join(directory, `${entry.id}.provider-events.jsonl`)
    writeFileSync(eventPath, '')
    let eventCount = 0
    let completed = false
    let streamEnded = false
    let fatalBoundary = false
    let cleanupFailed = false
    const lifecycle = { 'thread.started': 0, 'turn.started': 0, 'turn.completed': 0 }
    const messages: string[] = []
    const diagnostics: unknown[] = []
    const observedItems = new Set<string>()
    try {
      const configuration = buildCodexSdkConfiguration({
        abortController: controller,
        cwd: runtime,
        executable,
        env: { ...process.env, CODEX_HOME: path.join(homedir(), 'Library/Application Support/Remember/codex') },
        model: settings.codexAnalysisModel,
        effort: settings.codexAnalysisEffort,
        schema: INTENT_SHADOW_V4_SCHEMA,
        toolsDisabled: true,
      })
      result.providerStartedAt = new Date().toISOString()
      write(`${entry.id}.result.json`, result)
      const stream = await new Codex(configuration.client)
        .startThread(configuration.thread)
        .runStreamed(providerInput, configuration.turn)
      for await (const event of stream.events) {
        appendFileSync(
          eventPath,
          `${JSON.stringify({ sequence: ++eventCount, at: new Date().toISOString(), event })}\n`
        )
        if (
          ![
            'thread.started',
            'turn.started',
            'turn.completed',
            'turn.failed',
            'error',
            'item.started',
            'item.updated',
            'item.completed',
          ].includes(event.type)
        ) {
          fatalBoundary = true
          controller.abort()
          throw new Error('unknown-provider-event')
        }
        if (event.type === 'thread.started' || event.type === 'turn.started' || event.type === 'turn.completed') {
          lifecycle[event.type] += 1
          if (lifecycle[event.type] !== 1) {
            fatalBoundary = true
            controller.abort()
            throw new Error(`duplicate-provider-lifecycle:${event.type}`)
          }
        }
        if ('item' in event) {
          observedItems.add(event.item.type)
          if (!['agent_message', 'reasoning', 'error'].includes(event.item.type)) {
            fatalBoundary = true
            controller.abort()
            throw new Error(`unexpected-provider-item:${event.item.type}`)
          }
          if (event.type === 'item.completed' && event.item.type === 'agent_message') messages.push(event.item.text)
          if (event.item.type === 'error') diagnostics.push(event)
        }
        if (event.type === 'thread.started') result.threadId = event.thread_id
        if (event.type === 'turn.completed') {
          completed = true
          result.usage = event.usage
        }
        if (event.type === 'turn.failed') throw new Error(event.error.message)
        if (event.type === 'error') throw new Error(event.message)
      }
      streamEnded = true
      assert(
        completed && Object.values(lifecycle).every((count) => count === 1) && typeof result.threadId === 'string',
        'Expected one complete provider turn'
      )
      assert.equal(messages.length, 1, 'Expected exactly one final model record')
      const finalMessage = messages[0]
      assert(typeof finalMessage === 'string')
      writeFileSync(path.join(directory, `${entry.id}.raw.txt`), finalMessage)
      const raw: unknown = JSON.parse(finalMessage)
      write(`${entry.id}.raw.json`, raw)
      write(`${entry.id}.current-snapshot.json`, entry.snapshot)
      const bound = entry.request.accept(raw, entry.snapshot)
      write(`${entry.id}.shadow.json`, {
        bound,
        semanticAssessment: 'pending_independent_review',
        automaticAssignment: 'not_authorized',
        snapshotMode: 'fixed_synthetic_fixture',
      })
      result.status = bound.status === 'valid' ? 'completed_structurally_valid' : 'completed_structurally_invalid'
      result.boundReference = bound.reference
      result.bindingIssues = bound.issues
      result.structuralIssues = bound.structural?.issues ?? []
    } catch (error) {
      result.status = fatalBoundary
        ? 'execution_boundary_failed'
        : controller.signal.aborted
          ? 'timed_out'
          : 'execution_or_parse_failed'
      result.error = error instanceof Error ? error.message : String(error)
    } finally {
      clearTimeout(timeout)
      try {
        rmSync(runtime, { recursive: true, force: true })
        assert(!existsSync(runtime), 'Runtime directory still exists after cleanup')
        result.runtimeDirectoryRemoved = true
      } catch (error) {
        cleanupFailed = true
        result.runtimeDirectoryRemoved = false
        result.cleanupError = error instanceof Error ? error.message : String(error)
      }
      result.modelElapsedMs = Math.round(performance.now() - started)
      result.eventCount = eventCount
      result.providerItemTypes = [...observedItems]
      result.diagnostics = diagnostics
      result.lifecycle = lifecycle
      result.noExecutionItemsInCompletedStream =
        completed && streamEnded && !fatalBoundary && Object.values(lifecycle).every((count) => count === 1)
      manifest.cases.push(result)
      write(`${entry.id}.result.json`, result)
      write('manifest.json', manifest)
      console.log(JSON.stringify({ id: entry.id, status: result.status, modelElapsedMs: result.modelElapsedMs }))
    }
    if (fatalBoundary || cleanupFailed) {
      manifest.executionStatus = cleanupFailed ? 'aborted_on_cleanup_failure' : 'aborted_on_provider_boundary'
      process.exitCode = 1
      break
    }
  }
  manifest.completedAt = new Date().toISOString()
  if (manifest.executionStatus === 'running') manifest.executionStatus = 'completed'
  write('manifest.json', manifest)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
