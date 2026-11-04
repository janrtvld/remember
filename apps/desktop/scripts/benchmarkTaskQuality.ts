import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Codex } from '@openai/codex-sdk'
import type { DailyReviewSession, WorkItem } from '@remember/shared'
import { bundledCodexExecutablePath } from '../src/main/codexRuntimePaths'
import { parseJsonResponse } from '../src/main/dailyReview/agentResponse'
import { AMBIENT_TASK_SCHEMA, parseAmbientTaskPlan } from '../src/main/dailyReview/ambientTaskPolicy'
import { AMBIENT_TASK_SYSTEM_PROMPT, ambientTaskPrompt } from '../src/main/dailyReview/ambientTaskPrompt'
import type { AmbientEvidence } from '../src/main/dailyReview/ambientTaskStore'
import { parseDayMemory, parseShardAnalysis } from '../src/main/dailyReview/analysisFormat'
import { FINAL_ANALYSIS_SCHEMA, SHARD_ANALYSIS_SCHEMA } from '../src/main/dailyReview/analysisSchemas'
import { buildCodexSdkConfiguration } from '../src/main/dailyReview/codexAgentSdk'
import {
  buildFinalPrompt,
  buildShardPrompt,
  EVIDENCE_SYSTEM_PROMPT,
  FINAL_SYSTEM_PROMPT,
} from '../src/main/dailyReview/dayAnalysisPrompts'
import { workItemsForPrompt } from '../src/main/dailyReview/workItemPrompt'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const args = process.argv.slice(2)
const dayPipeline = args.includes('--day')
const baseline = args.includes('--baseline')
const dayPrompts = baseline
  ? ((await import(
      pathToFileURL(path.join(root, '.qa/task-quality/dayAnalysisPrompts.before.ts')).href
    )) as typeof import('../src/main/dailyReview/dayAnalysisPrompts'))
  : { buildShardPrompt, buildFinalPrompt, EVIDENCE_SYSTEM_PROMPT, FINAL_SYSTEM_PROMPT }
const systemPrompt = baseline
  ? readFileSync(path.join(root, '.qa/task-quality/baseline/system-prompt.txt'), 'utf8')
  : AMBIENT_TASK_SYSTEM_PROMPT
const name = args.find((arg) => arg.startsWith('--run='))?.slice(6)
assert(name && /^[a-z0-9-]+$/.test(name), 'Use --run=NAME [--live] [--cases=id,id]')
const directory = path.join(root, '.qa/task-quality', name)
mkdirSync(path.dirname(directory), { recursive: true })
mkdirSync(directory, { recursive: false })
const corpusPath =
  args.find((arg) => arg.startsWith('--corpus='))?.slice(9) ?? path.join(root, 'tests/fixtures/task-quality/v1.json')
const corpusText = readFileSync(path.resolve(root, corpusPath), 'utf8')
type Case = {
  id: string
  text: string
  existing: Partial<WorkItem> | null
  evidence?: AmbientEvidence[]
  cutoff?: number
  reviewOnly?: boolean
  expected: { count: number | null; title: string | null; description: string | null; id: string | null }
}
const corpus = JSON.parse(corpusText) as { kind: string; userName?: string; cases: Case[] }
const userName = corpus.userName?.trim() || 'Alex'
const selection = args
  .find((arg) => arg.startsWith('--cases='))
  ?.slice(8)
  .split(',')
assert(
  Array.isArray(corpus.cases) && corpus.cases.every((entry) => /^[a-zA-Z0-9-]+$/.test(entry.id)),
  'Invalid case IDs'
)
assert(new Set(corpus.cases.map((entry) => entry.id)).size === corpus.cases.length, 'Duplicate case IDs')
const cases = corpus.cases.filter((item) => !selection || selection.includes(item.id))
assert(cases.length && (!selection || cases.length === selection.length), 'Unknown or duplicate case')
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const write = (file: string, value: unknown) =>
  writeFileSync(path.join(directory, file), JSON.stringify(value, null, 2))
writeFileSync(path.join(directory, 'system-prompt.txt'), systemPrompt)
writeFileSync(path.join(directory, 'corpus.json'), corpusText)
const settings = args.includes('--live')
  ? JSON.parse(readFileSync(path.join(homedir(), 'Library/Application Support/Remember/settings.json'), 'utf8'))
  : {}
const executable = args.includes('--live')
  ? bundledCodexExecutablePath({
      isPackaged: false,
      appPath: path.join(root, 'apps/desktop'),
      resourcesPath: '',
    })
  : null
if (args.includes('--live')) assert(executable)
const manifest = {
  name,
  startedAt: new Date().toISOString(),
  completedAt: null as string | null,
  kind: corpus.kind,
  pipeline: dayPipeline ? 'day-shard-and-final' : 'ambient',
  scope:
    'Production prompts and parsers. Day mode includes shard extraction and final synthesis. No live task writes. Actual source selection and prior state are defined by the corpus; this is not proof of exact historical replay.',
  baseline,
  corpusHash: hash(corpusText),
  promptHash: hash(systemPrompt),
  schemaHash: hash(JSON.stringify(dayPipeline ? FINAL_ANALYSIS_SCHEMA : AMBIENT_TASK_SCHEMA)),
  model: settings.codexAnalysisModel,
  effort: settings.codexAnalysisEffort,
  results: [] as Record<string, unknown>[],
}
write('manifest.json', manifest)
function matches(pattern: string | null, text: string) {
  if (!pattern) return true
  const flags = pattern.match(/^\(\?([is]+)\)/)?.[1] ?? ''
  return new RegExp(pattern.replace(/^\(\?[is]+\)/, ''), flags).test(text)
}
async function run(entry: Case) {
  const now = entry.cutoff ?? Date.UTC(2026, 9, 29, 9)
  const evidence: AmbientEvidence[] = entry.evidence ?? [
    {
      kind: 'context',
      sourceId: entry.id,
      evidenceId: entry.id,
      revision: hash(entry.text),
      workdayId: 'quality-fixture',
      observedAt: now,
      text: entry.text,
      source: 'screen',
      appName: 'Fixture',
      bundleId: 'test.fixture',
      windowTitle: 'Observed context',
      url: '',
    },
  ]
  assert(
    evidence.length > 0 && evidence.every((source) => source.kind === 'context' && source.observedAt <= now),
    'Cases require screen evidence available by the cutoff'
  )
  const items: WorkItem[] = entry.existing
    ? [
        {
          id: 'existing',
          title: '',
          description: '',
          prompt: '',
          context: '',
          aiSuggestion: null,
          returnPoint: { lastMove: '', unresolved: '', nextMove: '' },
          lifecycle: 'open',
          status: 'todo',
          priority: 'none',
          dueAt: null,
          attention: 'idle',
          createdAt: now - 86400000,
          updatedAt: now - 86400000,
          closedAt: null,
          userEditedTitle: false,
          userEditedDescription: false,
          sources: [],
          facts: [],
          observations: [],
          agentSessions: [],
          ...entry.existing,
        } as WorkItem,
      ]
    : []
  const prompt = ambientTaskPrompt(evidence, items, userName, 'en')
  write(`${entry.id}.input.json`, JSON.parse(prompt))
  if (!args.includes('--live')) return
  const runtime = mkdtempSync(path.join(tmpdir(), 'remember-task-quality-'))
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 180000)
  const started = Date.now()
  const result: Record<string, unknown> = { id: entry.id }
  try {
    assert(executable)
    const modelExecutable = executable
    async function infer(system: string, input: string, schema: object, stage: string) {
      writeFileSync(path.join(directory, `${entry.id}.${stage}.prompt.txt`), `${system}\n\n${input}`)
      const config = buildCodexSdkConfiguration({
        abortController: controller,
        cwd: runtime,
        executable: modelExecutable,
        env: { ...process.env, CODEX_HOME: path.join(homedir(), 'Library/Application Support/Remember/codex') },
        model: settings.codexAnalysisModel,
        effort: settings.codexAnalysisEffort,
        schema,
        toolsDisabled: true,
      })
      const response = await new Codex(config.client)
        .startThread(config.thread)
        .run(`${system}\n\n${input}`, config.turn)
      assert(
        response.items.every((item) => ['agent_message', 'reasoning', 'error'].includes(item.type)),
        'Unexpected tool invocation'
      )
      writeFileSync(path.join(directory, `${entry.id}.${stage}.raw.json`), response.finalResponse)
      return response
    }
    let plan: ReturnType<typeof parseAmbientTaskPlan>
    let usage: unknown
    if (dayPipeline) {
      const shard = {
        startedAt: now,
        endedAt: now + 60000,
        entries: evidence.map((source) => ({
          evidenceId: source.evidenceId,
          timestamp: source.observedAt,
          kind: 'screen-context' as const,
          app: source.appName,
          bundleId: source.bundleId,
          window: source.windowTitle,
          url: source.url,
          text: source.text,
        })),
      }
      const first = await infer(
        dayPrompts.EVIDENCE_SYSTEM_PROMPT,
        dayPrompts.buildShardPrompt(shard, 0, 1, 'en', 'en-GB'),
        SHARD_ANALYSIS_SCHEMA,
        'shard'
      )
      const analysis = parseShardAnalysis(first.finalResponse)
      const session = {
        id: 'quality-fixture',
        startedAt: now,
        endedAt: null,
        activeDurationMs: 60000,
      } as DailyReviewSession
      const second = await infer(
        dayPrompts.FINAL_SYSTEM_PROMPT,
        dayPrompts.buildFinalPrompt(
          session,
          [analysis],
          null,
          'manual',
          now + 60000,
          'en',
          'en-GB',
          [],
          [],
          workItemsForPrompt(items)
        ),
        FINAL_ANALYSIS_SCHEMA,
        'final'
      )
      const memory = parseDayMemory(second.finalResponse)
      plan = {
        proposed: memory.openTasks ?? [],
        changes: memory.taskChanges ?? [],
        consideredEvidenceIds: evidence.map((source) => source.evidenceId),
        notifyTitles: [],
      }
      usage = [first.usage, second.usage]
    } else {
      const response = await infer(systemPrompt, prompt, AMBIENT_TASK_SCHEMA, 'ambient')
      plan = parseAmbientTaskPlan(parseJsonResponse(response.finalResponse), evidence, userName, items)
      usage = response.usage
    }
    write(`${entry.id}.parsed.json`, plan)
    const titles = plan.proposed.map((t) => t.title).join('\n')
    const descriptions = plan.proposed.map((t) => t.description).join('\n')
    const checks = {
      count: entry.expected.count === null || plan.proposed.length === entry.expected.count,
      title: matches(entry.expected.title, titles),
      description: matches(entry.expected.description, descriptions),
      identity: !entry.expected.id || (plan.proposed.length === 1 && plan.proposed[0]?.id === entry.expected.id),
      noUnsupportedLifecycleChanges: plan.changes.length === 0,
      renameIntent: plan.proposed.every(
        (task) =>
          !entry.existing ||
          task.id !== entry.existing.id ||
          task.title === entry.existing.title ||
          task.titleChangeReason === 'outcome'
      ),
      fullyConsidered: evidence.every((source) => plan.consideredEvidenceIds.includes(source.evidenceId)),
      sourceIdentity: plan.proposed.every((task) =>
        evidence.some((source) => source.evidenceId === task.source?.evidenceId)
      ),
    }
    Object.assign(result, {
      status: 'completed',
      checks,
      passed: entry.reviewOnly ? null : Object.values(checks).every(Boolean),
      semanticReview: entry.reviewOnly ? 'pending' : 'controlled-assertions',
      proposed: plan.proposed.map((t) => ({
        id: t.id,
        title: t.title,
        titleChangeReason: t.titleChangeReason,
        description: t.description,
      })),
      usage,
    })
  } catch (error) {
    Object.assign(result, {
      status: controller.signal.aborted ? 'timeout' : 'error',
      error: String(error),
      passed: false,
    })
  } finally {
    clearTimeout(timeout)
    rmSync(runtime, { recursive: true, force: true })
    result.elapsedMs = Date.now() - started
    manifest.results.push(result)
    write(`${entry.id}.result.json`, result)
    write('manifest.json', manifest)
    console.log(JSON.stringify(result))
  }
}
// Bounded model concurrency; every run stores the exact inputs and prompt.
for (let index = 0; index < cases.length; index += 3) await Promise.all(cases.slice(index, index + 3).map(run))
manifest.completedAt = new Date().toISOString()
write('manifest.json', manifest)
console.log(`Artifacts: ${directory}`)
if (manifest.results.some((result) => result.passed === false)) process.exitCode = 1
