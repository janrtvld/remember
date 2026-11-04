import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
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
import {
  type BriefingInput,
  validateBriefingOutput,
} from '../../../experiments/proactive-agent/briefing-models/validateOutput.mjs'
import { bundledCodexExecutablePath } from '../src/main/codexRuntimePaths'
import { buildCodexSdkConfiguration } from '../src/main/dailyReview/codexAgentSdk'

type Input = BriefingInput & {
  candidate: { kind: string; sourceIds: string[] }
  trigger: { sourceId: string; observedAt: string; ageMs: number; freshness: string }
  clock: { utc: string }
}
type Case = { id: string; input: Input }
type Planned = { caseId: string; model: string; effort: 'low' }
type Frozen = { file: string; archived: string; sha256: string }
type Manifest = {
  version: 1
  preparedAt: string
  mode: 'baseline' | 'comparison'
  schedule: Planned[]
  frozen: Frozen[]
  executable: string
  executableSha256: string
  executableVersion: string
  catalogPath: string
  runtimeConfig: unknown
  timeoutMs: number
  applicationRetries: 0
  fallbacks: 0
  providerInternalRetries: 'not_measured'
  comparisonSource: string | null
}
type ComparisonApproval = {
  baselineDirectory: string
  cases: { caseId: string; missedRequirementIds: string[]; semanticAssessment: string }[]
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const experiment = path.join(root, 'experiments/proactive-agent/briefing-models')
const args = process.argv.slice(2)
const allowed = new Set(['--dry-run', '--run', '--out', '--comparison-approval'])
for (let i = 0; i < args.length; i++) {
  assert(allowed.has(args[i]!), `Unknown flag: ${args[i]}`)
  if (args[i] === '--out' || args[i] === '--comparison-approval') i++
}
const run = args.includes('--run')
assert(run !== args.includes('--dry-run'), 'Select exactly --dry-run or --run')
assert(args.filter((arg) => arg === '--out').length === 1, 'One --out required')
const out = args[args.indexOf('--out') + 1]
assert(out && path.isAbsolute(out), 'Absolute --out required')
const approvalIndex = args.indexOf('--comparison-approval')
const approvalPath = approvalIndex < 0 ? null : args[approvalIndex + 1]
assert(!run || approvalPath === null, 'Approval is supplied only when preparing the frozen comparison')
assert(!approvalPath || path.isAbsolute(approvalPath), 'Absolute comparison approval path required')
const json = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const write = (file: string, value: unknown) =>
  writeFileSync(path.join(out, file), `${JSON.stringify(value, null, 2)}\n`)
const corpus = json<{ cases: Case[] }>(path.join(experiment, 'cases.v1.json'))
const schema = json<object>(path.join(experiment, 'schema.v1.json'))
const prompt = readFileSync(path.join(experiment, 'prompt.v1.txt'))
const catalogPath = path.join(homedir(), 'Library/Application Support/Remember/codex-models.json')
const catalog = json<{ model: string; supportedReasoningEfforts: string[] }[]>(catalogPath)
const executable = bundledCodexExecutablePath({
  isPackaged: false,
  appPath: path.join(root, 'apps/desktop'),
  resourcesPath: '',
})
assert(executable && existsSync(executable), 'Bundled executable missing')
const authHome = path.join(homedir(), 'Library/Application Support/Remember/codex')
assert(existsSync(path.join(authHome, 'auth.json')), 'Existing provider login missing; do not copy credentials')
assert.deepEqual(
  corpus.cases.map((entry) => entry.id),
  ['BP01', 'BP02', 'BP03']
)
const inputs = new Map<string, string>()
for (const entry of corpus.cases) {
  const file = path.join(experiment, 'inputs', `${entry.id}.json`)
  assert.deepEqual(json(file), entry.input, 'Standalone input differs from corpus')
  assert.deepEqual(entry.input.candidate, { kind: 'private-briefing', sourceIds: [entry.input.trigger.sourceId] })
  assert.equal(new Set(entry.input.sources.map((source) => source.sourceId)).size, entry.input.sources.length)
  assert(entry.input.sources.some((source) => source.sourceId === entry.input.trigger.sourceId))
  for (const source of entry.input.sources) assert.equal(hash(source.text), source.revision)
  assert.equal(
    Date.parse(entry.input.clock.utc) - Date.parse(entry.input.trigger.observedAt),
    entry.input.trigger.ageMs
  )
  assert.equal(entry.input.trigger.ageMs <= 120_000, entry.input.trigger.freshness === 'fresh')
  const bytes = Buffer.concat([prompt, Buffer.from('\n'), readFileSync(file)])
  assert(bytes.length < 48_000)
  assert.deepEqual(
    readFileSync(path.join(experiment, 'calls', `${entry.id}.input.txt`)),
    bytes,
    'Materialized prompt mismatch'
  )
  inputs.set(entry.id, bytes.toString('utf8'))
}

function configuration(runtime: string, model: string, controller: AbortController) {
  return buildCodexSdkConfiguration({
    abortController: controller,
    cwd: runtime,
    executable: executable!,
    env: { ...process.env, CODEX_HOME: authHome },
    model,
    effort: 'low',
    schema,
    toolsDisabled: true,
  })
}

function safeConfiguration(model: string) {
  const runtime = mkdtempSync(path.join(tmpdir(), 'remember-bp-config-'))
  try {
    const value = configuration(runtime, model, new AbortController())
    return {
      clientConfig: value.client.config,
      thread: { ...value.thread, workingDirectory: '<per-call-disposable-directory>' },
      outputSchemaSha256: hash(JSON.stringify(value.turn.outputSchema)),
      wrapperSha256: hash(readFileSync(value.client.codexPathOverride!)),
      auth: 'existing file-backed login via scoped symlink; no credential copy',
      authHome,
      toolsDisabled: true,
      freshThread: true,
      environmentValues: 'not recorded; existing process environment passed to established SDK helper',
    }
  } finally {
    rmSync(runtime, { recursive: true, force: true })
  }
}

let manifest: Manifest
if (!run) {
  assert(!existsSync(out), 'New output directory required; preserve earlier runs')
  let schedule: Planned[] = corpus.cases.map((entry) => ({ caseId: entry.id, model: 'gpt-5.6-luna', effort: 'low' }))
  let comparisonSource: string | null = null
  const extraFiles: string[] = []
  if (approvalPath) {
    const approval = json<ComparisonApproval>(approvalPath)
    assert(path.isAbsolute(approval.baselineDirectory))
    assert(approval.cases.length >= 1 && approval.cases.length <= 2)
    assert.equal(new Set(approval.cases.map((entry) => entry.caseId)).size, approval.cases.length)
    const baseline = json<Manifest>(path.join(approval.baselineDirectory, 'manifest.json'))
    assert.equal(baseline.mode, 'baseline')
    assert(existsSync(path.join(approval.baselineDirectory, 'report.json')), 'Completed baseline report required')
    const oracle = json<{ cases: { id: string; requirements: { id: string }[] }[] }>(
      path.join(experiment, 'oracle.v1.json')
    )
    for (const eligible of approval.cases) {
      assert(['BP01', 'BP02'].includes(eligible.caseId), 'Only positive cases may compare')
      assert(eligible.missedRequirementIds.length > 0 && eligible.semanticAssessment.trim())
      const requirementIds = oracle.cases
        .find((entry) => entry.id === eligible.caseId)!
        .requirements.map((item) => item.id)
      assert(eligible.missedRequirementIds.every((id) => requirementIds.includes(id)))
      const resultFile = path.join(approval.baselineDirectory, `${eligible.caseId}.result.json`)
      const result = json<{ status: string; structuralIssues: string[]; requestedModel: string }>(resultFile)
      assert.equal(result.status, 'completed')
      assert.deepEqual(result.structuralIssues, [])
      assert.equal(result.requestedModel, 'gpt-5.6-luna')
      assert(
        !existsSync(path.join(approval.baselineDirectory, `${eligible.caseId}.comparison-claimed.json`)),
        'Comparison already reserved'
      )
      extraFiles.push(resultFile)
    }
    comparisonSource = approval.baselineDirectory
    schedule = approval.cases.map((entry) => ({ caseId: entry.caseId, model: 'gpt-6-astra', effort: 'low' }))
    extraFiles.push(
      approvalPath,
      path.join(approval.baselineDirectory, 'manifest.json'),
      path.join(approval.baselineDirectory, 'report.json')
    )
    for (const relative of [
      'prompt.v1.txt',
      'schema.v1.json',
      ...schedule.map((entry) => `calls/${entry.caseId}.input.txt`),
    ]) {
      const file = path.join(experiment, relative)
      assert.equal(
        baseline.frozen.find((entry) => entry.file === file)?.sha256,
        hash(readFileSync(file)),
        'Comparison bytes differ'
      )
    }
  }
  for (const planned of schedule)
    assert(
      catalog.some(
        (entry) => entry.model === planned.model && entry.supportedReasoningEfforts.includes(planned.effort)
      ),
      'Requested model/effort absent from installed catalog'
    )
  mkdirSync(out)
  mkdirSync(path.join(out, 'frozen'))
  mkdirSync(path.join(out, 'blind'))
  const files = [
    ...[
      'README.md',
      'cases.v1.json',
      'oracle.v1.json',
      'prompt.v1.txt',
      'schema.v1.json',
      'validateOutput.mjs',
      'validateOutput.d.mts',
      'validateOutput.test.ts',
      ...corpus.cases.flatMap((entry) => [`inputs/${entry.id}.json`, `calls/${entry.id}.input.txt`]),
    ].map((name) => path.join(experiment, name)),
    fileURLToPath(import.meta.url),
    path.join(root, 'apps/desktop/src/main/dailyReview/codexAgentSdk.ts'),
    path.join(root, 'apps/desktop/src/main/codexRuntimePaths.ts'),
    path.join(root, 'apps/desktop/package.json'),
    path.join(root, 'pnpm-lock.yaml'),
    catalogPath,
    ...extraFiles,
  ]
  const frozen = [...new Set(files)].map((file, index) => {
    const archived = `frozen/${String(index).padStart(2, '0')}-${path.basename(file)}`
    copyFileSync(file, path.join(out, archived))
    return { file, archived, sha256: hash(readFileSync(file)) }
  })
  manifest = {
    version: 1,
    preparedAt: new Date().toISOString(),
    mode: approvalPath ? 'comparison' : 'baseline',
    schedule,
    frozen,
    executable,
    executableSha256: hash(readFileSync(executable)),
    executableVersion: execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim(),
    catalogPath,
    runtimeConfig: schedule.map((entry) => ({ model: entry.model, configuration: safeConfiguration(entry.model) })),
    timeoutMs: 120_000,
    applicationRetries: 0,
    fallbacks: 0,
    providerInternalRetries: 'not_measured',
    comparisonSource,
  }
  write('manifest.json', manifest)
  write('dry-run-report.json', {
    status: 'dry_run_passed',
    modelCalls: 0,
    preparedCalls: schedule.length,
    frozenFiles: frozen.length,
    runtimeConfigPreparedWithoutSdkInvocation: true,
  })
  process.stdout.write(`${out}/dry-run-report.json\n`)
} else {
  manifest = json<Manifest>(path.join(out, 'manifest.json'))
  const verifyFreeze = () => {
    for (const file of manifest.frozen) {
      assert.equal(hash(readFileSync(file.file)), file.sha256, `Source changed after freeze: ${file.file}`)
      assert.equal(hash(readFileSync(path.join(out, file.archived))), file.sha256, `Archive changed: ${file.archived}`)
    }
    assert.equal(hash(readFileSync(executable)), manifest.executableSha256)
    assert.equal(executable, manifest.executable)
    assert.deepEqual(
      manifest.runtimeConfig,
      manifest.schedule.map((entry) => ({ model: entry.model, configuration: safeConfiguration(entry.model) }))
    )
  }
  verifyFreeze()
  assert.equal(manifest.applicationRetries, 0)
  assert.equal(manifest.fallbacks, 0)
  assert.equal(manifest.timeoutMs, 120_000)
  assert(manifest.schedule.length >= 1 && manifest.schedule.length <= (manifest.mode === 'baseline' ? 3 : 2))
  if (manifest.mode === 'baseline')
    assert.deepEqual(
      manifest.schedule,
      corpus.cases.map((entry) => ({ caseId: entry.id, model: 'gpt-5.6-luna', effort: 'low' }))
    )
  else {
    assert(manifest.comparisonSource)
    for (const planned of manifest.schedule) {
      assert(['BP01', 'BP02'].includes(planned.caseId) && planned.model === 'gpt-6-astra' && planned.effort === 'low')
    }
  }
  writeFileSync(
    path.join(out, 'run.started.json'),
    JSON.stringify({
      at: new Date().toISOString(),
      pid: process.pid,
      manifestSha256: hash(readFileSync(path.join(out, 'manifest.json'))),
    }),
    { flag: 'wx' }
  )
  const results: Record<string, unknown>[] = []
  let current: AbortController | null = null
  let interrupted = false
  const cancel = () => {
    interrupted = true
    current?.abort(new Error('operator-cancelled'))
  }
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  let stopReason: string | null = null
  try {
    for (const planned of manifest.schedule) {
      if (interrupted) {
        stopReason = 'operator-cancelled'
        break
      }
      verifyFreeze()
      if (manifest.comparisonSource)
        writeFileSync(
          path.join(manifest.comparisonSource, `${planned.caseId}.comparison-claimed.json`),
          JSON.stringify({ out, at: new Date().toISOString() }),
          { flag: 'wx' }
        )
      const entry = corpus.cases.find((item) => item.id === planned.caseId)!
      const runtime = mkdtempSync(path.join(tmpdir(), 'remember-bp-call-'))
      const controller = new AbortController()
      current = controller
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort(new Error('call-timeout'))
      }, manifest.timeoutMs)
      const started = performance.now()
      const lifecycle = { thread: 0, started: 0, completed: 0 }
      const result: Record<string, unknown> = {
        caseId: planned.caseId,
        requestedModel: planned.model,
        requestedEffort: planned.effort,
        effectiveModel: null,
        effectiveModelEvidence: 'not_reported_by_sdk',
        startedAt: new Date().toISOString(),
        status: 'attempt_recorded',
        runtime,
        lifecycle,
        structuralIssues: [],
        semanticAssessment: 'not_assessed',
      }
      write(`${planned.caseId}.result.json`, result)
      appendFileSync(path.join(out, 'attempts.jsonl'), `${JSON.stringify({ ...planned, at: result.startedAt })}\n`)
      let boundaryFailure = false
      let sequence = 0
      let eventBytes = 0
      const messages: string[] = []
      const itemTypes = new Set<string>()
      try {
        const config = configuration(runtime, planned.model, controller)
        const stream = await new Codex(config.client)
          .startThread(config.thread)
          .runStreamed(inputs.get(planned.caseId)!, config.turn)
        for await (const event of stream.events) {
          const encoded = `${JSON.stringify({ sequence: ++sequence, at: new Date().toISOString(), event })}\n`
          eventBytes += Buffer.byteLength(encoded)
          appendFileSync(path.join(out, `${planned.caseId}.events.jsonl`), encoded)
          if (
            sequence > 512 ||
            eventBytes > 1_048_576 ||
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
            throw new Error('provider-event-boundary')
          }
          if ('item' in event) {
            itemTypes.add(event.item.type)
            if (!['agent_message', 'reasoning', 'error'].includes(event.item.type)) {
              boundaryFailure = true
              controller.abort()
              throw new Error(`unexpected-execution-item:${event.item.type}`)
            }
            if (event.type === 'item.completed' && event.item.type === 'agent_message') {
              messages.push(event.item.text)
              writeFileSync(path.join(out, `${planned.caseId}.message-${messages.length}.raw.txt`), event.item.text)
            }
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
        assert(!controller.signal.aborted, timedOut ? 'call-timeout' : 'operator-cancelled')
        assert(
          Object.values(lifecycle).every((count) => count === 1),
          'Expected one complete fresh thread and turn'
        )
        assert.equal(messages.length, 1, 'Expected exactly one final response')
        const validation = validateBriefingOutput(messages[0]!, entry.input)
        result.output = validation.output
        result.sourceRefs = validation.sourceRefs
        result.structuralIssues = validation.issues
        result.status = validation.valid ? 'completed' : 'structurally_invalid'
        result.semanticAssessment = validation.valid ? 'pending_blind_review' : 'not_eligible_until_structurally_valid'
        const reviewId = randomUUID()
        result.reviewId = reviewId
        write(`blind/${reviewId}.json`, {
          reviewId,
          caseId: planned.caseId,
          input: entry.input,
          output: validation.output,
          structuralVerdict: { valid: validation.valid, issues: validation.issues },
        })
      } catch (error) {
        result.status = boundaryFailure
          ? 'boundary_failed'
          : timedOut
            ? 'timed_out'
            : interrupted
              ? 'cancelled'
              : 'failed'
        result.error = error instanceof Error ? error.message : String(error)
      } finally {
        clearTimeout(timer)
        current = null
        result.durationMs = performance.now() - started
        result.endedAt = new Date().toISOString()
        result.eventCount = sequence
        result.itemTypes = [...itemTypes]
        rmSync(runtime, { recursive: true, force: true })
        result.runtimeRemoved = !existsSync(runtime)
        write(`${planned.caseId}.result.json`, result)
        results.push(result)
        write('progress.json', { attemptedCalls: results.length, plannedCalls: manifest.schedule.length, results })
      }
      if (boundaryFailure || interrupted) {
        stopReason = boundaryFailure ? 'execution-boundary' : 'operator-cancelled'
        break
      }
    }
  } finally {
    process.removeListener('SIGINT', cancel)
    process.removeListener('SIGTERM', cancel)
    write('report.json', {
      status: stopReason
        ? 'stopped'
        : results.length === manifest.schedule.length && results.every((item) => item.status === 'completed')
          ? 'completed_pending_semantic_review'
          : 'completed_with_failures',
      stopReason,
      modelCalls: results.length,
      plannedCalls: manifest.schedule.length,
      frozenUnchanged: manifest.frozen.every((entry) => hash(readFileSync(entry.file)) === entry.sha256),
      results,
    })
  }
  process.stdout.write(`${out}/report.json\n`)
}
