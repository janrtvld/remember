import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { AgentInteractionAnswer, LocalSettings, WikiPage, WikiSpace } from '@remember/shared'
import { createResidentMemoryTool } from '../residentAgentMemoryTool'
import { createResidentAgentService, type ResidentAgentDriver } from '../residentAgentService'
import { ResidentAgentStore, type ResidentHostRun } from '../residentAgentStore'
import { createCachedSettingsStore } from '../settingsStore'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const page: WikiPage = {
  slug: 'review',
  title: 'Review',
  content: 'Original private decision',
  excerpt: 'Original decision',
  revision: 'r1',
  sourceCount: 0,
  updatedAt: 1,
}
const space: WikiSpace = {
  id: 'personal',
  name: 'Personal',
  description: '',
  icon: 'book',
  color: 'slate',
  maintenanceMode: 'auto',
}
const mutation = {
  action: 'patch',
  spaceId: 'personal',
  slug: 'review',
  expectedRevision: 'r1',
  before: 'Original',
  after: 'Changed',
  summary: 'Change reviewed decision',
}
const captureSettings = (settings: LocalSettings) => ({
  paused: settings.capturePaused,
  until: settings.capturePausedUntil,
  sources: settings.capturePauseSources,
  audioEnabled: settings.audioCaptureEnabled,
  schedule: settings.captureSchedule,
})

for (const initiallyReachable of [true, false]) {
  test(`consent regrant preserves ${initiallyReachable ? 'stopped' : 'unconfirmed'} host ownership and pending write across restart`, async (t) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'remember-consent-regrant-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const settingsStore = createCachedSettingsStore()
    const settings = () => settingsStore.get(directory)
    settingsStore.update(
      directory,
      {
        cloudAnalysisConsent: true,
        capturePaused: true,
        capturePausedUntil: initiallyReachable ? null : Date.now() + 3_600_000,
        capturePauseSources: ['audio', 'capture'],
        audioCaptureEnabled: true,
      },
      Date.now()
    )
    const paused = captureSettings(settings())
    const assertAvailable = () => {
      if (!settings().cloudAnalysisConsent) throw new Error('cloud-analysis-consent-required')
    }
    const file = path.join(directory, 'conversation.sqlite')
    let store = new ResidentAgentStore(file)
    let driverInput!: Parameters<ResidentAgentDriver['run']>[0]
    let rejectDriver!: (error: Error) => void
    let reachable = initiallyReachable
    let providerCalls = 0
    const stopCalls: ResidentHostRun[] = []
    const toolAbort = new AbortController()
    let service = createResidentAgentService({
      store,
      assertAvailable,
      changed: () => {},
      context: () => 'Private source before consent revocation',
      driver: {
        run: async (input) => {
          providerCalls += 1
          driverInput = input
          input.onThread('original-provider-thread')
          input.onHostRun({
            jobId: 'original-host-job',
            messageId: input.turnId,
            endpoint: 'tcp://127.0.0.1:47833',
            cursor: 1,
            phase: 'running',
            connection: 'connected',
          })
          return new Promise((_resolve, reject) => {
            rejectDriver = reject
          })
        },
        detachHost: () => {
          toolAbort.abort()
          rejectDriver(new Error('client-detached'))
        },
        cancel: () => assert.fail('Host invalidation must use exact Stop'),
        stopHost: async (run) => {
          stopCalls.push(run)
          if (!reachable) throw new Error('host-stop-unconfirmed')
        },
      },
    })
    await service.setContextPolicy(JSON.stringify({ consent: settings().cloudAnalysisConsent }))
    service.send({ text: 'Review this private decision', provider: 'codex' })
    const messageId = driverInput.turnId
    const toolContext = {
      threadId: 'original-provider-thread',
      turnId: 'original-provider-turn',
      callId: 'original-memory-write',
      signal: toolAbort.signal,
    }
    let reviews = 0
    let writes = 0
    let approve!: (answer: AgentInteractionAnswer) => void
    const memoryTool = () =>
      createResidentMemoryTool('Read Personal page review', {
        messageId,
        spaces: () => [space],
        read: async () => ({ state: 'fresh', checkedAt: 1, pages: [page] }),
        pagePermitted: () => true,
        assertAvailable,
        store,
        ask: async () => {
          reviews += 1
          return new Promise((resolve) => {
            approve = resolve
          })
        },
        wiki: {
          getSpaces: () => [space],
          listPages: async () => [page],
          createPage: async () => assert.fail('No page creation is allowed'),
          deletePage: async () => assert.fail('No deletion is allowed'),
          proposePage: async () => assert.fail('No proposal is allowed'),
          savePage: async () => {
            writes += 1
            return [{ ...page, revision: 'r2' }]
          },
        },
      })
    const pendingWrite = memoryTool().call(mutation, toolContext)
    assert.equal(reviews, 1, 'A real memory tool claim precedes the consent change')

    const changeConsent = async (consent: boolean) => {
      settingsStore.update(directory, { cloudAnalysisConsent: consent }, Date.now())
      await service.setContextPolicy(JSON.stringify({ consent: settings().cloudAnalysisConsent }))
    }
    if (initiallyReachable) await changeConsent(false)
    else await assert.rejects(changeConsent(false), /host-stop-unconfirmed/)
    assert.equal(store.hostRun()?.contextInvalidated, true)
    assert.equal(store.hostRun()?.stopRequested, true)
    assert.equal(store.get(messageId)?.status, initiallyReachable ? 'cancelled' : 'interrupted')
    const stopped = store.hostRun()
    const priorCalls = providerCalls
    if (initiallyReachable) await changeConsent(true)
    else await assert.rejects(changeConsent(true), /host-stop-unconfirmed/)
    await tick()
    assert.equal(providerCalls, priorCalls, 'A policy regrant cannot dispatch or resume a provider turn')
    assert.deepEqual(store.hostRun(), stopped)
    assert.deepEqual(captureSettings(settings()), paused)
    assert.deepEqual(store.history(), [])
    assert.equal(store.thread('codex'), null)

    const lateApproval = assert.rejects(pendingWrite, /agent-cancelled/)
    approve({ id: 'obsolete-review', action: 'accept', values: {} })
    await lateApproval
    assert.equal(writes, 0, 'A late approval remains cancelled after consent is regranted')
    if (!initiallyReachable) {
      assert.throws(() => service.send({ text: 'New work', provider: 'codex' }), /host-recovery-required/)
      reachable = true
      service.resumeHost()
      await tick()
    }
    assert.equal(store.hostRun()?.phase, 'stopped')
    assert.ok(
      stopCalls.every((run) => run.jobId === 'original-host-job' && run.contextInvalidated && run.stopRequested)
    )
    await service.dispose()

    store = new ResidentAgentStore(file)
    service = createResidentAgentService({
      store,
      assertAvailable,
      changed: () => {},
      context: () => assert.fail('An old terminal job must not fetch context'),
      driver: {
        run: async () => assert.fail('Regrant/restart must not invoke the provider'),
        cancel: () => assert.fail('No local cancellation is required'),
        stopHost: async () => assert.fail('A terminal job must not be stopped again'),
      },
    })
    await service.setContextPolicy(JSON.stringify({ consent: settings().cloudAnalysisConsent }))
    service.resumeHost()
    service.retry(messageId)
    await tick()
    assert.equal(store.hostRun()?.phase, 'stopped')
    assert.equal(store.hostRun()?.contextInvalidated, true)
    assert.equal(store.hostRun()?.stopRequested, true)
    assert.equal(store.get(messageId)?.status, 'cancelled')
    assert.equal(service.snapshot().messages.length, 2)
    assert.deepEqual(store.get(messageId)?.results, [])
    await assert.rejects(
      memoryTool().call(mutation, { ...toolContext, signal: new AbortController().signal }),
      /memory-write-outcome-unknown-read-before-retrying/
    )
    assert.equal(reviews, 1, 'A durable claimed write cannot ask for approval again after regrant/restart')
    assert.equal(writes, 0)
    const database = new DatabaseSync(file)
    const claim = database.prepare('SELECT message_id, result_json FROM assistant_tool_call').get()
    assert.equal(claim?.message_id, messageId)
    assert.equal(claim?.result_json, null)
    database.close()
    assert.deepEqual(captureSettings(createCachedSettingsStore().get(directory)), paused)
    await service.dispose()
  })
}
