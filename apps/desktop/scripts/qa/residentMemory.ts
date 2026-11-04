import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import type { AssistantConversation, WikiPage } from '@remember/shared'
import type { Page } from 'playwright-core'
import { initializeCodexServer } from '../../src/main/codexAppServer'
import { connectCodexWebSocket } from '../../src/main/codexWebSocket'

type Options = { page: Page; directory: string; checks: string[] }
type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Expected an object from the real tool protocol')
  return value as JsonObject
}

function localToolState(directory: string) {
  const db = new DatabaseSync(join(directory, 'profile/daily-review/assistant/conversation.sqlite'), { readOnly: true })
  try {
    return {
      threadId: db.prepare("SELECT thread_id FROM assistant_thread WHERE provider = 'codex'").get()?.thread_id,
      calls: db
        .prepare('SELECT id, request_hash, result_json, message_id, tool_name FROM assistant_tool_call ORDER BY id')
        .all()
        .map((row) => ({ ...row })),
    }
  } finally {
    db.close()
  }
}

async function remoteMemoryCalls(endpoint: string, threadId: string) {
  const server = await connectCodexWebSocket(endpoint, { onNotification: () => {}, onClose: () => {} })
  try {
    await initializeCodexServer(server, 'native-memory-qa')
    const thread = object(object(await server.request('thread/read', { threadId, includeTurns: true }, 10_000)).thread)
    assert(Array.isArray(thread.turns), 'Remote thread/read must include its real turns')
    const turn = object(thread.turns.at(-1))
    assert(Array.isArray(turn.items), 'The current remote turn must expose tool records')
    const items = turn.items.map(object)
    assert.equal(
      items.some((item) => ['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch'].includes(String(item.type))),
      false,
      'Memory QA must use the local dynamic memory tool, without shell, browser or filesystem tools'
    )
    const calls = items.filter((item) => item.type === 'dynamicToolCall')
    for (const call of calls) {
      assert.equal(call.tool, 'remember_memory')
      assert(!call.namespace, 'The reviewed tool must be the registered unnamespaced Remember tool')
      const args = object(call.arguments)
      assert.equal(args.spaceId, 'personal')
      assert(['search', 'read', 'patch'].includes(String(args.action)), 'No other memory operation is authorized')
    }
    return calls
  } finally {
    server.close()
  }
}

function result(call: JsonObject) {
  assert.equal(call.status, 'completed')
  assert.equal(call.success, true)
  assert(Array.isArray(call.contentItems))
  const text = call.contentItems.map(object).find((item) => item.type === 'inputText')?.text
  assert.equal(typeof text, 'string')
  return object(JSON.parse(String(text)))
}

function assertRejectedWithoutWrite(call: JsonObject, writeIds: Set<string>, threadId: string) {
  assert.equal(call.status, 'failed', 'Every additional patch must have been rejected')
  assert.equal(call.success, false)
  assert(Array.isArray(call.contentItems))
  assert(
    call.contentItems
      .map(object)
      .some((item) => item.type === 'inputText' && typeof item.text === 'string' && item.text.length > 0)
  )
  assert.equal(
    writeIds.has(JSON.stringify([threadId, call.id])),
    false,
    'A rejected patch must not claim a durable write'
  )
}

function onePage(pages: WikiPage[], slug: string) {
  const matches = pages.filter((page) => page.slug === slug)
  assert.equal(matches.length, 1, 'Exactly one synthetic memory page must exist')
  assert.equal(typeof matches[0].revision, 'string')
  return matches[0]
}

async function openSavedResult(page: Page, sourceUrl: string, title: string) {
  const results = page.getByRole('list', { name: /^(Opgeslagen pagina's|Saved pages)$/ })
  const link = results.getByRole('link')
  await link.waitFor({ state: 'visible' })
  assert.equal(await link.count(), 1, 'The saved tool receipt must produce one result control')
  assert.equal(await link.getAttribute('href'), sourceUrl)
  assert((await link.innerText()).includes(title))
  await link.focus()
  assert(await link.evaluate((element) => document.activeElement === element), 'The result must be keyboard reachable')
  await link.press('Enter')
  await page.waitForURL((url) => `${url.pathname}${url.search}` === sourceUrl)
  const editor = page.getByRole('textbox', { name: /^(Pagina-inhoud|Page content)$/ })
  await editor.waitFor({ state: 'visible' })
  return editor
}

export async function residentMemoryQa({ page, directory, checks }: Options) {
  await page.evaluate(() => window.remember.updateSettings({ interfaceLanguage: 'en' }))
  const settings = await page.evaluate(() => window.remember.getSettings())
  assert.equal(settings.offlineMode, false)
  assert.equal(settings.cloudAnalysisConsent, true)
  assert.equal(settings.agentComputer.kind, 'remote')
  const endpoint = settings.agentComputer.kind === 'remote' ? settings.agentComputer.endpoint : ''
  const space = (await page.evaluate(() => window.remember.getWikiOverview())).spaces.find(
    (entry) => entry.id === 'personal'
  )
  assert(space)
  assert.equal(space.maintenanceMode, 'auto', 'This scenario verifies a reviewed saved change, not a proposal')

  const nonce = `${Date.now()}`
  const slug = `projects/resident-memory-qa-${nonce}`
  const title = `Native memory QA ${nonce}`
  const witness = `MEMORY_READ_${randomUUID()}`
  const before = `State: READY_${nonce}`
  const after = `State: VERIFIED_${nonce}`
  const content = `Disposable native memory QA.\n\nRead witness: ${witness}\n\n${before}\n\nKeep this line unchanged: ${nonce}`
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
  const baseline = localToolState(directory)
  const userCount = (await page.evaluate(() => window.remember.getAssistantConversation())).messages.filter(
    (entry) => entry.role === 'user'
  ).length
  const sourceUrl = `/wiki/page/?space=personal&slug=${encodeURIComponent(slug)}`
  const instruction = `Use only remember_memory for this disposable native QA. In Personal (spaceId personal), read the page ${slug}. Patch that exact page once using its current revision: replace exactly ${JSON.stringify(before)} with exactly ${JSON.stringify(after)}; summary must be "Native reviewed memory QA". Change nothing else. Let Remember present this one change for review. After it is saved, read the page again. Keep your final answer to the exact Read witness value; the app will display its own saved-result link. Do not use shell, browser, external services or any other tool.`
  await page.goto(`${new URL(page.url()).origin}/assistant/`)
  await page.locator('#assistant-message').fill(instruction)
  await page.locator('#assistant-message').press('Enter')

  const expectedDetail = `${space.name}\n${slug}\n\nRevision: ${seed.revision}\n\nReplace:\n${before}\n\nWith:\n${after}\n\nThis will be saved in this Space.`
  const expectedPatch = {
    action: 'patch',
    spaceId: 'personal',
    slug,
    expectedRevision: seed.revision,
    before,
    after,
    summary: 'Native reviewed memory QA',
  }
  const approved = new Set<string>()
  let reviewedWriteId: string | null = null
  const deadline = Date.now() + 150_000
  let completed: AssistantConversation | null = null
  while (!completed) {
    const state = await page.evaluate(() => window.remember.getAssistantConversation())
    const requests = await page.evaluate(() => window.remember.getAgentInteractions())
    for (const request of requests) {
      if (approved.has(request.id)) continue
      assert.equal(approved.size, 0, 'A second write or provider approval is not authorized by this scenario')
      assert.equal(request.turnId, state.activeTurnId)
      assert.equal(request.title, 'Save knowledge in Remember', `Unexpected approval: ${JSON.stringify(request)}`)
      assert.equal(
        request.detail,
        expectedDetail,
        'Only the exact synthetic page, revision and replacement may be approved'
      )
      assert.deepEqual(request.fields, [])
      assert.equal(request.url, undefined)
      assert.deepEqual(request.actions, [
        { id: 'accept', label: 'Save' },
        { id: 'decline', label: 'Cancel' },
      ])
      const unchanged = onePage(await page.evaluate(() => window.remember.listWikiPages('personal')), slug)
      assert.equal(unchanged.content, content, 'No write may occur before approval')
      assert.equal(unchanged.revision, seed.revision)
      const pendingState = localToolState(directory)
      const threadId = pendingState.threadId
      assert.equal(typeof threadId, 'string')
      const pendingWrites = pendingState.calls.filter((call) => !baseline.calls.some((old) => old.id === call.id))
      assert.equal(pendingWrites.length, 1, 'Exactly one reviewed write may be pending')
      assert.equal(pendingWrites[0].result_json, null, 'The reviewed write must not finish before approval')
      assert.equal(pendingWrites[0].message_id, state.activeTurnId)
      assert.equal(pendingWrites[0].tool_name, 'remember_memory')
      assert.deepEqual(state.messages.at(-1)?.results, [], 'An unapproved write is not a saved result')
      reviewedWriteId = String(pendingWrites[0].id)
      const [writeThreadId, writeCallId] = JSON.parse(reviewedWriteId)
      assert.equal(writeThreadId, threadId)
      assert.equal(typeof writeCallId, 'string')
      const calls = await remoteMemoryCalls(endpoint, String(threadId))
      writeFileSync(
        join(directory, 'resident-memory-review-protocol.json'),
        JSON.stringify({ request, pendingWrites, calls }, null, 2)
      )
      const reads = calls.filter((call) => object(call.arguments).action === 'read')
      assert(
        reads.some((call) => {
          if (call.status !== 'completed' || call.success !== true) return false
          const read = result(call)
          return read.content === content && read.slug === slug && read.revision === seed.revision
        }),
        'A real successful dynamic read of the current revision must precede the reviewed patch'
      )
      const patches = calls.filter((call) => object(call.arguments).action === 'patch')
      const writeIds = new Set(pendingState.calls.map((call) => String(call.id)))
      for (const patch of patches) {
        if (patch.id === writeCallId) {
          assert.deepEqual(object(patch.arguments), expectedPatch)
          assert.notEqual(patch.status, 'completed', 'The reviewed patch cannot complete before approval')
          assert.notEqual(patch.success, true)
        } else assertRejectedWithoutWrite(patch, writeIds, String(threadId))
      }
      const form = page.getByRole('form', { name: /^(Vraag van Codex|Question from Codex)$/ })
      await form.waitFor({ state: 'visible' })
      assert.equal(await form.count(), 1)
      assert.equal(await form.locator('pre').textContent(), expectedDetail)
      await page.screenshot({ path: join(directory, 'resident-memory-approval.png') })
      await form.getByRole('button', { name: /^(Bewaren|Keep|Save)$/ }).click()
      approved.add(request.id)
    }
    if (state.messages.filter((entry) => entry.role === 'user').length > userCount && !state.activeTurnId) {
      assert.equal(state.messages.at(-1)?.status, 'completed', JSON.stringify(state.messages.at(-1)))
      assert.equal(state.remoteRecoveryRequired, false)
      assert.equal(approved.size, 1, 'The remote agent must request and receive the reviewed memory approval')
      completed = state
    }
    assert(Date.now() < deadline, 'The live remote memory turn must finish after its single reviewed write')
    if (!completed) await delay(250)
  }

  const saved = onePage(await page.evaluate(() => window.remember.listWikiPages('personal')), slug)
  const expectedContent = content.replace(before, after)
  assert.equal(saved.content, expectedContent)
  assert.notEqual(saved.revision, seed.revision)
  assert.equal(saved.title, title)
  assert(completed.messages.at(-1)?.text.includes(witness), 'The answer must contain the witness read from the page')
  const toolState = localToolState(directory)
  const writes = toolState.calls.filter((call) => !baseline.calls.some((old) => old.id === call.id))
  assert.equal(writes.length, 1, 'One and only one durable memory write call must be recorded')
  assert.equal(writes[0].id, reviewedWriteId, 'The completed write must be the exact reviewed pending call')
  const writeResult = object(JSON.parse(String(writes[0].result_json)))
  assert.equal(writeResult.saved, true)
  assert.equal(writeResult.proposed, false)
  assert.equal(writeResult.slug, slug)
  assert.equal(writeResult.revision, saved.revision)
  const resultMessage = completed.messages.at(-1)
  assert(resultMessage)
  const savedResults = resultMessage.results
  assert(savedResults)
  assert.equal(writes[0].message_id, resultMessage.id)
  assert.equal(writes[0].tool_name, 'remember_memory')
  assert.deepEqual(savedResults, [
    { id: reviewedWriteId, kind: 'saved-page', spaceId: 'personal', slug, revision: saved.revision, title },
  ])
  const calls = await remoteMemoryCalls(endpoint, String(toolState.threadId))
  const reads = calls.filter((call) => object(call.arguments).action === 'read')
  assert(
    reads.some((call) => {
      if (call.status !== 'completed' || call.success !== true) return false
      const read = result(call)
      return read.content === expectedContent && read.slug === slug && read.revision === saved.revision
    }),
    'A real successful readback must observe the updated local revision'
  )
  const patches = calls.filter((call) => object(call.arguments).action === 'patch')
  const successfulPatches = patches.filter((call) => call.status === 'completed' && call.success === true)
  assert.equal(successfulPatches.length, 1, 'Exactly one patch may succeed; rejected requests are not writes')
  const successfulPatch = successfulPatches[0]
  assert.deepEqual(object(successfulPatch.arguments), expectedPatch)
  assert.deepEqual(result(successfulPatch), writeResult)
  assert.equal(JSON.stringify([toolState.threadId, successfulPatch.id]), reviewedWriteId)
  const writeIds = new Set(toolState.calls.map((call) => String(call.id)))
  for (const patch of patches) {
    if (patch.id !== successfulPatch.id) assertRejectedWithoutWrite(patch, writeIds, String(toolState.threadId))
  }
  const resultList = page.getByRole('list', { name: /^(Opgeslagen pagina's|Saved pages)$/ })
  await resultList.waitFor({ state: 'visible' })
  await resultList.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(directory, 'resident-memory-completed.png') })
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  await page.setViewportSize({ width: 720, height: 800 })
  await resultList.scrollIntoViewIfNeeded()
  await resultList.getByRole('link').focus()
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.screenshot({ path: join(directory, 'resident-memory-result-narrow.png') })
  await page.setViewportSize(viewport)
  const opened = await openSavedResult(page, sourceUrl, title)
  assert((await opened.innerText()).includes(after))
  assert.deepEqual(localToolState(directory).calls, toolState.calls, 'Opening a result must not replay the write')
  writeFileSync(
    join(directory, 'resident-memory-before-restart.json'),
    JSON.stringify(
      {
        slug,
        title,
        sourceUrl,
        beforeRevision: seed.revision,
        page: saved,
        messages: completed.messages,
        writes,
        remoteCalls: calls,
        rejectedPatchAttempts: patches.length - successfulPatches.length,
        result: savedResults[0],
        modelIncludedSourceUrl: resultMessage.text.includes(sourceUrl),
      },
      null,
      2
    )
  )
  checks.push(
    'Live Mac-mini agent performs one reviewed memory write; a receipt-derived result appears in the correct chat message and opens the exact saved page by keyboard, including a narrow native viewport'
  )
}

export async function residentMemoryAfterRestartQa({ page, directory, checks }: Options) {
  const before = JSON.parse(readFileSync(join(directory, 'resident-memory-before-restart.json'), 'utf8'))
  const saved = onePage(await page.evaluate(() => window.remember.listWikiPages('personal')), before.slug)
  assert.equal(saved.content, before.page.content)
  assert.equal(saved.revision, before.page.revision)
  assert.equal(saved.title, before.title)
  const conversation = await page.evaluate(() => window.remember.getAssistantConversation())
  assert.deepEqual(conversation.messages, before.messages)
  assert.equal(conversation.activeTurnId, null)
  assert.equal(conversation.remoteRecoveryRequired, false)
  const calls = localToolState(directory).calls
  for (const write of before.writes)
    assert.deepEqual(
      calls.find((call) => call.id === write.id),
      write
    )
  await page.goto(`${new URL(page.url()).origin}/assistant/`)
  assert.deepEqual(conversation.messages.at(-1)?.results, [before.result])
  const results = page.getByRole('list', { name: /^(Opgeslagen pagina's|Saved pages)$/ })
  await results.waitFor({ state: 'visible' })
  await results.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(directory, 'resident-memory-result-after-restart.png') })
  const editor = await openSavedResult(page, before.sourceUrl, before.title)
  assert((await editor.innerText()).includes(`State: VERIFIED_${before.slug.split('-').at(-1)}`))
  assert.deepEqual(localToolState(directory).calls, calls, 'Reopening the result after restart must not write again')
  await page.screenshot({ path: join(directory, 'resident-memory-after-restart.png') })
  writeFileSync(
    join(directory, 'resident-memory-proof.json'),
    JSON.stringify(
      {
        slug: before.slug,
        beforeRevision: before.beforeRevision,
        savedRevision: saved.revision,
        actualRemoteDynamicReads: true,
        exactNativeUiApproval: true,
        singleDurableWrite: true,
        rejectedPatchAttempts: before.rejectedPatchAttempts,
        sourceReadback: true,
        fullNativeRestart: true,
        pageAndChatPreserved: true,
        savedResult: before.result,
        resultOpenedThroughChatBeforeAndAfterRestart: true,
        resultDerivedFromToolReceipt: true,
        modelIncludedSourceUrl: before.modelIncludedSourceUrl,
        keyboardAndNarrowViewport: true,
        boundary:
          'Live remote Codex and actual local Wiki tool, IPC, revision storage and native renderer. Only a disposable Personal QA page is changed; no model/storage mocks and no audio or capture actions.',
      },
      null,
      2
    )
  )
  checks.push(
    'The exact saved result, revision, write receipt and chat survive full Remember restart; the same chat result opens the saved page without repeating a write'
  )
}
