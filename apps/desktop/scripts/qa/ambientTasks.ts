import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import type { ElectronApplication, Page } from 'playwright-core'

const title = 'Confirm ambient lifecycle'
const text = 'Sent by Jan: I will confirm the ambient lifecycle result tomorrow. QA ambient commitment.'
const nextCommitment = `${text} This is a new confirmation for a separate client delivery.`

type CapturedTaskSource = { workdayId: string; sourceId: string; observedAt: number }
declare global {
  var qaCapturedDayTask: (text: string, apply: boolean) => Promise<CapturedTaskSource | null>
}

function replaceOnce(file: string, pattern: RegExp, replacement: string) {
  const source = readFileSync(file, 'utf8')
  assert.equal([...source.matchAll(new RegExp(pattern, 'g'))].length, 1, `One fixture boundary in ${file}`)
  writeFileSync(file, source.replace(pattern, replacement))
}

/** Install only in the runner's disposable source snapshot, before its build. */
export function installAmbientTasksFixture(directory: string) {
  assert(!directory.endsWith('/apps/desktop'), 'Install fixtures only in the disposable source snapshot')
  const input = join(directory, 'ambient-native-input.json')
  const clockFile = join(directory, 'ambient-clock.json')
  writeFileSync(input, JSON.stringify({ text: 'Synthetic ambient capture is ready.' }))
  writeFileSync(clockFile, JSON.stringify({ offset: 0 }))
  writeFileSync(
    join(directory, 'src/main/ambientQaClock.ts'),
    `import { readFileSync } from 'node:fs'
const NativeDate = globalThis.Date
let offset = JSON.parse(readFileSync(${JSON.stringify(clockFile)}, 'utf8')).offset
const timer = setInterval(() => { offset = JSON.parse(readFileSync(${JSON.stringify(clockFile)}, 'utf8')).offset }, 50)
timer.unref()
const now = () => NativeDate.now() + offset
globalThis.Date = new Proxy(NativeDate, {
  construct(target, args) { return Reflect.construct(target, args.length ? args : [now()]) },
  apply() { return new NativeDate(now()).toString() },
  get(target, key) { return key === 'now' ? now : Reflect.get(target, key) },
})
`
  )
  const entry = join(directory, 'src/main/index.ts')
  writeFileSync(entry, `import './ambientQaClock'\n${readFileSync(entry, 'utf8')}`)
  const context = join(directory, 'ambient-context-fixture.cjs')
  writeFileSync(
    context,
    `#!${process.execPath}
const fs = require('node:fs');
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
if (process.argv.includes('--permission-status') || process.argv.includes('--request-permissions')) {
 send({type:'permissions',accessibility:true,input_monitoring:true});
} else {
 const emit = () => send({type:'context',timestamp:Date.now()+JSON.parse(fs.readFileSync(${JSON.stringify(clockFile)},'utf8')).offset,app_name:'Ambient QA',bundle_id:'test.remember.ambient-qa',window_title:'Synthetic sent commitment',text:JSON.parse(fs.readFileSync(${JSON.stringify(input)},'utf8')).text,text_source:'accessibility',trigger:'content-change',monitor_name:'QA',screenshot_path:'',url:'https://ambient-qa.invalid/sent'});
 emit(); const timer=setInterval(emit,1000);
 process.on('SIGINT',()=>{clearInterval(timer);process.exit(0)});
}
`,
    { mode: 0o700 }
  )
  replaceOnce(
    join(directory, 'src/main/dailyReview/context.ts'),
    /function helperPath\(\) \{[\s\S]*?\n\}/,
    `function helperPath() { return ${JSON.stringify(context)} }`
  )
  const main = join(directory, 'src/main/dailyReview/index.ts')
  writeFileSync(
    main,
    `${readFileSync(main, 'utf8')}
import { parseDayMemory as qaParseTaskDayMemory } from './analysisFormat'
Object.assign(globalThis, { qaCapturedDayTask: async (text: string, apply: boolean) => {
  const store = getEvidenceStore()
  const day = store.readSessionHeaders().sort((a, b) => b.startedAt-a.startedAt)[0]
  if (!day) return null
  const source = (await store.readAnalysisEvidence(day.id)).find(entry => entry.kind === 'screen-context' && entry.text === text)
  if (!source) return null
  if (apply) {
    const memory = qaParseTaskDayMemory(JSON.stringify({ summary: '', openTasks: [{
      id: null, titleChangeReason: null, title: ${JSON.stringify(title)}, description: 'Confirm the ambient lifecycle result tomorrow.',
      prompt: '', aiSuggestion: null, context: source.text,
      returnPoint: { lastMove: 'Commitment sent.', unresolved: 'Confirmation pending.', nextMove: 'Confirm the result.' },
      source: { kind: 'task', evidenceId: source.evidenceId, label: 'Synthetic sent commitment', detail: 'Explicit synthetic user commitment.', conversationStartTime: null },
    }], taskChanges: [] }))
    // Exercise the ordinary Day writer without an ambient/proactive batch.
    store.applyAnalyzedWorkItems({ workdayId: day.id, plan: { proposed: memory.openTasks ?? [], changes: [] }, conversations: [], analysisStartedAt: Date.now(), observedAt: Date.now() })
    emitMemoryChanged()
  }
  return { workdayId: day.id, sourceId: source.evidenceId, observedAt: source.timestamp }
} })
`
  )
}

async function waitFor(check: () => Promise<boolean>, label: string, milliseconds = 55_000) {
  const deadline = Date.now() + milliseconds
  while (!(await check())) {
    assert(Date.now() < deadline, label)
    await delay(100)
  }
}

function inspect(directory: string) {
  const database = new DatabaseSync(join(directory, 'profile/daily-review/evidence.sqlite'), { readOnly: true })
  try {
    return {
      tasks: database
        .prepare('SELECT id, title, lifecycle FROM work_item WHERE title = ? ORDER BY created_at, id')
        .all(title)
        .map((row) => ({ ...row })),
      sources: database
        .prepare(
          'SELECT s.*, c.workday_id, c.timestamp, c.text FROM ambient_task_source s JOIN context_evidence c ON c.id = s.source_id WHERE c.text LIKE ? ORDER BY c.timestamp, c.id'
        )
        .all(`${text}%`)
        .map((row) => ({ ...row })),
    }
  } finally {
    database.close()
  }
}

async function capturedSource(electron: ElectronApplication, text: string) {
  await waitFor(
    async () => Boolean(await electron.evaluate((_electron, text) => globalThis.qaCapturedDayTask(text, false), text)),
    'The native context parser must retain the exact synthetic screen on the current day'
  )
  const source = await electron.evaluate((_electron, text) => globalThis.qaCapturedDayTask(text, true), text)
  assert(source)
  return source
}

export async function ambientTasksQa(
  electron: ElectronApplication,
  page: Page,
  directory: string,
  desktopDirectory: string
) {
  assert(Math.abs((await electron.evaluate(() => Date.now())) - Date.now()) < 5_000)
  await page.evaluate(() =>
    window.remember.updateSettings({
      offlineMode: false,
      cloudAnalysisConsent: true,
      defaultAgentProvider: 'codex',
      agentLearningEnabled: false,
      liveTaskUpdates: false,
      frequentDayRefresh: false,
      audioCaptureEnabled: false,
      capturePaused: false,
      captureSchedule: { enabled: false, weekdays: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00' },
    })
  )
  await page.evaluate(() => window.remember.resumeCapture())
  await waitFor(
    () => page.evaluate(async () => (await window.remember.getState()).status === 'recording'),
    'Production capture startup must become active'
  )
  const provider = (await page.evaluate(() => window.remember.getState())).agent
  assert.equal(provider.provider, 'codex')
  assert.equal(provider.status, 'signed-out', 'The disposable profile must have no authenticated inference provider')
  writeFileSync(join(desktopDirectory, 'ambient-native-input.json'), JSON.stringify({ text }))
  const source = await capturedSource(electron, text)
  const state = inspect(directory)
  assert.equal(state.tasks.length, 1)
  assert.equal(state.tasks[0]?.lifecycle, 'open')
  assert.equal(state.sources.length, 1)
  assert.equal(state.sources[0]?.source_id, source.sourceId)
  assert.equal(state.sources[0]?.text, text)
  await page.goto(new URL(`/inbox/?item=${state.tasks[0]?.id}`, page.url()).toString())
  const evidenceLink = page.getByRole('link', { name: /Open timeline|Open tijdlijn/ }).filter({ visible: true })
  await evidenceLink.click()
  await page.waitForURL((url) => url.pathname === '/day/timeline/' && Boolean(url.searchParams.get('timelineAt')))
  assert.equal(new URL(page.url()).searchParams.get('id'), source.workdayId)
  assert.equal(new URL(page.url()).searchParams.get('timelineAt'), String(source.observedAt))
  await page.screenshot({ path: join(directory, 'ambient-task-source-timeline.png') })
  await page.goto(new URL(`/inbox/?item=${state.tasks[0]?.id}`, page.url()).toString())
  await page
    .getByRole('button', { name: /Mark .* as not needed|Markeer .* als niet nodig/ })
    .filter({ visible: true })
    .click()
  await waitFor(
    () =>
      page.evaluate(
        async (id) => (await window.remember.listWorkItems()).find((item) => item.id === id)?.lifecycle === 'abandoned',
        String(state.tasks[0]?.id)
      ),
    'The actual not-needed control must close the task through native IPC'
  )
  await page.screenshot({ path: join(directory, 'ambient-task-dismissed.png') })
  await page.evaluate(() => window.remember.updateSettings({ capturePaused: true }))
  writeFileSync(
    join(directory, 'ambient-before-restart.json'),
    JSON.stringify({ ...inspect(directory), desktopDirectory, source, providerStatus: provider.status }, null, 2)
  )
  writeFileSync(join(desktopDirectory, 'ambient-clock.json'), JSON.stringify({ offset: 24 * 60 * 60_000 }))
}

export async function ambientTasksAfterRestartQa(electron: ElectronApplication, page: Page, directory: string) {
  const before = JSON.parse(readFileSync(join(directory, 'ambient-before-restart.json'), 'utf8'))
  assert(Math.abs((await electron.evaluate(() => Date.now())) - Date.now() - 24 * 60 * 60_000) < 5_000)
  await page.evaluate(() => window.remember.resumeCapture())
  await waitFor(
    () => page.evaluate(async () => (await window.remember.getState()).status === 'recording'),
    'Capture must resume after full restart'
  )
  const source = await capturedSource(electron, text)
  assert.notEqual(source.workdayId, before.source.workdayId, 'The replay must belong to the next recorded day')
  assert.notEqual(source.sourceId, before.source.sourceId)
  const after = inspect(directory)
  assert.deepEqual(after.tasks, before.tasks)
  assert.equal(after.tasks[0]?.lifecycle, 'abandoned')
  writeFileSync(join(before.desktopDirectory, 'ambient-native-input.json'), JSON.stringify({ text: nextCommitment }))
  const freshSource = await capturedSource(electron, nextCommitment)
  const final = inspect(directory)
  assert.equal(final.tasks.length, 2)
  assert.equal(final.tasks.find((task) => task.id === before.tasks[0]?.id)?.lifecycle, 'abandoned')
  const fresh = final.tasks.find((task) => task.lifecycle === 'open')
  assert(fresh)
  assert.equal(freshSource.workdayId, source.workdayId)
  assert(final.sources.some((entry) => entry.work_item_id === fresh.id && entry.text === nextCommitment))
  await page.goto(new URL(`/inbox/?item=${fresh.id}`, page.url()).toString())
  await page
    .getByRole('button', { name: /Mark .* as not needed|Markeer .* als niet nodig/ })
    .filter({ visible: true })
    .waitFor()
  await page.screenshot({ path: join(directory, 'ambient-new-commitment.png') })
  const chat = await page.evaluate(() => window.remember.getAssistantConversation())
  assert.deepEqual(chat.messages, [])
  assert.equal(chat.activeTurnId, null)
  writeFileSync(
    join(directory, 'ambient-proof.json'),
    JSON.stringify(
      {
        startupThroughNativeContextParser: true,
        ordinaryDayTaskWriterWithoutBatch: true,
        originalSource: before.source,
        nextDayReplaySource: source,
        freshSource,
        exactPersistedSources: final.sources,
        taskSourceTimelineOpened: true,
        userDismissedTaskInRenderer: true,
        fullRestart: true,
        identicalScreenOnNextDayStayedAbandoned: true,
        freshNextDayCommitmentCreated: true,
        finalTasks: final.tasks,
        noAutomaticUserMessageOrToolTurn: true,
        providerStatus: before.providerStatus,
        boundary:
          'Synthetic native context through the real parser and storage, followed by an isolated helper invoking parseDayMemory and the ordinary Day task writer without an ambient/proactive batch. Real preload, renderer controls, source navigation and restart; clock advances one day. No full Day refresh, live model judgment, physical capture or notification claim.',
      },
      null,
      2
    )
  )
  await page.evaluate(() =>
    window.remember.updateSettings({ liveTaskUpdates: false, capturePaused: true, offlineMode: true })
  )
}
