import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import type { AgentInteraction, WikiPage } from '@remember/shared'
import type { ElectronApplication, Page } from 'playwright-core'
import { initializeCodexServer } from '../../src/main/codexAppServer'
import { readRemoteThread, remoteTurns } from '../../src/main/codexRemoteRecovery'
import { connectCodexWebSocket } from '../../src/main/codexWebSocket'
import type { ResidentHostRun } from '../../src/main/residentAgentStore'
import { connectResidentHost } from '../../src/main/residentHostConnection'
import { agentConsentSwitch, capturePolicy } from './agentConsent'
import { qaSshTarget } from './remoteConfig'
import { ownedHostProxy } from './residentHostProxy'

export type HostReviewCase = 'revoke' | 'stale' | 'quit-pending' | 'expire'
type Options = {
  directory: string
  launch: () => Promise<Page>
  close: () => Promise<void>
  getElectron: () => ElectronApplication | undefined
  checks: string[]
  reviewCase?: HostReviewCase
}
type JsonObject = Record<string, unknown>
type HostRequest = {
  id: string
  session_id: string
  method: string
  status: string
  created_at: number
  updated_at: number
  payload: JsonObject
  result: unknown
}
type HostSnapshot = {
  now: number
  job: { id: string; phase: string; thread_id: string | null; turn_id: string | null } | null
  events: { seq: number; type: string; created_at: number; payload: JsonObject }[]
  requests: HostRequest[]
}
const exec = promisify(execFile)
const stopButton = /^(Stoppen|Stop)$/
const reviewForm = /^(Vraag van Codex|Question from Codex)$/

export function object(value: unknown): JsonObject {
  assert(value && typeof value === 'object' && !Array.isArray(value))
  return value as JsonObject
}

function quote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`
}

export async function hostSnapshot(workspace: string): Promise<HostSnapshot> {
  const script = `import json,sqlite3,sys,time
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
c.row_factory=sqlite3.Row
job=c.execute('SELECT id,phase,thread_id,turn_id FROM job').fetchone()
events=[dict(r) for r in c.execute('SELECT seq,type,created_at,payload_json FROM event ORDER BY seq')]
requests=[dict(r) for r in c.execute('SELECT id,session_id,method,status,created_at,updated_at,payload_json,result_json FROM server_request ORDER BY created_at,id')]
for r in events+requests:r['payload']=json.loads(r.pop('payload_json'))
for r in requests:r['result']=json.loads(r.pop('result_json') or 'null')
print(json.dumps({'now':int(time.time()*1000),'job':dict(job) if job else None,'events':events,'requests':requests}))
c.close()`
  const { stdout } = await exec(
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
      `python3 -c ${quote(script)} ${quote(join(dirname(workspace), 'job.sqlite'))}`,
    ],
    { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }
  )
  return JSON.parse(stdout)
}

export async function waitFor<T>(read: () => Promise<T | null | false>, label: string, timeout = 150_000): Promise<T> {
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
      .prepare(`SELECT p.head_revision_id,p.deleted_at,r.title,r.content,r.content_hash,
      (SELECT COUNT(*) FROM wiki_page_revision WHERE page_id=p.id) AS revision_count
      FROM wiki_page p JOIN wiki_page_revision r ON r.id=p.head_revision_id
      WHERE p.space_id='personal' AND p.slug=?`)
      .get(slug)
    assert(revision)
    return {
      revision: { ...revision },
      markdown: readFileSync(join(directory, 'profile/daily-review/wiki', `${slug}.md`), 'utf8'),
    }
  } finally {
    db.close()
  }
}

export function localAssistant(directory: string, messageId?: string) {
  const db = new DatabaseSync(join(directory, 'profile/daily-review/assistant/conversation.sqlite'), { readOnly: true })
  try {
    const row = messageId
      ? db.prepare('SELECT binding FROM assistant_host_run WHERE message_id=?').get(messageId)
      : null
    return {
      binding: row ? (JSON.parse(String(row.binding)) as ResidentHostRun) : null,
      message: messageId ? db.prepare('SELECT * FROM assistant_message WHERE id=?').get(messageId) : null,
      calls: db
        .prepare('SELECT id,request_hash,result_json,message_id,tool_name FROM assistant_tool_call ORDER BY id')
        .all()
        .map((row) => ({ ...row })),
    }
  } finally {
    db.close()
  }
}

export function onePage(pages: WikiPage[], slug: string) {
  const matches = pages.filter((page) => page.slug === slug)
  assert.equal(matches.length, 1)
  assert.equal(typeof matches[0].revision, 'string')
  return matches[0]
}

export function processGone(pid: number) {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
    throw error
  }
}

export async function providerTurns(threadId: string) {
  const server = await connectCodexWebSocket('ws://127.0.0.1:47832/', { onNotification() {}, onClose() {} })
  try {
    await initializeCodexServer(server, 'native-host-review-readback')
    return remoteTurns(await readRemoteThread(server, threadId))
  } finally {
    server.close()
  }
}

export function toolOutput(call: JsonObject) {
  assert(Array.isArray(call.contentItems))
  const text = call.contentItems.map(object).find((item) => item.type === 'inputText')?.text
  assert.equal(typeof text, 'string')
  return object(JSON.parse(String(text)))
}

export async function residentHostReviewQa({
  directory,
  launch,
  close,
  getElectron,
  checks,
  reviewCase: requestedCase,
}: Options) {
  const reviewCase = requestedCase ?? process.env.REMEMBER_QA_HOST_REVIEW_CASE
  assert(
    reviewCase && ['revoke', 'stale', 'quit-pending', 'expire'].includes(reviewCase),
    'Select one explicit host review case'
  )
  const workspace = process.env.REMEMBER_QA_HOST_WORKSPACE
  const target = process.env.REMEMBER_QA_HOST_JOB_ENDPOINT
  assert(workspace && /^\/private\/tmp\/remember-e09-[a-z0-9-]+\/workspace$/.test(workspace))
  assert(target && /^tcp:\/\/127\.0\.0\.1:\d+$/.test(target))
  const proxy = await ownedHostProxy(target)
  process.env.REMEMBER_QA_HOST_JOB_ENDPOINT = proxy.endpoint
  const proof: JsonObject = {
    reviewCase,
    workspace,
    target,
    startedAt: new Date().toISOString(),
    boundary:
      'One fresh explicit Mini job and isolated native Remember. Only one exact synthetic Personal-page read and one reviewed revision-bound patch are requested. No shell, other pages, model retry, audio, capture, production profile or Space/account revocation claim. Expiry uses the real five-minute host timer.',
  }
  const save = () =>
    writeFileSync(
      join(directory, 'resident-host-review-proof.json'),
      JSON.stringify({ ...proof, proxy: proxy.trace }, null, 2)
    )
  let page: Page | null = null
  let messageId: string | null = null
  let slug: string | null = null
  const restarts: JsonObject[] = []
  const screen = async (name: string) => {
    assert(page)
    const conversation = await page.evaluate(() => window.remember.getAssistantConversation())
    writeFileSync(
      join(directory, `resident-host-review-${name}.json`),
      JSON.stringify(
        {
          conversation,
          local: localAssistant(directory, messageId ?? undefined),
          wiki: slug ? localWiki(directory, slug) : null,
        },
        null,
        2
      )
    )
    await page.screenshot({ path: join(directory, `resident-host-review-${name}.png`) })
  }
  const state = async () => {
    assert(page)
    const conversation = await page.evaluate(() => window.remember.getAssistantConversation())
    assert.equal(conversation.hostJob?.messageId, messageId)
    assert.deepEqual(
      conversation.messages.find((message) => message.id === messageId)?.results,
      [],
      'No case may publish a saved-page result'
    )
    return conversation
  }
  const setConsentInUi = async (enabled: boolean, screenshot: string) => {
    assert(page)
    const origin = new URL(page.url()).origin
    await page.goto(`${origin}/agent/`)
    await page.setViewportSize({ width: 720, height: 800 })
    const toggle = page.getByRole('switch', { name: agentConsentSwitch })
    await toggle.waitFor({ state: 'visible' })
    await waitFor(() => toggle.isEnabled(), 'The explicit AI permission must be editable')
    assert.equal(await toggle.isChecked(), !enabled)
    await toggle.focus()
    assert(await toggle.evaluate((element) => document.activeElement === element))
    await page.keyboard.press('Space')
    await waitFor(async () => {
      assert(page)
      const settings = await page.evaluate(() => window.remember.getSettings())
      return settings.cloudAnalysisConsent === enabled && (await toggle.isChecked()) === enabled
    }, 'The consent control must reflect the confirmed settings value')
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await toggle.scrollIntoViewIfNeeded()
    await screen(screenshot)
    await page.goto(`${origin}/assistant/`)
    await page.locator('#assistant-message').waitFor({ state: 'visible' })
  }
  const quit = async (reason: string) => {
    const pid = getElectron()?.process().pid
    assert(pid)
    await close()
    page = null
    await waitFor(async () => processGone(pid), 'The real native main process must exit', 15_000)
    restarts.push({ reason, pid, exitedAt: new Date().toISOString() })
    proof.nativeQuits = restarts
    save()
    return pid
  }
  const reopen = async () => {
    page = await launch()
    page.setDefaultNavigationTimeout(120_000)
    await page.goto(`${new URL(page.url()).origin}/assistant/`)
    await page.locator('#assistant-message').waitFor()
    return state()
  }
  const rejectOldReview = async (request: AgentInteraction) => {
    assert(page)
    const error = await page.evaluate(async (id) => {
      try {
        await window.remember.answerAgentInteraction({ id, action: 'accept', values: {} })
        return null
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }, request.id)
    assert.match(error ?? '', /agent-request-expired/, 'An obsolete local approval must be rejected')
    proof.oldInteractionRejected = { id: request.id, error }
    save()
  }
  const stopIfActive = async () => {
    assert(page)
    const current = await state()
    if (!['completed', 'stopped'].includes(current.hostJob?.phase ?? '')) {
      const button = page.getByRole('button', { name: stopButton })
      await button.waitFor({ state: 'visible' })
      await waitFor(() => button.isEnabled(), 'Explicit Stop must remain usable')
      await button.focus()
      await button.press('Enter')
    }
    return waitFor(async () => {
      const current = await state()
      return ['completed', 'stopped'].includes(current.hostJob?.phase ?? '') && !current.activeTurnId ? current : null
    }, 'The owned job must reach an authoritative terminal state')
  }

  try {
    const fresh = await hostSnapshot(workspace)
    assert.equal(fresh.job, null, 'Each case requires its own empty Mini coordinator; never reuse a prior job')
    proof.freshHost = fresh
    save()
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
    const pausedCapturePolicy = capturePolicy(await page.evaluate(() => window.remember.getSettings()))
    const space = (await page.evaluate(() => window.remember.getWikiOverview())).spaces.find(
      (space) => space.id === 'personal'
    )
    assert(space)
    assert.equal(space.maintenanceMode, 'auto')
    const nonce = randomUUID()
    slug = `projects/resident-host-review-${reviewCase}-${nonce}`
    const title = `Native ${reviewCase} review QA ${nonce}`
    const before = `State: READY_${nonce}`
    const after = `State: UNAUTHORIZED_${nonce}`
    const witness = `PRIVATE_WITNESS_${randomUUID()}`
    const content = `Disposable review QA.\n\nRead witness: ${witness}\n\n${before}\n\nRetain this line: ${nonce}`
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
    let expectedWiki = initialWiki
    const baselineCalls = localAssistant(directory).calls
    const baseline = await page.evaluate(() => window.remember.getAssistantConversation())
    assert.equal(baseline.hostJob, undefined, 'Use a fresh isolated native profile')
    const summary = `Native ${reviewCase} review QA`
    const expectedPatch = {
      action: 'patch',
      spaceId: 'personal',
      slug,
      expectedRevision: seed.revision,
      before,
      after,
      summary,
    }
    const expectedDetail = `${space.name}\n${slug}\n\nRevision: ${seed.revision}\n\nReplace:\n${before}\n\nWith:\n${after}\n\nThis will be saved in this Space.`
    const instruction = `Use only remember_memory for this bounded review test. First read exactly page ${slug} in Personal (spaceId personal). Then request exactly one patch of that page using the revision returned by that read: replace exactly ${JSON.stringify(before)} with ${JSON.stringify(after)}; summary must be ${JSON.stringify(summary)}. Wait for Remember to present the exact change for review. After this one patch call returns, end the turn with a short outcome only; do not repeat page content or its Read witness. On any failure, conflict, unknown outcome, denial, cancellation or error, stop immediately without another tool call. Do not retry, search, list Spaces, read again, access other pages, use shell/browser/other tools or issue parallel calls.`
    await page.goto(`${new URL(page.url()).origin}/assistant/`)
    await page.locator('#assistant-message').fill(instruction)
    await page.locator('#assistant-message').press('Enter')
    const review = await waitFor(async () => {
      assert(page)
      const requests = await page.evaluate(() => window.remember.getAgentInteractions())
      assert(requests.length <= 1)
      const current = await page.evaluate(() => window.remember.getAssistantConversation())
      if (current.hostJob) messageId = current.hostJob.messageId
      if (!requests.length) {
        if (current.hostJob && ['completed', 'stopped'].includes(current.hostJob.phase)) {
          const reply = current.messages.find((message) => message.id === messageId)
          proof.endedBeforeReview = {
            hostJob: current.hostJob,
            reply,
            observedAt: new Date().toISOString(),
          }
          save()
          throw new Error(
            `Host job ended before the required memory-write review: phase=${current.hostJob.phase}; response=${JSON.stringify(reply?.text ?? '').slice(0, 3000)}`
          )
        }
        return null
      }
      assert(current.hostJob)
      assert.equal(requests[0].turnId, messageId)
      assert.equal(requests[0].title, 'Save knowledge in Remember')
      assert.equal(requests[0].detail, expectedDetail)
      assert.deepEqual(requests[0].fields, [])
      assert.equal(requests[0].url, undefined)
      assert.deepEqual(requests[0].actions, [
        { id: 'accept', label: 'Save' },
        { id: 'decline', label: 'Cancel' },
      ])
      return requests[0]
    }, 'Exactly one actual memory-write review must appear before any perturbation')
    assert(messageId)
    const user = (await state()).messages.find((message) => message.role === 'user' && message.text === instruction)
    assert(user)
    const binding = localAssistant(directory, messageId).binding
    assert(binding)
    const jobId = binding.jobId
    const claimed = localAssistant(directory).calls.filter((call) => !baselineCalls.some((old) => old.id === call.id))
    assert.equal(claimed.length, 1)
    assert.equal(claimed[0].message_id, messageId)
    assert.equal(claimed[0].tool_name, 'remember_memory')
    assert.equal(claimed[0].result_json, null)
    const writeId = String(claimed[0].id)
    assert.deepEqual(localWiki(directory, slug), initialWiki)
    const form = page.getByRole('form', { name: reviewForm })
    await form.waitFor({ state: 'visible' })
    assert.equal(await form.count(), 1)
    assert.equal(await form.locator('pre').textContent(), expectedDetail)
    await page.setViewportSize({ width: 720, height: 800 })
    await form.scrollIntoViewIfNeeded()
    await screen('pending')
    const pendingHost = await hostSnapshot(workspace)
    assert.equal(pendingHost.job?.id, jobId)
    assert.equal(pendingHost.job?.phase, 'waiting')
    const hostRequest = pendingHost.requests.find((request) => request.status === 'pending')
    assert(hostRequest)
    assert.equal(pendingHost.requests.filter((request) => request.status === 'pending').length, 1)
    assert.equal(hostRequest.method, 'client-tool')
    assert.equal(hostRequest.payload.tool, 'remember_memory')
    assert.deepEqual(hostRequest.payload.input, expectedPatch)
    assert.deepEqual(JSON.parse(writeId), [pendingHost.job.thread_id, hostRequest.payload.callId])
    const expiresAt = Number(hostRequest.payload.expiresAt)
    assert(expiresAt - hostRequest.created_at >= 299_900 && expiresAt - hostRequest.created_at <= 300_100)
    assert(expiresAt > pendingHost.now + 15_000, 'Review must have time remaining before the deliberate perturbation')
    proof.identity = {
      jobId,
      messageId,
      userId: user.id,
      threadId: pendingHost.job.thread_id,
      turnId: pendingHost.job.turn_id,
      slug,
      writeId,
    }
    proof.review = { interaction: review, hostRequest, claimed, expiresAt, observedAt: Date.now(), pendingHost }
    save()

    if (reviewCase === 'stale') {
      const humanContent = `${content}\n\nHuman edit retained: ${nonce}`
      const human = onePage(
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
          { slug, title, content: humanContent, revision: seed.revision }
        ),
        slug
      )
      assert.notEqual(human.revision, seed.revision)
      assert.equal(human.content, humanContent)
      expectedWiki = localWiki(directory, slug)
      assert.equal(Number(expectedWiki.revision.revision_count), Number(initialWiki.revision.revision_count) + 1)
      assert.deepEqual(
        await page.evaluate(() => window.remember.getAgentInteractions()),
        [review],
        'An ordinary human save must leave the old exact review pending'
      )
      await screen('human-edited')
      const accept = form.getByRole('button', { name: 'Save', exact: true })
      await accept.focus()
      assert(await accept.evaluate((element) => document.activeElement === element))
      await accept.press('Enter')
      const rejected = await waitFor(async () => {
        const call = localAssistant(directory).calls.find((call) => call.id === writeId)
        return call?.result_json ? object(JSON.parse(String(call.result_json))) : null
      }, 'The stale write must produce a durable revision-conflict receipt')
      assert.equal(rejected.saved, false)
      assert.equal(rejected.error, 'wiki-page-conflict')
      proof.stale = { humanRevision: human.revision, humanContent, receipt: rejected }
      await waitFor(async () => {
        const current = await state()
        return current.hostJob?.phase === 'completed' && !current.activeTurnId ? current : null
      }, 'The agent must finish after the rejected patch without retrying')
      await rejectOldReview(review)
    } else if (reviewCase === 'revoke') {
      proxy.block(true)
      await setConsentInUi(false, 'consent-disabled-settings-narrow')
      const revoked = await waitFor(async () => {
        assert(page && messageId)
        const current = await state()
        const persisted = localAssistant(directory, messageId).binding
        return persisted?.contextInvalidated &&
          persisted.stopRequested &&
          current.hostJob?.phase === 'recovery-required'
          ? current
          : null
      }, 'Disconnected consent revocation must persist invalidation and unconfirmed Stop')
      assert.equal((await page.evaluate(() => window.remember.getSettings())).cloudAnalysisConsent, false)
      assert.deepEqual(
        capturePolicy(await page.evaluate(() => window.remember.getSettings())),
        pausedCapturePolicy,
        'Revoking AI permission must not change capture pause settings'
      )
      assert.equal((await page.evaluate(() => window.remember.getAgentInteractions())).length, 0)
      await rejectOldReview(review)
      const privateBoundary = revoked.messages.find((message) => message.id === messageId)
      assert(privateBoundary)
      assert(!privateBoundary.text.includes(witness))
      await page
        .getByRole('status')
        .filter({ hasText: /^(Stoppen is nog niet bevestigd\.|Stopping has not been confirmed yet\.)$/ })
        .waitFor({ state: 'visible' })
      const recovery = page.getByRole('button', { name: /^(Status controleren|Check status)$/ })
      await waitFor(() => recovery.isEnabled(), 'Consent revocation must not disable existing host recovery')
      assert(await page.getByRole('button', { name: stopButton }).isEnabled())
      const revokedDraft = 'Keep this draft until I choose to allow AI again.'
      await page.locator('#assistant-message').fill(revokedDraft)
      assert(await page.locator('#assistant-message').isEditable())
      await page.locator('#assistant-message').press('Enter')
      assert.equal(await page.locator('#assistant-message').inputValue(), revokedDraft)
      assert.deepEqual(
        (await state()).messages.map((message) => message.id),
        revoked.messages.map((message) => message.id)
      )
      await screen('revoked-disconnected')
      await quit('revoked-while-disconnected')
      await reopen()
      await waitFor(
        async () => (await state()).hostJob?.phase === 'recovery-required',
        'Revoked Stop must remain unconfirmed after restart'
      )
      assert.equal(localAssistant(directory, messageId).binding?.contextInvalidated, true)
      assert.equal(localAssistant(directory, messageId).binding?.stopRequested, true)
      const restoredRecovery = page.getByRole('button', { name: /^(Status controleren|Check status)$/ })
      await waitFor(
        () => restoredRecovery.isEnabled(),
        'Recovery must remain usable with consent revoked after restart'
      )
      assert(await page.getByRole('button', { name: stopButton }).isEnabled())
      await page.locator('#assistant-message').fill(revokedDraft)
      await screen('revoked-after-restart')
      proxy.block(false)
      const terminal = await stopIfActive()
      const message = terminal.messages.find((message) => message.id === messageId)
      assert.equal(message?.text, privateBoundary.text, 'Revoked completion must not import a new private response')
      assert.deepEqual(message?.steps, privateBoundary.steps, 'Revoked recovery must not import new private steps')
      const send = page.getByRole('button', { name: /^(Versturen|Send)$/ })
      await send.waitFor({ state: 'visible' })
      assert(await send.isDisabled(), 'New messages must remain disabled after recovery while consent is revoked')
      assert(await page.locator('#assistant-message').isEditable())
      await page.locator('#assistant-message').press('Enter')
      await delay(250)
      assert.equal(await page.locator('#assistant-message').inputValue(), revokedDraft)
      assert.deepEqual(
        (await state()).messages.map((message) => message.id),
        terminal.messages.map((message) => message.id)
      )
      assert.equal(
        await page.getByRole('alert').filter({ hasText: /\S/ }).count(),
        0,
        'Enter must not attempt a blocked send'
      )
      assert.equal((await page.evaluate(() => window.remember.getSettings())).cloudAnalysisConsent, false)
      await screen('revoked-recovered')
      const revokedSettings = await page.evaluate(() => window.remember.getSettings())
      const origin = new URL(page.url()).origin
      await page.goto(`${origin}/agent/`)
      for (const provider of ['claude', 'codex'] as const) {
        const radio = page.locator(`input[name="agent-page-provider"][value="${provider}"]`)
        await radio.waitFor({ state: 'attached' })
        await waitFor(() => radio.isEnabled(), 'Provider preference must be editable without granting AI consent')
        await radio.focus()
        await radio.press('Space')
        await waitFor(async () => {
          assert(page)
          const settings = await page.evaluate(() => window.remember.getSettings())
          assert.equal(settings.cloudAnalysisConsent, false, 'Changing provider must not regrant AI consent')
          assert.equal(settings.cloudConsentNoticeSeen, revokedSettings.cloudConsentNoticeSeen)
          return settings.defaultAgentProvider === provider && settings.dayAnalysisProvider === provider
        }, 'The provider preference must save without an authentication or consent action')
        await waitFor(() => radio.isChecked(), 'Provider picker must reflect the saved preference')
      }
      await page.goto(`${origin}/assistant/`)
      await page.locator('#assistant-message').waitFor({ state: 'visible' })
      await page.locator('#assistant-message').fill(revokedDraft)
      await page.getByRole('button', { name: /^(Versturen|Send)$/ }).waitFor({ state: 'visible' })
      assert(await page.getByRole('button', { name: /^(Versturen|Send)$/ }).isDisabled())
      assert.deepEqual(
        (await state()).messages.map((message) => message.id),
        terminal.messages.map((message) => message.id)
      )
      await screen('revoked-provider-preserved')
      proof.revocation = {
        beforeRecovery: privateBoundary,
        terminal: message,
        settingsConsent: false,
        draftEditableAndRetained: true,
        recoveryControlsEnabledWithoutConsent: true,
        newSendDisabledWithoutConsent: true,
        providerChangesPreserveConsent: true,
        revokedThroughSettingsKeyboardAt720px: true,
      }
    } else {
      const closedAt = await hostSnapshot(workspace)
      const pid = await quit(`pending-${reviewCase}`)
      await delay(3000)
      assert(processGone(pid))
      assert.deepEqual(localWiki(directory, slug), initialWiki)
      assert.deepEqual(
        localAssistant(directory).calls.filter((call) => call.id === writeId),
        claimed
      )
      if (reviewCase === 'expire') {
        let away = await hostSnapshot(workspace)
        const deadline = Date.now() + Math.max(0, expiresAt - away.now) + 60_000
        while (away.job?.phase !== 'stopped') {
          assert(Date.now() < deadline, 'The real host deadline must stop the abandoned pending review')
          assert(processGone(pid), 'The app must remain fully absent throughout expiry')
          assert.deepEqual(localWiki(directory, slug), initialWiki)
          const pending: HostRequest | undefined = away.requests.find((request) => request.id === hostRequest.id)
          assert(pending)
          if (away.now < expiresAt) assert.equal(pending.status, 'pending')
          proof.expiryProgress = {
            hostNow: away.now,
            expiresAt,
            phase: away.job?.phase,
            requestStatus: pending.status,
            nativePidAbsent: true,
          }
          save()
          await delay(5000)
          away = await hostSnapshot(workspace)
        }
        assert(away.now >= expiresAt)
        assert.equal(away.requests.find((request) => request.id === hostRequest.id)?.status, 'expired')
        const expiry = away.events.find(
          (event) => event.type === 'review-expiry' && event.payload.id === hostRequest.id
        )
        assert(expiry)
        assert(expiry.created_at >= expiresAt)
        const connection = await connectResidentHost(target)
        try {
          await assert.rejects(
            connection.request('reply', {
              requestId: hostRequest.id,
              sessionId: hostRequest.session_id,
              result: { success: false, error: 'qa-expired-review-must-reject' },
            }),
            /review-expired/
          )
        } finally {
          connection.close()
        }
        proof.expiry = {
          closedAt,
          expired: away,
          lateHostReplyRejected: true,
          realTtlMs: expiresAt - hostRequest.created_at,
        }
      }
      await reopen()
      await rejectOldReview(review)
      if (reviewCase === 'quit-pending') {
        const replay = await waitFor(async () => {
          assert(page)
          assert.equal(
            (await page.evaluate(() => window.remember.getAgentInteractions())).length,
            0,
            'A claimed write must not be presented or executed again'
          )
          const current = await hostSnapshot(workspace)
          const request = current.requests.find((request) => request.id === hostRequest.id)
          return request?.status === 'resolved' ? { request, current } : null
        }, 'Reattaching the claimed call must return a conservative unknown outcome')
        assert.equal(object(replay.request.result).success, false)
        assert.match(String(object(replay.request.result).error), /memory-write-outcome-unknown-read-before-retrying/)
        assert.equal(localAssistant(directory).calls.find((call) => call.id === writeId)?.result_json, null)
        const threadId = pendingHost.job.thread_id
        assert(threadId)
        const delivered = await waitFor(async () => {
          const turns = await providerTurns(threadId)
          assert.equal(turns.length, 1)
          assert.equal(turns[0].id, pendingHost.job?.turn_id)
          assert(Array.isArray(turns[0].items))
          const call = turns[0].items.map(object).find((item) => item.id === hostRequest.payload.callId)
          return call?.success === false &&
            String(JSON.stringify(call.contentItems)).includes('memory-write-outcome-unknown-read-before-retrying')
            ? call
            : null
        }, 'The same provider call must receive the unknown outcome before explicit Stop')
        proof.quitPending = { closedAt, replay, delivered }
      }
      await stopIfActive()
    }

    assert(page)
    const terminal = await state()
    assert.equal((await page.evaluate(() => window.remember.getAgentInteractions())).length, 0)
    assert.equal(await page.getByRole('form', { name: reviewForm }).count(), 0)
    assert.equal(await page.getByRole('list', { name: /^(Opgeslagen pagina's|Saved pages)$/ }).count(), 0)
    assert.deepEqual(localWiki(directory, slug), expectedWiki)
    const finalCalls = localAssistant(directory).calls
    const writes = finalCalls.filter((call) => !baselineCalls.some((old) => old.id === call.id))
    assert.equal(writes.length, 1, 'No retry may create another write claim')
    assert.equal(writes[0].id, writeId)
    if (reviewCase !== 'stale')
      assert.equal(writes[0].result_json, null, 'An unapproved write remains conservatively uncommitted')
    assert.equal(terminal.messages.filter((message) => message.replyTo === user.id).length, 1)
    assert.equal(
      terminal.messages.filter((message) => message.role === 'user').length,
      baseline.messages.filter((message) => message.role === 'user').length + 1
    )
    const done = await hostSnapshot(workspace)
    assert.equal(done.job?.id, jobId)
    assert.equal(done.job?.thread_id, pendingHost.job.thread_id)
    assert.equal(done.job?.turn_id, pendingHost.job.turn_id)
    assert(['completed', 'stopped'].includes(done.job?.phase ?? ''))
    assert.equal(done.events.filter((event) => event.type === 'driver-invoked').length, 1)
    assert(done.requests.every((request) => request.method === 'client-tool'))
    assert.equal(done.requests.length, 2, 'Exactly one read and one patch; no additional tool or replay request')
    assert(done.job?.thread_id)
    const turns = await providerTurns(done.job.thread_id)
    assert.equal(turns.length, 1)
    assert.equal(turns[0].id, done.job.turn_id)
    assert(['completed', 'interrupted'].includes(String(turns[0].status)))
    assert(Array.isArray(turns[0].items))
    const items = turns[0].items.map(object)
    assert(
      !items.some((item) => ['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch'].includes(String(item.type))),
      'No unrelated tool may execute'
    )
    const calls = items.filter((item) => item.type === 'dynamicToolCall')
    assert.equal(calls.length, 2)
    assert(calls.every((call) => call.tool === 'remember_memory' && !call.namespace))
    const read = calls.find((call) => object(call.arguments).action === 'read')
    const patch = calls.find((call) => object(call.arguments).action === 'patch')
    assert(read && patch)
    assert.deepEqual(read.arguments, { action: 'read', spaceId: 'personal', slug })
    assert.deepEqual(patch.arguments, expectedPatch)
    assert.equal(read.success, true)
    assert.equal(read.status, 'completed')
    const readResult = toolOutput(read)
    assert.equal(readResult.revision, seed.revision)
    assert.equal(readResult.content, content)
    if (reviewCase === 'stale') {
      assert.equal(patch.success, true, 'A revision conflict is a returned tool outcome, never a saved result')
      assert.deepEqual(toolOutput(patch), { saved: false, error: 'wiki-page-conflict' })
    } else if (reviewCase === 'quit-pending') {
      assert.equal(patch.success, false)
      assert.match(JSON.stringify(patch.contentItems), /memory-write-outcome-unknown-read-before-retrying/)
    }
    await screen('terminal')
    proof.terminal = {
      host: done,
      conversation: terminal,
      local: localAssistant(directory, messageId),
      wiki: expectedWiki,
      turns,
    }
    save()
    await quit('terminal-persistence')
    const restarted = await reopen()
    assert.equal(restarted.hostJob?.phase, terminal.hostJob?.phase)
    assert.deepEqual(
      restarted.messages,
      terminal.messages,
      'Full restart must preserve the same failure outcome and message identity'
    )
    assert.equal(localAssistant(directory, messageId).binding?.jobId, jobId)
    assert.deepEqual(localAssistant(directory).calls, finalCalls)
    assert.deepEqual(localWiki(directory, slug), expectedWiki)
    await rejectOldReview(review)
    const afterRestart = await hostSnapshot(workspace)
    assert.equal(afterRestart.events.filter((event) => event.type === 'driver-invoked').length, 1)
    assert.equal(afterRestart.requests.length, 2)
    assert.deepEqual(
      (await providerTurns(done.job.thread_id)).map((turn) => ({ id: turn.id, status: turn.status })),
      turns.map((turn) => ({ id: turn.id, status: turn.status }))
    )
    assert.notEqual((await page.evaluate(() => window.remember.getState())).status, 'recording')
    if (reviewCase === 'revoke')
      assert.equal((await page.evaluate(() => window.remember.getSettings())).cloudAnalysisConsent, false)
    await screen('after-restart')
    proof.restart = {
      conversation: restarted,
      host: afterRestart,
      sameMessage: true,
      singleProviderTurn: true,
      noWrite: true,
    }
    save()
    if (reviewCase === 'revoke') {
      const stoppedBinding = localAssistant(directory, messageId).binding
      assert.equal(stoppedBinding?.phase, 'stopped')
      assert.equal(stoppedBinding?.contextInvalidated, true)
      await setConsentInUi(true, 'consent-restored-settings-narrow')
      await delay(1000)
      const regranted = await state()
      const restoredSettings = await page.evaluate(() => window.remember.getSettings())
      assert.equal(restoredSettings.cloudAnalysisConsent, true)
      assert.equal(restoredSettings.cloudConsentNoticeSeen, true)
      assert.deepEqual(capturePolicy(restoredSettings), pausedCapturePolicy)
      assert.equal(regranted.activeTurnId, null, 'Regranting permission must not revive the old job')
      assert.equal(regranted.hostJob?.phase, 'stopped')
      assert.deepEqual(regranted.messages, restarted.messages, 'Regranting must not import old private output')
      assert.equal(localAssistant(directory, messageId).binding?.contextInvalidated, true)
      assert.equal(localAssistant(directory, messageId).binding?.jobId, jobId)
      assert.deepEqual(localAssistant(directory).calls, finalCalls)
      assert.deepEqual(localWiki(directory, slug), expectedWiki)
      assert.equal((await page.evaluate(() => window.remember.getAgentInteractions())).length, 0)
      await rejectOldReview(review)
      await screen('consent-restored-old-job-stopped')
      await quit('consent-restored-persistence')
      const regrantedRestart = await reopen()
      assert.deepEqual(regrantedRestart.messages, regranted.messages)
      assert.equal(regrantedRestart.activeTurnId, null)
      assert.equal(regrantedRestart.hostJob?.phase, 'stopped')
      assert.equal(localAssistant(directory, messageId).binding?.contextInvalidated, true)
      assert.equal(localAssistant(directory, messageId).binding?.jobId, jobId)
      assert.deepEqual(localAssistant(directory).calls, finalCalls)
      assert.deepEqual(localWiki(directory, slug), expectedWiki)
      const settingsAfterRegrantRestart = await page.evaluate(() => window.remember.getSettings())
      assert.equal(settingsAfterRegrantRestart.cloudAnalysisConsent, true)
      assert.deepEqual(capturePolicy(settingsAfterRegrantRestart), pausedCapturePolicy)
      assert.notEqual((await page.evaluate(() => window.remember.getState())).status, 'recording')
      await rejectOldReview(review)
      const hostAfterRegrant = await hostSnapshot(workspace)
      assert.deepEqual(hostAfterRegrant.job, afterRestart.job)
      assert.deepEqual(hostAfterRegrant.requests, afterRestart.requests)
      assert.equal(hostAfterRegrant.events.filter((event) => event.type === 'driver-invoked').length, 1)
      assert.deepEqual(
        (await providerTurns(done.job.thread_id)).map((turn) => ({ id: turn.id, status: turn.status })),
        turns.map((turn) => ({ id: turn.id, status: turn.status }))
      )
      await screen('consent-restored-after-restart')
      proof.consentRecovery = {
        regrantedThroughSettingsKeyboardAt720px: true,
        priorRevokedRestartPreserved: true,
        oldJobStillInvalidatedAndStopped: true,
        oldApprovalRejectedAfterRegrant: true,
        sameProviderTurnAndRequests: true,
        captureUnchanged: pausedCapturePolicy,
        conversation: regrantedRestart,
        host: hostAfterRegrant,
        noWrite: true,
      }
    }
    proof.status = 'passed'
    proof.finishedAt = new Date().toISOString()
    save()
    checks.push(
      `Native host review ${reviewCase}: one real pending revision-bound Personal write, no unauthorized revision or saved result, exact one provider turn, rejected obsolete approval, durable identity and no replay after full restart`
    )
    if (reviewCase === 'revoke')
      checks.push(
        'Explicit Agent settings permission off/on by keyboard at 720px preserves capture pause and never revives the old invalidated job, review or write across another full restart'
      )
  } catch (error) {
    proof.status = 'failed'
    proof.error = error instanceof Error ? error.stack : String(error)
    proof.hostMayRequireExplicitStop = true
    try {
      proof.failureHost = await hostSnapshot(workspace)
    } catch (readError) {
      proof.hostReadError = String(readError)
    }
    try {
      if (messageId) proof.failureLocal = localAssistant(directory, messageId)
      if (slug) proof.failureWiki = localWiki(directory, slug)
    } catch (readError) {
      proof.localReadError = String(readError)
    }
    if (page && !page.isClosed()) await screen('failed').catch(() => {})
    save()
    throw error
  } finally {
    process.env.REMEMBER_QA_HOST_JOB_ENDPOINT = target
    await proxy.close()
  }
}
