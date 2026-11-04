import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { LocalSettings } from '@remember/shared'
import type { Page } from 'playwright-core'

export const agentConsentSwitch = /^(AI-verwerking toestaan|Allow AI processing)$/

export function capturePolicy(settings: LocalSettings) {
  return {
    audioCaptureEnabled: settings.audioCaptureEnabled,
    capturePaused: settings.capturePaused,
    capturePausedUntil: settings.capturePausedUntil,
    capturePauseSources: settings.capturePauseSources,
  }
}

// This fault controller exists only in the runner's disposable source snapshot.
export function installAgentConsentFixture(directory: string) {
  const main = join(directory, 'src/main/index.ts')
  const source = readFileSync(main, 'utf8')
  const marker = '  ipcMain.handle(CHANNELS.updateSettings, async (_event, patch) => {'
  assert.equal(source.split(marker).length, 2, 'Consent fixture requires exactly one settings handler')
  writeFileSync(
    main,
    source.replace(
      marker,
      `  let qaConsentHold = false
  let qaConsentPending: { resolve: () => void; reject: (error: Error) => void } | null = null
  const qaConsentAttempts: unknown[] = []
  ipcMain.handle('remember:qa:consent', (_event, action: string) => {
    if (action === 'hold') qaConsentHold = true
    else if (action === 'release' || action === 'reject' || action === 'reset') {
      qaConsentHold = false
      const pending = qaConsentPending
      qaConsentPending = null
      if (action === 'release') pending?.resolve()
      else pending?.reject(new Error('qa-consent-update-failed'))
      if (action === 'reset') qaConsentAttempts.length = 0
    } else if (action !== 'status') throw new Error('qa-invalid-consent-control')
    return { pending: Boolean(qaConsentPending), attempts: qaConsentAttempts }
  })
${marker}
    if (qaConsentHold && typeof patch?.cloudAnalysisConsent === 'boolean') {
      if (qaConsentPending) throw new Error('qa-duplicate-consent-update')
      qaConsentAttempts.push(patch)
      await new Promise<void>((resolve, reject) => { qaConsentPending = { resolve, reject } })
    }`
    )
  )
  const preload = join(directory, 'src/preload/index.ts')
  writeFileSync(
    preload,
    `${readFileSync(preload, 'utf8')}
contextBridge.exposeInMainWorld('rememberQaConsent', {
  control: (action: string) => ipcRenderer.invoke('remember:qa:consent', action),
})
`
  )
}

type FixtureState = { pending: boolean; attempts: { cloudAnalysisConsent: boolean; [key: string]: unknown }[] }

async function control(page: Page, action: 'hold' | 'release' | 'reject' | 'reset' | 'status') {
  return page.evaluate(
    (action) =>
      (
        window as unknown as {
          rememberQaConsent: { control: (action: string) => Promise<FixtureState> }
        }
      ).rememberQaConsent.control(action),
    action
  )
}

async function waitFor(read: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 30_000
  while (!(await read())) {
    assert(Date.now() < deadline, label)
    await delay(100)
  }
}

async function focusState(page: Page) {
  return page.evaluate(() => {
    const element = document.activeElement
    return {
      documentFocused: document.hasFocus(),
      tagName: element?.tagName,
      id: element?.id,
      role: element?.getAttribute('role'),
      label: element?.getAttribute('aria-label'),
      consentFocused: element === document.getElementById('agent-ai-consent'),
      focusVisible: element?.matches(':focus-visible') ?? false,
    }
  })
}

export async function agentConsentUiQa(page: Page, webUrl: string, directory: string) {
  const original = await page.evaluate(() => window.remember.getSettings())
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  const proof: Record<string, unknown> = {
    boundary:
      'Isolated native UI and settings IPC with a snapshot-only held/rejected save; no real settings failure, model call or capture proof.',
    status: 'running',
  }
  const focus: Record<string, Awaited<ReturnType<typeof focusState>>> = {}
  proof.focus = focus
  const save = () => writeFileSync(join(directory, 'agent-consent-fixture-proof.json'), JSON.stringify(proof, null, 2))
  try {
    await page.evaluate(() =>
      window.remember.updateSettings({
        cloudAnalysisConsent: false,
        offlineMode: true,
        audioCaptureEnabled: false,
        capturePaused: true,
        capturePausedUntil: null,
        capturePauseSources: ['audio', 'capture'],
      })
    )
    const before = await page.evaluate(() => window.remember.getSettings())
    const chatBefore = await page.evaluate(() => window.remember.getAssistantConversation())
    await page.goto(`${webUrl}/agent/`)
    await page.setViewportSize({ width: 720, height: 800 })
    const toggle = page.getByRole('switch', { name: agentConsentSwitch })
    await toggle.waitFor({ state: 'visible' })
    assert(!(await toggle.isChecked()))
    await control(page, 'hold')
    await toggle.focus()
    assert(await toggle.evaluate((element) => document.activeElement === element))
    focus.beforeSave = await focusState(page)
    await page.keyboard.press('Space')
    await waitFor(async () => (await control(page, 'status')).pending, 'A real settings IPC call must be held')
    assert(await toggle.isDisabled())
    assert.equal(await toggle.getAttribute('aria-busy'), 'true')
    assert(!(await toggle.isChecked()), 'Pending permission must not appear granted')
    focus.pendingSave = await focusState(page)
    await page
      .getByRole('status')
      .filter({ hasText: /^(Opslaan…|Saving…)$/ })
      .waitFor()
    await page.keyboard.press('Space')
    await delay(150)
    assert.equal((await control(page, 'status')).attempts.length, 1, 'Pending keyboard input must not duplicate saves')
    assert.equal((await page.evaluate(() => window.remember.getSettings())).cloudAnalysisConsent, false)
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.screenshot({ path: join(directory, 'agent-consent-loading-narrow.png') })
    await control(page, 'reject')
    const error = page.getByRole('alert').filter({
      hasText:
        /^(De toestemming kon niet worden opgeslagen\. Probeer opnieuw\.|Could not save the permission\. Try again\.)$/,
    })
    await error.waitFor({ state: 'visible' })
    assert(await toggle.isEnabled())
    assert(!(await toggle.isChecked()))
    focus.afterRejectedSave = await focusState(page)
    save()
    try {
      await waitFor(async () => {
        const current = await focusState(page)
        return current.consentFocused && current.focusVisible
      }, 'A rejected keyboard save must restore visible focus to the available consent switch')
    } finally {
      focus.afterRejectedFocusWait = await focusState(page)
      save()
    }
    assert.equal((await page.evaluate(() => window.remember.getSettings())).cloudAnalysisConsent, false)
    assert.deepEqual(capturePolicy(await page.evaluate(() => window.remember.getSettings())), capturePolicy(before))
    await page.screenshot({ path: join(directory, 'agent-consent-error-narrow.png') })
    await control(page, 'hold')
    const retry = page.getByRole('button', { name: /^(Opnieuw proberen|Retry)$/ })
    await retry.focus()
    assert(await retry.evaluate((element) => document.activeElement === element))
    focus.beforeRetry = await focusState(page)
    await page.keyboard.press('Enter')
    await waitFor(async () => (await control(page, 'status')).pending, 'Retry must reach the same settings IPC')
    focus.pendingRetry = await focusState(page)
    const attempts = (await control(page, 'status')).attempts
    assert.equal(attempts.length, 2)
    assert.deepEqual(attempts[1], attempts[0], 'Retry must repeat the requested permission, not invert saved state')
    assert.equal(attempts[0].cloudAnalysisConsent, true)
    await control(page, 'release')
    await waitFor(() => toggle.isChecked(), 'A confirmed save must show permission enabled')
    await waitFor(async () => (await error.count()) === 0, 'The successful retry must clear its inline error')
    focus.afterSuccessfulRetry = await focusState(page)
    save()
    try {
      await waitFor(
        async () =>
          (await toggle.isEnabled()) &&
          (await toggle.evaluate((element) => document.activeElement === element && element.matches(':focus-visible'))),
        'Successful keyboard Retry must restore visible focus to the available consent switch'
      )
    } finally {
      focus.afterRetryFocusWait = await focusState(page)
      save()
    }
    const after = await page.evaluate(() => window.remember.getSettings())
    assert.equal(after.cloudAnalysisConsent, true)
    assert.equal(after.cloudConsentNoticeSeen, true)
    assert.deepEqual(capturePolicy(after), capturePolicy(before))
    assert.equal(after.defaultAgentProvider, before.defaultAgentProvider)
    assert.equal(after.dayAnalysisProvider, before.dayAnalysisProvider)
    assert.deepEqual(
      (await page.evaluate(() => window.remember.getAssistantConversation())).messages,
      chatBefore.messages
    )
    assert.notEqual((await page.evaluate(() => window.remember.getState())).status, 'recording')
    await page.screenshot({ path: join(directory, 'agent-consent-retry-saved-narrow.png') })
    await control(page, 'hold')
    await toggle.focus()
    await page.keyboard.press('Space')
    await waitFor(async () => (await control(page, 'status')).pending, 'The non-steal check must hold a real save')
    const provider = page.locator(`input[name="agent-page-provider"][value="${after.defaultAgentProvider}"]`)
    await provider.focus()
    assert(await provider.evaluate((element) => document.activeElement === element))
    focus.providerChosenWhilePending = await focusState(page)
    await control(page, 'release')
    await waitFor(
      async () =>
        (await toggle.isEnabled()) &&
        !(await toggle.isChecked()) &&
        !(await page.evaluate(() => window.remember.getSettings())).cloudAnalysisConsent,
      'The pending permission change must finish while another control retains focus'
    )
    await delay(200)
    focus.afterSaveWithProviderFocused = await focusState(page)
    assert(
      await provider.evaluate((element) => document.activeElement === element),
      'Consent completion must not steal focus from a different live control'
    )
    const nonStealSettings = await page.evaluate(() => window.remember.getSettings())
    assert.equal(nonStealSettings.defaultAgentProvider, after.defaultAgentProvider)
    assert.equal(nonStealSettings.dayAnalysisProvider, after.dayAnalysisProvider)
    assert.deepEqual(capturePolicy(nonStealSettings), capturePolicy(before))
    assert.deepEqual(
      (await page.evaluate(() => window.remember.getAssistantConversation())).messages,
      chatBefore.messages
    )
    const allAttempts = (await control(page, 'status')).attempts
    assert.equal(allAttempts.length, 3)
    assert.deepEqual(allAttempts[2], { cloudAnalysisConsent: false })
    await page.screenshot({ path: join(directory, 'agent-consent-no-focus-steal-narrow.png') })
    Object.assign(proof, {
      status: 'passed',
      attempts: allAttempts,
      loadingUnconfirmed: true,
      rejectedSaveKeepsConsentOff: true,
      keyboardRetrySameValue: true,
      keyboardRetryRestoresFocus: true,
      rejectedSaveRestoresVisibleFocus: true,
      retryRestoresVisibleFocus: true,
      completionDoesNotStealProviderFocus: true,
      captureUnchanged: capturePolicy(after),
      messagesUnchanged: true,
      narrowWidth: 720,
    })
    save()
  } catch (error) {
    Object.assign(proof, { status: 'failed', error: String(error) })
    save()
    throw error
  } finally {
    await control(page, 'reset')
    await page.evaluate((settings) => window.remember.updateSettings(settings), {
      ...capturePolicy(original),
      cloudAnalysisConsent: original.cloudAnalysisConsent,
      cloudConsentNoticeSeen: original.cloudConsentNoticeSeen,
      offlineMode: original.offlineMode,
    })
    await page.setViewportSize(viewport)
  }
}
