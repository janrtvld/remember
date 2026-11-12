// Cold-start benchmark for a packaged Remember build. It launches the app repeatedly against an isolated profile and
// home directory and reports launch milestones in milliseconds after the process was spawned.
//
// Build an ad-hoc app under its own bundle id first, so it cannot touch the installed app's login item:
//   pnpm --filter @remember/web build && pnpm build && node scripts/release-source-maps.cjs
//   pnpm exec electron-builder --mac --arm64 --dir --publish never --config electron-builder.yml \
//     --config.forceCodeSigning=false --config.mac.identity=- --config.mac.notarize=false \
//     --config.appId=computer.remember.bench --config.directories.output=release-bench
//
// Run: pnpm exec tsx scripts/benchmark-startup.ts --app release-bench/mac-arm64/Remember.app
//   [--runs 10] [--fresh 3] [--label name] [--out file.json] [--models dir] [--profile-source dir]
//
// The default profile is synthetic and small. Launch cost grows with recorded history, so numbers that reflect real
// use need --profile-source: a clone of an existing profile, used only with its owner's authorization.
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Day } from '@remember/shared'
import { EvidenceStore } from '../src/main/dailyReview/evidenceStore'
import { seedProfile } from './qa/fixture'

function option(name: string, fallback?: string) {
  const index = process.argv.indexOf(`--${name}`)
  const value = index === -1 ? fallback : process.argv[index + 1]
  if (value === undefined) throw new Error(`--${name} is required`)
  return value
}

const appBundle = option('app')
const repeatRuns = Number(option('runs', '10'))
const freshRuns = Number(option('fresh', '3'))
const label = option('label', 'run')
const output = option('out', '')
const macosDirectory = join(appBundle, 'Contents', 'MacOS')
const executable = join(macosDirectory, readdirSync(macosDirectory)[0])
const workspace = mkdtempSync('/private/tmp/remember-bench-')
const home = join(workspace, 'home')
mkdirSync(home, { mode: 0o700 })

/** Thirty synthetic workdays so launch reads a store of realistic size instead of a single fixture day. */
function seedHistory(profile: string) {
  const store = new EvidenceStore(join(profile, 'daily-review', 'evidence.sqlite'))
  try {
    for (let dayIndex = 2; dayIndex < 32; dayIndex++) {
      const start = new Date()
      start.setDate(start.getDate() - dayIndex)
      start.setHours(9, 0, 0, 0)
      const startedAt = start.getTime()
      const id = `bench-day-${dayIndex}`
      const day: Day = {
        id,
        startedAt,
        endedAt: startedAt + 8 * 3_600_000,
        activeDurationMs: 6 * 3_600_000,
        moments: [],
        appActivity: [],
        contextMoments: [],
        memory: {
          summary: `Synthetic benchmark day ${dayIndex}`,
          currentFocus: null,
          outcomes: [],
          decisions: [],
          openLoops: [],
          conversations: [],
          timeline: Array.from({ length: 12 }, (_, index) => ({
            id: `${id}-timeline-${index}`,
            startTime: `${String(9 + Math.floor(index / 2)).padStart(2, '0')}:${index % 2 ? '30' : '00'}`,
            endTime: `${String(9 + Math.floor((index + 1) / 2)).padStart(2, '0')}:${index % 2 ? '00' : '30'}`,
            title: `Synthetic block ${index}`,
            description: 'Generated benchmark activity with no real content.',
          })),
          knowledgeSuggestions: [],
          refreshedAt: startedAt + 8 * 3_600_000,
          coveredThrough: startedAt + 8 * 3_600_000,
        },
        refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
      }
      store.upsertSession(day)
      for (let block = 0; block < 24; block++) {
        const activityId = `${id}-focus-${block}`
        const blockStart = startedAt + block * 20 * 60_000
        store.upsertAppActivity(id, {
          id: activityId,
          appName: 'Benchmark fixture',
          bundleId: 'com.example.benchmark.fixture',
          startedAt: blockStart,
          endedAt: blockStart + 20 * 60_000,
        })
        for (let moment = 0; moment < 8; moment++) {
          store.appendContextMoment(
            id,
            {
              id: `${activityId}-context-${moment}`,
              timestamp: blockStart + moment * 120_000,
              appName: 'Benchmark fixture',
              windowTitle: `Synthetic window ${block}`,
              text: 'Synthetic benchmark context. '.repeat(40),
              textSource: 'accessibility',
              trigger: 'focus',
              monitorName: 'Fixture display',
              screenshotPath: '',
              url: 'https://example.test/benchmark',
              focusedElement: { role: 'AXTextField', title: 'Benchmark', description: '', value: '' },
            },
            activityId,
            'com.example.benchmark.fixture'
          )
        }
      }
    }
  } finally {
    store.close()
  }
}

const template = join(workspace, 'template')
const profileSource = option('profile-source', '')
if (profileSource) {
  // An existing profile, used only with its owner's authorization. The benchmark works on a copy-on-write clone that
  // is forced offline with capture paused, so it cannot sync, reach an AI provider, record, or touch the original.
  spawnSync('/bin/cp', ['-cR', profileSource, template], { stdio: 'inherit' })
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort', '.runtime-lock'])
    rmSync(join(template, name), { recursive: true, force: true })
  const settingsFile = join(template, 'settings.json')
  writeFileSync(
    settingsFile,
    JSON.stringify({
      ...JSON.parse(readFileSync(settingsFile, 'utf8')),
      offlineMode: true,
      capturePaused: true,
      automaticUpdates: false,
      launchAtLogin: false,
    })
  )
} else {
  seedProfile(template)
  seedHistory(template)
}
// Setup only counts as complete with the speech model present, so clone the installed model assets (no user data)
// the same way the native QA runner does. Without them the benchmark would time the setup screen.
if (!profileSource) {
  const models = option('models', join(process.env.HOME ?? '', 'Library/Application Support/Remember/models'))
  if (!existsSync(models)) throw new Error('Local model assets are required; pass --models /absolute/path/to/models')
  spawnSync('/bin/cp', ['-cR', models, join(template, 'models')], { stdio: 'inherit' })
}

function processTreeMemoryKb(pid: number) {
  const rows = spawnSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' })
    .stdout.trim()
    .split('\n')
    .map((row) => row.trim().split(/\s+/).map(Number))
  const tree = new Set([pid])
  for (let grew = true; grew; ) {
    grew = false
    for (const [child, parent] of rows) {
      if (tree.has(parent) && !tree.has(child)) {
        tree.add(child)
        grew = true
      }
    }
  }
  return {
    processes: tree.size,
    rssKb: rows.filter(([child]) => tree.has(child)).reduce((sum, row) => sum + row[2], 0),
  }
}

async function launch(profile: string) {
  const timelineFile = join(workspace, `timeline-${Date.now()}.json`)
  const spawnedAt = Date.now()
  const child = spawn(executable, [`--remember-profile=${profile}`], {
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: home,
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      REMEMBER_STARTUP_TIMELINE: timelineFile,
      ...(process.env.BENCH_PROFILE ? { REMEMBER_STARTUP_PROFILE: process.env.BENCH_PROFILE } : {}),
    },
    stdio: 'ignore',
  })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  const deadline = Date.now() + 90_000
  while (!existsSync(timelineFile) && Date.now() < deadline && child.exitCode === null) await delay(50)
  await delay(200)
  if (!existsSync(timelineFile)) {
    child.kill('SIGKILL')
    throw new Error('The app did not report a startup timeline within 90 seconds.')
  }
  const timeline = JSON.parse(readFileSync(timelineFile, 'utf8'))
  const memory = processTreeMemoryKb(child.pid ?? -1)
  child.kill('SIGTERM')
  await Promise.race([exited, delay(15_000).then(() => child.kill('SIGKILL'))])
  await exited
  const milestones: Record<string, number> = {
    'process-created': timeline.processCreatedAt - spawnedAt,
    'node-started': timeline.nodeTimeOrigin - spawnedAt,
  }
  for (const mark of timeline.marks) milestones[mark.name] = mark.at - spawnedAt
  if (timeline.renderer) {
    const origin = timeline.renderer.timeOrigin - spawnedAt
    for (const name of [
      'responseEnd',
      'domContentLoaded',
      'loadEventEnd',
      'firstContentfulPaint',
      'largestContentfulPaint',
      'contentVisible',
    ]) {
      if (timeline.renderer[name] != null) milestones[`renderer-${name}`] = origin + timeline.renderer[name]
    }
  }
  return {
    milestones,
    memory,
    mainRssKb: Math.round(timeline.memory.rss / 1024),
    mainCpuMs: Math.round((timeline.cpu.user + timeline.cpu.system) / 1000),
    renderer: timeline.renderer && {
      path: new URL(timeline.renderer.url).pathname,
      textLength: timeline.renderer.textLength,
      resources: timeline.renderer.resources,
    },
  }
}

function freshProfile(name: string) {
  const profile = join(workspace, name)
  spawnSync('/bin/cp', ['-cR', template, profile], { stdio: 'inherit' })
  chmodSync(profile, 0o700)
  return profile
}

function summarize(runs: Array<Awaited<ReturnType<typeof launch>>>) {
  const names = [...new Set(runs.flatMap((run) => Object.keys(run.milestones)))]
  const quantile = (values: number[], q: number) => {
    const sorted = [...values].sort((a, b) => a - b)
    return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))])
  }
  const row = (values: number[]) => ({
    median: quantile(values, 0.5),
    min: quantile(values, 0),
    p90: quantile(values, 0.9),
  })
  return {
    milestones: Object.fromEntries(
      names.map((name) => [name, row(runs.flatMap((run) => (name in run.milestones ? [run.milestones[name]] : [])))])
    ),
    treeRssMb: row(runs.map((run) => run.memory.rssKb / 1024)),
    mainRssMb: row(runs.map((run) => run.mainRssKb / 1024)),
    mainCpuMs: row(runs.map((run) => run.mainCpuMs)),
    processes: row(runs.map((run) => run.memory.processes)),
  }
}

// The first execution of a new binary pays a one-time macOS scan; keep it out of the samples.
await launch(freshProfile('warmup'))
const fresh = []
for (let index = 0; index < freshRuns; index++) fresh.push(await launch(freshProfile(`fresh-${index}`)))
const repeatProfile = freshProfile('repeat')
await launch(repeatProfile)
const repeat = []
for (let index = 0; index < repeatRuns; index++) repeat.push(await launch(repeatProfile))

const result = {
  label,
  app: appBundle,
  recordedAt: new Date().toISOString(),
  sample: repeat[0]?.renderer,
  firstLaunch: summarize(fresh),
  repeatLaunch: summarize(repeat),
  raw: { fresh, repeat },
}
if (output) writeFileSync(output, JSON.stringify(result, null, 2))
const order = Object.entries(result.repeatLaunch.milestones).sort((a, b) => a[1].median - b[1].median)
console.log(`\n${label}: repeat launch, ${repeatRuns} runs (ms after spawn: median / min / p90)`)
for (const [name, value] of order)
  console.log(
    `  ${name.padEnd(34)} ${String(value.median).padStart(6)} ${String(value.min).padStart(6)} ${String(value.p90).padStart(6)}`
  )
console.log(
  `  process tree RSS MB                ${result.repeatLaunch.treeRssMb.median}  main RSS MB ${result.repeatLaunch.mainRssMb.median}  main CPU ms ${result.repeatLaunch.mainCpuMs.median}`
)
console.log(`\n${label}: first launch on a fresh profile, ${freshRuns} runs`)
for (const [name, value] of Object.entries(result.firstLaunch.milestones).sort((a, b) => a[1].median - b[1].median))
  console.log(
    `  ${name.padEnd(34)} ${String(value.median).padStart(6)} ${String(value.min).padStart(6)} ${String(value.p90).padStart(6)}`
  )
console.log(`\nrenderer sample: ${JSON.stringify(result.sample)}`)
rmSync(workspace, { recursive: true, force: true })
