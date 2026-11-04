import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Codex } from '@openai/codex-sdk'
import {
  INTENT_SHADOW_SCHEMA,
  type IntentShadowSource,
  validateIntentShadow,
} from '../../../experiments/always-on-agent/intent-shadow-v2'
import { bundledCodexExecutablePath } from '../src/main/codexRuntimePaths'
import { parseJsonResponse } from '../src/main/dailyReview/agentResponse'
import { buildCodexSdkConfiguration } from '../src/main/dailyReview/codexAgentSdk'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const planPath = path.join(root, 'experiments/always-on-agent/intent-shadow-v2-baseline.json')
const promptPath = path.join(root, 'experiments/always-on-agent/intent-shadow-v2-prompt.txt')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const read = (file: string) => readFileSync(path.join(root, file), 'utf8')

type Input = { language: string; userName: string; workItems: unknown[]; evidence: IntentShadowSource[] }
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
  assert.equal(hash(JSON.stringify(INTENT_SHADOW_SCHEMA)), plan.schemaHash, 'Frozen schema changed')
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
  assert.equal(cases.length, 17)
  assert.equal(cases.length, plan.casesPerRound)
  assert.equal(new Set(cases.map((entry) => entry.id)).size, cases.length)
  for (const entry of cases) {
    assert.deepEqual(Object.keys(entry.input).sort(), ['evidence', 'language', 'userName', 'workItems'])
    assert.equal(entry.input.workItems.length, 0)
    assert.equal(entry.input.evidence.filter((source) => source.kind === 'speech').length, 1)
    for (const source of entry.input.evidence) assert.equal(source.revision, hash(source.text))
  }
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
    '/private/tmp/remember-intent-shadow-v2/runs',
    `${new Date().toISOString().replace(/:/g, '-')}-round${round}`
  )
  mkdirSync(directory, { recursive: true })
  const write = (file: string, value: unknown) =>
    writeFileSync(path.join(directory, file), JSON.stringify(value, null, 2))
  const manifest = {
    variant: 'E03.2-v2',
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
    ],
    cases: [] as Array<Record<string, unknown>>,
  }
  write('manifest.json', manifest)
  write('schema.json', INTENT_SHADOW_SCHEMA)
  writeFileSync(path.join(directory, 'system-prompt.txt'), systemPrompt)
  console.log(`Shadow artifacts: ${directory}`)
  for (const entry of cases) {
    write(`${entry.id}.input.json`, entry.input)
    write(`${entry.id}.comparison-only.json`, {
      baseline: entry.baseline ?? null,
      expected: entry.expected ?? null,
      projectedToModel: false,
    })
    const runtime = mkdtempSync(path.join(tmpdir(), 'remember-intent-shadow-v2-'))
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), manifest.timeoutMsPerCase)
    const started = performance.now()
    const result: Record<string, unknown> = {
      id: entry.id,
      status: 'running',
      semanticAssessment: 'pending_independent_review',
    }
    const eventPath = path.join(directory, `${entry.id}.provider-events.jsonl`)
    let eventCount = 0
    let completed = false
    let streamEnded = false
    let fatalBoundary = false
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
        schema: INTENT_SHADOW_SCHEMA,
        toolsDisabled: true,
      })
      const stream = await new Codex(configuration.client)
        .startThread(configuration.thread)
        .runStreamed(`${systemPrompt}\n\n${JSON.stringify(entry.input)}`, configuration.turn)
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
      const raw = parseJsonResponse(finalMessage) as { records?: unknown[] }
      write(`${entry.id}.raw.json`, raw)
      assert(
        raw && typeof raw === 'object' && Object.keys(raw).length === 1 && Array.isArray(raw.records),
        'Invalid record envelope'
      )
      const judgments = raw.records.map((record) =>
        validateIntentShadow(record, entry.input.evidence, { state: 'unknown', refs: [] })
      )
      const expectedSources = entry.input.evidence
        .filter((source) => source.kind === 'speech')
        .map((source) => source.evidenceId)
        .sort()
      const actualSources = judgments.map((judgment) => judgment.claim?.evidenceId).sort()
      const coverage = JSON.stringify(actualSources) === JSON.stringify(expectedSources)
      write(`${entry.id}.shadow.json`, {
        judgments,
        coverage,
        semanticAssessment: 'pending_independent_review',
        automaticAssignment: 'not_authorized',
      })
      result.status =
        coverage && judgments.every((judgment) => judgment.structural.status === 'valid')
          ? 'completed_structurally_valid'
          : 'completed_structurally_invalid'
      result.coverage = coverage
      result.structuralIssues = judgments.flatMap((judgment) => judgment.structural.issues)
    } catch (error) {
      result.status = fatalBoundary
        ? 'execution_boundary_failed'
        : controller.signal.aborted
          ? 'timed_out'
          : 'execution_or_parse_failed'
      result.error = error instanceof Error ? error.message : String(error)
    } finally {
      clearTimeout(timeout)
      rmSync(runtime, { recursive: true, force: true })
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
    if (fatalBoundary) {
      manifest.executionStatus = 'aborted_on_provider_boundary'
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
