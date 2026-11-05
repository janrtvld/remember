import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import type { AssistantConversation } from '@remember/shared'
import type { Page } from 'playwright-core'
import { agentConsentUiQa } from './agentConsent'
import {
  measureAssistantProgress,
  measureAssistantReading,
  measureAssistantTyping,
  measureAssistantWidths,
  measureRepeatedAssistantSubmit,
  observeAssistantSubmit,
  saveAssistantSubmit,
  verifyAssistantDraftScopes,
  verifyAssistantHistoryScroll,
} from './assistantUx'
import { longAssistantReviewFixture } from './codexWorker'

async function waitFor(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 30_000
  while (!(await check())) {
    assert(Date.now() < deadline, label)
    await delay(100)
  }
}

/** Requires installCodexWorkerFixture in the runner's disposable source copy. */
export async function residentAgentQa(page: Page, webUrl: string, directory: string) {
  page.setDefaultNavigationTimeout(120_000)
  await page.evaluate(() => window.remember.updateSettings({ offlineMode: false, cloudAnalysisConsent: true }))
  const workIds = await page.evaluate(async () => (await window.remember.listWorkItems()).map((item) => item.id))
  await page.goto(`${webUrl}/assistant/`)
  const composer = page.locator('#assistant-message')
  await composer.waitFor({ state: 'visible' })
  assert.equal((await page.evaluate(() => window.remember.getAssistantConversation())).messages.length, 0)
  const coldPrompt = 'qa-ux-short-cold: bevestig deze eerste synthetische vraag.'
  await composer.fill(coldPrompt)
  await observeAssistantSubmit(page, coldPrompt)
  await composer.press('Enter')
  await saveAssistantSubmit(page, directory, 'cold-ordinary')
  await waitFor(async () => {
    const conversation = await page.evaluate(() => window.remember.getAssistantConversation())
    return !conversation.activeTurnId && conversation.messages.at(-1)?.text === 'Ontvangen.'
  }, 'The cold ordinary fixture must complete without a review')
  const coldBaseline = await page.evaluate(() => window.remember.getAssistantConversation())
  const prompt = 'qa-assistant-restart: inspect this synthetic task'
  await page.goto(`${webUrl}/assistant/?prompt=${encodeURIComponent(prompt)}`)
  await composer.waitFor({ state: 'visible' })
  assert.equal(await composer.inputValue(), prompt)
  assert.equal(
    (await page.evaluate(() => window.remember.getAssistantConversation())).messages.length,
    coldBaseline.messages.length,
    'Prefill must not send'
  )
  await observeAssistantSubmit(page, prompt)
  await composer.press('Enter')
  await saveAssistantSubmit(page, directory)
  await waitFor(
    async () =>
      (await page.evaluate(() => window.remember.getAgentInteractions())).some((item) =>
        item.title.includes('toestemming')
      ),
    'Assistant must expose real provider approval'
  )
  await page.reload()
  await page.getByRole('button', { name: /^(Toestaan|Allow)$/ }).waitFor()
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  await page.setViewportSize({ width: 720, height: 800 })
  const details = page.getByRole('region', { name: /^(Details van het verzoek|Request details)$/ })
  await details.waitFor({ state: 'visible' })
  assert((await details.innerText()).includes(longAssistantReviewFixture))
  assert(await details.evaluate((element) => element.scrollHeight > element.clientHeight))
  await composer.focus()
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await details.evaluate((element) => document.activeElement === element)) break
    await page.keyboard.press('Shift+Tab')
  }
  assert(
    await details.evaluate((element) => document.activeElement === element),
    'A long review must be reachable through the normal tab order'
  )
  const scrollTop = await details.evaluate((element) => element.scrollTop)
  const keyboardBefore = await details.evaluate((element) => {
    const events: Record<string, unknown>[] = []
    Object.assign(window, { qaReviewKeyboardEvents: events })
    for (const type of ['keydown', 'keyup']) {
      window.addEventListener(
        type,
        (event) => {
          const key = event as KeyboardEvent
          const record: Record<string, unknown> = {
            type,
            key: key.key,
            code: key.code,
            trusted: key.isTrusted,
            targetIsReview: key.target === element,
            documentFocused: document.hasFocus(),
          }
          events.push(record)
          queueMicrotask(() => {
            record.defaultPrevented = key.defaultPrevented
          })
        },
        { capture: true, once: true }
      )
    }
    const rect = element.getBoundingClientRect()
    return {
      documentFocused: document.hasFocus(),
      activeElementIsReview: document.activeElement === element,
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      overflowY: getComputedStyle(element).overflowY,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    }
  })
  try {
    await page.keyboard.press('PageDown')
    await waitFor(
      async () => (await details.evaluate((element) => element.scrollTop)) > scrollTop,
      'Keyboard navigation must scroll the long review itself'
    )
  } finally {
    const keyboardAfter = await details.evaluate((element) => ({
      documentFocused: document.hasFocus(),
      activeElementIsReview: document.activeElement === element,
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      events: (window as unknown as { qaReviewKeyboardEvents: Record<string, unknown>[] }).qaReviewKeyboardEvents,
    }))
    writeFileSync(
      join(directory, 'assistant-review-keyboard-proof.json'),
      JSON.stringify({ before: keyboardBefore, after: keyboardAfter }, null, 2)
    )
  }
  assert.equal((await page.evaluate(() => window.remember.getAgentInteractions())).length, 1)
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.screenshot({ path: join(directory, 'assistant-long-review-narrow.png') })
  await page.setViewportSize(viewport)
  await page.screenshot({ path: join(directory, 'assistant-approval.png') })
  await page.getByRole('button', { name: /^(Toestaan|Allow)$/ }).click()
  await waitFor(async () => {
    const value = await page.evaluate(() => window.remember.getAssistantConversation())
    return (
      !value.activeTurnId &&
      value.messages.some((message) => message.role === 'assistant' && message.status === 'completed')
    )
  }, 'Assistant result must persist independently of renderer')
  const completed = await page.evaluate(() => window.remember.getAssistantConversation())
  assert.equal(completed.messages.at(-1)?.text, 'Synthetic Worker result verified.')
  assert.deepEqual(
    await page.evaluate(async () => (await window.remember.listWorkItems()).map((item) => item.id)),
    workIds,
    'General chat must not create a WorkItem'
  )
  await page.getByText('Synthetic Worker result verified.', { exact: true }).waitFor({ state: 'visible' })
  await page.goto(`${webUrl}/assistant/`)
  await composer.waitFor({ state: 'visible' })
  await waitFor(
    async () => (await page.getByRole('button', { name: /^(Stoppen|Stop)$/ }).count()) === 0,
    'Renderer must reflect the completed turn before the next keyboard submission'
  )
  await page.screenshot({ path: join(directory, 'assistant-completed.png') })
  await composer.fill('qa-cancel-no-approval')
  await observeAssistantSubmit(page, 'qa-cancel-no-approval', 1000)
  await waitFor(
    () => page.getByRole('button', { name: /^(Versturen|Send)$/ }).isEnabled(),
    'Composer must allow the second turn before Enter is pressed'
  )
  await composer.press('Enter')
  await waitFor(
    async () => Boolean((await page.evaluate(() => window.remember.getAssistantConversation())).activeTurnId),
    'A second turn must start'
  )
  const scrollProof = await saveAssistantSubmit(page, directory, 'followup-scroll')
  const positions = scrollProof.samples.map((sample: { scrollTop: number }) => sample.scrollTop)
  assert(
    new Set(positions.map((position: number) => Math.round(position))).size > 3,
    'Follow-up submit animates through intermediate scroll positions'
  )
  const layout = await page.evaluate(() => {
    const composer = document.querySelector('[data-assistant-composer]')?.getBoundingClientRect()
    const answer = [...document.querySelectorAll('[data-assistant-message]')].at(-1)?.getBoundingClientRect()
    if (!composer || !answer) throw new Error('Missing chat layout elements')
    return {
      composerLeft: composer.left,
      composerRight: composer.right,
      answerLeft: answer.left,
      answerRight: answer.right,
    }
  })
  assert.equal(layout.answerLeft, layout.composerLeft, 'Answer and composer share left edge')
  assert.equal(layout.answerRight, layout.composerRight, 'Answer and composer share right edge')
  assert.equal(await page.getByRole('group', { name: /Choose your agent|Kies je agent/ }).count(), 0)
  assert.equal(
    await page
      .locator('[data-assistant-message]')
      .getByRole('button', { name: /^(Copy|Kopiëren)$/ })
      .count(),
    0
  )
  writeFileSync(
    join(directory, 'assistant-layout-patch.json'),
    JSON.stringify({ layout, scrollPositions: positions }, null, 2)
  )
  const beforeNavigation = await page.evaluate(() => window.remember.getAssistantConversation())
  assert(beforeNavigation.activeTurnId)
  assert.equal(beforeNavigation.execution, 'local')
  const navigationStates = []
  for (const path of ['/inbox/', '/day/', '/conversations/', '/assistant/']) {
    await page.locator(`a[href="${path}"]`).first().click()
    await waitFor(async () => new URL(page.url()).pathname === path, `Sidebar navigation reaches ${path}`)
    const current = await page.evaluate(() => window.remember.getAssistantConversation())
    assert.equal(current.activeTurnId, beforeNavigation.activeTurnId, `${path} must not cancel the local turn`)
    const answer = current.messages.find((message) => message.id === beforeNavigation.activeTurnId)
    assert(answer, `${path} preserves the active response`)
    assert.equal(answer.status, 'streaming', `${path} preserves the pending local provider response`)
    assert.equal(answer?.command, undefined, 'Local chat must not become a remote command')
    assert.equal(
      current.messages.filter((message) => message.role === 'user').length,
      beforeNavigation.messages.filter((message) => message.role === 'user').length,
      'Navigation must not submit another copy of the request'
    )
    navigationStates.push({ path, activeTurnId: current.activeTurnId, status: answer.status })
  }
  await composer.waitFor({ state: 'visible' })
  await page.getByRole('button', { name: /^(Stoppen|Stop)$/ }).waitFor({ state: 'visible' })
  writeFileSync(join(directory, 'assistant-local-navigation.json'), JSON.stringify(navigationStates, null, 2))
  await page.screenshot({ path: join(directory, 'assistant-local-navigation.png') })
  await page.reload()
  await measureAssistantProgress(page, directory)
  await measureAssistantReading(page, directory)
  await measureAssistantWidths(page, directory)
  await page.getByRole('button', { name: /^(Stoppen|Stop)$/ }).click()
  await waitFor(
    async () => !(await page.evaluate(() => window.remember.getAssistantConversation())).activeTurnId,
    'Cancellation must finish after renderer reload'
  )
  assert.equal(
    (await page.evaluate(() => window.remember.getAssistantConversation())).messages.at(-1)?.status,
    'cancelled'
  )
  await page
    .getByRole('button', { name: /^(Opnieuw proberen|Try again|Retry)$/ })
    .last()
    .click()
  await waitFor(
    async () => Boolean((await page.evaluate(() => window.remember.getAssistantConversation())).activeTurnId),
    'Retry must restart the same user message'
  )
  await page.getByRole('button', { name: /^(Stoppen|Stop)$/ }).click()
  await waitFor(
    async () => !(await page.evaluate(() => window.remember.getAssistantConversation())).activeTurnId,
    'Retried turn must stop without duplicating messages'
  )
  const final = await page.evaluate(() => window.remember.getAssistantConversation())
  assert.equal(
    final.messages.filter((message) => message.role === 'user').length,
    3,
    'Retry must not duplicate user messages'
  )
  assert.equal(final.messages.at(-1)?.status, 'cancelled')
  writeFileSync(join(directory, 'assistant-before-restart.json'), JSON.stringify(final, null, 2))
  await hostResultRecoveryUiQa(page, directory)
}

type HostResultUiFixture = AssistantConversation & {
  qaHostResult: { retryIds: string[]; sendCount: number }
}

async function hostResultRecoveryUiQa(page: Page, directory: string) {
  const before = await page.evaluate(() => window.remember.getAssistantConversation())
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  const messageId = 'qa-host-result-message'
  const statusText =
    /^(Resultaat nog niet gecontroleerd\. De bronnen zijn tijdelijk niet beschikbaar\.|Result not yet verified\. The sources are temporarily unavailable\.)$/
  const proof: { input: string; retryIds: string[]; sendCount: number }[] = []
  try {
    for (const input of ['check-button', 'composer-enter']) {
      const seeded = await page.evaluate(() =>
        window.remember.sendAssistantMessage({ text: 'qa-host-context-unavailable', provider: 'codex' })
      )
      assert.equal(seeded.hostJob?.messageId, messageId)
      assert.equal(seeded.messages.at(-1)?.error, 'assistant-host-context-unavailable')
      await page.reload()
      const article = page.getByRole('article', { name: /^(Antwoord van je agent|Your agent’s reply)$/ })
      const status = article.getByRole('status').filter({ hasText: statusText })
      await status.waitFor({ state: 'visible' })
      assert.equal(await page.getByText(statusText).count(), 1, 'Only one source-unavailable status is shown')
      assert.equal(await page.getByRole('alert').filter({ hasText: statusText }).count(), 0)
      const check = article.getByRole('button', { name: /^(Status controleren|Check status)$/ })
      assert(await check.isEnabled(), 'Completed host work must keep its source revalidation action')
      const composer = page.locator('#assistant-message')
      const draft = `Preserved draft during ${input}.`
      await composer.fill(draft)
      assert(await page.getByRole('button', { name: /^(Versturen|Send)$/ }).isDisabled())
      assert.equal(await page.getByRole('button', { name: /^(Stoppen|Stop)$/ }).count(), 0)
      assert.equal(await article.getByRole('button', { name: /^(Opnieuw proberen|Try again|Retry)$/ }).count(), 0)
      await page.screenshot({ path: join(directory, `assistant-host-result-${input}.png`) })
      await page.setViewportSize({ width: 720, height: 800 })
      await check.scrollIntoViewIfNeeded()
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      await page.screenshot({ path: join(directory, `assistant-host-result-${input}-narrow.png`) })
      if (input === 'check-button') {
        await check.focus()
        assert(await check.evaluate((element) => document.activeElement === element))
        await page.keyboard.press('Enter')
      } else {
        await composer.press('Enter')
      }
      await article.getByText('Verified fixture result.', { exact: true }).waitFor()
      const after = (await page.evaluate(() => window.remember.getAssistantConversation())) as HostResultUiFixture
      assert.deepEqual(
        after.messages.map((message) => message.id),
        seeded.messages.map((message) => message.id)
      )
      assert.equal(after.hostJob?.messageId, messageId)
      assert.equal(after.hostJob?.phase, 'completed')
      assert.equal(after.messages.at(-1)?.error, null)
      assert.deepEqual(after.qaHostResult.retryIds, [messageId], 'Recovery must target the same durable host message')
      assert.equal(after.qaHostResult.sendCount, 0, 'Recovery must not send the composer draft as a new turn')
      assert.equal(await composer.inputValue(), draft)
      assert.equal(await article.getByRole('status').count(), 0, 'Ordinary completed results remain quiet')
      assert.equal(await check.count(), 0)
      assert(await page.getByRole('button', { name: /^(Versturen|Send)$/ }).isEnabled())
      proof.push({ input, ...after.qaHostResult })
      await page.screenshot({ path: join(directory, `assistant-host-result-${input}-resolved.png`) })
      await page.setViewportSize(viewport)
    }
  } finally {
    await page.evaluate(() =>
      window.remember.sendAssistantMessage({ text: 'qa-host-context-reset', provider: 'codex' })
    )
    await page.setViewportSize(viewport)
    await page.reload()
  }
  const restored = await page.evaluate(() => window.remember.getAssistantConversation())
  assert.deepEqual(restored.messages, before.messages, 'The UI fixture must leave persisted chat unchanged')
  writeFileSync(
    join(directory, 'assistant-host-result-fixture-proof.json'),
    JSON.stringify(
      {
        scope:
          'Isolated native renderer/IPC snapshot fixture; no real source outage, model turn or backend revalidation proof',
        terminalResultRecoveryVisible: true,
        oneStatusLocation: true,
        narrowWidth: 720,
        completedResultQuiet: true,
        draftPreserved: true,
        persistedChatUnchanged: true,
        attempts: proof,
      },
      null,
      2
    )
  )
}

export async function residentAgentAfterRestartQa(page: Page, webUrl: string, directory: string) {
  const before = JSON.parse(readFileSync(join(directory, 'assistant-before-restart.json'), 'utf8'))
  await page.goto(`${webUrl}/assistant/`)
  await page.locator('#assistant-message').waitFor({ state: 'visible' })
  const after = await page.evaluate(() => window.remember.getAssistantConversation())
  assert.deepEqual(
    after.messages,
    before.messages,
    'All completed/cancelled messages must survive full Electron restart'
  )
  assert.equal(after.activeTurnId, null)
  const database = new DatabaseSync(join(directory, 'profile/daily-review/assistant/conversation.sqlite'), {
    readOnly: true,
  })
  assert.equal(
    database.prepare("SELECT thread_id FROM assistant_thread WHERE provider = 'codex'").get()?.thread_id,
    'qa-codex-thread',
    'Provider identity must survive full restart'
  )
  database.close()
  await page.evaluate(() => window.remember.sendAssistantMessage({ text: 'qa-cancel-no-approval', provider: 'codex' }))
  await waitFor(
    async () =>
      (await page.evaluate(() => window.remember.getAssistantConversation())).messages
        .at(-1)
        ?.steps.some((step) => step.id === 'codex-started') ?? false,
    'Post-restart provider process must report a started turn'
  )
  await page.evaluate(() => window.remember.updateSettings({ cloudAnalysisConsent: false }))
  await waitFor(
    async () => !(await page.evaluate(() => window.remember.getAssistantConversation())).activeTurnId,
    'Revoking consent must interrupt the worker'
  )
  assert.equal(
    (await page.evaluate(() => window.remember.getAssistantConversation())).messages.at(-1)?.status,
    'cancelled'
  )
  await page.evaluate(() => window.remember.updateSettings({ offlineMode: true, cloudAnalysisConsent: true }))
  await page.screenshot({ path: join(directory, 'assistant-after-restart.png') })
  writeFileSync(
    join(directory, 'assistant-proof.json'),
    JSON.stringify(
      {
        prefillDoesNotSend: true,
        providerApprovalAfterReload: true,
        longReviewKeyboardScrollAt720px: true,
        persistedMessages: after.messages.length,
        noSyntheticWorkItem: true,
        cancellationAfterReload: true,
        retryWithoutDuplicateUserMessage: true,
        consentRevocationCancels: true,
        fullRestart: true,
        providerThreadAfterRestart: true,
        model: 'deterministic fixture; no live inference or browser tools',
      },
      null,
      2
    )
  )
  await agentConsentUiQa(page, webUrl, directory)
  await measureRepeatedAssistantSubmit(page, webUrl, directory)
  await measureAssistantTyping(page, directory)
  await verifyAssistantHistoryScroll(page, directory)
  await verifyAssistantDraftScopes(page, directory)
}
