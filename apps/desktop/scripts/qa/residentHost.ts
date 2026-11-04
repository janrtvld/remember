import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import type { AssistantConversation, WikiPage } from '@remember/shared'
import type { ElectronApplication, Page } from 'playwright-core'
import { initializeCodexServer } from '../../src/main/codexAppServer'
import { readRemoteThread, remoteTurns } from '../../src/main/codexRemoteRecovery'
import { connectCodexWebSocket } from '../../src/main/codexWebSocket'
import type { ResidentHostRun } from '../../src/main/residentAgentStore'
import { qaSshTarget } from './remoteConfig'

type Options = {
  directory: string
  launch: () => Promise<Page>
  close: () => Promise<void>
  getElectron: () => ElectronApplication | undefined
  checks: string[]
}
type JsonObject = Record<string, unknown>
type HostEvent = { seq: number; type: string; created_at: number; payload: JsonObject }
type HostSnapshot = {
  job: { id: string; phase: string; thread_id: string | null; turn_id: string | null } | null
  events: HostEvent[]
  requests: { id: string; session_id: string; method: string; status: string; payload: JsonObject }[]
}
const ssh = promisify(execFile)
const endpoint = 'ws://127.0.0.1:47832/'

function object(value: unknown): JsonObject {
  assert(value && typeof value === 'object' && !Array.isArray(value))
  return value as JsonObject
}

function quote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`
}

async function remote(command: string) {
  const { stdout } = await ssh(
    '/usr/bin/ssh',
    ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', qaSshTarget(), command],
    { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 }
  )
  return stdout
}

async function remoteFile(workspace: string, filename: 'a-started' | 'nonce.txt' | 'effects.jsonl') {
  const file = quote(join(workspace, filename))
  return remote(`if test -f ${file}; then cat ${file}; fi`)
}

async function hostSnapshot(workspace: string): Promise<HostSnapshot> {
  const script = `import json,sqlite3,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
c.row_factory=sqlite3.Row
job=c.execute('SELECT id,phase,thread_id,turn_id FROM job').fetchone()
events=[dict(r) for r in c.execute('SELECT seq,type,created_at,payload_json FROM event ORDER BY seq')]
requests=[dict(r) for r in c.execute("SELECT id,session_id,method,status,payload_json FROM server_request WHERE status='pending'")]
for r in events+requests:r['payload']=json.loads(r.pop('payload_json'))
print(json.dumps({'job':dict(job) if job else None,'events':events,'requests':requests}))
c.close()`
  return JSON.parse(await remote(`python3 -c ${quote(script)} ${quote(join(dirname(workspace), 'job.sqlite'))}`))
}

async function waitFor<T>(read: () => Promise<T | null | false>, label: string, timeout = 150_000): Promise<T> {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await read()
    if (value !== null && value !== false) return value
    assert(Date.now() < deadline, label)
    await delay(400)
  }
}

function localWiki(directory: string, slug: string) {
  const db = new DatabaseSync(join(directory, 'profile/daily-review/wiki.sqlite'), { readOnly: true })
  try {
    const revision = db
      .prepare(`SELECT p.head_revision_id, p.deleted_at, r.title, r.content, r.content_hash,
      (SELECT COUNT(*) FROM wiki_page_revision WHERE page_id=p.id) AS revision_count
      FROM wiki_page p JOIN wiki_page_revision r ON r.id=p.head_revision_id
      WHERE p.space_id='personal' AND p.slug=?`)
      .get(slug)
    assert(revision, 'The synthetic Personal page must exist in the real local Wiki database')
    return {
      revision: { ...revision },
      markdown: readFileSync(join(directory, 'profile/daily-review/wiki', `${slug}.md`), 'utf8'),
    }
  } finally {
    db.close()
  }
}

function localAssistant(directory: string, messageId?: string) {
  const db = new DatabaseSync(join(directory, 'profile/daily-review/assistant/conversation.sqlite'), { readOnly: true })
  try {
    const binding = messageId
      ? db.prepare('SELECT binding FROM assistant_host_run WHERE message_id=?').get(messageId)
      : null
    return {
      binding: binding ? (JSON.parse(String(binding.binding)) as ResidentHostRun) : null,
      memorySources: db
        .prepare('SELECT reference_json FROM assistant_memory_source ORDER BY space_id, slug')
        .all()
        .map((row) => object(JSON.parse(String(row.reference_json)))),
      calls: db
        .prepare('SELECT id, request_hash, result_json, message_id, tool_name FROM assistant_tool_call ORDER BY id')
        .all()
        .map((row) => ({ ...row })),
    }
  } finally {
    db.close()
  }
}

function onePage(pages: WikiPage[], slug: string) {
  const matches = pages.filter((page) => page.slug === slug)
  assert.equal(matches.length, 1)
  assert.equal(typeof matches[0].revision, 'string')
  return matches[0]
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

async function remoteTurnsFor(threadId: string) {
  const server = await connectCodexWebSocket(endpoint, { onNotification() {}, onClose() {} })
  try {
    await initializeCodexServer(server, 'native-host-qa-readback')
    return remoteTurns(await readRemoteThread(server, threadId))
  } finally {
    server.close()
  }
}

function toolOutput(call: JsonObject) {
  assert.equal(call.status, 'completed')
  assert.equal(call.success, true)
  assert(Array.isArray(call.contentItems))
  const text = call.contentItems.map(object).find((item) => item.type === 'inputText')?.text
  assert.equal(typeof text, 'string')
  return object(JSON.parse(String(text)))
}

async function openResult(page: Page, sourceUrl: string, title: string, content: string) {
  const result = page.getByRole('list', { name: /^(Opgeslagen pagina's|Saved pages)$/ }).getByRole('link')
  await result.waitFor({ state: 'visible' })
  assert.equal(await result.count(), 1)
  assert.equal(await result.getAttribute('href'), sourceUrl)
  assert((await result.innerText()).includes(title))
  await result.focus()
  assert(await result.evaluate((element) => document.activeElement === element))
  await result.press('Enter')
  await page.waitForURL((url) => `${url.pathname}${url.search}` === sourceUrl)
  const editor = page.getByRole('textbox', { name: /^(Pagina-inhoud|Page content)$/ })
  await editor.waitFor({ state: 'visible' })
  assert((await editor.innerText()).includes(content))
}

export async function residentHostQa({ directory, launch, close, getElectron, checks }: Options) {
  const workspace = process.env.REMEMBER_QA_HOST_WORKSPACE
  assert(
    workspace && /^\/private\/tmp\/remember-e0[67]-[a-z0-9-]+\/workspace$/.test(workspace),
    'An explicit owned temporary Mini workspace is required'
  )
  const proof: JsonObject = {
    startedAt: new Date().toISOString(),
    workspace,
    boundary:
      'Isolated native Remember and a real single-job Mini coordinator. Silent synthetic shell and one reviewed Personal-page write; no production profile, audio or capture. Native Stop, lost ACK, host crash, revocation and stale-review cases remain separate proof gaps.',
  }
  const save = () => writeFileSync(join(directory, 'resident-host-proof.json'), JSON.stringify(proof, null, 2))
  let page: Page | null = null
  try {
    page = await launch()
    page.setDefaultNavigationTimeout(120_000)
    await page.evaluate(
      (workspace) =>
        window.remember.updateSettings({
          agentComputer: { kind: 'remote', endpoint: 'ws://127.0.0.1:47832/', workspace },
          defaultAgentProvider: 'codex',
          interfaceLanguage: 'en',
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
    assert.notEqual((await page.evaluate(() => window.remember.getState())).status, 'recording')
    const space = (await page.evaluate(() => window.remember.getWikiOverview())).spaces.find(
      (space) => space.id === 'personal'
    )
    assert(space)
    assert.equal(space.maintenanceMode, 'auto')
    const suffix = Date.now().toString()
    const slug = `projects/resident-host-qa-${suffix}`
    const title = `Native host QA ${suffix}`
    const witness = `HOST_MEMORY_${randomUUID()}`
    const before = `State: READY_${suffix}`
    const after = `State: VERIFIED_${suffix}`
    const content = `Disposable host-job QA.\n\nRead witness: ${witness}\n\n${before}\n\nKeep this line unchanged: ${suffix}`
    const created = onePage(
      await page.evaluate(
        ({ slug, title }) => window.remember.createWikiPage({ spaceId: 'personal', category: 'projects', slug, title }),
        { slug, title }
      ),
      slug
    )
    const seed = onePage(
      await page.evaluate(
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
    assert.equal(seed.content, content)
    const initialWiki = localWiki(directory, slug)
    assert.equal(initialWiki.revision.head_revision_id, seed.revision)
    const baselineCalls = localAssistant(directory).calls
    const baseline = await page.evaluate(() => window.remember.getAssistantConversation())
    const sourceUrl = `/wiki/page/?space=personal&slug=${encodeURIComponent(slug)}`
    const summary = 'Native host reviewed memory QA'
    const expectedDetail = `${space.name}\n${slug}\n\nRevision: ${seed.revision}\n\nReplace:\n${before}\n\nWith:\n${after}\n\nThis will be saved in this Space.`
    const expectedPatch = {
      action: 'patch',
      spaceId: 'personal',
      slug,
      expectedRevision: seed.revision,
      before,
      after,
      summary,
    }
    const instruction = `Run exactly this silent, sequential native QA in the current workspace. Step 1: run python3 a.py once and wait for that same invocation to finish. It returns a random nonce. Step 2: in a NEW separate shell invocation run python3 b.py '<the literal nonce from step 1>'. Use the literal nonce, not a shell substitution; never combine steps or repeat either script. Step 3: use remember_memory to read exactly page ${slug} in Personal (spaceId personal). Patch that page once using the revision returned by the read: replace exactly ${JSON.stringify(before)} with ${JSON.stringify(after)}; summary must be ${JSON.stringify(summary)}. Let Remember present this exact change for review. Step 4: read the same page again with remember_memory. In your final answer give the nonce and the Read witness from that page, without a URL. Do not edit the scripts, use other tools, access other pages or run any additional commands. No parallel steps.`
    await page.goto(`${new URL(page.url()).origin}/assistant/`)
    await page.locator('#assistant-message').fill(instruction)
    await page.locator('#assistant-message').press('Enter')
    const started = await waitFor(async () => {
      assert(page)
      const requests = await page.evaluate(() => window.remember.getAgentInteractions())
      assert.equal(requests.length, 0, 'No provider approval is authorized before the memory step')
      const state = await page.evaluate(() => window.remember.getAssistantConversation())
      return state.hostJob && state.messages.some((message) => message.text === instruction) ? state : null
    }, 'The native composer must bind an actual host job')
    assert(started.hostJob)
    const messageId = started.hostJob.messageId
    const user = started.messages.find((message) => message.role === 'user' && message.text === instruction)
    assert(user)
    assert.equal(started.messages.find((message) => message.id === messageId)?.replyTo, user.id)
    const binding = localAssistant(directory, messageId).binding
    assert(binding)
    const jobId = binding.jobId
    proof.identity = { jobId, messageId, userId: user.id, slug, beforeRevision: seed.revision }
    save()
    await waitFor(
      async () => ((await remoteFile(workspace, 'a-started')).trim() ? true : null),
      'A must actually start on the Mini'
    )
    assert.equal(await remoteFile(workspace, 'effects.jsonl'), '', 'B cannot precede the explicit quit barrier')
    const beforeQuit = await hostSnapshot(workspace)
    assert.equal(beforeQuit.job?.id, jobId)
    assert.equal(beforeQuit.job?.phase, 'running')
    const quitCursor = beforeQuit.events.at(-1)?.seq ?? 0
    const electron = getElectron()
    assert(electron)
    const pid = electron.process().pid
    assert(pid)
    await page.screenshot({ path: join(directory, 'resident-host-before-quit.png') })
    await close()
    page = null
    await waitFor(async () => (processGone(pid) ? true : null), 'The real native main process must exit', 15_000)
    proof.nativeQuit = { pid, exitedAt: new Date().toISOString(), quitCursor }
    save()
    await delay(5500)
    assert(processGone(pid), 'Remember must remain closed at barrier release')
    await remote(
      `python3 -c ${quote("import pathlib,sys;pathlib.Path(sys.argv[1]).write_text('release')")} ${quote(join(workspace, 'release-a'))}`
    )
    const effects = await waitFor(
      async () => (await remoteFile(workspace, 'effects.jsonl')) || null,
      'A NEW shell B must execute while Remember is fully closed'
    )
    const nonce = (await remoteFile(workspace, 'nonce.txt')).trim()
    assert.match(nonce, /^[a-f0-9-]{36}$/i)
    assert.equal(effects, `B ${nonce}\n`)
    const waitingAway = await waitFor(async () => {
      const state = await hostSnapshot(workspace)
      assert.equal(state.job?.id, jobId)
      assert(
        state.requests.every((request) => request.method === 'client-tool'),
        'An unexpected provider approval cannot be auto-approved'
      )
      return state.requests.some((request) => request.payload.tool === 'remember_memory') ? state : null
    }, 'The host must wait on the real local memory client tool')
    for (const request of waitingAway.requests) {
      assert.equal(request.payload.tool, 'remember_memory')
      assert.equal(object(request.payload.input).action, 'read')
      assert.equal(object(request.payload.input).spaceId, 'personal')
      assert.equal(object(request.payload.input).slug, slug)
    }
    await delay(10_000)
    assert(processGone(pid), 'No native process may service the pending client tool')
    assert.deepEqual(
      localWiki(directory, slug),
      initialWiki,
      'The local page and revision must remain unchanged without a client'
    )
    assert.deepEqual(
      localAssistant(directory).calls,
      baselineCalls,
      'No local write receipt may appear while Remember is closed'
    )
    const away = await hostSnapshot(workspace)
    assert.equal(away.job?.phase, 'waiting')
    assert.equal(await remoteFile(workspace, 'effects.jsonl'), effects)
    const detach = away.events.find((event) => event.seq > quitCursor && event.type === 'client-detached')
    const b = away.events.find(
      (event) =>
        event.type === 'worker-report' &&
        event.payload.type === 'status' &&
        String(event.payload.text).includes('b.py') &&
        String(event.payload.text).includes(nonce)
    )
    assert(detach && b && detach.seq < b.seq)
    assert(Number(b.payload.monotonicMs) - Number(detach.payload.monotonicMs) >= 5000)
    proof.whileClosed = { nonce, effects, detach, b, requests: away.requests, localPageUnchanged: true }
    save()

    page = await launch()
    page.setDefaultNavigationTimeout(120_000)
    await page.goto(`${new URL(page.url()).origin}/assistant/`)
    await page.locator('#assistant-message').waitFor()
    const relaunched = await page.evaluate(() => window.remember.getAssistantConversation())
    assert.equal(relaunched.hostJob?.messageId, messageId)
    assert.equal(localAssistant(directory, messageId).binding?.jobId, jobId)
    assert.equal(relaunched.messages.filter((message) => message.replyTo === user.id).length, 1)
    const checkStatus = page.getByRole('button', { name: /^(Status controleren|Check status)$/ })
    if (relaunched.hostJob?.connection === 'disconnected') {
      await checkStatus.waitFor({ state: 'visible' })
      await checkStatus.click()
    }
    let approvedId: string | null = null
    let writeId: string | null = null
    const completed = await waitFor(async (): Promise<AssistantConversation | null> => {
      assert(page)
      const state = await page.evaluate(() => window.remember.getAssistantConversation())
      assert.equal(state.hostJob?.messageId, messageId, 'Reconnect must update the same assistant message')
      const requests = await page.evaluate(() => window.remember.getAgentInteractions())
      for (const request of requests) {
        if (request.id === approvedId) continue
        assert.equal(approvedId, null, 'Only one exact memory write may be approved')
        assert.equal(request.turnId, messageId)
        assert.equal(request.title, 'Save knowledge in Remember')
        assert.equal(request.detail, expectedDetail)
        assert.deepEqual(request.fields, [])
        assert.equal(request.url, undefined)
        assert.deepEqual(request.actions, [
          { id: 'accept', label: 'Save' },
          { id: 'decline', label: 'Cancel' },
        ])
        assert.deepEqual(localWiki(directory, slug), initialWiki, 'The exact preview must precede every write')
        const currentPage = onePage(await page.evaluate(() => window.remember.listWikiPages('personal')), slug)
        assert.equal(currentPage.content, content)
        assert.equal(currentPage.revision, seed.revision)
        const writes = localAssistant(directory).calls.filter(
          (call) => !baselineCalls.some((old) => old.id === call.id)
        )
        assert.equal(writes.length, 1)
        assert.equal(writes[0].message_id, messageId)
        assert.equal(writes[0].tool_name, 'remember_memory')
        assert.equal(writes[0].result_json, null)
        writeId = String(writes[0].id)
        const reviewedSource = localAssistant(directory).memorySources.find(
          (source) => source.spaceId === 'personal' && source.slug === slug
        )
        assert(reviewedSource, 'The actual read must register the exact page source before approval')
        assert.equal(reviewedSource.revision, seed.revision)
        proof.sourceBeforeApproval = reviewedSource
        const form = page.getByRole('form', { name: /^(Vraag van Codex|Question from Codex)$/ })
        await form.waitFor({ state: 'visible' })
        assert.equal(await form.count(), 1)
        assert.equal(await form.locator('pre').textContent(), expectedDetail)
        const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
        await page.screenshot({ path: join(directory, 'resident-host-review.png') })
        await page.setViewportSize({ width: 720, height: 800 })
        await form.scrollIntoViewIfNeeded()
        assert.equal(await page.locator('html').getAttribute('lang'), 'en')
        assert.equal(await form.locator('pre').textContent(), expectedDetail)
        assert(
          await form.locator('pre').evaluate((element) => element.scrollHeight <= element.clientHeight + 1),
          'The complete short review, including its save outcome, must be visible without an internal scroll'
        )
        assert.equal(await form.getByRole('region', { name: 'Request details' }).count(), 0)
        const keep = form.getByRole('button', { name: /^(Bewaren|Save|Keep)$/ })
        await keep.focus()
        assert(await keep.evaluate((element) => document.activeElement === element))
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        await page.screenshot({ path: join(directory, 'resident-host-review-narrow.png') })
        await keep.press('Enter')
        approvedId = request.id
        proof.approval = { id: approvedId, writeId, detail: request.detail }
        save()
        await page.setViewportSize(viewport)
      }
      if (state.hostJob?.phase !== 'completed') {
        assert.notEqual(state.hostJob?.phase, 'stopped', 'This scenario must complete, not stop')
        assert.notEqual(state.hostJob?.phase, 'recovery-required', 'Unexpected host recovery needs investigation')
        return null
      }
      assert.equal(approvedId !== null, true)
      assert.equal(state.activeTurnId, null)
      const message = state.messages.find((message) => message.id === messageId)
      assert.equal(message?.status, 'completed')
      assert(message.text.includes(nonce) && message.text.includes(witness))
      return state
    }, 'The same host job must complete after one native memory approval')
    const saved = onePage(await page.evaluate(() => window.remember.listWikiPages('personal')), slug)
    const expectedContent = content.replace(before, after)
    assert.equal(saved.content, expectedContent)
    assert.notEqual(saved.revision, seed.revision)
    const writes = localAssistant(directory).calls.filter((call) => !baselineCalls.some((old) => old.id === call.id))
    assert.equal(writes.length, 1)
    assert.equal(writes[0].id, writeId)
    const receipt = object(JSON.parse(String(writes[0].result_json)))
    assert.equal(receipt.saved, true)
    assert.equal(receipt.proposed, false)
    assert.equal(receipt.revision, saved.revision)
    const savedSources = localAssistant(directory).memorySources
    const savedSource = savedSources.find((source) => source.spaceId === 'personal' && source.slug === slug)
    assert.deepEqual(savedSource, { ...object(proof.sourceBeforeApproval), revision: saved.revision })
    assert.notEqual(localAssistant(directory, messageId).binding?.contextInvalidated, true)
    proof.sourceAfterWrite = savedSource
    const result = { id: writeId, kind: 'saved-page', spaceId: 'personal', slug, revision: saved.revision, title }
    assert.deepEqual(completed.messages.find((message) => message.id === messageId)?.results, [result])
    assert.equal(
      completed.messages.filter((message) => message.role === 'user').length,
      baseline.messages.filter((message) => message.role === 'user').length + 1
    )
    assert.equal(completed.messages.filter((message) => message.replyTo === user.id).length, 1)
    const hostDone = await hostSnapshot(workspace)
    assert.equal(hostDone.job?.id, jobId)
    assert.equal(hostDone.job?.phase, 'completed')
    assert.equal(hostDone.events.filter((event) => event.type === 'driver-invoked').length, 1)
    assert.equal(hostDone.events.filter((event) => event.type === 'result-persisted').length, 1)
    const threadId = hostDone.job.thread_id
    assert(threadId)
    const turns = await remoteTurnsFor(threadId)
    assert.equal(turns.length, 1)
    assert.equal(turns[0].id, hostDone.job.turn_id)
    assert.equal(turns[0].status, 'completed')
    assert(Array.isArray(turns[0].items))
    const calls = turns[0].items.map(object).filter((item) => item.type === 'dynamicToolCall')
    assert(calls.every((call) => call.tool === 'remember_memory' && !call.namespace))
    const successfulPatches = calls.filter(
      (call) => object(call.arguments).action === 'patch' && call.status === 'completed' && call.success === true
    )
    assert.equal(successfulPatches.length, 1)
    assert.deepEqual(object(successfulPatches[0].arguments), expectedPatch)
    const reads = calls
      .filter(
        (call) => object(call.arguments).action === 'read' && call.status === 'completed' && call.success === true
      )
      .map(toolOutput)
    assert(reads.some((read) => read.slug === slug && read.revision === seed.revision && read.content === content))
    assert(
      reads.some((read) => read.slug === slug && read.revision === saved.revision && read.content === expectedContent)
    )
    assert.equal(await remoteFile(workspace, 'effects.jsonl'), effects)
    await page.screenshot({ path: join(directory, 'resident-host-completed.png') })
    await openResult(page, sourceUrl, title, after)
    await page.screenshot({ path: join(directory, 'resident-host-saved-page.png') })
    const savedStorage = localWiki(directory, slug)
    const toolStorage = localAssistant(directory).calls
    const secondPid = getElectron()?.process().pid
    assert(secondPid)
    await close()
    page = null
    await waitFor(
      async () => (processGone(secondPid) ? true : null),
      'The second native process must fully exit',
      15_000
    )
    page = await launch()
    page.setDefaultNavigationTimeout(120_000)
    await page.goto(`${new URL(page.url()).origin}/assistant/`)
    await page.locator('#assistant-message').waitFor()
    const restarted = await page.evaluate(() => window.remember.getAssistantConversation())
    assert.equal(restarted.hostJob?.messageId, messageId)
    assert.equal(restarted.hostJob?.phase, 'completed')
    assert.deepEqual(
      restarted.messages.map((message) => message.id),
      completed.messages.map((message) => message.id)
    )
    assert.deepEqual(restarted.messages.find((message) => message.id === messageId)?.results, [result])
    assert.equal(localAssistant(directory, messageId).binding?.jobId, jobId)
    assert.deepEqual(localAssistant(directory).calls, toolStorage)
    assert.deepEqual(localAssistant(directory).memorySources, savedSources)
    assert.notEqual(localAssistant(directory, messageId).binding?.contextInvalidated, true)
    assert.deepEqual(localWiki(directory, slug), savedStorage)
    assert.equal(
      onePage(await page.evaluate(() => window.remember.listWikiPages('personal')), slug).revision,
      saved.revision
    )
    assert.equal(await remoteFile(workspace, 'effects.jsonl'), effects)
    assert.deepEqual(
      (await remoteTurnsFor(threadId)).map((turn) => ({ id: turn.id, status: turn.status })),
      [{ id: hostDone.job.turn_id, status: 'completed' }]
    )
    const afterRestart = await hostSnapshot(workspace)
    assert.equal(afterRestart.events.filter((event) => event.type === 'driver-invoked').length, 1)
    assert.equal(afterRestart.events.filter((event) => event.type === 'result-persisted').length, 1)
    await page.setViewportSize({ width: 720, height: 800 })
    const resultList = page.getByRole('list', { name: /^(Opgeslagen pagina's|Saved pages)$/ })
    await resultList.scrollIntoViewIfNeeded()
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.screenshot({ path: join(directory, 'resident-host-after-restart-narrow.png') })
    await openResult(page, sourceUrl, title, after)
    await page.screenshot({ path: join(directory, 'resident-host-page-after-restart.png') })
    assert.deepEqual(
      localAssistant(directory).calls,
      toolStorage,
      'Opening the durable result must not replay its write'
    )
    assert.notEqual((await page.evaluate(() => window.remember.getState())).status, 'recording')
    proof.status = 'passed'
    proof.finishedAt = new Date().toISOString()
    proof.completion = {
      threadId,
      turnId: hostDone.job.turn_id,
      result,
      writes,
      remoteCalls: calls,
      messageIds: restarted.messages.map((message) => message.id),
      effects,
    }
    proof.nativeRestarts = {
      afterQuit: true,
      afterCompletion: true,
      sameJob: true,
      sameMessage: true,
      singleProviderTurn: true,
      savedResultOpenedTwice: true,
    }
    save()
    checks.push(
      'Full native Remember quit leaves one Mini host job running: a new nonce-bound shell step executes with the PID absent; a local memory tool waits, one exact native review saves the Personal page, and two launches retain the same job/message/result without a second shell effect or provider turn'
    )
  } catch (error) {
    proof.status = 'failed'
    proof.error = error instanceof Error ? error.stack : String(error)
    proof.hostMayRequireExplicitStop = true
    if (page && !page.isClosed())
      await page.screenshot({ path: join(directory, 'resident-host-failed.png') }).catch(() => {})
    save()
    throw error
  }
}
