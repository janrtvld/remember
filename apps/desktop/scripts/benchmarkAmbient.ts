import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { arch, cpus, homedir, platform, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Codex } from '@openai/codex-sdk'
import type { WorkItem } from '@remember/shared'
import { bundledCodexExecutablePath } from '../src/main/codexRuntimePaths'
import { parseJsonResponse } from '../src/main/dailyReview/agentResponse'
import { AMBIENT_TASK_SCHEMA, parseAmbientTaskPlan } from '../src/main/dailyReview/ambientTaskPolicy'
import { AMBIENT_TASK_SYSTEM_PROMPT, ambientTaskPrompt } from '../src/main/dailyReview/ambientTaskPrompt'
import { type AmbientEvidence, ambientEvidenceRevision } from '../src/main/dailyReview/ambientTaskStore'
import { buildCodexSdkConfiguration } from '../src/main/dailyReview/codexAgentSdk'

type SourceEvent = {
  id: string
  kind: string
  at_ms?: number
  observed_start_ms?: number
  observed_end_ms?: number
  observed_at_ms?: number
  source_id?: string
  source?: string
  text?: string
  app_name?: string
  bundle_id?: string
  window_title?: string
  project_label?: string
  url?: string
}

type Scenario = {
  id: string
  schema_version: string
  title: string
  language: 'nl' | 'en'
  clock_origin: string
  initial_state: {
    user_name: string
    cloud_analysis_consent: boolean
    live_task_updates: boolean
    offline: boolean
    tasks: Array<{ key: string; result: string; source_refs: string[]; lifecycle: WorkItem['lifecycle'] }>
    evidence: SourceEvent[]
    space_pages: unknown[]
    chat: unknown[]
  }
  events: SourceEvent[]
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const holdout = process.argv.includes('--holdout')
assert(
  process.argv.slice(2).every((argument) => argument === '--holdout'),
  'Only --holdout is supported'
)
const corpusPath = path.join(
  root,
  'tests/fixtures/always-on-benchmarks',
  holdout ? 'v1.holdout.jsonl' : 'v1.scenarios.jsonl'
)
const selectedIds = holdout
  ? ['HO-001', 'HO-002', 'HO-003', 'HO-004', 'HO-005', 'HO-006']
  : ['AO-001', 'AO-002', 'AO-003', 'AO-006', 'AO-007', 'AO-008', 'AO-010', 'AO-011', 'AO-020']
const frozenCorpusHash = holdout
  ? '9e16afbc0dbed828ea89b940d05e9a717010c59b4180353caea70caae6946c5d'
  : '7602813d5edc6ffb16852a10b83356baecd79322e9e3d52ba6df0545e856ef95'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

function projectSource(scenario: Scenario, event: SourceEvent): AmbientEvidence {
  assert(event.kind === 'speech.accepted' || event.kind === 'context.observed')
  assert(typeof event.text === 'string')
  const kind = event.kind === 'speech.accepted' ? 'speech' : 'context'
  const sourceId = `${scenario.id}:${event.source_id ?? event.id}`
  const offset = kind === 'speech' ? event.observed_end_ms : event.observed_at_ms
  assert(typeof offset === 'number', `Observed timestamp required: ${scenario.id}/${event.id}`)
  return {
    kind,
    sourceId,
    evidenceId: kind === 'speech' ? `speech:${sourceId}` : sourceId,
    workdayId: 'benchmark-2026-10-22',
    revision: ambientEvidenceRevision(event.text),
    observedAt: Date.parse(scenario.clock_origin) + offset,
    text: event.text,
    source: kind === 'speech' ? (event.source ?? 'system') : 'screen',
    appName: event.app_name ?? '',
    bundleId: event.bundle_id ?? '',
    windowTitle: event.window_title ?? event.project_label ?? '',
    url: event.url ?? '',
  }
}

function projectItems(scenario: Scenario): WorkItem[] {
  const at = Date.parse(scenario.clock_origin) - 600_000
  return scenario.initial_state.tasks.map((task) => {
    const sources = task.source_refs.map((id) => {
      const source = scenario.initial_state.evidence.find((entry) => entry.id === id)
      assert(source?.text, `Missing initial task source: ${scenario.id}/${id}`)
      return source
    })
    return {
      id: task.key,
      title: task.result,
      description: task.result,
      prompt: '',
      aiSuggestion: null,
      context: sources.map((source) => source.text).join('\n'),
      returnPoint: { lastMove: '', unresolved: '', nextMove: task.result },
      lifecycle: task.lifecycle,
      status: 'todo',
      priority: 'none',
      dueAt: null,
      attention: 'idle',
      createdAt: at,
      updatedAt: at,
      closedAt: task.lifecycle === 'open' ? null : at,
      userEditedTitle: false,
      userEditedDescription: false,
      sources: sources.map((source) => ({
        id: source.id,
        kind: 'observed',
        label: source.app_name ?? 'Mail',
        detail: source.text ?? '',
        workdayId: 'benchmark-2026-10-22',
        conversationStartTime: null,
        observedAt: at,
        confidence: null,
      })),
      facts: [],
      observations: [],
      agentSessions: [],
    }
  })
}

async function main() {
  const corpus = readFileSync(corpusPath, 'utf8')
  assert.equal(hash(corpus), frozenCorpusHash, 'Corpus changed: review and freeze a new baseline before running')
  const scenarios: Scenario[] = corpus
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const settings = JSON.parse(
    readFileSync(path.join(homedir(), 'Library/Application Support/Remember/settings.json'), 'utf8')
  )
  const executable = bundledCodexExecutablePath({
    isPackaged: false,
    appPath: path.join(root, 'apps/desktop'),
    resourcesPath: '',
  })
  assert(executable)
  assert(typeof settings.codexAnalysisModel === 'string' && typeof settings.codexAnalysisEffort === 'string')
  const directory = path.join(root, '.qa/always-on-benchmarks', new Date().toISOString().replace(/:/g, '-'))
  mkdirSync(directory, { recursive: true })
  const write = (file: string, value: unknown) =>
    writeFileSync(path.join(directory, file), JSON.stringify(value, null, 2))
  writeFileSync(path.join(directory, 'system-prompt.txt'), AMBIENT_TASK_SYSTEM_PROMPT)
  write('schema.json', AMBIENT_TASK_SCHEMA)
  const run = {
    startedAt: new Date().toISOString(),
    completedAt: null as string | null,
    executionStatus: 'running',
    semanticAssessment: 'pending_human_review',
    corpus: { path: path.relative(root, corpusPath), sha256: hash(corpus), scenarios: scenarios.length },
    runtime: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? 'unknown' },
    runnerSHA256: hash(readFileSync(fileURLToPath(import.meta.url), 'utf8')),
    gitRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    dirtyStatus: execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }),
    productionSources: Object.fromEntries(
      [
        'ambientTaskPrompt.ts',
        'ambientTaskPolicy.ts',
        'ambientTaskStore.ts',
        'analysisFormat.ts',
        'analysisSchemas.ts',
        'inboxTaskPolicy.ts',
        'workItemPrompt.ts',
        'codexAgentSdk.ts',
      ].map((file) => [file, hash(readFileSync(path.join(root, 'apps/desktop/src/main/dailyReview', file), 'utf8'))])
    ),
    provider: 'codex',
    model: settings.codexAnalysisModel,
    effort: settings.codexAnalysisEffort,
    toolsDisabled: true,
    applicationRetries: 0,
    timeoutMsPerCase: 180_000,
    baselineScope:
      'One bounded model analysis per scenario on the allowed source batch; no application scheduler, storage, notifications, capture, ASR, remote tools, privacy transitions or renderer.',
    nativeLatency: 'not_measured',
    actualInterruptions: 'not_measured',
    actualTaskCommits: 'not_measured',
    selected: selectedIds,
    unselected: scenarios
      .filter((entry) => !selectedIds.includes(entry.id))
      .map((entry) => ({
        id: entry.id,
        status: 'not_run',
        reason: 'Outside the first text-analysis baseline; requires additional stateful or runtime boundaries.',
      })),
    cases: [] as Array<Record<string, unknown>>,
  }
  write('manifest.json', run)
  console.log(`Baseline artifacts: ${directory}`)
  for (const id of selectedIds) {
    const scenario = scenarios.find((entry) => entry.id === id)
    assert(scenario)
    assert(
      scenario.initial_state.cloud_analysis_consent &&
        scenario.initial_state.live_task_updates &&
        !scenario.initial_state.offline
    )
    assert(
      scenario.initial_state.space_pages.length === 0 && scenario.initial_state.chat.length === 0,
      'This baseline does not project Wiki or chat history'
    )
    const sourceEvents = scenario.events.filter((event) => ['speech.accepted', 'context.observed'].includes(event.kind))
    const evidence = sourceEvents.map((event) => projectSource(scenario, event))
    assert(evidence.length > 0 && evidence.length <= 12)
    const items = projectItems(scenario)
    const prompt = ambientTaskPrompt(evidence, items, scenario.initial_state.user_name, scenario.language)
    write(`${id}.input.json`, JSON.parse(prompt))
    write(`${id}.projection.json`, {
      includedEventIds: sourceEvents.map((event) => event.id),
      excludedControlEvents: scenario.events
        .filter((event) => !sourceEvents.includes(event))
        .map((event) => ({ id: event.id, kind: event.kind })),
      sourceObservedTimesPreserved: true,
      scenarioTimingNotReplayed: true,
      expectedAndGroundTruthProjected: false,
    })
    const runtime = mkdtempSync(path.join(tmpdir(), 'remember-benchmark-'))
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), run.timeoutMsPerCase)
    const startedAt = Date.now()
    const started = performance.now()
    const result: Record<string, unknown> = {
      id,
      startedAt,
      status: 'running',
      semanticAssessment: 'pending_human_review',
    }
    try {
      const configuration = buildCodexSdkConfiguration({
        abortController: controller,
        cwd: runtime,
        executable,
        env: { ...process.env, CODEX_HOME: path.join(homedir(), 'Library/Application Support/Remember/codex') },
        model: settings.codexAnalysisModel,
        effort: settings.codexAnalysisEffort,
        schema: AMBIENT_TASK_SCHEMA,
        toolsDisabled: true,
      })
      const response = await new Codex(configuration.client)
        .startThread(configuration.thread)
        .run(`${AMBIENT_TASK_SYSTEM_PROMPT}\n\n${prompt}`, configuration.turn)
      writeFileSync(path.join(directory, `${id}.raw.txt`), response.finalResponse)
      write(`${id}.provider-items.json`, response.items)
      result.providerItemTypes = response.items.map((item) => item.type)
      assert(
        response.items.every((item) => ['agent_message', 'reasoning', 'error'].includes(item.type)),
        'Unexpected tool or execution item in a tools-disabled benchmark'
      )
      result.modelElapsedMs = Math.round(performance.now() - started)
      result.usage = response.usage
      const raw = parseJsonResponse(response.finalResponse)
      write(`${id}.raw.json`, raw)
      const plan = parseAmbientTaskPlan(raw, evidence, scenario.initial_state.user_name, items)
      write(`${id}.parsed.json`, plan)
      result.status = 'model_completed_and_parser_accepted'
      result.proposedCount = plan.proposed.length
      result.changeCount = plan.changes.length
      result.notifyTitles = plan.notifyTitles
      result.consideredEvidenceIds = plan.consideredEvidenceIds
    } catch (error) {
      result.status = controller.signal.aborted ? 'timed_out' : 'execution_or_parser_error'
      result.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    } finally {
      clearTimeout(timeout)
      rmSync(runtime, { recursive: true, force: true })
      result.elapsedMs = Math.round(performance.now() - started)
      result.completedAt = Date.now()
      run.cases.push(result)
      write(`${id}.result.json`, result)
      write('manifest.json', run)
      console.log(JSON.stringify(result))
    }
  }
  run.completedAt = new Date().toISOString()
  run.executionStatus = 'completed'
  write('manifest.json', run)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
