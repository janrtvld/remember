import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Codex } from '@openai/codex-sdk'
import type { DailyReviewSession, DayMemory } from '@remember/shared'
import { bundledCodexExecutablePath } from '../src/main/codexRuntimePaths'
import {
  type AnalysisEvidenceEntry,
  compactContextEvidence,
  partitionEvidence,
} from '../src/main/dailyReview/analysisContext'
import { parseDayMemory, parseShardAnalysis } from '../src/main/dailyReview/analysisFormat'
import { FINAL_ANALYSIS_SCHEMA, SHARD_ANALYSIS_SCHEMA } from '../src/main/dailyReview/analysisSchemas'
import { buildCodexSdkConfiguration } from '../src/main/dailyReview/codexAgentSdk'
import * as productionPrompts from '../src/main/dailyReview/dayAnalysisPrompts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
assert(process.env.TZ === 'Europe/Amsterdam', 'Run with TZ=Europe/Amsterdam to keep fixture and prompt times aligned')
const args = process.argv.slice(2)
const option = (key: string) => args.find((arg) => arg.startsWith(`--${key}=`))?.slice(key.length + 3)
const name = option('run')
assert(name && /^[a-z0-9-]+$/.test(name), 'Use --run=NAME [--baseline] [--live] [--corpus=PATH] [--cases=id,id]')
const directory = path.join(root, '.qa/day-quality', name)
mkdirSync(directory, { recursive: false })
const baseline = args.includes('--baseline')
const candidate = args.includes('--candidate')
assert(!(baseline && candidate), 'Choose either --baseline or --candidate')
const sourcePath = baseline
  ? '.qa/day-quality/dayAnalysisPrompts.before.ts'
  : candidate
    ? '.qa/day-quality/dayAnalysisPrompts.candidate.ts'
    : 'apps/desktop/src/main/dailyReview/dayAnalysisPrompts.ts'
const prompts: typeof productionPrompts =
  baseline || candidate ? await import(pathToFileURL(path.join(root, sourcePath)).href) : productionPrompts
const corpusText = readFileSync(path.resolve(root, option('corpus') ?? 'tests/fixtures/day-quality/v1.json'), 'utf8')
type Checks = {
  attention?: { project: string; min: number; max: number }[]
  attentionTotalMax?: number
  outcomeRequired?: string
  forbidden?: string
  outcomesMin?: number
  outcomesMax?: number
}
type Case = {
  id: string
  kind: string
  startedAt: number
  endedAt: number
  activeDurationMs: number
  evidence: AnalysisEvidenceEntry[]
  previous?: DayMemory
  checks?: Checks
}
const corpus = JSON.parse(corpusText) as { cases: Case[] }
const selected = option('cases')?.split(',')
const cases = corpus.cases.filter((entry) => !selected || selected.includes(entry.id))
assert(cases.length && (!selected || selected.length === cases.length), 'Unknown/duplicate cases')
assert(new Set(cases.map((entry) => entry.id)).size === cases.length, 'Duplicate case IDs')
for (const entry of cases) {
  assert(/^[a-z0-9-]+$/.test(entry.id), 'Unsafe case ID')
  assert(Number.isFinite(entry.startedAt) && entry.endedAt > entry.startedAt, 'Invalid case interval')
  assert(
    entry.evidence.length > 0 &&
      entry.evidence.every((source) => source.timestamp >= entry.startedAt && source.timestamp <= entry.endedAt),
    'Evidence outside case interval'
  )
}
const settings = JSON.parse(
  readFileSync(path.join(homedir(), 'Library/Application Support/Remember/settings.json'), 'utf8')
)
const executable = bundledCodexExecutablePath({
  isPackaged: false,
  appPath: path.join(root, 'apps/desktop'),
  resourcesPath: '',
})
assert(executable)
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const write = (file: string, value: unknown) =>
  writeFileSync(path.join(directory, file), JSON.stringify(value, null, 2))
writeFileSync(path.join(directory, 'corpus.json'), corpusText)
const promptSource = readFileSync(path.join(root, sourcePath), 'utf8')
writeFileSync(path.join(directory, 'prompt-source.ts'), promptSource)
const manifest = {
  name,
  baseline,
  candidate,
  startedAt: new Date().toISOString(),
  completedAt: null as string | null,
  model: settings.codexAnalysisModel,
  effort: settings.codexAnalysisEffort,
  timezone: process.env.TZ,
  corpusHash: hash(corpusText),
  promptHash: hash(promptSource),
  schemaHash: hash(JSON.stringify([SHARD_ANALYSIS_SCHEMA, FINAL_ANALYSIS_SCHEMA])),
  scope:
    'Production compaction, sharding, prompts, schemas and parsers. Corpus owns source selection and prior memory. No historical replay or native persistence claim; no production writes. Assertion checks are limited proxies, not user acceptance.',
  results: [] as Record<string, unknown>[],
}
write('manifest.json', manifest)
async function run(entry: Case) {
  const runtime = mkdtempSync(path.join(tmpdir(), 'remember-day-quality-'))
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 300_000)
  const result: Record<string, unknown> = { id: entry.id, kind: entry.kind }
  try {
    const shards = partitionEvidence(compactContextEvidence(entry.evidence), {
      maxCharacters: 320_000,
      timeWindowMs: 7_200_000,
    })
    write(`${entry.id}.shards.json`, shards)
    if (!args.includes('--live')) {
      result.status = 'prepared'
      return
    }
    const usage: unknown[] = []
    async function infer(system: string, prompt: string, schema: object, stage: string) {
      assert(executable)
      const full = `${system}\n\n${prompt}`
      writeFileSync(path.join(directory, `${entry.id}.${stage}.prompt.txt`), full)
      const config = buildCodexSdkConfiguration({
        abortController: controller,
        cwd: runtime,
        executable,
        env: { ...process.env, CODEX_HOME: path.join(homedir(), 'Library/Application Support/Remember/codex') },
        model: settings.codexAnalysisModel,
        effort: settings.codexAnalysisEffort,
        schema,
        toolsDisabled: true,
      })
      const response = await new Codex(config.client).startThread(config.thread).run(full, config.turn)
      assert(
        response.items.every((item) => ['agent_message', 'reasoning', 'error'].includes(item.type)),
        'Unexpected tool use'
      )
      writeFileSync(path.join(directory, `${entry.id}.${stage}.raw.json`), response.finalResponse)
      usage.push(response.usage)
      return response.finalResponse
    }
    const analyses = []
    for (const [index, shard] of shards.entries())
      analyses.push(
        parseShardAnalysis(
          await infer(
            prompts.EVIDENCE_SYSTEM_PROMPT,
            prompts.buildShardPrompt(shard, index, shards.length, 'en', 'en-GB'),
            SHARD_ANALYSIS_SCHEMA,
            `shard-${index}`
          )
        )
      )
    const session = {
      id: entry.id,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      activeDurationMs: entry.activeDurationMs,
    } as DailyReviewSession
    const output = parseDayMemory(
      await infer(
        prompts.FINAL_SYSTEM_PROMPT,
        prompts.buildFinalPrompt(
          session,
          analyses,
          entry.previous ?? null,
          'manual',
          entry.endedAt,
          'en',
          'en-GB',
          [],
          [],
          []
        ),
        FINAL_ANALYSIS_SCHEMA,
        'final'
      )
    )
    write(`${entry.id}.parsed.json`, output)
    const expected = entry.checks
    const checks: Record<string, boolean> = {}
    const outcomes = output.outcomes.join('\n')
    if (expected) {
      checks.completeHeadlines = output.outcomes.every((headline) => !/[-–—,:;]$/.test(headline.trim()))
      for (const a of expected.attention ?? []) {
        const minutes = (output.projectAttention ?? [])
          .filter((p) => new RegExp(a.project, 'i').test(p.project))
          .reduce((n, p) => n + p.durationMinutes, 0)
        checks[`attention:${a.project}`] = minutes >= a.min && minutes <= a.max
      }
      if (expected.attentionTotalMax !== undefined)
        checks.attentionTotal =
          (output.projectAttention ?? []).reduce((n, p) => n + p.durationMinutes, 0) <= expected.attentionTotalMax
      if (expected.outcomeRequired) checks.requiredResult = new RegExp(expected.outcomeRequired, 'i').test(outcomes)
      if (expected.forbidden) checks.noForbiddenClaim = !new RegExp(expected.forbidden, 'im').test(outcomes)
      if (expected.outcomesMin !== undefined) checks.nonEmpty = output.outcomes.length >= expected.outcomesMin
      if (expected.outcomesMax !== undefined) checks.selective = output.outcomes.length <= expected.outcomesMax
    }
    Object.assign(result, {
      status: 'completed',
      checks,
      passed: expected ? Object.values(checks).every(Boolean) : null,
      outcomes: output.outcomes,
      attention: output.projectAttention,
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
    manifest.results.push(result)
    write(`${entry.id}.result.json`, result)
    write('manifest.json', manifest)
    console.log(JSON.stringify(result))
  }
}
for (let i = 0; i < cases.length; i += 2) await Promise.all(cases.slice(i, i + 2).map(run))
manifest.completedAt = new Date().toISOString()
write('manifest.json', manifest)
console.log(`Artifacts: ${directory}`)
if (manifest.results.some((r) => r.status === 'error' || r.status === 'timeout')) process.exitCode = 1
