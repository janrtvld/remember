import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import {
  type AssistantConversation,
  type AssistantTaskAction,
  agentComputerExecutionKey,
  normalizeAgentComputer,
  type RememberBridge,
  type WikiPage,
} from '@remember/shared'
import type { ElectronApplication, Page } from 'playwright-core'
import { initializeCodexServer } from '../../src/main/codexAppServer'
import { readRemoteThread, remoteTurns } from '../../src/main/codexRemoteRecovery'
import { connectCodexWebSocket } from '../../src/main/codexWebSocket'
import type { HostTaskRuntimeManifest } from '../../src/main/hostTaskRuntime'
import { DEFAULT_SETTINGS } from '../../src/main/settingsStore'
import { qaSshTarget } from './remoteConfig'

declare global {
  interface Window {
    remember: RememberBridge
  }
}

type Options = {
  directory: string
  launch(): Promise<Page>
  close(): Promise<void>
  getElectron(): ElectronApplication | undefined
  checks: string[]
}
type Row = Record<string, unknown>
type HostFacts = { job: Row | null; events: Row[]; requests: Row[] }
const ssh = promisify(execFile)
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const json = (value: unknown) => JSON.stringify(value, null, 2)
const parse = (value: unknown): Row => object(JSON.parse(String(value)))
function object(value: unknown): Row {
  assert(value && typeof value === 'object' && !Array.isArray(value))
  return value as Row
}

export function assertConfirmedTaskStop(before: HostFacts, after: HostFacts) {
  assert(before.job && after.job)
  assert.equal(before.job.phase, 'waiting')
  assert.equal(after.job.phase, 'stopped')
  for (const key of ['id', 'input_hash', 'thread_id', 'turn_id', 'created_at'])
    assert.equal(after.job[key], before.job[key], `Stop must retain exact ${key}`)
  assert.equal(typeof before.job.thread_id, 'string')
  assert.equal(typeof before.job.turn_id, 'string')
  const pending = before.requests.filter((request) => request.status === 'pending')
  assert.equal(pending.length, 1)
  const request = pending[0]
  const payload = parse(request.payload_json)
  assert.equal(request.method, 'client-tool')
  assert.equal(payload.tool, 'remember_memory')
  assert.equal(object(payload.input).action, 'patch')
  const ended = after.requests.filter((value) => value.id === request.id && value.session_id === request.session_id)
  assert.equal(ended.length, 1)
  assert.equal(ended[0].status, 'expired')
  assert.equal(ended[0].result_json, null)
  for (const key of ['method', 'payload_json', 'created_at']) assert.equal(ended[0][key], request[key])
  for (let index = 1; index < after.events.length; index++)
    assert(Number(after.events[index].seq) > Number(after.events[index - 1].seq), 'Journal order must be strict')
  const cursor = Number(before.events.at(-1)?.seq ?? 0)
  const events = after.events.filter((event) => Number(event.seq) > cursor)
  const one = (type: string) => {
    const values = events.filter((event) => event.type === type)
    assert.equal(values.length, 1, `Exactly one ${type} required after the reviewed snapshot`)
    return values[0]
  }
  const stop = one('stop-requested')
  const expired = events.filter(
    (event) => event.type === 'request-expired' && parse(event.payload_json).id === request.id
  )
  assert.equal(expired.length, 1)
  const cancellation = parse(expired[0].payload_json)
  assert.equal(cancellation.sessionId, request.session_id)
  assert.equal(cancellation.reason, 'upstream-request-resolved-or-cancelled')
  const terminal = events.filter(
    (event) => event.type === 'job-transition' && parse(event.payload_json).phase === 'stopped'
  )
  assert.equal(terminal.length, 1)
  const transition = parse(terminal[0].payload_json)
  assert.equal(transition.threadId, before.job.thread_id)
  assert.equal(transition.turnId, before.job.turn_id)
  assert(Number(stop.seq) < Number(expired[0].seq) && Number(expired[0].seq) < Number(terminal[0].seq))
  assert.equal(terminal[0].created_at, after.job.updated_at)
  assert(Number(stop.created_at) <= Number(expired[0].created_at))
  assert(Number(expired[0].created_at) <= Number(terminal[0].created_at))
  assert(Number(terminal[0].created_at) < Number(payload.expiresAt), 'Explicit Stop must precede original TTL')
  assert.equal(
    events.some((event) => event.type === 'review-expiry' || event.type === 'result-persisted'),
    false
  )
  const confirmed = events.filter((event) => event.type === 'stop-confirmed')
  if (confirmed.length) {
    assert.equal(confirmed.length, 1)
    const receipt = parse(confirmed[0].payload_json)
    assert.equal(receipt.threadId, before.job.thread_id)
    assert.equal(receipt.turnId, before.job.turn_id)
    assert(Number(stop.seq) < Number(confirmed[0].seq) && Number(confirmed[0].seq) < Number(terminal[0].seq))
    return {
      branch: 'checkpoint-stop',
      stopSeq: stop.seq,
      confirmationSeq: confirmed[0].seq,
      terminalSeq: terminal[0].seq,
    }
  }
  const worker = one('worker-ended')
  const outcome = parse(worker.payload_json)
  assert.equal(outcome.error, 'agent-cancelled')
  assert.equal(outcome.checkpointCleared, true)
  const checkpoint = events
    .filter((event) => event.type === 'checkpoint' && Number(event.seq) < Number(worker.seq))
    .at(-1)
  assert(checkpoint)
  assert.equal(parse(checkpoint.payload_json).checkpoint, null)
  assert(
    Number(stop.seq) < Number(checkpoint.seq) &&
      Number(checkpoint.seq) < Number(worker.seq) &&
      Number(worker.seq) < Number(terminal[0].seq)
  )
  return {
    branch: 'active-worker-stop',
    stopSeq: stop.seq,
    checkpointSeq: checkpoint.seq,
    workerEndedSeq: worker.seq,
    terminalSeq: terminal[0].seq,
  }
}

export function readHostTaskQaManifest(): HostTaskRuntimeManifest {
  const filename = process.env.REMEMBER_QA_HOST_TASK_MANIFEST
  assert.equal(typeof filename, 'string', 'An explicit owned temporary manifest is required')
  assert(filename)
  assert(filename.startsWith('/private/tmp/'))
  const bytes = readFileSync(filename)
  assert(bytes.byteLength <= 16_000)
  const manifest = JSON.parse(bytes.toString()) as HostTaskRuntimeManifest
  assert.equal(manifest.version, 1)
  assert.match(manifest.root, /^\/private\/tmp\/(?:r-)?e078-[a-z0-9-]+$/)
  assert.match(manifest.targetId, /^[a-zA-Z0-9_-]+$/)
  assert.match(manifest.targetEpoch, /^[a-zA-Z0-9_-]+$/)
  assert.equal(manifest.source.spaceId, 'personal')
  assert.match(manifest.source.slug, /^projects\/host-task-qa-[a-z0-9-]+$/)
  assert.equal(manifest.slots.length, 2)
  assert.equal(new Set(manifest.slots.map((slot) => slot.jobId)).size, 2)
  assert.equal(new Set(manifest.slots.map((slot) => slot.endpoint)).size, 2)
  for (const slot of manifest.slots) {
    assert.match(slot.jobId, /^[a-zA-Z0-9_-]+$/)
    assert.equal(slot.directory, join(manifest.root, 'jobs', sha(slot.jobId).slice(0, 24)))
    assert.equal(slot.workspace, join(slot.directory, 'workspace'))
    assert(Buffer.byteLength(join(slot.directory, 'client.sock')) < 104)
    assert.match(slot.endpoint, /^tcp:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/)
    assert(Number(slot.endpoint.split(':').at(-1)) <= 65_535)
  }
  const computer = normalizeAgentComputer(JSON.parse(manifest.computerExecutionKey))
  assert.equal(computer.kind, 'remote')
  assert.equal(agentComputerExecutionKey(computer), manifest.computerExecutionKey)
  assert(computer.kind === 'remote')
  assert.equal(computer.workspace, manifest.root)
  assert.equal(computer.endpoint, 'ws://127.0.0.1:47832/')
  return manifest
}

export function seedHostTaskProfile(profile: string) {
  const manifest = readHostTaskQaManifest()
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  writeFileSync(
    join(profile, 'settings.json'),
    json({
      ...DEFAULT_SETTINGS,
      interfaceLanguage: 'nl',
      offlineMode: false,
      cloudAnalysisConsent: true,
      cloudConsentNoticeSeen: true,
      automaticUpdates: false,
      launchAtLogin: false,
      frequentDayRefresh: false,
      liveTaskUpdates: false,
      agentLearningEnabled: false,
      audioCaptureEnabled: false,
      capturePaused: true,
      capturePausedUntil: null,
      capturePauseSources: ['audio', 'capture'],
      defaultAgentProvider: 'codex',
      dayAnalysisProvider: 'codex',
      agentComputer: JSON.parse(manifest.computerExecutionKey),
      codexAnalysisModel: process.env.REMEMBER_QA_HOST_TASK_MODEL || 'gpt-5.6-terra',
      codexAnalysisEffort: 'medium',
      dayAnalysisOnboardingCompleted: true,
      privacyOnboardingCompleted: true,
      audioCaptureOnboardingCompleted: true,
      contextImportOnboardingCompleted: true,
    }),
    { mode: 0o600 }
  )
  for (const marker of [
    '.legacy-user-data-migration-complete',
    '.legacy-archive-import-complete',
    '.legacy-model-import-complete',
  ])
    writeFileSync(join(profile, marker), 'qa\n', { mode: 0o600 })
}

function quote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`
}
async function hostFacts(slot: HostTaskRuntimeManifest['slots'][number]): Promise<HostFacts> {
  const script = `import json,sqlite3,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
job=c.execute('SELECT * FROM job').fetchone()
events=[dict(r) for r in c.execute('SELECT * FROM event ORDER BY seq')]
requests=[dict(r) for r in c.execute('SELECT * FROM server_request ORDER BY created_at,id')]
print(json.dumps({'job':dict(job) if job else None,'events':events,'requests':requests}));c.close()`
  const { stdout } = await ssh(
    '/usr/bin/ssh',
    [
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'ConnectTimeout=8',
      qaSshTarget(),
      `python3 -c ${quote(script)} ${quote(join(slot.directory, 'job.sqlite'))}`,
    ],
    { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }
  )
  return JSON.parse(stdout)
}

function tables(filename: string, names: string[]) {
  const db = new DatabaseSync(filename, { readOnly: true })
  try {
    return Object.fromEntries(
      names.map((name) => {
        assert.match(name, /^[a-z_]+$/)
        const columns = db.prepare(`PRAGMA table_info("${name}")`).all()
        assert(columns.length > 0, `Missing real table ${name}`)
        const primary = columns.filter((column) => Number(column.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk))
        const order = (primary.length ? primary : columns)
          .map((column) => `"${String(column.name).replaceAll('"', '""')}"`)
          .join(',')
        return [
          name,
          db
            .prepare(`SELECT * FROM "${name}" ORDER BY ${order}`)
            .all()
            .map((row) => ({ ...row })),
        ]
      })
    ) as Record<string, Row[]>
  } finally {
    db.close()
  }
}
export function localState(profile: string) {
  return {
    assistant: tables(join(profile, 'daily-review/assistant/conversation.sqlite'), [
      'assistant_message',
      'assistant_task_run',
      'assistant_task_execution',
      'assistant_task_memory_source',
      'assistant_tool_call',
      'assistant_thread',
      'assistant_host_run',
      'assistant_remote_run',
    ]),
    evidence: tables(join(profile, 'daily-review/evidence.sqlite'), [
      'work_item',
      'work_item_source',
      'work_item_host_receipt',
      'work_item_agent_session',
    ]),
    wiki: tables(join(profile, 'daily-review/wiki.sqlite'), ['wiki_page', 'wiki_page_revision']),
  }
}
export function frozenCopy(profile: string, destination: string) {
  const manifest: Row[] = []
  for (const file of [
    'daily-review/assistant/conversation.sqlite',
    'daily-review/evidence.sqlite',
    'daily-review/wiki.sqlite',
  ]) {
    for (const suffix of ['', '-wal', '-shm']) {
      const source = join(profile, file + suffix)
      if (!existsSync(source)) continue
      const target = join(destination, file + suffix)
      mkdirSync(join(target, '..'), { recursive: true, mode: 0o700 })
      copyFileSync(source, target)
      const bytes = readFileSync(source)
      assert.equal(sha(readFileSync(target)), sha(bytes))
      manifest.push({ source, target, bytes: bytes.byteLength, sha256: sha(bytes) })
    }
  }
  writeFileSync(join(destination, 'raw-files.json'), json(manifest))
  // SQLite reads a separate WAL-aware inspection copy, leaving raw evidence untouched.
  const inspection = `${destination}-inspection`
  for (const entry of manifest) {
    const target = String(entry.target).replace(destination, inspection)
    mkdirSync(join(target, '..'), { recursive: true })
    copyFileSync(String(entry.target), target)
  }
  return { files: manifest, state: localState(inspection) }
}
async function waitFor<T>(read: () => Promise<T | null | false>, label: string, timeout = 180_000): Promise<T> {
  const until = Date.now() + timeout
  for (;;) {
    const value = await read()
    if (value !== null && value !== false) return value
    assert(Date.now() < until, label)
    await delay(400)
  }
}
function onePage(pages: WikiPage[], slug: string) {
  const values = pages.filter((page) => page.slug === slug)
  assert.equal(values.length, 1)
  const value = values[0]
  assert(value.revision)
  return { ...value, revision: value.revision }
}
function actionOf(state: AssistantConversation, taskId: string) {
  return state.messages.map((message) => message.taskAction).find((action) => action?.workItemId === taskId)
}
function actionRows(state: ReturnType<typeof localState>, action: AssistantTaskAction) {
  const run = state.assistant.assistant_task_run.find((row) => row.action_id === action.actionId)
  const execution = state.assistant.assistant_task_execution.find((row) => row.action_id === action.actionId)
  assert(run && execution)
  assert.equal(run.assistant_message_id, action.messageId)
  assert.equal(run.work_item_id, action.workItemId)
  return {
    run,
    execution,
    sources: state.assistant.assistant_task_memory_source.filter((row) => row.action_id === action.actionId),
    calls: state.assistant.assistant_tool_call.filter((row) => row.message_id === action.messageId),
  }
}

function durableAction(rows: ReturnType<typeof actionRows>) {
  const { observation_json: _observation, cursor: _cursor, ...execution } = rows.execution
  return { ...rows, execution }
}

function durableMessage(message: AssistantConversation['messages'][number] | undefined) {
  assert(message?.taskAction)
  const { connection, ...taskAction } = message.taskAction
  assert(['connected', 'connecting', 'disconnected'].includes(connection))
  return { ...message, taskAction }
}
function assertSilent(
  settings: Awaited<ReturnType<Window['remember']['getSettings']>>,
  manifest: HostTaskRuntimeManifest
) {
  assert.equal(settings.audioCaptureEnabled, false)
  assert.equal(settings.capturePaused, true)
  assert.equal(settings.cloudAnalysisConsent, true)
  assert.equal(settings.offlineMode, false)
  assert.equal(agentComputerExecutionKey(settings.agentComputer), manifest.computerExecutionKey)
}
async function openTask(page: Page, taskId: string) {
  await page.goto(`${new URL(page.url()).origin}/inbox/?item=${encodeURIComponent(taskId)}`)
  const ask = page.getByRole('button', { name: /^(Vraag Agent|Ask Agent)$/ })
  await ask.waitFor({ state: 'visible' })
  await ask.focus()
  await ask.press('Enter')
  await page.waitForURL((url) => url.pathname === '/assistant/' && url.searchParams.get('task') === taskId)
  await waitFor(
    async () =>
      (await page.locator(`[data-assistant-task-draft="${taskId}"]`).innerText()).includes('Personal ·') || null,
    'The main-owned task and Personal source must be visible'
  )
}
async function resultLink(page: Page, messageId: string, href: string, title: string, content: string) {
  const row = page.locator(`[data-assistant-message="${messageId}"]`)
  const links = row.getByRole('list', { name: /^(Opgeslagen pagina's|Saved pages)$/ }).getByRole('link')
  await links.waitFor({ state: 'visible' })
  assert.equal(await links.count(), 1)
  assert.equal(await links.getAttribute('href'), href)
  assert((await links.innerText()).includes(title))
  await links.focus()
  assert(await links.evaluate((element) => document.activeElement === element))
  await links.press('Enter')
  await page.waitForURL((url) => `${url.pathname}${url.search}` === href)
  const editor = page.getByRole('textbox', { name: /^(Pagina-inhoud|Page content)$/ })
  await editor.waitFor()
  assert((await editor.innerText()).includes(content))
}

export async function residentHostTaskQa({ directory, launch, close, getElectron, checks }: Options) {
  const manifest = readHostTaskQaManifest()
  const profile = join(directory, 'profile')
  const proof: Row = {
    startedAt: new Date().toISOString(),
    manifest,
    boundary:
      'Real isolated native Task-to-chat A/B and two preprovisioned Mini jobs; one reviewed Personal patch. No capture/audio, production profile, cloud, arbitrary shell or lost-ACK injection. Exceptional UI overlays are not part of this live scenario.',
  }
  const save = () => writeFileSync(join(directory, 'resident-host-task-proof.json'), json(proof))
  let page: Page | null = null
  const nativePids: number[] = []
  const launchOwned = async () => {
    const target = await launch()
    target.setDefaultNavigationTimeout(120_000)
    const electron = getElectron()
    assert(electron)
    const pid = electron.process().pid
    assert(pid)
    nativePids.push(pid)
    assertSilent(await target.evaluate(() => window.remember.getSettings()), manifest)
    assert.notEqual((await target.evaluate(() => window.remember.getState())).status, 'recording')
    const state = await waitFor(
      async () => {
        const value = await target.evaluate(() => window.remember.getAssistantConversation())
        return value.taskActionsEnabled ? value : null
      },
      'Native feature gate must enable the actual Task runtime',
      30_000
    )
    assert.equal(state.taskActionsEnabled, true)
    return target
  }
  const quit = async (label: string) => {
    const pid = nativePids.at(-1)
    assert(pid)
    await close()
    page = null
    await waitFor(
      async () => {
        try {
          process.kill(pid, 0)
          return null
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
          throw error
        }
      },
      'Actual native main PID must exit',
      15_000
    )
    const copy = frozenCopy(profile, join(directory, label))
    proof[label] = { pid, exitedAt: Date.now(), ...copy }
    save()
    return copy.state
  }
  try {
    const initialHosts = await Promise.all(manifest.slots.map(hostFacts))
    assert(
      initialHosts.every((host) => host.job === null),
      'Both slots must be fresh before any user action'
    )
    proof.hostsBefore = initialHosts
    page = await launchOwned()
    const current = page
    const application = getElectron()
    assert(application)
    const untrusted = await application.evaluate(async ({ BrowserWindow, app }, nonce) => {
      const preload = `${app.getAppPath()}/out/preload/index.cjs`
      const other = new BrowserWindow({
        show: false,
        webPreferences: { preload, contextIsolation: true, sandbox: false, nodeIntegration: false },
      })
      try {
        await other.loadURL('about:blank')
        const results: unknown = await other.webContents.executeJavaScript(`Promise.all([
          () => window.remember.getAgentInteractions(),
          () => window.remember.answerAgentInteraction({id:${JSON.stringify(`qa-absent-review-${nonce}`)},action:'accept',values:{}}),
          () => window.remember.getAssistantTaskDraft(${JSON.stringify(`qa-absent-task-${nonce}`)})
        ].map(async call => {try {await call();return {rejected:false}}catch(error){return {rejected:true,error:String(error)}}}))`)
        return { url: other.webContents.getURL(), results }
      } finally {
        other.destroy()
      }
    }, randomUUID())
    assert.equal(untrusted.url, 'about:blank')
    assert(Array.isArray(untrusted.results) && untrusted.results.length === 3)
    for (const result of untrusted.results) {
      assert.equal(object(result).rejected, true)
      assert(String(object(result).error).includes('host-task-untrusted-sender'))
    }
    proof.untrustedMainFrame = untrusted
    const space = (await current.evaluate(() => window.remember.getWikiOverview())).spaces.find(
      (value) => value.id === 'personal'
    )
    assert(space && space.maintenanceMode === 'auto')
    const slug = manifest.source.slug
    const nonce = randomUUID()
    const title = `Host Task QA ${nonce}`
    const before = `State: READY_${nonce}`
    const after = `State: VERIFIED_${nonce}`
    const forbidden = `State: MUST_NOT_APPLY_${nonce}`
    const witness = `READ_${randomUUID()}`
    const content = `Disposable Task memory QA.\n\nRead witness: ${witness}\n\n${before}\n\nKeep this line unchanged.`
    const created = onePage(
      await current.evaluate(
        ({ slug, title }) => window.remember.createWikiPage({ spaceId: 'personal', category: 'projects', slug, title }),
        { slug, title }
      ),
      slug
    )
    const seed = onePage(
      await current.evaluate(
        ({ slug, title, content, revision }) =>
          window.remember.saveWikiPage({
            spaceId: 'personal',
            slug,
            title,
            content,
            expectedRevision: revision,
            strictRevision: true,
          }),
        { slug, title, content, revision: created.revision }
      ),
      slug
    )
    const tasks = await current.evaluate(async () => [
      await window.remember.createWorkItem({
        title: 'QA A — controleer de planning',
        description: 'Synthetic manual task. Prepare one reviewed Personal-page correction. Keep this task open.',
      }),
      await window.remember.createWorkItem({
        title: 'QA B — beoordeel de vervolgstap',
        description: 'Synthetic manual task. Wait for explicit review. Keep this task open.',
      }),
    ])
    const [taskA, taskB] = tasks
    const initial = localState(profile)
    assert.equal(initial.assistant.assistant_task_run.length, 0)
    assert.equal(initial.assistant.assistant_tool_call.length, 0)
    const instruction = (from: string, to: string, summary: string) =>
      `Use only remember_memory. Read the existing Personal page ${slug} (spaceId personal), then request exactly one patch using the current revision from that read: before=${JSON.stringify(from)}, after=${JSON.stringify(to)}, summary=${JSON.stringify(summary)}. Change nothing else. Wait for Remember's human review. After saving, finish with the exact Read witness value from the page, without any URL. Do not use shell, files, browser, search, ensure or other tools. Do not mark the task complete.`
    const instructionA = instruction(before, after, 'Native Task A reviewed change')
    await openTask(current, taskA.id)
    const source = current.locator(`[data-assistant-task-draft="${taskA.id}"]`).getByRole('link')
    const sourceHref = `/wiki/page/?space=personal&slug=${encodeURIComponent(slug)}`
    assert.equal(await source.getAttribute('href'), sourceHref)
    assert((await source.innerText()).includes(title))
    await source.focus()
    await source.press('Enter')
    await current.waitForURL((url) => `${url.pathname}${url.search}` === sourceHref)
    const sourceEditor = current.getByRole('textbox', { name: /^(Pagina-inhoud|Page content)$/ })
    await sourceEditor.waitFor()
    assert((await sourceEditor.innerText()).includes(content))
    await openTask(current, taskA.id)
    await current.locator('#assistant-message').fill(instructionA)
    await current.goto(`${new URL(current.url()).origin}/inbox/`)
    assert.deepEqual(
      localState(profile).assistant,
      initial.assistant,
      'Draft open/edit/leave must not create messages, intent or tool calls'
    )
    assert.deepEqual(localState(profile).evidence, initial.evidence)
    assert((await Promise.all(manifest.slots.map(hostFacts))).every((host) => host.job === null))
    await openTask(current, taskA.id)
    await current.locator('#assistant-message').fill(instructionA)
    const updated = await current.evaluate(
      (id) =>
        window.remember.updateWorkItem(id, {
          title: 'QA A — actuele planning',
          description: 'Explicit fixture edit before Send; keep open.',
        }),
      taskA.id
    )
    const taskBaseline = localState(profile).evidence.work_item
    const sourceBaseline = localState(profile).evidence.work_item_source
    proof.taskBaseline = { tasks: taskBaseline, sources: sourceBaseline }
    await current.locator('#assistant-message').press('Enter')
    const refresh = current.getByRole('button', { name: /^(Taak vernieuwen|Refresh task)$/ })
    await refresh.waitFor({ state: 'visible' })
    assert.equal(await current.locator('#assistant-message').inputValue(), instructionA)
    assert.deepEqual(localState(profile).assistant, initial.assistant)
    assert((await Promise.all(manifest.slots.map(hostFacts))).every((host) => host.job === null))
    proof.staleDraft = {
      taskId: taskA.id,
      beforeTitle: taskA.title,
      afterTitle: updated.title,
      instructionRetained: true,
      noAdmission: true,
    }
    await current.screenshot({ path: join(directory, 'host-task-stale-draft.png') })
    await refresh.focus()
    await refresh.press('Enter')
    await waitFor(
      async () =>
        (await current.locator(`[data-assistant-task-draft="${taskA.id}"]`).innerText()).includes(updated.title) ||
        null,
      'Explicit refresh must show current task'
    )
    assert.equal(await current.locator('#assistant-message').inputValue(), instructionA)
    await current.locator('#assistant-message').press('Enter')
    const actionA = await waitFor(
      async () => actionOf(await current.evaluate(() => window.remember.getAssistantConversation()), taskA.id) ?? null,
      'Send must durably create exactly one A action'
    )
    await current.waitForURL((url) => url.pathname === '/assistant/' && !url.searchParams.has('task'))
    assert.equal(await current.locator('#assistant-message').inputValue(), '')
    proof.admissionA = { acknowledgedAt: Date.now(), url: current.url(), composerCleared: true }
    const aRows = actionRows(localState(profile), actionA)
    assert.equal(aRows.run.job_id, manifest.slots[0].jobId)
    assert.equal(localState(profile).assistant.assistant_task_run.length, 1)
    assert.deepEqual(parse(aRows.run.envelope_json).sources, [
      { spaceId: 'personal', slug, revision: seed.revision, explicit: true },
    ])
    proof.actionA = actionA
    save()

    const waitReview = async (
      target: Page,
      action: AssistantTaskAction,
      revision: string,
      from: string,
      to: string,
      slot: number
    ) => {
      const request = await waitFor(async () => {
        const requests = await target.evaluate(() => window.remember.getAgentInteractions())
        assert(requests.length <= 1, 'Only one exact memory review is authorized')
        if (requests.length) return requests[0]
        const state = await target.evaluate(() => window.remember.getAssistantConversation())
        const actual = actionOf(state, action.workItemId)
        assert(actual && actual.actionId === action.actionId)
        assert(
          !['completed', 'stopped', 'cancelled'].includes(actual.state),
          `The exact expected review was not reached: ${json(actual)}`
        )
        return null
      }, 'An actual Mini read must lead to the exact native patch review')
      assert.equal(request.turnId, action.messageId)
      assert.equal(request.workItemId, action.workItemId)
      assert.equal(request.title, 'Kennis bewaren in Remember')
      assert.equal(request.detail, `Personal\n${slug}\nVersie: ${revision}\n\nVervang:\n${from}\n\nDoor:\n${to}`)
      assert.deepEqual(request.fields, [])
      assert.deepEqual(request.actions, [
        { id: 'accept', label: 'Bewaren' },
        { id: 'decline', label: 'Annuleren' },
      ])
      assert.equal(request.url, undefined)
      const actual = onePage(await target.evaluate(() => window.remember.listWikiPages('personal')), slug)
      assert.equal(actual.revision, revision)
      const host = await hostFacts(manifest.slots[slot])
      assert.equal(host.job?.id, manifest.slots[slot].jobId)
      const pending = host.requests.filter((row) => row.status === 'pending')
      assert.equal(pending.length, 1)
      assert.equal(pending[0].method, 'client-tool')
      const payload = parse(pending[0].payload_json)
      assert.equal(payload.tool, 'remember_memory')
      assert.deepEqual(payload.input, {
        action: 'patch',
        spaceId: 'personal',
        slug,
        expectedRevision: revision,
        before: from,
        after: to,
        summary: slot === 0 ? 'Native Task A reviewed change' : 'Native Task B must not apply',
      })
      for (const field of ['threadId', 'turnId', 'callId']) assert.equal(typeof payload[field], 'string')
      assert.equal(payload.threadId, host.job?.thread_id)
      assert.equal(payload.turnId, host.job?.turn_id)
      assert(Number(payload.expiresAt) > Date.now())
      const reads = host.requests.filter(
        (row) =>
          parse(row.payload_json).tool === 'remember_memory' && object(parse(row.payload_json).input).action === 'read'
      )
      assert.equal(reads.length, 1, 'Exactly one real read must precede this review')
      assert.equal(reads[0].status, 'resolved')
      const readReply = parse(reads[0].result_json)
      assert.equal(readReply.success, true)
      const readOutput = object(readReply.output)
      assert.equal(readOutput.revision, revision)
      assert.equal(readOutput.slug, slug)
      assert.equal(readOutput.content, actual.content)
      assert.equal(readOutput.truncated, false)
      const rows = actionRows(localState(profile), action)
      assert.equal(rows.calls.length, 1)
      assert.equal(rows.calls[0].result_json, null, 'Review may only reserve the write; it has not saved')
      await target.setViewportSize({ width: 720, height: 900 })
      const button = target.getByRole('button', { name: 'Bewaren', exact: true })
      await button.waitFor({ state: 'visible' })
      await button.focus()
      assert(await button.evaluate((element) => document.activeElement === element))
      await target.screenshot({ path: join(directory, `host-task-${slot === 0 ? 'a' : 'b'}-review-narrow.png`) })
      return { request, host, rows }
    }
    const reviewA = await waitReview(current, actionA, seed.revision, before, after, 0)
    proof.reviewA = reviewA
    save()
    await current.getByRole('button', { name: 'Bewaren', exact: true }).press('Enter')
    const completeA = await waitFor(async () => {
      assert.equal(
        (await current.evaluate(() => window.remember.getAgentInteractions())).length,
        0,
        'No second approval is authorized'
      )
      const state = await current.evaluate(() => window.remember.getAssistantConversation())
      const action = actionOf(state, taskA.id)
      return action?.state === 'completed' && action.connection === 'connected' ? state : null
    }, 'A must complete after the one reviewed save')
    const saved = onePage(await current.evaluate(() => window.remember.listWikiPages('personal')), slug)
    assert.equal(saved.content, content.replace(before, after))
    assert.notEqual(saved.revision, seed.revision)
    const aCompleteRows = actionRows(localState(profile), actionA)
    assert.equal(aCompleteRows.calls.length, 1)
    const receipt = parse(aCompleteRows.calls[0].result_json)
    assert.equal(receipt.saved, true)
    assert.equal(receipt.proposed, false)
    assert.equal(receipt.kind, 'saved-page')
    assert.equal(receipt.spaceId, 'personal')
    assert.equal(receipt.revision, saved.revision)
    assert.equal(receipt.slug, slug)
    assert.equal(parse(aCompleteRows.sources[0].reference_json).revision, saved.revision)
    assert.equal(object((parse(aCompleteRows.run.envelope_json).sources as unknown[])[0]).revision, seed.revision)
    const revisions = localState(profile).wiki.wiki_page_revision
    assert.equal(revisions.find((row) => row.id === saved.revision)?.parent_revision_id, seed.revision)
    assert.equal(revisions.length, initial.wiki.wiki_page_revision.length + 1)
    assert.deepEqual(
      revisions.filter((row) => row.id !== saved.revision),
      initial.wiki.wiki_page_revision
    )
    const finalMessage = completeA.messages.find((message) => message.id === actionA.messageId)
    assert(finalMessage)
    assert(finalMessage.text.includes(witness))
    assert(
      !finalMessage.text.includes('/wiki/') && !/https?:\/\//.test(finalMessage.text),
      'Result UI must work without model-authored links'
    )
    assert.equal(finalMessage.results?.length, 1)
    assert.equal(finalMessage.results[0].revision, saved.revision)
    const href = `/wiki/page/?space=personal&slug=${encodeURIComponent(slug)}`
    await current.screenshot({ path: join(directory, 'host-task-a-completed-narrow.png') })
    await current.setViewportSize({ width: 1200, height: 900 })
    await current.screenshot({ path: join(directory, 'host-task-a-completed.png') })
    await resultLink(current, actionA.messageId, href, title, saved.content)
    await current.screenshot({ path: join(directory, 'host-task-a-page.png') })
    assert.deepEqual(
      localState(profile).evidence.work_item,
      taskBaseline,
      'Agent completion must not alter the human tasks'
    )
    proof.completedA = { message: finalMessage, rows: aCompleteRows, revision: saved.revision, receipt }
    await quit('after-a-quit')
    page = await launchOwned()
    await page.goto(`${new URL(page.url()).origin}/assistant/`)
    const restartedA = await page.evaluate(() => window.remember.getAssistantConversation())
    assert.deepEqual(
      durableMessage(restartedA.messages.find((message) => message.id === actionA.messageId)),
      durableMessage(finalMessage)
    )
    assert.equal(actionOf(restartedA, taskA.id)?.connection, 'disconnected')
    assert.deepEqual(durableAction(actionRows(localState(profile), actionA)), durableAction(aCompleteRows))
    await resultLink(page, actionA.messageId, href, title, saved.content)

    await openTask(page, taskB.id)
    const instructionB = instruction(after, forbidden, 'Native Task B must not apply')
    await page.locator('#assistant-message').fill(instructionB)
    await page.locator('#assistant-message').press('Enter')
    const second = page
    const actionB = await waitFor(
      async () => actionOf(await second.evaluate(() => window.remember.getAssistantConversation()), taskB.id) ?? null,
      'B must get a separate durable identity'
    )
    await second.waitForURL((url) => url.pathname === '/assistant/' && !url.searchParams.has('task'))
    assert.equal(await second.locator('#assistant-message').inputValue(), '')
    proof.admissionB = { acknowledgedAt: Date.now(), url: second.url(), composerCleared: true }
    assert.notEqual(actionB.actionId, actionA.actionId)
    assert.notEqual(actionB.messageId, actionA.messageId)
    assert.equal(actionRows(localState(profile), actionB).run.job_id, manifest.slots[1].jobId)
    assert.equal(localState(profile).assistant.assistant_task_run.length, 2)
    const reviewB = await waitReview(second, actionB, saved.revision, after, forbidden, 1)
    proof.reviewB = reviewB
    const aControls = second.locator(`[data-task-action="${actionA.actionId}"]`).getByRole('button')
    assert.equal(await aControls.count(), 0, 'Historical terminal A must not offer B controls')
    const staleError = await second.evaluate(
      async (input) => {
        try {
          await window.remember.controlAssistantTask(input)
          return null
        } catch (error) {
          return String(error)
        }
      },
      { actionId: actionA.actionId, messageId: actionB.messageId, command: 'stop' as const }
    )
    assert(staleError, 'Cross-action A/B control must fail')
    assert(staleError.includes('host-task-message-mismatch'))
    assert.equal((await hostFacts(manifest.slots[1])).job?.phase, 'waiting')
    const stop = second
      .locator(`[data-task-action="${actionB.actionId}"]`)
      .getByRole('button', { name: /^(Stoppen|Stop)$/ })
    await stop.focus()
    await stop.press('Enter')
    await waitFor(
      async () =>
        actionOf(await second.evaluate(() => window.remember.getAssistantConversation()), taskB.id)?.state ===
          'stopped' || null,
      'B Stop must be confirmed for the exact action'
    )
    const stoppedHost = await hostFacts(manifest.slots[1])
    const stopProof = assertConfirmedTaskStop(reviewB.host, stoppedHost)
    const late = await second.evaluate(async (id) => {
      try {
        await window.remember.answerAgentInteraction({ id, action: 'accept', values: {} })
        return null
      } catch (error) {
        return String(error)
      }
    }, reviewB.request.id)
    assert(late, 'The old local review must not be answerable after Stop')
    assert(late.includes('agent-request-expired'))
    const bStoppedRows = actionRows(localState(profile), actionB)
    assert.equal(parse(bStoppedRows.execution.terminal_json).stopReason, null)
    assert.equal(bStoppedRows.calls.length, 1)
    assert.equal(bStoppedRows.calls[0].result_json, null)
    assert.equal(
      onePage(await second.evaluate(() => window.remember.listWikiPages('personal')), slug).revision,
      saved.revision
    )
    assert.deepEqual(durableAction(actionRows(localState(profile), actionA)), durableAction(aCompleteRows))
    assert.deepEqual(localState(profile).evidence.work_item, taskBaseline)
    assert.deepEqual(localState(profile).evidence.work_item_source, sourceBaseline)
    await second.screenshot({ path: join(directory, 'host-task-b-stopped-narrow.png') })
    proof.stoppedB = { actionB, rows: bStoppedRows, host: stoppedHost, stopProof, staleError, late }
    await quit('after-b-quit')
    page = await launchOwned()
    await page.goto(`${new URL(page.url()).origin}/assistant/`)
    await page.setViewportSize({ width: 720, height: 900 })
    const final = await page.evaluate(() => window.remember.getAssistantConversation())
    assert.equal(actionOf(final, taskB.id)?.state, 'stopped')
    assert.deepEqual(
      durableMessage(final.messages.find((message) => message.id === actionA.messageId)),
      durableMessage(finalMessage)
    )
    assert.equal(actionOf(final, taskA.id)?.connection, 'disconnected')
    assert.equal(actionOf(final, taskB.id)?.connection, 'disconnected')
    assert.deepEqual(durableAction(actionRows(localState(profile), actionA)), durableAction(aCompleteRows))
    assert.deepEqual(durableAction(actionRows(localState(profile), actionB)), durableAction(bStoppedRows))
    assert.equal((await page.evaluate(() => window.remember.getAgentInteractions())).length, 0)
    assert.equal(final.activeTaskAction, null)
    assert.deepEqual(localState(profile).evidence.work_item, taskBaseline)
    assert.deepEqual(localState(profile).evidence.work_item_source, sourceBaseline)
    await page.screenshot({ path: join(directory, 'host-task-final-history-narrow.png') })
    await resultLink(page, actionA.messageId, href, title, saved.content)
    const finalHosts = await Promise.all(manifest.slots.map(hostFacts))
    assert.notEqual(finalHosts[0].job?.thread_id, finalHosts[1].job?.thread_id)
    assert.notEqual(finalHosts[0].job?.turn_id, finalHosts[1].job?.turn_id)
    for (const [index, host] of finalHosts.entries()) {
      assert.equal(host.job?.id, manifest.slots[index].jobId)
      assert.equal(host.events.filter((event) => event.type === 'job-submitted').length, 1)
      assert.equal(host.events.filter((event) => event.type === 'driver-invoked').length, 1)
      assert.equal(host.requests.length, 2, 'Only the one source read and exact patch are allowed')
      for (const request of host.requests) {
        assert.equal(request.method, 'client-tool')
        const payload = parse(request.payload_json)
        assert.equal(payload.tool, 'remember_memory')
        assert.equal(object(payload.input).spaceId, 'personal')
        assert.equal(object(payload.input).slug, slug)
      }
      const patch = host.requests.find((request) => object(parse(request.payload_json).input).action === 'patch')
      assert(patch)
      assert.equal(patch.status, index === 0 ? 'resolved' : 'expired')
      if (index === 0) assert.deepEqual(parse(patch.result_json), { success: true, output: receipt })
      else assert.equal(patch.result_json, null, 'Stopped B must never forward a saved or declined patch reply')
      assert.equal(host.events.filter((event) => event.type === 'review-forwarded').length, index === 0 ? 2 : 1)
      const provider = await connectCodexWebSocket('ws://127.0.0.1:47832/', { onNotification() {}, onClose() {} })
      try {
        await initializeCodexServer(provider, 'native-task-readback')
        assert.equal(typeof host.job?.thread_id, 'string')
        const thread = await readRemoteThread(provider, String(host.job?.thread_id))
        const turns = remoteTurns(thread)
        assert.equal(turns.length, 1, 'Restart must not create another provider turn')
        assert.equal(turns[0].id, host.job?.turn_id)
        assert.equal(turns[0].status, index === 0 ? 'completed' : 'interrupted')
        assert(Array.isArray(turns[0].items))
        assert(
          !turns[0].items.some((item: Row) =>
            ['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch'].includes(String(item.type))
          )
        )
        proof[`provider${index === 0 ? 'A' : 'B'}`] = { thread, turns, spec: parse(host.job?.spec_json) }
      } finally {
        provider.close()
      }
    }
    assert.equal(finalHosts[0].job?.phase, 'completed')
    assert.equal(finalHosts[1].job?.phase, 'stopped')
    assert.deepEqual(localState(profile).assistant.assistant_thread, [])
    assert.deepEqual(localState(profile).assistant.assistant_host_run, [])
    assert.deepEqual(localState(profile).assistant.assistant_remote_run, [])
    proof.finalHosts = finalHosts
    proof.nativePids = nativePids
    proof.phase = 'complete'
    await quit('final-quit')
    checks.push('Native Task draft is inert; stale Send preserves text and requires explicit refresh')
    checks.push(
      'A: real Mini read and exact keyboard-reviewed Personal save produce one durable typed result and unchanged human task'
    )
    checks.push(
      'B: separate identity/review, exact Stop before TTL, stale A control and late B review rejected; no second write'
    )
    checks.push(
      'Two full native restarts preserve A outcome/result and stopped B; actual host journals/provider turns show no replay'
    )
    save()
  } catch (error) {
    proof.phase = 'failed'
    proof.error = error instanceof Error ? error.stack : String(error)
    proof.nativePids = nativePids
    if (page) {
      try {
        proof.failedState = await page.evaluate(() => window.remember.getAssistantConversation())
        proof.failedLocal = localState(profile)
      } catch {}
      try {
        await page.screenshot({ path: join(directory, 'host-task-failed.png') })
      } catch {}
      // Cleanup may stop only this manifest's current action, never another job or provider.
      try {
        const state = await page.evaluate(() => window.remember.getAssistantConversation())
        if (state.activeTaskAction)
          proof.cleanup = await page.evaluate(
            (action) =>
              window.remember.controlAssistantTask({
                actionId: action.actionId,
                messageId: action.messageId,
                command: 'stop',
              }),
            state.activeTaskAction
          )
      } catch (cleanupError) {
        proof.cleanupError = String(cleanupError)
      }
    }
    save()
    throw error
  } finally {
    await close()
  }
}
