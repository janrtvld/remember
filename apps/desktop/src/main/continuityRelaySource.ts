import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { isAbsolute, relative } from 'node:path'
import { promisify } from 'node:util'

type SourceRecord = Record<string, unknown>
type SourceRef = { kind: string; id: string }
type Operation = 'created' | 'updated' | 'deleted'
type SourceRedaction = {
  reason: 'authentication_surface'
  detection: 'preview_metadata' | 'source_metadata'
  omittedFields: string[]
}
type SelfEchoLabel = {
  classification: 'confirmed' | 'uncertain'
  basis:
    | 'exact_thread_metadata'
    | 'exact_thread_url'
    | 'conflicting_thread_identity'
    | 'embedded_relay_marker'
    | 'no_exact_thread_identity'
  scope: 'surface_provenance_only'
  threadId?: string
}
export type RelayChange = {
  sourceRef: SourceRef
  operation: Operation
  availability: 'available' | 'not_found'
  record: SourceRecord | null
  sourceDetails?: SourceRecord
  redaction?: SourceRedaction
  selfEcho?: SelfEchoLabel
  readAt: number
  changeObservedAt: number
  readContentHash: string | null
  historicalVersionGuaranteed: false
  origin: 'source' | 'relay'
  eligibleForWorkUpdate: boolean
}
type ExecuteOptions = {
  encoding: 'utf8'
  env: NodeJS.ProcessEnv
  timeout: number
  maxBuffer: number
  signal?: AbortSignal
}
type Execute = (file: string, args: string[], options: ExecuteOptions) => Promise<{ stdout: string; stderr?: string }>
type SourceOptions = {
  cliPath: string
  dataDirectory: string
  cacheDirectory: string
  excludedThreadIds: string[]
  execute?: Execute
  signal?: AbortSignal
}

const executeFile = promisify(execFile)
const authenticationHosts = new Set([
  'accounts.google.com',
  'login.microsoftonline.com',
  'login.live.com',
  'appleid.apple.com',
  'idmsa.apple.com',
])
const sensitiveQueryNames = new Set(['access_token', 'id_token', 'refresh_token', 'client_secret', 'password'])

export function authenticationSurfaceMetadata(record: SourceRecord) {
  for (const key of [
    'window_title',
    'windowTitle',
    'window',
    'title',
    'application',
    'applicationName',
    'application_name',
    'applicationId',
    'application_id',
    'applicationBundleId',
    'application_bundle_id',
    'bundleId',
    'bundle_id',
    'app',
    'appName',
    'app_name',
    'appId',
  ]) {
    if (typeof record[key] !== 'string') continue
    if (['loginwindow', 'com.apple.loginwindow'].includes(record[key].trim().toLowerCase())) return true
  }
  const authenticationTitle =
    /^(?:log[ -]?in|sign[ -]?in|aanmelden|inloggen|authenticat(?:ion|e)|two-factor authentication|multi-factor authentication|password(?: reset)?|reset password|forgot password|wachtwoord(?: opnieuw instellen)?)(?:\s+to\s+.+|\s*[-–—|:]\s*.+)?$/i
  for (const key of ['window_title', 'windowTitle', 'window', 'title']) {
    if (typeof record[key] === 'string' && authenticationTitle.test(record[key].trim())) return true
  }
  if (typeof record.url !== 'string' || !record.url) return false
  try {
    const url = new URL(record.url)
    if (!['https:', 'http:'].includes(url.protocol)) return false
    if (url.username || url.password) return true
    for (const name of url.searchParams.keys()) {
      if (sensitiveQueryNames.has(name.toLowerCase())) return true
    }
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
    if (authenticationHosts.has(hostname)) return true
    const labels = hostname.split('.')
    if (labels.length > 2 && labels.slice(0, -2).some((label) => /^(?:auth|login|signin|sso)$/.test(label))) return true
    return /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:v\d+(?:\.\d+)?\/)?(?:(?:account|accounts|user|users|session|sessions)\/)?(?:login|log-in|sign_in|signin|sign-in|auth|authenticate|authentication|oauth|oauth2|sso|password|reset-password|forgot-password|mfa|2fa)(?:\/|$)/i.test(
      url.pathname
    )
  } catch {
    return false
  }
}

export function createRememberRelaySource(options: SourceOptions) {
  const { cliPath, dataDirectory, cacheDirectory } = options
  if (![cliPath, dataDirectory, cacheDirectory].every(isAbsolute)) {
    throw new Error('Remember relay requires absolute CLI, profile and cache paths')
  }
  const cacheFromProfile = relative(dataDirectory, cacheDirectory)
  if (!cacheFromProfile.startsWith('../') && cacheFromProfile !== '..') {
    throw new Error('Remember relay cache must be outside the source profile')
  }
  const execute: Execute = options.execute ?? executeFile
  const excludedThreadIds = new Set(options.excludedThreadIds)
  const authenticationPreviews = new Map<string, { record: SourceRecord; redaction: SourceRedaction }>()

  async function invoke(args: string[]) {
    options.signal?.throwIfAborted()
    const result = await execute(cliPath, [...args, '--json'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        REMEMBER_AGENT: 'codex',
        REMEMBER_DATA_DIR: dataDirectory,
        REMEMBER_CONTINUITY_DIR: cacheDirectory,
      },
      timeout: 30_000,
      maxBuffer: 128 * 1024 * 1024,
      signal: options.signal,
    })
    options.signal?.throwIfAborted()
    return object(JSON.parse(result.stdout), `Remember ${args[0]} response`)
  }

  async function verify() {
    const status = await invoke(['status'])
    if (status.dataDirectory !== dataDirectory) throw new Error('Remember profile mismatch; cursor unchanged')
    return status
  }

  async function currentSnapshot() {
    authenticationPreviews.clear()
    const snapshot = await invoke(['now', '--limit', '20'])
    if (snapshot.dataDirectory !== dataDirectory)
      throw new Error('Remember snapshot profile mismatch; cursor unchanged')
    const privacyOmissions: SourceRecord[] = []
    function sanitize(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(sanitize)
      if (value === null || typeof value !== 'object') return value
      const record = value as SourceRecord
      if (record.sourceRef && authenticationSurfaceMetadata(record)) {
        const sourceRef = reference(record.sourceRef)
        if (['context', 'focus'].includes(sourceRef.kind)) {
          const omitted = authenticationOmission(record, 'preview_metadata')
          authenticationPreviews.set(sourceIdentity(sourceRef), omitted)
          privacyOmissions.push({ sourceRef, ...omitted.redaction })
          return { ...omitted.record, sourceRef, redaction: omitted.redaction }
        }
      }
      return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, sanitize(child)]))
    }
    const safeSnapshot = object(sanitize(snapshot), 'Remember snapshot')
    if (privacyOmissions.length > 0) safeSnapshot.privacyOmissions = privacyOmissions
    return safeSnapshot
  }

  async function hydrate(sourceRef: SourceRef, operation: Operation, changeObservedAt: number): Promise<RelayChange> {
    options.signal?.throwIfAborted()
    const preview = authenticationPreviews.get(sourceIdentity(sourceRef))
    if (operation !== 'deleted' && preview) {
      return {
        ...omittedChange(sourceRef, operation, changeObservedAt, preview.record, 'preview_metadata'),
        redaction: preview.redaction,
      }
    }
    const source =
      operation === 'deleted'
        ? { availability: 'not_found', record: null }
        : await invoke(['source', 'read', sourceRef.kind, sourceRef.id])
    if (operation !== 'deleted') {
      const returnedRef = reference(source.sourceRef)
      if (returnedRef.kind !== sourceRef.kind || returnedRef.id !== sourceRef.id) {
        throw new Error('Remember source identity mismatch; cursor unchanged')
      }
    }
    if (source.availability !== 'available' && source.availability !== 'not_found') {
      throw new Error('Remember source availability unknown; cursor unchanged')
    }
    const record = source.availability === 'available' ? object(source.record, 'Remember source record') : null
    if (source.availability === 'not_found' && source.record !== null) {
      throw new Error('Remember unavailable source has an unexpected record; cursor unchanged')
    }
    if (record && ['context', 'focus'].includes(sourceRef.kind) && authenticationSurfaceMetadata(record)) {
      return omittedChange(sourceRef, operation, changeObservedAt, record, 'source_metadata')
    }
    const sourceDetails = Object.fromEntries(
      Object.entries(source).filter(([key]) => !['kind', 'id', 'sourceRef', 'availability', 'record'].includes(key))
    )
    let originRecord = record
    if (record && sourceRef.kind === 'agent_span' && typeof record.event_id === 'string') {
      const event = await hydrate({ kind: 'agent_event', id: record.event_id }, 'updated', changeObservedAt)
      originRecord = event.record
      sourceDetails.agentEvent = event
    }
    const isCapturedSurface = ['context', 'focus'].includes(sourceRef.kind)
    const isRelay = !isCapturedSurface && originRecord !== null && isRelayRecord(originRecord, excludedThreadIds)
    const selfEcho = record && isCapturedSurface ? contextSelfEchoLabel(record, excludedThreadIds) : null
    return {
      sourceRef,
      operation,
      availability: source.availability,
      record,
      ...(Object.keys(sourceDetails).length > 0 ? { sourceDetails } : {}),
      ...(selfEcho ? { selfEcho } : {}),
      readAt: Date.now(),
      changeObservedAt,
      readContentHash: record === null ? null : createHash('sha256').update(canonicalJson(record)).digest('hex'),
      historicalVersionGuaranteed: false,
      origin: isRelay ? 'relay' : 'source',
      eligibleForWorkUpdate: !isRelay,
    }
  }

  async function scanOpenInbox() {
    const items: SourceRecord[] = []
    const identities = new Set<string>()
    let offset = 0
    let hasMore = true
    let count: number | null = null
    let isComplete = true
    while (hasMore) {
      const inbox = await invoke(['inbox', 'list', '--lifecycle', 'open', '--limit', '200', '--offset', String(offset)])
      if (
        !Array.isArray(inbox.items) ||
        typeof inbox.hasMore !== 'boolean' ||
        !Number.isSafeInteger(inbox.count) ||
        Number(inbox.count) < 0
      ) {
        throw new Error('Invalid Remember Inbox page; cursor unchanged')
      }
      if (count === null) count = Number(inbox.count)
      if (count !== inbox.count) isComplete = false
      for (const entry of inbox.items) {
        const item = object(entry, 'Remember Inbox item')
        const sourceRef = reference(item.sourceRef)
        const identity = JSON.stringify([sourceRef.kind, sourceRef.id])
        if (identities.has(identity)) isComplete = false
        identities.add(identity)
        items.push(item)
      }
      if (inbox.hasMore && inbox.items.length === 0) throw new Error('Remember Inbox pagination stalled')
      offset += inbox.items.length
      hasMore = inbox.hasMore
    }
    if (items.length !== count) isComplete = false
    const versions = items.map(canonicalJson).sort()
    return { items, fingerprint: isComplete ? canonicalJson(versions) : null }
  }

  async function stableOpenInbox() {
    let previousFingerprint: string | null = null
    for (let scanCount = 1; scanCount <= 4; scanCount++) {
      const scan = await scanOpenInbox()
      if (scan.fingerprint !== null && scan.fingerprint === previousFingerprint) return { ...scan, scanCount }
      previousFingerprint = scan.fingerprint
    }
    throw new Error('Remember baseline-unstable: open Inbox changed during reconciliation; cursor unchanged')
  }

  async function readPage(cursor: string | null) {
    await verify()
    const page = await invoke(['changes', ...(cursor === null ? [] : ['--since', cursor]), '--limit', '200'])
    if (
      typeof page.nextCursor !== 'string' ||
      page.nextCursor.length === 0 ||
      typeof page.hasMore !== 'boolean' ||
      page.baseline !== (cursor === null) ||
      !Array.isArray(page.changes) ||
      typeof page.observedAt !== 'number' ||
      !Number.isFinite(page.observedAt)
    ) {
      throw new Error('Invalid Remember change page; cursor unchanged')
    }
    const snapshot = await currentSnapshot()
    const pending = page.changes.map((entry) => {
      const change = object(entry, 'Remember change')
      if (!['created', 'updated', 'deleted'].includes(String(change.operation))) {
        throw new Error('Invalid Remember change operation; cursor unchanged')
      }
      return { sourceRef: reference(change.sourceRef), operation: change.operation as Operation }
    })
    if (page.baseline) {
      const stableInbox = await stableOpenInbox()
      const openItems: SourceRecord[] = []
      for (const item of stableInbox.items) {
        const itemRef = reference(item.sourceRef)
        openItems.push(await invoke(['inbox', 'read', itemRef.id]))
      }
      snapshot.openInbox = {
        items: openItems,
        count: openItems.length,
        hasMore: false,
        consistency: {
          matchingScans: 2,
          scanCount: stableInbox.scanCount,
          atomicSnapshot: false,
          note: 'Two complete observed listings matched; detailed source reads may reflect later changes.',
        },
      }
      for (const sourceRef of sourceReferences(snapshot)) pending.push({ sourceRef, operation: 'created' })
    }
    const changes: RelayChange[] = []
    for (const change of pending) {
      changes.push(await hydrate(change.sourceRef, change.operation, page.observedAt))
    }
    return {
      cursorBefore: cursor,
      cursorAfter: page.nextCursor,
      hasMore: page.hasMore,
      baseline: page.baseline,
      snapshot,
      changes,
      synthetic: false as const,
    }
  }

  async function lookup(kind: string, id: string) {
    await verify()
    authenticationPreviews.clear()
    return hydrate(reference({ kind, id }), 'updated', Date.now())
  }

  async function fresh() {
    await verify()
    return currentSnapshot()
  }

  return { verify, readPage, lookup, fresh }
}

function omittedChange(
  sourceRef: SourceRef,
  operation: Operation,
  changeObservedAt: number,
  original: SourceRecord,
  detection: SourceRedaction['detection']
): RelayChange {
  const { record, redaction } = authenticationOmission(original, detection)
  return {
    sourceRef,
    operation,
    availability: 'available',
    record,
    redaction,
    readAt: Date.now(),
    changeObservedAt,
    readContentHash: createHash('sha256').update(canonicalJson(record)).digest('hex'),
    historicalVersionGuaranteed: false,
    origin: 'source',
    eligibleForWorkUpdate: false,
  }
}

function authenticationOmission(original: SourceRecord, detection: SourceRedaction['detection']) {
  const record: SourceRecord = { contentOmitted: true, omissionReason: 'authentication_surface' }
  for (const key of ['id', 'workday_id', 'workdayId']) {
    if (typeof original[key] === 'string') record[key] = original[key]
  }
  for (const key of [
    'timestamp',
    'application_id',
    'applicationId',
    'started_at',
    'startedAt',
    'ended_at',
    'endedAt',
    'observed_at',
    'observedAt',
    'updated_at',
    'updatedAt',
  ]) {
    if (typeof original[key] === 'number' && Number.isFinite(original[key])) record[key] = original[key]
  }
  const redaction: SourceRedaction = {
    reason: 'authentication_surface',
    detection,
    omittedFields: Object.keys(original).filter((key) => !(key in record)),
  }
  return { record, redaction }
}

function sourceIdentity(sourceRef: SourceRef) {
  return JSON.stringify([sourceRef.kind, sourceRef.id])
}

function object(value: unknown, label: string) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`)
  return value as SourceRecord
}

function reference(value: unknown) {
  const result = object(value, 'Remember source reference')
  if (typeof result.kind !== 'string' || !result.kind || typeof result.id !== 'string' || !result.id) {
    throw new Error('Invalid Remember source reference')
  }
  return { kind: result.kind, id: result.id }
}

function sourceReferences(value: unknown) {
  const references = new Map<string, SourceRef>()
  function visit(node: unknown) {
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    if (node === null || typeof node !== 'object') return
    for (const [key, child] of Object.entries(node)) {
      if (key === 'sourceRef' || key === 'episodeRef') {
        const ref = reference(child)
        references.set(JSON.stringify([ref.kind, ref.id]), ref)
      } else visit(child)
    }
  }
  visit(value)
  return [...references.values()]
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function contextSelfEchoLabel(record: SourceRecord, excludedThreadIds: Set<string>): SelfEchoLabel | null {
  const urlThreadId = threadIdFromContextUrl(record.url)
  const metadataThreadIds = ['thread_id', 'threadId', 'session_id', 'sessionId']
    .map((key) => record[key])
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
  const identities = new Set([...metadataThreadIds, ...(urlThreadId ? [urlThreadId] : [])])
  if (identities.size > 1) {
    return { classification: 'uncertain', basis: 'conflicting_thread_identity', scope: 'surface_provenance_only' }
  }
  for (const key of ['thread_id', 'threadId', 'session_id', 'sessionId']) {
    const threadId = record[key]
    if (typeof threadId === 'string' && excludedThreadIds.has(threadId)) {
      return {
        classification: 'confirmed',
        basis: 'exact_thread_metadata',
        scope: 'surface_provenance_only',
        threadId,
      }
    }
  }
  if (urlThreadId && excludedThreadIds.has(urlThreadId)) {
    return {
      classification: 'confirmed',
      basis: 'exact_thread_url',
      scope: 'surface_provenance_only',
      threadId: urlThreadId,
    }
  }
  const containsMarker = ['text', 'content'].some((key) => {
    const text = record[key]
    if (typeof text !== 'string') return false
    const candidates = [
      text,
      ...text.split('\n'),
      ...Array.from(text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g), (match) => match[1]),
    ]
    return candidates.some((candidate) => {
      try {
        return isProtocolEnvelope(JSON.parse(candidate))
      } catch {
        return false
      }
    })
  })
  if (!containsMarker && !hasChatSurfaceMetadata(record)) return null
  return {
    classification: 'uncertain',
    basis: containsMarker ? 'embedded_relay_marker' : 'no_exact_thread_identity',
    scope: 'surface_provenance_only',
  }
}

function hasChatSurfaceMetadata(record: SourceRecord) {
  if (
    ['window_title', 'windowTitle', 'window', 'title', 'appName', 'applicationName'].some(
      (key) => typeof record[key] === 'string' && ['chatgpt', 'codex'].includes(record[key].trim().toLowerCase())
    )
  )
    return true
  if (typeof record.url !== 'string') return false
  try {
    const url = new URL(record.url)
    return (
      url.protocol === 'codex:' ||
      (['https:', 'http:'].includes(url.protocol) && ['chatgpt.com', 'chat.openai.com'].includes(url.hostname))
    )
  } catch {
    return false
  }
}

function threadIdFromContextUrl(value: unknown) {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (url.protocol === 'codex:' && url.hostname === 'threads') {
      const match = url.pathname.match(/^\/([^/]+)\/?$/)
      return match ? decodeURIComponent(match[1]) : null
    }
    if (['https:', 'http:'].includes(url.protocol) && ['chatgpt.com', 'chat.openai.com'].includes(url.hostname)) {
      const match = url.pathname.match(/^\/(?:g\/[^/]+\/)?c\/([^/]+)\/?$/)
      return match ? decodeURIComponent(match[1]) : null
    }
  } catch {
    return null
  }
  return null
}

function isRelayRecord(record: SourceRecord, excludedThreadIds: Set<string>) {
  if (isProtocolEnvelope(record)) return true
  for (const key of ['text', 'content']) {
    if (typeof record[key] !== 'string') continue
    const originalText = record[key].trim()
    const delegation = originalText.match(
      /^<codex_delegation>\s*<source_thread_id>([^<>]+)<\/source_thread_id>\s*<input>[\s\S]*<\/input>\s*<\/codex_delegation>$/
    )
    if (delegation && excludedThreadIds.has(delegation[1].trim())) return true
    const text = originalText.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1')
    try {
      if (isProtocolEnvelope(JSON.parse(text))) return true
    } catch {
      // Mixed prose and JSON remains evidence; a substring is not a relay envelope.
    }
  }
  const role = record.role ?? record.actor
  if (!['assistant', 'agent', 'tool', 'system'].includes(String(role))) return false
  return ['session_id', 'sessionId', 'thread_id', 'threadId'].some(
    (key) => typeof record[key] === 'string' && excludedThreadIds.has(record[key])
  )
}

function isProtocolEnvelope(value: unknown) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const envelope = value as SourceRecord
  const hasText = (key: string) => typeof envelope[key] === 'string' && envelope[key].length > 0
  const hasSequence = (key: string) => Number.isSafeInteger(envelope[key]) && Number(envelope[key]) > 0
  const hasObject = (key: string) => envelope[key] !== null && typeof envelope[key] === 'object'
  switch (envelope.kind) {
    case 'remember.context.batch':
      return (
        hasText('batchId') &&
        (hasText('runId') ||
          (envelope.schemaVersion === 1 &&
            hasSequence('sequence') &&
            hasText('consumerId') &&
            hasText('profileId') &&
            hasText('payloadHash')))
      )
    case 'remember.context.ack':
      return (
        hasText('batchId') &&
        (hasText('runId') || (hasSequence('sequence') && hasText('payloadHash') && hasText('consumerId')))
      )
    case 'remember.context.acknowledged':
      return (
        envelope.acknowledged === true &&
        hasText('batchId') &&
        hasSequence('sequence') &&
        hasSequence('appliedSequence')
      )
    case 'remember.context.rearm':
      return hasText('runId') || (envelope.rearm === true && hasText('consumerId'))
    case 'remember.context.waiting':
      return envelope.rearmRequired === true && typeof envelope.checkedAt === 'number' && hasObject('status')
    case 'remember.context.busy':
      return typeof envelope.retryAfterMs === 'number' && hasObject('status')
    case 'remember.context.status':
      return envelope.schemaVersion === 1 && hasText('consumerId') && hasText('profileId')
    case 'remember.context.fresh':
      return hasObject('snapshot')
    case 'remember.context.source':
      return hasObject('source')
    default:
      return false
  }
}
