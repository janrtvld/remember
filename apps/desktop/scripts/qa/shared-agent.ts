import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import {
  type AssistantConversation,
  type AssistantTaskAction,
  agentComputerExecutionKey,
  normalizeAgentComputer,
  type WikiPage,
} from '@remember/shared'
import type { ElectronApplication, Page } from 'playwright-core'
import type { HostTaskRuntimeManifest } from '../../src/main/hostTaskRuntime'
import { assertConfirmedTaskStop, frozenCopy, localState, readHostTaskQaManifest } from './residentHostTask'

type Row = Record<string, unknown>
type HostFacts = { job: Row | null; events: Row[]; requests: Row[] }
type Setup = {
  manifestPath: string
  root: string
  childPids: number[]
  before: string
  after: string
  forbidden: string
  witness: string
}
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const json = (value: unknown) => JSON.stringify(value, null, 2)
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const question = 'shared-agent-chat-answer: Say only the synthetic chat confirmation.'
const answer = 'Synthetic shared chat reply verified.'
const heldQuestion = 'shared-agent-chat-hold: Wait here until I stop this chat reply.'

function record(file: string, value: unknown) {
  appendFileSync(file, `${JSON.stringify(value)}\n`)
}
function lines(file: string): Row[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}
function parse(value: unknown): Row {
  const parsed = JSON.parse(String(value))
  assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed))
  return parsed
}
async function waitFor<T>(read: () => Promise<T | null | false>, label: string, timeout = 30_000): Promise<T> {
  const until = Date.now() + timeout
  for (;;) {
    const value = await read()
    if (value !== null && value !== false) return value
    assert(Date.now() < until, label)
    await delay(100)
  }
}
function gone(pid: number) {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
    throw error
  }
}
function facts(slot: HostTaskRuntimeManifest['slots'][number]): HostFacts {
  const db = new DatabaseSync(join(slot.directory, 'job.sqlite'), { readOnly: true })
  const rows = (sql: string) =>
    db
      .prepare(sql)
      .all()
      .map((row) => ({ ...row }))
  try {
    return {
      job: rows('SELECT * FROM job')[0] ?? null,
      events: rows('SELECT * FROM event ORDER BY seq'),
      requests: rows('SELECT * FROM server_request ORDER BY created_at,id'),
    }
  } finally {
    db.close()
  }
}
function captureRows(profile: string) {
  const db = new DatabaseSync(join(profile, 'daily-review/evidence.sqlite'), { readOnly: true })
  try {
    return Object.fromEntries(
      ['audio_evidence', 'context_evidence'].map((table) => [
        table,
        db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count,
      ])
    )
  } finally {
    db.close()
  }
}
async function rpc(socketPath: string, op: string): Promise<Row> {
  return new Promise((accept, reject) => {
    const socket = createConnection(socketPath)
    const timeout = setTimeout(() => finish(Error(`Owned coordinator ${op} timed out`)), 10_000)
    let buffer = ''
    const finish = (error?: Error, result?: Row) => {
      clearTimeout(timeout)
      socket.destroy()
      if (error) reject(error)
      else {
        assert(result)
        accept(result)
      }
    }
    socket.on('error', (error) => finish(error))
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: 1, op })}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      if (!buffer.includes('\n')) return
      try {
        const response = JSON.parse(buffer.slice(0, buffer.indexOf('\n')))
        assert.equal(response.id, 1)
        finish(response.error ? Error(response.error) : undefined, response.result)
      } catch (error) {
        finish(error as Error)
      }
    })
  })
}

/** Provisions only this run's two local single-job coordinators and loopback bridges. */
export async function setupSharedAgentQa(runDirectory: string) {
  const nonce = randomUUID().slice(0, 8)
  const root = `/private/tmp/e078-rpa2-${nonce}`
  mkdirSync(root, { mode: 0o700 })
  mkdirSync(runDirectory, { recursive: true })
  const manifestPath = join(root, 'manifest.json')
  const trace = join(root, 'provider.jsonl')
  writeFileSync(trace, '')
  const setup: Setup = {
    manifestPath,
    root,
    childPids: [],
    before: `READY_${nonce}`,
    after: `VERIFIED_${nonce}`,
    forbidden: `FORBIDDEN_${nonce}`,
    witness: `SHARED_RESULT_${nonce}`,
  }
  const manifest: HostTaskRuntimeManifest = {
    version: 1,
    targetId: `shared-agent-${nonce}`,
    targetEpoch: `epoch-${nonce}`,
    root,
    source: { spaceId: 'personal', slug: `projects/host-task-qa-rpa2-${nonce}` },
    computerExecutionKey: agentComputerExecutionKey(
      normalizeAgentComputer({ kind: 'remote', endpoint: 'ws://127.0.0.1:47832/', workspace: root })
    ),
    slots: ['A', 'B'].map((suffix) => {
      const jobId = `shared-${nonce}-${suffix}`
      const directory = join(root, 'jobs', hash(jobId).slice(0, 24))
      mkdirSync(join(directory, 'workspace'), { recursive: true, mode: 0o700 })
      return { jobId, directory, workspace: join(directory, 'workspace'), endpoint: '' }
    }),
  }
  const childFile = join(root, 'coordinator-fixture.mjs')
  writeFileSync(
    childFile,
    `import assert from 'node:assert/strict';
import {appendFileSync,readFileSync} from 'node:fs';
import {createCoordinator} from ${JSON.stringify(join(repository, 'experiments/always-on-agent/coordinator.mjs'))};
const config=JSON.parse(readFileSync(process.argv[2],'utf8')), index=Number(process.argv[3]), slot=config.manifest.slots[index], suffix=index===0?'A':'B';
const log=value=>appendFileSync(config.trace,JSON.stringify({at:Date.now(),pid:process.pid,suffix,...value})+'\\n');
const coordinator=await createCoordinator({directory:slot.directory,nativeClient:true,driver:{
 async runCodexWorker(input){
  const threadId='thread-'+slot.jobId,turnId='turn-'+slot.jobId;
  log({kind:'invoked',jobId:slot.jobId,threadId,turnId,prompt:input.prompt});
  assert(input.prompt.includes('shared-agent-task-'+suffix));
  input.onThread(threadId);
  input.onCheckpoint({computer:input.remote,threadId,turnId:null,previousTurnId:null});
  input.onCheckpoint({computer:input.remote,threadId,turnId,previousTurnId:null});
  try{
   assert.equal(input.tools.length,1);assert.equal(input.tools[0].name,'remember_memory');
   const read=await input.tools[0].call({action:'read',spaceId:'personal',slug:config.manifest.source.slug},{threadId,turnId,callId:'read-'+slot.jobId,signal:input.signal});
   log({kind:'read-returned',result:read});
   assert.equal(read.slug,config.manifest.source.slug);assert(read.content.includes(index===0?config.setup.before:config.setup.after));
   const patch={action:'patch',spaceId:'personal',slug:read.slug,expectedRevision:read.revision,before:index===0?config.setup.before:config.setup.after,after:index===0?config.setup.after:config.setup.forbidden,summary:'Shared agent '+suffix+' reviewed patch'};
   log({kind:'patch-requested',patch});
   const result=await input.tools[0].call(patch,{threadId,turnId,callId:'patch-'+slot.jobId,signal:input.signal});
   log({kind:'patch-returned',result});
   assert.equal(index,0,'B must never receive a patch answer');assert.equal(result.kind,'saved-page');
   input.report('status','saved-A','Verified the disposable Personal change.');
   const response=config.setup.witness+': completed one reviewed Personal change.';
   log({kind:'completed',response});return {response,threadId};
  }finally{input.onCheckpoint(null);log({kind:'worker-ended'});}
 },async stopCodexRemoteCheckpoint(checkpoint){log({kind:'checkpoint-stop',checkpoint});}
}});
process.on('message',async message=>{if(message==='close'){try{await coordinator.close();log({kind:'closed'});process.exit(0)}catch(error){process.send?.({closeError:String(error)})}}});
process.send?.({ready:true,pid:process.pid,socketPath:coordinator.socketPath});
`
  )
  const configFile = join(root, 'provider-config.json')
  writeFileSync(configFile, json({ manifest, setup, trace }))
  const children: ChildProcess[] = []
  const servers: Server[] = []
  const sockets = new Set<Socket>()
  let cleaned = false
  const cleanup = async () => {
    if (cleaned) return
    cleaned = true
    const errors: string[] = []
    const result: Row = { startedAt: Date.now(), children: [], sockets: [], errors }
    for (const [index, child] of children.entries()) {
      const slot = manifest.slots[index]
      try {
        if (child.exitCode === null && child.signalCode === null) {
          const before = facts(slot)
          writeFileSync(join(root, `cleanup-${index}-before.json`), json(before))
          if (before.job && !['completed', 'stopped'].includes(String(before.job.phase))) {
            const hello = await rpc(join(slot.directory, 'client.sock'), 'hello')
            assert.equal(hello.jobId, slot.jobId)
            const stopped = await rpc(join(slot.directory, 'client.sock'), 'stop')
            assert.equal(stopped.id, slot.jobId)
            assert(['completed', 'stopped'].includes(String(stopped.phase)))
            writeFileSync(join(root, `cleanup-${index}-stop.json`), json(stopped))
          }
          child.send('close')
          await waitFor(
            async () => child.exitCode !== null || child.signalCode !== null,
            'Own coordinator must close',
            10_000
          )
        }
        assert.equal(child.exitCode, 0)
      } catch (error) {
        errors.push(`coordinator-${index}: ${String(error)}`)
        record(join(root, 'cleanup-errors.jsonl'), { index, error: String(error) })
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      }
      const pid = child.pid
      try {
        if (pid) await waitFor(async () => gone(pid) || null, 'Owned child must exit', 10_000)
      } catch (error) {
        errors.push(`coordinator-${index}-exit: ${String(error)}`)
      }
      ;(result.children as unknown[]).push({
        pid: child.pid,
        exitCode: child.exitCode,
        signalCode: child.signalCode,
        gone: child.pid ? gone(child.pid) : null,
      })
      const socket = join(slot.directory, 'client.sock')
      if ((!pid || gone(pid)) && existsSync(socket)) unlinkSync(socket)
      ;(result.sockets as unknown[]).push({ path: socket, absent: !existsSync(socket) })
    }
    for (const socket of sockets) socket.destroy()
    for (const server of servers) await new Promise<void>((done) => server.close(() => done()))
    result.bridgeServersClosed = servers.every((server) => !server.listening)
    result.finishedAt = Date.now()
    copyFileSync(trace, join(runDirectory, 'shared-provider-after-cleanup.jsonl'))
    writeFileSync(join(runDirectory, 'shared-agent-cleanup.json'), json(result))
    assert.equal(errors.length, 0, `Owned fixture cleanup failed: ${errors.join('; ')}`)
  }
  try {
    for (const [index, slot] of manifest.slots.entries()) {
      const child = spawn(process.execPath, [childFile, configFile, String(index)], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
      children.push(child)
      child.stdout?.on('data', (data) => appendFileSync(join(root, `child-${index}.stdout`), data))
      child.stderr?.on('data', (data) => appendFileSync(join(root, `child-${index}.stderr`), data))
      await new Promise<void>((accept, reject) => {
        const timeout = setTimeout(() => reject(Error('Local coordinator readiness timed out')), 10_000)
        child.once('error', reject)
        child.once('exit', (code) => {
          clearTimeout(timeout)
          reject(Error(`Local coordinator exited ${code} before ready`))
        })
        child.once('message', (raw) => {
          clearTimeout(timeout)
          const message = raw as Row
          try {
            assert.equal(message.ready, true)
            assert.equal(message.socketPath, join(slot.directory, 'client.sock'))
            accept()
          } catch (error) {
            reject(error)
          }
        })
      })
      assert(child.pid)
      setup.childPids.push(child.pid)
      const server = createServer((client) => {
        const upstream = createConnection(join(slot.directory, 'client.sock'))
        sockets.add(client)
        sockets.add(upstream)
        client.on('close', () => {
          sockets.delete(client)
          upstream.destroy()
        })
        upstream.on('close', () => {
          sockets.delete(upstream)
          client.destroy()
        })
        client.on('error', () => upstream.destroy())
        upstream.on('error', () => client.destroy())
        client.pipe(upstream)
        upstream.pipe(client)
      })
      servers.push(server)
      await new Promise<void>((accept, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', accept)
      })
      const address = server.address()
      assert(address && typeof address !== 'string')
      slot.endpoint = `tcp://127.0.0.1:${address.port}`
    }
    writeFileSync(manifestPath, json(manifest), { mode: 0o600 })
    writeFileSync(join(runDirectory, 'shared-agent-setup.json'), json(setup))
    writeFileSync(join(runDirectory, 'shared-agent-manifest.json'), json(manifest))
    return { manifestPath, cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}

/** The fixture changes only the runner's copied executable discovery boundary. */
export function installSharedAgentChatFixture(desktopDirectory: string) {
  assert(!desktopDirectory.endsWith('/apps/desktop'), 'Never install fixture into checkout')
  const manifest = readHostTaskQaManifest()
  const log = join(manifest.root, 'chat.jsonl')
  writeFileSync(log, '')
  const executable = join(desktopDirectory, 'shared-agent-codex-fixture.cjs')
  writeFileSync(
    executable,
    `#!${process.execPath}
const fs=require('node:fs');
const log=value=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({at:Date.now(),pid:process.pid,...value})+'\\n');
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
if(process.argv.includes('--version')){console.log('codex-cli 0.0.0-shared-agent-qa');process.exit(0)}
if(process.argv.includes('login')&&process.argv.includes('status')){console.log('Logged in using ChatGPT');process.exit(0)}
if(!process.argv.includes('exec'))throw Error('Only tools-disabled SDK exec is expected');
log({kind:'exec-start',argv:process.argv.slice(2)});
let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>text+=chunk);
process.stdin.on('end',()=>{
 log({kind:'exec-input',text});
 if(!text.startsWith('You are Remember in a tools-disabled chat turn.'))throw Error('Unexpected chat driver');
 if(text.includes('shared-agent-task-')||text.includes('TASK_SECRET_')||text.includes('SHARED_RESULT_'))throw Error('Task text leaked into ordinary chat');
 send({type:'thread.started',thread_id:'shared-chat-'+process.pid});
 if(text.includes(${JSON.stringify(heldQuestion)})){
  log({kind:'held'});const timer=setInterval(()=>{},1000);
  for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.on(signal,()=>{log({kind:'cancelled',signal});clearInterval(timer);process.exit(0)});
 }else if(text.includes(${JSON.stringify(question)})){
  send({type:'item.completed',item:{id:'shared-answer',type:'agent_message',text:${JSON.stringify(answer)}}});
  send({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}});log({kind:'completed'});
 }else throw Error('Unexpected ordinary chat');
});
`,
    { mode: 0o700 }
  )
  const runtime = join(desktopDirectory, 'src/main/codexRuntime.ts')
  const original = readFileSync(runtime, 'utf8')
  const boundary = /export function bundledCodexExecutable\(\) \{[\s\S]*?\n\}/g
  assert.equal([...original.matchAll(boundary)].length, 1)
  writeFileSync(
    runtime,
    original.replace(boundary, `export function bundledCodexExecutable() { return ${JSON.stringify(executable)} }`)
  )
}

function actionOf(state: AssistantConversation, workItemId: string) {
  return state.messages.map((message) => message.taskAction).find((action) => action?.workItemId === workItemId)
}
function onePage(pages: WikiPage[], slug: string) {
  const matches = pages.filter((page) => page.slug === slug)
  assert.equal(matches.length, 1)
  assert(matches[0].revision)
  return { ...matches[0], revision: matches[0].revision }
}
function durableMessage(message: AssistantConversation['messages'][number] | undefined) {
  assert(message?.taskAction)
  const { connection: _connection, ...taskAction } = message.taskAction
  return { ...message, taskAction }
}
async function openTask(page: Page, id: string) {
  await page.goto(`${new URL(page.url()).origin}/inbox/?item=${encodeURIComponent(id)}`)
  const ask = page.getByRole('button', { name: /^(Vraag Agent|Ask Agent)$/ })
  await ask.waitFor({ state: 'visible' })
  await ask.focus()
  await ask.press('Enter')
  await page.waitForURL((url) => url.pathname === '/assistant/' && url.searchParams.get('task') === id)
  await waitFor(
    async () => (await page.locator(`[data-assistant-task-draft="${id}"]`).innerText()).includes('Personal ·') || null,
    'Exact main-owned Task draft and source must render'
  )
}

export async function sharedAgentQa({
  directory,
  launch,
  close,
  getElectron,
  checks,
}: {
  directory: string
  launch(): Promise<Page>
  close(): Promise<void>
  getElectron(): ElectronApplication | undefined
  checks: string[]
}) {
  const setup = JSON.parse(readFileSync(join(directory, 'shared-agent-setup.json'), 'utf8')) as Setup
  const manifest = readHostTaskQaManifest()
  assert.equal(manifest.root, setup.root)
  const profile = join(directory, 'profile')
  const proof: Row = {
    startedAt: Date.now(),
    boundary:
      'Real isolated Electron, two local coordinator processes with fake providers, actual disposable Personal write. Ordinary tools-disabled SDK uses deterministic CLI. No Mini, model, cloud, production, audio or new capture.',
    setup,
    manifest,
  }
  const save = () => writeFileSync(join(directory, 'shared-agent-proof.json'), json(proof))
  const nativePids: number[] = []
  let page: Page | null = null
  const start = async () => {
    const target = await launch()
    target.setDefaultTimeout(20_000)
    target.setDefaultNavigationTimeout(90_000)
    const pid = getElectron()?.process().pid
    assert(pid)
    nativePids.push(pid)
    await target.goto(`${new URL(target.url()).origin}/assistant/`)
    const state = await waitFor(async () => {
      const state = await target.evaluate(() => window.remember.getAssistantConversation())
      return state.sharedTaskChat && state.taskActionsEnabled ? state : null
    }, 'Shared native conversation owner must be active')
    assert.equal(state.execution, 'local')
    const settings = await target.evaluate(() => window.remember.getSettings())
    assert.equal(settings.audioCaptureEnabled, false)
    assert.equal(settings.capturePaused, true)
    assert.notEqual((await target.evaluate(() => window.remember.getState())).status, 'recording')
    return target
  }
  const quit = async (label: string) => {
    const pid = nativePids.at(-1)
    assert(pid)
    await close()
    page = null
    await waitFor(async () => gone(pid) || null, 'Native main PID must exit', 15_000)
    proof[label] = { pid, exitedAt: Date.now(), ...frozenCopy(profile, join(directory, label)) }
    save()
  }
  const submit = async (target: Page, taskId: string, suffix: string) => {
    await openTask(target, taskId)
    await target
      .locator('#assistant-message')
      .fill(
        `shared-agent-task-${suffix}: TASK_SECRET_${suffix}. Read the selected existing Personal page, propose only the exact ${suffix} patch and wait for my review.`
      )
    await target.locator('#assistant-message').press('Enter')
    const action = await waitFor(
      async () => actionOf(await target.evaluate(() => window.remember.getAssistantConversation()), taskId) ?? null,
      'Explicit Send must create its exact Task action'
    )
    await target.waitForURL((url) => url.pathname === '/assistant/' && !url.searchParams.has('task'))
    assert.equal(await target.locator('#assistant-message').inputValue(), '')
    return action
  }
  const review = async (target: Page, action: AssistantTaskAction, index: number) => {
    const request = await waitFor(async () => {
      const requests = await target.evaluate(() => window.remember.getAgentInteractions())
      assert(requests.length <= 1)
      return requests[0] ?? null
    }, 'One actual native patch review must become available')
    assert.equal(request.turnId, action.messageId)
    assert.equal(request.workItemId, action.workItemId)
    const host = facts(manifest.slots[index])
    const pending = host.requests.filter((item) => item.status === 'pending')
    assert.equal(pending.length, 1)
    assert.equal(host.job?.phase, 'waiting')
    const payload = parse(pending[0].payload_json)
    assert.equal((payload.input as Row).action, 'patch')
    assert.equal((payload.input as Row).slug, manifest.source.slug)
    assert.equal((payload.input as Row).before, index === 0 ? setup.before : setup.after)
    assert.equal((payload.input as Row).after, index === 0 ? setup.after : setup.forbidden)
    assert(request.detail?.includes(manifest.source.slug))
    const accept = target.getByRole('button', { name: 'Bewaren', exact: true })
    await accept.waitFor({ state: 'visible' })
    await accept.focus()
    assert(await accept.evaluate((element) => document.activeElement === element))
    await target.setViewportSize({ width: 720, height: 900 })
    await target.screenshot({ path: join(directory, `shared-${index === 0 ? 'a' : 'b'}-review-720.png`) })
    return { request, host }
  }
  try {
    proof.hostsBefore = manifest.slots.map(facts)
    assert((proof.hostsBefore as HostFacts[]).every((host) => host.job === null))
    page = await start()
    const current = page
    const slug = manifest.source.slug,
      title = 'Shared agent disposable source'
    const content = `Private Task fixture ${setup.witness}.\n\n${setup.before}\n\nKeep this line.`
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
    const taskA = await current.evaluate(() =>
      window.remember.createWorkItem({
        title: 'Shared agent QA A',
        description: 'Keep this task open. Explicit fixture only.',
      })
    )
    const taskB = await current.evaluate(() =>
      window.remember.createWorkItem({
        title: 'Shared agent QA B',
        description: 'Keep this task open. Never apply B change.',
      })
    )
    const baseline = localState(profile)
    const captureBaseline = captureRows(profile)
    proof.baseline = baseline
    proof.captureBaseline = captureBaseline
    proof.seed = seed
    proof.tasks = [taskA, taskB]
    const actionA = await submit(current, taskA.id, 'A')
    assert.equal(
      localState(profile).assistant.assistant_task_run.find((row) => row.action_id === actionA.actionId)?.job_id,
      manifest.slots[0].jobId
    )
    const reviewA = await review(current, actionA, 0)
    proof.actionA = actionA
    proof.reviewA = reviewA
    save()

    await openTask(current, taskB.id)
    await current.locator('#assistant-message').fill('Draft only; do not start B.')
    assert(
      await current.getByRole('button', { name: /^(Versturen|Send)$/ }).isDisabled(),
      'A pending Task must disable B draft Send'
    )
    const draftState = localState(profile)
    assert.equal(draftState.assistant.assistant_task_run.length, 1)
    assert.equal(facts(manifest.slots[1]).job, null)
    const remove = current.getByRole('button', { name: /^(Taak uit concept verwijderen|Remove task from draft)$/ })
    await remove.focus()
    await remove.press('Enter')
    await current.waitForURL((url) => !url.searchParams.has('task'))
    assert.equal(await current.locator('#assistant-message').inputValue(), 'Draft only; do not start B.')
    assert.equal(facts(manifest.slots[1]).job, null)
    assert.deepEqual(localState(profile).assistant.assistant_task_run, draftState.assistant.assistant_task_run)
    proof.removedDraft = { taskId: taskB.id, textRetained: true, noBJob: true }

    await current.locator('#assistant-message').fill(question)
    await current.locator('#assistant-message').press('Enter')
    const chatState = await waitFor(async () => {
      const state = await current.evaluate(() => window.remember.getAssistantConversation())
      return !state.activeTurnId &&
        state.messages.some((message) => message.text === answer && message.status === 'completed')
        ? state
        : null
    }, 'Ordinary chat must answer while A review is still pending')
    assert.equal(chatState.activeTaskAction?.actionId, actionA.actionId)
    assert.equal(facts(manifest.slots[0]).job?.phase, 'waiting')
    assert.deepEqual(
      (await current.evaluate(() => window.remember.getAgentInteractions())).map((item) => item.id),
      [reviewA.request.id]
    )
    assert.equal(
      onePage(await current.evaluate(() => window.remember.listWikiPages('personal')), slug).revision,
      seed.revision
    )
    await current.screenshot({ path: join(directory, 'shared-a-review-and-chat-720.png') })
    proof.chatDuringA = chatState
    const accept = current.getByRole('button', { name: 'Bewaren', exact: true })
    await accept.focus()
    await accept.press('Enter')
    const completedA = await waitFor(async () => {
      const state = await current.evaluate(() => window.remember.getAssistantConversation())
      return actionOf(state, taskA.id)?.state === 'completed' ? state : null
    }, 'A must complete after one keyboard-reviewed save')
    const messageA = completedA.messages.find((message) => message.id === actionA.messageId)
    assert(messageA)
    assert(messageA.text.includes(setup.witness))
    assert.equal(messageA.results?.length, 1)
    const saved = onePage(await current.evaluate(() => window.remember.listWikiPages('personal')), slug)
    assert.equal(saved.content, content.replace(setup.before, setup.after))
    assert.notEqual(saved.revision, seed.revision)
    assert.equal(messageA.results?.[0].revision, saved.revision)
    const completeRows = localState(profile)
    assert.equal(completeRows.wiki.wiki_page_revision.length, baseline.wiki.wiki_page_revision.length + 1)
    assert.equal(completeRows.assistant.assistant_tool_call.length, 1)
    assert.equal(parse(completeRows.assistant.assistant_tool_call[0].result_json).revision, saved.revision)
    assert.deepEqual(completeRows.evidence.work_item, baseline.evidence.work_item)
    assert.equal(facts(manifest.slots[1]).job, null, 'Discarded B draft must not start when A completes')
    const href = `/wiki/page/?space=personal&slug=${encodeURIComponent(slug)}`
    const link = current
      .locator(`[data-assistant-message="${actionA.messageId}"]`)
      .getByRole('list', { name: /^(Opgeslagen pagina's|Saved pages)$/ })
      .getByRole('link')
    assert.equal(await link.count(), 1)
    assert.equal(await link.getAttribute('href'), href)
    await link.focus()
    await link.press('Enter')
    await current.waitForURL((url) => `${url.pathname}${url.search}` === href)
    const editor = current.getByRole('textbox', { name: /^(Pagina-inhoud|Page content)$/ })
    await editor.waitFor()
    assert((await editor.innerText()).includes(saved.content))
    await current.screenshot({ path: join(directory, 'shared-a-saved-page-720.png') })
    proof.completedA = { message: messageA, rows: completeRows, saved }
    await quit('after-a-quit')
    page = await start()
    const restarted = await page.evaluate(() => window.remember.getAssistantConversation())
    assert.deepEqual(
      durableMessage(restarted.messages.find((message) => message.id === actionA.messageId)),
      durableMessage(messageA)
    )
    assert.equal(facts(manifest.slots[0]).events.filter((event) => event.type === 'driver-invoked').length, 1)

    const second = page
    const actionB = await submit(second, taskB.id, 'B')
    assert.notEqual(actionB.actionId, actionA.actionId)
    assert.notEqual(actionB.messageId, actionA.messageId)
    assert.equal(
      localState(profile).assistant.assistant_task_run.find((row) => row.action_id === actionB.actionId)?.job_id,
      manifest.slots[1].jobId
    )
    const reviewB = await review(second, actionB, 1)
    proof.actionB = actionB
    proof.reviewB = reviewB
    save()
    await second.locator('#assistant-message').fill(heldQuestion)
    await second.locator('#assistant-message').press('Enter')
    await waitFor(
      async () => lines(join(manifest.root, 'chat.jsonl')).some((entry) => entry.kind === 'held') || null,
      'Held ordinary SDK turn must actually start'
    )
    const held = await second.evaluate(() => window.remember.getAssistantConversation())
    assert(held.activeTurnId)
    assert.equal(held.activeTaskAction?.actionId, actionB.actionId)
    const ordinaryStop = second.getByRole('button', { name: /^(Antwoord stoppen|Stop reply)$/ })
    await ordinaryStop.waitFor({ state: 'visible' })
    await ordinaryStop.focus()
    await second.screenshot({ path: join(directory, 'shared-b-review-chat-stop-720.png') })
    await ordinaryStop.press('Enter')
    await waitFor(
      async () => !(await second.evaluate(() => window.remember.getAssistantConversation())).activeTurnId || null,
      'Ordinary Stop must clear only the chat turn'
    )
    assert.equal(facts(manifest.slots[1]).job?.phase, 'waiting')
    assert.deepEqual(facts(manifest.slots[1]).requests, reviewB.host.requests)
    assert.deepEqual(
      (await second.evaluate(() => window.remember.getAgentInteractions())).map((item) => item.id),
      [reviewB.request.id]
    )
    const stoppedChat = await second.evaluate(() => window.remember.getAssistantConversation())
    assert.equal(stoppedChat.messages.find((message) => message.id === held.activeTurnId)?.status, 'cancelled')
    proof.ordinaryStop = { heldTurnId: held.activeTurnId, after: stoppedChat, host: facts(manifest.slots[1]) }
    const wrongStop = await second.evaluate(
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
    assert(wrongStop?.includes('host-task-message-mismatch'))
    const historical = second.locator(`[data-task-action="${actionA.actionId}"]`)
    assert.equal(await historical.getByRole('button').count(), 0)
    const taskStop = second
      .locator(`[data-task-action="${actionB.actionId}"]`)
      .getByRole('button', { name: /^(Stoppen|Stop)$/ })
    await taskStop.focus()
    await taskStop.press('Enter')
    await waitFor(
      async () =>
        actionOf(await second.evaluate(() => window.remember.getAssistantConversation()), taskB.id)?.state ===
          'stopped' || null,
      'Exact B Stop must become durable'
    )
    const stoppedHost = facts(manifest.slots[1])
    const stopProof = assertConfirmedTaskStop(reviewB.host, stoppedHost)
    const late = await second.evaluate(async (id) => {
      try {
        await window.remember.answerAgentInteraction({ id, action: 'accept', values: {} })
        return null
      } catch (error) {
        return String(error)
      }
    }, reviewB.request.id)
    assert(late?.includes('agent-request-expired'))
    const stoppedRows = localState(profile)
    const bClaim = stoppedRows.assistant.assistant_tool_call.find((row) => row.message_id === actionB.messageId)
    assert(bClaim)
    assert.equal(bClaim.result_json, null)
    assert.deepEqual(stoppedRows.wiki, completeRows.wiki)
    assert.deepEqual(stoppedRows.evidence.work_item, baseline.evidence.work_item)
    proof.stoppedB = { host: stoppedHost, stopProof, late, wrongStop, rows: stoppedRows }
    await quit('after-b-quit')
    page = await start()
    await page.setViewportSize({ width: 720, height: 900 })
    const final = await page.evaluate(() => window.remember.getAssistantConversation())
    assert.equal(final.activeTurnId, null)
    assert.equal(final.activeTaskAction, null)
    assert.equal(actionOf(final, taskB.id)?.state, 'stopped')
    assert.deepEqual(
      durableMessage(final.messages.find((message) => message.id === actionA.messageId)),
      durableMessage(messageA)
    )
    assert.deepEqual(localState(profile).evidence.work_item, baseline.evidence.work_item)
    assert.deepEqual(localState(profile).evidence.work_item_source, baseline.evidence.work_item_source)
    assert.deepEqual(localState(profile).wiki, completeRows.wiki)
    assert.deepEqual(captureRows(profile), captureBaseline, 'The fixture must not add audio or context evidence')
    assert.equal((await page.evaluate(() => window.remember.getAgentInteractions())).length, 0)
    const hosts = manifest.slots.map(facts)
    for (const [index, host] of hosts.entries()) {
      assert.equal(host.job?.id, manifest.slots[index].jobId)
      assert.equal(host.job?.phase, index === 0 ? 'completed' : 'stopped')
      assert.equal(host.events.filter((event) => event.type === 'driver-invoked').length, 1)
      assert.equal(host.events.filter((event) => event.type === 'job-submitted').length, 1)
      assert.equal(host.requests.length, 2)
      assert.equal(host.requests.filter((request) => request.status === 'resolved').length, index === 0 ? 2 : 1)
    }
    const chat = lines(join(manifest.root, 'chat.jsonl'))
    assert.equal(chat.filter((entry) => entry.kind === 'exec-start').length, 2)
    assert.equal(chat.filter((entry) => entry.kind === 'completed').length, 1)
    assert.equal(chat.filter((entry) => entry.kind === 'held').length, 1)
    await waitFor(
      async () =>
        lines(join(manifest.root, 'chat.jsonl')).filter((entry) => entry.kind === 'cancelled').length === 1 || null,
      'Held fixture must receive actual cancellation'
    )
    for (const entry of chat.filter((entry) => entry.kind === 'exec-start')) {
      const argv = entry.argv as string[]
      assert(argv.includes('read-only'))
      assert(argv.includes('--ephemeral'))
      assert(argv.includes('--ignore-user-config'))
      assert(argv.some((arg) => arg === 'features.shell_tool=false'))
      assert(argv.some((arg) => arg === 'features.unified_exec=false'))
      assert(argv.some((arg) => arg === 'web_search="disabled"'))
    }
    proof.final = final
    proof.finalHosts = hosts
    proof.chat = lines(join(manifest.root, 'chat.jsonl'))
    proof.provider = lines(join(manifest.root, 'provider.jsonl'))
    await page.screenshot({ path: join(directory, 'shared-final-history-720.png') })
    await quit('final-quit')
    const chatPids = [
      ...new Set(
        lines(join(manifest.root, 'chat.jsonl'))
          .filter((entry) => entry.kind === 'exec-start')
          .map((entry) => Number(entry.pid))
      ),
    ]
    for (const pid of chatPids)
      await waitFor(async () => gone(pid) || null, 'Own ordinary fixture process must exit', 10_000)
    proof.chatPids = chatPids.map((pid) => ({ pid, gone: gone(pid) }))
    proof.nativePids = nativePids
    proof.phase = 'complete'
    save()
    checks.push('Shared native chat answers during exact pending Task A review; discarded B draft has no effect')
    checks.push(
      'Actual keyboard-reviewed A Personal write/result persists over two native restarts with one provider invocation'
    )
    checks.push('Ordinary chat Stop preserves B review; exact B Stop rejects late approval before TTL with no B write')
    checks.push(
      'Two deterministic tools-disabled SDK invocations; complete human Task rows unchanged; no Mini/model/capture claim'
    )
  } catch (error) {
    proof.phase = 'failed'
    proof.error = error instanceof Error ? error.stack : String(error)
    proof.nativePids = nativePids
    if (page) {
      try {
        proof.failedState = await page.evaluate(() => window.remember.getAssistantConversation())
        await page.screenshot({ path: join(directory, 'shared-failed.png') })
      } catch {}
    }
    save()
    throw error
  } finally {
    if (getElectron()) await close()
    for (const name of ['provider.jsonl', 'chat.jsonl'])
      if (existsSync(join(manifest.root, name)))
        copyFileSync(join(manifest.root, name), join(directory, `shared-${name}`))
  }
}
