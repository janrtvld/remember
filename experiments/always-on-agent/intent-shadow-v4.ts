import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { AmbientEvidence } from '../../apps/desktop/src/main/dailyReview/ambientTaskStore'
import {
  type IntentQuoteLayoutIssue,
  type IntentQuoteLayoutSpan,
  validateIntentQuoteLayout,
} from './intent-quote-layout-v4'

const semanticKeys = Object.freeze([
  'speechAct',
  'claimedOwner',
  'actionStatus',
  'addresseeQuote',
  'actionQuote',
  'payloadQuote',
  'reversalQuotes',
])
const speechActs: readonly string[] = Object.freeze(['direct_request', 'speaker_commitment', 'reported', 'unclear'])
const owners: readonly string[] = Object.freeze(['user', 'other', 'unknown'])
const actionStatuses: readonly string[] = Object.freeze(['active', 'withdrawn', 'unclear'])
const quoteSchema = Object.freeze({ type: Object.freeze(['string', 'null']), minLength: 1, maxLength: 600 })

export const INTENT_SHADOW_V4_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: semanticKeys,
  properties: Object.freeze({
    speechAct: Object.freeze({ type: 'string', enum: speechActs }),
    claimedOwner: Object.freeze({ type: 'string', enum: owners }),
    actionStatus: Object.freeze({ type: 'string', enum: actionStatuses }),
    addresseeQuote: quoteSchema,
    actionQuote: quoteSchema,
    payloadQuote: quoteSchema,
    reversalQuotes: Object.freeze({
      type: 'array',
      maxItems: 8,
      items: Object.freeze({ type: 'string', minLength: 1, maxLength: 600 }),
    }),
  }),
})

export type IntentShadowV4Reference = {
  evidenceId: string
  sourceId: string
  revision: string
}

export type IntentShadowV4Claim = {
  speechAct: 'direct_request' | 'speaker_commitment' | 'reported' | 'unclear'
  claimedOwner: 'user' | 'other' | 'unknown'
  actionStatus: 'active' | 'withdrawn' | 'unclear'
  addresseeQuote: string | null
  actionQuote: string | null
  payloadQuote: string | null
  reversalQuotes: string[]
}

export type IntentShadowV4Structural = {
  status: 'valid' | 'invalid'
  issues: Array<{ code: IntentQuoteLayoutIssue['code'] | 'missing-required-quote'; field: string }>
  spans: IntentQuoteLayoutSpan[]
  unquotedRanges: Array<{ start: number; end: number }>
}

export type IntentShadowV4Snapshot = {
  sources: readonly AmbientEvidence[]
  userName: string
  language: string
  policyEpoch: string
  allowed: boolean
}

type OfferedSource = Readonly<Omit<AmbientEvidence, 'evidenceId' | 'sourceId' | 'revision'>>
export type IntentShadowV4Input = {
  readonly userName: string
  readonly language: string
  readonly speech: OfferedSource
  readonly context: readonly OfferedSource[]
}

export type IntentShadowV4Validation = {
  status: 'valid' | 'invalid'
  reference: IntentShadowV4Reference | null
  claim: IntentShadowV4Claim | null
  structural: IntentShadowV4Structural | null
  issues: Array<{ code: string; field: string }>
  semanticAssessment: 'not_assessed'
  provenance: { state: 'unknown'; refs: [] }
  sourceSuitability: 'unknown'
  automaticAssignment: 'not_authorized'
}

const referenceKeys = ['evidenceId', 'sourceId', 'revision']
const sourceKeys = [
  'kind',
  'evidenceId',
  'sourceId',
  'revision',
  'workdayId',
  'observedAt',
  'text',
  'source',
  'appName',
  'bundleId',
  'windowTitle',
  'url',
]
const snapshotKeys = ['sources', 'userName', 'language', 'policyEpoch', 'allowed']

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const ownKeys = Reflect.ownKeys(value)
  return (
    ownKeys.length === keys.length &&
    ownKeys.every((key) => typeof key === 'string' && keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'))
  )
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function quote(value: unknown): value is string {
  return nonempty(value) && value.length <= 600
}

function quoteList(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > 8 || Reflect.ownKeys(value).length !== value.length + 1) return false
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !quote(descriptor.value)) return false
  }
  return true
}

function semanticRecord(value: unknown): value is IntentShadowV4Claim {
  return (
    exactObject(value, semanticKeys) &&
    typeof value.speechAct === 'string' &&
    speechActs.includes(value.speechAct) &&
    typeof value.claimedOwner === 'string' &&
    owners.includes(value.claimedOwner) &&
    typeof value.actionStatus === 'string' &&
    actionStatuses.includes(value.actionStatus) &&
    [value.addresseeQuote, value.actionQuote, value.payloadQuote].every((entry) => entry === null || quote(entry)) &&
    quoteList(value.reversalQuotes)
  )
}

function validReference(value: unknown): value is IntentShadowV4Reference {
  return exactObject(value, referenceKeys) && referenceKeys.every((key) => nonempty(value[key]))
}

function assertSnapshot(snapshot: IntentShadowV4Snapshot): void {
  if (
    !exactObject(snapshot, snapshotKeys) ||
    snapshot.allowed !== true ||
    !nonempty(snapshot.userName) ||
    !nonempty(snapshot.language) ||
    !nonempty(snapshot.policyEpoch) ||
    !Array.isArray(snapshot.sources) ||
    snapshot.sources.length === 0
  )
    throw new Error('intent-shadow-invalid-snapshot')

  const evidenceIds = new Set<string>()
  const sourceIdentities = new Set<string>()
  for (const source of snapshot.sources) {
    if (
      !exactObject(source, sourceKeys) ||
      (source.kind !== 'speech' && source.kind !== 'context') ||
      !nonempty(source.evidenceId) ||
      !nonempty(source.sourceId) ||
      !nonempty(source.workdayId) ||
      !nonempty(source.text) ||
      !nonempty(source.source) ||
      typeof source.observedAt !== 'number' ||
      !Number.isFinite(source.observedAt) ||
      source.observedAt < 0 ||
      !['appName', 'bundleId', 'windowTitle', 'url'].every((key) => typeof source[key] === 'string')
    )
      throw new Error('intent-shadow-invalid-source')
    if (source.revision !== createHash('sha256').update(source.text).digest('hex'))
      throw new Error('intent-shadow-source-revision-mismatch')
    const identity = JSON.stringify([source.kind, source.sourceId])
    if (evidenceIds.has(source.evidenceId) || sourceIdentities.has(identity))
      throw new Error('intent-shadow-ambiguous-source')
    evidenceIds.add(source.evidenceId)
    sourceIdentities.add(identity)
  }
}

function offeredSource(source: AmbientEvidence): OfferedSource {
  return Object.freeze({
    kind: source.kind,
    workdayId: source.workdayId,
    observedAt: source.observedAt,
    text: source.text,
    source: source.source,
    appName: source.appName,
    bundleId: source.bundleId,
    windowTitle: source.windowTitle,
    url: source.url,
  })
}

function invalid(code: string, field: string): IntentShadowV4Validation {
  return {
    status: 'invalid',
    reference: null,
    claim: null,
    structural: null,
    issues: [{ code, field }],
    semanticAssessment: 'not_assessed',
    provenance: { state: 'unknown', refs: [] },
    sourceSuitability: 'unknown',
    automaticAssignment: 'not_authorized',
  }
}

export function prepareIntentShadowV4(
  target: IntentShadowV4Reference,
  snapshot: IntentShadowV4Snapshot
): {
  input: IntentShadowV4Input
  accept(raw: unknown, currentSnapshot: IntentShadowV4Snapshot): IntentShadowV4Validation
} {
  if (!validReference(target)) throw new Error('intent-shadow-invalid-target')
  assertSnapshot(snapshot)
  const speech = snapshot.sources.find((source) => source.evidenceId === target.evidenceId)
  if (speech?.kind !== 'speech' || speech.sourceId !== target.sourceId || speech.revision !== target.revision)
    throw new Error('intent-shadow-target-mismatch')

  const capturedTarget = Object.freeze({ ...target })
  const captured = Object.freeze({
    ...snapshot,
    sources: Object.freeze(snapshot.sources.map((source) => Object.freeze({ ...source }))),
  })
  const input: IntentShadowV4Input = Object.freeze({
    userName: captured.userName,
    language: captured.language,
    speech: offeredSource(speech),
    context: Object.freeze(
      captured.sources.filter((source) => source.evidenceId !== target.evidenceId).map(offeredSource)
    ),
  })
  let consumed = false

  return Object.freeze({
    input,
    accept(raw: unknown, currentSnapshot: IntentShadowV4Snapshot): IntentShadowV4Validation {
      if (consumed) return invalid('binding-consumed', 'binding')
      consumed = true
      try {
        assertSnapshot(currentSnapshot)
      } catch {
        return invalid('invalid-current-snapshot', 'currentSnapshot')
      }
      if (!isDeepStrictEqual(captured, currentSnapshot)) return invalid('snapshot-changed', 'currentSnapshot')
      if (!semanticRecord(raw)) return invalid('invalid-semantic-record', 'record')

      const layout = validateIntentQuoteLayout(input.speech.text, {
        addresseeQuote: raw.addresseeQuote,
        actionQuote: raw.actionQuote,
        payloadQuote: raw.payloadQuote,
        reversalQuotes: raw.reversalQuotes,
      })
      const issues: IntentShadowV4Structural['issues'] = []
      if (raw.speechAct === 'direct_request' && raw.addresseeQuote === null)
        issues.push({ code: 'missing-required-quote', field: 'addresseeQuote' })
      if (
        (raw.actionStatus === 'active' ||
          raw.speechAct === 'direct_request' ||
          raw.speechAct === 'speaker_commitment') &&
        raw.actionQuote === null
      )
        issues.push({ code: 'missing-required-quote', field: 'actionQuote' })
      if (raw.actionStatus === 'withdrawn' && raw.reversalQuotes.length === 0)
        issues.push({ code: 'missing-required-quote', field: 'reversalQuotes' })
      issues.push(...layout.issues)

      const valid = issues.length === 0
      const structural: IntentShadowV4Structural = {
        status: valid ? 'valid' : 'invalid',
        issues,
        spans: layout.spans,
        unquotedRanges: layout.unquotedRanges,
      }
      const claim: IntentShadowV4Claim = {
        speechAct: raw.speechAct,
        claimedOwner: raw.claimedOwner,
        actionStatus: raw.actionStatus,
        addresseeQuote: raw.addresseeQuote,
        actionQuote: raw.actionQuote,
        payloadQuote: raw.payloadQuote,
        reversalQuotes: [...raw.reversalQuotes],
      }
      return {
        status: valid ? 'valid' : 'invalid',
        reference: valid ? { ...capturedTarget } : null,
        claim,
        structural,
        issues: issues.map((issue) => ({ ...issue })),
        semanticAssessment: 'not_assessed',
        provenance: { state: 'unknown', refs: [] },
        sourceSuitability: 'unknown',
        automaticAssignment: 'not_authorized',
      }
    },
  })
}
