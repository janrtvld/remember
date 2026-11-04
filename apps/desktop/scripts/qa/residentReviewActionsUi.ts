import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { AgentInteraction, AgentInteractionAnswer } from '@remember/shared'
import type { ElectronApplication, Locator, Page } from 'playwright-core'
import { observeFocus, watchFocus } from './residentHostFocusUi'
import { waitFor } from './residentHostReview'

export type ActionLedger = {
  request: AgentInteraction | null
  pending: AgentInteractionAnswer | null
  attempts: AgentInteractionAnswer[]
  dispatched: AgentInteractionAnswer[]
  resolved: AgentInteractionAnswer[]
  rejected: number
  duplicateAttempts: number
}
export type ActionFixture = {
  begin(name: string): AgentInteraction
  arm(): void
  release(outcome: 'failure' | 'success'): void
  clear(): void
  inspect(): ActionLedger
}
type FixtureGlobal = typeof globalThis & {
  qaReviewActionsUi: ActionFixture
  qaHostExpiryUi: { show(): void; clear(): void }
}

/** Installs a pre-dispatch fault gate only in the runner's disposable source copy. */
export function installReviewActionsUiFixture(directory: string) {
  assert.notEqual(resolve(directory), resolve(import.meta.dirname, '../..'))
  const file = join(directory, 'src/main/residentAgentRuntime.ts')
  const source = readFileSync(file, 'utf8')
  const marker = '  Object.assign(globalThis, { qaHostFocusUi:'
  assert.equal(source.split(marker).length, 2, 'Review actions fixture requires the installed focus overlay')
  writeFileSync(
    file,
    source.replace(
      marker,
      `  type QaReviewAnswer = import('@remember/shared').AgentInteractionAnswer
  const qaOriginalAnswer = interactions.answer.bind(interactions)
  let qaActionRequest: import('@remember/shared').AgentInteraction | null = null
  let qaActionAbort: AbortController | null = null
  let qaActionArmed = false
  let qaActionHeld: { answer: QaReviewAnswer; resolve: () => void; reject: (error: Error) => void } | null = null
  let qaActionAttempts: QaReviewAnswer[] = []
  let qaActionDispatched: QaReviewAnswer[] = []
  let qaActionResolved: QaReviewAnswer[] = []
  let qaActionRejected = 0
  let qaActionDuplicates = 0
  interactions.answer = (raw: unknown) => {
    if (!qaActionRequest) return qaOriginalAnswer(raw)
    const answer = structuredClone(raw) as QaReviewAnswer
    qaActionAttempts.push(answer)
    if (answer?.id !== qaActionRequest.id) throw new Error('qa-review-unexpected-request')
    if (qaActionHeld) { qaActionDuplicates += 1; throw new Error('qa-review-duplicate-pending') }
    if (!qaActionArmed) throw new Error('qa-review-answer-not-armed')
    qaActionArmed = false
    return new Promise<void>((resolve, reject) => { qaActionHeld = { answer, resolve, reject } })
  }
  Object.assign(globalThis, { qaReviewActionsUi: {
    begin(name: string) {
      if (qaActionRequest || qaActionHeld || !qaExpiryOverlay?.hostJob) throw new Error('qa-review-invalid-begin')
      const id = qaExpiryOverlay.hostJob.messageId
      qaExpiryOverlay = { ...qaExpiryOverlay, activeTurnId: id,
        hostJob: { messageId: id, phase: 'waiting', connection: 'connected' } }
      qaActionAbort = new AbortController()
      qaActionAttempts = []; qaActionDispatched = []; qaActionResolved = []
      qaActionRejected = 0; qaActionDuplicates = 0
      void interactions.ask({ turnId: id, title: 'Synthetic review actions',
        detail: 'Revision: qa-review-revision-1\\nSynthetic local review for ' + name + '. No page, host or external write.',
        fields: [{ id: 'note', label: 'Review note', required: true }, { id: 'target', label: 'Review target', required: false }],
        actions: [{ id: 'accept', label: 'Save' }, { id: 'decline', label: 'Cancel' }] }, qaActionAbort.signal)
        .then(answer => { qaActionResolved.push(structuredClone(answer)) }, () => {})
      qaActionRequest = interactions.list().find(request => request.turnId === id && request.title === 'Synthetic review actions') ?? null
      if (!qaActionRequest) throw new Error('qa-review-request-missing')
      qaExpiryChanged()
      return structuredClone(qaActionRequest)
    },
    arm() {
      if (!qaActionRequest || qaActionArmed || qaActionHeld) throw new Error('qa-review-invalid-arm')
      qaActionArmed = true
    },
    release(outcome: 'failure' | 'success') {
      const held = qaActionHeld
      if (!held) throw new Error('qa-review-not-pending')
      qaActionHeld = null
      if (outcome === 'failure') {
        qaActionRejected += 1
        held.reject(new Error('qa-review-before-dispatch-rejected'))
        return
      }
      try {
        qaOriginalAnswer(held.answer)
        qaActionDispatched.push(structuredClone(held.answer))
        held.resolve()
      } catch (error) { held.reject(error instanceof Error ? error : new Error(String(error))) }
    },
    clear() {
      qaActionHeld?.reject(new Error('qa-review-cleanup')); qaActionHeld = null
      qaActionAbort?.abort(); qaActionAbort = null; qaActionRequest = null; qaActionArmed = false
    },
    inspect() { return structuredClone({ request: qaActionRequest, pending: qaActionHeld?.answer ?? null,
      attempts: qaActionAttempts, dispatched: qaActionDispatched, resolved: qaActionResolved,
      rejected: qaActionRejected, duplicateAttempts: qaActionDuplicates }) },
  } })
${marker}`
    )
  )
}

type FormState = {
  focus: Awaited<ReturnType<typeof observeFocus>>
  focusedFieldIndex: number
  values: Record<string, string>
  buttons: { text: string | null; disabled: boolean }[]
  inputs: { value: string; disabled: boolean }[]
  alerts: number
  activeVisibility: {
    rect: { top: number; left: number; right: number; bottom: number }
    clip: { top: number; left: number; right: number; bottom: number }
    outlineBounds: { top: number; left: number; right: number; bottom: number }
    outlineFullyVisible: boolean
    fullyVisible: boolean
    hitTarget: string | null
    hitOwned: boolean
  }
  preview: string | null
  ledger: ActionLedger
}
type CaseProof = {
  name: string
  action: 'accept' | 'decline'
  request?: AgentInteraction
  values?: Record<string, string>
  draft?: string
  before?: FormState
  pending?: FormState
  moved?: FormState
  afterInputEnter?: FormState
  rejected?: FormState
  retryPending?: FormState
  returned?: FormState
  nativeHidden?: unknown
  nativeReturned?: unknown
  completed?: {
    focus: Awaited<ReturnType<typeof observeFocus>>
    ledger: ActionLedger
    remainingRequests: AgentInteraction[]
    savedResults: number
  }
  assertions?: Record<string, boolean>
  error?: string
  pass?: boolean
}

/** Uses real local asks and renderer IPC, but never a host tool or a saved-page write. */
export async function residentReviewActionsUiQa(page: Page, electron: ElectronApplication, directory: string) {
  const cases: CaseProof[] = []
  const proof: Record<string, unknown> = {
    boundary:
      'Disposable pre-dispatch answerAgentInteraction fault gate; real local interactions.ask resolves only after explicit successful retry. No lost ACK, provider, host tool, memory write or saved-result claim. Inputs are not edited while pending; retry must retain the exact request/action/values. All failures are saved before assertions.',
    cases,
    focusEmulationCommands: [],
  }
  const save = () =>
    writeFileSync(join(directory, 'resident-review-actions-ui-proof.json'), JSON.stringify(proof, null, 2))
  const command = (action: 'clear' | 'arm') =>
    electron.evaluate((_, action) => (globalThis as FixtureGlobal).qaReviewActionsUi[action](), action)
  const ledger = () => electron.evaluate(() => (globalThis as FixtureGlobal).qaReviewActionsUi.inspect())
  const cdp = await page.context().newCDPSession(page)
  const screenshot = (name: string) => page.screenshot({ path: join(directory, `review-actions-${name}.png`) })
  const settle = async () => {
    await delay(200)
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    )
  }
  const snapshot = async (form: Locator): Promise<FormState> => ({
    focus: await observeFocus(page),
    focusedFieldIndex: await form.evaluate((element) =>
      document.activeElement
        ? Array.from<Element>(element.querySelectorAll('input')).indexOf(document.activeElement)
        : -1
    ),
    values: {
      note: await form.getByLabel('Review note', { exact: true }).inputValue(),
      target: await form.getByLabel('Review target', { exact: true }).inputValue(),
    },
    buttons: await form
      .getByRole('button')
      .evaluateAll((elements) =>
        elements.map((element) => ({ text: element.textContent, disabled: (element as HTMLButtonElement).disabled }))
      ),
    inputs: await form.locator('input').evaluateAll((elements) =>
      elements.map((element) => ({
        value: (element as HTMLInputElement).value,
        disabled: (element as HTMLInputElement).disabled,
      }))
    ),
    activeVisibility: await page.evaluate(() => {
      const active = document.activeElement
      const rect = active?.getBoundingClientRect() ?? new DOMRect()
      const clip = { top: 0, left: 0, right: innerWidth, bottom: innerHeight }
      for (let parent = active?.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent)
        const bounds = parent.getBoundingClientRect()
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
          clip.left = Math.max(clip.left, bounds.left + parent.clientLeft)
          clip.right = Math.min(clip.right, bounds.left + parent.clientLeft + parent.clientWidth)
        }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
          clip.top = Math.max(clip.top, bounds.top + parent.clientTop)
          clip.bottom = Math.min(clip.bottom, bounds.top + parent.clientTop + parent.clientHeight)
        }
      }
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      const style = active ? getComputedStyle(active) : null
      const outlineExtent = Math.max(
        0,
        Number.parseFloat(style?.outlineWidth ?? '0') + Number.parseFloat(style?.outlineOffset ?? '0')
      )
      const outlineBounds = {
        top: rect.top - outlineExtent,
        left: rect.left - outlineExtent,
        right: rect.right + outlineExtent,
        bottom: rect.bottom + outlineExtent,
      }
      return {
        rect: { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom },
        clip,
        outlineBounds,
        outlineFullyVisible:
          outlineExtent > 0 &&
          outlineBounds.top >= clip.top &&
          outlineBounds.left >= clip.left &&
          outlineBounds.right <= clip.right &&
          outlineBounds.bottom <= clip.bottom,
        fullyVisible:
          rect.width > 0 &&
          rect.height > 0 &&
          rect.top >= clip.top &&
          rect.left >= clip.left &&
          rect.right <= clip.right &&
          rect.bottom <= clip.bottom,
        hitTarget: hit?.tagName ?? null,
        hitOwned: Boolean(active && hit && (hit === active || active.contains(hit))),
      }
    }),
    alerts: await form.getByRole('alert').count(),
    preview: await form.locator('pre').textContent(),
    ledger: await ledger(),
  })
  const inputs = [
    { action: 'accept', move: 'owned' },
    { action: 'decline', move: 'owned' },
    { action: 'accept', move: 'field-enter-busy' },
    { action: 'decline', move: 'composer' },
    { action: 'accept', move: 'owned-window-hidden' },
  ] as const
  try {
    await page.setViewportSize({ width: 720, height: 800 })
    for (const input of inputs) {
      const entry: CaseProof = { name: `${input.action}-${input.move}`, action: input.action }
      cases.push(entry)
      try {
        await command('clear')
        await electron.evaluate(() => (globalThis as FixtureGlobal).qaHostExpiryUi.show())
        await page.reload()
        await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
        ;(proof.focusEmulationCommands as unknown[]).push({
          stage: entry.name,
          command: 'Emulation.setFocusEmulationEnabled',
          parameters: { enabled: false },
          at: Date.now(),
        })
        await page.locator('#assistant-message').waitFor()
        await (await electron.browserWindow(page)).evaluate((window) => {
          window.show()
          window.focus()
        })
        await waitFor(
          () => page.evaluate(() => document.hasFocus()),
          'The review-action test window must have real focus',
          10_000
        )
        entry.request = await electron.evaluate(
          (_, name) => (globalThis as FixtureGlobal).qaReviewActionsUi.begin(name),
          entry.name
        )
        const form = page.getByRole('form', { name: /^(Vraag van Codex|Question from Codex)$/ })
        await form.waitFor()
        entry.values = { note: `Prepared decision: ${entry.name}`, target: 'Personal/qa-only' }
        entry.draft = `Unsent draft: ${entry.name}`
        await page.locator('#assistant-message').fill(entry.draft)
        await form.getByLabel('Review note', { exact: true }).fill(entry.values.note)
        await form.getByLabel('Review target', { exact: true }).fill(entry.values.target)
        const button = form.getByRole('button', {
          name: input.action === 'accept' ? /^(Save|Bewaren)$/ : /^(Cancel|Annuleren)$/,
        })
        await button.focus()
        await button.press('Tab')
        await page.keyboard.press('Shift+Tab')
        await watchFocus(button)
        entry.before = await snapshot(form)
        await command('arm')
        await button.press('Enter')
        await waitFor(
          async () => Boolean((await ledger()).pending),
          'The review answer IPC must be held before any dispatch'
        )
        await waitFor(
          () => button.isDisabled(),
          'The initiating review action must disable while its answer is pending'
        )
        entry.pending = await snapshot(form)
        if (input.move === 'field-enter-busy') {
          const field = form.getByLabel('Review note', { exact: true })
          await field.focus()
          entry.moved = await snapshot(form)
          await field.press('Enter')
          await settle()
          entry.afterInputEnter = await snapshot(form)
        } else if (input.move === 'composer') {
          await page.locator('#assistant-message').focus()
          entry.moved = await snapshot(form)
        }
        if (input.move === 'owned-window-hidden') {
          await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
          ;(proof.focusEmulationCommands as unknown[]).push({
            stage: 'before-child-hide',
            command: 'Emulation.setFocusEmulationEnabled',
            parameters: { enabled: false },
            at: Date.now(),
          })
          await (await electron.browserWindow(page)).evaluate((window) => window.hide())
          await waitFor(
            () => page.evaluate(() => !document.hasFocus()),
            'Own hidden window must remove real document focus',
            10_000
          )
          entry.nativeHidden = await (await electron.browserWindow(page)).evaluate((window) => ({
            visible: window.isVisible(),
            focused: window.isFocused(),
            webContentsFocused: window.webContents.isFocused(),
          }))
          entry.moved = await snapshot(form)
        }
        save()
        if (input.move !== 'owned-window-hidden') await screenshot(`${entry.name}-pending`)
        if (entry.name === 'accept-owned') {
          await page.setViewportSize({ width: 1100, height: 800 })
          await screenshot(`${entry.name}-pending-standard`)
          await page.setViewportSize({ width: 720, height: 800 })
        }
        await electron.evaluate(() => (globalThis as FixtureGlobal).qaReviewActionsUi.release('failure'))
        await form.getByRole('alert').waitFor()
        await waitFor(() => button.isEnabled(), 'A rejected pre-dispatch answer must permit an explicit retry')
        if (input.move === 'owned-window-hidden') await delay(350)
        else await settle()
        entry.rejected = await snapshot(form)
        save()
        if (input.move === 'owned-window-hidden') {
          await (await electron.browserWindow(page)).evaluate((window) => {
            window.show()
            window.focus()
          })
          await waitFor(
            () => page.evaluate(() => document.hasFocus()),
            'Own window must regain real document focus',
            10_000
          )
          await settle()
          entry.returned = await snapshot(form)
          entry.nativeReturned = await (await electron.browserWindow(page)).evaluate((window) => ({
            visible: window.isVisible(),
            focused: window.isFocused(),
            webContentsFocused: window.webContents.isFocused(),
          }))
          save()
        }
        await screenshot(`${entry.name}-rejected`)
        if (entry.name === 'accept-owned') {
          await page.setViewportSize({ width: 1100, height: 800 })
          await screenshot(`${entry.name}-rejected-standard`)
          await page.setViewportSize({ width: 720, height: 800 })
        }
        await button.focus()
        await button.press('Tab')
        await page.keyboard.press('Shift+Tab')
        await command('arm')
        await button.press('Enter')
        await waitFor(async () => Boolean((await ledger()).pending), 'Explicit retry must await the same held gate')
        entry.retryPending = await snapshot(form)
        save()
        await electron.evaluate(() => (globalThis as FixtureGlobal).qaReviewActionsUi.release('success'))
        await form.waitFor({ state: 'hidden' })
        await waitFor(
          async () => (await ledger()).resolved.length === 1,
          'The real local ask must resolve exactly once'
        )
        await settle()
        entry.completed = {
          focus: await observeFocus(page),
          ledger: await ledger(),
          remainingRequests: await page.evaluate(() => window.remember.getAgentInteractions()),
          savedResults: await page.getByRole('list', { name: /^(Opgeslagen pagina's|Saved pages)$/ }).count(),
        }
        const expected = { id: entry.request.id, action: entry.action, values: entry.values }
        const identical = (first: unknown, second: unknown) => JSON.stringify(first) === JSON.stringify(second)
        entry.assertions = {
          initiatorOwnedFocus: entry.before.focus.documentFocused && entry.before.focus.originFocused,
          actionsDisabled:
            entry.pending.buttons.length === 2 && entry.pending.buttons.every((button) => button.disabled),
          rejectedActionsEnabled:
            entry.rejected.buttons.length === 2 && entry.rejected.buttons.every((button) => !button.disabled),
          singleInlineError: entry.rejected.alerts === 1,
          noDispatchBeforeRetry:
            entry.rejected.ledger.dispatched.length === 0 && entry.rejected.ledger.resolved.length === 0,
          oneRejectedAttempt:
            identical(entry.rejected.ledger.attempts, [expected]) && entry.rejected.ledger.rejected === 1,
          sameRequestPreviewValues: [entry.pending, entry.rejected, entry.retryPending].every(
            (state) =>
              identical(state.ledger.request, entry.request) &&
              identical(state.values, entry.values) &&
              state.preview === entry.before?.preview
          ),
          draftRetained:
            [entry.before, entry.pending, entry.rejected, entry.retryPending].every(
              (state) => state.focus.draft === entry.draft
            ) && entry.completed.focus.draft === entry.draft,
          hiddenWindowDoesNotRestore:
            input.move !== 'owned-window-hidden' ||
            (entry.moved?.focus.documentFocused === false &&
              entry.rejected.focus.documentFocused === false &&
              !entry.rejected.focus.originFocused &&
              entry.returned?.focus.documentFocused === true &&
              !entry.returned.focus.originFocused &&
              entry.returned.focus.active.tag === entry.rejected.focus.active.tag &&
              entry.returned.focus.draft === entry.draft),
          rejectedFocus:
            input.move === 'owned-window-hidden' ||
            (entry.rejected.focus.documentFocused &&
              (input.move === 'owned'
                ? entry.rejected.focus.originFocused && entry.rejected.focus.active.focusVisible
                : input.move === 'composer'
                  ? entry.rejected.focus.composerFocused
                  : entry.rejected.focus.active.tag === 'INPUT' &&
                    entry.rejected.focusedFieldIndex >= 0 &&
                    entry.rejected.focusedFieldIndex === entry.moved?.focusedFieldIndex)),
          rejectedOwnedIndicator:
            input.move !== 'owned' ||
            (entry.rejected.focus.active.outlineStyle === 'solid' &&
              Number.parseFloat(entry.rejected.focus.active.outlineWidth ?? '0') >= 2 &&
              Number.parseFloat(entry.rejected.focus.active.outlineOffset ?? '0') >= 2),
          rejectedOwnedVisible:
            input.move !== 'owned' ||
            (entry.rejected.activeVisibility.fullyVisible && entry.rejected.activeVisibility.hitOwned),
          rejectedOwnedOutlineUnclipped: input.move !== 'owned' || entry.rejected.activeVisibility.outlineFullyVisible,
          noDuplicateInputEnter:
            !entry.afterInputEnter ||
            (entry.afterInputEnter.ledger.attempts.length === 1 &&
              entry.afterInputEnter.ledger.duplicateAttempts === 0),
          explicitIdenticalRetry:
            identical(entry.retryPending.ledger.attempts, [expected, expected]) &&
            entry.retryPending.ledger.dispatched.length === 0,
          oneRealResolution:
            identical(entry.completed.ledger.dispatched, [expected]) &&
            identical(entry.completed.ledger.resolved, [expected]) &&
            entry.completed.ledger.duplicateAttempts === 0,
          removedReviewReturnsToComposer:
            entry.completed.focus.documentFocused &&
            entry.completed.focus.composerFocused &&
            entry.completed.focus.active.focusVisible,
          noRequestOrSavedResult: entry.completed.remainingRequests.length === 0 && entry.completed.savedResults === 0,
        }
        entry.pass = Object.values(entry.assertions).every(Boolean)
        await screenshot(`${entry.name}-completed`)
      } catch (error) {
        entry.error = error instanceof Error ? error.message : String(error)
        entry.pass = false
      }
      save()
    }
    proof.failures = cases.flatMap((entry) =>
      entry.error
        ? [`${entry.name}: ${entry.error}`]
        : Object.entries(entry.assertions ?? {})
            .filter(([, passed]) => !passed)
            .map(([name]) => `${entry.name}: ${name}`)
    )
    proof.status = cases.every((entry) => entry.pass) ? 'passed' : 'failed'
  } finally {
    await command('clear')
    await electron.evaluate(() => (globalThis as FixtureGlobal).qaHostExpiryUi.clear())
    await cdp.detach()
    save()
  }
  return proof
}
