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
const planPath = path.join(root, 'experiments/always-on-agent/intent-temporal-v5-baseline.json')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const read = (file: string) => readFileSync(path.join(root, file), 'utf8')

type Input = { language: string; userName: string; workItems: unknown[]; evidence: AmbientEvidence[] }
type Case = { id: string; input: Input; baseline?: unknown; expected?: unknown; oracle?: unknown }
type Control = { id: string; corpus: string } | { id: string; input: string; parsed?: string; oracleCorpus?: string }
type Variant = { id: 'baselinev4' | 'scopedv5'; prompt: string }
type Plan = {
  files: Record<string, string>
  schemaHash: string
  controls: Control[]
  contrasts: string[]
  variants: Variant[]
  casesPerVariant: number
  callsPerRound: number
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
  const readFrozen = (file: string) => {
    assert(Object.hasOwn(plan.files, file), `Consumed file missing from freeze: ${file}`)
    const content = read(file)
    assert.equal(hash(content), plan.files[file], `Frozen file changed while loading: ${file}`)
    return content
  }
  const corpus = (file: string): Array<Case & { expected?: unknown }> =>
    readFrozen(file)
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  const selected = (file: string, id: string) => {
    const matches = corpus(file).filter((entry) => entry.id === id)
    assert.equal(matches.length, 1, `Expected one ${id} in ${file}`)
    const entry = matches[0]
    assert(entry)
    return entry
  }
  assert.deepEqual(
    plan.controls.map((entry) => entry.id),
    ['OC-05', 'HO-003', 'HO-001', 'NO-03']
  )
  assert.deepEqual(
    plan.variants.map((variant) => variant.id),
    ['baselinev4', 'scopedv5']
  )
  assert.equal(plan.casesPerVariant, 10)
  assert.equal(plan.callsPerRound, 20)
  const variants = plan.variants.map((variant) => ({ ...variant, systemPrompt: readFrozen(variant.prompt) }))
  const variantOrder = round === 1 ? variants : [...variants].reverse()
  const fresh = plan.contrasts.flatMap(corpus)
  assert.equal(fresh.length, 6)
  const cases: Case[] = [
    ...plan.controls.map((entry) => {
      if ('corpus' in entry) return selected(entry.corpus, entry.id)
      const oracle = entry.oracleCorpus ? selected(entry.oracleCorpus, entry.id) : undefined
      return {
        id: entry.id,
        input: JSON.parse(readFrozen(entry.input)),
        baseline: entry.parsed ? JSON.parse(readFrozen(entry.parsed)) : undefined,
        expected: oracle?.expected,
        oracle,
      }
    }),
    ...fresh,
  ]
  assert.equal(cases.length, plan.casesPerVariant)
  assert.equal(new Set(cases.map((entry) => entry.id)).size, cases.length)
  assert(
    cases.every((entry) => /^[A-Z]{2}-\d{2,3}$/.test(entry.id)),
    'Case IDs must be safe artifact names'
  )
  for (const entry of cases) {
    assert.deepEqual(Object.keys(entry.input).sort(), ['evidence', 'language', 'userName', 'workItems'])
    assert.equal(entry.input.workItems.length, 0)
    assert.equal(entry.input.evidence.filter((source) => source.kind === 'speech').length, 1)
    for (const source of entry.input.evidence) assert.equal(source.revision, hash(source.text))
  }
  const preparedCases = variantOrder.flatMap((variant) =>
    cases.map((entry) => {
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
        policyEpoch: 'E03.6-fixed-synthetic-policy-v1',
        allowed: true,
      }
      return {
        ...entry,
        variantId: variant.id,
        systemPrompt: variant.systemPrompt,
        reference,
        snapshot,
        request: prepareIntentShadowV4(reference, snapshot),
        preparedAt: new Date().toISOString(),
      }
    })
  )
  assert.equal(preparedCases.length, plan.callsPerRound)
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
    '/private/tmp/remember-intent-temporal/runs',
    `${new Date().toISOString().replace(/:/g, '-')}-round${round}`
  )
  mkdirSync(path.dirname(directory), { recursive: true })
  mkdirSync(directory)
  const write = (file: string, value: unknown) =>
    writeFileSync(path.join(directory, file), JSON.stringify(value, null, 2))
  const manifest = {
    experiment: 'E03.6-temporal-comparison',
    variantOrder: variantOrder.map((variant) => variant.id),
    caseOrder: cases.map((entry) => entry.id),
    casesPerVariant: plan.casesPerVariant,
    callsPerRound: plan.callsPerRound,
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
  writeFileSync(path.join(directory, 'baseline-plan.json'), planText)
  for (const variant of variants) {
    mkdirSync(path.join(directory, variant.id))
    writeFileSync(path.join(directory, variant.id, 'system-prompt.txt'), variant.systemPrompt)
  }
  console.log(`Temporal comparison artifacts: ${directory}`)
  for (const [callIndex, entry] of preparedCases.entries()) {
    const prefix = `${entry.variantId}/${entry.id}`
    write(`${prefix}.input.json`, entry.input)
    write(`${prefix}.comparison-only.json`, {
      baseline: entry.baseline ?? null,
      expected: entry.expected ?? null,
      oracle: entry.oracle ?? null,
      projectedToModel: false,
    })
    write(`${prefix}.caller-reference.json`, entry.reference)
    write(`${prefix}.snapshot.json`, entry.snapshot)
    write(`${prefix}.offered-input.json`, entry.request.input)
    const providerInput = `${entry.systemPrompt}\n\n${JSON.stringify(entry.request.input)}`
    writeFileSync(path.join(directory, `${prefix}.provider-input.txt`), providerInput)
    const runtime = mkdtempSync(path.join(tmpdir(), `remember-intent-temporal-${entry.variantId}-`))
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), manifest.timeoutMsPerCase)
    const started = performance.now()
    const result: Record<string, unknown> = {
      id: entry.id,
      variantId: entry.variantId,
      callIndex,
      status: 'running',
      preparedAt: entry.preparedAt,
      providerStartedAt: null,
      runtimeDirectory: runtime,
      callerReference: entry.reference,
      snapshotMode: 'fixed_synthetic_fixture',
      semanticAssessment: 'pending_independent_review',
    }
    const eventPath = path.join(directory, `${prefix}.provider-events.jsonl`)
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
      write(`${prefix}.result.json`, result)
      writeFileSync(eventPath, '')
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
      write(`${prefix}.result.json`, result)
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
      writeFileSync(path.join(directory, `${prefix}.raw.txt`), finalMessage)
      const raw: unknown = JSON.parse(finalMessage)
      write(`${prefix}.raw.json`, raw)
      write(`${prefix}.current-snapshot.json`, entry.snapshot)
      const bound = entry.request.accept(raw, entry.snapshot)
      write(`${prefix}.shadow.json`, {
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
      write(`${prefix}.result.json`, result)
      write('manifest.json', manifest)
      console.log(
        JSON.stringify({
          variantId: entry.variantId,
          id: entry.id,
          status: result.status,
          modelElapsedMs: result.modelElapsedMs,
        })
      )
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
