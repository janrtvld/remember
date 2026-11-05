export * from './daySearch'
export { parseInboxResult } from './inboxResult'
export * from './timelineEvidence'

import type { CaptureSchedule } from './captureSchedule'
import type { DayChanges, DaySnapshot } from './dayChanges'
import type { RememberSearchResults } from './daySearch'
import type { DictationPreferences } from './dictation'

export * from './agentComputer'
export * from './captureSchedule'
export * from './dayChanges'
export * from './dictation'
export * from './edgeWidget'

export type CaptureStatus = 'idle' | 'recording' | 'paused' | 'stopping' | 'error'
export type CapturePauseSource = 'audio' | 'capture'

export interface CapturePauseInput {
  sources: CapturePauseSource[]
  durationMs: number | null
}
export type AudioSource = 'microphone' | 'system' | 'revinote'
export type MomentStatus = 'transcribing' | 'ready' | 'empty' | 'failed'
export type SpeechSegmentRejectionReason =
  | 'unsupported-language'
  | 'cross-language-short'
  | 'cross-language-unconfirmed'
  | 'likely-hallucination'
export type AudioCaptureOutcome =
  | 'pending'
  | 'transcribed'
  | 'vad-empty'
  | 'asr-empty'
  | 'quarantined'
  | 'music-gated'
  | 'too-short'
  | 'failed'
export type ConversationEpisodeState = 'provisional' | 'final'
export type ConversationEpisodeBoundaryReason =
  | 'open'
  | 'call-surface-changed'
  | 'call-ended'
  | 'speech-gap'
  | 'capture-paused'
  | 'day-ended'
  | 'manual-merge'
export type CallSignalState = 'active' | 'ended'
export type PermissionStatus = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'
export type ContextPermissionStatus = 'granted' | 'denied' | 'unknown'
export type SystemAudioCheckStatus = 'unchecked' | 'checking' | 'ready' | 'failed'
export type DayRefreshStatus = 'idle' | 'refreshing' | 'failed'
export type DayRefreshReason = 'manual' | 'downtime' | 'active-interval' | 'end-of-day'
export type AgentProvider = 'codex' | 'claude'

export interface AgentUsageTotals {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
}

export interface AgentUsageSummary {
  firstRecordedAt: number | null
  providers: { provider: AgentProvider; today: AgentUsageTotals; week: AgentUsageTotals }[]
}

export interface AgentAccountUsage {
  provider: AgentProvider
  checkedAt: number
  windows: { remainingPercent: number; durationMinutes: number; resetsAt: number | null }[]
}

export function redactSensitiveCaptureText(value: string) {
  return value
    .replace(
      /([?&](?:access_token|auth(?:orization)?_code|client_secret|code|id_token|needs_setup|org_id|plan_type|project_id|refresh_token|state|token)=)[^&#\s"']+/gi,
      '$1[redacted]'
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
}
export type AgentStatus = 'ready' | 'missing' | 'signed-out' | 'checking' | 'error'
export type AppLocale = 'en' | 'nl'
export type InterfaceLanguage = 'system' | AppLocale
export type InterfaceTheme = 'system' | 'light' | 'dark'
export type CaptureFilterMode = 'exclude' | 'include'

export const DEFAULT_CODEX_ANALYSIS_MODEL = 'gpt-6.1-sol'
export const CODEX_ANALYSIS_MODELS = [DEFAULT_CODEX_ANALYSIS_MODEL, 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'] as const
export const CLAUDE_ANALYSIS_MODELS = ['sonnet', 'opus', 'haiku'] as const
export const CODEX_ANALYSIS_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
export const CLAUDE_ANALYSIS_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export const DEFAULT_FREQUENT_DAY_REFRESH_INTERVAL_MINUTES = 10
export const MIN_FREQUENT_DAY_REFRESH_INTERVAL_MINUTES = 1
export const MAX_FREQUENT_DAY_REFRESH_INTERVAL_MINUTES = 24 * 60

export function localeFromLanguageTag(languageTag: string | null | undefined): AppLocale {
  return languageTag?.trim().toLocaleLowerCase().split(/[-_]/)[0] === 'nl' ? 'nl' : 'en'
}

export function resolveInterfaceLocale(
  language: InterfaceLanguage,
  systemLanguage: string | null | undefined
): AppLocale {
  return language === 'system' ? localeFromLanguageTag(systemLanguage) : language
}

export type CodexAnalysisModel = string
export type ClaudeAnalysisModel = (typeof CLAUDE_ANALYSIS_MODELS)[number]
export type CodexAnalysisEffort = string
export type ClaudeAnalysisEffort = (typeof CLAUDE_ANALYSIS_EFFORTS)[number]

export interface CodexModel {
  model: string
  displayName: string
  supportedReasoningEfforts: string[]
  defaultReasoningEffort: string
}

// Only used before the first successful catalog fetch.
export const FALLBACK_CODEX_MODELS: CodexModel[] = CODEX_ANALYSIS_MODELS.map((model) => ({
  model,
  displayName:
    model === DEFAULT_CODEX_ANALYSIS_MODEL
      ? 'GPT-6.1 Sol'
      : model === 'gpt-5.5'
        ? 'GPT-5.5'
        : model === 'gpt-5.6-terra'
          ? 'GPT-5.6 Terra'
          : 'GPT-5.6 Luna',
  supportedReasoningEfforts: CODEX_ANALYSIS_EFFORTS.filter((effort) =>
    model === 'gpt-5.5' ? effort !== 'max' && effort !== 'ultra' : model !== 'gpt-5.6-luna' || effort !== 'ultra'
  ),
  defaultReasoningEffort: 'high',
}))

export function isCodexModelId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(value)
}

export function isCodexEffort(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(value)
}

export function compatibleCodexEffort(model: CodexModel | undefined, effort: string): string {
  if (!model || model.supportedReasoningEfforts.includes(effort)) return effort
  return model.defaultReasoningEffort
}

export function normalizeFrequentDayRefreshIntervalMinutes(
  value: unknown,
  fallback = DEFAULT_FREQUENT_DAY_REFRESH_INTERVAL_MINUTES
) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(
    MAX_FREQUENT_DAY_REFRESH_INTERVAL_MINUTES,
    Math.max(MIN_FREQUENT_DAY_REFRESH_INTERVAL_MINUTES, Math.trunc(value))
  )
}

export const PASSWORD_MANAGER_APPS = [
  { name: '1Password', bundleId: 'com.1password.1password' },
  { name: '1Password for Safari', bundleId: 'com.1password.safari' },
  { name: 'Bitwarden', bundleId: 'com.bitwarden.desktop' },
  { name: 'Dashlane', bundleId: 'com.dashlane.Dashlane' },
  { name: 'Keychain Access', bundleId: 'com.apple.keychainaccess' },
  { name: 'Keeper', bundleId: 'com.callpod.KeeperMacPasswordManager' },
  { name: 'LastPass', bundleId: 'com.lastpass.LastPass' },
  { name: 'NordPass', bundleId: 'com.nordsec.nordpass' },
  { name: 'Passwords', bundleId: 'com.apple.Passwords' },
  { name: 'Proton Pass', bundleId: 'me.proton.pass' },
] as const

export interface AudioMoment {
  id: string
  sessionId: string
  source: AudioSource
  startedAt: number
  durationMs: number
  status: MomentStatus
  transcript: string
  mediaPlayback?: MediaPlaybackContext
  captureEpochId?: string
  captureSequence?: number
  capturedSampleCount?: number
  captureSampleTime?: number
  captureOutcome?: AudioCaptureOutcome
}

/** One VAD-delimited speech span inside a recorder transport chunk. */
export interface SpeechSegment {
  id: string
  workdayId: string
  chunkId: string
  chunkIds?: string[]
  source: Exclude<AudioSource, 'revinote'>
  startedAt: number
  endedAt: number
  vadStartedAt?: number
  vadEndedAt?: number
  asrWindowIndex?: number
  asrWindowCount?: number
  transcriptionOutcome?: 'transcribed' | 'asr-empty'
  text: string
  detectedLanguage: string | null
  acceptedLanguage: AppLocale | null
  rejectionReason: SpeechSegmentRejectionReason | null
}

/** A conservative observation of a live call surface in captured screen context. */
export interface CallSignal {
  id: string
  workdayId: string
  provider: string
  surfaceKey: string
  state: CallSignalState
  observedAt: number
}

/** Stable conversation identity derived from speech spans and call signals before any model runs. */
export interface ConversationEpisode {
  id: string
  workdayId: string
  startedAt: number
  endedAt: number
  state: ConversationEpisodeState
  surfaceKey: string | null
  provider: string | null
  boundaryReason: ConversationEpisodeBoundaryReason
  segmentIds: string[]
  deletedAt: number | null
  automaticRevinoteProcessingBlocked: boolean
  userDecision?: 'confirmed' | 'dismissed' | null
}

export interface OngoingConversation {
  episodeId: string
  startedAt: number
  lastSpeechAt: number
  provider: string
  surfaceKey: string
}

export interface ConversationCandidate {
  episodeId: string
  startedAt: number
  endedAt: number
  provider: string | null
  confidence: 'high' | 'medium' | 'low'
  title: string
  description: string
  preview: string
  expiresAt: number
}

export interface RecoverableConversationBlock {
  episodeId: string
  startedAt: number
  endedAt: number
  provider: string | null
  source: Exclude<AudioSource, 'revinote'> | 'mixed'
  preview: string
  /** Retained transport chunks that contain this episode's accepted speech segments. */
  momentIds?: string[]
}

export interface MediaPlaybackContext {
  isPlaying: boolean
  bundleIdentifier: string
  applicationName: string
}

export interface AppActivity {
  id: string
  appName: string
  bundleId: string
  startedAt: number
  endedAt: number | null
}

export interface AppUsage {
  name: string
  bundleId: string
  durationMs: number
}

export interface InstalledApp {
  name: string
  bundleId: string
}

export type OpenAgentChatInput = {
  provider: AgentProvider
} & ({ query: string; workItemId?: never } | { workItemId: string; query?: never })

export interface RunAgentTurnInput {
  turnId: string
  workItemId?: string
  provider: AgentProvider
  prompt: string
}

export type AssistantMessageStatus = 'streaming' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

export type AssistantResult = {
  id: string
  kind: 'saved-page'
  spaceId: string
  slug: string
  revision: string
  title: string
}

export type AssistantTaskControl = 'check' | 'stop' | 'cancel'

export interface AssistantTaskDraft {
  token: string
  workItemId: string
  definitionHash: string
  title: string
  text: string
  source: { spaceId: 'personal'; slug: string; title: string; revision: string }
}

export interface AssistantTaskAction {
  actionId: string
  messageId: string
  workItemId: string
  state:
    | 'prepared'
    | 'running'
    | 'waiting'
    | 'unknown'
    | 'withheld'
    | 'claimed-unknown'
    | 'cancelled'
    | 'completed'
    | 'stopped'
  connection: 'connecting' | 'connected' | 'disconnected'
  issue?: string
  allowedControls: AssistantTaskControl[]
}

export interface AssistantTaskControlInput {
  actionId: string
  messageId: string
  command: AssistantTaskControl
}

export interface AssistantBriefingAction {
  actionId: string
  messageId: string
  state: 'prepared' | 'running' | 'waiting' | 'unknown' | 'withheld' | 'cancelled' | 'completed' | 'stopped'
  allowedControls: AssistantTaskControl[]
  result?: { id: string; title: string; byteLength: number }
  terminalReceivedAt: number | null
}

export interface AssistantBriefingGrantPreview {
  token: string
  targetLabel: string
  projectLabel: string
  sourceTitle: string
  sourceSlug: string
  screenAppLabel?: string
  expiresAt: number
  maxJobs: 2
}

export interface AssistantMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  provider: AgentProvider
  createdAt: number
  updatedAt: number
  status: AssistantMessageStatus
  replyTo: string | null
  error: string | null
  steps: AgentTurnStep[]
  results?: AssistantResult[]
  taskAction?: AssistantTaskAction
  briefingAction?: AssistantBriefingAction
  command?: {
    state: 'reserved' | 'dispatching' | 'running' | 'unknown' | 'completed' | 'stopped' | 'cancelled'
    targetLabel: string
    stopRequested: boolean
    canStop: boolean
  }
  initiative?: {
    kind?: 'offer' | 'observe' | 'clarify'
    taskIds?: string[]
    decisionId: string
    topicKey: string
    dismissed: boolean
    sources: {
      id: string
      kind: 'context' | 'speech' | 'note' | 'day'
      noteId?: string
      dayId?: string
      quote: string
      observedAt: number
      appName: string
      windowTitle: string
    }[]
  }
}

export type AssistantHostStopReason = 'request-expired' | 'context-invalidated'

export interface AssistantAttention {
  unread: boolean
  needsInput: boolean
}

export interface AssistantConversation {
  queuedMessages?: { id: string; text: string; state: 'waiting' | 'paused' }[]
  commandMode?: { targetLabel: string; unified?: boolean }
  messages: AssistantMessage[]
  activeTurnId: string | null
  hasEarlier: boolean
  execution: 'local' | 'remote'
  taskActionsEnabled?: boolean
  sharedTaskChat?: boolean
  proactiveEnabled?: boolean
  briefingsEnabled?: boolean
  briefingGrant?: { id: string; expiresAt: number; remainingJobs: number; targetLabel: string } | null
  activeTaskAction?: AssistantTaskAction | null
  remoteRecoveryRequired?: boolean
  remoteRecoveryMessageId?: string | null
  hostJob?: {
    canCheck?: boolean
    messageId: string
    phase: 'starting' | 'running' | 'waiting' | 'recovery-required' | 'completed' | 'stopped'
    connection: 'connecting' | 'connected' | 'disconnected'
    stopRequested?: boolean
    stopReason?: AssistantHostStopReason
  }
}

export interface SendAssistantMessageInput {
  /** Stable across transport retries; becomes the persisted user/queued message ID. */
  clientMessageId?: string
  queue?: boolean
  mode?: 'question' | 'command'
  text: string
  provider: AgentProvider
  task?: { token: string }
}

export interface SendAssistantQueuedMessageInput {
  queuedMessageId: string
  interruptMessageId?: string
}

export interface AgentProject {
  id: string
  name: string
  path: string
  providers: AgentProvider[]
  lastUsedAt: number | null
}

export interface WorkItemAgentContext {
  project: AgentProject | null
}

export type AgentTurnStepKind = 'status' | 'reasoning'

export interface AgentTurnStep {
  id: string
  kind: AgentTurnStepKind
  text: string
  at: number
}

export interface AgentTurnUpdate {
  turnId: string
  provider: AgentProvider
  type: AgentTurnStepKind | 'response'
  id: string
  text: string
  at: number
}

export interface AgentInteraction {
  id: string
  turnId: string
  workItemId?: string
  title: string
  detail: string
  url?: string
  fields: { id: string; label: string; required: boolean; secret?: boolean; options?: string[] }[]
  actions: { id: 'accept' | 'decline'; label: string }[]
}

export interface AgentInteractionAnswer {
  id: string
  action: 'accept' | 'decline'
  values: Record<string, string>
}

export interface RunAgentTurnResult {
  provider: AgentProvider
  response: string
  durationMs: number
  steps: AgentTurnStep[]
}

export interface ContextMoment {
  id: string
  timestamp: number
  appName: string
  bundleId?: string
  windowTitle: string
  text: string
  textSource: 'accessibility' | 'ocr'
  trigger: string
  monitorName: string
  screenshotPath: string
  /** Captured page or document URL when the foreground application exposes one. */
  url?: string
  focusedElement?: {
    role: string
    title: string
    description: string
    value: string
  }
}

/** Day snapshots carry references. Source-level workflows can supply the full archived record. */
export type ContextMomentReference = Pick<ContextMoment, 'id' | 'timestamp' | 'bundleId'> | ContextMoment

export function contextMomentReference(moment: ContextMoment): ContextMomentReference {
  return { id: moment.id, timestamp: moment.timestamp, ...(moment.bundleId ? { bundleId: moment.bundleId } : {}) }
}

export type TimelineEvidenceKind = 'context' | 'audio' | 'app'

export interface TimelineEvidenceReference {
  kind: TimelineEvidenceKind
  id: string
}

export interface TimelineDetail {
  /** Local HH:mm timestamp for the observed step. */
  at: string
  /** Concise factual step, decision, result, or blocker within the activity. */
  text: string
}

export interface CalendarBlock {
  /** Stable local identity, reconciled across generated Day refreshes. */
  id?: string
  startTime: string
  endTime: string
  title: string
  description: string
  /** A compact chronological record that keeps useful continuity behind the summary. */
  details?: TimelineDetail[]
  /** Exact local evidence records that support this generated block. */
  sourceRefs?: TimelineEvidenceReference[]
}

export interface TimelineItemOverride {
  id: string
  title: string
  description: string
}

export interface UpdateTimelineItemInput {
  title: string
  description: string
}

export interface TimelineWikiResult {
  slug: string
  title: string
  changeType: 'created' | 'updated'
}

export interface ConversationSummary {
  /** Stable local episode identity. Imported and historical summaries may not have one. */
  episodeId?: string
  /** Stable identity from the persisted episode analysis. */
  id?: string
  startTime: string
  endTime: string
  title: string
  description: string
  summary?: string
  actionPoints?: string[]
  /** Durable action-point identities used to present the same WorkItem in conversations and Inbox. */
  actionPointItems?: ConversationActionPoint[]
  /** Confirmed from time-bounded, visible meeting-app context; never from audio. */
  otherParticipantName?: string
  /** Imported conversations retain their remote identity so later Revinote edits replace them idempotently. */
  source?: 'revinote'
  externalId?: string
  /** A generated conversation or manual merge whose metadata is still catching up. */
  processing?: 'merging' | 'processing'
  /** The service expected to replace a processing placeholder with final conversation metadata. */
  processingProvider?: 'remember' | 'revinote'
  processingError?: 'analysis' | 'revinote' | 'audio'
  /** Retained notes on conversations created by earlier versions. */
  notes?: string
  /** Stable link to the manual capture that supplied this conversation's local audio. */
  manualMeetingId?: string
  /** Exact, persisted speech belonging to a manual recording; an empty list is authoritative. */
  recordingSource?: ConversationRecordingSource
}

export interface ConversationRecordingSource {
  startedAt: number
  endedAt: number
  segments: Pick<SpeechSegment, 'id' | 'source' | 'startedAt' | 'endedAt' | 'text'>[]
}

export interface ConversationActionPoint {
  id: string
  text: string
  /** Present for imported providers that expose completion in their meeting snapshot. */
  completed?: boolean
}

export type ConversationIdentity = Pick<
  ConversationSummary,
  'episodeId' | 'externalId' | 'id' | 'startTime' | 'endTime'
>

export type ConversationReference =
  | `episode:${string}`
  | `external:${string}`
  | `summary:${string}`
  | `window:${string}-${string}`

function stableConversationReferences(conversation: ConversationIdentity): ConversationReference[] {
  return [
    ...(conversation.episodeId ? ([`episode:${conversation.episodeId}`] as const) : []),
    ...(conversation.externalId ? ([`external:${conversation.externalId}`] as const) : []),
    ...(conversation.id ? ([`summary:${conversation.id}`] as const) : []),
  ]
}

/**
 * A durable selector for conversation mutations. The window fallback keeps
 * historical summaries addressable, while stable source identities take
 * precedence whenever they exist.
 */
export function conversationReference(conversation: ConversationIdentity): ConversationReference {
  return stableConversationReferences(conversation)[0] ?? `window:${conversation.startTime}-${conversation.endTime}`
}

export function conversationActionPointItems(conversation: ConversationSummary): ConversationActionPoint[] {
  const explicit = (conversation.actionPointItems ?? []).flatMap((item) => {
    const id = item.id.trim()
    const text = item.text.trim()
    return id && text ? [{ ...item, id, text }] : []
  })
  if (explicit.length) return explicit

  const reference = conversationReference(conversation)
  return (conversation.actionPoints ?? []).flatMap((text, index) => {
    const normalized = text.trim()
    return normalized ? [{ id: `${reference}:action:${index}`, text: normalized }] : []
  })
}

/** Resolve stable references and old raw start-time links without guessing. */
export function resolveConversationReference<T extends ConversationIdentity>(
  conversations: readonly T[],
  reference: string
): T | null {
  const referenced = conversations.filter((conversation) =>
    [
      ...stableConversationReferences(conversation),
      `window:${conversation.startTime}-${conversation.endTime}`,
    ].includes(reference)
  )
  if (referenced.length > 1) throw new Error('ambiguous-conversation-reference')
  if (referenced[0]) return referenced[0]

  const legacy = conversations.filter((conversation) => conversation.startTime === reference)
  if (legacy.length > 1) throw new Error('ambiguous-conversation-reference')
  return legacy[0] ?? null
}

export function conversationsShareStableIdentity(first: ConversationIdentity, second: ConversationIdentity) {
  const firstReferences = stableConversationReferences(first)
  if (firstReferences.length === 0) return false
  const secondReferences = new Set(stableConversationReferences(second))
  return firstReferences.some((reference) => secondReferences.has(reference))
}

export type DeletedConversationReference = Pick<ConversationSummary, 'startTime' | 'endTime'> &
  Partial<Pick<ConversationSummary, 'episodeId' | 'externalId' | 'id'>>

export type RevinoteConnectionMethod = 'oauth' | 'api-key'
export type RevinoteConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface RevinoteConnectionStatus {
  state: RevinoteConnectionState
  method: RevinoteConnectionMethod | null
  canPostProcess: boolean
  lastSyncedAt: number | null
  importedCount: number
  error: string | null
}

export interface RevinoteSyncResult {
  status: RevinoteConnectionStatus
  imported: number
  updated: number
}

export interface RevinotePostProcessStatus {
  state: 'idle' | 'queued'
  meetingId: string | null
  submittedAt: number | null
}

export interface RevinotePostProcessResult {
  meetingId: string
  submittedAt: number
}

export type ConversationClassification = 'conversation' | 'media' | 'insufficient'
export type ConversationConfidence = 'high' | 'medium' | 'low'

export interface PersistedEpisodeAnalysis {
  id: string
  episodeId: string
  workdayId: string
  startedAt: number
  endedAt: number
  classification: ConversationClassification
  confidence: ConversationConfidence
  reason: string
  title: string
  description: string
  summary: string
  actionPoints: string[]
  sourceHash: string
  provider: AgentProvider
  model: string
  promptVersion: number
  schemaVersion: number
  generatedAt: number
}

export interface ProjectAttention {
  project: string
  durationMinutes: number
  description: string
}

export interface OpenTask {
  titleChangeReason?: 'outcome' | null
  /** Exact durable WorkItem identity; absent only for a genuinely new analyzed item. */
  id?: string
  title: string
  description: string
  prompt?: string
  /** Optional AI offer. Null means the action requires the user; omitted in legacy analyses. */
  aiSuggestion?: string | null
  context?: string
  returnPoint?: WorkItemReturnPoint
  source?: {
    kind: 'conversation' | 'task'
    label: string
    detail: string
    /** Stable link to the originating conversation within this Day. */
    conversationStartTime?: string
    /** Exact persisted screen-context record supporting a generated task. */
    evidenceId?: string
  }
  /** Persisted authoring guards; model output never sets these. */
  userEditedTitle?: boolean
  userEditedDescription?: boolean
  completed?: boolean
}

export type DayTaskState = 'open' | 'completed' | 'dismissed' | 'removed' | 'superseded'
export type DayTaskEventType =
  | 'created'
  | 'completed'
  | 'reopened'
  | 'dismissed'
  | 'revised'
  | 'removed'
  | 'superseded'
  | 'delegated'

export interface DayTaskEvent {
  id: string
  type: DayTaskEventType
  at: number
  title: string
  previousTitle?: string
  reason: string
  provider?: AgentProvider
  prompt?: string
  message?: string
  response?: string
  durationMs?: number
  steps?: AgentTurnStep[]
}

export type WorkItemLifecycle = 'open' | 'completed' | 'abandoned' | 'superseded'
export type WorkItemStatus = 'todo' | 'in_progress'
export type WorkItemPriority = 'none' | 'low' | 'medium' | 'high' | 'urgent'
export type WorkItemAttentionState = 'idle' | 'user_active' | 'agent_running' | 'waiting_on_user'
export type WorkItemActor = 'user' | 'agent' | 'system'
export type WorkItemFactType =
  | 'created'
  | 'edited'
  | 'completed'
  | 'reopened'
  | 'abandoned'
  | 'superseded'
  | 'agent_started'
  | 'agent_completed'
  | 'agent_failed'

export interface WorkItemSource {
  id: string
  kind: 'manual' | 'meeting' | 'observed' | 'legacy'
  label: string
  detail: string
  workdayId: string | null
  conversationReference?: string | null
  /** Exact action point within the originating conversation, when this source represents one. */
  conversationActionId?: string | null
  conversationStartTime: string | null
  observedAt: number
  confidence: number | null
}

export interface WorkItemReturnPoint {
  lastMove: string
  unresolved: string
  nextMove: string
}

export interface WorkItemFact {
  id: string
  type: WorkItemFactType
  actor: WorkItemActor
  summary: string
  at: number
  agentSessionId: string | null
}

export interface WorkItemObservation {
  id: string
  kind: 'progress' | 'blocked' | 'completion_candidate'
  summary: string
  confidence: number
  workdayId: string | null
  observedAt: number
  dismissedAt: number | null
}

export type WorkItemAgentSessionStatus = 'running' | 'waiting_on_user' | 'completed' | 'failed' | 'cancelled' | 'stale'

export interface WorkItemAgentSession {
  id: string
  provider: AgentProvider
  status: WorkItemAgentSessionStatus
  instruction: string
  message: string
  response: string
  startedAt: number
  updatedAt: number
  completedAt: number | null
  durationMs: number | null
  steps: AgentTurnStep[]
}

export interface WorkItem {
  id: string
  title: string
  description: string
  prompt: string
  /** A concrete, optional AI offer; absent or null means this is a personal task. */
  aiSuggestion?: string | null
  context: string
  returnPoint: WorkItemReturnPoint
  lifecycle: WorkItemLifecycle
  status: WorkItemStatus
  priority: WorkItemPriority
  dueAt: number | null
  attention: WorkItemAttentionState
  createdAt: number
  updatedAt: number
  closedAt: number | null
  userEditedTitle: boolean
  userEditedDescription: boolean
  sources: WorkItemSource[]
  facts: WorkItemFact[]
  observations: WorkItemObservation[]
  agentSessions: WorkItemAgentSession[]
}

export function workItemForConversationActionPoint(
  workItems: readonly WorkItem[],
  conversation: ConversationSummary,
  actionPoint: ConversationActionPoint
): WorkItem | null {
  const reference = conversationReference(conversation)
  const linked = workItems.filter((item) =>
    item.sources.some(
      (source) =>
        source.kind === 'meeting' &&
        source.conversationReference === reference &&
        source.conversationActionId === actionPoint.id
    )
  )
  if (linked.length === 1) return linked[0] ?? null
  if (linked.length > 1) return null

  const normalizedText = actionPoint.text.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
  const legacy = workItems.filter(
    (item) =>
      item.title.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US') === normalizedText &&
      item.sources.some(
        (source) =>
          source.kind === 'meeting' && source.conversationReference === reference && !source.conversationActionId
      )
  )
  return legacy.length === 1 ? (legacy[0] ?? null) : null
}

export interface CreateWorkItemInput {
  title: string
  description: string
}

export interface UpdateWorkItemInput {
  title: string
  description: string
}

export interface UpdateWorkItemMetadataInput {
  status: WorkItemStatus
  priority: WorkItemPriority
  dueAt: number | null
}

export function manualMeetingTitle(timestamp: number, locale: AppLocale = 'nl') {
  const date = new Date(timestamp)
  const day = date.toLocaleDateString(locale === 'nl' ? 'nl-NL' : 'en-GB', { day: 'numeric', month: 'long' })
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return `${day}, ${time}`
}

export interface ManualMeeting {
  id: string
  workdayId: string
  /** Final local conversation episode, available as soon as captured audio has been assembled. */
  episodeId?: string
  title: string
  notes: string
  startedAt: number
  confirmedAt?: number
  availableFromAt?: number
  endedAt: number | null
  pausedAt: number | null
  pausedMs: number
  status: 'recording' | 'processing' | 'completed'
  automaticRevinoteProcessingBlocked: boolean
  systemAudioAvailable?: boolean
}

export type ManualMeetingDetails = Pick<ManualMeeting, 'title' | 'notes'>

export interface RecordWorkItemAgentSessionInput {
  sessionId: string
  provider: AgentProvider
  prompt: string
  message: string
  response: string
  durationMs: number
  steps: AgentTurnStep[]
  startedAt: number
}

export interface StartWorkItemAgentSessionInput {
  sessionId: string
  provider: AgentProvider
  prompt: string
  message: string
  startedAt: number
}

export interface FinishWorkItemAgentSessionInput {
  response: string
  durationMs: number
  steps: AgentTurnStep[]
}

export interface DayTaskRecord {
  id: string
  task: OpenTask
  state: DayTaskState
  createdAt: number
  updatedAt: number
  events: DayTaskEvent[]
}

export interface GeneratedDayTaskChange {
  /** Exact durable WorkItem identity copied from the analysis input. */
  id: string
  title: string
  type: 'completed' | 'removed' | 'superseded'
  reason: string
  replacementTitle?: string
}

export interface WikiSuggestionEvidence {
  sourceId: string
  observedAt: number
  quote: string
  kind?: string
  provider?: AgentProvider
  project?: string
  documentSourceId?: string
  role?: 'user' | 'assistant'
  eventId?: string
  partIndex?: number
  partCount?: number
}

export interface WikiPageUpdate {
  slug: string
  title: string
  /** Complete current content for Remember's managed section. Older stored updates may omit it. */
  content?: string
  summary: string
  changeType: 'created' | 'updated'
  /** Exact destination for agent learning; other maintenance treats this as a legacy hint. */
  suggestedSpaceId?: string | null
  /** Verified supporting passages retained for maintenance deduplication. */
  evidence?: WikiSuggestionEvidence[]
}

export interface DayAnalysisProvenance {
  version: 1
  workdayId: string
  startedAt: number
  coveredThrough: number
  rawEvidenceIds: string[]
  rawSources: { kind: 'context' | 'speech' | 'audio' | 'app'; sourceId: string; workdayId: string; revision: string }[]
  taskIds: string[]
  agentMessages: { id: string; contentHash: string }[]
  wikiPages: { spaceId: string; slug: string; pageId: string; revisionId: string }[]
}

export interface DayMemory {
  analysisProvenance?: DayAnalysisProvenance
  summary: string
  currentFocus: string | null
  outcomes: string[]
  decisions: string[]
  openLoops: string[]
  /** @deprecated Legacy migration input. New Inbox state is stored as durable WorkItems. */
  openTasks?: OpenTask[]
  /** @deprecated Legacy migration input. */
  taskRecords?: DayTaskRecord[]
  /** @deprecated Analysis transport only; never persisted as Inbox lifecycle. */
  taskChanges?: GeneratedDayTaskChange[]
  /** @deprecated Legacy migration input. */
  currentFocusTaskId?: string | null
  /** @deprecated Legacy migration input. */
  dismissedOpenLoops?: string[]
  /** @deprecated Legacy migration input. */
  completedTaskTitles?: string[]
  projectAttention?: ProjectAttention[]
  conversations: ConversationSummary[]
  /** Classification windows that authoritatively exclude generated conversations. */
  classifiedNonConversationWindows?: Array<Pick<ConversationSummary, 'startTime' | 'endTime'>>
  /** User-deleted conversations remain excluded when a later refresh recognizes them again. */
  deletedConversationWindows?: DeletedConversationReference[]
  timeline: CalendarBlock[]
  /** User corrections that remain authoritative across generated refreshes. */
  timelineOverrides?: TimelineItemOverride[]
  /** User-hidden blocks remain hidden when a later refresh recognizes them again. */
  hiddenTimelineItemIds?: string[]
  knowledgeSuggestions: WikiPageUpdate[]
  refreshedAt: number
  coveredThrough: number
  /** Wiki review coverage advances only after reviewed changes are saved. */
  wikiCoveredThrough?: number
}

export interface DayRefreshProgress {
  phase: 'preparing' | 'analyzing' | 'synthesizing' | 'saving'
  message: string
  completed: number | null
  total: number | null
  updatedAt: number
  updates: string[]
}

export type AgentRunStatus = 'running' | 'completed' | 'failed'
export type AgentTraceAction =
  | 'day-refresh'
  | 'agent-learning'
  | 'context-import'
  | 'cli-status'
  | 'cli-days'
  | 'cli-day'
  | 'cli-search'
  | 'cli-conversations'
  | 'cli-usage'
  | 'cli-wiki-spaces'
  | 'cli-wiki-list'
  | 'cli-wiki-search'
  | 'cli-wiki-read'
  | 'cli-wiki-write'

export interface AgentRunContextCategory {
  category: 'app-usage' | 'screen-context' | 'audio-transcripts' | 'wiki'
  itemCount: number
}

/** Operational audit metadata only. This intentionally never contains model reasoning. */
export interface AgentRunTrace {
  id: string
  provider: AgentProvider
  startedAt: number
  completedAt: number | null
  durationMs: number | null
  status: AgentRunStatus
  contextUsed: AgentRunContextCategory[]
  insights: string[]
  error: string | null
}

export interface AgentTraceLogEntry {
  timestamp: number
  message: string
}

export interface AgentTraceDiagnostic {
  provider: AgentProvider
  phase: 'shard' | 'final'
  shardIndex: number | null
  shardCount: number | null
  attempt: 1 | 2
  executable: string
  launchExecutable: string
  arguments: string[]
  workingDirectory: string
  version: string | null
  model: string
  effort: string
  outputFormat: 'json' | 'codex-output-file'
  environment: {
    home: string | null
    path: string | null
    shell: string | null
    bunInstall: string | null
    claudeCode: string | null
  }
  exitCode: number | null
  startedAt: number
  completedAt: number
  promptBytes: number
  stdoutBytes: number
  stderrBytes: number
  stdout: string
  stderr: string
  systemPrompt: string
  schema: string
  prompt: string
  truncated: boolean
  error: string
}

/** Append-only operational activity. Failed runs may include redacted raw agent output for explicit debugging. */
export interface AgentTraceEvent {
  id: string
  action: AgentTraceAction
  provider: AgentProvider | null
  status: AgentRunStatus
  startedAt: number
  completedAt: number | null
  dayId: string | null
  reason: DayRefreshReason | null
  error: string | null
  logs: AgentTraceLogEntry[]
  diagnostics?: AgentTraceDiagnostic[]
}

export interface DayRefresh {
  status: DayRefreshStatus
  reason: DayRefreshReason | null
  targetThrough: number | null
  error: string | null
  progress: DayRefreshProgress | null
  run: AgentRunTrace | null
}

export interface Day {
  id: string
  /** Calendar identity captured when the Day was created; unchanged by timezone travel. */
  localDay?: string
  startedAt: number
  endedAt: number | null
  activeDurationMs: number
  moments: AudioMoment[]
  appActivity: AppActivity[]
  contextMoments: ContextMomentReference[]
  memory: DayMemory | null
  refresh: DayRefresh
  /** Runtime projection of live, explicitly scoped speech episodes. */
  ongoingConversations?: OngoingConversation[]
  /** Runtime projection of plausible conversations awaiting a user decision. */
  conversationCandidates?: ConversationCandidate[]
  /** Runtime projection of retained speech blocks available for manual recovery. */
  recoverableConversationBlocks?: RecoverableConversationBlock[]
  /** Captured chunks that still have local audio, independent of episode recognition. */
  retainedAudioMomentIds?: string[]
}

const REMEMBER_BUNDLE_ID = 'computer.remember.app'
const LEGACY_REMEMBER_BUNDLE_IDS = new Set(['com.revinote.local'])
const ELECTRON_DEVELOPMENT_BUNDLE_IDS = new Set(['com.github.Electron', 'org.electronjs.Electron'])
const MACOS_SYSTEM_ACTIVITY_BUNDLE_IDS = new Set([
  'com.apple.authenticationservicescore.authenticationservicesagent',
  'com.apple.controlcenter',
  'com.apple.coreservicesuiagent',
  'com.apple.dock',
  'com.apple.localauthentication.uiagent',
  'com.apple.loginwindow',
  'com.apple.notificationcenterui',
  'com.apple.screensaver.engine',
  'com.apple.screensaver.engine.legacy',
  'com.apple.securityagent',
  'com.apple.systemuiserver',
  'com.apple.usernotificationcenter',
  'com.apple.windowmanager',
  'com.apple.windowmanager.stagemanageronboarding',
  'com.apple.windowserver',
])
const MACOS_SYSTEM_ACTIVITY_NAMES = new Set([
  'authenticationservicesagent',
  'controlcenter',
  'coreservicesuiagent',
  'coreautha',
  'dock',
  'lock screen',
  'loginwindow',
  'notificationcenter',
  'screensaverengine',
  'securityagent',
  'stagemanageronboarding',
  'systemuiserver',
  'usernotificationcenter',
  'windowmanager',
  'window server',
])

export function isMacosSystemActivity(activity: Pick<AppActivity, 'appName' | 'bundleId'>): boolean {
  const bundleId = activity.bundleId.trim().toLowerCase()
  if (MACOS_SYSTEM_ACTIVITY_BUNDLE_IDS.has(bundleId)) return true

  const appName = activity.appName.trim().toLowerCase()
  return (!bundleId || bundleId.startsWith('com.apple.')) && MACOS_SYSTEM_ACTIVITY_NAMES.has(appName)
}

export function normalizeAppIdentity(
  activity: Pick<AppActivity, 'appName' | 'bundleId'>
): Pick<AppUsage, 'name' | 'bundleId'> {
  if (activity.appName === 'Electron' && ELECTRON_DEVELOPMENT_BUNDLE_IDS.has(activity.bundleId)) {
    return { name: 'Remember', bundleId: REMEMBER_BUNDLE_ID }
  }
  if (LEGACY_REMEMBER_BUNDLE_IDS.has(activity.bundleId)) return { name: 'Remember', bundleId: REMEMBER_BUNDLE_ID }
  return { name: activity.appName, bundleId: activity.bundleId }
}

/**
 * Focus segments are exclusive: at any point in time only the foreground app
 * receives credit. Capping a segment at the next segment start also repairs
 * legacy rows that were left open by an interrupted capture.
 */
export function summarizeAppUsage(days: Day[], dayLimit: number, now = Date.now()): AppUsage[] {
  const usage = new Map<string, AppUsage>()

  for (const day of days.slice(0, dayLimit)) {
    const dayEnd = day.endedAt ?? now
    const activities = day.appActivity.slice().sort((first, second) => first.startedAt - second.startedAt)

    for (const [index, activity] of activities.entries()) {
      const nextStartedAt = activities[index + 1]?.startedAt ?? dayEnd
      const endedAt = Math.min(activity.endedAt ?? dayEnd, nextStartedAt, dayEnd)
      const durationMs = Math.max(0, endedAt - Math.max(activity.startedAt, day.startedAt))
      if (activity.appName === 'Idle' || isMacosSystemActivity(activity) || durationMs === 0) continue

      const identity = normalizeAppIdentity(activity)
      const key = identity.bundleId || identity.name
      const current = usage.get(key)
      usage.set(key, {
        ...identity,
        durationMs: (current?.durationMs ?? 0) + durationMs,
      })
    }
  }

  return Array.from(usage.values()).sort((first, second) => second.durationMs - first.durationMs)
}

export interface WikiPage {
  slug: string
  title: string
  content: string
  excerpt: string
  updatedAt: number
  sourceCount: number
  revision?: string
}

export const PERSONAL_WIKI_SPACE_ID = 'personal'

export function defaultPersonalWikiSpaceName(locale: AppLocale) {
  return locale === 'nl' ? 'Persoonlijk' : 'Personal'
}

export const WIKI_SPACE_ICONS = [
  'lock',
  'book',
  'folder',
  'building',
  'code',
  'bank',
  'heart',
  'idea',
  'people',
  'rocket',
  'star',
  'compass',
] as const
export type WikiSpaceIcon = (typeof WIKI_SPACE_ICONS)[number]

export const WIKI_SPACE_COLORS = ['slate', 'purple', 'teal', 'green', 'amber', 'orange', 'pink', 'red', 'sky'] as const
export type WikiSpaceColor = (typeof WIKI_SPACE_COLORS)[number]

export type WikiMaintenanceMode = 'auto' | 'suggest'

export interface WikiSpace {
  id: string
  name: string
  description: string
  icon: WikiSpaceIcon
  color: WikiSpaceColor
  maintenanceMode: WikiMaintenanceMode
}

export type KnowledgeSuggestionStatus = 'pending' | 'applied' | 'dismissed' | 'superseded'

export interface KnowledgeSuggestion {
  id: string
  dayId: string
  dayStartedAt: number
  slug: string
  title: string
  content: string
  summary: string
  baseRevision: string | null
  sourceId: string
  suggestedSpaceId: string
  status: KnowledgeSuggestionStatus
  destinationSpaceId: string | null
  appliedAt: number | null
  evidence?: WikiSuggestionEvidence[]
}

export type WikiChangeLogSource = 'day' | 'timeline' | 'import' | 'other'
export type WikiChangeLogType = 'created' | 'updated' | 'removed'

export interface WikiChangeLogItem {
  slug: string
  title: string
  type: WikiChangeLogType
}

export interface WikiChangeLogEntry {
  id: string
  timestamp: number
  sourceId: string
  source: WikiChangeLogSource
  dayId: string | null
  changes: WikiChangeLogItem[]
}

export interface WikiOverview {
  spaces: WikiSpace[]
  suggestions: KnowledgeSuggestion[]
  personalChanges: WikiChangeLogEntry[]
  projectAssignments: WikiProjectAssignment[]
}

export type WikiRevisionActor = 'user' | 'remember' | 'external' | 'system'
export type WikiRevisionOperation = 'created' | 'updated' | 'deleted' | 'restored'

export interface WikiPageRevision {
  id: string
  parentRevisionId: string | null
  createdAt: number
  actor: WikiRevisionActor
  operation: WikiRevisionOperation
  sourceId: string | null
  summary: string | null
  title: string
  content: string
  contentHash: string
  evidence?: WikiSuggestionEvidence[]
}

export interface WikiPageHistory {
  pageId: string
  spaceId: string
  slug: string
  headRevisionId: string | null
  revisions: WikiPageRevision[]
}

export interface WikiPageAnalysisEditContext {
  currentRevision: Pick<WikiPageRevision, 'id' | 'createdAt' | 'actor' | 'sourceId' | 'summary'>
  lastRememberRevision: Pick<WikiPageRevision, 'id' | 'createdAt' | 'title' | 'content'> | null
  changesSinceRemember: Array<
    Pick<WikiPageRevision, 'id' | 'createdAt' | 'actor' | 'operation' | 'sourceId' | 'summary'>
  >
}

export interface WikiPageForAnalysis extends WikiPage {
  spaceId: string
  spaceName: string
  maintenanceMode: WikiMaintenanceMode
  editContext: WikiPageAnalysisEditContext | null
}

export interface WikiProjectAssignment {
  projectSlug: string
  spaceId: string
  createdAt: number
}

export interface MoveWikiProjectInput {
  projectSlug: string
  sourceSpaceId: string
  destinationSpaceId: string
}

export interface ContextImportProviderSummary {
  provider: AgentProvider
  available: boolean
  projectCount: number
  sessionCount: number
  memoryCount: number
  latestAt: number | null
}

export interface ContextImportPreview {
  providers: ContextImportProviderSummary[]
}

export interface ContextImportResult {
  providers: AgentProvider[]
  sourceCount: number
  createdPages: string[]
  updatedPages: string[]
}

export interface CreateWikiPageInput {
  /** Stable slug and initial content for atomic, source-bound creation. */
  slug?: string
  content?: string
  contribution?: { client: string; summary: string }
  spaceId: string
  category: string
  title: string
  /** Existing page that will contain this page as a direct child. */
  parentSlug?: string
}

export interface SaveWikiPageInput {
  strictRevision?: boolean
  contribution?: { client: string; summary: string }
  spaceId: string
  slug: string
  title: string
  content: string
  expectedRevision?: string
}

export interface DeleteWikiPageInput {
  spaceId: string
  slug: string
  expectedRevision?: string
  onlyIfLeaf?: boolean
}

export interface CreateLocalWikiSpaceInput {
  name: string
  description: string
}

export interface RemoveLocalWikiSpaceInput {
  spaceId: string
}

export interface UpdateWikiSpaceInput {
  spaceId: string
  name?: string
  description?: string
  icon?: WikiSpaceIcon
  color?: WikiSpaceColor
  maintenanceMode?: WikiMaintenanceMode
}

export interface WikiPageHistoryInput {
  spaceId: string
  slug: string
}

export interface RestoreWikiPageRevisionInput extends WikiPageHistoryInput {
  revisionId: string
  expectedRevision: string
}

export interface ReorderWikiSpacesInput {
  spaceIds: string[]
}

export interface KnowledgeSuggestionActionInput {
  suggestionId: string
  destinationSpaceId?: string
}

export interface AgentContextBinding {
  directory: string
  spaceId: string
  projectSlug: string
}

export interface AgentLearningStatus {
  status: 'disabled' | 'watching' | 'learning' | 'paused' | 'offline' | 'needs-consent' | 'failed'
  lastCheckedAt: number | null
  lastProcessedAt: number | null
  pendingCount: number
  sourceCount: number
  error: string | null
}

export interface LocalSettings {
  dictation: DictationPreferences
  interfaceLanguage: InterfaceLanguage
  interfaceTheme: InterfaceTheme
  offlineMode: boolean
  errorReportingEnabled: boolean
  automaticUpdates: boolean
  defaultAgentProvider: AgentProvider
  agentComputer: import('./agentComputer').AgentComputer
  liveTaskUpdates: boolean
  dayAnalysisProvider: AgentProvider | null
  dayAnalysisOnboardingCompleted: boolean
  privacyOnboardingCompleted: boolean
  cloudAnalysisConsent: boolean
  cloudConsentNoticeSeen: boolean
  contextImportOnboardingCompleted: boolean
  contextImportCompletedAt: number | null
  agentLearningEnabled: boolean
  agentLearningEnabledAt: number | null
  agentContextBindings: AgentContextBinding[]
  codexAnalysisModel: CodexAnalysisModel
  codexAnalysisEffort: CodexAnalysisEffort
  claudeAnalysisModel: ClaudeAnalysisModel
  claudeAnalysisEffort: ClaudeAnalysisEffort
  launchAtLogin: boolean
  edgeWidgetEnabled: boolean
  edgeWidgetHiddenUntil: number | null
  edgeWidgetEdge: import('./edgeWidget').EdgeWidgetEdge
  audioCaptureEnabled: boolean
  audioCaptureOnboardingCompleted: boolean
  automaticRevinoteProcessing: boolean
  frequentDayRefresh: boolean
  frequentDayRefreshIntervalMinutes: number
  capturePaused: boolean
  capturePausedUntil: number | null
  capturePauseSources: CapturePauseSource[]
  captureSchedule: CaptureSchedule
  excludePasswordManagers: boolean
  excludePrivateBrowsing: boolean
  appCaptureMode: CaptureFilterMode
  excludedAppBundleIds: string[]
  includedAppBundleIds: string[]
  websiteCaptureMode: CaptureFilterMode
  excludedWebsites: string[]
  includedWebsites: string[]
}

export function hasCompletedOnboarding(settings: LocalSettings): boolean {
  return (
    settings.privacyOnboardingCompleted &&
    settings.audioCaptureOnboardingCompleted &&
    settings.dayAnalysisOnboardingCompleted &&
    settings.dayAnalysisProvider !== null &&
    settings.cloudAnalysisConsent
  )
}

export interface AgentSetup {
  provider: AgentProvider
  status: AgentStatus
  executable: string | null
  detail: string | null
}

export interface CliSetupStatus {
  installed: boolean
  upToDate: boolean
  commandInstalled: boolean
  codexSkillInstalled: boolean
  claudeSkillInstalled: boolean
  commandPath: string
  pathAvailable: boolean
  error: string | null
}

export interface ClaudeMcpSetupStatus {
  connected: boolean
  conflict: boolean
  commandPath: string
  error: string | null
}

export interface CaptureState {
  status: CaptureStatus
  pauseReason: 'manual' | 'schedule' | null
  pausedSources: CapturePauseSource[]
  nextScheduleTransitionAt: number | null
  activeSessionId: string | null
  startedAt: number | null
  activeStartedAt: number | null
  activeDurationMs: number
  manualMeeting: ManualMeeting | null
  modelDownloaded: boolean
  modelDownloadProgress: number | null
  modelPreparationPhase: 'downloading' | 'installing' | null
  systemAudioPermission: PermissionStatus
  microphonePermission: PermissionStatus
  microphoneName: string | null
  microphoneLastChunkAt: number | null
  systemAudioCheckStatus: SystemAudioCheckStatus
  systemAudioCheckError: string | null
  permissionsResolved: boolean
  accessibilityPermission: ContextPermissionStatus
  inputMonitoringPermission: ContextPermissionStatus
  appActivityStatus: 'available' | 'unavailable' | 'unsupported'
  contextCaptureStatus: 'available' | 'unavailable' | 'unsupported'
  contextCaptureHealth: 'inactive' | 'starting' | 'healthy' | 'reconnecting'
  contextCaptureLastEventAt: number | null
  settingsHealth: SettingsHealth
  restartRequired: boolean
  agent: AgentSetup
  claudeCliAvailable: boolean
  error: string | null
}

export interface SettingsHealth {
  status: 'healthy' | 'missing' | 'recovery-required'
  reason: 'none' | 'unreadable' | 'invalid' | 'unsupported-version' | 'missing-current'
  lastKnownGoodAvailable: boolean
  lastKnownGoodAt: number | null
}

export type SettingsRecoveryAction = 'restore-last-known-good' | 'use-safe-settings'

export type DailyReviewSource = Exclude<AudioSource, 'revinote'>
export type DailyReviewContextPermissionStatus = ContextPermissionStatus
export type DailyReviewMoment = AudioMoment
export type DailyReviewAppActivity = AppActivity
export type DailyReviewContextMoment = ContextMoment
export type DailyReviewCalendarBlock = CalendarBlock
export type DailyReviewWikiPageUpdate = WikiPageUpdate
export type DailyReviewSession = Day
export type DailyReviewWikiPage = WikiPage
export type DailyReviewState = CaptureState
export type ScreenPermissionStatus = PermissionStatus

export interface UpdateState {
  status: 'unavailable' | 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'error'
  availability: 'supported' | 'development' | 'unconfigured'
  currentVersion: string
  version: string | null
  downloadProgress: number | null
  errorStage: 'check' | 'download' | null
  revision: number
}

export interface RendererErrorReport {
  source: 'error' | 'unhandled-rejection'
  name: string
  message: string
  stack: string | null
}

export interface RecordingAudioLevel {
  source: 'microphone' | 'system'
  level: number
  at: number
}

export interface RememberBridge {
  readonly platform: 'macos' | 'windows' | 'linux'
  reportRendererError: (input: RendererErrorReport) => void
  getUserName: () => Promise<string | null>
  getState: () => Promise<CaptureState>
  onState: (listener: (state: CaptureState) => void) => () => void
  onRecordingAudioLevel?: (listener: (sample: RecordingAudioLevel) => void) => () => void
  listDays: () => Promise<Day[]>
  searchDays: (query: string, locale: 'en-US' | 'nl-NL') => Promise<RememberSearchResults>
  getDayRevision: () => Promise<number>
  listDaySnapshot: () => Promise<DaySnapshot>
  onDays: (listener: (changes: DayChanges) => void) => () => void
  onMemoryChanged: (listener: () => void) => () => void
  listWorkItems: () => Promise<WorkItem[]>
  createWorkItem: (input: CreateWorkItemInput) => Promise<WorkItem>
  updateWorkItem: (itemId: string, input: UpdateWorkItemInput) => Promise<WorkItem>
  updateWorkItemMetadata: (itemId: string, input: UpdateWorkItemMetadataInput) => Promise<WorkItem>
  setWorkItemLifecycle: (itemId: string, lifecycle: WorkItemLifecycle) => Promise<WorkItem>
  recordWorkItemAgentSession: (itemId: string, input: RecordWorkItemAgentSessionInput) => Promise<WorkItem>
  startWorkItemAgentSession: (itemId: string, input: StartWorkItemAgentSessionInput) => Promise<WorkItem>
  finishWorkItemAgentSession: (
    itemId: string,
    sessionId: string,
    input: FinishWorkItemAgentSessionInput
  ) => Promise<WorkItem>
  failWorkItemAgentSession: (itemId: string, sessionId: string) => Promise<WorkItem>
  prepareModel: () => Promise<CaptureState>
  pauseCapture: (input?: number | null | CapturePauseInput) => Promise<CaptureState>
  resumeCapture: () => Promise<CaptureState>
  startManualMeeting: () => Promise<CaptureState>
  updateManualMeetingDetails: (meetingId: string, title: string, notes: string) => Promise<CaptureState>
  updateManualMeetingStart: (meetingId: string, startedAt: number) => Promise<CaptureState>
  pauseManualMeeting: (meetingId: string) => Promise<CaptureState>
  resumeManualMeeting: (meetingId: string) => Promise<CaptureState>
  stopManualMeeting: (meetingId: string, details?: ManualMeetingDetails) => Promise<CaptureState>
  discardManualMeeting: (meetingId: string) => Promise<CaptureState>
  onMeetingReminder: (listener: () => void) => () => void
  clearRecentCapture: (cutoff: number) => Promise<Day[]>
  verifySystemAudio: () => Promise<CaptureState>
  requestMicrophonePermission: () => Promise<CaptureState>
  requestAccessibilityPermission: () => Promise<CaptureState>
  showAccessibilityPermissionGuide: () => Promise<void>
  getAccessibilityPermissionStatus: () => Promise<boolean>
  startPermissionGuideDrag: (previewDataUrl?: string) => void
  closePermissionGuide: () => void
  openSystemAudioSettings: () => Promise<void>
  openMicrophoneSettings: () => Promise<void>
  openAccessibilitySettings: () => Promise<void>
  restartApp: () => Promise<void>
  revealDataFolder: () => Promise<void>
  getSettings: () => Promise<LocalSettings>
  onSettingsChanged: (listener: (settings: LocalSettings) => void) => () => void
  updateSettings: (patch: Partial<LocalSettings>) => Promise<LocalSettings>
  repairSettings: (action: SettingsRecoveryAction) => Promise<LocalSettings>
  getRevinoteConnectionStatus: () => Promise<RevinoteConnectionStatus>
  connectRevinote: () => Promise<RevinoteConnectionStatus>
  syncRevinote: () => Promise<RevinoteSyncResult>
  disconnectRevinote: () => Promise<RevinoteConnectionStatus>
  onRevinoteConnectionStatus: (listener: (status: RevinoteConnectionStatus) => void) => () => void
  getRevinotePostProcessStatus: (episodeId: string) => Promise<RevinotePostProcessStatus>
  postProcessConversationWithRevinote: (
    dayId: string,
    conversationReference: string
  ) => Promise<RevinotePostProcessResult>
  resetPermissionsForDevelopment: () => Promise<boolean>
  resetAllData: () => Promise<boolean>
  getCodexModels: () => Promise<CodexModel[]>
  checkAgent: (provider?: AgentProvider) => Promise<AgentSetup>
  openAgentLogin: (provider?: AgentProvider) => Promise<void>
  logoutAgent: () => Promise<void>
  getContextImportPreview: () => Promise<ContextImportPreview>
  importAgentContext: () => Promise<ContextImportResult>
  getAgentLearningStatus: () => Promise<AgentLearningStatus>
  checkAgentLearning: () => Promise<AgentLearningStatus>
  openAgentChat: (input: OpenAgentChatInput) => Promise<boolean>
  listAgentProjects: () => Promise<AgentProject[]>
  chooseAgentProject: () => Promise<AgentProject | null>
  getWorkItemAgentContext: (itemId: string) => Promise<WorkItemAgentContext>
  setWorkItemAgentProject: (itemId: string, project: AgentProject | null) => Promise<WorkItemAgentContext>
  getAssistantTaskActionsEnabled: () => Promise<boolean>
  getAssistantConversation: (beforeMessageId?: string) => Promise<AssistantConversation>
  getAssistantTaskDraft: (workItemId: string) => Promise<AssistantTaskDraft>
  controlAssistantTask: (input: AssistantTaskControlInput) => Promise<AssistantConversation>
  sendAssistantMessage: (input: SendAssistantMessageInput) => Promise<AssistantConversation>
  sendAssistantQueuedMessage: (input: SendAssistantQueuedMessageInput) => Promise<AssistantConversation>
  retryAssistantMessage: (messageId: string) => Promise<AssistantConversation>
  cancelAssistantTurn: (messageId?: string) => Promise<void>
  onAssistantChanged: (listener: () => void) => () => void
  getAssistantAttention?: () => Promise<AssistantAttention>
  onAssistantAttentionChanged?: (listener: (state: AssistantAttention) => void) => () => void
  markAssistantRead?: (messageId: string) => Promise<void>
  setAssistantComposing?: (active: boolean) => Promise<void>
  dismissAssistantInitiative?: (messageId: string) => Promise<AssistantConversation>
  previewAssistantBriefingGrant?: () => Promise<AssistantBriefingGrantPreview>
  confirmAssistantBriefingGrant?: (token: string) => Promise<AssistantConversation>
  revokeAssistantBriefingGrant?: (id: string) => Promise<AssistantConversation>
  controlAssistantBriefing?: (input: AssistantTaskControlInput) => Promise<AssistantConversation>
  openAssistantBriefing?: (input: {
    actionId: string
    messageId: string
    resultId: string
  }) => Promise<{ title: string; content: string }>
  runAgentTurn: (input: RunAgentTurnInput) => Promise<RunAgentTurnResult>
  getAgentInteractions: () => Promise<AgentInteraction[]>
  answerAgentInteraction: (answer: AgentInteractionAnswer) => Promise<void>
  onAgentInteractionsChanged: (listener: () => void) => () => void
  cancelAgentTurn: (turnId: string) => Promise<void>
  onAgentTurnUpdate: (listener: (update: AgentTurnUpdate) => void) => () => void
  refreshDay: (dayId: string) => Promise<Day>
  updateTimelineItem: (dayId: string, itemId: string, input: UpdateTimelineItemInput) => Promise<Day>
  hideTimelineItem: (dayId: string, itemId: string) => Promise<Day>
  showHiddenTimelineItems: (dayId: string) => Promise<Day>
  addTimelineItemToWiki: (dayId: string, itemId: string) => Promise<TimelineWikiResult>
  /** Accepts a stable conversation reference or a legacy local episode id. Prefers Revinote audio for imports. */
  getConversationAudioUrl: (dayId: string, conversationReference: string) => Promise<string | null>
  /** Saves retained audio through a native dialog. Returns false when the dialog is cancelled. */
  saveConversationAudio: (dayId: string, conversationReference: string) => Promise<boolean>
  setConversationAudioPlayback: (playbackId: string, active: boolean) => Promise<void>
  deleteConversation: (dayId: string, conversationReference: string) => Promise<Day>
  mergeConversations: (dayId: string, conversationReferences: string[]) => Promise<Day>
  recoverConversation: (dayId: string, episodeIds: string[]) => Promise<Day>
  recoverAudio: (dayId: string, momentIds: string[]) => Promise<Day>
  dismissConversationCandidate: (dayId: string, episodeId: string) => Promise<Day>
  deleteDay: (dayId: string) => Promise<Day[]>
  getWikiOverview: () => Promise<WikiOverview>
  createLocalWikiSpace: (input: CreateLocalWikiSpaceInput) => Promise<WikiOverview>
  removeLocalWikiSpace: (input: RemoveLocalWikiSpaceInput) => Promise<WikiOverview>
  updateWikiSpace: (input: UpdateWikiSpaceInput) => Promise<WikiOverview>
  reorderWikiSpaces: (input: ReorderWikiSpacesInput) => Promise<WikiOverview>
  listWikiPages: (spaceId: string) => Promise<WikiPage[]>
  createWikiPage: (input: CreateWikiPageInput) => Promise<WikiPage[]>
  saveWikiPage: (input: SaveWikiPageInput) => Promise<WikiPage[]>
  deleteWikiPage: (input: DeleteWikiPageInput) => Promise<WikiPage[]>
  getWikiPageHistory: (input: WikiPageHistoryInput) => Promise<WikiPageHistory>
  restoreWikiPageRevision: (input: RestoreWikiPageRevisionInput) => Promise<WikiPage[]>
  undoWikiLearning: (input: RestoreWikiPageRevisionInput) => Promise<WikiPage[]>
  moveWikiProject: (input: MoveWikiProjectInput) => Promise<WikiOverview>
  applyKnowledgeSuggestion: (input: KnowledgeSuggestionActionInput) => Promise<WikiOverview>
  dismissKnowledgeSuggestion: (input: KnowledgeSuggestionActionInput) => Promise<WikiOverview>
  getCliSetupStatus: () => Promise<CliSetupStatus>
  installCliAccess: () => Promise<CliSetupStatus>
  getClaudeMcpSetupStatus: () => Promise<ClaudeMcpSetupStatus>
  installClaudeMcp: () => Promise<ClaudeMcpSetupStatus>
  getAgentUsage: () => Promise<AgentUsageSummary>
  getAgentAccountUsage: (provider: AgentProvider) => Promise<AgentAccountUsage>
  listAgentTrace: () => Promise<AgentTraceEvent[]>
  getAppIcons: (bundleIds: string[]) => Promise<Record<string, string>>
  listInstalledApps: () => Promise<InstalledApp[]>
  getUpdateState: () => Promise<UpdateState>
  onUpdateState: (listener: (state: UpdateState) => void) => () => void
  checkForUpdate: () => Promise<UpdateState>
  downloadUpdate: () => Promise<UpdateState>
  restartToUpdate: () => Promise<void>
}

export const CHANNELS = {
  reportRendererError: 'remember:error-reporting:renderer-error',
  getUserName: 'remember:get-user-name',
  getState: 'remember:get-state',
  stateChanged: 'remember:state-changed',
  recordingAudioLevel: 'remember:recording-audio-level',
  listDays: 'remember:list-days',
  searchDays: 'remember:search-days',
  getDayRevision: 'remember:get-day-revision',
  listDaySnapshot: 'remember:list-day-snapshot',
  daysChanged: 'remember:days-changed',
  memoryChanged: 'remember:memory-changed',
  listWorkItems: 'remember:work-items:list',
  createWorkItem: 'remember:work-items:create',
  updateWorkItem: 'remember:work-items:update',
  updateWorkItemMetadata: 'remember:work-items:update-metadata',
  setWorkItemLifecycle: 'remember:work-items:set-lifecycle',
  recordWorkItemAgentSession: 'remember:work-items:record-agent-session',
  startWorkItemAgentSession: 'remember:work-items:start-agent-session',
  finishWorkItemAgentSession: 'remember:work-items:finish-agent-session',
  failWorkItemAgentSession: 'remember:work-items:fail-agent-session',
  prepareModel: 'remember:prepare-model',
  pauseCapture: 'remember:pause-capture',
  resumeCapture: 'remember:resume-capture',
  startManualMeeting: 'remember:meeting:start',
  updateManualMeetingDetails: 'remember:meeting:details',
  updateManualMeetingStart: 'remember:meeting:update-start',
  pauseManualMeeting: 'remember:meeting:pause',
  resumeManualMeeting: 'remember:meeting:resume',
  stopManualMeeting: 'remember:meeting:stop',
  discardManualMeeting: 'remember:meeting:discard',
  meetingReminder: 'remember:meeting:reminder',
  clearRecentCapture: 'remember:clear-recent-capture',
  verifySystemAudio: 'remember:verify-system-audio',
  requestMicrophonePermission: 'remember:request-microphone-permission',
  requestAccessibilityPermission: 'remember:request-accessibility-permission',
  showAccessibilityPermissionGuide: 'remember:show-accessibility-permission-guide',
  getAccessibilityPermissionStatus: 'remember:get-accessibility-permission-status',
  startPermissionGuideDrag: 'remember:start-permission-guide-drag',
  closePermissionGuide: 'remember:close-permission-guide',
  openSystemAudioSettings: 'remember:open-system-audio-settings',
  openMicrophoneSettings: 'remember:open-microphone-settings',
  openAccessibilitySettings: 'remember:open-accessibility-settings',
  restartApp: 'remember:restart-app',
  revealDataFolder: 'remember:reveal-data-folder',
  getSettings: 'remember:get-settings',
  settingsChanged: 'remember:settings-changed',
  updateSettings: 'remember:update-settings',
  repairSettings: 'remember:repair-settings',
  revinoteGetStatus: 'remember:revinote:get-status',
  revinoteConnect: 'remember:revinote:connect',
  revinoteSync: 'remember:revinote:sync',
  revinoteDisconnect: 'remember:revinote:disconnect',
  revinoteStatusChanged: 'remember:revinote:status-changed',
  revinotePostProcessGetStatus: 'remember:revinote:post-process:get-status',
  revinotePostProcessConversation: 'remember:revinote:post-process:conversation',
  resetPermissionsForDevelopment: 'remember:reset-permissions-for-development',
  resetAllData: 'remember:reset-all-data',
  getCodexModels: 'remember:get-codex-models',
  checkAgent: 'remember:check-agent',
  openAgentLogin: 'remember:open-agent-login',
  logoutAgent: 'remember:logout-agent',
  contextImportPreview: 'remember:context-import:preview',
  contextImportRun: 'remember:context-import:run',
  agentLearningStatus: 'remember:agent-learning:status',
  agentLearningCheck: 'remember:agent-learning:check',
  openAgentChat: 'remember:open-agent-chat',
  listAgentProjects: 'remember:agent-projects:list',
  chooseAgentProject: 'remember:agent-projects:choose',
  getWorkItemAgentContext: 'remember:work-items:get-agent-context',
  setWorkItemAgentProject: 'remember:work-items:set-agent-project',
  getAssistantTaskActionsEnabled: 'remember:assistant:task-actions-enabled',
  getAssistantConversation: 'remember:assistant:get',
  getAssistantAttention: 'remember:assistant:attention',
  assistantAttentionChanged: 'remember:assistant:attention-changed',
  markAssistantRead: 'remember:assistant:read',
  getAssistantTaskDraft: 'remember:assistant:task-draft',
  controlAssistantTask: 'remember:assistant:task-control',
  sendAssistantMessage: 'remember:assistant:send',
  sendAssistantQueuedMessage: 'remember:assistant:send-queued',
  retryAssistantMessage: 'remember:assistant:retry',
  cancelAssistantTurn: 'remember:assistant:cancel',
  assistantChanged: 'remember:assistant:changed',
  setAssistantComposing: 'remember:assistant:composing',
  dismissAssistantInitiative: 'remember:assistant:dismiss-initiative',
  previewAssistantBriefingGrant: 'remember:assistant:briefing:preview-grant',
  confirmAssistantBriefingGrant: 'remember:assistant:briefing:confirm-grant',
  revokeAssistantBriefingGrant: 'remember:assistant:briefing:revoke-grant',
  controlAssistantBriefing: 'remember:assistant:briefing:control',
  openAssistantBriefing: 'remember:assistant:briefing:open',

  runAgentTurn: 'remember:run-agent-turn',
  getAgentInteractions: 'remember:agent-interactions:get',
  answerAgentInteraction: 'remember:agent-interactions:answer',
  agentInteractionsChanged: 'remember:agent-interactions:changed',
  cancelAgentTurn: 'remember:agent-turn:cancel',
  agentTurnUpdate: 'remember:agent-turn-update',
  refreshDay: 'remember:refresh-day',
  updateTimelineItem: 'remember:timeline:update-item',
  hideTimelineItem: 'remember:timeline:hide-item',
  showHiddenTimelineItems: 'remember:timeline:show-hidden-items',
  addTimelineItemToWiki: 'remember:timeline:add-to-wiki',
  getConversationAudioUrl: 'remember:get-conversation-audio-url',
  saveConversationAudio: 'remember:save-conversation-audio',
  setConversationAudioPlayback: 'remember:set-conversation-audio-playback',
  deleteConversation: 'remember:delete-conversation',
  mergeConversations: 'remember:merge-conversations',
  recoverConversation: 'remember:recover-conversation',
  recoverAudio: 'remember:recover-audio',
  dismissConversationCandidate: 'remember:dismiss-conversation-candidate',
  deleteDay: 'remember:delete-day',
  getWikiOverview: 'remember:wiki:get-overview',
  createLocalWikiSpace: 'remember:wiki:local:create-space',
  removeLocalWikiSpace: 'remember:wiki:local:remove-space',
  updateWikiSpace: 'remember:wiki:update-space',
  reorderWikiSpaces: 'remember:wiki:reorder-spaces',
  listWikiPages: 'remember:list-wiki-pages',
  createWikiPage: 'remember:create-wiki-page',
  saveWikiPage: 'remember:save-wiki-page',
  deleteWikiPage: 'remember:delete-wiki-page',
  getWikiPageHistory: 'remember:wiki:page:history',
  restoreWikiPageRevision: 'remember:wiki:page:restore',
  undoWikiLearning: 'remember:wiki:page:undo-learning',
  moveWikiProject: 'remember:wiki:project:move',
  applyKnowledgeSuggestion: 'remember:wiki:suggestion:apply',
  dismissKnowledgeSuggestion: 'remember:wiki:suggestion:dismiss',
  cliGetSetupStatus: 'remember:cli:get-setup-status',
  cliInstall: 'remember:cli:install',
  claudeMcpGetSetupStatus: 'remember:claude-mcp:get-setup-status',
  claudeMcpInstall: 'remember:claude-mcp:install',
  getAgentUsage: 'remember:agent-usage:get',
  getAgentAccountUsage: 'remember:agent-account-usage:get',
  listAgentTrace: 'remember:agent-trace:list',
  getAppIcons: 'remember:get-app-icons',
  listInstalledApps: 'remember:list-installed-apps',
  updateGetState: 'remember:update:get-state',
  updateStateChanged: 'remember:update:state-changed',
  updateCheck: 'remember:update:check',
  updateDownload: 'remember:update:download',
  updateRestart: 'remember:update:restart',
  dailyReviewGetState: 'remember:get-state',
  dailyReviewStateChanged: 'remember:state-changed',
  dailyReviewListSessions: 'remember:list-days',
  dailyReviewSessionsChanged: 'remember:days-changed',
  dailyReviewPrepare: 'remember:prepare-model',
  dailyReviewPause: 'remember:pause-capture',
  dailyReviewResume: 'remember:resume-capture',
  dailyReviewVerifySystemAudio: 'remember:verify-system-audio',
  dailyReviewRequestMicrophonePermission: 'remember:request-microphone-permission',
  dailyReviewRequestContextPermissions: 'remember:request-accessibility-permission',
  dailyReviewOpenSystemAudioSettings: 'remember:open-system-audio-settings',
  dailyReviewOpenMicrophoneSettings: 'remember:open-microphone-settings',
  dailyReviewOpenAccessibilitySettings: 'remember:open-accessibility-settings',
  dailyReviewOpenInputMonitoringSettings: 'remember:open-input-monitoring-settings',
  dailyReviewRestartApp: 'remember:restart-app',
  dailyReviewRefresh: 'remember:refresh-day',
  dailyReviewDeleteSession: 'remember:delete-day',
  dailyReviewListWikiPages: 'remember:list-wiki-pages',
} as const
