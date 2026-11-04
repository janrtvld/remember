export type BriefingDescriptor = {
  version: 1
  actionId: string
  jobId: string
  assistantMessageId: string
  targetId: string
  targetEpoch: string
  root: string
  directory: string
  workspace: string
  inputHash: string
  authorityHash: string
}
export type BriefingSpec = {
  version: 1
  preparedInput: {
    prompt: string
    systemPrompt: string
    model: string
    effort: string
    threadId: null
    tools: []
    maxInputBytes: number
    maxOutputBytes: number
    maxDurationMs: number
  }
  sourcePacketHash: string
  deadlineAt: number
  outputBasename: 'briefing.md'
  workspace: string
}
export type BriefingPhase = 'accepted' | 'executing' | 'awaiting-write-permission' | 'completed' | 'stopped' | 'unknown'
export type BriefingExecution = {
  invocationId: string
  pid: number | null
  providerThreadId: string | null
  exit: { code: number | null; signal: string | null; at: number } | null
}
export type BriefingPermission = {
  requestId: string
  nonce: string
  sessionId: string
  contentHash: string
  byteLength: number
  leaseMs: 3000
  createdAt: number
}
export type BriefingReceipt = {
  version: 1
  resultId: string
  descriptorHash: string
  actionId: string
  jobId: string
  inputHash: string
  authorityHash: string
  basename: 'briefing.md'
  contentHash: string
  byteLength: number
  createdAt: number
  verifiedAt: number
}
export type BriefingEvent = { seq: number; type: string; at: number; data: Record<string, unknown> }
export type BriefingObservation = {
  version: 1
  sessionId: string
  descriptor: BriefingDescriptor
  phase: BriefingPhase
  createdAt: number
  updatedAt: number
  cursor: number
  events: BriefingEvent[]
  execution: BriefingExecution | null
  permission: BriefingPermission | null
  writeIntent: {
    contentHash: string
    byteLength: number
    createdAt: number
    state: 'reserved' | 'consumed' | 'verified'
  } | null
  receipt: BriefingReceipt | null
  completion: 'briefing' | 'silent' | null
  error: string | null
}
export type BriefingResult = { version: 1; receipt: BriefingReceipt; content: string }
export const BRIEFING_PROTOCOL: 'remember-private-briefing-v1'
export const BRIEFING_LIMITS: Readonly<{
  inputBytes: number
  outputBytes: number
  rpcBytes: number
  maxEvents: number
  maxDurationMs: number
  leaseMs: 3000
}>
export function canonicalBriefingJson(value: unknown, maxBytes?: number): string
export function hashBriefingValue(value: unknown): string
export function hashBriefingText(value: string): string
export function validateBriefingDescriptor(value: unknown, spec?: unknown): BriefingDescriptor
export function validateBriefingSpec(value: unknown): BriefingSpec
export function validateBriefingObservation(value: unknown, descriptor?: unknown): BriefingObservation
export function validateBriefingReceipt(value: unknown, descriptor?: unknown): BriefingReceipt
export function validateBriefingResult(value: unknown, descriptor?: unknown): BriefingResult

export type BriefingSlot = Pick<
  BriefingDescriptor,
  'version' | 'targetId' | 'targetEpoch' | 'root' | 'directory' | 'workspace' | 'jobId'
>
export function validateBriefingSlot(value: unknown): BriefingSlot
