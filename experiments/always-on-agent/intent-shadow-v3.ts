import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { AmbientEvidence } from '../../apps/desktop/src/main/dailyReview/ambientTaskStore'
import {
  type IntentShadowRecord,
  type IntentShadowReference,
  type IntentShadowValidation,
  validateIntentShadow,
} from './intent-shadow-v2'

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

export const INTENT_SHADOW_V3_SCHEMA = Object.freeze({
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

export type IntentShadowV3Claim = Pick<
  IntentShadowRecord,
  'speechAct' | 'claimedOwner' | 'actionStatus' | 'addresseeQuote' | 'actionQuote' | 'payloadQuote' | 'reversalQuotes'
>

export type IntentShadowV3Snapshot = {
  sources: readonly AmbientEvidence[]
  userName: string
  language: string
  policyEpoch: string
  allowed: boolean
}

type OfferedSource = Readonly<Omit<AmbientEvidence, 'evidenceId' | 'sourceId' | 'revision'>>
export type IntentShadowV3Input = {
  readonly userName: string
  readonly language: string
  readonly speech: OfferedSource
  readonly context: readonly OfferedSource[]
}

export type IntentShadowV3Validation = {
  status: 'valid' | 'invalid'
  reference: IntentShadowReference | null
  claim: IntentShadowV3Claim | null
  structural: IntentShadowValidation['structural'] | null
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

function semanticRecord(value: unknown): value is IntentShadowV3Claim {
  return (
    exactObject(value, semanticKeys) &&
    typeof value.speechAct === 'string' &&
    speechActs.includes(value.speechAct) &&
    typeof value.claimedOwner === 'string' &&
    owners.includes(value.claimedOwner) &&
    typeof value.actionStatus === 'string' &&
    actionStatuses.includes(value.actionStatus) &&
    [value.addresseeQuote, value.actionQuote, value.payloadQuote].every((entry) => entry === null || quote(entry)) &&
    Array.isArray(value.reversalQuotes) &&
    value.reversalQuotes.length <= 8 &&
    Array.from(value.reversalQuotes).every(quote)
  )
}

function validReference(value: unknown): value is IntentShadowReference {
  return exactObject(value, referenceKeys) && referenceKeys.every((key) => nonempty(value[key]))
}

function assertSnapshot(snapshot: IntentShadowV3Snapshot): void {
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

function invalid(code: string, field: string): IntentShadowV3Validation {
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

export function prepareIntentShadowV3(
  target: IntentShadowReference,
  snapshot: IntentShadowV3Snapshot
): {
  input: IntentShadowV3Input
  accept(raw: unknown, currentSnapshot: IntentShadowV3Snapshot): IntentShadowV3Validation
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
  const input: IntentShadowV3Input = Object.freeze({
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
    accept(raw: unknown, currentSnapshot: IntentShadowV3Snapshot): IntentShadowV3Validation {
      if (consumed) return invalid('binding-consumed', 'binding')
      consumed = true
      try {
        assertSnapshot(currentSnapshot)
      } catch {
        return invalid('invalid-current-snapshot', 'currentSnapshot')
      }
      if (!isDeepStrictEqual(captured, currentSnapshot)) return invalid('snapshot-changed', 'currentSnapshot')
      if (!semanticRecord(raw)) return invalid('invalid-semantic-record', 'record')

      const lexical = validateIntentShadow({ ...raw, ...capturedTarget, actionSummary: '' }, [...captured.sources], {
        state: 'unknown',
        refs: [],
      })
      const claim: IntentShadowV3Claim | null = lexical.claim
        ? {
            speechAct: lexical.claim.speechAct,
            claimedOwner: lexical.claim.claimedOwner,
            actionStatus: lexical.claim.actionStatus,
            addresseeQuote: lexical.claim.addresseeQuote,
            actionQuote: lexical.claim.actionQuote,
            payloadQuote: lexical.claim.payloadQuote,
            reversalQuotes: [...lexical.claim.reversalQuotes],
          }
        : null
      const valid = lexical.structural.status === 'valid'
      return {
        status: valid ? 'valid' : 'invalid',
        reference: valid ? { ...capturedTarget } : null,
        claim,
        structural: lexical.structural,
        issues: [...lexical.structural.issues],
        semanticAssessment: 'not_assessed',
        provenance: { state: 'unknown', refs: [] },
        sourceSuitability: 'unknown',
        automaticAssignment: 'not_authorized',
      }
    },
  })
}
