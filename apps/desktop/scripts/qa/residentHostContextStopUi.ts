import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AssistantConversation } from '@remember/shared'
import type { ElectronApplication, Locator, Page } from 'playwright-core'
import { ResidentAgentStore } from '../../src/main/residentAgentStore'
import { capturePolicy } from './agentConsent'
import { processGone, waitFor } from './residentHostReview'

type Options = {
  directory: string
  launch: () => Promise<Page>
  close: () => Promise<void>
  getElectron: () => ElectronApplication | undefined
  checks: string[]
}
type Metrics = { retryIds: string[]; cancelCount: number; sendCount: number; realRetryIds: string[] }
type FixtureGlobal = typeof globalThis & {
  qaHostContextStopUi: { show(): void; clear(): void; inspect(): Metrics }
}

/** Confirmed history uses the real store. Only uncertain Stop is a renderer-facing IPC fixture. */
export function installHostContextStopUiFixture(directory: string) {
  assert.notEqual(resolve(directory), resolve(import.meta.dirname, '../..'))
  const file = join(directory, 'src/main/residentAgentRuntime.ts')
  let source = readFileSync(file, 'utf8')
  const replace = (before: string, after: string) => {
    assert.equal(source.split(before).length, 2, `Context Stop fixture needs one exact anchor: ${before}`)
    source = source.replace(before, after)
  }
  replace(
    '  ipcMain.handle(CHANNELS.getAssistantConversation,',
    `  let qaContextStopOverlay: ReturnType<typeof service.snapshot> | null = null
  const qaContextStopMetrics = { retryIds: [] as string[], cancelCount: 0, sendCount: 0, realRetryIds: [] as string[] }
  const qaContextStopChanged = () => {
    for (const window of BrowserWindow.getAllWindows())
      if (!window.isDestroyed()) window.webContents.send(CHANNELS.assistantChanged)
  }
  Object.assign(globalThis, { qaHostContextStopUi: {
    show() {
      const current = service.snapshot()
      const message = current.messages.at(-1)
      if (!message || message.role !== 'assistant') throw new Error('qa-context-stop-message-missing')
      qaContextStopOverlay = {
        ...current, activeTurnId: message.id,
        messages: current.messages.map(item => item.id === message.id
          ? { ...item, status: 'interrupted' as const, error: null } : item),
        hostJob: { messageId: message.id, phase: 'recovery-required', connection: 'disconnected',
          stopRequested: true, stopReason: 'context-invalidated' },
      }
      qaContextStopChanged()
    },
    clear() { qaContextStopOverlay = null; qaContextStopChanged() },
    inspect() { return structuredClone(qaContextStopMetrics) },
  } })
  ipcMain.handle(CHANNELS.getAssistantConversation,`
  )
  replace(
    '    return service.snapshot(beforeMessageId)',
    '    return qaContextStopOverlay ?? service.snapshot(beforeMessageId)'
  )
  replace(
    '  ipcMain.handle(CHANNELS.sendAssistantMessage, (_event, input: unknown) => service.send(input))',
    `  ipcMain.handle(CHANNELS.sendAssistantMessage, () => {
    qaContextStopMetrics.sendCount += 1
    throw new Error('qa-context-stop-unexpected-send')
  })`
  )
  replace(
    '    return service.retry(messageId)',
    `    if (qaContextStopOverlay) {
      if (messageId !== qaContextStopOverlay.hostJob?.messageId) throw new Error('qa-context-stop-wrong-retry')
      qaContextStopMetrics.retryIds.push(messageId)
      return qaContextStopOverlay
    }
    qaContextStopMetrics.realRetryIds.push(messageId)
    return service.retry(messageId)`
  )
  replace(
    '  ipcMain.handle(CHANNELS.cancelAssistantTurn, () => service.cancel())',
    `  ipcMain.handle(CHANNELS.cancelAssistantTurn, () => {
    qaContextStopMetrics.cancelCount += 1
    throw new Error(qaContextStopOverlay ? 'assistant-host-stop-unconfirmed' : 'qa-context-stop-unexpected-cancel')
  })`
  )
  writeFileSync(file, source)
}

function storedState(file: string) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return {
      messages: db.prepare('SELECT * FROM assistant_message ORDER BY sequence').all(),
      bindings: db.prepare('SELECT * FROM assistant_host_run ORDER BY rowid').all(),
      calls: db.prepare('SELECT * FROM assistant_tool_call ORDER BY id').all(),
      threads: db.prepare('SELECT * FROM assistant_thread ORDER BY provider').all(),
      sources: db.prepare('SELECT * FROM assistant_memory_source ORDER BY space_id,slug').all(),
    }
  } finally {
    db.close()
  }
}

async function visibility(locator: Locator) {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    let top = 0
    let bottom = innerHeight
    let left = 0
    let right = innerWidth
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const css = getComputedStyle(parent)
      const bounds = parent.getBoundingClientRect()
      if (/(auto|scroll|hidden|clip)/.test(css.overflowY)) {
        top = Math.max(top, bounds.top)
        bottom = Math.min(bottom, bounds.bottom)
      }
      if (/(auto|scroll|hidden|clip)/.test(css.overflowX)) {
        left = Math.max(left, bounds.left)
        right = Math.min(right, bounds.right)
      }
    }
    return {
      text: element.textContent,
      visible:
        rect.width > 0 &&
        rect.height > 0 &&
        rect.top >= top &&
        rect.bottom <= bottom &&
        rect.left >= left &&
        rect.right <= right,
      rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
      clip: { top, bottom, left, right },
      whiteSpace: style.whiteSpace,
      textOverflow: style.textOverflow,
      focusable: element.matches('a,button,input,textarea,[tabindex]'),
    }
  })
}

const replyName = /^(Antwoord van je agent|Your agent’s reply)$/
const retryName = /^(Opnieuw proberen|Try again|Retry)$/
const checkName = /^(Status controleren|Check status)$/
const stopName = /^(Stoppen|Stop)$/
const copy = {
  nl: {
    stopped: 'Gestopt: informatie of toegang gewijzigd.',
    uncertain: 'Informatie of toegang gewijzigd. Stoppen is nog niet bevestigd.',
  },
  en: {
    stopped: 'Stopped: information or access changed.',
    uncertain: 'Information or access changed. Stopping has not been confirmed.',
  },
}
const reply = 'Ik heb de relevante notities geopend.'
const laterReply = 'Het latere concept blijft afzonderlijk bewaard.'
const longInstruction = [
  'Use only remember_memory for this bounded review test. First read exactly the disposable project page in the synthetic Space.',
  'Then request exactly one patch using the revision returned by that read. Wait for Remember to present the exact change for review.',
  'After this one patch call returns, end the turn with a short outcome only; do not repeat page content or its Read witness.',
  'On any failure, conflict, unknown outcome, denial, cancellation or error, stop immediately without another tool call.',
  'Do not retry, search, list Spaces, read again, access other pages, use shell/browser/other tools or issue parallel calls.',
].join(' ')

export async function residentHostContextStopUiQa({ directory, launch, close, getElectron, checks }: Options) {
  const file = join(directory, 'profile/daily-review/assistant/conversation.sqlite')
  const settingsFile = join(directory, 'profile/settings.json')
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'))
  writeFileSync(
    settingsFile,
    JSON.stringify({
      ...settings,
      interfaceLanguage: 'nl',
      offlineMode: false,
      cloudAnalysisConsent: true,
      audioCaptureEnabled: false,
      capturePaused: true,
      capturePausedUntil: null,
      capturePauseSources: ['audio', 'capture'],
      liveTaskUpdates: false,
      frequentDayRefresh: false,
      agentLearningEnabled: false,
      automaticRevinoteProcessing: false,
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
      'Deterministic native real-store/IPC presentation fixture, no Mini, cloud, model or capture. Confirmed context Stop is written after actual store.resetContext on a nonterminal binding; no real remote Stop is simulated as proven. Unconfirmed status alone is a snapshot-only IPC overlay. Later binding is history presentation, not multi-job host support.',
    status: 'running',
    restarts: [],
    presentations: [],
  }
  const save = () =>
    writeFileSync(
      join(directory, 'resident-host-context-stop-ui-proof.json'),
      JSON.stringify({ ...proof, connections }, null, 2)
    )
  let page: Page | null = null
  let expected: ReturnType<typeof storedState> | null = null
  let expectedMessages: AssistantConversation['messages'] | null = null
  let stoppedId = ''
  let laterId = ''
  let failure: unknown
  const metrics = async () => {
    const electron = getElectron()
    assert(electron)
    return electron.evaluate(() => (globalThis as FixtureGlobal).qaHostContextStopUi.inspect())
  }
  const unchanged = async () => {
    assert.deepEqual(storedState(file), expected)
    assert.equal(connections.length, 0, 'No startup, retry or fixture action may contact the host')
    assert.equal((await metrics()).sendCount, 0)
  }
  const quit = async (label: string) => {
    const pid = getElectron()?.process().pid
    assert(pid)
    await close()
    page = null
    await waitFor(async () => processGone(pid), 'Native context Stop fixture process must exit', 15_000)
    ;(proof.restarts as unknown[]).push({ label, pid, exitedAt: Date.now() })
    if (expected) assert.deepEqual(storedState(file), expected)
    assert.equal(connections.length, 0)
    save()
  }
  const open = async () => {
    page = await launch()
    page.setDefaultNavigationTimeout(120_000)
    await page.goto(`${new URL(page.url()).origin}/assistant/`)
    await page.locator('#assistant-message').waitFor()
    const state = await page.evaluate(() => window.remember.getAssistantConversation())
    if (expectedMessages) assert.deepEqual(state.messages, expectedMessages)
    else expectedMessages = state.messages
    assert.equal(state.activeTurnId, null)
    assert.equal(
      state.messages.find((message) => message.id === stoppedId)?.error,
      'assistant-host-context-invalidated'
    )
    assert.equal((await page.evaluate(() => window.remember.getAgentInteractions())).length, 0)
    const actualSettings = await page.evaluate(() => window.remember.getSettings())
    assert.deepEqual(capturePolicy(actualSettings), {
      audioCaptureEnabled: false,
      capturePaused: true,
      capturePausedUntil: null,
      capturePauseSources: ['audio', 'capture'],
    })
    assert.notEqual((await page.evaluate(() => window.remember.getState())).status, 'recording')
    return page
  }
  const inspect = async (label: string, language: 'nl' | 'en', narrow: boolean, historical = false) => {
    assert(page)
    proof.phase = label
    save()
    await page.evaluate((interfaceLanguage) => window.remember.updateSettings({ interfaceLanguage }), language)
    await page.setViewportSize(narrow ? { width: 720, height: 800 } : { width: 1220, height: 740 })
    const article = page.getByRole('article', { name: replyName }).filter({ hasText: reply })
    const status = article.getByRole('status')
    await page.waitForFunction(
      (text) => [...document.querySelectorAll('[role="status"]')].some((element) => element.textContent === text),
      copy[language].stopped,
      { timeout: 10_000 }
    )
    assert.equal(await status.textContent(), copy[language].stopped)
    assert.equal(await page.getByText(copy[language].stopped, { exact: true }).count(), 1)
    assert.equal(await article.getByRole('button', { name: retryName }).count(), 0)
    assert.equal(await page.getByRole('button', { name: checkName }).count(), 0)
    assert.equal(await page.getByRole('button', { name: stopName }).count(), 0)
    assert.equal(await page.getByRole('list', { name: /^(Opgeslagen pagina's|Saved pages)$/ }).count(), 0)
    const measured = await visibility(status)
    assert(measured.visible, 'Confirmed stop reason must be inside the viewport and actual scroll clip')
    assert.equal(measured.focusable, false)
    assert.notEqual(measured.textOverflow, 'ellipsis')
    assert.notEqual(measured.whiteSpace, 'nowrap')
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    const state = await page.evaluate(() => window.remember.getAssistantConversation())
    assert.equal(state.hostJob?.messageId, historical ? laterId : stoppedId)
    if (!historical) assert.equal(state.hostJob?.stopReason, 'context-invalidated')
    await page.screenshot({ path: join(directory, `context-stop-${label}.png`) })
    ;(proof.presentations as unknown[]).push({ label, language, narrow, historical, measured, conversation: state })
    await unchanged()
    save()
  }
  try {
    const store = new ResidentAgentStore(file)
    try {
      assert.equal(store.conversation(null).messages.length, 0)
      const turn = store.start('Maak een concept van de projectupdate.', 'codex')
      stoppedId = turn.id
      store.claimToolCall(JSON.stringify(['qa-context-thread', 'qa-context-call']), 'qa-context-claim', {
        messageId: stoppedId,
        toolName: 'remember_memory',
      })
      store.persistHostRun(
        { jobId: stoppedId, messageId: stoppedId, endpoint, cursor: 7, phase: 'waiting', connection: 'connected' },
        { text: reply, steps: [], status: 'streaming' }
      )
      proof.beforeInvalidation = storedState(file)
      store.resetContext()
      const invalidated = store.hostRun()
      assert(invalidated)
      assert.equal(invalidated.contextInvalidated, true)
      assert.equal(invalidated.stopReason, 'context-invalidated')
      proof.afterInvalidation = storedState(file)
      store.persistHostRun(
        { ...invalidated, phase: 'stopped', connection: 'disconnected', stopRequested: true },
        { text: reply, steps: [], status: 'cancelled', error: null }
      )
      assert.equal(store.get(stoppedId)?.error, 'assistant-host-context-invalidated')
      proof.seed = { stoppedId, snapshot: store.conversation(null) }
    } finally {
      store.close()
    }
    expected = storedState(file)
    proof.baseline = expected
    save()
    page = await open()
    await inspect('terminal-nl-standard', 'nl', false)
    await inspect('terminal-nl-narrow', 'nl', true)
    await inspect('terminal-en-standard', 'en', false)
    await inspect('terminal-en-narrow', 'en', true)
    assert(page)
    const terminalRetry = await page.evaluate((id) => window.remember.retryAssistantMessage(id), stoppedId)
    assert.deepEqual(terminalRetry.messages, expectedMessages, 'Current confirmed host retry must not run again')
    proof.currentRetry = { metrics: await metrics(), conversation: terminalRetry }
    await unchanged()
    await quit('first')
    page = await open()
    await inspect('restarted-nl-standard', 'nl', false)
    await inspect('restarted-en-narrow', 'en', true)
    await quit('second')

    const history = new ResidentAgentStore(file)
    try {
      const next = history.start(longInstruction, 'codex')
      laterId = next.id
      history.persistHostRun(
        { jobId: laterId, messageId: laterId, endpoint, cursor: 1, phase: 'completed', connection: 'disconnected' },
        { text: laterReply, steps: [], status: 'completed' }
      )
      expectedMessages = history.conversation(null).messages
    } finally {
      history.close()
    }
    expected = storedState(file)
    proof.historySeed = { laterId, expected }
    page = await open()
    assert(page)
    await page.setViewportSize({ width: 720, height: 800 })
    const oldArticle = page.getByRole('article', { name: replyName }).filter({ hasText: reply })
    const oldStatus = oldArticle.getByRole('status')
    const beforeScroll = await visibility(oldStatus)
    await page.screenshot({ path: join(directory, 'context-stop-history-before-keyboard.png') })
    const pointer = await page.getByText(longInstruction, { exact: true }).evaluate((element) => {
      const rect = element.getBoundingClientRect()
      let top = Math.max(rect.top, 0)
      let bottom = Math.min(rect.bottom, innerHeight)
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (/(auto|scroll|hidden)/.test(getComputedStyle(parent).overflowY)) {
          const clip = parent.getBoundingClientRect()
          top = Math.max(top, clip.top)
          bottom = Math.min(bottom, clip.bottom)
        }
      }
      if (bottom <= top) throw new Error('Long instruction must have a visible native scroll target')
      return { x: rect.left + 20, y: top + Math.min(20, (bottom - top) / 2) }
    })
    await page.mouse.click(pointer.x, pointer.y)
    let presses = 0
    while (!(await visibility(oldStatus)).visible && presses < 12) {
      await page.keyboard.press('PageUp')
      presses += 1
      await page.waitForTimeout(80)
    }
    const afterScroll = await visibility(oldStatus)
    assert(afterScroll.visible, 'Historical context stop must remain visible or be reachable with ordinary PageUp')
    proof.longInstruction = {
      beforeScroll,
      afterScroll,
      presses,
      pointer,
      method:
        presses > 0
          ? 'native pointer focus then keyboard PageUp; no scrollTop writes'
          : 'already visible; pointer focus only, no PageUp or scrollTop writes',
      keyboardScrollProven: presses > 0 && !beforeScroll.visible,
      boundary: beforeScroll.visible
        ? 'Historical status was already visible; this run does not prove keyboard scroll reachability.'
        : 'Historical status was outside the clip and became visible after ordinary PageUp.',
    }
    await inspect('historical-en-narrow', 'en', true, true)
    await inspect('historical-nl-standard', 'nl', false, true)
    const historicalRetry = await page.evaluate(async (id) => {
      try {
        await window.remember.retryAssistantMessage(id)
        return null
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }, stoppedId)
    assert.match(historicalRetry ?? '', /assistant-message-not-retryable/)
    proof.historicalRetry = { error: historicalRetry, metrics: await metrics() }
    await unchanged()

    const electron = getElectron()
    assert(electron)
    await electron.evaluate(() => (globalThis as FixtureGlobal).qaHostContextStopUi.show())
    const activeArticle = page.getByRole('article', { name: replyName }).filter({ hasText: laterReply })
    const status = activeArticle.getByRole('status')
    const composer = page.locator('#assistant-message')
    const draft = 'Bewaar dit concept terwijl de bestaande opdracht wordt gecontroleerd.'
    await status.getByText(copy.nl.uncertain, { exact: true }).waitFor()
    await page.getByRole('button', { name: stopName }).waitFor()
    assert.equal(await page.getByRole('button', { name: /^(Versturen|Send)$/ }).count(), 0)
    await composer.fill(draft)
    await composer.press('Enter')
    assert.equal(await composer.inputValue(), draft)
    for (const language of ['nl', 'en'] as const) {
      await page.evaluate((interfaceLanguage) => window.remember.updateSettings({ interfaceLanguage }), language)
      await page.setViewportSize(language === 'nl' ? { width: 720, height: 800 } : { width: 1220, height: 740 })
      await status.getByText(copy[language].uncertain, { exact: true }).waitFor()
      assert.equal(await activeArticle.getByText(copy[language].stopped, { exact: true }).count(), 0)
      assert.equal(await page.getByRole('button', { name: /^(Versturen|Send)$/ }).count(), 0)
      const check = activeArticle.getByRole('button', { name: checkName })
      const stop = page.getByRole('button', { name: stopName })
      assert((await check.isEnabled()) && (await stop.isEnabled()))
      await check.focus()
      assert(await check.evaluate((element) => document.activeElement === element && element.matches(':focus-visible')))
      await page.screenshot({ path: join(directory, `context-stop-unconfirmed-${language}.png`) })
    }
    const check = activeArticle.getByRole('button', { name: checkName })
    await check.press('Enter')
    await waitFor(async () => (await metrics()).retryIds.length === 1, 'Check must target the existing overlay job')
    const stop = page.getByRole('button', { name: stopName })
    await waitFor(() => stop.isEnabled(), 'Stop must remain available after checking')
    await stop.focus()
    await stop.press('Enter')
    await waitFor(async () => (await metrics()).cancelCount === 1, 'Stop must dispatch once by keyboard')
    assert.equal(await composer.inputValue(), draft)
    assert.equal(await activeArticle.getByText(copy.en.uncertain, { exact: true }).count(), 1)
    const attempts = await metrics()
    assert.deepEqual(attempts.retryIds, [laterId])
    assert.equal(attempts.cancelCount, 1)
    assert.equal(attempts.sendCount, 0)
    proof.unconfirmedFixture = { attempts, draftRetained: true, actualRemoteStop: false }
    await unchanged()
    await electron.evaluate(() => (globalThis as FixtureGlobal).qaHostContextStopUi.clear())
    await waitFor(async () => {
      assert(page)
      return (await page.evaluate(() => window.remember.getAssistantConversation())).activeTurnId === null
    }, 'Clearing overlay must restore actual terminal data')
    proof.status = 'passed'
    checks.push(
      'Native context Stop uses real persisted cause/marker through two full quits, NL/EN standard and 720px; unchanged SQLite and zero host trap connections'
    )
    checks.push(
      'Historical context Stop rejects retry without replay; long-message status visibility is recorded separately from keyboard-scroll proof, and isolated uncertain Stop preserves draft and exact Check/Stop actions without Send'
    )
  } catch (error) {
    failure = error
    proof.status = 'failed'
    proof.error = error instanceof Error ? error.message : String(error)
    if (getElectron()) {
      try {
        proof.failureMetrics = await metrics()
      } catch (metricsError) {
        proof.failureMetricsError = String(metricsError)
      }
    }
    if (page && !page.isClosed()) {
      try {
        proof.failureConversation = await page.evaluate(() => window.remember.getAssistantConversation())
        await page.screenshot({ path: join(directory, 'context-stop-failed.png') })
      } catch (captureError) {
        proof.failureEvidenceError = String(captureError)
      }
    }
  } finally {
    const errors: string[] = []
    if (getElectron()) {
      try {
        await quit('final-cleanup')
      } catch (error) {
        errors.push(String(error))
      }
    }
    await new Promise<void>((resolve) => trap.close(() => resolve()))
    if (originalEndpoint === undefined) delete process.env.REMEMBER_QA_HOST_JOB_ENDPOINT
    else process.env.REMEMBER_QA_HOST_JOB_ENDPOINT = originalEndpoint
    proof.cleanup = { errors, trapClosed: !trap.listening, at: Date.now() }
    if (errors.length && !failure) failure = new Error(`Context Stop cleanup failed: ${errors.join('; ')}`)
    if (failure) proof.status = 'failed'
    save()
  }
  if (failure) throw failure
}
