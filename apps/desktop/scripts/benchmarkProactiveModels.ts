import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Codex } from '@openai/codex-sdk'
import { bundledCodexExecutablePath } from '../src/main/codexRuntimePaths'
import { buildCodexSdkConfiguration } from '../src/main/dailyReview/codexAgentSdk'

type Source = { id: string; text: string; revision: string }
type Case = { id: string; input: { sources: Source[]; newSourceIds: string[]; allowedGrants: { id: string }[] } }
type Oracle = { id: string; acceptableKinds: string[]; requiredSourceIds: string[]; sourceAlternatives: string[][] }
type Decision = {
  kind: string
  text: string
  sourceIds: string[]
  uncertainty: string
  rationale: string
  preparation: null | { grantId: string; description: string }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const experiment = path.join(root, 'experiments/proactive-models')
const modelIds = ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-6-astra']
const repeats = ['PM03', 'PM04', 'PM07', 'PM09']
const args = process.argv.slice(2)
const run = args.includes('--run')
assert(run !== args.includes('--dry-run'), 'Select exactly --run or --dry-run')
const out = args[args.indexOf('--out') + 1]
assert(args.includes('--out') && out && path.isAbsolute(out), 'An absolute new --out directory is required')
assert(!existsSync(out), 'Output directory already exists; preserve earlier runs')
const load = (name: string) => JSON.parse(readFileSync(path.join(experiment, name), 'utf8'))
const corpus = load('cases.v1.json') as { cases: Case[] }
const oracle = load('oracle.v1.json') as { cases: Oracle[] }
const schema = load('schema.v1.json')
const prompt = readFileSync(path.join(experiment, 'prompt.v1.txt'), 'utf8')
const catalogPath = path.join(homedir(), 'Library/Application Support/Remember/codex-models.json')
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as {
  model: string
  supportedReasoningEfforts: string[]
}[]
const executable = bundledCodexExecutablePath({
  isPackaged: false,
  appPath: path.join(root, 'apps/desktop'),
  resourcesPath: '',
})
assert(executable && existsSync(executable), 'Bundled Codex executable unavailable')
for (const model of modelIds) {
  assert(
    catalog.some((entry) => entry.model === model && entry.supportedReasoningEfforts.includes('low')),
    `Model absent from catalog: ${model}`
  )
}
assert.equal(corpus.cases.length, 16)
assert.equal(new Set(corpus.cases.map((entry) => entry.id)).size, 16)
assert.equal(oracle.cases.length, 16)
for (const entry of corpus.cases) {
  const ids = entry.input.sources.map((source) => source.id)
  assert.equal(ids.length, new Set(ids).size, `Duplicate source ID: ${entry.id}`)
  assert(
    entry.input.newSourceIds.every((id) => ids.includes(id)),
    'Unbound trigger'
  )
  const expected = oracle.cases.find((item) => item.id === entry.id)
  assert(expected, `Missing oracle: ${entry.id}`)
  assert(
    expected.requiredSourceIds.every((id) => ids.includes(id)),
    'Unbound oracle source'
  )
  assert(JSON.stringify(entry.input).length < 48_000, 'Input exceeds frozen bound')
}

const schedule = corpus.cases.flatMap((entry, i) =>
  modelIds.map((_, offset) => ({
    caseId: entry.id,
    model: modelIds[(i + offset) % 3],
    repeat: false,
  }))
)
for (const caseId of repeats) {
  const i = corpus.cases.findIndex((entry) => entry.id === caseId)
  assert(i >= 0)
  for (let offset = 2; offset >= 0; offset--) schedule.push({ caseId, model: modelIds[(i + offset) % 3], repeat: true })
}
assert.equal(schedule.length, 60)

mkdirSync(out)
mkdirSync(path.join(out, 'frozen'))
const write = (name: string, value: unknown) =>
  writeFileSync(path.join(out, name), `${JSON.stringify(value, null, 2)}\n`)
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const freezeFiles = [
  ...['README.md', 'CASE-DESIGN.md', 'cases.v1.json', 'oracle.v1.json', 'prompt.v1.txt', 'schema.v1.json'].map((name) =>
    path.join(experiment, name)
  ),
  fileURLToPath(import.meta.url),
  path.join(root, 'apps/desktop/src/main/dailyReview/codexAgentSdk.ts'),
  path.join(root, 'apps/desktop/src/main/codexRuntimePaths.ts'),
  path.join(root, 'apps/desktop/package.json'),
  catalogPath,
]
const frozen = freezeFiles.map((file, i) => {
  const archived = `frozen/${String(i).padStart(2, '0')}-${path.basename(file)}`
  copyFileSync(file, path.join(out, archived))
  return { file, archived, sha256: hash(readFileSync(file)) }
})
const manifest = {
  createdAt: new Date().toISOString(),
  mode: run ? 'real_tools_disabled_models' : 'zero_call_dry_run',
  pid: process.pid,
  modelIds,
  effort: 'low',
  executable,
  executableSha256: hash(readFileSync(executable)),
  executableVersion: execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim(),
  timeoutMs: 120_000,
  applicationRetries: 0,
  effectiveModel: null,
  effectiveModelEvidence: 'not_reported_by_sdk',
  frozen,
  schedule,
}
write('manifest.json', manifest)
const inputs = new Map(corpus.cases.map((entry) => [entry.id, `${prompt}\n\n${JSON.stringify(entry.input)}`]))
for (const [id, input] of inputs) writeFileSync(path.join(out, `${id}.input.txt`), input)

function validate(value: unknown, entry: Case): string[] {
  const issues: string[] = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['not-object']
  const record = value as Decision
  if (Object.keys(record).sort().join(',') !== 'kind,preparation,rationale,sourceIds,text,uncertainty')
    issues.push('keys')
  if (!['silent', 'observe', 'clarify', 'offer', 'prepare'].includes(record.kind)) issues.push('kind')
  if (!['none', 'meaning', 'ownership', 'conflict'].includes(record.uncertainty)) issues.push('uncertainty')
  if (typeof record.text !== 'string' || typeof record.rationale !== 'string') issues.push('text')
  if (record.kind === 'silent' && record.text !== '') issues.push('silent-text')
  if (record.kind !== 'silent' && (typeof record.text !== 'string' || !record.text.trim())) issues.push('missing-text')
  if (
    !Array.isArray(record.sourceIds) ||
    record.sourceIds.some((id) => !entry.input.sources.some((source) => source.id === id))
  )
    issues.push('sourceIds')
  if (Array.isArray(record.sourceIds) && new Set(record.sourceIds).size !== record.sourceIds.length)
    issues.push('duplicate-sourceIds')
  if (record.kind === 'prepare') {
    if (
      !record.preparation ||
      typeof record.preparation.description !== 'string' ||
      !entry.input.allowedGrants.some((grant) => grant.id === record.preparation?.grantId)
    )
      issues.push('unbound-grant')
  } else if (record.preparation !== null) issues.push('unexpected-preparation')
  return issues
}

const results: Record<string, unknown>[] = []
let consecutiveFailures = 0
let stopReason: string | null = null
if (run)
  for (const [index, planned] of schedule.entries()) {
    const entry = corpus.cases.find((item) => item.id === planned.caseId)
    assert(entry)
    const prefix = `${String(index + 1).padStart(2, '0')}-${planned.caseId}-${planned.model}`
    const runtime = mkdtempSync(path.join(tmpdir(), 'remember-pm-v1-'))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), manifest.timeoutMs)
    const started = performance.now()
    const result: Record<string, unknown> = {
      ...planned,
      index: index + 1,
      prefix,
      requestedEffort: 'low',
      effectiveModel: null,
      effectiveModelEvidence: 'not_reported',
      startedAt: new Date().toISOString(),
      runtime,
      status: 'running',
      lifecycle: { thread: 0, started: 0, completed: 0 },
    }
    const lifecycle = result.lifecycle as { thread: number; started: number; completed: number }
    const messages: string[] = []
    const itemTypes = new Set<string>()
    let boundaryFailure = false
    let eventCount = 0
    write(`${prefix}.result.json`, result)
    try {
      const configuration = buildCodexSdkConfiguration({
        abortController: controller,
        cwd: runtime,
        executable,
        env: { ...process.env, CODEX_HOME: path.join(homedir(), 'Library/Application Support/Remember/codex') },
        model: planned.model,
        effort: 'low',
        schema,
        toolsDisabled: true,
      })
      const input = inputs.get(entry.id)
      assert(input, 'Missing prepared input')
      const stream = await new Codex(configuration.client)
        .startThread(configuration.thread)
        .runStreamed(input, configuration.turn)
      for await (const event of stream.events) {
        appendFileSync(
          path.join(out, `${prefix}.events.jsonl`),
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
          boundaryFailure = true
          controller.abort()
          throw new Error(`unknown-provider-event:${event.type}`)
        }
        if ('item' in event) {
          itemTypes.add(event.item.type)
          if (!['agent_message', 'reasoning', 'error'].includes(event.item.type)) {
            boundaryFailure = true
            controller.abort()
            throw new Error(`unexpected-execution-item:${event.item.type}`)
          }
          if (event.type === 'item.completed' && event.item.type === 'agent_message') messages.push(event.item.text)
        }
        if (event.type === 'thread.started') {
          lifecycle.thread++
          result.threadId = event.thread_id
        }
        if (event.type === 'turn.started') lifecycle.started++
        if (event.type === 'turn.completed') {
          lifecycle.completed++
          result.usage = event.usage
        }
        if (event.type === 'turn.failed') throw new Error(event.error.message)
        if (event.type === 'error') throw new Error(event.message)
      }
      assert(
        Object.values(lifecycle).every((count) => count === 1),
        'Expected exactly one complete thread/turn'
      )
      assert.equal(messages.length, 1, 'Expected exactly one final response')
      writeFileSync(path.join(out, `${prefix}.raw.txt`), messages[0])
      const output: unknown = JSON.parse(messages[0])
      result.output = output
      const issues = validate(output, entry)
      result.structuralIssues = issues
      result.status = issues.length ? 'structurally_invalid' : 'completed'
      result.semanticAssessment = 'pending_independent_review'
      consecutiveFailures = 0
    } catch (error) {
      result.status = boundaryFailure ? 'boundary_failed' : controller.signal.aborted ? 'timed_out' : 'failed'
      result.error = error instanceof Error ? error.message : String(error)
      consecutiveFailures++
    } finally {
      clearTimeout(timer)
      result.durationMs = performance.now() - started
      result.endedAt = new Date().toISOString()
      result.eventCount = eventCount
      result.itemTypes = [...itemTypes]
      rmSync(runtime, { recursive: true, force: true })
      result.runtimeRemoved = !existsSync(runtime)
      write(`${prefix}.result.json`, result)
      results.push(result)
      write('progress.json', { completedCalls: results.length, totalCalls: schedule.length, results })
      process.stdout.write(`${prefix} ${result.status} ${Math.round(Number(result.durationMs))}ms\n`)
    }
    if (boundaryFailure || consecutiveFailures >= 3) {
      stopReason = boundaryFailure ? 'execution-boundary' : 'three-consecutive-failures'
      break
    }
  }
write('report.json', {
  status: !run
    ? 'dry_run_passed'
    : stopReason
      ? 'stopped'
      : results.every((result) => result.status === 'completed')
        ? 'completed_pending_semantic_assessment'
        : 'completed_with_failures',
  stopReason,
  modelCalls: results.length,
  plannedCalls: schedule.length,
  frozenUnchanged: frozen.every((entry) => hash(readFileSync(entry.file)) === entry.sha256),
  results,
})
process.stdout.write(`${out}/report.json\n`)
