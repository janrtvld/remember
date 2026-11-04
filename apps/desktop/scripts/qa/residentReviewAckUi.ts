import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { AgentInteraction, AgentInteractionAnswer } from '@remember/shared'
import type { ElectronApplication, Page } from 'playwright-core'
import { observeFocus } from './residentHostFocusUi'
import { waitFor } from './residentHostReview'
import type { ActionFixture } from './residentReviewActionsUi'

type AckLedger = {
  accepted: boolean
  lostAcks: number
  suppressed: { requestId: string; at: number }[]
  replacement: AgentInteraction | null
  replacementResolved: AgentInteractionAnswer[]
  reads: { requestId: string; senderId: number; outcome: 'held' | 'failure' | 'success' }[]
  readPending: boolean
}
type FixtureGlobal = typeof globalThis & {
  qaReviewActionsUi: ActionFixture
  qaHostExpiryUi: { show(): void; clear(): void }
  qaReviewAckUi: {
    accept(suppressOwnChange: boolean, replace: boolean): void
    loseAck(): void
    armRead(senderId: number): void
    releaseRead(outcome: 'failure' | 'success'): void
    currentRequests(): AgentInteraction[]
    clear(): void
    inspect(): AckLedger
  }
}

/** Only drops the notification synchronously emitted by an owned synthetic answer. */
export function installReviewAckUiFixture(directory: string) {
  assert.notEqual(resolve(directory), resolve(import.meta.dirname, '../..'))
  const runtimeFile = join(directory, 'src/main/residentAgentRuntime.ts')
  const runtime = readFileSync(runtimeFile, 'utf8')
  const marker = '  Object.assign(globalThis, { qaReviewActionsUi: {'
  assert.equal(runtime.split(marker).length, 2)
  writeFileSync(
    runtimeFile,
    runtime.replace(
      marker,
      `  let qaAckAccepted = false
  let qaAckLost = 0
  let qaAckNotificationScope: string | null = null
  let qaAckSuppressed: { requestId: string; at: number }[] = []
  let qaAckReplacement: import('@remember/shared').AgentInteraction | null = null
  let qaAckReplacementAbort: AbortController | null = null
  let qaAckReplacementResolved: QaReviewAnswer[] = []
  let qaReadSender: number | null = null
  let qaReadHeld: { resolve: (requests: import('@remember/shared').AgentInteraction[]) => void; reject: (error: Error) => void; index: number } | null = null
  let qaReads: { requestId: string; senderId: number; outcome: 'held' | 'failure' | 'success' }[] = []
  Object.assign(globalThis, { qaReviewAckUi: {
    armRead(senderId: number) {
      if (!qaActionRequest || qaReadHeld || qaReadSender !== null || !Number.isSafeInteger(senderId)) throw new Error('qa-read-invalid-arm')
      qaReadSender = senderId
    },
    interceptRead(senderId: number) {
      if (qaReadSender === null || senderId !== qaReadSender) return null
      if (!qaActionRequest || qaReadHeld) throw new Error('qa-read-invalid-intercept')
      qaReadSender = null
      const index = qaReads.length
      qaReads.push({ requestId: qaActionRequest.id, senderId, outcome: 'held' })
      return new Promise<import('@remember/shared').AgentInteraction[]>((resolve, reject) => { qaReadHeld = { resolve, reject, index } })
    },
    releaseRead(outcome: 'failure' | 'success') {
      const held = qaReadHeld
      if (!held) throw new Error('qa-read-not-held')
      qaReadHeld = null
      qaReads[held.index].outcome = outcome
      if (outcome === 'failure') held.reject(new Error('qa-review-status-unavailable'))
      else held.resolve(structuredClone(interactions.list()))
    },
    currentRequests() { return structuredClone(interactions.list()) },
    accept(suppressOwnChange: boolean, replace: boolean) {
      const held = qaActionHeld
      if (!held || !qaActionRequest || qaAckAccepted || held.answer.id !== qaActionRequest.id) throw new Error('qa-ack-invalid-accept')
      if (!interactions.list().some(request => request.id === held.answer.id)) throw new Error('qa-ack-request-not-pending')
      qaAckNotificationScope = suppressOwnChange ? held.answer.id : null
      try {
        qaOriginalAnswer(held.answer)
        qaActionDispatched.push(structuredClone(held.answer))
        qaAckAccepted = true
      } finally { qaAckNotificationScope = null }
      if (replace) {
        const { id: _oldId, ...request } = qaActionRequest
        qaAckReplacementAbort = new AbortController()
        void interactions.ask({ ...request, detail: 'Revision: qa-review-revision-2\\nNew request with the same title, turn and fields. No inherited answer.' }, qaAckReplacementAbort.signal)
          .then(answer => qaAckReplacementResolved.push(structuredClone(answer)), () => {})
        qaAckReplacement = interactions.list().find(item => item.turnId === request.turnId && item.id !== qaActionRequest?.id) ?? null
        if (!qaAckReplacement) throw new Error('qa-ack-replacement-missing')
      }
    },
    shouldSuppressOwnChange() {
      if (!qaAckNotificationScope) return false
      if (qaAckNotificationScope !== qaActionRequest?.id || interactions.list().some(request => request.id === qaAckNotificationScope)) throw new Error('qa-ack-notification-scope-invalid')
      qaAckSuppressed.push({ requestId: qaAckNotificationScope, at: Date.now() })
      return true
    },
    loseAck() {
      const held = qaActionHeld
      if (!held || !qaAckAccepted) throw new Error('qa-ack-not-accepted')
      qaActionHeld = null
      qaAckLost += 1
      held.reject(new Error('qa-review-ack-lost-after-accept'))
    },
    clear() {
      qaAckReplacementAbort?.abort(); qaAckReplacementAbort = null
      qaAckAccepted = false; qaAckLost = 0; qaAckNotificationScope = null
      qaAckSuppressed = []; qaAckReplacement = null; qaAckReplacementResolved = []
      qaReadHeld?.reject(new Error('qa-read-cleanup')); qaReadHeld = null; qaReadSender = null; qaReads = []
    },
    inspect() { return structuredClone({ accepted: qaAckAccepted, lostAcks: qaAckLost,
      suppressed: qaAckSuppressed, replacement: qaAckReplacement, replacementResolved: qaAckReplacementResolved,
      reads: qaReads, readPending: qaReadHeld !== null }) },
  } })
${marker}`
    )
  )
  const indexFile = join(directory, 'src/main/index.ts')
  let index = readFileSync(indexFile, 'utf8')
  const callback = 'const agentInteractions = createAgentInteractions(() => {\n'
  assert.equal(index.split(callback).length, 2)
  index = index.replace(
    callback,
    `${callback}  if ((globalThis as typeof globalThis & { qaReviewAckUi?: { shouldSuppressOwnChange(): boolean } }).qaReviewAckUi?.shouldSuppressOwnChange()) return\n`
  )
  const readHandler = '  ipcMain.handle(CHANNELS.getAgentInteractions, () => agentInteractions.list())'
  assert.equal(index.split(readHandler).length, 2)
  index = index.replace(
    readHandler,
    `  ipcMain.handle(CHANNELS.getAgentInteractions, (event) => {
    const gated = (globalThis as typeof globalThis & { qaReviewAckUi?: { interceptRead(senderId: number): Promise<import('@remember/shared').AgentInteraction[]> | null } }).qaReviewAckUi?.interceptRead(event.sender.id)
    return gated ?? agentInteractions.list()
  })`
  )
  writeFileSync(indexFile, index)
}

export async function residentReviewAckUiQa(page: Page, electron: ElectronApplication, directory: string) {
  const cases: Record<string, unknown>[] = []
  const proof: Record<string, unknown> = {
    boundary:
      'Real local ask acceptance followed by a synthetic rejected IPC acknowledgement. Only the owned answer synchronous notification may be suppressed; no host, provider, page write, durable result or lost network delivery claim. Replacement has the same title, turn and fields but a fresh ID. All outcomes saved before final assertions.',
    cases,
    focusEmulationCommands: [],
  }
  const save = () => writeFileSync(join(directory, 'resident-review-ack-ui-proof.json'), JSON.stringify(proof, null, 2))
  const clear = async () => {
    await electron.evaluate(() => (globalThis as FixtureGlobal).qaReviewAckUi.clear())
    await electron.evaluate(() => (globalThis as FixtureGlobal).qaReviewActionsUi.clear())
  }
  const inspect = () =>
    electron.evaluate(() => ({
      action: (globalThis as FixtureGlobal).qaReviewActionsUi.inspect(),
      ack: (globalThis as FixtureGlobal).qaReviewAckUi.inspect(),
    }))
  const form = page.getByRole('form', { name: /^(Vraag van Codex|Question from Codex)$/ })
  const snapshot = async () => ({
    ...(await inspect()),
    pendingRequests: await electron.evaluate(() => (globalThis as FixtureGlobal).qaReviewAckUi.currentRequests()),
    formCount: await form.count(),
    formVisible: await form.isVisible(),
    preview: (await form.count()) ? await form.locator('pre').textContent() : null,
    buttons: await form
      .getByRole('button')
      .evaluateAll((elements) =>
        elements.map((element) => ({ text: element.textContent, disabled: (element as HTMLButtonElement).disabled }))
      ),
    values: await form
      .locator('input')
      .evaluateAll((elements) => elements.map((element) => (element as HTMLInputElement).value)),
    alerts: await form.getByRole('alert').allTextContents(),
    focus: await observeFocus(page),
    savedResults: await page.getByRole('list', { name: /^(Opgeslagen pagina's|Saved pages)$/ }).count(),
  })
  const cdp = await page.context().newCDPSession(page)
  try {
    await page.setViewportSize({ width: 720, height: 800 })
    for (const input of [
      { name: 'normal-change', suppress: false, replace: false },
      { name: 'suppressed-owned-change', suppress: true, replace: false },
      { name: 'replacement-before-ack', suppress: false, replace: true },
    ]) {
      const entry: Record<string, unknown> = { name: input.name }
      cases.push(entry)
      try {
        await clear()
        await electron.evaluate(() => (globalThis as FixtureGlobal).qaHostExpiryUi.show())
        await page.reload()
        await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
        ;(proof.focusEmulationCommands as unknown[]).push({
          stage: input.name,
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
          'The owned ACK fixture window must have real focus'
        )
        const request = await electron.evaluate(
          (_, name) => (globalThis as FixtureGlobal).qaReviewActionsUi.begin(name),
          input.name
        )
        const draft = `Unsent draft: ${input.name}`
        const values = { note: `Exact answer: ${input.name}`, target: 'Personal/qa-only' }
        const expected = { id: request.id, action: 'accept', values }
        entry.request = request
        entry.draft = draft
        entry.values = values
        await form.waitFor()
        await page.locator('#assistant-message').fill(draft)
        await form.getByLabel('Review note', { exact: true }).fill(values.note)
        await form.getByLabel('Review target', { exact: true }).fill(values.target)
        const button = form.getByRole('button', { name: /^(Save|Bewaren)$/ })
        await button.focus()
        await button.press('Tab')
        await page.keyboard.press('Shift+Tab')
        await electron.evaluate(() => (globalThis as FixtureGlobal).qaReviewActionsUi.arm())
        await button.press('Enter')
        await waitFor(async () => Boolean((await inspect()).action.pending), 'Answer is held before acceptance')
        entry.beforeAccept = await snapshot()
        await electron.evaluate(
          (_, options) => (globalThis as FixtureGlobal).qaReviewAckUi.accept(options.suppress, options.replace),
          input
        )
        await waitFor(
          async () => (await inspect()).action.resolved.length === 1,
          'Actual local ask resolves once before ACK rejection'
        )
        if (input.replace)
          await waitFor(
            async () => (await form.locator('pre').textContent())?.includes('qa-review-revision-2') ?? false,
            'Replacement must render before old acknowledgement rejects'
          )
        else if (!input.suppress) await form.waitFor({ state: 'hidden' })
        const accepted = await snapshot()
        entry.acceptedBeforeLostAck = accepted
        const replacementValues = ['Fresh replacement decision', 'Fresh replacement target']
        if (input.replace) {
          await form.getByLabel('Review note', { exact: true }).fill(replacementValues[0])
          await form.getByLabel('Review target', { exact: true }).fill(replacementValues[1])
          entry.replacementBeforeLostAck = await snapshot()
        }
        save()
        await electron.evaluate(() => (globalThis as FixtureGlobal).qaReviewAckUi.loseAck())
        await delay(400)
        const after = await snapshot()
        entry.afterLostAck = after
        save()
        await page.screenshot({ path: join(directory, `review-ack-${input.name}-after.png`) })
        const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
        const replacement = after.ack.replacement
        entry.assertions = {
          acceptedBeforeLostAck:
            accepted.ack.accepted &&
            accepted.ack.lostAcks === 0 &&
            same(accepted.action.dispatched, [expected]) &&
            same(accepted.action.resolved, [expected]),
          oldRequestAbsent: after.pendingRequests.every((item) => item.id !== request.id),
          exactOwnedSuppression: input.suppress
            ? after.ack.suppressed.length === 1 && after.ack.suppressed[0]?.requestId === request.id
            : after.ack.suppressed.length === 0,
          exactlyOneLostAck: after.ack.lostAcks === 1,
          noAutomaticReplay:
            same(after.action.attempts, [expected]) &&
            same(after.action.dispatched, [expected]) &&
            same(after.action.resolved, [expected]) &&
            after.action.duplicateAttempts === 0,
          absentRequestNotOffered:
            input.replace || !after.formVisible || after.buttons.every((button) => button.disabled),
          replacementUntouched:
            !input.replace ||
            Boolean(
              replacement &&
                replacement.id !== request.id &&
                replacement.turnId === request.turnId &&
                replacement.title === request.title &&
                same(after.pendingRequests, [replacement]) &&
                after.preview?.includes('qa-review-revision-2') &&
                accepted.values.length === 2 &&
                accepted.values.every((value) => value === '') &&
                same(after.values, replacementValues) &&
                after.alerts.length === 0 &&
                after.ack.replacementResolved.length === 0
            ),
          draftRetained: after.focus.draft === draft,
          noSavedResult: after.savedResults === 0,
        }
        // Explicit read-only reload after measurement; it must never replay the accepted answer.
        await page.reload()
        await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
        await page.locator('#assistant-message').waitFor()
        await delay(200)
        const reloaded = await snapshot()
        entry.afterReadOnlyReload = reloaded
        ;(entry.assertions as Record<string, boolean>).noReplayAfterReadOnlyReload =
          same(reloaded.action.attempts, [expected]) &&
          same(reloaded.action.dispatched, [expected]) &&
          same(reloaded.action.resolved, [expected]) &&
          reloaded.ack.replacementResolved.length === 0
        entry.pass = Object.values(entry.assertions as Record<string, boolean>).every(Boolean)
      } catch (error) {
        entry.error = error instanceof Error ? error.message : String(error)
        entry.pass = false
      }
      save()
    }
    for (const accepted of [true, false]) {
      const name = accepted ? 'accepted-read-unavailable' : 'pending-read-unavailable-decline'
      const entry: Record<string, unknown> = { name }
      cases.push(entry)
      try {
        await clear()
        await electron.evaluate(() => (globalThis as FixtureGlobal).qaHostExpiryUi.show())
        await page.reload()
        await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
        ;(proof.focusEmulationCommands as unknown[]).push({
          stage: name,
          command: 'Emulation.setFocusEmulationEnabled',
          parameters: { enabled: false },
          at: Date.now(),
        })
        await page.locator('#assistant-message').waitFor()
        const window = await electron.browserWindow(page)
        await window.evaluate((window) => {
          window.show()
          window.focus()
        })
        await waitFor(
          () => page.evaluate(() => document.hasFocus()),
          'The status-read fixture must own real native focus'
        )
        const senderId = await window.evaluate((window) => window.webContents.id)
        const armRead = () =>
          electron.evaluate((_, senderId) => (globalThis as FixtureGlobal).qaReviewAckUi.armRead(senderId), senderId)
        const releaseRead = (outcome: 'failure' | 'success') =>
          electron.evaluate((_, outcome) => (globalThis as FixtureGlobal).qaReviewAckUi.releaseRead(outcome), outcome)
        const waitRead = () =>
          waitFor(async () => (await inspect()).ack.readPending, 'Only the armed own renderer status read must be held')
        const request = await electron.evaluate(
          (_, name) => (globalThis as FixtureGlobal).qaReviewActionsUi.begin(name),
          name
        )
        const values = { note: `Exact answer: ${name}`, target: 'Personal/qa-only' }
        const originalAction = accepted ? 'accept' : 'decline'
        const expected = { id: request.id, action: originalAction, values }
        const draft = `Unsent draft: ${name}`
        entry.request = request
        entry.values = values
        entry.draft = draft
        entry.senderId = senderId
        entry.originalAction = originalAction
        await form.waitFor()
        await page.locator('#assistant-message').fill(draft)
        await form.getByLabel('Review note', { exact: true }).fill(values.note)
        await form.getByLabel('Review target', { exact: true }).fill(values.target)
        const answer = form.getByRole('button', { name: accepted ? /^(Save|Bewaren)$/ : /^(Cancel|Annuleren)$/ })
        const check = form.getByRole('button', { name: /^(Status controleren|Check status)$/ })
        await answer.focus()
        await answer.press('Tab')
        await page.keyboard.press('Shift+Tab')
        await electron.evaluate(() => (globalThis as FixtureGlobal).qaReviewActionsUi.arm())
        await answer.press('Enter')
        await waitFor(
          async () => Boolean((await inspect()).action.pending),
          'The exact answer must be held before the read-failure case'
        )
        if (accepted) {
          await electron.evaluate(() => (globalThis as FixtureGlobal).qaReviewAckUi.accept(true, false))
          await waitFor(
            async () => (await inspect()).action.resolved.length === 1,
            'The local ask really resolves before the lost ACK'
          )
        }
        await armRead()
        if (accepted) await electron.evaluate(() => (globalThis as FixtureGlobal).qaReviewAckUi.loseAck())
        else await electron.evaluate(() => (globalThis as FixtureGlobal).qaReviewActionsUi.release('failure'))
        await waitRead()
        const automaticHeld = await snapshot()
        entry.automaticReadHeld = automaticHeld
        save()
        await releaseRead('failure')
        await check.waitFor()
        await waitFor(() => check.isEnabled(), 'An unavailable status permits only a new read-only Check')
        await delay(200)
        const unknown = await snapshot()
        entry.unknownAfterAutomaticRead = unknown
        save()
        await page.screenshot({ path: join(directory, `review-ack-${name}-unknown.png`) })
        await check.focus()
        await check.press('Tab')
        await page.keyboard.press('Shift+Tab')
        await armRead()
        await check.press('Enter')
        await waitRead()
        const manualHeld = await snapshot()
        entry.manualCheckHeld = manualHeld
        save()
        await releaseRead('failure')
        await waitFor(() => check.isEnabled(), 'Failed manual Check must remain retryable')
        await delay(200)
        const manualFailed = await snapshot()
        entry.manualCheckFailed = manualFailed
        save()
        await page.screenshot({ path: join(directory, `review-ack-${name}-check-failed.png`) })
        await armRead()
        await check.press('Enter')
        await waitRead()
        entry.manualSuccessHeld = await snapshot()
        save()
        await releaseRead('success')
        if (accepted) await form.waitFor({ state: 'hidden' })
        else await waitFor(() => answer.isEnabled(), 'Only the exact still-pending request may be answered again')
        await delay(200)
        const checked = await snapshot()
        entry.afterSuccessfulCheck = checked
        save()
        if (!accepted) {
          await electron.evaluate(() => (globalThis as FixtureGlobal).qaReviewActionsUi.arm())
          await page.keyboard.press('Enter')
          await waitFor(
            async () => Boolean((await inspect()).action.pending),
            'Explicit retry must still use the same request and answer'
          )
          const retried = await snapshot()
          entry.explicitRetryHeld = retried
          save()
          if (retried.action.pending?.action === originalAction) {
            await electron.evaluate(() => (globalThis as FixtureGlobal).qaReviewActionsUi.release('success'))
            await form.waitFor({ state: 'hidden' })
            await waitFor(
              async () => (await inspect()).action.resolved.length === 1,
              'Explicit retry resolves the one local ask once'
            )
          } else {
            entry.unexpectedActionBlockedBeforeDispatch = retried.action.pending
            await electron.evaluate(() => (globalThis as FixtureGlobal).qaReviewActionsUi.release('failure'))
            await delay(200)
          }
        }
        const finished = await snapshot()
        entry.finished = finished
        save()
        await page.screenshot({ path: join(directory, `review-ack-${name}-finished.png`) })
        const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
        const oldActionsDisabled = (state: Awaited<ReturnType<typeof snapshot>>) => {
          const actions = state.buttons.filter((button) => /^(Save|Bewaren|Cancel|Annuleren)$/.test(button.text ?? ''))
          return actions.length === 2 && actions.every((button) => button.disabled)
        }
        entry.assertions = {
          exactAuthoritativePendingState: same(automaticHeld.pendingRequests, accepted ? [] : [request]),
          acceptanceDistinguished:
            same(automaticHeld.action.dispatched, accepted ? [expected] : []) &&
            same(automaticHeld.action.resolved, accepted ? [expected] : []),
          onlyOwnReadGated:
            finished.ack.reads.length === 3 &&
            finished.ack.reads.every((read) => read.requestId === request.id && read.senderId === senderId) &&
            same(
              finished.ack.reads.map((read) => read.outcome),
              ['failure', 'failure', 'success']
            ),
          unknownMessage:
            unknown.alerts.length === 1 &&
            unknown.alerts[0] === 'Ontvangst van je antwoord is niet bevestigd.' &&
            same(manualFailed.alerts, unknown.alerts),
          noOldActionWhileUnknown: [unknown, manualHeld, manualFailed].every(oldActionsDisabled),
          checkHeldDisabled: manualHeld.buttons.some(
            (button) => /^(Status controleren|Check status)$/.test(button.text ?? '') && button.disabled
          ),
          manualFailureKeepsKeyboardFocus:
            manualFailed.focus.documentFocused &&
            manualFailed.focus.active.tag === 'BUTTON' &&
            /^(Status controleren|Check status)$/.test(manualFailed.focus.active.text ?? '') &&
            manualFailed.focus.active.focusVisible &&
            manualFailed.focus.active.outlineStyle === 'solid',
          valuesAndPreviewRetained: [unknown, manualHeld, manualFailed].every(
            (state) => same(state.values, [values.note, values.target]) && state.preview === automaticHeld.preview
          ),
          checksNeverAnswer:
            same(checked.action.attempts, [expected]) &&
            same(checked.action.dispatched, accepted ? [expected] : []) &&
            same(checked.action.resolved, accepted ? [expected] : []),
          authoritativeReadOnlyOutcome: accepted
            ? !checked.formVisible && checked.pendingRequests.length === 0
            : same(checked.pendingRequests, [request]) &&
              same(checked.values, [values.note, values.target]) &&
              checked.buttons.some((button) => /^(Cancel|Annuleren)$/.test(button.text ?? '') && !button.disabled),
          recoveredOriginalActionFocus:
            accepted ||
            (checked.focus.documentFocused &&
              checked.focus.active.tag === 'BUTTON' &&
              /^(Cancel|Annuleren)$/.test(checked.focus.active.text ?? '') &&
              checked.focus.active.focusVisible),
          explicitAnswerOnlyOnce:
            same(finished.action.attempts, accepted ? [expected] : [expected, expected]) &&
            same(finished.action.dispatched, [expected]) &&
            same(finished.action.resolved, [expected]) &&
            finished.action.duplicateAttempts === 0,
          draftRetained: [automaticHeld, unknown, manualHeld, manualFailed, checked, finished].every(
            (state) => state.focus.draft === draft
          ),
          noSavedResult: [unknown, manualFailed, checked, finished].every((state) => state.savedResults === 0),
        }
        entry.pass = Object.values(entry.assertions as Record<string, boolean>).every(Boolean)
      } catch (error) {
        entry.error = error instanceof Error ? error.message : String(error)
        entry.pass = false
      }
      save()
    }
    proof.failures = cases.flatMap((entry) =>
      entry.error
        ? [`${entry.name}: ${entry.error}`]
        : Object.entries((entry.assertions as Record<string, boolean>) ?? {})
            .filter(([, pass]) => !pass)
            .map(([name]) => `${entry.name}: ${name}`)
    )
    proof.status = cases.every((entry) => entry.pass) ? 'passed' : 'failed'
  } finally {
    await clear()
    await electron.evaluate(() => (globalThis as FixtureGlobal).qaHostExpiryUi.clear())
    await cdp.detach()
    save()
  }
  return proof
}
