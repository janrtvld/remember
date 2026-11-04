import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import type { AssistantConversation } from '@remember/shared'
import type { ElectronApplication, Page } from 'playwright-core'
import { initializeCodexServer } from '../../src/main/codexAppServer'
import { readRemoteThread, remoteTurns } from '../../src/main/codexRemoteRecovery'
import { connectCodexWebSocket } from '../../src/main/codexWebSocket'
import type { ResidentHostRun } from '../../src/main/residentAgentStore'
import { qaSshTarget } from './remoteConfig'
import { ownedHostProxy } from './residentHostProxy'

type Options = {
  directory: string
  launch: () => Promise<Page>
  close: () => Promise<void>
  getElectron: () => ElectronApplication | undefined
  checks: string[]
}
type HostState = {
  job: { id: string; phase: string; thread_id: string; turn_id: string }
  events: { seq: number; type: string; payload: Record<string, unknown> }[]
}
const exec = promisify(execFile)
const stopButton = /^(Stoppen|Stop)$/
const checkButton = /^(Status controleren|Check status)$/
const unconfirmedStop = /^(Stoppen is nog niet bevestigd\.|Stopping has not been confirmed yet\.)$/
function quote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`
}
async function remote(command: string) {
  return (
    await exec(
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
        command,
      ],
      { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }
    )
  ).stdout
}
async function remoteFile(workspace: string, name: string) {
  assert(['late.txt', 'deadline-ms', 'pulse', 'sentinel.txt'].includes(name))
  const file = quote(join(workspace, name))
  return remote(`if test -f ${file}; then cat ${file}; fi`)
}
async function waitFor<T>(read: () => Promise<T | false | null>, label: string, timeout = 120_000): Promise<T> {
  const end = Date.now() + timeout
  for (;;) {
    const value = await read()
    if (value !== false && value !== null) return value
    assert(Date.now() < end, label)
    await delay(250)
  }
}
function localBinding(directory: string, id: string) {
  const db = new DatabaseSync(join(directory, 'profile/daily-review/assistant/conversation.sqlite'), { readOnly: true })
  try {
    const row = db.prepare('SELECT binding FROM assistant_host_run WHERE message_id=?').get(id)
    assert(row)
    return JSON.parse(String(row.binding)) as ResidentHostRun
  } finally {
    db.close()
  }
}
async function hostState(root: string): Promise<HostState> {
  const script = `import sqlite3,json,sys\nc=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);c.row_factory=sqlite3.Row\nj=dict(c.execute('select id,phase,thread_id,turn_id from job').fetchone())\ne=[dict(r) for r in c.execute('select seq,type,payload_json from event order by seq')]\nfor r in e:r['payload']=json.loads(r.pop('payload_json'))\nprint(json.dumps({'job':j,'events':e}))\nc.close()`
  return JSON.parse(await remote(`python3 -c ${quote(script)} ${quote(join(root, 'job.sqlite'))}`))
}
function processGone(pid: number) {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
    throw error
  }
}

export async function residentHostFaultsQa({ directory, launch, close, getElectron, checks }: Options) {
  const workspace = process.env.REMEMBER_QA_HOST_WORKSPACE
  const target = process.env.REMEMBER_QA_HOST_JOB_ENDPOINT
  const source = process.env.REMEMBER_QA_HOST_SOURCE
  assert(workspace && /^\/private\/tmp\/remember-e08-[a-z0-9-]+\/workspace$/.test(workspace))
  assert(target && /^tcp:\/\/127\.0\.0\.1:\d+$/.test(target))
  assert(source && /^\/private\/tmp\/remember-e08-source-[a-z0-9-]+$/.test(source))
  const root = dirname(workspace)
  const proxy = await ownedHostProxy(target)
  process.env.REMEMBER_QA_HOST_JOB_ENDPOINT = proxy.endpoint
  const proof: Record<string, unknown> = {
    workspace,
    target,
    endpoint: proxy.endpoint,
    startedAt: new Date().toISOString(),
    boundary:
      'Real native app, isolated one-job Mini coordinator, synthetic late shell and independent sentinel. Submit/Stop ACK loss is injected only in the owned client proxy. No audio, capture, production settings, general daemon, privacy-revocation or memory-write claim.',
  }
  const save = () =>
    writeFileSync(
      join(directory, 'resident-host-faults-proof.json'),
      JSON.stringify({ ...proof, proxy: proxy.trace }, null, 2)
    )
  let page: Page | null = null
  let messageId: string | null = null
  async function state() {
    assert(page)
    assert.equal(
      (await page.evaluate(() => window.remember.getAgentInteractions())).length,
      0,
      'Never approve provider requests in this shell-only test'
    )
    return page.evaluate(() => window.remember.getAssistantConversation())
  }
  async function screen(name: string) {
    assert(page && messageId)
    const conversation = await state()
    writeFileSync(
      join(directory, `resident-host-${name}.json`),
      JSON.stringify({ conversation, binding: localBinding(directory, messageId) }, null, 2)
    )
    await page.screenshot({ path: join(directory, `resident-host-${name}.png`) })
  }
  async function assertStopRecoveryUi() {
    assert(page)
    const status = page.getByRole('status').filter({ hasText: unconfirmedStop })
    await status.waitFor({ state: 'visible' })
    await waitFor(async () => {
      assert(page)
      return (
        (await page.getByRole('button', { name: checkButton }).isEnabled()) &&
        (await page.getByRole('button', { name: stopButton }).isEnabled())
      )
    }, 'Both recovery actions must remain enabled after the failed Stop settles')
    assert.equal(
      await page.getByText(unconfirmedStop).count(),
      1,
      'Unconfirmed Stop needs exactly one recovery message'
    )
    assert.equal(
      await page.getByRole('alert').filter({ hasText: unconfirmedStop }).count(),
      0,
      'The host status must not be repeated as a composer error'
    )
    assert.equal(
      await page
        .getByRole('article', { name: /^(Antwoord van je agent|Your agent’s reply)$/ })
        .locator(status)
        .count(),
      1,
      'Stop recovery belongs to its durable assistant message'
    )
    assert(await page.getByRole('button', { name: checkButton }).isEnabled())
    assert(await page.getByRole('button', { name: stopButton }).isEnabled())
    assert.equal(await page.getByText(/^(Gestopt|Stopped)$/).count(), 0)
  }
  async function checkStatusWithKeyboard() {
    assert(page)
    const button = page.getByRole('button', { name: checkButton })
    await button.focus()
    assert(await button.evaluate((element) => document.activeElement === element))
    await button.press('Enter')
  }
  try {
    proxy.dropNextResponse('submit')
    page = await launch()
    page.setDefaultNavigationTimeout(120_000)
    await page.evaluate(
      (workspace) =>
        window.remember.updateSettings({
          agentComputer: { kind: 'remote', endpoint: 'ws://127.0.0.1:47832/', workspace },
          defaultAgentProvider: 'codex',
          codexAnalysisModel: 'gpt-6-astra',
          offlineMode: false,
          cloudAnalysisConsent: true,
          audioCaptureEnabled: false,
          capturePaused: true,
          capturePausedUntil: null,
          capturePauseSources: ['audio', 'capture'],
          liveTaskUpdates: false,
          frequentDayRefresh: false,
          agentLearningEnabled: false,
        }),
      workspace
    )
    await page.evaluate(() => window.remember.pauseCapture({ sources: ['audio', 'capture'], durationMs: null }))
    await page.goto(`${new URL(page.url()).origin}/assistant/`)
    const instruction =
      'Run exactly python3 late.py once in the current workspace. Wait for that same invocation to finish, polling its existing session only if needed. Do not repeat it, modify any files or scripts, or start any other command. This is an explicit silent native Stop test; after it finishes, reply with its actual output.'
    await page.locator('#assistant-message').fill(instruction)
    await page.locator('#assistant-message').press('Enter')
    const uncertain = await waitFor(async () => {
      const s = await state()
      return s.hostJob?.phase === 'starting' && s.hostJob.connection === 'disconnected' ? s : null
    }, 'An accepted submit with lost ACK must remain visibly unconfirmed')
    assert(uncertain.hostJob)
    messageId = uncertain.hostJob.messageId
    const identity = localBinding(directory, messageId)
    assert.equal(identity.jobId, messageId)
    await page
      .getByText(
        /^(Start nog niet bevestigd\. Er wordt niets opnieuw gestart\.|Start not yet confirmed\. Nothing is being started again\.)$/
      )
      .waitFor()
    const draft = 'Keep this draft while I check the existing job.'
    await page.locator('#assistant-message').fill(draft)
    await page.locator('#assistant-message').press('Enter')
    assert.equal((await state()).messages.length, 2, 'Uncertain state must block sending without losing the draft')
    assert.equal(await page.locator('#assistant-message').inputValue(), draft)
    await screen('start-unconfirmed')
    await page.getByRole('button', { name: checkButton }).click()
    await waitFor(
      async () => (await state()).hostJob?.connection === 'connected',
      'Status check must attach to the existing job'
    )
    await waitFor(
      async () => (await remoteFile(workspace, 'late.txt')) === 'START\n',
      'The Mini command must actually start'
    )
    const deadline = Number(await remoteFile(workspace, 'deadline-ms'))
    assert(deadline > Date.now() + 80_000, 'The Stop proof needs enough remaining time for native fault injection')
    proof.identity = identity
    proof.deadlineMs = deadline
    const sentinelScript = `import pathlib,time,sys\np=pathlib.Path(sys.argv[1]);deadline=int(p.joinpath('deadline-ms').read_text())\ntime.sleep(max(0,(deadline+2000-int(time.time()*1000))/1000))\np.joinpath('sentinel.txt').write_text('SENTINEL\\n')`
    const startSentinel = `import subprocess,pathlib,sys\np=pathlib.Path(sys.argv[1]);script=sys.argv[2]\nf=open(p/'sentinel.log','ab')\nc=subprocess.Popen(['python3','-c',script,str(p)],stdin=subprocess.DEVNULL,stdout=f,stderr=f,start_new_session=True)\n(p/'sentinel.pid').write_text(str(c.pid));print(c.pid)`
    proof.sentinelPid = Number(
      await remote(`python3 -c ${quote(startSentinel)} ${quote(workspace)} ${quote(sentinelScript)}`)
    )
    const app = getElectron()
    assert(app)
    const main = await app.browserWindow(page)
    const pulseBefore = Number(await remoteFile(workspace, 'pulse'))
    await main.evaluate((window) => window.close())
    assert.equal(await main.evaluate((window) => window.isVisible()), false)
    await delay(1500)
    const pulseAfter = Number(await remoteFile(workspace, 'pulse'))
    assert(pulseAfter > pulseBefore, 'The original command must keep working while the window is hidden')
    await main.evaluate((window) => {
      window.show()
      window.focus()
    })
    proof.hideOnly = { pulseBefore, pulseAfter, mainPid: app.process().pid }
    proxy.block(true)
    await waitFor(async () => (await state()).hostJob?.connection === 'disconnected', 'Disconnect must become visible')
    await page.setViewportSize({ width: 720, height: 800 })
    await page.getByRole('button', { name: stopButton }).click()
    await waitFor(async () => {
      const s = await state()
      return s.hostJob?.stopRequested &&
        s.hostJob.phase === 'recovery-required' &&
        s.hostJob.connection === 'disconnected'
        ? s
        : null
    }, 'Stop must remain unconfirmed while disconnected')
    await assertStopRecoveryUi()
    assert.equal(await page.locator('#assistant-message').inputValue(), draft)
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await screen('stop-unconfirmed')
    await page.reload()
    await page.locator('#assistant-message').waitFor()
    await assertStopRecoveryUi()
    await screen('stop-unconfirmed-reloaded')
    const pid = app.process().pid
    assert(pid)
    await close()
    page = null
    await waitFor(async () => processGone(pid), 'Native main PID must really exit', 15_000)
    proof.quit = { pid, exited: true }
    save()
    const crashScript = `import pathlib,subprocess,os,signal,time,sys,json\nr=pathlib.Path(sys.argv[1]);source=pathlib.Path(sys.argv[2]);pid=int((r/'coordinator.pid').read_text())\ncmd=subprocess.check_output(['ps','-p',str(pid),'-o','command='],text=True).strip()\nassert str(source/'coordinator.mjs')+' '+str(r)+' --native-client' in cmd\nos.kill(pid,signal.SIGKILL)\nfor _ in range(100):\n try:os.kill(pid,0)\n except ProcessLookupError:break\n time.sleep(.05)\nelse:raise Exception('coordinator-did-not-exit')\nsock=r/'client.sock'\nif sock.exists():sock.unlink()\nf=open(r/'coordinator.log','ab')\np=subprocess.Popen(['/opt/homebrew/bin/node',str(source/'coordinator.mjs'),str(r),'--native-client'],stdin=subprocess.DEVNULL,stdout=f,stderr=f,start_new_session=True)\n(r/'coordinator.pid').write_text(str(p.pid));print(json.dumps({'oldPid':pid,'newPid':p.pid,'oldExited':True}))`
    proof.coordinatorCrash = JSON.parse(
      await remote(`python3 -c ${quote(crashScript)} ${quote(root)} ${quote(source)}`)
    )
    const recovered = await waitFor(async () => {
      const s = await hostState(root)
      return s.job.phase === 'recovery-required' ? s : null
    }, 'Host crash must not replay the job')
    assert.equal(recovered.job.id, messageId)
    assert.equal(recovered.events.filter((e) => e.type === 'driver-invoked').length, 1)
    page = await launch()
    page.setDefaultNavigationTimeout(120_000)
    await page.goto(`${new URL(page.url()).origin}/assistant/`)
    await page.locator('#assistant-message').waitFor()
    await waitFor(async () => {
      const s = await state()
      return s.hostJob?.stopRequested && s.hostJob.connection === 'disconnected' ? s : null
    }, 'Stop intent must survive app restart')
    assert.equal((await state()).hostJob?.messageId, messageId)
    await assertStopRecoveryUi()
    const livePulseBefore = Number(await remoteFile(workspace, 'pulse'))
    await delay(1200)
    const livePulseAfter = Number(await remoteFile(workspace, 'pulse'))
    assert(
      livePulseAfter > livePulseBefore,
      'The owned command must still be live after coordinator crash and before Stop'
    )
    proof.beforeStopLiveness = { livePulseBefore, livePulseAfter, at: Date.now() }
    proxy.dropNextResponse('stop')
    proxy.block(false)
    await checkStatusWithKeyboard()
    await waitFor(
      async () => proxy.trace.some((e) => e.event === 'dropped-response' && e.op === 'stop'),
      'Observe actual successful Stop ACK before losing it'
    )
    await waitFor(async () => {
      const s = await state()
      return s.hostJob?.phase === 'recovery-required' && s.hostJob.connection === 'disconnected' ? s : null
    }, 'Lost Stop ACK cannot become false confirmed UI')
    await assertStopRecoveryUi()
    assert.equal((await hostState(root)).job.phase, 'stopped')
    await screen('stop-ack-lost')
    await checkStatusWithKeyboard()
    const stopped: AssistantConversation = await waitFor(async () => {
      const s = await state()
      return s.hostJob?.phase === 'stopped' ? s : null
    }, 'A current host receipt must confirm Stop')
    assert.equal(stopped.messages.find((m) => m.id === messageId)?.status, 'cancelled')
    assert.equal(stopped.messages.length, 2)
    await page.getByText(/^(Gestopt|Stopped)$/).waitFor()
    assert.equal(await page.getByRole('button', { name: stopButton }).count(), 0)
    await screen('stop-confirmed')
    const server = await connectCodexWebSocket('ws://127.0.0.1:47832/', { onNotification() {}, onClose() {} })
    try {
      await initializeCodexServer(server, 'native-host-fault-readback')
      const turns = remoteTurns(await readRemoteThread(server, recovered.job.thread_id))
      assert.equal(turns.length, 1)
      assert.equal(turns[0].id, recovered.job.turn_id)
      assert.notEqual(turns[0].status, 'inProgress')
      const items = turns[0].items as Array<Record<string, unknown>>
      const commands = items.filter((item) => item.type === 'commandExecution')
      assert(commands.every((item) => String(item.command).includes('python3 late.py')))
      assert.equal(commands.length, 1)
      assert.equal(commands[0].exitCode, -1)
      const terminals = await server.request('thread/backgroundTerminals/list', {
        threadId: recovered.job.thread_id,
        limit: 100,
      })
      assert(terminals && typeof terminals === 'object' && 'data' in terminals)
      assert.deepEqual(terminals.data, [])
      proof.remote = { turn: turns[0], terminals }
    } finally {
      server.close()
    }
    await close()
    page = null
    page = await launch()
    page.setDefaultNavigationTimeout(120_000)
    await page.goto(`${new URL(page.url()).origin}/assistant/`)
    await page.locator('#assistant-message').waitFor()
    assert.equal((await state()).hostJob?.phase, 'stopped')
    assert.equal((await state()).hostJob?.messageId, messageId)
    await page.getByText(/^(Gestopt|Stopped)$/).waitFor()
    assert.equal(await page.getByRole('button', { name: checkButton }).count(), 0)
    await screen('stopped-after-restart')
    save()
    await waitFor(
      async () => Date.now() > deadline + 5000 && (await remoteFile(workspace, 'sentinel.txt')) === 'SENTINEL\n',
      'Independent original deadline and sentinel must both pass',
      135_000
    )
    const late = await remoteFile(workspace, 'late.txt')
    assert.equal(late, 'START\n')
    const final = await hostState(root)
    assert.equal(final.job.phase, 'stopped')
    assert.equal(final.events.filter((e) => e.type === 'driver-invoked').length, 1)
    assert.equal(proxy.trace.filter((e) => e.event === 'request' && e.op === 'submit').length, 1)
    assert.equal(proxy.trace.filter((e) => e.event === 'dropped-response' && e.op === 'submit').length, 1)
    assert.equal(proxy.trace.filter((e) => e.event === 'dropped-response' && e.op === 'stop').length, 1)
    assert.notEqual((await page.evaluate(() => window.remember.getState())).status, 'recording')
    proof.lateReadback = { at: Date.now(), deadline, late, sentinel: await remoteFile(workspace, 'sentinel.txt') }
    proof.status = 'passed'
    proof.finishedAt = new Date().toISOString()
    save()
    checks.push(
      'One real native host job survives lost submit ACK and hide-only; durable Stop survives client loss, full app quit, coordinator SIGKILL/restart and lost successful Stop ACK; same message remains stopped after another restart, one providerturn/command, exact exit -1 and late independent SSH readback START only with sentinel alive'
    )
  } catch (error) {
    proof.status = 'failed'
    proof.error = error instanceof Error ? error.stack : String(error)
    proof.hostMayNeedExplicitStop = true
    if (page && !page.isClosed())
      await page.screenshot({ path: join(directory, 'resident-host-faults-failed.png') }).catch(() => {})
    save()
    throw error
  } finally {
    process.env.REMEMBER_QA_HOST_JOB_ENDPOINT = target
    await proxy.close()
  }
}
