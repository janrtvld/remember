import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AssistantConversation } from '@remember/shared'
import type { ElectronApplication, Page } from 'playwright-core'
import { ResidentAgentStore } from '../../src/main/residentAgentStore'
import { capturePolicy } from './agentConsent'
import { installHostFocusUiFixture, residentHostFocusUiQa } from './residentHostFocusUi'
import { processGone, waitFor } from './residentHostReview'
import { installReviewAckUiFixture, residentReviewAckUiQa } from './residentReviewAckUi'
import { installReviewActionsUiFixture, residentReviewActionsUiQa } from './residentReviewActionsUi'

type Options = {
  directory: string
  launch: () => Promise<Page>
  close: () => Promise<void>
  getElectron: () => ElectronApplication | undefined
  checks: string[]
}
type OverlayMetrics = { retryIds: string[]; cancelCount: number; sendCount: number; realRetryIds: string[] }
type Overlay = { show(): void; clear(): void; inspect(): OverlayMetrics }
type FixtureGlobal = typeof globalThis & { qaHostExpiryUi: Overlay }

/** Only the uncertain-status UI is synthetic. Terminal messages still use the real service and SQLite store. */
export function installHostExpiryUiFixture(directory: string) {
  assert.notEqual(
    resolve(directory),
    resolve(import.meta.dirname, '../..'),
    'The expiry overlay is only allowed in a disposable source copy'
  )
  const file = join(directory, 'src/main/residentAgentRuntime.ts')
  let source = readFileSync(file, 'utf8')
  const replace = (before: string, after: string) => {
    assert.equal(source.split(before).length, 2, `Expiry fixture needs one exact anchor: ${before}`)
    source = source.replace(before, after)
  }
  replace(
    '  ipcMain.handle(CHANNELS.getAssistantConversation,',
    `  let qaExpiryOverlay: ReturnType<typeof service.snapshot> | null = null
  const qaExpiryMetrics = { retryIds: [] as string[], cancelCount: 0, sendCount: 0, realRetryIds: [] as string[] }
  const qaExpiryChanged = () => {
    for (const window of BrowserWindow.getAllWindows())
      if (!window.isDestroyed()) window.webContents.send(CHANNELS.assistantChanged)
  }
  Object.assign(globalThis, { qaHostExpiryUi: {
    show() {
      const current = service.snapshot()
      const message = current.messages.at(-1)
      if (!message || message.role !== 'assistant') throw new Error('qa-expiry-message-missing')
      qaExpiryOverlay = {
        ...current, activeTurnId: message.id,
        messages: current.messages.map(item => item.id === message.id
          ? { ...item, status: 'interrupted' as const, error: null } : item),
        hostJob: { messageId: message.id, phase: 'recovery-required', connection: 'disconnected',
          stopRequested: true, stopReason: 'request-expired' },
      }
      qaExpiryChanged()
    },
    clear() { qaExpiryOverlay = null; qaExpiryChanged() },
    inspect() { return structuredClone(qaExpiryMetrics) },
  } })
  ipcMain.handle(CHANNELS.getAssistantConversation,`
  )
  replace(
    '    return service.snapshot(beforeMessageId)',
    '    return qaExpiryOverlay ?? service.snapshot(beforeMessageId)'
  )
  replace(
    '  ipcMain.handle(CHANNELS.sendAssistantMessage, (_event, input: unknown) => service.send(input))',
    `  ipcMain.handle(CHANNELS.sendAssistantMessage, () => {
    qaExpiryMetrics.sendCount += 1
    throw new Error('qa-expiry-unexpected-new-send')
  })`
  )
  replace(
    '    return service.retry(messageId)',
    `    if (qaExpiryOverlay) {
      if (messageId !== qaExpiryOverlay.hostJob?.messageId) throw new Error('qa-expiry-wrong-retry')
      qaExpiryMetrics.retryIds.push(messageId)
      return qaExpiryOverlay
    }
    qaExpiryMetrics.realRetryIds.push(messageId)
    return service.retry(messageId)`
  )
  replace(
    '  ipcMain.handle(CHANNELS.cancelAssistantTurn, () => service.cancel())',
    `  ipcMain.handle(CHANNELS.cancelAssistantTurn, () => {
    qaExpiryMetrics.cancelCount += 1
    if (qaExpiryOverlay) throw new Error('qa-expiry-stop-unconfirmed')
    throw new Error('qa-expiry-unexpected-stop')
  })`
  )
  writeFileSync(file, source)
  installHostFocusUiFixture(directory)
  installReviewActionsUiFixture(directory)
  installReviewAckUiFixture(directory)
}

function storedState(file: string) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return {
      messages: db.prepare('SELECT * FROM assistant_message ORDER BY sequence').all(),
      bindings: db.prepare('SELECT * FROM assistant_host_run ORDER BY rowid').all(),
      calls: db.prepare('SELECT * FROM assistant_tool_call ORDER BY id').all(),
      threads: db.prepare('SELECT * FROM assistant_thread ORDER BY provider').all(),
    }
  } finally {
    db.close()
  }
}

const expiredText = /^(Gestopt: wachttijd verlopen\.|Stopped: the wait timed out\.)$/
const uncertainText =
  /^(Wachttijd verlopen\. Stoppen is nog niet bevestigd\.|The wait timed out\. Stop is not yet confirmed\.)$/
const retryText = /^(Opnieuw proberen|Try again|Retry)$/
const replyName = /^(Antwoord van je agent|Your agent’s reply)$/

export async function residentHostExpiryUiQa({ directory, launch, close, getElectron, checks }: Options) {
  const file = join(directory, 'profile/daily-review/assistant/conversation.sqlite')
  const settingsFile = join(directory, 'profile/settings.json')
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'))
  writeFileSync(
    settingsFile,
    JSON.stringify({
      ...settings,
      offlineMode: false,
      cloudAnalysisConsent: true,
      audioCaptureEnabled: false,
      capturePaused: true,
      capturePausedUntil: null,
      capturePauseSources: ['audio', 'capture'],
      liveTaskUpdates: false,
      frequentDayRefresh: false,
      agentLearningEnabled: false,
    })
  )
  const connections: number[] = []
  const trap = createServer((socket) => {
    connections.push(Date.now())
    socket.destroy()
  })
  trap.listen(0, '127.0.0.1')
  await once(trap, 'listening')
  const address = trap.address()
  assert(address && typeof address !== 'string')
  const endpoint = `tcp://127.0.0.1:${address.port}`
  const originalEndpoint = process.env.REMEMBER_QA_HOST_JOB_ENDPOINT
  process.env.REMEMBER_QA_HOST_JOB_ENDPOINT = endpoint
  const proof: Record<string, unknown> = {
    boundary:
      'Deterministic native fixture, no provider, Mini, OAuth, audio or capture. Terminal and historical expiry use the real SQLite store and IPC across two full quits; an owned loopback trap must receive no connection. Unconfirmed expiry is a snapshot-only UI/IPC overlay with dispatch counters, not actual remote Stop proof. This is not a new five-minute timer measurement.',
    restarts: [],
  }
  const save = () =>
    writeFileSync(
      join(directory, 'resident-host-expiry-ui-proof.json'),
      JSON.stringify({ ...proof, connections }, null, 2)
    )
  const store = new ResidentAgentStore(file)
  assert.equal(store.conversation(null).messages.length, 0)
  const expired = store.start('Synthetic expired request; do not execute anything.', 'codex')
  const claimId = JSON.stringify(['qa-expiry-thread', 'qa-expiry-call'])
  store.claimToolCall(claimId, 'qa-expiry-claim', { messageId: expired.id, toolName: 'remember_memory' })
  store.persistHostRun(
    {
      jobId: expired.id,
      messageId: expired.id,
      endpoint,
      cursor: 41,
      phase: 'stopped',
      connection: 'disconnected',
      stopReason: 'request-expired',
    },
    {
      text: 'Synthetic earlier work remains visible.',
      steps: [],
      status: 'cancelled',
      error: null,
    }
  )
  assert.equal(
    store.get(expired.id)?.error,
    'assistant-host-request-expired',
    'The real store must derive the historical expiry marker from the typed terminal reason'
  )
  store.close()
  const baseline = storedState(file)
  proof.seed = { expiredId: expired.id, claimId, baseline }
  save()
  let page: Page | null = null
  let expected = baseline
  let expectedMessages: AssistantConversation['messages'] | null = null
  let pausePolicy: ReturnType<typeof capturePolicy> | null = null
  const metrics = async () => {
    const electron = getElectron()
    assert(electron)
    return electron.evaluate(() => (globalThis as FixtureGlobal).qaHostExpiryUi.inspect())
  }
  const quit = async (label: string) => {
    const pid = getElectron()?.process().pid
    assert(pid)
    await close()
    page = null
    await waitFor(async () => processGone(pid), 'The actual native process must exit', 15_000)
    ;(proof.restarts as unknown[]).push({ label, pid, exitedAt: Date.now() })
    assert.deepEqual(storedState(file), expected)
    assert.equal(connections.length, 0)
    save()
  }
  const inspect = async (label: string, historical = false) => {
    assert(page)
    page.setDefaultNavigationTimeout(120_000)
    await page.goto(`${new URL(page.url()).origin}/assistant/`)
    await page.locator('#assistant-message').waitFor()
    const current = await page.evaluate(() => window.remember.getAssistantConversation())
    if (expectedMessages) assert.deepEqual(current.messages, expectedMessages)
    else expectedMessages = current.messages
    assert.equal(current.activeTurnId, null)
    assert.equal(current.messages.find((message) => message.id === expired.id)?.error, 'assistant-host-request-expired')
    if (historical) {
      assert.notEqual(current.hostJob?.messageId, expired.id)
      assert.equal(current.hostJob?.stopReason, undefined)
    } else {
      assert.equal(current.hostJob?.messageId, expired.id)
      assert.equal(current.hostJob.stopReason, 'request-expired')
    }
    const article = page
      .getByRole('article', { name: replyName })
      .filter({ hasText: 'Synthetic earlier work remains visible.' })
    await article.getByText(expiredText).waitFor({ state: 'visible' })
    assert.equal(await page.getByText(expiredText).count(), 1)
    assert.equal(await article.getByRole('status').filter({ hasText: expiredText }).count(), 1)
    assert.equal(await article.getByRole('button', { name: retryText }).count(), 0)
    assert.equal(await page.getByRole('form', { name: /^(Vraag van Codex|Question from Codex)$/ }).count(), 0)
    assert.equal(await page.getByRole('button', { name: /^(Stop|Stoppen)$/ }).count(), 0)
    assert.equal(await page.getByRole('button', { name: /^(Status controleren|Check status)$/ }).count(), 0)
    assert.equal(await page.getByRole('list', { name: /^(Opgeslagen pagina's|Saved pages)$/ }).count(), 0)
    assert.equal((await page.evaluate(() => window.remember.getAgentInteractions())).length, 0)
    await page.screenshot({ path: join(directory, `expiry-${label}-standard.png`) })
    await page.setViewportSize({ width: 720, height: 800 })
    const composer = page.locator('#assistant-message')
    await composer.focus()
    await composer.press('Tab')
    await page.keyboard.press('Shift+Tab')
    assert(
      await composer.evaluate((element) => document.activeElement === element),
      'Keyboard must return to the composer'
    )
    const draft = `A new draft after ${label}; not submitted.`
    await composer.fill(draft)
    await composer.press('Shift+Enter')
    assert.equal(await composer.inputValue(), `${draft}\n`)
    assert(await composer.evaluate((element) => document.activeElement === element))
    assert(await composer.evaluate((element) => element.matches(':focus-visible')))
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.screenshot({ path: join(directory, `expiry-${label}-narrow.png`) })
    const lateReply = await page.evaluate(async () => {
      try {
        await window.remember.answerAgentInteraction({ id: 'qa-expired-review', action: 'accept', values: {} })
        return null
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    })
    assert.match(lateReply ?? '', /agent-request-expired/)
    if (!historical) {
      const retried = await page.evaluate((id) => window.remember.retryAssistantMessage(id), expired.id)
      assert.deepEqual(retried.messages, current.messages, 'Retrying the same terminal host message is a no-op')
    }
    const currentSettings = await page.evaluate(() => window.remember.getSettings())
    pausePolicy ??= capturePolicy(currentSettings)
    assert.deepEqual(capturePolicy(currentSettings), pausePolicy)
    assert.equal(currentSettings.audioCaptureEnabled, false)
    assert.notEqual((await page.evaluate(() => window.remember.getState())).status, 'recording')
    assert.deepEqual(storedState(file), expected)
    assert.equal(connections.length, 0, 'Neither startup nor retry may contact the host for a terminal job')
    assert.equal((await metrics()).sendCount, 0)
    proof[label] = {
      conversation: current,
      lateReply,
      metrics: await metrics(),
      keyboardDraft: await composer.inputValue(),
    }
    save()
  }
  try {
    page = await launch()
    await inspect('terminal')
    await quit('first')
    page = await launch()
    await inspect('restarted')
    await quit('second')
    const nextStore = new ResidentAgentStore(file)
    const next = nextStore.start('Synthetic later completed job; store fixture only.', 'codex')
    nextStore.persistHostRun(
      { jobId: next.id, messageId: next.id, endpoint, cursor: 1, phase: 'completed', connection: 'disconnected' },
      {
        text: 'Synthetic later result.',
        steps: [],
        status: 'completed',
      }
    )
    expectedMessages = nextStore.conversation(null).messages
    nextStore.close()
    expected = storedState(file)
    page = await launch()
    await inspect('historical', true)
    const electron = getElectron()
    assert(electron)
    await electron.evaluate(() => (globalThis as FixtureGlobal).qaHostExpiryUi.show())
    const article = page.getByRole('article', { name: replyName }).filter({ hasText: 'Synthetic later result.' })
    const status = article.getByText(uncertainText)
    await status.waitFor({ state: 'visible' })
    assert.equal(await article.getByText(expiredText).count(), 0, 'An unconfirmed Stop cannot look terminal')
    const check = article.getByRole('button', { name: /^(Status controleren|Check status)$/ })
    const stop = page.getByRole('button', { name: /^(Stop|Stoppen)$/ })
    assert((await check.isEnabled()) && (await stop.isEnabled()))
    assert.equal(await page.getByRole('button', { name: /^(Versturen|Send)$/ }).count(), 0)
    const composer = page.locator('#assistant-message')
    const draft = 'Keep this draft while the expired job status is uncertain.'
    await composer.fill(draft)
    await composer.press('Enter')
    assert.equal(await composer.inputValue(), draft)
    await check.focus()
    await check.press('Enter')
    await waitFor(
      async () => (await metrics()).retryIds.length === 1,
      'Check status must dispatch exactly one retry to this host message'
    )
    assert.equal(await composer.inputValue(), draft)
    await waitFor(() => stop.isEnabled(), 'The completed status check must leave Stop available')
    await stop.focus()
    await stop.press('Enter')
    await waitFor(async () => (await metrics()).cancelCount === 1, 'Stop must remain keyboard usable')
    await status.waitFor({ state: 'visible' })
    assert.equal(await article.getByText(uncertainText).count(), 1)
    assert.equal(await composer.inputValue(), draft)
    assert.equal(
      await page
        .getByRole('alert')
        .filter({ hasText: /^(Stoppen is nog niet bevestigd\.|Stopping has not been confirmed yet\.)$/ })
        .count(),
      0
    )
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.screenshot({ path: join(directory, 'expiry-unconfirmed-narrow.png') })
    const attempts = await metrics()
    assert.deepEqual(attempts.retryIds, [next.id])
    assert.equal(attempts.cancelCount, 1)
    assert.equal(attempts.sendCount, 0)
    assert.deepEqual(storedState(file), expected, 'Unconfirmed overlay never mutates the real terminal history')
    assert.equal(connections.length, 0)
    proof.unconfirmedFixture = { attempts, draftRetained: true, noNewSend: true, actualRemoteStop: false }
    await electron.evaluate(() => (globalThis as FixtureGlobal).qaHostExpiryUi.clear())
    await waitFor(async () => {
      assert(page)
      return (await page.evaluate(() => window.remember.getAssistantConversation())).activeTurnId === null
    }, 'Clearing only the overlay restores real persisted state')
    proof.expiryRegression = 'passed'
    checks.push(
      'Native expiry reason survives two full quits and a later stored job; same SQLite messages/NULL claim, no host connection or replay, one status at 720px and keyboard draft preserved'
    )
    checks.push(
      'Snapshot-only unconfirmed expiry keeps Check/Stop keyboard actions and draft, has no Send action, and never claims confirmed Stop or writes durable history'
    )
    proof.focus = await residentHostFocusUiQa(page, electron, directory)
    const focusMetrics = (proof.focus as { metrics?: { reviewAnswers?: number } }).metrics
    save()
    assert.deepEqual(storedState(file), expected, 'Focus fixtures may not write or replay persisted work')
    assert.equal(connections.length, 0)
    assert.equal((await metrics()).sendCount, 0)
    assert.equal(focusMetrics?.reviewAnswers, 0)
    assert.deepEqual(
      (proof.focus as { failures: string[] }).failures,
      [],
      'Native focus outcomes must satisfy the predeclared ownership policy; all cases are saved before this assertion'
    )
    proof.focusRegression = 'passed'
    checks.push(
      'Native held IPC and local review-abort focus measurements preserve keyboard continuity and respect intentional focus movement; Dutch narrow and English standard uncertainty are captured'
    )
    proof.reviewActions = await residentReviewActionsUiQa(page, electron, directory)
    save()
    assert.deepEqual(storedState(file), expected, 'Local review-answer fixtures may not write persisted assistant work')
    assert.equal(connections.length, 0)
    assert.equal((await metrics()).sendCount, 0)
    assert.deepEqual(
      (proof.reviewActions as { failures: string[] }).failures,
      [],
      'Native review-answer outcomes must satisfy the predeclared action, focus and single-dispatch contract'
    )
    checks.push(
      'Native review Save/Cancel pre-dispatch rejection preserves the exact request/values/draft; explicit identical retry resolves the real local ask once with no host or saved result'
    )
    proof.reviewActionsRegression = 'passed'
    proof.reviewAck = await residentReviewAckUiQa(page, electron, directory)
    save()
    assert.deepEqual(storedState(file), expected, 'Lost-ACK fixtures may not write persisted assistant work')
    assert.equal(connections.length, 0)
    assert.equal((await metrics()).sendCount, 0)
    assert.deepEqual(
      (proof.reviewAck as { failures: string[] }).failures,
      [],
      'An accepted local answer must not be offered again after its acknowledgement is lost'
    )
    proof.status = 'passed'
    checks.push(
      'Accepted local review answers are not replayed after lost IPC acknowledgement; notification loss and replacement request identities are measured separately'
    )
  } catch (error) {
    proof.status = 'failed'
    proof.error = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    save()
    await new Promise<void>((resolve) => trap.close(() => resolve()))
    if (originalEndpoint === undefined) delete process.env.REMEMBER_QA_HOST_JOB_ENDPOINT
    else process.env.REMEMBER_QA_HOST_JOB_ENDPOINT = originalEndpoint
  }
}
