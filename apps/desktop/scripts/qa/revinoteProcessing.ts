import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { ConversationEpisode, Day } from '@remember/shared'
import type { ElectronApplication, Page } from 'playwright-core'
import { renderConversationAudioAt, saveConversationAudioChunkAt } from '../../src/main/dailyReview/conversationAudio'
import { localDayKey, sessionLocalDay } from '../../src/main/dailyReview/dayLifecycle'
import { EvidenceStore } from '../../src/main/dailyReview/evidenceStore'
import { createQaAudioFixture } from '../../src/main/dailyReview/qaAudioFixture'

const retryId = 'qa-auto-retry'
const ambiguousId = 'qa-auto-ambiguous'

function seedProcessingConversations(profile: string) {
  const root = join(profile, 'daily-review')
  const store = new EvidenceStore(join(root, 'evidence.sqlite'))
  try {
    const template = store.readSessions().find((day) => day.id === 'qa-day')
    assert(template?.memory)
    const templateMoment = template.moments[0]
    assert(templateMoment)
    const startedAt = Date.now() - 60_000
    const existing = store.readSessions().find((day) => sessionLocalDay(day) === localDayKey(startedAt))
    const dayId = existing?.id ?? 'qa-auto-recovery'
    const moments = [retryId, ambiguousId].map((id, index) => ({
      ...templateMoment,
      id,
      sessionId: dayId,
      startedAt: startedAt + index * 10_000,
    }))
    const day: Day = {
      ...(existing ?? template),
      id: dayId,
      localDay: existing?.localDay ?? localDayKey(startedAt),
      startedAt: existing?.startedAt ?? startedAt,
      endedAt: startedAt + 12_000,
      moments: [...(existing?.moments ?? []), ...moments],
      memory: {
        ...(existing?.memory ?? template.memory),
        conversations: [
          ...(existing?.memory?.conversations ?? []),
          {
            episodeId: ambiguousId,
            startTime: '10:00',
            endTime: '10:01',
            title: ambiguousId,
            description: '',
            processing: 'processing',
            processingProvider: 'revinote',
          },
        ],
      },
      refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
    }
    store.upsertSession(day)
    const episodes: ConversationEpisode[] = moments.map((moment) => ({
      id: moment.id,
      workdayId: dayId,
      startedAt: moment.startedAt,
      endedAt: moment.startedAt + 2_000,
      state: 'final',
      surfaceKey: null,
      provider: null,
      boundaryReason: 'capture-paused',
      segmentIds: [],
      deletedAt: null,
      automaticRevinoteProcessingBlocked: false,
    }))
    store.syncConversationEpisodes(dayId, [...store.listConversationEpisodes(dayId), ...episodes])
    store.decideConversationEpisode(ambiguousId, 'confirmed')
    for (const moment of moments) {
      store.appendAudioMoment(moment, 0.01)
      saveConversationAudioChunkAt(root, dayId, moment.id, createQaAudioFixture(2_000))
    }
    for (const episode of episodes) renderConversationAudioAt(root, episode, day.moments)
    return dayId
  } finally {
    store.close()
  }
}

export async function revinoteProcessingRecoveryQa(options: {
  getElectron: () => ElectronApplication | undefined
  profile: string
  checks: string[]
  close: () => Promise<void>
  launch: () => Promise<Page>
}) {
  let failUpload = true
  let failSync = true
  let syncGate: Promise<void> | null = null
  let syncArrived: (() => void) | null = null
  let uploads = 0
  let presigns = 0
  let ambiguousCompletions = 0
  let submitted = false
  let syncRequests = 0
  let tokenRequests = 0
  let releaseReconnectSync: (() => void) | undefined
  const uploadedKeys = new Set<string>()
  let baseUrl = ''
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.url === '/.well-known/oauth-authorization-server') {
      response.end(
        JSON.stringify({
          issuer: `${baseUrl}/api/auth`,
          authorization_endpoint: `${baseUrl}/api/auth/authorize`,
          token_endpoint: `${baseUrl}/api/auth/token`,
          registration_endpoint: `${baseUrl}/api/auth/register`,
          scopes_supported: ['meetings:read', 'meetings:write', 'offline_access'],
        })
      )
    } else if (request.url === '/api/auth/register') {
      response.end(JSON.stringify({ client_id: 'qa-reconnect-client' }))
    } else if (request.url === '/api/auth/token') {
      tokenRequests += 1
      response.end(
        JSON.stringify({
          access_token: 'qa-reconnected',
          refresh_token: 'qa-refresh',
          expires_in: 3600,
          scope: 'meetings:read meetings:write offline_access',
        })
      )
    } else if (request.url === '/api/v1/recordings/presign') {
      presigns += 1
      response.end(
        JSON.stringify({
          key: `qa-retry-upload-${presigns}`,
          uploadUrl: `${baseUrl}/upload?key=qa-retry-upload-${presigns}`,
        })
      )
    } else if (request.url?.startsWith('/upload?')) {
      for await (const _chunk of request) {
        /* Synthetic audio only. */
      }
      uploads += 1
      if (!failUpload) uploadedKeys.add(new URL(request.url, baseUrl).searchParams.get('key') ?? '')
      response.statusCode = failUpload ? 500 : 200
      response.end('{}')
    } else if (request.url === '/api/v1/recordings/complete') {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const { key } = JSON.parse(Buffer.concat(chunks).toString()) as { key: string }
      if (key === 'qa-ambiguous-upload') {
        ambiguousCompletions += 1
        response.statusCode = 400
        response.end('{}')
      } else if (!uploadedKeys.has(key)) {
        response.statusCode = 400
        response.end('{}')
      } else {
        submitted = true
        response.end(JSON.stringify({ meetingId: 'qa-retried-meeting' }))
      }
    } else if (request.url?.startsWith('/api/v1/meetings/sync')) {
      syncRequests += 1
      syncArrived?.()
      if (syncGate) await syncGate
      if (failSync) {
        response.statusCode = 500
        response.end('{}')
        return
      }
      response.end(
        JSON.stringify({
          meetings: submitted
            ? [
                {
                  id: 'qa-retried-meeting',
                  title: 'QA recovered upload',
                  status: 'finished',
                  date: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                  participants: [],
                  summary: 'Recovered after an interrupted upload',
                  actionItems: [],
                  durationSeconds: 2,
                  transcript: null,
                },
              ]
            : [],
          nextCursor: null,
          hasMore: false,
        })
      )
    } else {
      response.statusCode = 404
      response.end('{}')
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  baseUrl = `http://127.0.0.1:${address.port}`
  const directory = join(options.profile, 'integrations', 'revinote')
  mkdirSync(directory, { recursive: true })
  const initialElectron = options.getElectron()
  assert(initialElectron)
  const encrypted = await initialElectron.evaluate(
    ({ safeStorage }, url) =>
      safeStorage
        .encryptString(JSON.stringify({ method: 'api-key', apiKey: 'qa-only', baseUrl: url }))
        .toString('base64'),
    baseUrl
  )
  let target: Page | undefined
  try {
    await options.close()
    const dayId = seedProcessingConversations(options.profile)
    writeFileSync(join(directory, 'credentials.json'), JSON.stringify({ version: 1, encrypted }), { mode: 0o600 })
    writeFileSync(
      join(directory, 'post-processing.json'),
      JSON.stringify({
        version: 1,
        submissions: {},
        failures: {},
        pending: {
          [ambiguousId]: { key: 'qa-ambiguous-upload', preparedAt: Date.now() - 12 * 60 * 60_000, stage: 'uploaded' },
        },
      }),
      { mode: 0o600 }
    )
    const settingsPath = join(options.profile, 'settings.json')
    writeFileSync(
      settingsPath,
      JSON.stringify({
        ...JSON.parse(readFileSync(settingsPath, 'utf8')),
        automaticRevinoteProcessing: true,
        offlineMode: false,
      }),
      { mode: 0o600 }
    )
    target = await options.launch()
    await target.waitForFunction(
      async (id) =>
        (await window.remember.listDays())
          .flatMap((day) => day.memory?.conversations ?? [])
          .some(
            (conversation) =>
              conversation.episodeId === id && !conversation.processing && conversation.processingError === 'revinote'
          ),
      ambiguousId
    )
    assert.equal(presigns, 0, 'A failed startup sync must expose queued errors without uploading')
    failSync = false
    let releaseSync!: () => void
    syncGate = new Promise<void>((resolve) => {
      releaseSync = resolve
    })
    const arrived = new Promise<void>((resolve) => {
      syncArrived = resolve
    })
    const syncing = target.evaluate(() => window.remember.syncRevinote())
    try {
      await Promise.race([
        arrived,
        delay(10_000).then(() => {
          throw new Error('sync request did not arrive')
        }),
      ])
      assert.equal(
        (await target.evaluate(() => window.remember.getRevinoteConnectionStatus())).state,
        'connected',
        'Background synchronization must not look like an unfinished OAuth connection'
      )
      await target.evaluate(() => window.remember.getState())
      options.checks.push(
        'An existing Revinote connection stays connected while a delayed sync is in flight; capture IPC remains responsive'
      )
    } finally {
      releaseSync()
      syncGate = null
      syncArrived = null
      await syncing
    }
    await target.waitForFunction(
      async (id) =>
        (await window.remember.listDays())
          .flatMap((day) => day.memory?.conversations ?? [])
          .some(
            (conversation) =>
              conversation.episodeId === id &&
              conversation.processingError === 'revinote' &&
              !conversation.processingProvider
          ),
      ambiguousId
    )
    assert.equal(ambiguousCompletions, 1)
    assert.equal(presigns, 0, 'An ambiguous uploaded key must not request another upload')
    await target.evaluate(({ dayId, episodeId }) => window.remember.recoverConversation(dayId, [episodeId]), {
      dayId,
      episodeId: retryId,
    })
    const initialUploadDeadline = Date.now() + 5_000
    while (uploads < 1 && Date.now() < initialUploadDeadline) await delay(25)
    await target.waitForFunction(
      async ({ retryId, ambiguousId }) => {
        const days = await window.remember.listDays()
        return [retryId, ambiguousId].every((id) =>
          days
            .flatMap((day) => day.memory?.conversations ?? [])
            .some(
              (conversation) =>
                conversation.episodeId === id && !conversation.processing && conversation.processingError === 'revinote'
            )
        )
      },
      { retryId, ambiguousId }
    )
    const failedDays = await target.evaluate(() => window.remember.listDays())
    assert.equal(
      failedDays.find((day) => day.id === dayId)?.refresh.status,
      'idle',
      'Revinote upload must not depend on running Day analysis'
    )
    assert.equal(ambiguousCompletions, 1)
    assert(uploads >= 1, 'Confirmed always-on audio must reach the upload endpoint')
    const audioUrl = await target.evaluate(
      ({ dayId, episodeId }) => window.remember.getConversationAudioUrl(dayId, episodeId),
      { dayId, episodeId: retryId }
    )
    assert(audioUrl, 'Failed processing must retain playable local audio')
    const stored = new EvidenceStore(join(options.profile, 'daily-review/evidence.sqlite'))
    try {
      assert.equal(
        stored
          .readSessions()
          .find((day) => day.id === dayId)
          ?.memory?.conversations.find((conversation) => conversation.episodeId === retryId)?.processingError,
        'revinote'
      )
    } finally {
      stored.close()
    }

    await target.evaluate(() => window.remember.updateSettings({ offlineMode: true }))
    const uploadsBeforeRestart = uploads
    await options.close()
    const archive = new EvidenceStore(join(options.profile, 'daily-review/evidence.sqlite'))
    try {
      const day = archive.readSessions().find((candidate) => candidate.id === dayId)
      assert(day?.memory)
      archive.upsertSession({
        ...day,
        memory: {
          ...day.memory,
          conversations: day.memory.conversations.map((conversation) =>
            conversation.episodeId === retryId
              ? {
                  ...conversation,
                  notes: 'Final QA note retained through Revinote',
                  recordingSource: { startedAt: day.startedAt, endedAt: day.startedAt + 2000, segments: [] },
                }
              : conversation
          ),
        },
      })
    } finally {
      archive.close()
    }
    target = await options.launch()
    await target.waitForFunction(
      async (id) =>
        (await window.remember.listDays())
          .flatMap((day) => day.memory?.conversations ?? [])
          .some(
            (conversation) =>
              conversation.episodeId === id && !conversation.processing && conversation.processingError === 'revinote'
          ),
      retryId
    )
    await target.evaluate(() => window.remember.updateSettings({ offlineMode: false }))
    await target.evaluate(() => window.remember.syncRevinote())
    const retryDeadline = Date.now() + 5_000
    while (uploads <= uploadsBeforeRestart && Date.now() < retryDeadline) await delay(25)
    assert(uploads > uploadsBeforeRestart, 'Restarted processing must retry a recoverable upload')
    assert.equal(ambiguousCompletions, 1, 'Restart must not retry ambiguous completion automatically')
    const manualError = await target.evaluate(
      async ({ dayId, episodeId }) => {
        try {
          await window.remember.postProcessConversationWithRevinote(dayId, `episode:${episodeId}`)
          return null
        } catch (error) {
          return String(error)
        }
      },
      { dayId, episodeId: ambiguousId }
    )
    assert(manualError?.includes('revinote-post-process-state-unknown'))
    assert.equal(ambiguousCompletions, 2, 'Manual retry must retry completion with the same ambiguous upload key')
    assert.equal(submitted, false, 'The ambiguous retry must not create a meeting')
    const pending = JSON.parse(readFileSync(join(directory, 'post-processing.json'), 'utf8'))
    assert.equal(pending.pending[ambiguousId].key, 'qa-ambiguous-upload')

    failUpload = false
    await target.evaluate(() => window.remember.syncRevinote())
    await target.waitForFunction(
      async (id) => (await window.remember.getRevinotePostProcessStatus(id)).state === 'queued',
      retryId
    )
    await target.evaluate(() => window.remember.syncRevinote())
    await target.waitForFunction(async () =>
      (await window.remember.listDays()).some((day) =>
        day.memory?.conversations.some(
          (conversation) =>
            conversation.externalId === 'qa-retried-meeting' &&
            conversation.source === 'revinote' &&
            !conversation.processing &&
            !conversation.processingError
        )
      )
    )
    const completed = (await target.evaluate(() => window.remember.listDays()))
      .flatMap((day) => day.memory?.conversations ?? [])
      .find((conversation) => conversation.externalId === 'qa-retried-meeting')
    assert(completed)
    assert.equal(completed.notes, 'Final QA note retained through Revinote')
    assert(completed.recordingSource, 'Cloud replacement must retain the exact local recording source')
    await target.evaluate(() => window.remember.syncRevinote())
    const repeated = (await target.evaluate(() => window.remember.listDays()))
      .flatMap((day) => day.memory?.conversations ?? [])
      .find((conversation) => conversation.externalId === 'qa-retried-meeting')
    assert.equal(repeated?.notes, completed.notes)
    assert.deepEqual(repeated?.recordingSource, completed.recordingSource)
    options.checks.push('Revinote replacement and repeat sync retain saved quick notes and local recording source')
    options.checks.push(
      'Always-on confirmation submits directly; failed upload retains local audio availability and its error state survives restart'
    )
    options.checks.push('Failed startup Revinote sync settles queued skeletons into a visible error')
    options.checks.push(
      'Revinote reconnect sync automatically retries failed uploads and replaces the error with the completed result'
    )
    options.checks.push(
      'Ambiguous uploaded completion stops automatic retries; manual retry preserves the key without duplicate presign/upload'
    )
    const currentElectron = options.getElectron()
    assert(currentElectron)
    await currentElectron.evaluate(({ shell }, url) => {
      const previousUrl = process.env.REMEMBER_REVINOTE_URL
      const openExternal = shell.openExternal
      const authorization = { state: '', openExternal, previousUrl }
      process.env.REMEMBER_REVINOTE_URL = url
      shell.openExternal = async (destination) => {
        const endpoint = new URL(destination)
        if (endpoint.origin !== url || endpoint.pathname !== '/api/auth/authorize')
          throw new Error('unexpected-qa-authorization-destination')
        authorization.state = endpoint.searchParams.get('state') ?? ''
      }
      Object.assign(globalThis, { qaRevinoteAuthorization: authorization })
    }, baseUrl)
    syncGate = new Promise<void>((resolve) => {
      releaseReconnectSync = resolve
    })
    const reconnectSyncArrived = new Promise<void>((resolve) => {
      syncArrived = resolve
    })
    const oldSync = target.evaluate(async () => {
      try {
        await window.remember.syncRevinote()
        return 'completed'
      } catch {
        return 'cancelled'
      }
    })
    await Promise.race([
      reconnectSyncArrived,
      delay(5000).then(() => {
        throw new Error('old sync did not arrive')
      }),
    ])
    assert.equal((await target.evaluate(() => window.remember.connectRevinote())).state, 'connecting')
    assert.equal(
      await Promise.race([
        oldSync,
        delay(2000).then(() => {
          throw new Error('reconnect did not cancel old sync')
        }),
      ]),
      'cancelled'
    )
    releaseReconnectSync?.()
    syncGate = null
    syncArrived = null
    const pendingRequests = syncRequests
    assert.equal((await target.evaluate(() => window.remember.syncRevinote())).status.state, 'connecting')
    assert.equal(syncRequests, pendingRequests, 'Pending authorization must not synchronize the old credential')
    const previousSync = (await target.evaluate(() => window.remember.getRevinoteConnectionStatus())).lastSyncedAt ?? 0
    await currentElectron.evaluate(({ app }, url) => {
      const authorization = (globalThis as unknown as { qaRevinoteAuthorization: { state: string } })
        .qaRevinoteAuthorization
      if (!authorization.state) throw new Error('qa-authorization-state-missing')
      app.emit(
        'open-url',
        { preventDefault() {} },
        `remember://revinote/callback?code=qa-code&state=${encodeURIComponent(authorization.state)}&iss=${encodeURIComponent(`${url}/api/auth`)}`
      )
    }, baseUrl)
    await target.waitForFunction(async (previous) => {
      const status = await window.remember.getRevinoteConnectionStatus()
      return status.state === 'connected' && status.method === 'oauth' && (status.lastSyncedAt ?? 0) > previous
    }, previousSync)
    assert.equal(tokenRequests, 1)
    options.checks.push(
      'Reconnecting cancels an old in-flight sync, retains Connecting during browser authorization, and only synchronizes after the state-bound OAuth callback'
    )
    return target
  } finally {
    releaseReconnectSync?.()
    try {
      await options.getElectron()?.evaluate(({ shell }) => {
        const authorization = (
          globalThis as unknown as {
            qaRevinoteAuthorization?: {
              openExternal: typeof shell.openExternal
              previousUrl?: string
            }
          }
        ).qaRevinoteAuthorization
        if (!authorization) return
        shell.openExternal = authorization.openExternal
        if (authorization.previousUrl === undefined) delete process.env.REMEMBER_REVINOTE_URL
        else process.env.REMEMBER_REVINOTE_URL = authorization.previousUrl
      })
    } catch {}
    if (target && !target.isClosed()) {
      await target.evaluate(() =>
        window.remember.updateSettings({ automaticRevinoteProcessing: false, offlineMode: true })
      )
      await target.evaluate(() => window.remember.disconnectRevinote())
    }
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
