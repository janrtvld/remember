import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type {
  RevinoteConnectionMethod,
  RevinoteConnectionStatus,
  RevinotePostProcessResult,
  RevinotePostProcessStatus,
  RevinoteSyncResult,
} from '@remember/shared'
import { CHANNELS } from '@remember/shared'
import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron'
import { isOfflineMode, requireNetworkAccess, runNetworkRequest, subscribeNetworkAccessChanges } from './networkAccess'
import {
  cancelableRevinoteAudioResponse,
  resolveRevinoteAudioResponse,
  revinoteAudioRequestHeaders,
} from './revinoteAudio'
import { requestedRevinoteOAuthScopes } from './revinoteOAuth'
import {
  failedRevinotePostProcessEpisodes,
  hasPendingRevinotePostProcesses,
  mergeRevinoteSyncMeetings,
  preparedUploadCanRestart,
  REVINOTE_COMPLETION_POLL_MS,
  shouldImportRevinoteMeeting,
} from './revinoteSyncState'

const PRODUCTION_REVINOTE_URL = 'https://www.revinote.com'
const REDIRECT_URI = 'remember://revinote/callback'
const SYNC_INTERVAL_MS = 5 * 60_000
const SYNC_THROTTLE_MS = 2 * 60_000
const REQUEST_TIMEOUT_MS = 20_000
const OAUTH_PENDING_MAX_AGE_MS = 15 * 60_000
const POST_PROCESS_UPLOAD_TIMEOUT_MS = 10 * 60_000

export type ImportedRevinoteMeeting = {
  id: string
  title: string | null
  status: string
  date: string
  updatedAt: string
  participants: string[]
  summary: string | null
  actionItems: Array<{ label: string; done: boolean }>
  durationSeconds: number | null
  transcript: string | null
}

type OAuthCredential = {
  method: 'oauth'
  clientId: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  tokenEndpoint: string
  baseUrl: string
  scopes?: string[]
}

type ApiKeyCredential = {
  method: 'api-key'
  apiKey: string
  baseUrl: string
}

type RevinoteCredential = OAuthCredential | ApiKeyCredential

type PendingOAuth = {
  state: string
  verifier: string
  clientId: string
  tokenEndpoint: string
  baseUrl: string
  scopes: string[]
  createdAt: number
}

type ImportStore = {
  version: 1
  cursor: string | null
  lastSyncedAt: number | null
  meetings: Record<string, ImportedRevinoteMeeting>
}

type SyncPage = {
  meetings: ImportedRevinoteMeeting[]
  nextCursor: string | null
  hasMore: boolean
}

type PostProcessStore = {
  version: 1
  submissions: Record<string, RevinotePostProcessResult & { settledAt?: number }>
  pending: Record<string, { key: string; preparedAt: number; stage: 'prepared' | 'uploaded' }>
  failures: Record<string, { meetingId: string; failedAt: number }>
}

type RegistrationMetadata = {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint: string
  scopes_supported?: string[]
}

let runtimeState: Pick<RevinoteConnectionStatus, 'state' | 'method' | 'error'> | null = null
let syncPromise: Promise<RevinoteSyncResult> | null = null
let pollTimer: NodeJS.Timeout | null = null
let onImportedMeetingsChanged: (() => void | Promise<void>) | null = null
const postProcessPromises = new Map<string, Promise<RevinotePostProcessResult>>()
let connectionLifetime = new AbortController()

function integrationDirectory() {
  return join(app.getPath('userData'), 'integrations', 'revinote')
}

function credentialsPath() {
  return join(integrationDirectory(), 'credentials.json')
}

function pendingOAuthPath() {
  return join(integrationDirectory(), 'oauth-pending.json')
}

function importsPath() {
  return join(integrationDirectory(), 'meetings.json')
}

function postProcessPath() {
  return join(integrationDirectory(), 'post-processing.json')
}

function ensureDirectory() {
  mkdirSync(integrationDirectory(), { recursive: true, mode: 0o700 })
  chmodSync(integrationDirectory(), 0o700)
}

function writeAtomic(path: string, contents: string) {
  ensureDirectory()
  const temporary = `${path}.tmp`
  writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, path)
}

function writeEncrypted(path: string, value: unknown) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('revinote-secure-storage-unavailable')
  const encrypted = safeStorage.encryptString(JSON.stringify(value)).toString('base64')
  writeAtomic(path, `${JSON.stringify({ version: 1, encrypted })}\n`)
}

function readEncrypted<T>(path: string): T | null {
  if (!existsSync(path)) return null
  if (!safeStorage.isEncryptionAvailable()) throw new Error('revinote-secure-storage-unavailable')
  const stored = JSON.parse(readFileSync(path, 'utf8')) as { version?: number; encrypted?: unknown }
  if (stored.version !== 1 || typeof stored.encrypted !== 'string') throw new Error('revinote-credential-invalid')
  return JSON.parse(safeStorage.decryptString(Buffer.from(stored.encrypted, 'base64'))) as T
}

function emptyImportStore(): ImportStore {
  return { version: 1, cursor: null, lastSyncedAt: null, meetings: {} }
}

function validMeeting(value: unknown): value is ImportedRevinoteMeeting {
  if (!value || typeof value !== 'object') return false
  const meeting = value as Partial<ImportedRevinoteMeeting>
  return (
    typeof meeting.id === 'string' &&
    (typeof meeting.title === 'string' || meeting.title === null) &&
    typeof meeting.status === 'string' &&
    typeof meeting.date === 'string' &&
    Number.isFinite(Date.parse(meeting.date)) &&
    typeof meeting.updatedAt === 'string' &&
    Number.isFinite(Date.parse(meeting.updatedAt)) &&
    Array.isArray(meeting.participants) &&
    meeting.participants.every((participant) => typeof participant === 'string') &&
    (typeof meeting.summary === 'string' || meeting.summary === null) &&
    Array.isArray(meeting.actionItems) &&
    meeting.actionItems.every(
      (item) => item && typeof item === 'object' && typeof item.label === 'string' && typeof item.done === 'boolean'
    ) &&
    (typeof meeting.durationSeconds === 'number' || meeting.durationSeconds === null) &&
    (typeof meeting.transcript === 'string' || meeting.transcript === null)
  )
}

function readImportStore(): ImportStore {
  try {
    if (!existsSync(importsPath())) return emptyImportStore()
    const stored = JSON.parse(readFileSync(importsPath(), 'utf8')) as Partial<ImportStore>
    if (stored.version !== 1 || !stored.meetings || typeof stored.meetings !== 'object') return emptyImportStore()
    const meetings = Object.fromEntries(
      Object.entries(stored.meetings).filter(
        (entry): entry is [string, ImportedRevinoteMeeting] =>
          validMeeting(entry[1]) && shouldImportRevinoteMeeting(entry[1])
      )
    )
    return {
      version: 1,
      cursor: typeof stored.cursor === 'string' ? stored.cursor : null,
      lastSyncedAt:
        typeof stored.lastSyncedAt === 'number' && Number.isFinite(stored.lastSyncedAt) ? stored.lastSyncedAt : null,
      meetings,
    }
  } catch {
    return emptyImportStore()
  }
}

function writeImportStore(store: ImportStore) {
  writeAtomic(importsPath(), `${JSON.stringify(store, null, 2)}\n`)
}

function readPostProcessStore(): PostProcessStore {
  try {
    if (!existsSync(postProcessPath())) return { version: 1, submissions: {}, pending: {}, failures: {} }
    const stored = JSON.parse(readFileSync(postProcessPath(), 'utf8')) as Partial<PostProcessStore>
    if (stored.version !== 1 || !stored.submissions || typeof stored.submissions !== 'object') {
      return { version: 1, submissions: {}, pending: {}, failures: {} }
    }
    const submissions = Object.fromEntries(
      Object.entries(stored.submissions).filter((entry): entry is [string, RevinotePostProcessResult] => {
        const value = entry[1]
        return (
          value != null &&
          typeof value === 'object' &&
          typeof value.meetingId === 'string' &&
          typeof value.submittedAt === 'number' &&
          Number.isFinite(value.submittedAt)
        )
      })
    )
    const pending = Object.fromEntries(
      Object.entries(stored.pending ?? {}).flatMap(([episodeId, value]) => {
        if (
          value == null ||
          typeof value !== 'object' ||
          typeof value.key !== 'string' ||
          typeof value.preparedAt !== 'number' ||
          !Number.isFinite(value.preparedAt) ||
          (value.stage != null && value.stage !== 'prepared' && value.stage !== 'uploaded')
        ) {
          return []
        }
        return [
          [
            episodeId,
            {
              key: value.key,
              preparedAt: value.preparedAt,
              // Older clients persisted the key before upload and could crash after it. Treat that state as
              // uploaded so a 400 can never silently create a duplicate server meeting.
              stage: value.stage ?? 'uploaded',
            },
          ],
        ]
      })
    )
    const failures = Object.fromEntries(
      Object.entries(stored.failures ?? {}).filter(
        (entry): entry is [string, { meetingId: string; failedAt: number }] => {
          const value = entry[1]
          return (
            value != null &&
            typeof value === 'object' &&
            typeof value.meetingId === 'string' &&
            typeof value.failedAt === 'number' &&
            Number.isFinite(value.failedAt)
          )
        }
      )
    )
    return { version: 1, submissions, pending, failures }
  } catch {
    return { version: 1, submissions: {}, pending: {}, failures: {} }
  }
}

function writePostProcessStore(store: PostProcessStore) {
  writeAtomic(postProcessPath(), `${JSON.stringify(store, null, 2)}\n`)
}

function recordPostProcessCompletions(meetings: ImportedRevinoteMeeting[]) {
  const store = readPostProcessStore()
  const failed = failedRevinotePostProcessEpisodes(store.submissions, meetings)
  const completedIds = new Set(
    meetings
      .filter((meeting) => meeting.status === 'finished' || meeting.status === 'processed')
      .map((meeting) => meeting.id)
  )
  const completed = Object.values(store.submissions).filter(
    (submission) => submission.settledAt == null && completedIds.has(submission.meetingId)
  )
  if (failed.length === 0 && completed.length === 0) return
  const settledAt = Date.now()
  for (const submission of completed) submission.settledAt = settledAt
  for (const failure of failed) {
    delete store.submissions[failure.episodeId]
    delete store.pending[failure.episodeId]
    store.failures[failure.episodeId] = { meetingId: failure.meetingId, failedAt: settledAt }
  }
  writePostProcessStore(store)
}

export function getRevinotePostProcessStatus(episodeId: string): RevinotePostProcessStatus {
  const submission = readPostProcessStore().submissions[episodeId]
  if (!submission) return { state: 'idle', meetingId: null, submittedAt: null }
  return { state: 'queued', ...submission }
}

export function getRevinotePostProcessSubmissions() {
  return Object.entries(readPostProcessStore().submissions).map(([episodeId, submission]) => ({
    episodeId,
    ...submission,
  }))
}

export function getFailedRevinotePostProcesses() {
  return Object.entries(readPostProcessStore().failures).map(([episodeId, failure]) => ({ episodeId, ...failure }))
}

function configuredBaseUrl() {
  const raw = process.env.REMEMBER_REVINOTE_URL?.trim() || PRODUCTION_REVINOTE_URL
  const url = new URL(raw)
  const localDevelopment =
    !app.isPackaged && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !localDevelopment) || url.username || url.password || url.search || url.hash) {
    throw new Error('revinote-url-invalid')
  }
  return url.origin
}

function trustedEndpoint(value: unknown, baseUrl: string) {
  if (typeof value !== 'string') throw new Error('revinote-oauth-metadata-invalid')
  const endpoint = new URL(value)
  if (endpoint.origin !== new URL(baseUrl).origin || endpoint.username || endpoint.password) {
    throw new Error('revinote-oauth-metadata-invalid')
  }
  return endpoint.toString()
}

async function request(url: string, init: RequestInit = {}) {
  return runNetworkRequest(
    (signal) =>
      fetch(url, { ...init, signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal, cache: 'no-store' }),
    REQUEST_TIMEOUT_MS
  )
}

async function responseJson(response: Response) {
  return (await response.json().catch(() => null)) as unknown
}

async function oauthMetadata(baseUrl: string): Promise<RegistrationMetadata> {
  const response = await request(`${baseUrl}/.well-known/oauth-authorization-server`)
  if (!response.ok) throw new Error('revinote-oauth-metadata-unavailable')
  const value = (await responseJson(response)) as Partial<RegistrationMetadata> | null
  if (!value || typeof value !== 'object') throw new Error('revinote-oauth-metadata-invalid')
  const issuer = trustedEndpoint(value.issuer, baseUrl)
  if (issuer.replace(/\/$/, '') !== `${baseUrl}/api/auth`) throw new Error('revinote-oauth-metadata-invalid')
  return {
    issuer,
    authorization_endpoint: trustedEndpoint(value.authorization_endpoint, baseUrl),
    token_endpoint: trustedEndpoint(value.token_endpoint, baseUrl),
    registration_endpoint: trustedEndpoint(value.registration_endpoint, baseUrl),
    scopes_supported: Array.isArray(value.scopes_supported)
      ? value.scopes_supported.filter((scope): scope is string => typeof scope === 'string')
      : undefined,
  }
}

function randomBase64Url(bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

function stateMatches(expected: string, received: string) {
  const expectedBuffer = Buffer.from(expected)
  const receivedBuffer = Buffer.from(received)
  return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer)
}

function emitStatus() {
  const status = getRevinoteConnectionStatus()
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.revinoteStatusChanged, status)
  }
}

function statusError(error: unknown, method: RevinoteConnectionMethod | null) {
  runtimeState = {
    state: 'error',
    method,
    error: error instanceof Error ? error.message : 'revinote-sync-failed',
  }
  emitStatus()
}

export function getImportedRevinoteMeetings() {
  return Object.values(readImportStore().meetings).sort(
    (first, second) => Date.parse(first.date) - Date.parse(second.date)
  )
}

export function getRevinoteConnectionStatus(): RevinoteConnectionStatus {
  const imports = readImportStore()
  const canPostProcess = (() => {
    if (!existsSync(credentialsPath())) return false
    try {
      const credential = readEncrypted<RevinoteCredential>(credentialsPath())
      return (
        credential?.method === 'api-key' ||
        (credential?.method === 'oauth' && credential.scopes?.includes('meetings:write') === true)
      )
    } catch {
      return false
    }
  })()
  if (runtimeState)
    return {
      ...runtimeState,
      canPostProcess,
      lastSyncedAt: imports.lastSyncedAt,
      importedCount: Object.keys(imports.meetings).length,
    }
  if (!existsSync(credentialsPath())) {
    return {
      state: 'disconnected',
      method: null,
      canPostProcess: false,
      lastSyncedAt: imports.lastSyncedAt,
      importedCount: Object.keys(imports.meetings).length,
      error: null,
    }
  }
  let credential: RevinoteCredential | null = null
  try {
    credential = readEncrypted<RevinoteCredential>(credentialsPath())
  } catch {
    return {
      state: 'error',
      method: null,
      canPostProcess: false,
      lastSyncedAt: imports.lastSyncedAt,
      importedCount: Object.keys(imports.meetings).length,
      error: 'revinote-credential-invalid',
    }
  }
  return {
    state: 'connected',
    method: credential?.method ?? null,
    canPostProcess,
    lastSyncedAt: imports.lastSyncedAt,
    importedCount: Object.keys(imports.meetings).length,
    error: null,
  }
}

export async function connectRevinoteOAuth() {
  requireNetworkAccess()
  connectionLifetime.abort(new Error('revinote-connection-replaced'))
  connectionLifetime = new AbortController()
  const connection = connectionLifetime.signal
  await syncPromise?.catch(() => undefined)
  connection.throwIfAborted()
  const baseUrl = configuredBaseUrl()
  runtimeState = { state: 'connecting', method: 'oauth', error: null }
  emitStatus()
  try {
    const metadata = await oauthMetadata(baseUrl)
    connection.throwIfAborted()
    const scopes = requestedRevinoteOAuthScopes(metadata.scopes_supported)
    const scope = scopes.join(' ')
    const registration = await request(metadata.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: connection,
      body: JSON.stringify({
        client_name: 'Remember',
        client_uri: 'https://remember.computer',
        logo_uri: 'https://remember.computer/logo.png',
        application_type: 'native',
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope,
      }),
    })
    const registered = (await responseJson(registration)) as { client_id?: unknown } | null
    connection.throwIfAborted()
    if (!registration.ok || typeof registered?.client_id !== 'string')
      throw new Error('revinote-oauth-registration-failed')

    const state = randomBase64Url()
    const verifier = randomBase64Url(48)
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    writeEncrypted(pendingOAuthPath(), {
      state,
      verifier,
      clientId: registered.client_id,
      tokenEndpoint: metadata.token_endpoint,
      baseUrl,
      scopes,
      createdAt: Date.now(),
    } satisfies PendingOAuth)

    const authorizationUrl = new URL(metadata.authorization_endpoint)
    authorizationUrl.searchParams.set('response_type', 'code')
    authorizationUrl.searchParams.set('client_id', registered.client_id)
    authorizationUrl.searchParams.set('redirect_uri', REDIRECT_URI)
    authorizationUrl.searchParams.set('scope', scope)
    authorizationUrl.searchParams.set('resource', `${baseUrl}/api/v1`)
    authorizationUrl.searchParams.set('state', state)
    authorizationUrl.searchParams.set('code_challenge', challenge)
    authorizationUrl.searchParams.set('code_challenge_method', 'S256')
    requireNetworkAccess()
    await shell.openExternal(authorizationUrl.toString())
    return getRevinoteConnectionStatus()
  } catch (error) {
    if (connection === connectionLifetime.signal && !connection.aborted) statusError(error, 'oauth')
    throw error
  }
}

async function tokenRequest(endpoint: string, body: URLSearchParams, signal?: AbortSignal) {
  const response = await request(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal,
  })
  const value = (await responseJson(response)) as {
    access_token?: unknown
    refresh_token?: unknown
    expires_in?: unknown
    scope?: unknown
  } | null
  if (!response.ok || typeof value?.access_token !== 'string') throw new Error('revinote-authentication-failed')
  return {
    accessToken: value.access_token,
    refreshToken: typeof value.refresh_token === 'string' ? value.refresh_token : null,
    expiresIn: typeof value.expires_in === 'number' && Number.isFinite(value.expires_in) ? value.expires_in : 3600,
    scopes:
      typeof value.scope === 'string'
        ? value.scope
            .split(/\s+/)
            .map((scope) => scope.trim())
            .filter(Boolean)
        : null,
  }
}

export async function completeRevinoteOAuth(input: {
  code: string | null
  state: string
  issuer: string | null
  error: string | null
}) {
  let connection = connectionLifetime.signal
  requireNetworkAccess()
  runtimeState = { state: 'connecting', method: 'oauth', error: null }
  emitStatus()
  try {
    const pending = readEncrypted<PendingOAuth>(pendingOAuthPath())
    if (!pending || Date.now() - pending.createdAt > OAUTH_PENDING_MAX_AGE_MS)
      throw new Error('revinote-oauth-state-expired')
    if (!stateMatches(pending.state, input.state)) throw new Error('revinote-oauth-state-mismatch')
    if (input.error) throw new Error('revinote-oauth-denied')
    if (!input.code) throw new Error('revinote-oauth-code-missing')
    if (input.issuer && input.issuer.replace(/\/$/, '') !== `${pending.baseUrl}/api/auth`) {
      throw new Error('revinote-oauth-issuer-mismatch')
    }

    connectionLifetime.abort(new Error('revinote-connection-replaced'))
    connectionLifetime = new AbortController()
    connection = connectionLifetime.signal
    await syncPromise?.catch(() => undefined)
    connection.throwIfAborted()

    const tokens = await tokenRequest(
      pending.tokenEndpoint,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: REDIRECT_URI,
        client_id: pending.clientId,
        code_verifier: pending.verifier,
        resource: `${pending.baseUrl}/api/v1`,
      }),
      connection
    )
    if (!tokens.refreshToken) throw new Error('revinote-refresh-token-missing')
    connection.throwIfAborted()
    writeEncrypted(credentialsPath(), {
      method: 'oauth',
      clientId: pending.clientId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: Date.now() + tokens.expiresIn * 1_000,
      tokenEndpoint: pending.tokenEndpoint,
      baseUrl: pending.baseUrl,
      scopes: tokens.scopes ?? pending.scopes,
    } satisfies OAuthCredential)
    rmSync(pendingOAuthPath(), { force: true })
    runtimeState = null
    const result = await syncRevinote({ force: true })
    return result.status
  } catch (error) {
    if (connection === connectionLifetime.signal && !connection.aborted) statusError(error, 'oauth')
    throw error
  }
}

async function accessToken(
  credential: RevinoteCredential,
  forceRefresh = false,
  connection = connectionLifetime.signal
) {
  connection.throwIfAborted()
  if (credential.method === 'api-key') return { token: credential.apiKey, credential }
  if (!forceRefresh && credential.expiresAt > Date.now() + 60_000) {
    return { token: credential.accessToken, credential }
  }

  const tokens = await tokenRequest(
    credential.tokenEndpoint,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credential.refreshToken,
      client_id: credential.clientId,
      resource: `${credential.baseUrl}/api/v1`,
    }),
    connection
  )
  const refreshed: OAuthCredential = {
    ...credential,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? credential.refreshToken,
    expiresAt: Date.now() + tokens.expiresIn * 1_000,
    scopes: tokens.scopes ?? credential.scopes,
  }
  connection.throwIfAborted()
  writeEncrypted(credentialsPath(), refreshed)
  return { token: refreshed.accessToken, credential: refreshed }
}

async function authorizedRequest(pathname: string, init: RequestInit) {
  const connection = connectionLifetime.signal
  const credential = readEncrypted<RevinoteCredential>(credentialsPath())
  if (!credential) throw new Error('revinote-not-connected')

  let authorized = await accessToken(credential, false, connection)
  let response = await request(new URL(pathname, authorized.credential.baseUrl).toString(), {
    ...init,
    signal: init.signal ? AbortSignal.any([connection, init.signal]) : connection,
    headers: { ...init.headers, Authorization: `Bearer ${authorized.token}` },
  })
  if (response.status === 401 && authorized.credential.method === 'oauth') {
    await response.body?.cancel()
    authorized = await accessToken(authorized.credential, true, connection)
    response = await request(new URL(pathname, authorized.credential.baseUrl).toString(), {
      ...init,
      signal: init.signal ? AbortSignal.any([connection, init.signal]) : connection,
      headers: { ...init.headers, Authorization: `Bearer ${authorized.token}` },
    })
  }
  return response
}

export async function fetchRevinoteConversationAudio(
  meetingId: string,
  requestHeaders: Headers
): Promise<Response | null> {
  const connection = connectionLifetime.signal
  if (!meetingId || isOfflineMode() || !existsSync(credentialsPath())) return null
  const response = await authorizedRequest(`/api/v1/meetings/${encodeURIComponent(meetingId)}/audio`, {
    headers: revinoteAudioRequestHeaders(requestHeaders),
    redirect: 'manual',
  })
  const developmentOrigin = app.isPackaged ? undefined : readEncrypted<RevinoteCredential>(credentialsPath())?.baseUrl
  const audio = await resolveRevinoteAudioResponse(
    response,
    requestHeaders,
    (url, init) => request(url, { ...init, signal: connection }),
    developmentOrigin
  )
  return audio
    ? cancelableRevinoteAudioResponse(audio, (cancel) => {
        const cancelWhenOffline = () => {
          if (isOfflineMode()) cancel()
        }
        const unsubscribe = subscribeNetworkAccessChanges(cancelWhenOffline)
        connection.addEventListener('abort', cancel, { once: true })
        if (connection.aborted) cancel()
        cancelWhenOffline()
        return () => {
          unsubscribe()
          connection.removeEventListener('abort', cancel)
        }
      })
    : null
}

function postProcessApiError(response: Response) {
  if (response.status === 401) return new Error('revinote-permission-required')
  if (response.status === 402) return new Error('revinote-minutes-required')
  if (response.status === 403) return new Error('revinote-plan-required')
  return new Error('revinote-post-process-failed')
}

type PostProcessInput = {
  episodeId: string
  audioPath: string
  durationSeconds: number
  recordedAt: string
}

async function completePostProcessUpload(key: string, input: PostProcessInput) {
  const response = await authorizedRequest('/api/v1/recordings/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key,
      durationSeconds: input.durationSeconds,
      recordedAt: input.recordedAt,
    }),
  })
  if (!response.ok) return { response, result: null }
  const completed = (await responseJson(response)) as { meetingId?: unknown } | null
  if (typeof completed?.meetingId !== 'string') throw new Error('revinote-post-process-response-invalid')
  return { response, result: { meetingId: completed.meetingId, submittedAt: Date.now() } }
}

function persistPostProcessResult(episodeId: string, result: RevinotePostProcessResult) {
  const store = readPostProcessStore()
  store.submissions[episodeId] = result
  delete store.pending[episodeId]
  delete store.failures[episodeId]
  writePostProcessStore(store)
  scheduleRevinoteSync()
  return result
}

async function runPostProcessConversation(input: PostProcessInput): Promise<RevinotePostProcessResult> {
  const existing = getRevinotePostProcessStatus(input.episodeId)
  if (existing.state === 'queued' && existing.meetingId && existing.submittedAt) {
    return { meetingId: existing.meetingId, submittedAt: existing.submittedAt }
  }
  if (!existsSync(input.audioPath)) throw new Error('conversation-audio-not-found')

  const pending = readPostProcessStore().pending[input.episodeId]
  if (pending) {
    const resumed = await completePostProcessUpload(pending.key, input)
    if (resumed.result) return persistPostProcessResult(input.episodeId, resumed.result)
    if (resumed.response.status !== 400) throw postProcessApiError(resumed.response)
    if (!preparedUploadCanRestart(pending.stage, resumed.response.status)) {
      throw new Error('revinote-post-process-state-unknown')
    }
    const store = readPostProcessStore()
    if (store.pending[input.episodeId]?.key === pending.key) {
      delete store.pending[input.episodeId]
      writePostProcessStore(store)
    }
  }

  const presign = await authorizedRequest('/api/v1/recordings/presign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentType: 'audio/wav' }),
  })
  if (!presign.ok) throw postProcessApiError(presign)
  const prepared = (await responseJson(presign)) as { uploadUrl?: unknown; key?: unknown } | null
  if (typeof prepared?.uploadUrl !== 'string' || typeof prepared.key !== 'string') {
    throw new Error('revinote-post-process-response-invalid')
  }
  const uploadUrl = prepared.uploadUrl
  const store = readPostProcessStore()
  store.pending[input.episodeId] = { key: prepared.key, preparedAt: Date.now(), stage: 'prepared' }
  writePostProcessStore(store)

  const upload = await runNetworkRequest(
    (signal) =>
      fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'audio/wav',
          'Content-Length': String(statSync(input.audioPath).size),
        },
        body: createReadStream(input.audioPath),
        duplex: 'half',
        signal,
      } as unknown as RequestInit & { duplex: 'half' }),
    POST_PROCESS_UPLOAD_TIMEOUT_MS
  )
  if (!upload.ok) throw new Error('revinote-post-process-upload-failed')

  const uploadedStore = readPostProcessStore()
  const uploadedPending = uploadedStore.pending[input.episodeId]
  if (uploadedPending?.key === prepared.key) {
    uploadedStore.pending[input.episodeId] = { ...uploadedPending, stage: 'uploaded' }
    writePostProcessStore(uploadedStore)
  }

  const completed = await completePostProcessUpload(prepared.key, input)
  if (!completed.result) throw postProcessApiError(completed.response)
  return persistPostProcessResult(input.episodeId, completed.result)
}

export function postProcessConversationWithRevinote(input: PostProcessInput): Promise<RevinotePostProcessResult> {
  const running = postProcessPromises.get(input.episodeId)
  if (running) return running
  const request = runPostProcessConversation(input).finally(() => postProcessPromises.delete(input.episodeId))
  postProcessPromises.set(input.episodeId, request)
  return request
}

function parseSyncPage(value: unknown): SyncPage | null {
  if (!value || typeof value !== 'object') return null
  const page = value as Partial<SyncPage>
  if (!Array.isArray(page.meetings) || !page.meetings.every(validMeeting) || typeof page.hasMore !== 'boolean')
    return null
  if (page.nextCursor !== null && typeof page.nextCursor !== 'string') return null
  return { meetings: page.meetings, nextCursor: page.nextCursor, hasMore: page.hasMore }
}

async function fetchSyncPage(
  credential: RevinoteCredential,
  token: string,
  cursor: string | null,
  connection: AbortSignal
) {
  const url = new URL('/api/v1/meetings/sync', credential.baseUrl)
  url.searchParams.set('limit', '100')
  if (cursor) url.searchParams.set('cursor', cursor)
  const response = await request(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    signal: connection,
  })
  if (response.status === 401) throw new Error('revinote-authentication-failed')
  if (response.status === 403) throw new Error('revinote-plan-required')
  if (!response.ok) throw new Error('revinote-sync-failed')
  const page = parseSyncPage(await responseJson(response))
  if (!page) throw new Error('revinote-sync-response-invalid')
  return page
}

async function performSync(force: boolean, connection: AbortSignal): Promise<RevinoteSyncResult> {
  connection.throwIfAborted()
  const initialStore = readImportStore()
  const throttle = hasPendingRevinotePostProcesses(readPostProcessStore().submissions, initialStore.meetings)
    ? REVINOTE_COMPLETION_POLL_MS
    : SYNC_THROTTLE_MS
  if (!force && initialStore.lastSyncedAt && Date.now() - initialStore.lastSyncedAt < throttle) {
    return { status: getRevinoteConnectionStatus(), imported: 0, updated: 0 }
  }
  const credential = readEncrypted<RevinoteCredential>(credentialsPath())
  if (!credential) {
    runtimeState = null
    return { status: getRevinoteConnectionStatus(), imported: 0, updated: 0 }
  }

  runtimeState = { state: 'connected', method: credential.method, error: null }
  emitStatus()
  let currentCredential = credential
  let currentToken = (await accessToken(currentCredential, false, connection)).token
  if (credential.method === 'oauth') currentCredential = readEncrypted<OAuthCredential>(credentialsPath()) ?? credential
  let cursor = force ? null : initialStore.cursor
  let meetings = force ? {} : { ...initialStore.meetings }
  const stagedMeetings: ImportedRevinoteMeeting[] = []
  let imported = 0
  let updated = 0
  let pageCount = 0
  let retriedAuthentication = false

  while (true) {
    let page: SyncPage
    try {
      page = await fetchSyncPage(currentCredential, currentToken, cursor, connection)
    } catch (error) {
      if (
        !retriedAuthentication &&
        currentCredential.method === 'oauth' &&
        error instanceof Error &&
        error.message === 'revinote-authentication-failed'
      ) {
        retriedAuthentication = true
        const refreshed = await accessToken(currentCredential, true, connection)
        currentCredential = refreshed.credential
        currentToken = refreshed.token
        page = await fetchSyncPage(currentCredential, currentToken, cursor, connection)
      } else {
        throw error
      }
    }

    connection.throwIfAborted()
    stagedMeetings.push(...page.meetings)
    for (const meeting of page.meetings) {
      if (!shouldImportRevinoteMeeting(meeting)) continue
      const existing = initialStore.meetings[meeting.id]
      if (!existing) imported += 1
      else if (existing.updatedAt !== meeting.updatedAt) updated += 1
    }
    cursor = page.nextCursor
    if (!force) {
      meetings = mergeRevinoteSyncMeetings(meetings, page.meetings, false)
      writeImportStore({ ...initialStore, meetings, cursor })
    }
    pageCount += 1
    if (!page.hasMore) break
    if (!page.nextCursor || pageCount > 10_000) throw new Error('revinote-sync-pagination-invalid')
  }

  connection.throwIfAborted()
  if (force) meetings = mergeRevinoteSyncMeetings(initialStore.meetings, stagedMeetings, true)
  const store = { ...initialStore, meetings, cursor, lastSyncedAt: Date.now() }
  writeImportStore(store)
  recordPostProcessCompletions(stagedMeetings)
  runtimeState = null
  await onImportedMeetingsChanged?.()
  emitStatus()
  return { status: getRevinoteConnectionStatus(), imported, updated }
}

export async function syncRevinote(options: { force?: boolean } = {}) {
  if (runtimeState?.state === 'connecting') {
    scheduleRevinoteSync()
    return { status: getRevinoteConnectionStatus(), imported: 0, updated: 0 }
  }
  if (syncPromise) return syncPromise
  const connection = connectionLifetime.signal
  syncPromise = Promise.resolve()
    .then(() => {
      requireNetworkAccess()
      return performSync(options.force === true, connection)
    })
    .catch(async (error) => {
      if (connection !== connectionLifetime.signal || connection.aborted) throw error
      const method = (() => {
        try {
          return readEncrypted<RevinoteCredential>(credentialsPath())?.method ?? null
        } catch {
          return null
        }
      })()
      statusError(error, method)
      // A startup pass may have waited for this sync; expose its failure on queued conversations too.
      await onImportedMeetingsChanged?.()
      throw error
    })
    .finally(() => {
      syncPromise = null
      scheduleRevinoteSync()
    })
  return syncPromise
}

export async function disconnectRevinote() {
  connectionLifetime.abort(new Error('revinote-not-connected'))
  connectionLifetime = new AbortController()
  rmSync(credentialsPath(), { force: true })
  rmSync(pendingOAuthPath(), { force: true })
  // Let an in-flight sync finish before clearing its persisted snapshot.
  await syncPromise?.catch(() => undefined)
  rmSync(importsPath(), { force: true })
  runtimeState = null
  await onImportedMeetingsChanged?.()
  emitStatus()
  return getRevinoteConnectionStatus()
}

export function registerRevinoteIntegration(options: { onImportedMeetingsChanged: () => void | Promise<void> }) {
  onImportedMeetingsChanged = options.onImportedMeetingsChanged
  ipcMain.handle(CHANNELS.revinoteGetStatus, () => getRevinoteConnectionStatus())
  ipcMain.handle(CHANNELS.revinoteConnect, () => connectRevinoteOAuth())
  ipcMain.handle(CHANNELS.revinoteSync, () => syncRevinote({ force: true }))
  ipcMain.handle(CHANNELS.revinoteDisconnect, () => disconnectRevinote())
  ipcMain.handle(CHANNELS.revinotePostProcessGetStatus, (_event, episodeId: string) => {
    if (typeof episodeId !== 'string' || !episodeId) throw new Error('invalid-conversation')
    return getRevinotePostProcessStatus(episodeId)
  })

  scheduleRevinoteSync()
  if (existsSync(credentialsPath()) && !isOfflineMode()) void syncRevinote({ force: true }).catch(() => undefined)
}

function scheduleRevinoteSync() {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
  if (!onImportedMeetingsChanged) return
  const pending = hasPendingRevinotePostProcesses(readPostProcessStore().submissions, readImportStore().meetings)
  pollTimer = setTimeout(
    () => {
      pollTimer = null
      if (isOfflineMode()) scheduleRevinoteSync()
      else void syncRevinote().catch(() => undefined)
    },
    pending ? REVINOTE_COMPLETION_POLL_MS : SYNC_INTERVAL_MS
  )
}

export function disposeRevinoteIntegration() {
  connectionLifetime.abort(new Error('revinote-not-connected'))
  connectionLifetime = new AbortController()
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
  onImportedMeetingsChanged = null
}
