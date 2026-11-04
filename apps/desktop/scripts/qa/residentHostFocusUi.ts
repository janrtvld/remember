import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { CDPSession, ElectronApplication, Locator, Page } from 'playwright-core'
import { waitFor } from './residentHostReview'

type Operation = 'check' | 'stop'
type FocusControl = {
  arm(operation: Operation): void
  release(outcome: 'success' | 'failure'): void
  review(): void
  expire(): void
  replaceJob(): void
  clear(): void
  inspect(): { pending: Operation | null; events: Record<string, unknown>[]; reviewAnswers: number }
}
type FixtureGlobal = typeof globalThis & {
  qaHostFocusUi: FocusControl
  qaHostExpiryUi: { show(): void; clear(): void; inspect(): unknown }
}

export function installHostFocusUiFixture(directory: string) {
  assert.notEqual(resolve(directory), resolve(import.meta.dirname, '../..'))
  const file = join(directory, 'src/main/residentAgentRuntime.ts')
  let source = readFileSync(file, 'utf8')
  const replace = (before: string, after: string) => {
    assert.equal(source.split(before).length, 2, `Focus fixture needs one exact snapshot anchor: ${before}`)
    source = source.replace(before, after)
  }
  replace(
    '  Object.assign(globalThis, { qaHostExpiryUi:',
    `  let qaFocusArmed: 'check' | 'stop' | null = null
  let qaFocusHeld: { operation: 'check' | 'stop'; resolve: (value: unknown) => void; reject: (error: Error) => void } | null = null
  let qaFocusReview: AbortController | null = null
  const qaFocusEvents: Record<string, unknown>[] = []
  let qaFocusReviewAnswers = 0
  const qaFocusRecord = (event: string) => qaFocusEvents.push({ event, at: Date.now() })
  const qaFocusWait = (operation: 'check' | 'stop') => {
    if (qaFocusArmed !== operation || qaFocusHeld) throw new Error('qa-focus-unexpected-operation')
    qaFocusArmed = null
    qaFocusRecord(operation + '-pending')
    return new Promise((resolve, reject) => { qaFocusHeld = { operation, resolve, reject } })
  }
  const qaFocusExpire = () => {
    qaFocusReview?.abort()
    qaFocusReview = null
    if (!qaExpiryOverlay?.hostJob) throw new Error('qa-focus-overlay-missing')
    const id = qaExpiryOverlay.hostJob.messageId
    qaExpiryOverlay = { ...qaExpiryOverlay, activeTurnId: null,
      hostJob: { ...qaExpiryOverlay.hostJob, phase: 'stopped', stopReason: 'request-expired' },
      messages: qaExpiryOverlay.messages.map(message => message.id === id
        ? { ...message, status: 'cancelled', error: 'assistant-host-request-expired' } : message) }
    qaFocusRecord('snapshot-expired')
    qaExpiryChanged()
  }
  Object.assign(globalThis, { qaHostFocusUi: {
    arm(operation: 'check' | 'stop') {
      if (qaFocusHeld || qaFocusArmed) throw new Error('qa-focus-already-held')
      qaFocusArmed = operation
    },
    release(outcome: 'success' | 'failure') {
      const pending = qaFocusHeld
      if (!pending) throw new Error('qa-focus-not-pending')
      qaFocusHeld = null
      qaFocusRecord(pending.operation + '-' + outcome)
      if (outcome === 'failure') pending.reject(new Error('qa-focus-injected-failure'))
      else {
        if (pending.operation === 'stop') qaFocusExpire()
        pending.resolve(qaExpiryOverlay)
      }
    },
    review() {
      if (!qaExpiryOverlay?.hostJob || qaFocusReview) throw new Error('qa-focus-review-state')
      const id = qaExpiryOverlay.hostJob.messageId
      qaExpiryOverlay = { ...qaExpiryOverlay, activeTurnId: id,
        hostJob: { messageId: id, phase: 'waiting', connection: 'connected' } }
      qaFocusReview = new AbortController()
      const detail = Array.from({ length: 35 }, (_, index) => 'Synthetic memory review line ' + (index + 1) + ': preserve the exact reviewed change.').join('\\n')
      void interactions.ask({ turnId: id, title: 'Save knowledge in Remember', detail, fields: [],
        actions: [{ id: 'accept', label: 'Save' }, { id: 'decline', label: 'Cancel' }] }, qaFocusReview.signal)
        .then(() => { qaFocusReviewAnswers += 1; qaFocusRecord('review-answered') }, () => qaFocusRecord('review-aborted'))
      qaExpiryChanged()
    },
    expire: qaFocusExpire,
    replaceJob() {
      if (!qaExpiryOverlay?.hostJob) throw new Error('qa-focus-overlay-missing')
      const previous = qaExpiryOverlay.messages.find(message => message.id === qaExpiryOverlay?.hostJob?.messageId)
      if (!previous) throw new Error('qa-focus-message-missing')
      const id = 'qa-focus-replacement-job'
      qaExpiryOverlay = { ...qaExpiryOverlay, activeTurnId: id,
        hostJob: { ...qaExpiryOverlay.hostJob, messageId: id },
        messages: [...qaExpiryOverlay.messages, { ...previous, id, text: 'Synthetic replacement job; no driver or action.' }] }
      qaFocusRecord('snapshot-job-replaced')
      qaExpiryChanged()
    },
    clear() {
      qaFocusReview?.abort(); qaFocusReview = null
      qaFocusHeld?.reject(new Error('qa-focus-cleanup')); qaFocusHeld = null; qaFocusArmed = null
    },
    inspect() { return { pending: qaFocusHeld?.operation ?? null, events: structuredClone(qaFocusEvents), reviewAnswers: qaFocusReviewAnswers } },
  } })
  Object.assign(globalThis, { qaHostExpiryUi:`
  )
  replace(
    '      qaExpiryMetrics.retryIds.push(messageId)\n      return qaExpiryOverlay',
    "      qaExpiryMetrics.retryIds.push(messageId)\n      if (qaFocusArmed) return qaFocusWait('check')\n      return qaExpiryOverlay"
  )
  replace(
    "    if (qaExpiryOverlay) throw new Error('qa-expiry-stop-unconfirmed')",
    "    if (qaExpiryOverlay && qaFocusArmed) return qaFocusWait('stop')\n    if (qaExpiryOverlay) throw new Error('qa-expiry-stop-unconfirmed')"
  )
  writeFileSync(file, source)
}

type ElementState = {
  tag: string | null
  id: string | null
  role: string | null
  className: string | null
  text: string | null
  connected: boolean
  disabled: boolean
  focusVisible: boolean
  outlineStyle: string | null
  outlineWidth: string | null
  outlineColor: string | null
  outlineOffset: string | null
  boxShadow: string | null
}
type FocusState = {
  documentFocused: boolean
  active: ElementState
  origin: ElementState
  composerFocused: boolean
  originFocused: boolean
  draft: string
  trace: Record<string, unknown>[]
}
type CaseProof = {
  name: string
  draft?: string
  focusLossMethod?: string
  hideDiagnostic?: unknown
  nativeFocus?: unknown
  operationCountsBefore?: unknown
  operationCountsAfter?: unknown
  pointerTarget?: unknown
  before?: FocusState
  pending?: FocusState
  moved?: FocusState
  settled?: FocusState
  returned?: FocusState
  expected?: string
  pass?: boolean
  error?: string
}
type BrowserObservation = typeof window & {
  qaFocusOrigin?: HTMLElement
  qaFocusEvents?: Record<string, unknown>[]
  qaFocusCleanup?: () => void
}

export async function observeFocus(page: Page): Promise<FocusState> {
  return page.evaluate(() => {
    const observed = window as BrowserObservation
    const helpers = {
      describe(element: Element | null | undefined): ElementState {
        const style = element ? getComputedStyle(element) : null
        return {
          tag: element?.tagName ?? null,
          id: element?.id ?? null,
          role: element?.getAttribute('role') ?? null,
          className: element?.getAttribute('class') ?? null,
          text: element?.tagName === 'BODY' ? null : (element?.textContent?.trim().slice(0, 100) ?? null),
          connected: Boolean(element?.isConnected),
          disabled: Boolean(element?.matches(':disabled')),
          focusVisible: Boolean(element?.matches(':focus-visible')),
          outlineStyle: style?.outlineStyle ?? null,
          outlineWidth: style?.outlineWidth ?? null,
          outlineColor: style?.outlineColor ?? null,
          outlineOffset: style?.outlineOffset ?? null,
          boxShadow: style?.boxShadow ?? null,
        }
      },
    }
    return {
      documentFocused: document.hasFocus(),
      active: helpers.describe(document.activeElement),
      origin: helpers.describe(observed.qaFocusOrigin),
      composerFocused: document.activeElement?.id === 'assistant-message',
      originFocused: document.activeElement === observed.qaFocusOrigin,
      draft: (document.querySelector('#assistant-message') as HTMLTextAreaElement | null)?.value ?? '',
      trace: [...(observed.qaFocusEvents ?? [])],
    }
  })
}

export async function watchFocus(target: Locator) {
  await target.evaluate((element) => {
    const observed = window as BrowserObservation
    observed.qaFocusCleanup?.()
    observed.qaFocusOrigin = element as HTMLElement
    observed.qaFocusEvents = []
    const listeners = {
      record(event: Event) {
        const item = event.target instanceof Element ? event.target : null
        observed.qaFocusEvents?.push({
          type: event.type,
          at: performance.now(),
          documentFocused: document.hasFocus(),
          trusted: event.isTrusted,
          tag: item?.tagName ?? null,
          id: item?.id ?? null,
          origin: item === element,
          activeTag: document.activeElement?.tagName ?? null,
          activeId: document.activeElement?.id ?? null,
        })
      },
      cleanup() {
        for (const name of ['focusin', 'focusout', 'focus', 'blur', 'pointerdown'])
          window.removeEventListener(name, listeners.record, true)
      },
    }
    for (const name of ['focusin', 'focusout', 'focus', 'blur', 'pointerdown'])
      window.addEventListener(name, listeners.record, true)
    observed.qaFocusCleanup = listeners.cleanup
  })
}

/** Records all outcomes before reporting assertion failures. No production focus behavior is replaced. */
export async function residentHostFocusUiQa(page: Page, electron: ElectronApplication, directory: string) {
  const cases: CaseProof[] = []
  const proof: Record<string, unknown> = {
    boundary:
      'Held IPC and conversation-state overlay only in the disposable source copy. Review uses real local interactions.ask/AbortController plus synthetic expiry projection, not a host deadline. Production React focus behavior is unchanged for the baseline. All cases are recorded before final assertions.',
    cases,
    focusEmulationCommands: [],
  }
  const save = () => writeFileSync(join(directory, 'resident-host-focus-ui-proof.json'), JSON.stringify(proof, null, 2))
  let nativeCdp: CDPSession | null = null
  const control = async (action: 'clear' | 'review' | 'expire' | 'replaceJob') =>
    electron.evaluate((_, action) => (globalThis as FixtureGlobal).qaHostFocusUi[action](), action)
  const reset = async () => {
    await control('clear')
    await electron.evaluate(() => (globalThis as FixtureGlobal).qaHostExpiryUi.show())
    await page.reload()
    await disableFocusEmulation('after-reload')
    await page.locator('#assistant-message').waitFor()
    await (await electron.browserWindow(page)).evaluate((window) => {
      window.show()
      window.focus()
    })
    await waitFor(
      () => page.evaluate(() => document.hasFocus()),
      'The owned native test window must have focus',
      10_000
    )
  }
  const screenshot = async (name: string) => page.screenshot({ path: join(directory, `focus-${name}.png`) })
  const dispatchCounts = () => electron.evaluate(() => (globalThis as FixtureGlobal).qaHostExpiryUi.inspect())
  const nativeFocus = async () =>
    (await electron.browserWindow(page)).evaluate((window) => ({
      visible: window.isVisible(),
      focused: window.isFocused(),
      webContentsFocused: window.webContents.isFocused(),
    }))
  const disableFocusEmulation = async (stage: string) => {
    assert(nativeCdp)
    await nativeCdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
    ;(proof.focusEmulationCommands as unknown[]).push({
      stage,
      at: Date.now(),
      command: 'Emulation.setFocusEmulationEnabled',
      parameters: { enabled: false },
      documentFocused: await page.evaluate(() => document.hasFocus()),
      native: await nativeFocus(),
    })
  }
  const settle = async () => {
    await delay(250)
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    )
  }
  try {
    const focusBefore = { renderer: await observeFocus(page), native: await nativeFocus() }
    nativeCdp = await page.context().newCDPSession(page)
    await disableFocusEmulation('initial')
    proof.focusEmulation = {
      command: 'Emulation.setFocusEmulationEnabled',
      parameters: { enabled: false },
      scope:
        'Only this owned native QA page target; removes Playwright default emulation, does not replace document.hasFocus.',
      before: focusBefore,
      after: { renderer: await observeFocus(page), native: await nativeFocus() },
    }
    save()
    await reset()
    await page.setViewportSize({ width: 1100, height: 800 })
    await page.getByRole('status').filter({ hasText: 'The wait timed out. Stop is not yet confirmed.' }).waitFor()
    await screenshot('uncertain-standard-en')
    await page.evaluate(() => window.remember.updateSettings({ interfaceLanguage: 'nl' }))
    await page.setViewportSize({ width: 720, height: 800 })
    const dutchStatus = page
      .getByRole('status')
      .filter({ hasText: 'Wachttijd verlopen. Stoppen is nog niet bevestigd.' })
    await dutchStatus.waitFor()
    proof.narrowDutch = await dutchStatus.evaluate((element) => ({
      text: element.textContent,
      rect: element.getBoundingClientRect().toJSON(),
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }))
    await screenshot('uncertain-narrow-nl')
    save()
    const operations: Array<{ operation: Operation; outcome: 'success' | 'failure'; move?: 'composer' | 'blur' }> = [
      { operation: 'check', outcome: 'success' },
      { operation: 'check', outcome: 'failure' },
      { operation: 'stop', outcome: 'success' },
      { operation: 'stop', outcome: 'failure' },
      { operation: 'check', outcome: 'failure', move: 'composer' },
      { operation: 'stop', outcome: 'success', move: 'composer' },
      { operation: 'check', outcome: 'success', move: 'blur' },
    ]
    for (const input of operations) {
      const entry: CaseProof = { name: `${input.operation}-${input.outcome}-${input.move ?? 'owned'}` }
      let otherWindowId: number | null = null
      if (input.move === 'blur') {
        entry.name = `${input.operation}-${input.outcome}-owned-window-hidden`
        entry.focusLossMethod =
          'Hide only the owned QA BrowserWindow with Playwright focus emulation disabled; require document.hasFocus=false before returning. This does not establish another-app deactivation behavior.'
      }
      cases.push(entry)
      try {
        await reset()
        entry.draft = `Unsent draft: ${entry.name}`
        await page.locator('#assistant-message').fill(entry.draft)
        const target = page.getByRole('button', {
          name: input.operation === 'check' ? /^(Status controleren|Check status)$/ : /^(Stoppen|Stop)$/,
        })
        await target.waitFor()
        await target.focus()
        await target.press('Tab')
        await page.keyboard.press('Shift+Tab')
        await watchFocus(target)
        entry.before = await observeFocus(page)
        await electron.evaluate(
          (_, operation) => (globalThis as FixtureGlobal).qaHostFocusUi.arm(operation),
          input.operation
        )
        await target.press('Enter')
        await waitFor(
          async () =>
            (await electron.evaluate(() => (globalThis as FixtureGlobal).qaHostFocusUi.inspect())).pending ===
            input.operation,
          'The synthetic native IPC must actually be held'
        )
        await waitFor(
          () => target.isDisabled(),
          'The initiating action must be disabled during the real pending renderer state'
        )
        entry.pending = await observeFocus(page)
        if (input.move === 'composer') await page.locator('#assistant-message').focus()
        if (input.move === 'blur') {
          await disableFocusEmulation('before-native-hide')
          await (await electron.browserWindow(page)).evaluate((window) => window.hide())
          await delay(250)
          entry.hideDiagnostic = {
            renderer: await observeFocus(page),
            native: await nativeFocus(),
          }
          if (await page.evaluate(() => document.hasFocus())) {
            entry.name = `${input.operation}-${input.outcome}-owned-other-window`
            entry.focusLossMethod =
              'Native hide did not remove document focus, so use a separate inert owned QA BrowserWindow. This does not establish another-app deactivation behavior.'
            await (await electron.browserWindow(page)).evaluate((window) => {
              window.show()
              window.focus()
            })
            otherWindowId = await electron.evaluate(async ({ BrowserWindow }) => {
              const other = new BrowserWindow({
                width: 240,
                height: 160,
                show: false,
                webPreferences: { nodeIntegration: false, contextIsolation: true },
              })
              await other.loadURL(
                'data:text/html,<title>Owned QA focus target</title><p>Inert native focus fixture</p>'
              )
              other.show()
              other.focus()
              return other.id
            })
            entry.nativeFocus = await electron.evaluate(
              ({ BrowserWindow }, otherId) =>
                BrowserWindow.getAllWindows().map((window) => ({
                  id: window.id,
                  other: window.id === otherId,
                  visible: window.isVisible(),
                  focused: window.isFocused(),
                  webContentsFocused: window.webContents.isFocused(),
                })),
              otherWindowId
            )
          }
          await waitFor(
            () => page.evaluate(() => !document.hasFocus()),
            'The owned native hide or inert-window transition must actually remove focus from the chat document',
            10_000
          )
        }
        if (input.move) entry.moved = await observeFocus(page)
        save()
        if (input.move !== 'blur') await screenshot(`${entry.name}-pending`)
        await electron.evaluate(
          (_, outcome) => (globalThis as FixtureGlobal).qaHostFocusUi.release(outcome),
          input.outcome
        )
        if (input.move === 'blur') await delay(350)
        else await settle()
        entry.settled = await observeFocus(page)
        if (input.move === 'blur') {
          await (await electron.browserWindow(page)).evaluate((window) => {
            window.show()
            window.focus()
          })
          await waitFor(
            () => page.evaluate(() => document.hasFocus()),
            'The owned native window must regain focus',
            10_000
          )
          await settle()
          entry.returned = await observeFocus(page)
        }
        const terminal = input.operation === 'stop' && input.outcome === 'success'
        entry.expected =
          input.move === 'blur'
            ? 'No focus restoration while the owned chat document lacks native focus or delayed on return'
            : input.move === 'composer' || terminal
              ? 'Composer retains or receives visible keyboard focus'
              : 'Same available action regains visible keyboard focus'
        const sameElement = (first: FocusState | undefined, second: FocusState | undefined) =>
          first &&
          second &&
          ['tag', 'id', 'role', 'text'].every(
            (key) => first.active[key as keyof ElementState] === second.active[key as keyof ElementState]
          )
        entry.pass = Boolean(
          entry.before.documentFocused &&
            entry.before.originFocused &&
            entry.before.draft === entry.draft &&
            entry.settled.draft === entry.draft &&
            (!entry.returned || entry.returned.draft === entry.draft) &&
            (input.move === 'blur'
              ? !entry.settled.documentFocused &&
                sameElement(entry.moved, entry.settled) &&
                sameElement(entry.moved, entry.returned)
              : entry.settled.documentFocused &&
                entry.settled.active.focusVisible &&
                (input.move === 'composer' || terminal ? entry.settled.composerFocused : entry.settled.originFocused))
        )
        await screenshot(`${entry.name}-settled`)
      } catch (error) {
        entry.error = error instanceof Error ? error.message : String(error)
        entry.pass = false
      } finally {
        if (otherWindowId !== null) {
          await electron.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(), otherWindowId)
        }
      }
      save()
    }
    for (const scenario of ['stop-job-replaced', 'check-pointer-blank'] as const) {
      const entry: CaseProof = { name: scenario, draft: `Unsent draft: ${scenario}` }
      cases.push(entry)
      try {
        await reset()
        await page.locator('#assistant-message').fill(entry.draft ?? '')
        const target = page.getByRole('button', {
          name: scenario === 'stop-job-replaced' ? /^(Stoppen|Stop)$/ : /^(Status controleren|Check status)$/,
        })
        await target.waitFor()
        await target.focus()
        await target.press('Tab')
        await page.keyboard.press('Shift+Tab')
        await watchFocus(target)
        entry.before = await observeFocus(page)
        entry.operationCountsBefore = await dispatchCounts()
        if (scenario === 'stop-job-replaced') {
          entry.expected =
            'A different job must not inherit focus on its Stop action; move to composer without dispatch'
          await control('replaceJob')
          await page.getByText('Synthetic replacement job; no driver or action.', { exact: true }).waitFor()
        } else {
          entry.expected = 'Trusted pointer selection of blank nonfocusable chat space cancels Check focus restoration'
          await electron.evaluate(() => (globalThis as FixtureGlobal).qaHostFocusUi.arm('check'))
          await target.press('Enter')
          await waitFor(
            async () =>
              (await electron.evaluate(() => (globalThis as FixtureGlobal).qaHostFocusUi.inspect())).pending ===
              'check',
            'The pointer case must hold its actual Check IPC'
          )
          entry.pending = await observeFocus(page)
          const article = await page.getByRole('article').last().boundingBox()
          const composer = await page.locator('#assistant-message').boundingBox()
          assert(article && composer && composer.y > article.y + article.height + 12)
          const point = { x: article.x + 12, y: (article.y + article.height + composer.y) / 2 }
          const hit = await page.evaluate(({ x, y }) => {
            const element = document.elementFromPoint(x, y)
            const ancestor = element?.closest('[tabindex]')
            return {
              tag: element?.tagName,
              role: element?.getAttribute('role'),
              directFocusable: Boolean(element?.matches('button,input,textarea,select,a[href],[tabindex]')),
              interactiveAncestor: Boolean(element?.closest('button,input,textarea,select,a[href]')),
              tabindexAncestor: ancestor
                ? {
                    tag: ancestor.tagName,
                    id: ancestor.id,
                    role: ancestor.getAttribute('role'),
                    tabindex: ancestor.getAttribute('tabindex'),
                  }
                : null,
            }
          }, point)
          entry.pointerTarget = { ...point, ...hit }
          assert.equal(
            hit.directFocusable,
            false,
            'The directly clicked blank chat element must not be a focusable control'
          )
          assert.equal(hit.interactiveAncestor, false, 'The blank click must not activate a button, input or link')
          await page.mouse.click(point.x, point.y)
          entry.moved = await observeFocus(page)
          entry.expected = `Keep the actual intentional pointer focus on ${entry.moved.active.tag}#${entry.moved.active.id}; never restore Check`
          save()
          await electron.evaluate(() => (globalThis as FixtureGlobal).qaHostFocusUi.release('success'))
        }
        await settle()
        entry.settled = await observeFocus(page)
        entry.operationCountsAfter = await dispatchCounts()
        entry.pass = Boolean(
          entry.before.documentFocused &&
            entry.before.originFocused &&
            entry.before.draft === entry.draft &&
            entry.settled.draft === entry.draft &&
            entry.settled.documentFocused &&
            (scenario === 'stop-job-replaced'
              ? entry.settled.composerFocused &&
                entry.settled.active.focusVisible &&
                JSON.stringify(entry.operationCountsBefore) === JSON.stringify(entry.operationCountsAfter)
              : !entry.settled.originFocused &&
                entry.settled.active.tag === entry.moved?.active.tag &&
                entry.settled.active.id === entry.moved?.active.id &&
                entry.moved?.trace.some((event) => event.type === 'pointerdown' && event.trusted === true))
        )
        await screenshot(`${entry.name}-settled`)
      } catch (error) {
        entry.error = error instanceof Error ? error.message : String(error)
        entry.pass = false
      }
      save()
    }
    for (const origin of ['button', 'preview', 'composer'] as const) {
      const entry: CaseProof = {
        name: `review-expiry-${origin}`,
        expected:
          origin === 'composer' ? 'Composer focus remains untouched' : 'Removed review focus moves to the composer',
      }
      cases.push(entry)
      try {
        await reset()
        entry.draft = `Unsent draft: ${entry.name}`
        await page.locator('#assistant-message').fill(entry.draft)
        await control('review')
        const form = page.getByRole('form', { name: /^(Vraag van Codex|Question from Codex)$/ })
        await form.waitFor()
        const target =
          origin === 'preview' ? form.getByRole('region') : form.getByRole('button', { name: /^(Save|Bewaren)$/ })
        await target.focus()
        await target.press('Tab')
        await page.keyboard.press('Shift+Tab')
        await watchFocus(target)
        entry.before = await observeFocus(page)
        if (origin === 'composer') {
          await page.locator('#assistant-message').focus()
          entry.moved = await observeFocus(page)
        }
        save()
        await screenshot(`${entry.name}-pending`)
        await control('expire')
        await form.waitFor({ state: 'hidden' })
        await settle()
        entry.settled = await observeFocus(page)
        entry.pass =
          entry.before.documentFocused &&
          entry.before.originFocused &&
          entry.before.draft === entry.draft &&
          entry.settled.draft === entry.draft &&
          entry.settled.documentFocused &&
          entry.settled.composerFocused &&
          entry.settled.active.focusVisible
        await screenshot(`${entry.name}-settled`)
      } catch (error) {
        entry.error = error instanceof Error ? error.message : String(error)
        entry.pass = false
      }
      save()
    }
    proof.metrics = await electron.evaluate(() => (globalThis as FixtureGlobal).qaHostFocusUi.inspect())
    proof.visibleFocusFailures = cases
      .filter((entry) => {
        const settled = entry.settled
        if (!settled?.originFocused || settled.active.tag !== 'BUTTON' || !settled.active.focusVisible) return false
        return settled.active.outlineStyle === 'none' || Number.parseFloat(settled.active.outlineWidth ?? '0') <= 0
      })
      .map((entry) => `${entry.name}-visible-focus-indicator`)
    proof.visiblePreviewFocusFailures = cases
      .filter((entry) => {
        if (entry.name !== 'review-expiry-preview') return false
        const before = entry.before
        return (
          !before?.originFocused ||
          before.active.tag !== 'PRE' ||
          before.active.role !== 'region' ||
          !before.active.focusVisible ||
          before.active.outlineStyle === 'none' ||
          !(Number.parseFloat(before.active.outlineWidth ?? '0') > 0)
        )
      })
      .map((entry) => `${entry.name}-visible-preview-focus-indicator`)
    proof.failures = [
      ...cases.filter((entry) => !entry.pass).map((entry) => entry.name),
      ...(proof.visibleFocusFailures as string[]),
      ...(proof.visiblePreviewFocusFailures as string[]),
    ]
    const layout = proof.narrowDutch as {
      documentWidth: number
      viewportWidth: number
      clientWidth: number
      scrollWidth: number
    }
    if (layout.documentWidth > layout.viewportWidth || layout.scrollWidth > layout.clientWidth + 1)
      (proof.failures as string[]).push('dutch-narrow-overflow')
    proof.status = (proof.failures as string[]).length ? 'failed' : 'passed'
  } finally {
    await control('clear')
    await electron.evaluate(() => (globalThis as FixtureGlobal).qaHostExpiryUi.clear())
    await nativeCdp?.detach()
    save()
  }
  return proof
}
