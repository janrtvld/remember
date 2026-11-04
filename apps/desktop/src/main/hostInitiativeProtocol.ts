import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import {
  type BriefingDescriptor,
  type BriefingSpec,
  canonicalBriefingJson,
  hashBriefingValue,
  validateBriefingDescriptor,
  validateBriefingSpec,
} from '../../../../experiments/always-on-agent/briefing-protocol.mjs'
import type { ProactiveSourceRef } from './dailyReview/proactiveStore'

export type InitiativeTarget = { targetId: string; targetEpoch: string; root: string }
export type InitiativePersonalSource = { spaceId: 'personal'; slug: string; revision: string }
export type InitiativeScreenApp = { bundleId: string; label: string }
type StandingGrantCommon = {
  installationId: string
  contextFingerprint: string
  target: InitiativeTarget
  capability: 'private-briefing-v1'
  afterSequence: number
  personalSources: InitiativePersonalSource[]
  model: string
  effort: string
  maxInputBytes: number
  maxOutputBytes: number
  maxDurationMs: number
  outputBasename: 'briefing.md'
  expiresAt: number
  maxJobs: number
}
export type StandingGrantScope = StandingGrantCommon &
  ({ version: 1; evidenceSourceIds: string[] } | { version: 2; screenApp: InitiativeScreenApp })
export type HostInitiativeEnvelopeV2 = {
  version: 2
  authority: {
    kind: 'initiative'
    decisionId: string
    decisionInputHash: string
    decisionPayloadHash: string
    grantId: string
    grantGeneration: number
    grantScopeHash: string
  }
  actionId: string
  jobId: string
  assistantMessageId: string
  target: InitiativeTarget
  policyFingerprint: string
  deletionRevision: number
  sourceRefs: { evidence: ProactiveSourceRef[]; personal: InitiativePersonalSource[] }
  sourcePacketHash: string
  startedAt: number
  deadlineAt: number
  capability: 'private-briefing-v1'
  preparedInput: BriefingSpec['preparedInput']
}
export type InitiativePrepared = { version: 1; descriptor: BriefingDescriptor; spec: BriefingSpec }

function fail(): never {
  throw new Error('initiative-protocol-invalid')
}
function object(value: unknown, keys: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const row = value as Record<string, unknown>
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key))) fail()
  return row
}
function text(value: unknown, max = 500, empty = false): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (!empty && !value.trim()) ||
    [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    fail()
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) fail()
}
function digest(value: unknown) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail()
}
function target(value: unknown) {
  const v = object(value, ['targetId', 'targetEpoch', 'root'])
  text(v.targetId, 200)
  text(v.targetEpoch, 200)
  text(v.root, 2000)
  if (
    !v.root.startsWith('/') ||
    v.root === '/' ||
    v.root.endsWith('/') ||
    v.root.includes('\\') ||
    posix.normalize(v.root) !== v.root
  )
    fail()
}
function personal(value: unknown) {
  if (!Array.isArray(value) || value.length > 4) return fail()
  const seen = new Set<string>()
  for (const item of value) {
    const v = object(item, ['spaceId', 'slug', 'revision'])
    if (v.spaceId !== 'personal') fail()
    text(v.slug, 500)
    text(v.revision, 500)
    if (seen.has(v.slug)) fail()
    seen.add(v.slug)
  }
}
function limits(value: Record<string, unknown>) {
  text(value.model, 200)
  text(value.effort, 30)
  if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value.effort)) fail()
  integer(value.maxInputBytes, 1, 262144)
  integer(value.maxOutputBytes, 1, 65536)
  integer(value.maxDurationMs, 1, 300000)
}
export function validateInitiativeScreenApp(input: unknown): InitiativeScreenApp {
  const value = object(input, ['bundleId', 'label'])
  text(value.bundleId, 200)
  text(value.label, 100)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(value.bundleId) || value.label !== value.label.trim()) fail()
  return { bundleId: value.bundleId, label: value.label }
}

export function initiativeSourcesWithinScope(scope: StandingGrantScope, refs: ProactiveSourceRef[]): boolean {
  if (scope.version === 1) return refs.every((ref) => scope.evidenceSourceIds.includes(ref.sourceId))
  return (
    refs.length > 0 &&
    refs.length <= 11 &&
    refs.every((ref) => ref.kind === 'context' && ref.bundleId === scope.screenApp.bundleId)
  )
}

export function validateStandingGrantScope(input: unknown): StandingGrantScope {
  const version = (input as { version?: unknown } | null)?.version
  const value = object(JSON.parse(canonicalBriefingJson(input)), [
    'version',
    'installationId',
    'contextFingerprint',
    'target',
    'capability',
    version === 2 ? 'screenApp' : 'evidenceSourceIds',
    'afterSequence',
    'personalSources',
    'model',
    'effort',
    'maxInputBytes',
    'maxOutputBytes',
    'maxDurationMs',
    'outputBasename',
    'expiresAt',
    'maxJobs',
  ])
  if (
    (value.version !== 1 && value.version !== 2) ||
    value.capability !== 'private-briefing-v1' ||
    value.outputBasename !== 'briefing.md'
  )
    fail()
  text(value.installationId, 200)
  text(value.contextFingerprint, 20000)
  target(value.target)
  personal(value.personalSources)
  limits(value)
  integer(value.afterSequence)
  integer(value.expiresAt)
  integer(value.maxJobs, 1, 2)
  if (version === 2) {
    validateInitiativeScreenApp(value.screenApp)
    if (
      (value.personalSources as unknown[]).length !== 1 ||
      Number(value.maxInputBytes) > 48000 ||
      Number(value.maxOutputBytes) > 16384 ||
      Number(value.maxDurationMs) > 120000
    )
      fail()
  } else {
    if (
      !Array.isArray(value.evidenceSourceIds) ||
      !value.evidenceSourceIds.length ||
      value.evidenceSourceIds.length > 12
    )
      fail()
    for (const id of value.evidenceSourceIds) text(id)
    if (new Set(value.evidenceSourceIds).size !== value.evidenceSourceIds.length) fail()
  }
  return value as StandingGrantScope
}
export function validateInitiativeEnvelope(input: unknown): HostInitiativeEnvelopeV2 {
  const value = object(JSON.parse(canonicalBriefingJson(input)), [
    'version',
    'authority',
    'actionId',
    'jobId',
    'assistantMessageId',
    'target',
    'policyFingerprint',
    'deletionRevision',
    'sourceRefs',
    'sourcePacketHash',
    'startedAt',
    'deadlineAt',
    'capability',
    'preparedInput',
  ])
  if (value.version !== 2 || value.capability !== 'private-briefing-v1') fail()
  const authority = object(value.authority, [
    'kind',
    'decisionId',
    'decisionInputHash',
    'decisionPayloadHash',
    'grantId',
    'grantGeneration',
    'grantScopeHash',
  ])
  if (authority.kind !== 'initiative') fail()
  for (const key of ['decisionId', 'grantId']) text(authority[key], 200)
  for (const key of ['decisionInputHash', 'decisionPayloadHash', 'grantScopeHash']) digest(authority[key])
  integer(authority.grantGeneration, 1)
  for (const key of ['actionId', 'jobId', 'assistantMessageId']) text(value[key], 200)
  target(value.target)
  text(value.policyFingerprint, 20000)
  digest(value.sourcePacketHash)
  integer(value.deletionRevision)
  integer(value.startedAt)
  integer(value.deadlineAt)
  if (value.deadlineAt <= value.startedAt) fail()
  const refs = object(value.sourceRefs, ['evidence', 'personal'])
  personal(refs.personal)
  if (!Array.isArray(refs.evidence) || !refs.evidence.length || refs.evidence.length > 12) fail()
  const ids = new Set<string>()
  for (const ref of refs.evidence) {
    const hasBundle = ref && typeof ref === 'object' && Object.hasOwn(ref, 'bundleId')
    const row = object(ref, [
      'eventId',
      'kind',
      'sourceId',
      'evidenceId',
      'workdayId',
      'eventRevision',
      'revision',
      'contentKey',
      'observedAt',
      'appName',
      'windowTitle',
      'url',
      ...(hasBundle ? ['bundleId'] : []),
    ])
    if (!['context', 'speech'].includes(String(row.kind))) fail()
    for (const key of ['eventId', 'sourceId', 'evidenceId', 'workdayId', 'eventRevision', 'revision', 'contentKey'])
      text(row[key])
    for (const key of ['appName', 'windowTitle', 'url']) text(row[key], 8000, true)
    if (hasBundle) text(row.bundleId, 200)
    integer(row.observedAt)
    const id = String(row.eventId)
    if (ids.has(id)) fail()
    ids.add(id)
  }
  const provisional = value as HostInitiativeEnvelopeV2
  const spec = initiativeSpec(provisional)
  validateBriefingSpec(spec)
  if (value.deadlineAt - value.startedAt > spec.preparedInput.maxDurationMs) fail()
  return provisional
}
function directory(envelope: HostInitiativeEnvelopeV2) {
  return posix.join(
    envelope.target.root,
    'jobs',
    createHash('sha256').update(envelope.jobId).digest('hex').slice(0, 24)
  )
}
function initiativeSpec(envelope: HostInitiativeEnvelopeV2): BriefingSpec {
  return {
    version: 1,
    preparedInput: envelope.preparedInput,
    sourcePacketHash: envelope.sourcePacketHash,
    deadlineAt: envelope.deadlineAt,
    outputBasename: 'briefing.md',
    workspace: posix.join(directory(envelope), 'workspace'),
  }
}
export function buildInitiativePrepared(input: unknown): InitiativePrepared {
  const envelope = validateInitiativeEnvelope(input)
  const spec = validateBriefingSpec(initiativeSpec(envelope))
  const descriptor = validateBriefingDescriptor(
    {
      version: 1,
      actionId: envelope.actionId,
      jobId: envelope.jobId,
      assistantMessageId: envelope.assistantMessageId,
      ...envelope.target,
      directory: directory(envelope),
      workspace: spec.workspace,
      inputHash: hashBriefingValue(spec),
      authorityHash: hashBriefingValue(envelope.authority),
    },
    spec
  )
  return { version: 1, descriptor, spec }
}
export function validateInitiativePrepared(envelope: unknown, input: unknown): InitiativePrepared {
  const value = object(JSON.parse(canonicalBriefingJson(input)), ['version', 'descriptor', 'spec'])
  const expected = buildInitiativePrepared(envelope)
  if (canonicalBriefingJson(value) !== canonicalBriefingJson(expected)) throw new Error('initiative-prepared-conflict')
  return expected
}
