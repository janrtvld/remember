import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { setImmediate as yieldToMainLoop } from 'node:timers/promises'
import {
  type AgentSetup,
  type AgentTraceDiagnostic,
  type CapturePauseInput,
  type CapturePauseSource,
  CHANNELS,
  type ConversationEpisode,
  type ConversationSummary,
  contextMomentReference,
  conversationActionPointItems,
  conversationReference,
  type DailyReviewContextMoment,
  type DailyReviewContextPermissionStatus,
  type DailyReviewMoment,
  type DailyReviewSession,
  type DailyReviewSource,
  type DailyReviewState,
  type DayRefreshReason,
  getCaptureScheduleStatus,
  hasCompletedOnboarding,
  type ManualMeeting,
  type ManualMeetingDetails,
  prepareRememberSearch,
  type RememberSearchResults,
  redactSensitiveCaptureText,
  resolveConversationReference,
  type ScreenPermissionStatus,
  type SpeechSegment,
  searchRemember,
} from '@remember/shared'
import {
  app,
  type BrowserWindow,
  dialog,
  ipcMain,
  Notification,
  powerMonitor,
  shell,
  systemPreferences,
} from 'electron'
import { checkAgent } from '../agent'
import { agentActivityEvidence } from '../agentActivityEvidence'
import { buildWorkItemAgentContext } from '../agentKnowledgeContext'
import { getAgentLearningPolicyToken, latestAgentLearningEventAt, readAgentLearningEvents } from '../agentLearning'
import { recordAgentTrace, recoverInterruptedAgentTrace } from '../agentTraceRepository'
import { captureScheduleAction } from '../captureSchedulePolicy'
import { getCodexModels } from '../codexModels'
import { exportConversationAudio } from '../conversationAudioExport'
import { subscribeDictationHistoryChanges } from '../dictation/historySource'
import { reportAgentFailure, reportAppError } from '../errorReporting'
import { isExcludedContext } from '../exclusions'
import { isOfflineMode, OFFLINE_MODE_ERROR, requireNetworkAccess } from '../networkAccess'
import { selectAgentTasks, selectProactiveSources } from '../residentAgentPrivacy'
import {
  deliverProactiveInitiative,
  getDeliveredProactiveInitiative,
  getProactiveBriefingCandidateSourceIds,
  getProactiveConversationAttention,
  getProactiveConversationState,
  subscribeProactiveConversationChanges,
} from '../residentProactive'
import {
  fetchRevinoteConversationAudio,
  getFailedRevinotePostProcesses,
  getImportedRevinoteMeetings,
  getRevinoteConnectionStatus,
  getRevinotePostProcessSubmissions,
  postProcessConversationWithRevinote,
  syncRevinote,
} from '../revinoteIntegration'
import { mergeRevinoteMeetings, type RevinoteSourceWindow } from '../revinoteMeetings'
import { changedRevinoteMeetingIds } from '../revinoteSyncState'
import {
  getInterfaceLocale,
  getSettings,
  getSettingsHealth,
  subscribeSettingsChanges,
  updateSettings,
} from '../settings'
import {
  downloadModel,
  downloadProgress,
  isModelDownloaded,
  modelPreparationPhase,
  subscribeModelPreparation,
} from '../voiceNotes/models'
import {
  flushTranscriptionStream,
  subscribeTranscriptionInterruptions,
  type TranscriptionResult,
  transcribeWav,
  warmTranscriber,
} from '../voiceNotes/transcribe'
import { subscribeWikiContentChanges } from '../wikiContextEvents'
import { closeWikiHistoryStore } from '../wikiHistoryStore'
import {
  applyKnowledgeSuggestion,
  applyKnowledgeUpdatesByProject,
  createLocalWikiSpace,
  createWikiPage,
  deleteWikiPage,
  dismissKnowledgeSuggestion,
  getWikiOverview,
  getWikiPageHistoryForSpace,
  listWikiPages,
  moveWikiProject,
  removeLocalWikiSpace,
  reorderWikiSpaces,
  restoreWikiPageRevision,
  saveWikiPage,
  undoWikiLearning,
  updateWikiSpace,
  wikiPagesForAnalysis,
} from '../wikiSpaceStore'
import {
  ACTIVE_DURATION_IDLE_LIMIT_MS,
  type ActiveInterval,
  activeUntil,
  checkpointActiveDuration as checkpointActiveDurationClock,
  creditActiveInterval,
  currentActiveDuration,
} from './activeDuration'
import { agentErrorDetail, classifyAgentError } from './agentErrors'
import { shutdownAgentProcesses } from './agentProcessLifecycle'
import { agentContextUsed, memoryInsights } from './agentRunTrace'
import type { AmbientEvidenceKind } from './ambientTaskStore'
import { createAmbientTaskAuthority } from './ambientTaskWorker'
import { generateDayMemory, generateTimelineWikiUpdate } from './analyzer'
import {
  ConversationAudioPlaybackCoordinator,
  modelPreparationFailureState,
  modelPreparationStartState,
  nextAudioEngineToStart,
  shouldRunAudioEngines as shouldRunAudioEnginesForState,
} from './audioCapturePolicy'
import { resolvedAudioMoment } from './audioTranscription'
import {
  automaticRevinoteCandidates,
  automaticRevinoteFailureReport,
  failedAutomaticRevinoteConversation,
  isTerminalAutomaticRevinoteError,
  preserveAutomaticRevinoteExclusions,
  routeNewFinishedConversationsToRevinote,
} from './automaticRevinoteProcessing'
import { detectCallSurface } from './callSurfaces'
import {
  type ContextCaptureEvent,
  isContextCaptureAvailable,
  readContextPermissions,
  startContextCapture,
  stopContextCapture,
} from './context'
import { isPassiveContext } from './contextActivity'
import { isContextCaptureStale, shouldMonitorContextCapture } from './contextCaptureHealth'
import { ContextSnapshotCompactor } from './contextCompaction'
import {
  conversationAudioChunkPathAt,
  conversationAudioDurationSecondsAt,
  conversationAudioPathAt,
  mergeConversationAudioAt,
  pruneResolvedConversationChunksAt,
  removeConversationAudioForEpisodeAt,
  removeConversationAudioForWorkdayAt,
  removeConversationAudioSinceAt,
  renderConversationAudioAsyncAt,
  renderConversationAudioAt,
  saveConversationAudioChunkAt,
} from './conversationAudio'
import { conversationEpisodeCompletedAt, deriveConversationEpisodes } from './conversationEpisodes'
import { attachConfirmedConversationParticipants } from './conversationParticipant'
import {
  deleteDayMemoryConversation,
  matchesDeletedConversation,
  reconcileEpisodeConversationSummaries,
  reconcileLivingConversations,
} from './conversationReconciliation'
import { createDayAnalysisValidationScope, withDayAnalysisProvenanceValidation } from './dayAnalysisProvenance'
import { localDayKey, nextLocalDayBoundary, sessionForCaptureStart } from './dayLifecycle'
import {
  completedEvidenceThrough,
  frequentRefreshIntervalMs,
  hasPendingDayWikiReview,
  lastRefreshAttemptAt,
  nextDayWithPendingWikiReview,
  shouldRefreshDuringDowntime,
  shouldRefreshDuringFrequentInterval,
} from './dayRefreshPolicy'
import { createDayRefreshQueue } from './dayRefreshQueue'
import { createDaySnapshotPublisher } from './daySnapshotPublisher'
import {
  clearTemporaryCapture,
  closeEvidenceStore,
  dailyReviewDirectory,
  getEvidenceStore,
  removeTemporaryCaptureFile,
} from './evidenceRepository'
import {
  applyManagedKnowledgeUpdates,
  initializeKnowledgeStore,
  listKnowledgePages,
  removeKnowledgeForSession,
} from './knowledgeStore'
import {
  manualMeetingAudioReadinessError,
  manualMeetingAudioStreamsReady,
  manualMeetingAvailableFromAt,
  manualMeetingEpisode,
  manualMeetingForConversation,
  manualMeetingRecordingSource,
  manualMeetingStillProcessing,
  manualMeetingTitle,
  memoryWithFinishedManualMeetingConversation,
  memoryWithManualMeetingConversation,
  preserveManualMeetingConversations,
  selectManualMeetingProcessingProvider,
  waitForManualMeetingAudioReadiness,
} from './manualMeetingLifecycle'
import { readMediaPlayback } from './mediaPlayback'
import { shouldShowMeetingReminder } from './meetingReminder'
import {
  type MicrophoneCaptureHandle,
  startMicrophoneAudioCapture,
  stopMicrophoneAudioCapture,
} from './microphoneAudio'
import { shouldTranscribeSystemAudio } from './musicDetection'
import { analyzeProactiveContext } from './proactiveAnalysis'
import { proactiveModelForCatalog } from './proactivePolicy'
import { proactiveReviewMode, proactiveSourceAdmission } from './proactiveSourceAdmission'
import type { ProactiveSourceKind } from './proactiveStore'
import { createProactiveWorker } from './proactiveWorker'
import { createQaAudioFixture } from './qaAudioFixture'
import { CONVERSATION_RECOVERY_RETENTION_MS, projectDailyReviewSessions } from './sessionProjection'
import {
  audioDirectory,
  contextDirectory,
  readSessions,
  recoverInterruptedSessions,
  removeStoredSession,
  saveAudioChunk,
  writeSession,
  writeSessions,
} from './store'
import { startSystemAudioCapture, stopSystemAudioCapture, verifySystemAudioCapture } from './systemAudio'
import { consumeTemporaryCaptureFile } from './temporaryCapture'
import { writeTimelineArtifacts } from './timelineArtifact'
import {
  hideTimelineMemoryItem,
  reconcileTimelineItems,
  showHiddenTimelineMemoryItems,
  updateTimelineMemoryItem,
} from './timelineItems'

const CHUNK_DURATION_MS = 10_000
const captureChunkDuration = () =>
  manualMeetingStarting || manualMeeting?.status === 'recording' ? 2_000 : CHUNK_DURATION_MS
const QA_SYNTHETIC_ACTIVE_LEVEL = 0.004
const DAY_ROLLOVER_DELAY_MS = 1_000
const SYSTEM_AUDIO_RESTART_DELAYS_MS = [1_000, 5_000, 15_000, 30_000, 60_000] as const
const CONTEXT_PERSIST_DELAY_MS = 10_000
const CONTEXT_HEALTH_CHECK_MS = 15_000
const CONTEXT_STALE_AFTER_MS = 45_000
const SCHEDULE_HEARTBEAT_MS = 60_000
const DOWNTIME_CHECK_INTERVAL_MS = 60_000
const DOWNTIME_IDLE_SECONDS = 10 * 60
const DOWNTIME_SPEECH_SILENCE_MS = 4 * 60_000
const MIN_NEW_EVIDENCE_MS = 15 * 60_000
const ALL_CAPTURE_PAUSE_SOURCES = ['audio', 'capture'] as const satisfies readonly CapturePauseSource[]

let getMainWindow: () => BrowserWindow | null = () => null
const daySnapshotPublisher = createDaySnapshotPublisher((changes) => {
  const window = getMainWindow()
  if (window && !window.isDestroyed()) window.webContents.send(CHANNELS.daysChanged, changes)
})
let sessions: DailyReviewSession[] = []
let status: DailyReviewState['status'] = 'idle'
let activeSessionId: string | null = null
let startedAt: number | null = null
let activeStartedAt: number | null = null
let activeDurationMs = 0
let errorCode: string | null = null
let transcriptionQueue = Promise.resolve()
const pendingAudioFiles = new Map<string, { sessionId: string; path: string }>()
let stoppedAudioFinalization: Promise<void> | null = null
let stopWatchdog: ReturnType<typeof setTimeout> | null = null
let dayRolloverTimer: ReturnType<typeof setTimeout> | null = null
let pendingEndOfDayRefreshId: string | null = null
let contextCaptureProcess: ChildProcessWithoutNullStreams | null = null
let contextCaptureHealth: DailyReviewState['contextCaptureHealth'] = 'inactive'
let contextCaptureLastEventAt: number | null = null
let contextCaptureStartedAt: number | null = null
let contextCaptureRestartTimer: ReturnType<typeof setTimeout> | null = null
let contextCaptureHealthTimer: ReturnType<typeof setInterval> | null = null
let systemAudioCaptureProcess: ChildProcessWithoutNullStreams | null = null
let systemAudioReady = false
let microphoneAudioCaptureProcess: MicrophoneCaptureHandle | null = null
let systemAudioRestartTimer: ReturnType<typeof setTimeout> | null = null
let systemAudioRestartAttempts = 0
let microphoneRestartTimer: ReturnType<typeof setTimeout> | null = null
let microphoneRestartAttempts = 0
let accessibilityPermission: DailyReviewContextPermissionStatus = 'unknown'
let inputMonitoringPermission: DailyReviewContextPermissionStatus = 'unknown'
let contextPermissionsInitialized = false
let restartRequired = false
let microphonePermissionAtLaunch: ScreenPermissionStatus = 'unknown'
let systemAudioCheckStatus: DailyReviewState['systemAudioCheckStatus'] = 'unchecked'
let systemAudioCheckError: string | null = null
let microphoneName: string | null = null
let microphoneLastChunkAt: number | null = null
let dictationOwnsMicrophone = false
let deferredPersistTimer: ReturnType<typeof setTimeout> | null = null
let automaticCapturePromise: Promise<void> | null = null
let modelPreparationPromise: Promise<void> | null = null
let removeModelPreparationListener: (() => void) | null = null
let removeTranscriptionInterruptionListener: (() => void) | null = null
let pausedAudioFinalizationVersion = 0
let pausedAudioFinalization: Promise<void> = Promise.resolve()
let timedResumeTimer: ReturnType<typeof setTimeout> | null = null
let captureScheduleTimer: ReturnType<typeof setTimeout> | null = null
let captureAllowed = () => true
let downtimeRefreshTimer: ReturnType<typeof setInterval> | null = null
let lastMeaningfulSpeechAt = 0
let pendingAutomaticDayRefresh: Promise<void> | null = null
const conversationAudioPlayback = new ConversationAudioPlaybackCoordinator(
  async () => {
    const captureProcesses = [microphoneAudioCaptureProcess, systemAudioCaptureProcess]
    stopMicrophoneEngine()
    stopSystemAudioEngine()
    await Promise.all(captureProcesses.map((child) => waitForCaptureProcess(child)))
  },
  () => {
    if (status === 'recording' && activeSessionId) reconcileSourceEngines()
  }
)
const conversationAudioPlaybackSenderCleanupIds = new Set<number>()
let manualMeeting: DailyReviewState['manualMeeting'] = null
let manualMeetingStarting = false
let manualMeetingDiscarding = false
let manualMeetingProcessingQueue = Promise.resolve()
const manualMeetingAudioPreparations = new Map<string, Promise<ManualMeeting | null>>()
let daySearchSequence = 0
let searchEvidenceRevision = -1
let searchEvidenceDays = new Map<string, { source: DailyReviewSession; hydrated: DailyReviewSession }>()
const daySearchRequests = new Map<number, number>()
let automaticRevinoteProcessingQueue = Promise.resolve()
const automaticRevinoteSubmissions = new Map<string, Promise<boolean>>()
let restorePauseAfterManualMeeting = false
let isDisposing = false
let isDisposed = false
const deferredSessionIds = new Set<string>()
const speechActivityIntervals = new Map<string, ActiveInterval[]>()
const contextCompactor = new ContextSnapshotCompactor()
let agentSetup: DailyReviewState['agent'] = {
  provider: 'codex',
  status: 'checking',
  executable: null,
  detail: null,
}
const dayRefreshQueue = createDayRefreshQueue(performDayRefresh)
let dataDeletionEpoch = 0
const sessionDeletionEpochs = new Map<string, number>()
const regeneratingMergedConversationDayIds = new Set<string>()
const stateListeners = new Set<(state: DailyReviewState) => void>()
const meetingReminderShownAt = new Map<string, number>()
const activeMeetingReminderNotifications = new Set<Notification>()
const revinoteActionVersions = new Map<string, string>()
function maybeShowMeetingReminder(surface: { surfaceKey: string; state: 'active' | 'ended' }) {
  const now = Date.now()
  const lastShownAt = meetingReminderShownAt.get(surface.surfaceKey) ?? 0
  if (
    !shouldShowMeetingReminder({
      surfaceState: surface.state,
      automaticAudioCaptureEnabled: getSettings().audioCaptureEnabled,
      manualMeetingRecording: isManualMeetingRecording(),
      notificationSupported: Notification.isSupported(),
      lastShownAt,
      now,
    })
  ) {
    return
  }
  meetingReminderShownAt.set(surface.surfaceKey, now)
  const dutch = getInterfaceLocale().startsWith('nl')
  const notification = new Notification({
    title: dutch ? 'Meeting opnemen?' : 'Record this meeting?',
    body: dutch
      ? 'Remember herkent een actief gesprek. Open Remember om de opname te starten.'
      : 'Remember detected an active call. Open Remember to start recording.',
    silent: true,
  })
  notification.on('click', () => {
    const window = getMainWindow()
    if (!window || window.isDestroyed()) return
    window.show()
    window.focus()
    window.webContents.send(CHANNELS.meetingReminder)
  })
  notification.on('close', () => activeMeetingReminderNotifications.delete(notification))
  activeMeetingReminderNotifications.add(notification)
  notification.show()
}

function clearStopWatchdog(): void {
  if (!stopWatchdog) return
  clearTimeout(stopWatchdog)
  stopWatchdog = null
}

function clearDayRolloverTimer(): void {
  if (!dayRolloverTimer) return
  clearTimeout(dayRolloverTimer)
  dayRolloverTimer = null
}

function clearTimedResumeTimer(): void {
  if (!timedResumeTimer) return
  clearTimeout(timedResumeTimer)
  timedResumeTimer = null
}

function manualPauseSources(settings = getSettings()): CapturePauseSource[] {
  return settings.capturePaused ? settings.capturePauseSources : []
}

function isManualMeetingRecording() {
  return manualMeeting?.status === 'recording' || manualMeetingStarting
}

function isManualMeetingPaused() {
  return manualMeeting?.status === 'recording' && manualMeeting.pausedAt != null
}

function isManualMeetingActivelyCapturing() {
  return isManualMeetingRecording() && !isManualMeetingPaused()
}

function usesQaSyntheticManualAudio() {
  return (
    !app.isPackaged &&
    process.env.REMEMBER_QA_SYNTHETIC_AUDIO === '1' &&
    (manualMeetingStarting || isManualMeetingActivelyCapturing())
  )
}

function isSourcePaused(source: CapturePauseSource, settings = getSettings()): boolean {
  if (source === 'audio' && isManualMeetingPaused()) return true
  if (source === 'audio' && isManualMeetingActivelyCapturing()) return false
  return manualPauseSources(settings).includes(source)
}

function areAllSourcesPaused(settings = getSettings()): boolean {
  const sources = manualPauseSources(settings)
  return ALL_CAPTURE_PAUSE_SOURCES.every((source) => sources.includes(source))
}

function clearCaptureScheduleTimer(): void {
  if (!captureScheduleTimer) return
  clearTimeout(captureScheduleTimer)
  captureScheduleTimer = null
}

function scheduleCaptureCheck(): void {
  clearCaptureScheduleTimer()
  const { nextTransitionAt } = getCaptureScheduleStatus(getSettings().captureSchedule)
  const transitionDelay = nextTransitionAt == null ? SCHEDULE_HEARTBEAT_MS : nextTransitionAt - Date.now() + 250
  captureScheduleTimer = setTimeout(
    () => {
      captureScheduleTimer = null
      void reconcileCaptureSchedule()
    },
    Math.max(1_000, Math.min(SCHEDULE_HEARTBEAT_MS, transitionDelay))
  )
}

function scheduleTimedResume(pausedUntil: number | null): void {
  clearTimedResumeTimer()
  if (pausedUntil == null) return
  const delay = Math.max(0, pausedUntil - Date.now())
  timedResumeTimer = setTimeout(() => {
    timedResumeTimer = null
    const settings = getSettings()
    if (!settings.capturePaused || settings.capturePausedUntil !== pausedUntil) return
    void resumeAllCapture()
  }, delay)
}

function scheduleDayRollover(): void {
  clearDayRolloverTimer()
  const delay = Math.max(1_000, nextLocalDayBoundary() - Date.now() + DAY_ROLLOVER_DELAY_MS)
  dayRolloverTimer = setTimeout(() => {
    dayRolloverTimer = null
    rolloverWorkday()
  }, delay)
}

function screenPermissionStatus(): ScreenPermissionStatus {
  if (process.platform !== 'darwin' || systemAudioCheckStatus === 'ready') return 'granted'
  return systemAudioCheckStatus === 'failed' ? 'unknown' : 'not-determined'
}

function microphonePermissionStatus(): ScreenPermissionStatus {
  if (process.platform !== 'darwin') return 'granted'
  const permission = systemPreferences.getMediaAccessStatus('microphone')
  switch (permission) {
    case 'granted':
    case 'denied':
    case 'restricted':
    case 'not-determined':
      return permission
    default:
      return 'unknown'
  }
}

function buildState(): DailyReviewState {
  const settings = getSettings()
  const scheduleStatus = getCaptureScheduleStatus(settings.captureSchedule)
  return {
    status,
    pauseReason: status === 'paused' ? (areAllSourcesPaused(settings) ? 'manual' : 'schedule') : null,
    pausedSources: status === 'paused' ? [...ALL_CAPTURE_PAUSE_SOURCES] : manualPauseSources(settings),
    nextScheduleTransitionAt: scheduleStatus.nextTransitionAt,
    activeSessionId,
    startedAt,
    activeStartedAt,
    activeDurationMs,
    manualMeeting,
    modelDownloaded: isModelDownloaded(),
    modelDownloadProgress: downloadProgress(),
    modelPreparationPhase: modelPreparationPhase(),
    systemAudioPermission: screenPermissionStatus(),
    microphonePermission: microphonePermissionStatus(),
    microphoneName,
    microphoneLastChunkAt,
    systemAudioCheckStatus,
    systemAudioCheckError,
    permissionsResolved: contextPermissionsInitialized,
    appActivityStatus:
      process.platform !== 'darwin' ? 'unsupported' : isContextCaptureAvailable() ? 'available' : 'unavailable',
    contextCaptureStatus:
      process.platform !== 'darwin' ? 'unsupported' : isContextCaptureAvailable() ? 'available' : 'unavailable',
    contextCaptureHealth,
    contextCaptureLastEventAt,
    settingsHealth: getSettingsHealth(),
    accessibilityPermission,
    inputMonitoringPermission,
    restartRequired,
    agent: agentSetup,
    claudeCliAvailable: agentSetup.provider === 'claude' && agentSetup.status === 'ready',
    error: errorCode,
  }
}

function hasRequiredPermissions(): boolean {
  const settings = getSettings()
  const audioRequested = settings.audioCaptureEnabled || isManualMeetingRecording()
  return (
    accessibilityPermission === 'granted' &&
    !restartRequired &&
    (!audioRequested ||
      (microphonePermissionStatus() === 'granted' &&
        (systemAudioCheckStatus === 'ready' || manualMeetingStarting || isManualMeetingActivelyCapturing())))
  )
}

function canRunAudioCapture(): boolean {
  const settings = getSettings()
  return (
    !isDisposing &&
    !isDisposed &&
    !manualMeetingDiscarding &&
    (settings.audioCaptureEnabled || isManualMeetingActivelyCapturing()) &&
    isModelDownloaded() &&
    microphonePermissionStatus() === 'granted' &&
    !restartRequired &&
    (systemAudioCheckStatus === 'ready' || manualMeetingStarting || isManualMeetingActivelyCapturing())
  )
}

function shouldRunAudioEngines(): boolean {
  return shouldRunAudioEnginesForState({
    canRunAudioCapture: canRunAudioCapture(),
    conversationAudioPlaybackActive: conversationAudioPlayback.active,
  })
}

async function refreshAgentStatus(): Promise<void> {
  agentSetup = await checkAgent()
}

async function refreshPermissionStatuses(): Promise<void> {
  const wasInitialized = contextPermissionsInitialized
  const previousAccessibility = accessibilityPermission
  const permissions = await readContextPermissions()
  accessibilityPermission = permissions.accessibility
  inputMonitoringPermission = permissions.inputMonitoring
  contextPermissionsInitialized = true

  if (
    (wasInitialized && previousAccessibility !== 'granted' && accessibilityPermission === 'granted') ||
    (microphonePermissionAtLaunch !== 'granted' && microphonePermissionStatus() === 'granted')
  ) {
    restartRequired = true
  }

  if (microphonePermissionStatus() !== 'granted' || restartRequired) {
    systemAudioCheckStatus = 'unchecked'
    systemAudioCheckError = null
    microphoneName = null
  }

  if (hasRequiredPermissions() && errorCode?.endsWith('-permission')) {
    status = 'idle'
    errorCode = null
  }
}

function emitState(): void {
  const state = buildState()
  for (const listener of stateListeners) listener(state)
  const window = getMainWindow()
  if (window && !window.isDestroyed()) window.webContents.send(CHANNELS.dailyReviewStateChanged, state)
}

function emitSessions(): void {
  daySnapshotPublisher.update(projectedSessions())
}

let ambientTaskWorker: ReturnType<typeof createProactiveWorker> | null = null
const ambientTaskAuthority = createAmbientTaskAuthority()
let unsubscribeAmbientSettings: (() => void) | null = null
let unsubscribeAmbientDeletions: (() => void) | null = null
let unsubscribeProactiveConversation: (() => void) | null = null
let unsubscribeProactiveNotes: (() => void) | null = null
let unsubscribeWikiContent: (() => void) | null = null

function usesDaySyncProactivity() {
  return (
    proactiveReviewMode({
      isPackaged: app.isPackaged,
      qaObservation: process.env.REMEMBER_QA_PROACTIVE_AGENT === '1',
      qaDaySync: process.env.REMEMBER_QA_PROACTIVE_DAY_SYNC === '1',
    }) === 'day-sync'
  )
}

function ambientSourceAllowed(kind: AmbientEvidenceKind) {
  const settings = getSettings()
  const source = kind === 'speech' ? 'audio' : 'capture'
  return (
    status === 'recording' && !isSourcePaused(source, settings) && (kind !== 'speech' || settings.audioCaptureEnabled)
  )
}

export function currentProactivePolicyToken() {
  const settings = getSettings()
  if (
    isDisposed ||
    isDisposing ||
    isOfflineMode() ||
    !settings.cloudAnalysisConsent ||
    !settings.liveTaskUpdates ||
    settings.dayAnalysisProvider !== 'codex' ||
    (!usesDaySyncProactivity() && (agentSetup.provider !== 'codex' || agentSetup.status !== 'ready'))
  )
    return null
  return JSON.stringify({
    provider: 'codex',
    policy: getAgentLearningPolicyToken(),
    deletion: dataDeletionEpoch,
    deletionRevision: getEvidenceStore().deletionRevision(),
    exclusions: [
      settings.excludePasswordManagers,
      settings.excludePrivateBrowsing,
      settings.appCaptureMode,
      settings.excludedAppBundleIds,
      settings.includedAppBundleIds,
      settings.websiteCaptureMode,
      settings.excludedWebsites,
      settings.includedWebsites,
    ],
    mode: usesDaySyncProactivity() ? 'day-sync' : 'observations',
    note: !usesDaySyncProactivity(),
    context:
      !usesDaySyncProactivity() &&
      proactiveSourceAdmission({
        kind: 'context',
        policyAvailable: true,
        captureSourceAllowed: captureAllowed() && ambientSourceAllowed('context'),
      }),
    audio: !usesDaySyncProactivity() && captureAllowed() && ambientSourceAllowed('speech'),
  })
}

function startProactiveContextWorker() {
  const store = getEvidenceStore()
  const withSourceValidation = createDayAnalysisValidationScope(store)
  ambientTaskAuthority.update(getSettings().liveTaskUpdates && !usesDaySyncProactivity())
  let reconciledGeneration: number | null = null
  ambientTaskWorker = createProactiveWorker({
    store: store.proactive,
    withSourceValidation,
    policy: currentProactivePolicyToken,
    allowed: (kind: ProactiveSourceKind) =>
      usesDaySyncProactivity()
        ? kind === 'day' && currentProactivePolicyToken() !== null
        : kind !== 'day' &&
          proactiveSourceAdmission({
            kind,
            policyAvailable: currentProactivePolicyToken() !== null,
            captureSourceAllowed: kind !== 'note' && captureAllowed() && ambientSourceAllowed(kind),
          }),
    accept: (evidence) => {
      return withSourceValidation(
        ({ settings, checks }) =>
          selectProactiveSources([evidence], store, settings, { ...checks, requireCurrent: true }).evidence.length === 1
      )
    },
    beforeBatch: () => {
      if (!usesDaySyncProactivity()) return
      if (reconciledGeneration !== store.proactive.generation() && reconcileProactiveDaySync())
        reconciledGeneration = store.proactive.generation()
      if (store.proactive.dayReviewDue()) reconcileProactiveDayReview()
    },
    items: () =>
      selectAgentTasks(store.listWorkItems(), {
        contextEvidence: (workdayId, observedAt) => store.readTaskContextEvidence(workdayId, observedAt),
        settings: getSettings(),
        provenance: store.ambientTasks,
      }),
    attention: () => {
      const state = getProactiveConversationAttention()
      return {
        ...state,
        available: state.available && agentSetup.provider === 'codex' && agentSetup.status === 'ready',
      }
    },
    conversation: () => {
      const state = getProactiveConversationState()
      return {
        ...state,
        available: state.available && agentSetup.provider === 'codex' && agentSetup.status === 'ready',
      }
    },
    analyze: async (evidence, items, conversation, signal) => {
      const model = proactiveModelForCatalog(await getCodexModels())
      signal.throwIfAborted()
      if (!model) throw new Error('proactive-model-unavailable')
      const settings = getSettings()
      const selected = withDayAnalysisProvenanceValidation(
        store,
        settings,
        (validation) =>
          selectProactiveSources(evidence, store, settings, { ...validation, requireCurrent: true }).evidence
      )
      const candidates = getProactiveBriefingCandidateSourceIds(selected).filter((id) =>
        selected.some((source) => source.evidenceId === id && source.kind !== 'note' && source.kind !== 'day')
      )
      return analyzeProactiveContext({
        model,
        agentComputer: 'local',
        evidence: selected,
        items: selected.every((source) => source.kind === 'note' || source.kind === 'day') ? [] : items,
        conversation,
        ...(selected.every((source) => source.kind === 'day')
          ? {
              followUpMemory: withDayAnalysisProvenanceValidation(store, settings, (validation) =>
                store.proactive.recentDayAssessments(
                  Date.now(),
                  (source) => selectProactiveSources([source], store, settings, validation).omittedCount === 0
                )
              ),
            }
          : {}),
        signal,
        provider: 'codex',
        locale: getInterfaceLocale(),
        now: Date.now(),
        ...(candidates.length ? { briefingCandidateSourceIds: candidates } : {}),
      })
    },
    apply: (proactiveBatch, plan, startedAt) => {
      const first = proactiveBatch.sources[0]
      if (!first) throw new Error('proactive-empty-batch')
      if (first.kind === 'note' || first.kind === 'day') {
        if (
          proactiveBatch.sources.some((source) => source.kind !== first.kind) ||
          plan.proposed.length ||
          plan.changes.length ||
          plan.notifyTitles.length ||
          proactiveBatch.decision.kind === 'prepare'
        )
          throw new Error('derived-source-task-authority-denied')
        store.proactive.commit(proactiveBatch)
        return
      }
      const result = store.applyAnalyzedWorkItems({
        workdayId: first.workdayId,
        plan,
        conversations: [],
        analysisStartedAt: startedAt,
        observedAt: proactiveBatch.decision.createdAt,
        proactiveBatch,
      })
      console.info('[proactive] decided', {
        id: proactiveBatch.decision.id,
        kind: proactiveBatch.decision.kind,
        reason: proactiveBatch.decision.reason,
        sourceCount: proactiveBatch.sources.length,
        startedAt,
        completedAt: proactiveBatch.decision.createdAt,
        ...result,
      })
    },
    deliver: deliverProactiveInitiative,
    delivered: (decision) => getDeliveredProactiveInitiative(decision.id, decision.inputHash),
    changed: emitMemoryChanged,
    error: (error) => console.error('[proactive] withheld; no automatic analysis retry', error),
  })
  unsubscribeAmbientSettings = subscribeSettingsChanges(() => {
    ambientTaskAuthority.update(getSettings().liveTaskUpdates && !usesDaySyncProactivity())
    void ambientTaskWorker?.tick()
  })
  unsubscribeAmbientDeletions = store.subscribeEvidenceDeletion(() => void ambientTaskWorker?.tick())
  unsubscribeProactiveConversation = subscribeProactiveConversationChanges(() => void ambientTaskWorker?.tick())
  const reconcileNotes = () => {
    try {
      if (!usesDaySyncProactivity()) store.proactive.reconcileNotes()
    } catch (error) {
      console.error('[proactive] Note reconciliation unavailable', error)
    }
    void ambientTaskWorker?.tick()
  }
  unsubscribeProactiveNotes = subscribeDictationHistoryChanges(reconcileNotes)
  reconcileNotes()
  ambientTaskWorker.start()
}

function reconcileProactiveDaySync(sessionId?: string) {
  if (!usesDaySyncProactivity() || currentProactivePolicyToken() === null) return false
  const store = getEvidenceStore()
  const items = selectAgentTasks(store.listWorkItems(), {
    contextEvidence: (workdayId, observedAt) => store.readTaskContextEvidence(workdayId, observedAt),
    settings: getSettings(),
    provenance: store.ambientTasks,
  })
  try {
    if (sessionId) store.proactive.reconcileDaySync(sessionId, items)
    else store.proactive.reconcileDaySyncs(items)
    return true
  } catch (error) {
    console.error('[proactive] Day sync retained; agent handoff will reconcile', error)
    return false
  }
}

function reconcileProactiveDayReview() {
  const store = getEvidenceStore()
  const items = selectAgentTasks(store.listWorkItems(), {
    contextEvidence: (workdayId, observedAt) => store.readTaskContextEvidence(workdayId, observedAt),
    settings: getSettings(),
    provenance: store.ambientTasks,
  })
  try {
    store.proactive.reconcileDayReview(items)
  } catch (error) {
    console.error('[proactive] Scheduled review retained for reconciliation', error)
  }
}

function emitMemoryChanged(): void {
  const window = getMainWindow()
  if (window && !window.isDestroyed()) window.webContents.send(CHANNELS.memoryChanged)
}

function projectedSessions(): DailyReviewSession[] {
  return projectDailyReviewSessions(sessions, getEvidenceStore(), dailyReviewDirectory())
}

function persistSessions(): void {
  writeSessions(sessions)
  emitSessions()
}

function flushDeferredSessions(): void {
  if (deferredPersistTimer) clearTimeout(deferredPersistTimer)
  deferredPersistTimer = null
  for (const sessionId of deferredSessionIds) {
    const session = sessions.find((candidate) => candidate.id === sessionId)
    if (session) writeSession(session)
  }
  if (deferredSessionIds.size > 0) emitSessions()
  deferredSessionIds.clear()
}

function updateSession(
  sessionId: string,
  update: (session: DailyReviewSession) => DailyReviewSession,
  deferred = false
): void {
  if (isDisposed) return
  let updated: DailyReviewSession | null = null
  sessions = sessions.map((session) => {
    if (session.id !== sessionId) return session
    updated = update(session)
    return updated
  })
  if (!updated) return
  if (!deferred) {
    writeSession(updated)
    emitSessions()
    return
  }
  deferredSessionIds.add(sessionId)
  if (!deferredPersistTimer) {
    deferredPersistTimer = setTimeout(flushDeferredSessions, CONTEXT_PERSIST_DELAY_MS)
  }
}

function settleActiveDuration(timestamp = Date.now(), idleSeconds = powerMonitor.getSystemIdleTime()): void {
  const clock = checkpointActiveDurationClock(
    { accumulatedMs: activeDurationMs, trackingSince: activeStartedAt },
    timestamp,
    idleSeconds
  )
  activeDurationMs = clock.accumulatedMs
  activeStartedAt = clock.trackingSince
}

function accrueActiveDuration(): void {
  settleActiveDuration()
  activeStartedAt = null
}

function syncActiveDurationIntoSession(sessionId: string): void {
  sessions = sessions.map((session) => (session.id === sessionId ? { ...session, activeDurationMs } : session))
}

function checkpointActiveDuration(
  sessionId: string,
  timestamp = Date.now(),
  idleSeconds = powerMonitor.getSystemIdleTime()
): void {
  settleActiveDuration(timestamp, idleSeconds)
  syncActiveDurationIntoSession(sessionId)
  getEvidenceStore().checkpointWorkday(sessionId, activeDurationMs)
}

function creditMeaningfulSpeechActivity(
  sessionId: string,
  chunkStartedAt: number,
  durationMs: number,
  idleSecondsAtChunkEnd: number
): void {
  if (idleSecondsAtChunkEnd * 1_000 < ACTIVE_DURATION_IDLE_LIMIT_MS) return
  const chunkEndedAt = chunkStartedAt + durationMs
  const interval = {
    startedAt: Math.max(chunkStartedAt, activeUntil(chunkEndedAt, idleSecondsAtChunkEnd)),
    endedAt: chunkEndedAt,
  }
  const credited = creditActiveInterval(speechActivityIntervals.get(sessionId) ?? [], interval)
  speechActivityIntervals.set(sessionId, credited.intervals)
  if (credited.addedMs <= 0) return

  if (sessionId === activeSessionId) {
    activeDurationMs += credited.addedMs
    syncActiveDurationIntoSession(sessionId)
    getEvidenceStore().checkpointWorkday(sessionId, activeDurationMs)
    emitState()
    return
  }
  updateSession(sessionId, (session) => ({
    ...session,
    activeDurationMs: session.activeDurationMs + credited.addedMs,
  }))
}

function handleContext(event: ContextCaptureEvent): void {
  if (!activeSessionId || status !== 'recording') return
  contextCaptureLastEventAt = event.timestamp
  if (contextCaptureHealth !== 'healthy') {
    contextCaptureHealth = 'healthy'
    emitState()
  }
  const sanitizedEvent: ContextCaptureEvent = {
    ...event,
    windowTitle: redactSensitiveCaptureText(event.windowTitle),
    text: redactSensitiveCaptureText(event.text),
    url: redactSensitiveCaptureText(event.url ?? ''),
    focusedElement: event.focusedElement
      ? {
          ...event.focusedElement,
          title: redactSensitiveCaptureText(event.focusedElement.title),
          description: redactSensitiveCaptureText(event.focusedElement.description),
          value: redactSensitiveCaptureText(event.focusedElement.value),
        }
      : undefined,
  }
  if (isExcludedContext(sanitizedEvent, getSettings())) {
    closeCurrentAppActivity(event.timestamp)
    return
  }
  const passiveContext = isPassiveContext(sanitizedEvent)
  if (passiveContext) closeCurrentAppActivity(event.timestamp)
  const compactedEvent = contextCompactor.compact(sanitizedEvent)
  if (!compactedEvent) return
  checkpointActiveDuration(activeSessionId, compactedEvent.timestamp)

  updateSession(
    activeSessionId,
    (session) => {
      const { bundleId, ...capturedContext } = compactedEvent
      const context: DailyReviewContextMoment = { id: randomUUID(), bundleId, ...capturedContext }
      const reference = contextMomentReference(context)
      const detectedCallSurface = detectCallSurface(context)
      if (detectedCallSurface) {
        maybeShowMeetingReminder(detectedCallSurface)
        getEvidenceStore().appendCallSignal({
          id: `call-signal:${context.id}`,
          workdayId: session.id,
          observedAt: context.timestamp,
          ...detectedCallSurface,
        })
      }
      if (passiveContext) {
        getEvidenceStore().appendContextMoment(session.id, context, null, bundleId)
        return { ...session, contextMoments: [...session.contextMoments, reference] }
      }
      const current = session.appActivity.at(-1)
      if (
        current &&
        current.endedAt == null &&
        current.appName === compactedEvent.appName &&
        current.bundleId === bundleId
      ) {
        getEvidenceStore().appendContextMoment(session.id, context, current.id, bundleId)
        return { ...session, contextMoments: [...session.contextMoments, reference] }
      }

      const closedActivity =
        current && current.endedAt == null
          ? session.appActivity.map((activity, index) =>
              index === session.appActivity.length - 1
                ? { ...activity, endedAt: Math.max(activity.startedAt, compactedEvent.timestamp) }
                : activity
            )
          : session.appActivity
      const activity = {
        id: randomUUID(),
        appName: compactedEvent.appName,
        bundleId,
        startedAt: compactedEvent.timestamp,
        endedAt: null,
      }
      const closedCurrent = closedActivity.at(-1)
      if (closedCurrent) getEvidenceStore().upsertAppActivity(session.id, closedCurrent)
      getEvidenceStore().upsertAppActivity(session.id, activity)
      getEvidenceStore().appendContextMoment(session.id, context, activity.id, bundleId)

      return {
        ...session,
        appActivity: [...closedActivity, activity],
        contextMoments: [...session.contextMoments, reference],
      }
    },
    true
  )
}

function closeCurrentAppActivity(endedAt = Date.now()): void {
  if (!activeSessionId) return
  updateSession(activeSessionId, (session) => {
    const appActivity = session.appActivity.map((activity, index) =>
      index === session.appActivity.length - 1 && activity.endedAt == null
        ? { ...activity, endedAt: Math.max(activity.startedAt, endedAt) }
        : activity
    )
    const current = appActivity.at(-1)
    if (current) getEvidenceStore().upsertAppActivity(session.id, current)
    return { ...session, appActivity }
  })
}

function clearContextCaptureRestart(): void {
  if (!contextCaptureRestartTimer) return
  clearTimeout(contextCaptureRestartTimer)
  contextCaptureRestartTimer = null
}

function scheduleContextCaptureRestart(code: string, message: string): void {
  if (!activeSessionId || status !== 'recording' || isSourcePaused('capture') || contextCaptureRestartTimer) return
  console.warn(`[daily-review] context capture interrupted (${code}); reconnecting:`, message)
  const previousProcess = contextCaptureProcess
  contextCaptureProcess = null
  stopContextCapture(previousProcess)
  contextCaptureHealth = 'reconnecting'
  contextCaptureStartedAt = null
  if (code === 'accessibility-permission') {
    accessibilityPermission = 'denied'
    contextCaptureHealth = 'inactive'
    errorCode = 'accessibility-permission'
    emitState()
    return
  }
  emitState()
  contextCaptureRestartTimer = setTimeout(() => {
    contextCaptureRestartTimer = null
    if (!activeSessionId || status !== 'recording' || isSourcePaused('capture')) return
    if (!startContextEngine(true))
      scheduleContextCaptureRestart('context-capture-unavailable', 'Native helper unavailable')
  }, 1_000)
}

function startContextEngine(reconnecting = false): boolean {
  if (!activeSessionId) return false
  if (isSourcePaused('capture')) return true
  clearContextCaptureRestart()
  stopContextCapture(contextCaptureProcess)
  contextCaptureHealth = reconnecting ? 'reconnecting' : 'starting'
  contextCaptureStartedAt = Date.now()
  contextCaptureLastEventAt = null
  let child: ChildProcessWithoutNullStreams | null = null
  child = startContextCapture(contextDirectory(activeSessionId), handleContext, (code, message) => {
    if (child !== contextCaptureProcess) return
    scheduleContextCaptureRestart(code, message)
  })
  contextCaptureProcess = child
  emitState()
  return contextCaptureProcess != null
}

function stopContextEngine(): void {
  clearContextCaptureRestart()
  stopContextCapture(contextCaptureProcess)
  contextCaptureProcess = null
  contextCaptureHealth = 'inactive'
  contextCaptureStartedAt = null
  contextCaptureLastEventAt = null
  closeCurrentAppActivity()
}

function checkContextCaptureHealth(): void {
  if (
    !shouldMonitorContextCapture({
      hasActiveSession: activeSessionId != null,
      status,
      capturePaused: isSourcePaused('capture'),
    })
  ) {
    return
  }
  if (
    !isContextCaptureStale({
      now: Date.now(),
      lastEventAt: contextCaptureLastEventAt,
      startedAt: contextCaptureStartedAt,
      staleAfterMs: CONTEXT_STALE_AFTER_MS,
    })
  ) {
    return
  }
  scheduleContextCaptureRestart('context-capture-stalled', 'No context events received')
}

function startContextCaptureHealthTimer(): void {
  if (contextCaptureHealthTimer) return
  contextCaptureHealthTimer = setInterval(checkContextCaptureHealth, CONTEXT_HEALTH_CHECK_MS)
}

function clearContextCaptureHealthTimer(): void {
  if (!contextCaptureHealthTimer) return
  clearInterval(contextCaptureHealthTimer)
  contextCaptureHealthTimer = null
}

function clearSystemAudioRestart(): void {
  if (systemAudioRestartTimer) clearTimeout(systemAudioRestartTimer)
  systemAudioRestartTimer = null
}

function stopSystemAudioProcess(): void {
  const child = systemAudioCaptureProcess
  child?.once('close', () => {
    if (systemAudioCaptureProcess === child) systemAudioCaptureProcess = null
  })
  stopSystemAudioCapture(child)
}

function scheduleSystemAudioRestart(code: string, message: string): void {
  if (
    !activeSessionId ||
    status !== 'recording' ||
    !canRunAudioCapture() ||
    isSourcePaused('audio') ||
    systemAudioRestartTimer
  )
    return
  console.warn(`[daily-review] native system audio interrupted (${code}); retrying:`, message)
  stopSystemAudioProcess()
  systemAudioReady = false
  const delay =
    SYSTEM_AUDIO_RESTART_DELAYS_MS[Math.min(systemAudioRestartAttempts, SYSTEM_AUDIO_RESTART_DELAYS_MS.length - 1)] ??
    60_000
  systemAudioRestartAttempts += 1
  systemAudioRestartTimer = setTimeout(() => {
    systemAudioRestartTimer = null
    if (!activeSessionId || status !== 'recording' || !shouldRunAudioEngines() || isSourcePaused('audio')) return
    startSystemAudioEngine(false)
  }, delay)
}

function startSystemAudioEngine(resetRestartAttempts = true): boolean {
  if (!activeSessionId) return false
  if (!shouldRunAudioEngines()) return false
  if (isSourcePaused('audio')) return true
  pausedAudioFinalizationVersion++
  if (usesQaSyntheticManualAudio()) {
    clearSystemAudioRestart()
    stopSystemAudioProcess()
    systemAudioReady = true
    systemAudioCheckStatus = 'ready'
    systemAudioCheckError = null
    systemAudioRestartAttempts = 0
    return true
  }
  clearSystemAudioRestart()
  stopSystemAudioProcess()
  systemAudioReady = false
  if (resetRestartAttempts) systemAudioRestartAttempts = 0
  let child: ChildProcessWithoutNullStreams | null = null
  child = startSystemAudioCapture(
    audioDirectory(activeSessionId),
    captureChunkDuration(),
    (chunk) => {
      if (child !== systemAudioCaptureProcess) {
        removeTemporaryCaptureFile(chunk.path)
        return
      }
      systemAudioRestartAttempts = 0
      let wav: Buffer
      try {
        wav = readFileSync(chunk.path)
      } catch (error) {
        removeTemporaryCaptureFile(chunk.path)
        console.error('[daily-review] failed to read local system-audio chunk', error)
        failCapture('storage-failed')
        return
      }
      handleChunk(
        'system',
        wav,
        chunk.startedAt,
        chunk.durationMs,
        chunk.averageLevel,
        chunk.path,
        chunk.captureEpochId,
        chunk.sequence,
        chunk.sampleCount,
        chunk.sampleTime
      )
    },
    (code, message) => {
      if (child !== systemAudioCaptureProcess) return
      if (manualMeetingStarting) {
        systemAudioCheckStatus = 'failed'
        systemAudioCheckError = message
        emitState()
      }
      scheduleSystemAudioRestart(code, message)
    },
    () => {
      if (child !== systemAudioCaptureProcess) return
      systemAudioReady = true
      systemAudioCheckStatus = 'ready'
      systemAudioCheckError = null
      systemAudioRestartAttempts = 0
      if (manualMeeting?.status === 'recording' && !manualMeeting.systemAudioAvailable) {
        manualMeeting = getEvidenceStore().markManualMeetingSystemAudioAvailable(manualMeeting.id)
      }
      emitState()
    }
  )
  systemAudioCaptureProcess = child
  if (!systemAudioCaptureProcess && status === 'recording') {
    scheduleSystemAudioRestart('system-audio-capture-failed', 'Native helper was unavailable')
  }
  return systemAudioCaptureProcess != null
}

function stopSystemAudioEngine(): void {
  clearSystemAudioRestart()
  stopSystemAudioProcess()
  systemAudioReady = false
  systemAudioRestartAttempts = 0
}

function clearMicrophoneRestart(): void {
  if (microphoneRestartTimer) clearTimeout(microphoneRestartTimer)
  microphoneRestartTimer = null
}

function stopMicrophoneAudioProcess(): void {
  const child = microphoneAudioCaptureProcess
  child?.once('close', () => {
    if (microphoneAudioCaptureProcess === child) microphoneAudioCaptureProcess = null
  })
  stopMicrophoneAudioCapture(child)
}

function scheduleMicrophoneRestart(code: string, message: string): void {
  if (
    dictationOwnsMicrophone ||
    !activeSessionId ||
    status !== 'recording' ||
    !canRunAudioCapture() ||
    isSourcePaused('audio') ||
    microphoneRestartTimer
  )
    return
  console.warn(`[daily-review] native microphone interrupted (${code}); retrying:`, message)
  reportAppError(new Error('Microphone capture interrupted'), {
    area: 'audio-capture',
    code: 'microphone-capture-interrupted',
    tags: { reason: code },
    diagnostics: {
      attempt: microphoneRestartAttempts + 1,
      microphone_ready: microphoneName != null,
      system_audio_ready: systemAudioReady,
    },
  })
  stopMicrophoneAudioProcess()
  microphoneName = null
  microphoneLastChunkAt = null
  emitState()
  const delay =
    SYSTEM_AUDIO_RESTART_DELAYS_MS[Math.min(microphoneRestartAttempts, SYSTEM_AUDIO_RESTART_DELAYS_MS.length - 1)] ??
    60_000
  microphoneRestartAttempts += 1
  microphoneRestartTimer = setTimeout(() => {
    microphoneRestartTimer = null
    if (!activeSessionId || status !== 'recording' || !shouldRunAudioEngines() || isSourcePaused('audio')) return
    // A failed lease may still be closing. The shared service queues its
    // replacement until input is released; do not mistake it for live capture.
    startMicrophoneEngine(false)
  }, delay)
}

function startMicrophoneEngine(resetRestartAttempts = true): boolean {
  if (dictationOwnsMicrophone) return false
  if (!activeSessionId) return false
  if (!shouldRunAudioEngines()) return false
  if (isSourcePaused('audio')) return true
  pausedAudioFinalizationVersion++
  if (usesQaSyntheticManualAudio()) {
    clearMicrophoneRestart()
    stopMicrophoneAudioProcess()
    microphoneName = 'Remember QA audio fixture'
    microphoneLastChunkAt = Date.now()
    microphoneRestartAttempts = 0
    return true
  }
  clearMicrophoneRestart()
  stopMicrophoneAudioProcess()
  microphoneName = null
  microphoneLastChunkAt = null
  if (resetRestartAttempts) microphoneRestartAttempts = 0
  const captureSessionId = activeSessionId
  let child: MicrophoneCaptureHandle | null = null
  child = startMicrophoneAudioCapture(
    audioDirectory(activeSessionId),
    captureChunkDuration(),
    (name) => {
      if (child !== microphoneAudioCaptureProcess) return
      microphoneName = name
      microphoneRestartAttempts = 0
      startNextAudioEngine()
      emitState()
    },
    (chunk) => {
      if (child !== microphoneAudioCaptureProcess) {
        removeTemporaryCaptureFile(chunk.path)
        return
      }
      microphoneRestartAttempts = 0
      microphoneLastChunkAt = chunk.startedAt + chunk.durationMs
      emitState()
      let wav: Buffer
      try {
        wav = readFileSync(chunk.path)
      } catch (error) {
        removeTemporaryCaptureFile(chunk.path)
        console.error('[daily-review] failed to read local microphone chunk', error)
        scheduleMicrophoneRestart('storage-failed', String(error))
        return
      }
      handleChunk(
        'microphone',
        wav,
        chunk.startedAt,
        chunk.durationMs,
        chunk.averageLevel,
        chunk.path,
        chunk.captureEpochId,
        chunk.sequence,
        chunk.sampleCount,
        chunk.sampleTime
      )
    },
    (code, message) => {
      if (child !== microphoneAudioCaptureProcess) return
      scheduleMicrophoneRestart(code, message)
    },
    () => {
      if (child === microphoneAudioCaptureProcess) flushConversationMicrophoneTranscription(captureSessionId)
    }
  )
  microphoneAudioCaptureProcess = child
  if (!microphoneAudioCaptureProcess && status === 'recording') {
    scheduleMicrophoneRestart('microphone-capture-failed', 'Native helper was unavailable')
  }
  return microphoneAudioCaptureProcess != null
}

function startNextAudioEngine(resetRestartAttempts = true): void {
  let target = nextAudioEngineToStart({
    microphoneStarted: microphoneAudioCaptureProcess != null || microphoneName != null,
    microphoneReady: microphoneName != null,
    systemAudioStarted: systemAudioCaptureProcess != null || systemAudioReady,
  })
  if (target === 'microphone') {
    if (!startMicrophoneEngine(resetRestartAttempts)) {
      startSystemAudioEngine(resetRestartAttempts)
      return
    }
    target = nextAudioEngineToStart({
      microphoneStarted: microphoneAudioCaptureProcess != null || microphoneName != null,
      microphoneReady: microphoneName != null,
      systemAudioStarted: systemAudioCaptureProcess != null || systemAudioReady,
    })
  }
  if (target === 'system') startSystemAudioEngine(resetRestartAttempts)
}

function stopMicrophoneEngine(): void {
  clearMicrophoneRestart()
  stopMicrophoneAudioProcess()
  microphoneRestartAttempts = 0
  microphoneName = null
  microphoneLastChunkAt = null
}

function flushConversationMicrophoneTranscription(sessionId: string) {
  transcriptionQueue = transcriptionQueue
    .then(async () => {
      const result = await flushTranscriptionStream(`${sessionId}:microphone`)
      persistTranscriptionResult(sessionId, 'microphone', result, Date.now(), powerMonitor.getSystemIdleTime())
    })
    .catch((error) => console.error('[dictation] Could not flush preceding conversation speech', error))
}

export async function suspendConversationMicrophone() {
  if (dictationOwnsMicrophone) throw new Error('dictation-microphone-already-owned')
  dictationOwnsMicrophone = true
  const child = microphoneAudioCaptureProcess
  const sessionId = activeSessionId
  stopMicrophoneEngine()
  const release = () => {
    dictationOwnsMicrophone = false
    if (isDisposed || isDisposing) return
    // The normal startup sequence considers audio running once the system tap
    // is ready. Dictation leaves that tap alive, so restore the mic explicitly.
    if (
      status === 'recording' &&
      !microphoneAudioCaptureProcess &&
      shouldRunAudioEngines() &&
      !isSourcePaused('audio')
    ) {
      startMicrophoneEngine()
    }
    reconcileSourceEngines()
  }
  try {
    await waitForCaptureProcess(child, true)
    if (sessionId && child) flushConversationMicrophoneTranscription(sessionId)
    return release
  } catch (error) {
    release()
    throw error
  }
}

function startAudioEngines(): void {
  if (!shouldRunAudioEngines()) {
    stopMicrophoneEngine()
    stopSystemAudioEngine()
    return
  }
  startNextAudioEngine()
}

function finalizeActiveSession(): string | null {
  if (!activeSessionId) return null
  closeCurrentAppActivity()
  const sessionId = activeSessionId
  const endedAt = Date.now()
  updateSession(sessionId, (session) => ({
    ...session,
    endedAt,
    activeDurationMs,
  }))
  activeSessionId = null
  startedAt = null
  activeStartedAt = null
  activeDurationMs = 0
  return sessionId
}

function failCapture(code: string): void {
  clearStopWatchdog()
  accrueActiveDuration()
  stopMicrophoneEngine()
  stopSystemAudioEngine()
  stopContextEngine()
  finalizeActiveSession()
  status = 'error'
  errorCode = code
  emitState()
}

async function ensureCapturePermissions(): Promise<boolean> {
  if (!hasCompletedOnboarding(getSettings())) return false
  if (process.platform !== 'darwin') return true
  const audioCaptureEnabled = getSettings().audioCaptureEnabled || isManualMeetingRecording()

  if (audioCaptureEnabled && microphonePermissionStatus() !== 'granted') {
    status = 'error'
    errorCode = 'microphone-permission'
    emitState()
    return false
  }

  if (!isContextCaptureAvailable()) {
    status = 'error'
    errorCode = 'context-capture-unavailable'
    emitState()
    return false
  }

  await refreshPermissionStatuses()
  if (accessibilityPermission !== 'granted') {
    status = 'error'
    errorCode = 'accessibility-permission'
    emitState()
    return false
  }
  if (restartRequired) {
    status = 'error'
    errorCode = 'permissions-restart-required'
    emitState()
    return false
  }
  if (audioCaptureEnabled && systemAudioCheckStatus !== 'ready' && !manualMeetingStarting) {
    status = 'error'
    errorCode = 'system-audio-check-required'
    emitState()
    return false
  }
  return true
}

async function verifySystemAudio(): Promise<DailyReviewState> {
  if ((status === 'recording' && shouldRunAudioEngines()) || status === 'stopping') return buildState()
  await refreshPermissionStatuses()
  if (microphonePermissionStatus() !== 'granted' || accessibilityPermission !== 'granted' || restartRequired) {
    return buildState()
  }

  systemAudioCheckStatus = 'checking'
  systemAudioCheckError = null
  emitState()
  const systemResult = await verifySystemAudioCapture()
  if (!systemResult.ok) {
    console.error('[daily-review] system audio verification failed', systemResult)
  }
  systemAudioCheckStatus = systemResult.ok ? 'ready' : 'failed'
  systemAudioCheckError = systemResult.error
  if (systemResult.ok && errorCode === 'system-audio-check-required') {
    status = 'idle'
    errorCode = null
  }
  emitState()
  return buildState()
}

function beginRecorder(): void {
  activeStartedAt = Date.now()
  status = 'recording'
  errorCode = null
  startAudioEngines()
  if (!isSourcePaused('capture') && !startContextEngine()) {
    failCapture('context-capture-unavailable')
    return
  }
  emitState()
}

async function startSession(): Promise<DailyReviewState> {
  if (status === 'recording' || status === 'paused' || status === 'stopping') return buildState()
  if ((getSettings().audioCaptureEnabled || manualMeetingStarting) && !isModelDownloaded()) {
    status = 'error'
    errorCode = 'model-required'
    emitState()
    return buildState()
  }
  if (!(await ensureCapturePermissions())) return buildState()

  const now = Date.now()
  const reusable = sessionForCaptureStart(sessions, activeSessionId, now)
  const session: DailyReviewSession = reusable
    ? { ...reusable, endedAt: null }
    : {
        id: randomUUID(),
        localDay: localDayKey(now),
        startedAt: now,
        endedAt: null,
        activeDurationMs: 0,
        moments: [],
        appActivity: [],
        contextMoments: [],
        memory: null,
        refresh: {
          status: 'idle',
          reason: null,
          targetThrough: null,
          error: null,
          progress: null,
          run: null,
        },
      }
  sessions = reusable
    ? sessions.map((candidate) => (candidate.id === session.id ? session : candidate))
    : [session, ...sessions]
  activeSessionId = session.id
  startedAt = session.startedAt
  activeDurationMs = session.activeDurationMs
  contextCompactor.reset(getEvidenceStore().readContextMoments(session.id))
  persistSessions()
  beginRecorder()
  scheduleDayRollover()
  return buildState()
}

function pauseSession(pausedUntil: number | null = null): DailyReviewState {
  if (status !== 'recording') return buildState()
  updateSettings({
    capturePaused: true,
    capturePausedUntil: pausedUntil,
    capturePauseSources: [...ALL_CAPTURE_PAUSE_SOURCES],
  })
  scheduleTimedResume(pausedUntil)
  pauseRecorder()
  return buildState()
}

function pauseRecorder(): void {
  const sessionId = activeSessionId
  const captureProcesses = [microphoneAudioCaptureProcess, systemAudioCaptureProcess]
  accrueActiveDuration()
  status = 'paused'
  stopMicrophoneEngine()
  stopSystemAudioEngine()
  stopContextEngine()
  emitState()
  if (sessionId) {
    finishPausedAudioCapture(sessionId, captureProcesses)
  }
}

function finishPausedAudioCapture(
  sessionId: string,
  captureProcesses: Parameters<typeof waitForCaptureProcess>[0][],
  pausedAt = Date.now()
) {
  const version = ++pausedAudioFinalizationVersion
  const stillPaused = () =>
    !isDisposed &&
    !isDisposing &&
    version === pausedAudioFinalizationVersion &&
    (status !== 'recording' || !shouldRunAudioEngines() || isSourcePaused('audio'))
  pausedAudioFinalization = Promise.all([
    pausedAudioFinalization,
    ...captureProcesses.map((child) => waitForCaptureProcess(child)),
  ])
    .then(() => {
      if (stillPaused()) return queueAudioTranscriptionFlush(sessionId, pausedAt, stillPaused)
    })
    .then(() => {
      if (stillPaused()) syncDerivedConversationEpisodes(sessionId, pausedAt, true, 'capture-paused')
    })
    .catch((error) => console.error('[daily-review] failed to finalize paused audio', error))
}

async function resumeSession(clearManualPause = true): Promise<DailyReviewState> {
  if (status !== 'paused') return buildState()
  clearTimedResumeTimer()
  const settings = getSettings()
  if (clearManualPause && settings.capturePaused) {
    updateSettings({ capturePaused: false, capturePausedUntil: null })
  }
  const scheduleStatus = getCaptureScheduleStatus(settings.captureSchedule)
  scheduleCaptureCheck()
  if (!scheduleStatus.isAllowed) {
    emitState()
    return buildState()
  }
  if (!activeSessionId) {
    status = 'idle'
    await startAutomaticCapture()
    return buildState()
  }
  if (!(await ensureCapturePermissions())) {
    return buildState()
  }
  beginRecorder()
  return buildState()
}

function reconcileSourceEngines(): DailyReviewState {
  if (isDisposing || isDisposed || status !== 'recording' || !activeSessionId) return buildState()

  if (!shouldRunAudioEngines() || isSourcePaused('audio')) {
    stopMicrophoneEngine()
    stopSystemAudioEngine()
  } else {
    startNextAudioEngine()
  }

  if (isSourcePaused('capture')) {
    stopContextEngine()
  } else {
    if (!contextCaptureProcess && !startContextEngine()) {
      failCapture('context-capture-unavailable')
      return buildState()
    }
  }
  emitState()
  return buildState()
}

async function configureManualPause(input: CapturePauseInput): Promise<DailyReviewState> {
  const audioWasPaused = isSourcePaused('audio')
  const sources = Array.from(
    new Set(input.sources.filter((source): source is CapturePauseSource => ALL_CAPTURE_PAUSE_SOURCES.includes(source)))
  )
  const pausedUntil =
    input.durationMs == null
      ? null
      : Number.isFinite(input.durationMs) && input.durationMs > 0
        ? Date.now() + input.durationMs
        : 0
  if (pausedUntil === 0) return buildState()

  clearTimedResumeTimer()
  updateSettings({
    capturePaused: sources.length > 0,
    capturePausedUntil: sources.length > 0 ? pausedUntil : null,
    capturePauseSources: sources,
  })
  if (sources.length > 0) scheduleTimedResume(pausedUntil)

  if (ALL_CAPTURE_PAUSE_SOURCES.every((source) => sources.includes(source))) {
    if (status === 'recording') pauseRecorder()
    else if (status === 'idle') {
      status = 'paused'
      errorCode = null
      emitState()
    }
    return buildState()
  }

  if (!audioWasPaused && sources.includes('audio') && activeSessionId) {
    const captureProcesses = [microphoneAudioCaptureProcess, systemAudioCaptureProcess]
    stopMicrophoneEngine()
    stopSystemAudioEngine()
    finishPausedAudioCapture(activeSessionId, captureProcesses)
  }

  if (status === 'paused') {
    const scheduleStatus = getCaptureScheduleStatus(getSettings().captureSchedule)
    if (!scheduleStatus.isAllowed) {
      emitState()
      return buildState()
    }
    if (!activeSessionId) {
      status = 'idle'
      await startAutomaticCapture()
      return buildState()
    }
    if (!(await ensureCapturePermissions())) return buildState()
    beginRecorder()
    return buildState()
  }

  if (status === 'idle') {
    await startAutomaticCapture()
    return buildState()
  }

  return reconcileSourceEngines()
}

async function resumeAllCapture(): Promise<DailyReviewState> {
  clearTimedResumeTimer()
  const settings = getSettings()
  if (settings.capturePaused) updateSettings({ capturePaused: false, capturePausedUntil: null })
  if (status === 'paused') return resumeSession(false)
  return reconcileSourceEngines()
}

function stopSession(): DailyReviewState {
  if (status !== 'recording' && status !== 'paused') return buildState()
  accrueActiveDuration()
  const sessionId = activeSessionId
  const captureProcesses = [microphoneAudioCaptureProcess, systemAudioCaptureProcess]
  status = 'stopping'
  errorCode = null
  stopMicrophoneEngine()
  stopSystemAudioEngine()
  stopContextEngine()
  const captureStopped = Promise.all(captureProcesses.map((child) => waitForCaptureProcess(child)))
  if (sessionId) {
    const finalization = captureStopped
      .then(() => waitForTranscriptionsToSettle())
      .then(() => flushAudioTranscriptionStreams(sessionId))
    const trackedFinalization = finalization.finally(() => {
      if (stoppedAudioFinalization === trackedFinalization) stoppedAudioFinalization = null
    })
    stoppedAudioFinalization = trackedFinalization
  }
  void captureStopped.then(() => finishStop())
  clearStopWatchdog()
  stopWatchdog = setTimeout(() => {
    stopWatchdog = null
    finishStop()
  }, 3_000)
  emitState()
  return buildState()
}

function finishStop(): void {
  if (status !== 'stopping') return
  clearStopWatchdog()
  const sessionId = finalizeActiveSession()
  status = 'idle'
  errorCode = null
  emitState()

  if (sessionId && pendingEndOfDayRefreshId === sessionId) {
    pendingEndOfDayRefreshId = null
    const completedTranscriptions = stoppedAudioFinalization ?? transcriptionQueue
    void startAutomaticCapture()
    void completedTranscriptions.then(() => refreshDayIfAvailable(sessionId, 'end-of-day'))
  }
}

function rolloverWorkday(): void {
  scheduleDayRollover()
  if (!activeSessionId || (status !== 'recording' && status !== 'paused')) return
  pendingEndOfDayRefreshId = activeSessionId
  stopSession()
}

function updateMoment(sessionId: string, momentId: string, update: Partial<DailyReviewMoment>): void {
  if (isDisposed) return
  getEvidenceStore().updateAudioMoment(sessionId, momentId, update)
  updateSession(sessionId, (session) => ({
    ...session,
    moments: session.moments.map((moment) => (moment.id === momentId ? { ...moment, ...update } : moment)),
  }))
}

function syncDerivedConversationEpisodes(
  sessionId: string,
  coveredThrough: number,
  finalizeAll = false,
  finalBoundaryReason?: 'capture-paused' | 'day-ended'
) {
  const store = getEvidenceStore()
  const existing = store.listConversationEpisodes(sessionId)
  const existingById = new Map(existing.map((episode) => [episode.id, episode]))
  const signals = store.listCallSignals(sessionId)
  const derived = deriveConversationEpisodes({
    workdayId: sessionId,
    segments: store.listSpeechSegments(sessionId),
    moments: sessions.find((session) => session.id === sessionId)?.moments,
    signals,
    existing,
    coveredThrough,
    finalizeAll,
    finalBoundaryReason,
  })
  const finalizedOfflineEpisodeIds = new Set(
    derived
      .filter((episode) => {
        if (episode.state !== 'final' || existingById.get(episode.id)?.state === 'final') return false
        const completedAt = conversationEpisodeCompletedAt(episode, signals, coveredThrough)
        return completedAt != null && (isOfflineMode() || store.wasOfflineAt(completedAt))
      })
      .map((episode) => episode.id)
  )
  const episodes = preserveAutomaticRevinoteExclusions(derived, existing, finalizedOfflineEpisodeIds)
  store.syncConversationEpisodes(sessionId, episodes)
  return episodes
}

async function persistRecognizedConversationAudio(
  session: DailyReviewSession,
  episodes: ReturnType<typeof syncDerivedConversationEpisodes>,
  generatedMemory: Awaited<ReturnType<typeof generateDayMemory>>['memory'],
  coveredThrough: number
) {
  const deletionEpoch = dataDeletionEpoch
  const sessionEpoch = sessionDeletionEpochs.get(session.id)
  const invalidated = () =>
    isDisposed || dataDeletionEpoch !== deletionEpoch || sessionDeletionEpochs.get(session.id) !== sessionEpoch
  const byId = new Map(episodes.map((episode) => [episode.id, episode]))
  const recognizedEpisodeIds = new Set(
    generatedMemory.conversations.flatMap((conversation) => (conversation.episodeId ? [conversation.episodeId] : []))
  )
  const resolvedEpisodeIds = new Set(
    episodes
      .filter(
        (episode) =>
          episode.state === 'final' &&
          episode.endedAt <= coveredThrough &&
          episode.endedAt + CONVERSATION_RECOVERY_RETENTION_MS <= Date.now() &&
          !recognizedEpisodeIds.has(episode.id)
      )
      .map((episode) => episode.id)
  )

  for (const conversation of generatedMemory.conversations) {
    if (invalidated()) return
    if (!conversation.episodeId) continue
    const episode = byId.get(conversation.episodeId)
    if (episode?.state !== 'final' || episode.deletedAt != null) continue
    try {
      if (await renderConversationAudioAsyncAt(dailyReviewDirectory(), episode, session.moments)) {
        resolvedEpisodeIds.add(episode.id)
      }
    } catch (error) {
      console.warn('[daily-review] failed to render recognized conversation audio', {
        episodeId: episode.id,
        error,
      })
    }
  }

  if (invalidated()) return
  pruneResolvedConversationChunksAt(
    dailyReviewDirectory(),
    session.id,
    session.moments,
    episodes,
    resolvedEpisodeIds,
    coveredThrough,
    Date.now() - CONVERSATION_RECOVERY_RETENTION_MS
  )
}

function mergedConversationFallback(conversations: ConversationSummary[], episodeId: string): ConversationSummary {
  const first = conversations[0]
  if (!first) throw new Error('conversation-merge-needs-two-sources')
  const participantNames = [
    ...new Set(conversations.flatMap((conversation) => conversation.otherParticipantName ?? [])),
  ]
  return {
    episodeId,
    startTime: first.startTime,
    endTime: conversations.reduce(
      (latest, conversation) => (conversation.endTime > latest ? conversation.endTime : latest),
      first.endTime
    ),
    title: 'Gesprekken worden samengevoegd',
    description: 'Het samengevoegde gesprek wordt opnieuw verwerkt.',
    summary: conversations.flatMap((conversation) => conversation.summary ?? []).join('\n\n'),
    actionPoints: [...new Set(conversations.flatMap((conversation) => conversation.actionPoints ?? []))],
    actionPointItems: conversations
      .flatMap((conversation) => conversationActionPointItems(conversation))
      .filter(
        (item, index, items) =>
          items.findIndex(
            (candidate) =>
              candidate.text.trim().replace(/\s+/g, ' ').toLocaleLowerCase() ===
              item.text.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
          ) === index
      ),
    ...(participantNames.length === 1 ? { otherParticipantName: participantNames[0] } : {}),
    processing: 'merging',
  }
}

function markConversationMergeFailed(sessionId: string, episodeId: string) {
  updateSession(sessionId, (candidate) =>
    candidate.memory
      ? {
          ...candidate,
          memory: {
            ...candidate.memory,
            conversations: candidate.memory.conversations.map((conversation) =>
              conversation.episodeId === episodeId
                ? {
                    ...conversation,
                    title: 'Samengevoegd gesprek',
                    description:
                      'De audio is samengevoegd. De nieuwe titel en samenvatting konden nog niet worden gemaakt.',
                    processing: undefined,
                  }
                : conversation
            ),
          },
        }
      : candidate
  )
}

function pendingMergedConversationEpisodeIds(sessionId: string) {
  const session = sessions.find((candidate) => candidate.id === sessionId)
  return [
    ...new Set(
      (session?.memory?.conversations ?? []).flatMap((conversation) =>
        conversation.processing === 'merging' && conversation.episodeId ? [conversation.episodeId] : []
      )
    ),
  ]
}

function regenerateMergedConversations(sessionId: string) {
  if (isDisposed || regeneratingMergedConversationDayIds.has(sessionId)) return
  const episodeIds = pendingMergedConversationEpisodeIds(sessionId)
  if (episodeIds.length === 0) return

  regeneratingMergedConversationDayIds.add(sessionId)
  void transcriptionQueue
    .then(() => refreshDay(sessionId, 'manual', getInterfaceLocale()))
    .then((updated) => {
      for (const episodeId of episodeIds) {
        const merged = updated.memory?.conversations.find((conversation) => conversation.episodeId === episodeId)
        if (!merged || merged.processing === 'merging' || updated.refresh.status === 'failed') {
          markConversationMergeFailed(sessionId, episodeId)
        }
      }
    })
    .catch((error) => {
      console.error('[daily-review] failed to regenerate merged conversation', error)
      for (const episodeId of episodeIds) markConversationMergeFailed(sessionId, episodeId)
    })
    .finally(() => {
      regeneratingMergedConversationDayIds.delete(sessionId)
      regenerateMergedConversations(sessionId)
    })
}

function mergeConversations(sessionId: string, conversationReferences: string[]) {
  if (
    typeof sessionId !== 'string' ||
    !Array.isArray(conversationReferences) ||
    conversationReferences.some((value) => typeof value !== 'string')
  ) {
    throw new Error('invalid-conversation-merge')
  }
  const selectedReferences = [...new Set(conversationReferences)]
  if (selectedReferences.length < 2) throw new Error('conversation-merge-needs-two-sources')
  const session = sessions.find((candidate) => candidate.id === sessionId)
  if (!session?.memory) throw new Error('day-memory-not-found')
  const selected = selectedReferences
    .map((reference) => resolveConversationReference(session.memory?.conversations ?? [], reference))
    .filter((conversation): conversation is ConversationSummary => conversation != null)
    .sort((first, second) => first.startTime.localeCompare(second.startTime))
  if (selected.length !== selectedReferences.length) throw new Error('conversation-not-found')
  if (new Set(selected.map(conversationReference)).size !== selected.length) {
    throw new Error('conversation-merge-needs-two-sources')
  }
  if (selected.some((conversation) => !conversation.episodeId || conversation.source === 'revinote')) {
    throw new Error('conversation-merge-source-not-local')
  }

  const episodesById = new Map(
    getEvidenceStore()
      .listConversationEpisodes(sessionId)
      .map((episode) => [episode.id, episode])
  )
  const sourceEpisodes = selected
    .map((conversation) => episodesById.get(conversation.episodeId as string))
    .filter((episode): episode is ConversationEpisode => episode != null)
    .sort((first, second) => first.startedAt - second.startedAt)
  if (
    sourceEpisodes.length !== selected.length ||
    sourceEpisodes.some((episode) => episode.state !== 'final' || episode.deletedAt != null)
  ) {
    throw new Error('conversation-merge-source-not-final')
  }

  const surfaceKeys = [...new Set(sourceEpisodes.map((episode) => episode.surfaceKey))]
  const providers = [...new Set(sourceEpisodes.map((episode) => episode.provider))]
  const mergedEpisode: ConversationEpisode = {
    id: `manual-merge-${randomUUID()}`,
    workdayId: sessionId,
    startedAt: sourceEpisodes[0]?.startedAt ?? 0,
    endedAt: Math.max(...sourceEpisodes.map((episode) => episode.endedAt)),
    state: 'final',
    surfaceKey: surfaceKeys.length === 1 ? (surfaceKeys[0] ?? null) : null,
    provider: providers.length === 1 ? (providers[0] ?? null) : null,
    boundaryReason: 'manual-merge',
    segmentIds: [...new Set(sourceEpisodes.flatMap((episode) => episode.segmentIds))],
    deletedAt: null,
    automaticRevinoteProcessingBlocked: sourceEpisodes.some((episode) => episode.automaticRevinoteProcessingBlocked),
  }

  mergeConversationAudioAt(dailyReviewDirectory(), mergedEpisode, sourceEpisodes)
  try {
    getEvidenceStore().mergeConversationEpisodes(
      mergedEpisode,
      sourceEpisodes.map((episode) => episode.id)
    )
  } catch (error) {
    removeConversationAudioForEpisodeAt(dailyReviewDirectory(), mergedEpisode)
    throw error
  }
  updateSession(sessionId, (candidate) => {
    if (!candidate.memory) return candidate
    const selectedSet = new Set(selected)
    return {
      ...candidate,
      memory: {
        ...candidate.memory,
        conversations: [
          ...candidate.memory.conversations.filter((conversation) => !selectedSet.has(conversation)),
          mergedConversationFallback(selected, mergedEpisode.id),
        ].sort((first, second) => first.startTime.localeCompare(second.startTime)),
      },
    }
  })
  for (const episode of sourceEpisodes) removeConversationAudioForEpisodeAt(dailyReviewDirectory(), episode)

  regenerateMergedConversations(sessionId)

  const updated = sessions.find((candidate) => candidate.id === sessionId)
  if (!updated) throw new Error('day-not-found')
  return updated
}

function conversationClockTime(timestamp: number) {
  const date = new Date(timestamp)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function markRecoveredConversationFailed(sessionId: string, episodeId: string) {
  updateSession(sessionId, (session) =>
    session.memory
      ? {
          ...session,
          memory: {
            ...session.memory,
            conversations: session.memory.conversations.map((conversation) =>
              conversation.episodeId === episodeId
                ? {
                    ...conversation,
                    title: conversation.title || 'Gesprek',
                    processing: undefined,
                    processingProvider: undefined,
                    processingError: 'analysis',
                  }
                : conversation
            ),
          },
        }
      : session
  )
}

function recoverAudio(sessionId: string, momentIds: string[]) {
  if (
    typeof sessionId !== 'string' ||
    !Array.isArray(momentIds) ||
    !momentIds.length ||
    momentIds.some((id) => typeof id !== 'string' || !id)
  )
    throw new Error('invalid-audio-selection')
  const session = sessions.find((candidate) => candidate.id === sessionId)
  if (!session) throw new Error('day-not-found')
  const selected = new Set(momentIds)
  const moments = session.moments.filter((moment) => selected.has(moment.id))
  if (
    moments.length !== selected.size ||
    moments.some(
      (moment) =>
        moment.source === 'revinote' ||
        moment.status !== 'ready' ||
        !moment.transcript.trim() ||
        moment.startedAt + moment.durationMs + CONVERSATION_RECOVERY_RETENTION_MS <= Date.now() ||
        !existsSync(conversationAudioChunkPathAt(dailyReviewDirectory(), sessionId, moment.id))
    )
  ) {
    throw new Error('conversation-audio-unavailable')
  }
  const store = getEvidenceStore()
  const segments = store
    .listSpeechSegments(sessionId)
    .filter((segment) => !segment.rejectionReason && segment.text.trim() && selected.has(segment.chunkId))
  if (!segments.length) throw new Error('conversation-transcript-unavailable')
  const episode: ConversationEpisode = {
    id: `audio-selection-${randomUUID()}`,
    workdayId: sessionId,
    startedAt: Math.min(...moments.map((moment) => moment.startedAt)),
    endedAt: Math.max(...moments.map((moment) => moment.startedAt + moment.durationMs)),
    state: 'final',
    surfaceKey: null,
    provider: null,
    boundaryReason: 'manual-merge',
    segmentIds: segments.map((segment) => segment.id),
    deletedAt: null,
    automaticRevinoteProcessingBlocked: isOfflineMode(),
  }
  if (!renderConversationAudioAt(dailyReviewDirectory(), episode, moments, { compactGaps: true })) {
    throw new Error('conversation-audio-unavailable')
  }
  try {
    store.syncConversationEpisodes(sessionId, [...store.listConversationEpisodes(sessionId), episode])
  } catch (error) {
    removeConversationAudioForEpisodeAt(dailyReviewDirectory(), episode)
    throw error
  }
  return recoverConversation(sessionId, [episode.id])
}

function recoverConversation(sessionId: string, episodeIds: string[]) {
  if (
    typeof sessionId !== 'string' ||
    !Array.isArray(episodeIds) ||
    episodeIds.length === 0 ||
    episodeIds.some((episodeId) => typeof episodeId !== 'string' || !episodeId)
  ) {
    throw new Error('invalid-conversation-recovery')
  }
  const session = sessions.find((candidate) => candidate.id === sessionId)
  if (!session) throw new Error('day-not-found')
  const requestedIds = [...new Set(episodeIds)]
  const sourceEpisodes = getEvidenceStore()
    .listConversationEpisodes(sessionId)
    .filter((episode) => requestedIds.includes(episode.id))
    .sort((first, second) => first.startedAt - second.startedAt)
  const now = Date.now()
  if (
    sourceEpisodes.length !== requestedIds.length ||
    sourceEpisodes.some(
      (episode) =>
        episode.state !== 'final' ||
        episode.deletedAt != null ||
        episode.endedAt + CONVERSATION_RECOVERY_RETENTION_MS <= now
    )
  ) {
    throw new Error('conversation-recovery-unavailable')
  }

  let episode = sourceEpisodes[0] as ConversationEpisode
  if (sourceEpisodes.length > 1) {
    const surfaceKeys = [...new Set(sourceEpisodes.map((source) => source.surfaceKey))]
    const providers = [...new Set(sourceEpisodes.map((source) => source.provider))]
    episode = {
      id: `manual-merge-${randomUUID()}`,
      workdayId: sessionId,
      startedAt: sourceEpisodes[0]?.startedAt ?? 0,
      endedAt: Math.max(...sourceEpisodes.map((source) => source.endedAt)),
      state: 'final',
      surfaceKey: surfaceKeys.length === 1 ? (surfaceKeys[0] ?? null) : null,
      provider: providers.length === 1 ? (providers[0] ?? null) : null,
      boundaryReason: 'manual-merge',
      segmentIds: [...new Set(sourceEpisodes.flatMap((source) => source.segmentIds))],
      deletedAt: null,
      automaticRevinoteProcessingBlocked: sourceEpisodes.some((source) => source.automaticRevinoteProcessingBlocked),
      userDecision: 'confirmed',
    }
    for (const sourceEpisode of sourceEpisodes) {
      const audioPath = renderConversationAudioAt(dailyReviewDirectory(), sourceEpisode, session.moments, {
        compactGaps: true,
      })
      if (!audioPath) throw new Error('conversation-audio-unavailable')
    }
    mergeConversationAudioAt(dailyReviewDirectory(), episode, sourceEpisodes)
    try {
      getEvidenceStore().mergeConversationEpisodes(
        episode,
        sourceEpisodes.map((source) => source.id)
      )
    } catch (error) {
      removeConversationAudioForEpisodeAt(dailyReviewDirectory(), episode)
      throw error
    }
    for (const sourceEpisode of sourceEpisodes) {
      removeConversationAudioForEpisodeAt(dailyReviewDirectory(), sourceEpisode)
    }
  } else {
    const audioPath = renderConversationAudioAt(dailyReviewDirectory(), episode, session.moments, {
      compactGaps: true,
    })
    if (!audioPath) throw new Error('conversation-audio-unavailable')
  }
  getEvidenceStore().decideConversationEpisode(episode.id, 'confirmed')

  if (!session.memory) {
    updateSession(sessionId, (candidate) => ({
      ...candidate,
      memory: {
        summary: '',
        currentFocus: null,
        outcomes: [],
        decisions: [],
        openLoops: [],
        conversations: [],
        timeline: [],
        knowledgeSuggestions: [],
        refreshedAt: Date.now(),
        coveredThrough: session.startedAt,
      },
    }))
  }

  const processingProvider = selectManualMeetingProcessingProvider({
    automaticRevinoteProcessing: getSettings().automaticRevinoteProcessing,
    existing: undefined,
    offlineMode: isOfflineMode(),
    automaticRevinoteProcessingBlocked: episode.automaticRevinoteProcessingBlocked,
  })
  const placeholder: ConversationSummary = {
    episodeId: episode.id,
    startTime: conversationClockTime(episode.startedAt),
    endTime: conversationClockTime(episode.endedAt),
    title: 'Gesprek',
    description: '',
    processing: 'processing',
    processingProvider,
  }
  updateSession(sessionId, (candidate) =>
    candidate.memory
      ? {
          ...candidate,
          memory: {
            ...candidate.memory,
            conversations: [
              ...candidate.memory.conversations.filter(
                (conversation) => !sourceEpisodes.some((source) => source.id === conversation.episodeId)
              ),
              placeholder,
            ].sort((first, second) => first.startTime.localeCompare(second.startTime)),
          },
        }
      : candidate
  )
  if (processingProvider === 'revinote') {
    void queueAutomaticRevinoteProcessing()
    return sessions.find((candidate) => candidate.id === sessionId) as DailyReviewSession
  }
  void transcriptionQueue
    .then(() => refreshDay(sessionId, 'manual', getInterfaceLocale()))
    .then((updated) => {
      if (updated.refresh.status === 'failed') markRecoveredConversationFailed(sessionId, episode.id)
    })
    .catch((error) => {
      console.error('[daily-review] failed to process recovered conversation', error)
      markRecoveredConversationFailed(sessionId, episode.id)
    })

  return sessions.find((candidate) => candidate.id === sessionId) as DailyReviewSession
}

function dismissConversationCandidate(sessionId: string, episodeId: string) {
  if (typeof sessionId !== 'string' || typeof episodeId !== 'string' || !episodeId) {
    throw new Error('invalid-conversation-candidate')
  }
  const session = sessions.find((candidate) => candidate.id === sessionId)
  const episode = getEvidenceStore()
    .listConversationEpisodes(sessionId)
    .find((candidate) => candidate.id === episodeId && candidate.deletedAt == null)
  if (!session || !episode || episode.state !== 'final') throw new Error('conversation-candidate-not-found')
  getEvidenceStore().decideConversationEpisode(episodeId, 'dismissed')
  emitSessions()
  return projectedSessions().find((candidate) => candidate.id === sessionId) as DailyReviewSession
}

function applyManualMeetingMetadata(workdayId: string, conversations: ConversationSummary[]) {
  const store = getEvidenceStore()
  const meetings = store
    .listManualMeetings(workdayId)
    .filter((meeting) => meeting.endedAt != null && meeting.status !== 'recording')
  if (!meetings.length) return conversations
  const episodes = store.listConversationEpisodes(workdayId)
  const speechSegments = store.listSpeechSegments(workdayId)
  return conversations.map((conversation) => {
    const meeting = manualMeetingForConversation(conversation, meetings, episodes)
    if (!meeting) return conversation
    return {
      ...conversation,
      title:
        meeting.title.trim() ||
        conversation.title.trim() ||
        manualMeetingTitle(meeting.startedAt, getInterfaceLocale()),
      ...(meeting.notes ? { notes: meeting.notes } : {}),
      manualMeetingId: meeting.id,
      recordingSource:
        conversation.recordingSource ??
        manualMeetingRecordingSource(
          meeting,
          episodes.find((episode) => episode.id === meeting.episodeId),
          speechSegments
        ),
    }
  })
}

function stableSpeechSegmentId(segment: Pick<SpeechSegment, 'chunkId' | 'startedAt' | 'endedAt'>) {
  return `speech-${createHash('sha256')
    .update(`${segment.chunkId}\u0000${segment.startedAt}\u0000${segment.endedAt}`)
    .digest('hex')
    .slice(0, 24)}`
}

function persistTranscriptionResult(
  sessionId: string,
  source: DailyReviewSource,
  result: TranscriptionResult,
  observedThrough: number,
  idleSecondsAtChunkEnd: number
) {
  const retainedMomentIds = new Set(
    sessions.find((session) => session.id === sessionId)?.moments.map((moment) => moment.id)
  )
  const retainedSegments = result.segments.filter((segment) =>
    [segment.chunkId, ...segment.chunkIds].every((id) => retainedMomentIds.has(id))
  )
  const resolvedChunkIds = result.resolvedChunkIds.filter((id) => retainedMomentIds.has(id))
  if (!retainedSegments.length && !resolvedChunkIds.length) return
  const speechSegments: SpeechSegment[] = retainedSegments.map((segment) => ({
    id: stableSpeechSegmentId(segment),
    workdayId: sessionId,
    chunkId: segment.chunkId,
    chunkIds: segment.chunkIds,
    source,
    startedAt: segment.startedAt,
    endedAt: segment.endedAt,
    vadStartedAt: segment.vadStartedAt,
    vadEndedAt: segment.vadEndedAt,
    asrWindowIndex: segment.asrWindowIndex,
    asrWindowCount: segment.asrWindowCount,
    transcriptionOutcome: segment.transcriptionOutcome,
    text: segment.text,
    detectedLanguage: segment.detectedLanguage,
    acceptedLanguage: segment.acceptedLanguage,
    rejectionReason: segment.rejectionReason,
  }))
  const store = getEvidenceStore()
  store.appendSpeechSegments(speechSegments)
  const promotedChunkIds: string[] = []
  for (const language of result.promotedLanguages) {
    promotedChunkIds.push(...store.promoteQuarantinedSpeechSegments(sessionId, source, language, observedThrough))
  }
  for (const segment of speechSegments.filter(
    (candidate) => !candidate.rejectionReason && candidate.transcriptionOutcome !== 'asr-empty'
  )) {
    lastMeaningfulSpeechAt = Math.max(lastMeaningfulSpeechAt, segment.endedAt)
    creditMeaningfulSpeechActivity(
      sessionId,
      segment.startedAt,
      segment.endedAt - segment.startedAt,
      idleSecondsAtChunkEnd
    )
  }
  settleResolvedAudioMoments(sessionId, source, [...new Set([...resolvedChunkIds, ...promotedChunkIds])])
  syncDerivedConversationEpisodes(sessionId, observedThrough)
  emitSessions()
}

function recoverInterruptedTranscription(chunkIds: string[]) {
  if (isDisposed || chunkIds.length === 0) return
  const interrupted = new Set(chunkIds)
  for (const session of sessions) {
    for (const source of ['microphone', 'system'] as const) {
      const moments = session.moments.filter(
        (moment) => moment.source === source && moment.status === 'transcribing' && interrupted.has(moment.id)
      )
      settleResolvedAudioMoments(
        session.id,
        source,
        moments.map((moment) => moment.id),
        true
      )
    }
  }
  emitSessions()
}

function queueAudioTranscriptionFlush(sessionId: string, through: number, shouldContinue = () => !isDisposed) {
  transcriptionQueue = transcriptionQueue
    .then(() => {
      if (shouldContinue()) return flushAudioTranscriptionStreams(sessionId, shouldContinue, through)
    })
    .catch((error) => console.error('[daily-review] queued audio finalization failed', error))
  return transcriptionQueue
}

async function flushAudioTranscriptionStreams(sessionId: string, shouldContinue = () => true, through = Date.now()) {
  const pendingMoments =
    sessions
      .find((session) => session.id === sessionId)
      ?.moments.filter((moment) => moment.status === 'transcribing' && moment.startedAt < through) ?? []
  for (const source of ['microphone', 'system'] as const) {
    if (!shouldContinue()) return
    const pendingIds = pendingMoments.filter((moment) => moment.source === source).map((moment) => moment.id)
    try {
      const result = await flushTranscriptionStream(`${sessionId}:${source}`)
      persistTranscriptionResult(sessionId, source, result, through, powerMonitor.getSystemIdleTime())
    } catch (error) {
      console.error('[daily-review] failed to flush audio transcription stream', { source, error })
    }
    settleResolvedAudioMoments(sessionId, source, pendingIds, true)
  }
  emitSessions()
}

function settleResolvedAudioMoments(
  sessionId: string,
  source: DailyReviewSource,
  momentIds: string[],
  interrupted = false
) {
  if (momentIds.length === 0) return
  const store = getEvidenceStore()
  const segments = store.listSpeechSegments(sessionId)
  for (const momentId of momentIds) {
    const moment = sessions
      .find((session) => session.id === sessionId)
      ?.moments.find((candidate) => candidate.id === momentId && candidate.source === source)
    if (!moment) continue
    if (interrupted && moment.status !== 'transcribing') continue
    updateMoment(sessionId, momentId, resolvedAudioMoment(moment, segments, interrupted))
  }
}

function handleChunk(
  source: DailyReviewSource,
  wav: Buffer,
  chunkStartedAt: number,
  durationMs: number,
  averageLevel: number,
  existingAudioPath?: string,
  captureEpochId?: string,
  captureSequence?: number,
  capturedSampleCount?: number,
  captureSampleTime?: number | null
): void {
  const sessionId = activeSessionId
  if (!sessionId || !['recording', 'paused', 'stopping'].includes(status)) {
    if (existingAudioPath) removeTemporaryCaptureFile(existingAudioPath)
    return
  }
  const momentId = randomUUID()
  const idleSecondsAtChunkEnd = powerMonitor.getSystemIdleTime()
  checkpointActiveDuration(sessionId, chunkStartedAt + durationMs, idleSecondsAtChunkEnd)

  let audioPath: string
  try {
    audioPath = existingAudioPath ?? saveAudioChunk(sessionId, `${chunkStartedAt}-${source}-${momentId}`, wav)
  } catch (error) {
    console.error('[daily-review] failed to save local audio chunk', error)
    failCapture('storage-failed')
    return
  }

  const mediaPlayback = readMediaPlayback()
  const moment: DailyReviewMoment = {
    id: momentId,
    sessionId,
    source,
    startedAt: chunkStartedAt,
    durationMs,
    status: 'transcribing',
    transcript: '',
    captureEpochId: captureEpochId ?? `${sessionId}:${source}:${momentId}`,
    captureSequence: captureSequence ?? 0,
    capturedSampleCount: capturedSampleCount ?? Math.round((durationMs / 1_000) * 16_000),
    ...(captureSampleTime == null ? {} : { captureSampleTime }),
    captureOutcome: 'pending',
  }
  try {
    saveConversationAudioChunkAt(dailyReviewDirectory(), sessionId, momentId, wav)
  } catch (error) {
    console.error('[daily-review] failed to retain audio transport chunk', { momentId, error })
    removeTemporaryCaptureFile(audioPath)
    failCapture('storage-failed')
    return
  }
  getEvidenceStore().appendAudioMoment(moment, averageLevel)
  updateSession(sessionId, (session) => ({
    ...session,
    moments: [...session.moments, moment].sort((a, b) => a.startedAt - b.startedAt),
  }))

  if (durationMs < 500) {
    removeTemporaryCaptureFile(audioPath)
    updateMoment(sessionId, momentId, { status: 'empty', captureOutcome: 'too-short' })
    emitSessions()
    return
  }

  pendingAudioFiles.set(momentId, { sessionId, path: audioPath })
  transcriptionQueue = transcriptionQueue
    .then(() => {
      if (isDisposed) return
      return consumeTemporaryCaptureFile(audioPath, removeTemporaryCaptureFile, async () => {
        if (
          isDisposed ||
          !sessions.find((session) => session.id === sessionId)?.moments.some((moment) => moment.id === momentId)
        )
          return
        const playback = await mediaPlayback
        if (playback.isPlaying) updateMoment(sessionId, momentId, { mediaPlayback: playback })
        if (source === 'system' && !(await shouldTranscribeSystemAudio(audioPath, playback))) {
          updateMoment(sessionId, momentId, { status: 'empty', captureOutcome: 'music-gated' })
          emitSessions()
          return
        }
        if (isDisposed) return

        const result = await transcribeWav(wav, {
          streamId: `${sessionId}:${source}`,
          chunkId: momentId,
          captureEpochId: moment.captureEpochId as string,
          captureSequence: moment.captureSequence as number,
          startedAt: chunkStartedAt,
          defaultLanguage: getInterfaceLocale(),
        })
        persistTranscriptionResult(sessionId, source, result, chunkStartedAt + durationMs, idleSecondsAtChunkEnd)
      })
    })
    .catch((error) => {
      console.error('[daily-review] local transcription failed', error)
      settleResolvedAudioMoments(sessionId, source, [momentId], true)
      emitSessions()
    })
    .finally(() => {
      removeTemporaryCaptureFile(audioPath)
      pendingAudioFiles.delete(momentId)
    })
}

async function performModelPreparation(): Promise<void> {
  if (isModelDownloaded()) {
    warmTranscriber()
    emitState()
    return
  }
  const preparationState = modelPreparationStartState({ status, errorCode })
  status = preparationState.status
  errorCode = preparationState.errorCode
  try {
    await downloadModel(() => emitState())
    warmTranscriber()
  } catch (error) {
    console.error('[daily-review] model preparation failed', error)
    const failureState = modelPreparationFailureState(
      { status, errorCode },
      error instanceof Error && error.message === OFFLINE_MODE_ERROR
        ? 'model-download-offline'
        : 'model-download-failed'
    )
    status = failureState.status
    errorCode = failureState.errorCode
  } finally {
    emitState()
  }
}

function prepareModel(): Promise<void> {
  if (modelPreparationPromise) return modelPreparationPromise
  modelPreparationPromise = performModelPreparation().finally(() => {
    modelPreparationPromise = null
  })
  return modelPreparationPromise
}

function refreshDay(sessionId: string, reason: DayRefreshReason, language: 'en' | 'nl') {
  return dayRefreshQueue.refresh(sessionId, reason, language)
}

async function performDayRefresh(sessionId: string, reason: DayRefreshReason, language: 'en' | 'nl') {
  if (isDisposed) throw new Error('agent-interrupted')
  requireNetworkAccess()
  await syncRevinote().catch(() => undefined)
  const session = sessions.find((candidate) => candidate.id === sessionId)
  if (!session) throw new Error('day-not-found')
  const initialSettings = getSettings()
  ambientTaskAuthority.update(initialSettings.liveTaskUpdates && !usesDaySyncProactivity())
  const dayTaskAuthority = ambientTaskAuthority.dayAnalysisToken()
  if (!initialSettings.dayAnalysisProvider) throw new Error('day-analysis-provider-required')
  if (!initialSettings.cloudAnalysisConsent) throw new Error('agent-analysis-consent-required')
  const refreshDeletionEpoch = dataDeletionEpoch
  const refreshSessionDeletionEpoch = sessionDeletionEpochs.get(sessionId) ?? 0
  const refreshWasInvalidated = () =>
    refreshDeletionEpoch !== dataDeletionEpoch ||
    refreshSessionDeletionEpoch !== (sessionDeletionEpochs.get(sessionId) ?? 0)
  const runStartedAt = Date.now()
  const runId = randomUUID()
  const targetThrough =
    reason === 'active-interval' ? completedEvidenceThrough(runStartedAt, session.moments) : runStartedAt
  const provider = initialSettings.dayAnalysisProvider
  const traceDiagnostics: AgentTraceDiagnostic[] = []
  const traceLogs = [
    { timestamp: runStartedAt, message: `Remember-versie ${app.getVersion()}` },
    { timestamp: runStartedAt, message: 'Bronmateriaal verzamelen' },
  ]
  updateSession(sessionId, (candidate) => ({
    ...candidate,
    refresh: {
      status: 'refreshing',
      reason,
      targetThrough,
      error: null,
      progress: {
        phase: 'preparing',
        message: 'Bronmateriaal verzamelen',
        completed: null,
        total: null,
        updatedAt: Date.now(),
        updates: ['Bronmateriaal verzamelen'],
      },
      run: {
        id: runId,
        provider,
        startedAt: runStartedAt,
        completedAt: null,
        durationMs: null,
        status: 'running',
        contextUsed: agentContextUsed(candidate),
        insights: [],
        error: null,
      },
    },
  }))
  recordAgentTrace({
    id: runId,
    action: 'day-refresh',
    provider,
    status: 'running',
    startedAt: runStartedAt,
    completedAt: null,
    dayId: sessionId,
    reason,
    error: null,
    logs: traceLogs,
  })

  try {
    const current = sessions.find((candidate) => candidate.id === sessionId)
    if (!current) throw new Error('daily-review-session-not-found')
    const inFlightDuration =
      current.id === activeSessionId
        ? currentActiveDuration(
            { accumulatedMs: activeDurationMs, trackingSince: activeStartedAt },
            Date.now(),
            powerMonitor.getSystemIdleTime()
          ) - activeDurationMs
        : 0
    const dayAtBoundary =
      current.id === activeSessionId ? { ...current, activeDurationMs: activeDurationMs + inFlightDuration } : current
    const episodes = syncDerivedConversationEpisodes(
      sessionId,
      targetThrough,
      reason === 'end-of-day',
      reason === 'end-of-day' ? 'day-ended' : undefined
    )
    const coverageStartedAt = dayAtBoundary.memory?.coveredThrough ?? dayAtBoundary.startedAt
    const progressUpdates = ['Bronmateriaal verzamelen']
    const settings = getSettings()
    const agentPolicyToken = getAgentLearningPolicyToken()
    const agentEvidenceThrough = Math.min(targetThrough, dayAtBoundary.endedAt ?? targetThrough)
    const assertAnalysisPolicy = () => {
      if (
        !getSettings().cloudAnalysisConsent ||
        getSettings().offlineMode ||
        getAgentLearningPolicyToken() !== agentPolicyToken
      )
        throw new Error('agent-interrupted')
    }
    const analysisWikiPages = await wikiPagesForAnalysis()
    const generatedAnalysis = await generateDayMemory(
      dayAtBoundary,
      reason,
      targetThrough,
      language,
      analysisWikiPages,
      [],
      provider,
      initialSettings.defaultAgentProvider,
      (progress) => {
        if (progressUpdates.at(-1) !== progress.message) {
          const timestamp = Date.now()
          progressUpdates.push(progress.message)
          traceLogs.push({ timestamp, message: progress.message })
          recordAgentTrace({
            id: runId,
            action: 'day-refresh',
            provider,
            status: 'running',
            startedAt: runStartedAt,
            completedAt: null,
            dayId: sessionId,
            reason,
            error: null,
            logs: traceLogs,
          })
        }
        updateSession(sessionId, (candidate) => ({
          ...candidate,
          refresh:
            candidate.refresh.status === 'refreshing'
              ? {
                  ...candidate.refresh,
                  progress: {
                    ...progress,
                    updatedAt: Date.now(),
                    updates: progressUpdates.slice(-3),
                  },
                }
              : candidate.refresh,
        }))
      },
      (diagnostic) => traceDiagnostics.push(diagnostic),
      agentActivityEvidence(
        readAgentLearningEvents({ after: dayAtBoundary.startedAt, through: agentEvidenceThrough }),
        {
          after: dayAtBoundary.startedAt,
          through: agentEvidenceThrough,
          recordedThrough: targetThrough,
        }
      )
    )
    assertAnalysisPolicy()
    const generatedMemory = generatedAnalysis.memory
    if (refreshWasInvalidated()) throw new Error('day-refresh-invalidated-by-deletion')
    await persistRecognizedConversationAudio(dayAtBoundary, episodes, generatedMemory, targetThrough)
    if (refreshWasInvalidated()) throw new Error('day-refresh-invalidated-by-deletion')
    progressUpdates.push('Dag wordt bijgewerkt')
    traceLogs.push({ timestamp: Date.now(), message: 'Dag wordt bijgewerkt' })
    updateSession(sessionId, (candidate) => ({
      ...candidate,
      refresh:
        candidate.refresh.status === 'refreshing'
          ? {
              ...candidate.refresh,
              progress: {
                phase: 'saving',
                message: 'Dag wordt bijgewerkt',
                completed: null,
                total: null,
                updatedAt: Date.now(),
                updates: progressUpdates.slice(-3),
              },
            }
          : candidate.refresh,
    }))
    const refreshedAt = Date.now()
    const routedConversations = routeNewFinishedConversationsToRevinote({
      enabled: settings.automaticRevinoteProcessing,
      previous: dayAtBoundary.memory?.conversations ?? [],
      generated: generatedMemory.conversations,
      episodes,
    })
    let appliedKnowledge: typeof generatedMemory.knowledgeSuggestions = []
    let retainedKnowledge = generatedMemory.knowledgeSuggestions
    let wikiCoveredThrough = generatedMemory.wikiCoveredThrough
    try {
      assertAnalysisPolicy()
      appliedKnowledge = await applyKnowledgeUpdatesByProject(
        sessionId,
        refreshedAt,
        generatedMemory.knowledgeSuggestions,
        { sourceId: `daily-review://${sessionId}`, expectedPages: analysisWikiPages }
      )
      retainedKnowledge = appliedKnowledge
    } catch (error) {
      wikiCoveredThrough = dayAtBoundary.memory?.wikiCoveredThrough ?? dayAtBoundary.startedAt - 1
      console.error('[day] Wiki update deferred; completing the Day refresh', error)
      const message = 'Wiki bijwerken uitgesteld'
      progressUpdates.push(message)
      traceLogs.push({ timestamp: Date.now(), message })
    }
    assertAnalysisPolicy()
    if (refreshWasInvalidated()) throw new Error('day-refresh-invalidated-by-deletion')
    const store = getEvidenceStore()
    ambientTaskAuthority.update(getSettings().liveTaskUpdates && !usesDaySyncProactivity())
    const dayMayApplyTasks = ambientTaskAuthority.canApplyDayAnalysis(dayTaskAuthority)
    const workItemChanges = !dayMayApplyTasks
      ? { created: 0, updated: 0, closed: 0 }
      : store.applyAnalyzedWorkItems({
          workdayId: sessionId,
          plan: generatedAnalysis.workItems,
          conversations: generatedMemory.conversations,
          analysisStartedAt: runStartedAt,
          observedAt: refreshedAt,
        })
    store.synchronizeConversationActionPoints({
      workdayId: sessionId,
      conversations: generatedMemory.conversations,
      observedAt: refreshedAt,
      createMissing: dayMayApplyTasks,
    })
    const reconciliationContext = await store.readContextMomentsAsync(sessionId)
    assertAnalysisPolicy()
    if (refreshWasInvalidated()) throw new Error('day-refresh-invalidated-by-deletion')
    updateSession(sessionId, (candidate) => {
      const timeline = reconcileTimelineItems(candidate, generatedMemory.timeline, candidate.memory)
      const previousMemory = candidate.memory
      return {
        ...candidate,
        memory: {
          ...generatedMemory,
          timeline,
          timelineOverrides: previousMemory?.timelineOverrides ?? [],
          hiddenTimelineItemIds: previousMemory?.hiddenTimelineItemIds ?? [],
          knowledgeSuggestions: retainedKnowledge,
          wikiCoveredThrough,
          conversations: preserveManualMeetingConversations(
            previousMemory?.conversations ?? [],
            applyManualMeetingMetadata(
              candidate.id,
              attachConfirmedConversationParticipants(
                candidate.startedAt,
                reconcileEpisodeConversationSummaries(
                  candidate.startedAt,
                  previousMemory?.conversations ?? [],
                  routedConversations,
                  previousMemory?.deletedConversationWindows
                ) ??
                  reconcileLivingConversations(
                    candidate.startedAt,
                    previousMemory?.conversations ?? [],
                    routedConversations,
                    candidate.moments,
                    previousMemory?.deletedConversationWindows,
                    targetThrough,
                    generatedMemory.classifiedNonConversationWindows
                  ),
                reconciliationContext
              )
            )
          ),
          classifiedNonConversationWindows: generatedMemory.classifiedNonConversationWindows ?? [],
          deletedConversationWindows: previousMemory?.deletedConversationWindows ?? [],
          refreshedAt,
          coveredThrough: targetThrough,
        },
        refresh: {
          status: 'idle',
          reason: null,
          targetThrough: null,
          error: null,
          progress: null,
          run: candidate.refresh.run
            ? {
                ...candidate.refresh.run,
                completedAt: refreshedAt,
                durationMs: refreshedAt - candidate.refresh.run.startedAt,
                status: 'completed',
                insights: memoryInsights(
                  { ...generatedMemory, knowledgeSuggestions: appliedKnowledge },
                  workItemChanges.created
                ),
                error: null,
              }
            : null,
        },
      }
    })
    const refreshedSession = sessions.find((candidate) => candidate.id === sessionId)
    if (refreshedSession) {
      writeTimelineArtifacts(
        refreshedSession,
        { startedAt: coverageStartedAt, endedAt: targetThrough },
        dailyReviewDirectory()
      )
      queueAutomaticRevinoteProcessing()
    }
    recordAgentTrace({
      id: runId,
      action: 'day-refresh',
      provider,
      status: 'completed',
      startedAt: runStartedAt,
      completedAt: refreshedAt,
      dayId: sessionId,
      reason,
      error: null,
      logs: traceLogs,
    })
    reconcileProactiveDaySync(sessionId)
    void ambientTaskWorker?.tick()
    emitMemoryChanged()
  } catch (error) {
    if (error instanceof Error && error.message === 'day-refresh-invalidated-by-deletion') return session
    console.error('[day] refresh failed', error)
    const failedAt = Date.now()
    const errorCode = classifyAgentError(error)
    reportAgentFailure({ error, errorCode, provider, reason, diagnostics: traceDiagnostics })
    const failureDetail = agentErrorDetail(error, errorCode)
    if (failureDetail) traceLogs.push({ timestamp: failedAt, message: `Agentdetail: ${failureDetail}` })
    updateSession(sessionId, (candidate) => ({
      ...candidate,
      refresh: {
        status: 'failed',
        reason,
        targetThrough,
        error: errorCode,
        progress: null,
        run: candidate.refresh.run
          ? {
              ...candidate.refresh.run,
              completedAt: failedAt,
              durationMs: failedAt - candidate.refresh.run.startedAt,
              status: 'failed',
              error: errorCode,
            }
          : null,
      },
    }))
    recordAgentTrace({
      id: runId,
      action: 'day-refresh',
      provider,
      status: 'failed',
      startedAt: runStartedAt,
      completedAt: failedAt,
      dayId: sessionId,
      reason,
      error: errorCode,
      logs: traceLogs,
      diagnostics: traceDiagnostics,
    })
  }

  const updated = sessions.find((candidate) => candidate.id === sessionId)
  if (!updated) throw new Error('day-not-found')
  return updated
}

function deleteSession(sessionId: string) {
  const session = sessions.find((candidate) => candidate.id === sessionId)
  if (!session) return sessions
  if (session.id === activeSessionId || dayRefreshQueue.has(session.id)) {
    throw new Error('daily-review-session-busy')
  }

  removeStoredSession(session.id)
  removeConversationAudioForWorkdayAt(dailyReviewDirectory(), session.id)
  speechActivityIntervals.delete(session.id)
  removeKnowledgeForSession(session.id)
  sessions = sessions.filter((candidate) => candidate.id !== session.id)
  persistSessions()
  return sessions
}

function sessionHasRecentDerivedOrSourceData(session: DailyReviewSession, cutoff: number) {
  return (
    (session.memory?.coveredThrough ?? 0) > cutoff ||
    session.contextMoments.some((moment) => moment.timestamp >= cutoff) ||
    session.moments.some((moment) => moment.startedAt + moment.durationMs > cutoff) ||
    session.appActivity.some(
      (activity) => activity.startedAt >= cutoff || activity.endedAt == null || activity.endedAt > cutoff
    )
  )
}

async function clearRecentCapture(cutoff: number) {
  if (!Number.isFinite(cutoff) || cutoff <= 0 || cutoff < Date.now() - 31 * 24 * 60 * 60_000) {
    throw new Error('invalid-clear-cutoff')
  }
  dataDeletionEpoch += 1
  const captureProcesses = [microphoneAudioCaptureProcess, systemAudioCaptureProcess, contextCaptureProcess]
  updateSettings({
    capturePaused: true,
    capturePausedUntil: null,
    capturePauseSources: [...ALL_CAPTURE_PAUSE_SOURCES],
  })
  status = 'paused'
  stopMicrophoneEngine()
  stopSystemAudioEngine()
  stopContextEngine()
  try {
    await Promise.all(captureProcesses.map((child) => waitForCaptureProcess(child, true)))
    await waitForTranscriptionsToSettle()
    if (activeSessionId) await flushAudioTranscriptionStreams(activeSessionId)
    clearTemporaryCapture()
    flushDeferredSessions()

    for (const session of sessions) {
      if (!sessionHasRecentDerivedOrSourceData(session, cutoff)) continue
      removeConversationAudioSinceAt(
        dailyReviewDirectory(),
        session.id,
        session.moments,
        getEvidenceStore().listConversationEpisodes(session.id),
        cutoff
      )
    }

    const clearedManualMeeting = manualMeeting
    const affectedIds = new Set([
      ...sessions
        .filter((session) => sessionHasRecentDerivedOrSourceData(session, cutoff))
        .map((session) => session.id),
      ...getEvidenceStore().deleteEvidenceSince(cutoff),
    ])
    if (clearedManualMeeting && (clearedManualMeeting.endedAt == null || clearedManualMeeting.endedAt > cutoff)) {
      manualMeeting = null
      restorePauseAfterManualMeeting = false
    }
    sessions = sessions.map((session) => {
      if (!affectedIds.has(session.id)) return session
      return {
        ...session,
        moments: session.moments.filter((moment) => moment.startedAt + moment.durationMs <= cutoff),
        contextMoments: session.contextMoments.filter((moment) => moment.timestamp < cutoff),
        appActivity: session.appActivity
          .filter((activity) => activity.startedAt < cutoff)
          .map((activity) => ({
            ...activity,
            endedAt: activity.endedAt == null || activity.endedAt > cutoff ? cutoff : activity.endedAt,
          })),
        memory: null,
        refresh: {
          status: 'idle' as const,
          reason: null,
          targetThrough: null,
          error: null,
          progress: null,
          run: null,
        },
      }
    })
    persistSessions()
    let knowledgeCleanupError: unknown = null
    for (const sessionId of affectedIds) {
      try {
        removeKnowledgeForSession(sessionId)
      } catch (error) {
        knowledgeCleanupError ??= error
      }
    }
    if (knowledgeCleanupError) throw knowledgeCleanupError
  } finally {
    emitState()
  }
  return sessions
}

function latestEvidenceAt(day: DailyReviewSession) {
  const latestAudio = day.moments.reduce(
    (latest, moment) => Math.max(latest, moment.startedAt + moment.durationMs),
    day.startedAt
  )
  const latestContext = day.contextMoments.reduce((latest, moment) => Math.max(latest, moment.timestamp), day.startedAt)
  const latestActivity = day.appActivity.reduce(
    (latest, activity) => Math.max(latest, activity.endedAt ?? activity.startedAt),
    day.startedAt
  )
  const latestAgent = latestAgentLearningEventAt({ after: day.startedAt, through: day.endedAt ?? Date.now() })
  return Math.max(latestAudio, latestContext, latestActivity, latestAgent ?? day.startedAt)
}

async function refreshDayIfAvailable(sessionId: string, reason: DayRefreshReason) {
  if (isOfflineMode()) return 'skipped' as const
  const settings = getSettings()
  if (!settings.frequentDayRefresh && (reason === 'downtime' || reason === 'active-interval')) return 'skipped' as const
  if (!settings.dayAnalysisProvider) return 'skipped' as const
  if (
    !settings.cloudAnalysisConsent ||
    agentSetup.provider !== settings.dayAnalysisProvider ||
    agentSetup.status !== 'ready'
  ) {
    return 'skipped' as const
  }
  const day = sessions.find((candidate) => candidate.id === sessionId)
  if (!day) return 'skipped' as const
  if (reason !== 'active-interval' && day.moments.some((moment) => moment.status === 'transcribing'))
    return 'skipped' as const
  const latestEvidence =
    reason === 'active-interval'
      ? Math.min(latestEvidenceAt(day), completedEvidenceThrough(Date.now(), day.moments))
      : latestEvidenceAt(day)
  if (latestEvidence <= (day.memory?.coveredThrough ?? day.startedAt) && !hasPendingDayWikiReview(day.memory))
    return 'skipped' as const
  await refreshDay(sessionId, reason, getInterfaceLocale())
  return sessions.find((candidate) => candidate.id === sessionId)?.refresh.status === 'idle'
    ? ('completed' as const)
    : ('failed' as const)
}

function considerDowntimeRefresh() {
  const now = Date.now()
  const settings = getSettings()
  const refreshIntervalMs = frequentRefreshIntervalMs(settings.frequentDayRefreshIntervalMinutes)
  if (!isOfflineMode() && settings.frequentDayRefresh) {
    const pendingWikiDay = nextDayWithPendingWikiReview(sessions, now, refreshIntervalMs)
    if (pendingWikiDay) {
      queueAutomaticDayRefresh(pendingWikiDay.id, pendingWikiDay.endedAt === null ? 'active-interval' : 'end-of-day')
    }
  }
  if (!activeSessionId) return
  const userIdleSeconds = powerMonitor.getSystemIdleTime()
  const wasTrackingActiveTime = activeStartedAt != null
  checkpointActiveDuration(activeSessionId, now, userIdleSeconds)
  if (userIdleSeconds * 1_000 >= ACTIVE_DURATION_IDLE_LIMIT_MS) {
    closeCurrentAppActivity(activeUntil(now, userIdleSeconds))
    if (wasTrackingActiveTime && activeStartedAt == null) emitState()
  }
  const day = sessions.find((candidate) => candidate.id === activeSessionId)
  if (!day) return
  if (isOfflineMode() || pendingAutomaticDayRefresh) return
  const coveredThrough = day.memory?.coveredThrough ?? day.startedAt
  if (
    settings.frequentDayRefresh &&
    shouldRefreshDuringFrequentInterval({
      isRefreshing: day.refresh.status === 'refreshing',
      now,
      lastRefreshAt: Math.max(day.memory?.refreshedAt ?? day.startedAt, day.refresh.run?.startedAt ?? day.startedAt),
      refreshIntervalMs,
      latestEvidenceAt: Math.min(latestEvidenceAt(day), completedEvidenceThrough(now, day.moments)),
      coveredThrough,
      requiredNewEvidenceMs: Math.min(refreshIntervalMs, MIN_NEW_EVIDENCE_MS),
    })
  ) {
    queueAutomaticDayRefresh(day.id, 'active-interval')
    return
  }
  if (
    !shouldRefreshDuringDowntime({
      isRecording: status === 'recording',
      isRefreshing: day.refresh.status === 'refreshing',
      hasPendingTranscription: day.moments.some((moment) => moment.status === 'transcribing'),
      userIdleSeconds,
      lastMeaningfulSpeechAt,
      now,
      lastRefreshAt: lastRefreshAttemptAt(day),
      refreshIntervalMs,
      latestEvidenceAt: latestEvidenceAt(day),
      coveredThrough,
      requiredIdleSeconds: DOWNTIME_IDLE_SECONDS,
      requiredSpeechSilenceMs: DOWNTIME_SPEECH_SILENCE_MS,
      requiredNewEvidenceMs: MIN_NEW_EVIDENCE_MS,
    })
  ) {
    return
  }
  void refreshDayIfAvailable(day.id, 'downtime')
}

function queueAutomaticDayRefresh(sessionId: string, reason: DayRefreshReason) {
  if (pendingAutomaticDayRefresh) return
  if (isDisposed) return
  pendingAutomaticDayRefresh = refreshDayIfAvailable(sessionId, reason)
    .then(() => undefined)
    .catch((error) => console.error('[day] automatic refresh failed', error))
    .finally(() => {
      pendingAutomaticDayRefresh = null
    })
}

async function waitForTranscriptionsToSettle() {
  let pendingTranscriptions = transcriptionQueue
  await pendingTranscriptions
  while (pendingTranscriptions !== transcriptionQueue) {
    pendingTranscriptions = transcriptionQueue
    await pendingTranscriptions
  }
}

function startDowntimeRefreshTimer() {
  if (downtimeRefreshTimer) return
  downtimeRefreshTimer = setInterval(considerDowntimeRefresh, DOWNTIME_CHECK_INTERVAL_MS)
}

function clearDowntimeRefreshTimer() {
  if (!downtimeRefreshTimer) return
  clearInterval(downtimeRefreshTimer)
  downtimeRefreshTimer = null
}

async function performAutomaticCapture(): Promise<void> {
  await Promise.all([refreshPermissionStatuses(), refreshAgentStatus()])
  if (isDisposing || isDisposed || manualMeetingStarting || manualMeeting != null) return
  const settings = getSettings()
  const scheduleStatus = getCaptureScheduleStatus(settings.captureSchedule)
  scheduleCaptureCheck()
  if (
    settings.audioCaptureEnabled &&
    isModelDownloaded() &&
    status === 'idle' &&
    microphonePermissionStatus() === 'granted' &&
    accessibilityPermission === 'granted' &&
    !restartRequired &&
    systemAudioCheckStatus !== 'ready'
  ) {
    await verifySystemAudio()
  }
  if (settings.capturePaused) {
    if (settings.capturePausedUntil != null && settings.capturePausedUntil <= Date.now()) {
      updateSettings({ capturePaused: false, capturePausedUntil: null })
    } else if (areAllSourcesPaused(settings)) {
      scheduleTimedResume(settings.capturePausedUntil)
      if (status === 'idle') {
        status = 'paused'
        errorCode = null
        emitState()
      }
      return
    } else {
      scheduleTimedResume(settings.capturePausedUntil)
    }
  }
  if (!scheduleStatus.isAllowed) {
    if (status === 'recording') pauseRecorder()
    else if (status === 'idle') {
      status = 'paused'
      errorCode = null
      emitState()
    }
    return
  }
  if (status === 'paused') {
    await resumeSession(false)
    return
  }
  if ((settings.audioCaptureEnabled && !isModelDownloaded()) || status !== 'idle') return

  if (hasRequiredPermissions()) await startSession()
}

async function reconcileCaptureSchedule(): Promise<void> {
  const settings = getSettings()
  const scheduleStatus = getCaptureScheduleStatus(settings.captureSchedule)
  scheduleCaptureCheck()
  const action = captureScheduleAction({
    status,
    isAllowed: scheduleStatus.isAllowed,
    isManuallyPaused: areAllSourcesPaused(settings),
  })

  if (action === 'pause') {
    pauseRecorder()
    return
  }
  if (action === 'resume') {
    await resumeSession(false)
    return
  }
  if (action === 'start') {
    await startAutomaticCapture()
    return
  }
  emitState()
}

function handleSystemInactive(): void {
  if (status !== 'recording' || !activeSessionId) return
  checkpointActiveDuration(activeSessionId)
  activeStartedAt = null
  closeCurrentAppActivity()
  emitState()
}

function handleSystemResume(): void {
  if (status === 'recording' && activeStartedAt == null) activeStartedAt = Date.now()
  void reconcileCaptureSchedule()
}

function startAutomaticCapture(): Promise<void> {
  if (manualMeetingStarting || manualMeeting != null) return Promise.resolve()
  if (!hasCompletedOnboarding(getSettings())) return Promise.resolve()
  if (!captureAllowed()) return Promise.resolve()
  if (status === 'recording') {
    reconcileSourceEngines()
    return Promise.resolve()
  }
  if (automaticCapturePromise) return automaticCapturePromise
  automaticCapturePromise = performAutomaticCapture().finally(() => {
    automaticCapturePromise = null
  })
  return automaticCapturePromise
}

export function rememberContextForWorkItem(itemId: string) {
  const item = getEvidenceStore().getWorkItem(itemId)
  return item ? buildWorkItemAgentContext(item) : ''
}

async function startManualMeetingCapture(): Promise<DailyReviewState> {
  if (
    isDisposing ||
    isDisposed ||
    manualMeeting != null ||
    manualMeetingStarting ||
    manualMeetingDiscarding ||
    status === 'stopping'
  ) {
    return buildState()
  }
  const audioWasRunning = status === 'recording' && !isSourcePaused('audio') && shouldRunAudioEngines()
  manualMeetingStarting = true
  errorCode = null
  const captureStatusBeforeStart = status
  try {
    if (!isModelDownloaded()) {
      status = 'error'
      errorCode = 'model-required'
      emitState()
      return buildState()
    }
    await refreshPermissionStatuses()
    if (isDisposing || isDisposed) return buildState()
    if (microphonePermissionStatus() !== 'granted') {
      status = 'error'
      errorCode = 'microphone-permission'
      emitState()
      return buildState()
    }
    if (!(await ensureCapturePermissions())) return buildState()
    if (isDisposing || isDisposed) return buildState()

    // Finish old capture handles before requesting the manual recording cadence.
    const previousCaptures = [microphoneAudioCaptureProcess, systemAudioCaptureProcess]
    stopMicrophoneEngine()
    stopSystemAudioEngine()
    await Promise.all(previousCaptures.map((child) => waitForCaptureProcess(child)))
    if (isDisposing || isDisposed) return buildState()
    microphoneName = null
    systemAudioReady = false
    restorePauseAfterManualMeeting = status === 'paused' || areAllSourcesPaused()
    if (status === 'paused') status = 'idle'
    if (status === 'idle') await startSession()
    if (!isDisposing && !isDisposed && activeSessionId && status === 'recording') {
      const confirmedAt = Date.now()
      const episodesAtConfirmation = syncDerivedConversationEpisodes(activeSessionId, confirmedAt)
      const availableFromAt = manualMeetingAvailableFromAt({
        confirmedAt,
        episodes: episodesAtConfirmation,
        audioWasRunning,
      })
      reconcileSourceEngines()
      const audioReadinessStartedAt = Date.now()
      const audioReadiness = await waitForManualMeetingAudioReadiness({
        ready: () => manualMeetingAudioStreamsReady(microphoneName, systemAudioReady),
        cancelled: () => isDisposing || isDisposed || status !== 'recording' || !activeSessionId,
      })
      if (audioReadiness === 'ready' && !isDisposing && !isDisposed) {
        manualMeeting = getEvidenceStore().createManualMeeting(
          activeSessionId,
          manualMeetingTitle(availableFromAt, getInterfaceLocale()),
          availableFromAt,
          confirmedAt,
          availableFromAt,
          systemAudioReady
        )
        getEvidenceStore().appendCallSignal({
          id: `manual-meeting:${manualMeeting.id}:active`,
          workdayId: activeSessionId,
          provider: 'manual',
          surfaceKey: `manual:${manualMeeting.id}`,
          state: 'active',
          observedAt: confirmedAt,
        })
        emitState()
      } else if (audioReadiness === 'timed-out' && !isDisposing && !isDisposed) {
        errorCode =
          manualMeetingAudioReadinessError(microphoneName, systemAudioReady) ?? 'manual-meeting-audio-not-ready'
        reportAppError(new Error(errorCode), {
          area: 'manual-recording',
          code: errorCode,
          diagnostics: {
            elapsed_ms: Date.now() - audioReadinessStartedAt,
            microphone_ready: Boolean(microphoneName),
            system_audio_ready: systemAudioReady,
          },
        })
        emitState()
      }
    }
  } finally {
    manualMeetingStarting = false
    if (!manualMeeting && status === 'recording' && !isDisposing && !isDisposed) {
      if (captureStatusBeforeStart === 'paused') {
        pauseRecorder()
      } else if (captureStatusBeforeStart === 'idle') {
        accrueActiveDuration()
        stopMicrophoneEngine()
        stopSystemAudioEngine()
        stopContextEngine()
        finalizeActiveSession()
        status = 'idle'
        emitState()
      } else {
        reconcileSourceEngines()
      }
      restorePauseAfterManualMeeting = false
    }
  }
  return buildState()
}

function pauseManualMeetingCapture(meetingId: string): DailyReviewState {
  if (
    manualMeetingDiscarding ||
    !manualMeeting ||
    manualMeeting.id !== meetingId ||
    manualMeeting.status !== 'recording'
  ) {
    throw new Error('manual-meeting-not-active')
  }
  if (manualMeeting.pausedAt != null) return buildState()
  const pausedAt = Date.now()
  const sessionId = activeSessionId
  const captureProcesses = [microphoneAudioCaptureProcess, systemAudioCaptureProcess]
  manualMeeting = getEvidenceStore().pauseManualMeeting(meetingId, pausedAt)
  reconcileSourceEngines()
  if (sessionId) {
    if (!shouldRunAudioEngines() || isSourcePaused('audio')) {
      finishPausedAudioCapture(sessionId, captureProcesses, pausedAt)
    } else {
      void transcriptionQueue.then(() => syncDerivedConversationEpisodes(sessionId, pausedAt, true, 'capture-paused'))
    }
  }
  emitState()
  return buildState()
}

function updateManualMeetingCaptureStart(meetingId: string, startedAt: number): DailyReviewState {
  if (
    manualMeetingDiscarding ||
    !manualMeeting ||
    manualMeeting.id !== meetingId ||
    manualMeeting.status !== 'recording'
  ) {
    throw new Error('manual-meeting-not-active')
  }
  manualMeeting = getEvidenceStore().updateManualMeetingStart(meetingId, startedAt)
  emitState()
  return buildState()
}

async function resumeManualMeetingCapture(meetingId: string): Promise<DailyReviewState> {
  if (
    manualMeetingDiscarding ||
    !manualMeeting ||
    manualMeeting.id !== meetingId ||
    manualMeeting.status !== 'recording'
  ) {
    throw new Error('manual-meeting-not-active')
  }
  if (manualMeeting.pausedAt == null) return buildState()
  if (!(await ensureCapturePermissions())) return buildState()
  if (
    manualMeetingDiscarding ||
    !manualMeeting ||
    manualMeeting.id !== meetingId ||
    manualMeeting.status !== 'recording'
  ) {
    throw new Error('manual-meeting-not-active')
  }
  const resumedAt = Date.now()
  manualMeeting = getEvidenceStore().resumeManualMeeting(meetingId, resumedAt)
  reconcileSourceEngines()
  emitState()
  return buildState()
}

function persistManualMeetingEpisode(meeting: ManualMeeting) {
  if (meeting.endedAt == null) return meeting
  const episodes = getEvidenceStore().listConversationEpisodes(meeting.workdayId)
  const meetingEpisode = manualMeetingEpisode(
    meeting,
    episodes,
    isOfflineMode(),
    getEvidenceStore().listSpeechSegments(meeting.workdayId)
  )
  try {
    getEvidenceStore().upsertManualMeetingEpisode(meetingEpisode)
    return getEvidenceStore().setManualMeetingEpisode(meeting.id, meetingEpisode.id)
  } catch (error) {
    console.warn('[manual-meeting] failed to persist the recording episode before analysis', {
      meetingId: meeting.id,
      episodeId: meetingEpisode.id,
      error,
    })
    return meeting
  }
}

async function assembleManualMeetingAudio(meeting: ManualMeeting) {
  const meetingWithEpisode = persistManualMeetingEpisode(meeting)
  const session = sessions.find((candidate) => candidate.id === meeting.workdayId)
  const meetingEpisode = meetingWithEpisode.episodeId
    ? getEvidenceStore()
        .listConversationEpisodes(meeting.workdayId)
        .find((episode) => episode.id === meetingWithEpisode.episodeId && episode.deletedAt == null)
    : null
  if (!session || !meetingEpisode) return meetingWithEpisode
  try {
    await renderConversationAudioAsyncAt(dailyReviewDirectory(), meetingEpisode, session.moments, { compactGaps: true })
  } catch (error) {
    console.warn('[manual-meeting] failed to assemble captured audio before analysis', {
      meetingId: meeting.id,
      episodeId: meetingEpisode.id,
      error,
    })
  }
  return meetingWithEpisode
}

function manualMeetingProcessingProvider(meeting: ManualMeeting) {
  const existing = sessions
    .find((session) => session.id === meeting.workdayId)
    ?.memory?.conversations.find((conversation) => conversation.manualMeetingId === meeting.id)?.processingProvider
  return selectManualMeetingProcessingProvider({
    automaticRevinoteProcessing: getSettings().automaticRevinoteProcessing,
    existing,
    offlineMode: isOfflineMode(),
    automaticRevinoteProcessingBlocked: meeting.automaticRevinoteProcessingBlocked,
  })
}

function publishManualMeetingConversation(meeting: ManualMeeting) {
  const store = getEvidenceStore()
  const recordingSource = manualMeetingRecordingSource(
    meeting,
    store.listConversationEpisodes(meeting.workdayId).find((episode) => episode.id === meeting.episodeId),
    store.listSpeechSegments(meeting.workdayId)
  )
  let published = false
  updateSession(meeting.workdayId, (session) => {
    published = true
    return {
      ...session,
      memory: memoryWithManualMeetingConversation(
        session,
        meeting,
        manualMeetingProcessingProvider(meeting),
        recordingSource
      ),
    }
  })
  return published
}

function finishManualMeetingConversation(
  meeting: ManualMeeting,
  processingError?: ConversationSummary['processingError']
) {
  updateSession(meeting.workdayId, (session) =>
    session.memory
      ? { ...session, memory: memoryWithFinishedManualMeetingConversation(session.memory, meeting.id, processingError) }
      : session
  )
}

function failAutomaticRevinoteProcessing(
  sessionId: string,
  conversation: ConversationSummary,
  retryAutomatically: boolean
) {
  updateSession(sessionId, (session) =>
    session.memory
      ? {
          ...session,
          memory: {
            ...session.memory,
            conversations: session.memory.conversations.map((candidate) =>
              candidate.episodeId === conversation.episodeId && candidate.source !== 'revinote'
                ? failedAutomaticRevinoteConversation(candidate, retryAutomatically)
                : candidate
            ),
          },
        }
      : session
  )
  if (conversation.manualMeetingId && !retryAutomatically) {
    getEvidenceStore().completeManualMeeting(conversation.manualMeetingId)
  }
}

function settleFailedRevinoteProcessing(sourceSessions: DailyReviewSession[]) {
  const failedEpisodeIds = new Set(getFailedRevinotePostProcesses().map((failure) => failure.episodeId))
  if (failedEpisodeIds.size === 0) return sourceSessions
  const completedManualMeetings = new Map<string, string>()
  const settled = sourceSessions.map((session) => {
    if (!session.memory) return session
    let changed = false
    const conversations = session.memory.conversations.map((conversation) => {
      if (
        !conversation.episodeId ||
        !failedEpisodeIds.has(conversation.episodeId) ||
        conversation.processingProvider !== 'revinote'
      ) {
        return conversation
      }
      changed = true
      if (conversation.manualMeetingId) completedManualMeetings.set(conversation.manualMeetingId, session.id)
      return failedAutomaticRevinoteConversation(conversation, false)
    })
    return changed ? { ...session, memory: { ...session.memory, conversations } } : session
  })
  const store = getEvidenceStore()
  for (const [meetingId, workdayId] of completedManualMeetings) {
    if (store.listManualMeetings(workdayId).some((meeting) => meeting.id === meetingId)) {
      store.completeManualMeeting(meetingId)
    }
  }
  return settled
}

function recordRevinoteMeetingIdentity(sessionId: string, episodeId: string, meetingId: string) {
  updateSession(sessionId, (session) =>
    session.memory
      ? {
          ...session,
          memory: {
            ...session.memory,
            conversations: session.memory.conversations.map((conversation) =>
              conversation.episodeId === episodeId && conversation.source !== 'revinote'
                ? {
                    ...conversation,
                    externalId: meetingId,
                    processing: 'processing',
                    processingProvider: 'revinote',
                    processingError: undefined,
                  }
                : conversation
            ),
          },
        }
      : session
  )
}

function postProcessAutomaticallyWithRevinote(
  sessionId: string,
  conversation: ConversationSummary,
  episode: ConversationEpisode
) {
  const existing = automaticRevinoteSubmissions.get(episode.id)
  if (existing) return existing
  const submission = (async () => {
    const startedAt = Date.now()
    try {
      const connection = getRevinoteConnectionStatus()
      if (!connection.canPostProcess && connection.state === 'connected') {
        throw new Error('revinote-permission-required')
      }
      if (connection.state !== 'connected' || !connection.canPostProcess) {
        throw new Error('revinote-automatic-processing-unavailable')
      }
      const audioPath = resolveConversationAudioFile(sessionId, episode.id)
      if (!audioPath) throw new Error('conversation-audio-not-found')
      const durationSeconds = conversationAudioDurationSecondsAt(audioPath)
      if (durationSeconds == null) throw new Error('conversation-audio-not-found')
      const result = await postProcessConversationWithRevinote({
        episodeId: episode.id,
        audioPath,
        durationSeconds,
        recordedAt: new Date(episode.startedAt).toISOString(),
      })
      recordRevinoteMeetingIdentity(sessionId, episode.id, result.meetingId)
      if (conversation.manualMeetingId) {
        getEvidenceStore().completeManualMeeting(conversation.manualMeetingId)
      }
      return true
    } catch (error) {
      const retryAutomatically = !isTerminalAutomaticRevinoteError(error)
      const report = automaticRevinoteFailureReport(error, {
        retryAutomatically,
        elapsedMs: Date.now() - startedAt,
        interrupted: isDisposing || isDisposed || isOfflineMode(),
      })
      if (report) reportAppError(error, report)
      console.error('[revinote] automatic conversation processing failed', {
        episodeId: episode.id,
        retryAutomatically,
        error,
      })
      failAutomaticRevinoteProcessing(sessionId, conversation, retryAutomatically)
      return false
    }
  })().finally(() => automaticRevinoteSubmissions.delete(episode.id))
  automaticRevinoteSubmissions.set(episode.id, submission)
  return submission
}

async function processAutomaticRevinoteCandidates() {
  if (isDisposed || isOfflineMode()) return
  const connection = getRevinoteConnectionStatus()
  if (connection.state === 'connecting') return
  for (const session of sessions) {
    const episodes = getEvidenceStore().listConversationEpisodes(session.id)
    const candidates = automaticRevinoteCandidates(session.memory?.conversations ?? [], episodes)
    for (const { conversation, episode } of candidates) {
      if (!resolveConversationAudioFile(session.id, episode.id)) continue
      await postProcessAutomaticallyWithRevinote(session.id, conversation, episode).catch((error) => {
        console.error('[revinote] automatic conversation processing deferred', { episodeId: episode.id, error })
      })
    }
  }
}

export function queueAutomaticRevinoteProcessing() {
  if (isOfflineMode()) return automaticRevinoteProcessingQueue
  automaticRevinoteProcessingQueue = automaticRevinoteProcessingQueue
    .catch((error) => console.error('[revinote] previous automatic processing pass failed', error))
    .then(() => processAutomaticRevinoteCandidates())
  return automaticRevinoteProcessingQueue
}

function canContinueManualMeetingProcessing(meeting: ManualMeeting) {
  if (isDisposed) return false
  const persisted = getEvidenceStore()
    .listManualMeetings(meeting.workdayId)
    .find((candidate) => candidate.id === meeting.id)
  const episode = persisted?.episodeId
    ? getEvidenceStore()
        .listConversationEpisodes(meeting.workdayId)
        .find((candidate) => candidate.id === persisted.episodeId)
    : undefined
  return episode?.deletedAt == null && manualMeetingStillProcessing(meeting.id, persisted)
}

async function finalizeManualMeetingProcessing(meeting: ManualMeeting) {
  if (!canContinueManualMeetingProcessing(meeting)) return
  const assembledMeeting = meeting
  const session = sessions.find((candidate) => candidate.id === assembledMeeting.workdayId)
  const conversation = session?.memory?.conversations.find(
    (candidate) => candidate.manualMeetingId === assembledMeeting.id
  )
  if (
    !assembledMeeting.episodeId ||
    !resolveConversationAudioFile(assembledMeeting.workdayId, assembledMeeting.episodeId)
  ) {
    finishManualMeetingConversation(assembledMeeting, 'audio')
    getEvidenceStore().completeManualMeeting(assembledMeeting.id)
    return
  }
  if (isOfflineMode()) {
    finishManualMeetingConversation(assembledMeeting)
    getEvidenceStore().completeManualMeeting(assembledMeeting.id)
    return
  }
  if (conversation?.processingProvider === 'revinote' && assembledMeeting.episodeId) {
    const episode = getEvidenceStore()
      .listConversationEpisodes(assembledMeeting.workdayId)
      .find((candidate) => candidate.id === assembledMeeting.episodeId && candidate.deletedAt == null)
    if (episode) {
      await postProcessAutomaticallyWithRevinote(assembledMeeting.workdayId, conversation, episode)
      return
    }
  }
  const result = await refreshDayIfAvailable(assembledMeeting.workdayId, 'manual').catch((error) => {
    console.error('[manual-meeting] post-recording refresh failed', error)
    return 'failed' as const
  })
  if (!canContinueManualMeetingProcessing(meeting)) return
  finishManualMeetingConversation(assembledMeeting, result === 'failed' ? 'analysis' : undefined)
  getEvidenceStore().completeManualMeeting(assembledMeeting.id)
}

function queueManualMeetingProcessing(meeting: ManualMeeting, transcriptionReady: Promise<void> = Promise.resolve()) {
  const transcribed = transcriptionReady
    .then(() => {
      if (isDisposed) return
      const store = getEvidenceStore()
      const persisted = store.listManualMeetings(meeting.workdayId).find((candidate) => candidate.id === meeting.id)
      if (!persisted || persisted.episodeId !== meeting.episodeId) return
      const episode = store
        .listConversationEpisodes(meeting.workdayId)
        .find((candidate) => candidate.id === meeting.episodeId && candidate.deletedAt == null)
      if (!episode) return
      const updated = persistManualMeetingEpisode(persisted)
      const recordingSource = manualMeetingRecordingSource(
        updated,
        store.listConversationEpisodes(meeting.workdayId).find((candidate) => candidate.id === updated.episodeId),
        store.listSpeechSegments(meeting.workdayId)
      )
      // A cloud result may already have replaced the local draft. Only enrich its source link.
      updateSession(meeting.workdayId, (session) =>
        session.memory
          ? {
              ...session,
              memory: {
                ...session.memory,
                conversations: session.memory.conversations.map((conversation) =>
                  conversation.manualMeetingId === meeting.id ? { ...conversation, recordingSource } : conversation
                ),
              },
            }
          : session
      )
    })
    .catch((error) => {
      console.error('[manual-meeting] recording source finalization failed', { meetingId: meeting.id, error })
    })
  const prepared = Promise.resolve()
    .then(async () => {
      if (!canContinueManualMeetingProcessing(meeting)) return null
      const assembled = await assembleManualMeetingAudio(meeting)
      if (!canContinueManualMeetingProcessing(meeting)) return null
      publishManualMeetingConversation(assembled)
      return assembled
    })
    .catch((error) => {
      console.error('[manual-meeting] audio preparation failed', { meetingId: meeting.id, error })
      if (canContinueManualMeetingProcessing(meeting)) {
        finishManualMeetingConversation(meeting, 'audio')
        getEvidenceStore().completeManualMeeting(meeting.id)
      }
      return null
    })
    .finally(() => {
      if (meeting.episodeId && manualMeetingAudioPreparations.get(meeting.episodeId) === prepared) {
        manualMeetingAudioPreparations.delete(meeting.episodeId)
      }
    })
  if (meeting.episodeId) manualMeetingAudioPreparations.set(meeting.episodeId, prepared)
  manualMeetingProcessingQueue = manualMeetingProcessingQueue
    .catch((error) => console.error('[manual-meeting] previous processing job failed', error))
    .then(async () => {
      const assembled = await prepared
      if (!assembled) return
      if (manualMeetingProcessingProvider(assembled) !== 'revinote') await transcribed
      await finalizeManualMeetingProcessing(assembled)
    })
    .catch((error) => {
      console.error('[manual-meeting] background processing failed', { meetingId: meeting.id, error })
      if (!canContinueManualMeetingProcessing(meeting)) return
      finishManualMeetingConversation(meeting, 'analysis')
      getEvidenceStore().completeManualMeeting(meeting.id)
    })
}

async function stopManualMeetingCapture(meetingId: string, details?: ManualMeetingDetails): Promise<DailyReviewState> {
  const stopStartedAt = performance.now()
  if (
    manualMeetingDiscarding ||
    !manualMeeting ||
    manualMeeting.id !== meetingId ||
    manualMeeting.status !== 'recording'
  ) {
    throw new Error('manual-meeting-not-active')
  }
  if (details) manualMeeting = getEvidenceStore().updateManualMeetingDetails(meetingId, details.title, details.notes)
  const endedAt = Date.now()
  const usesSyntheticAudio = usesQaSyntheticManualAudio()
  const syntheticDurationMs = Math.min(2_000, Math.max(600, endedAt - manualMeeting.startedAt))
  const syntheticStartedAt = Math.max(manualMeeting.startedAt, endedAt - syntheticDurationMs)
  const workdayId = manualMeeting.workdayId
  getEvidenceStore().appendCallSignal({
    id: `manual-meeting:${meetingId}:ended`,
    workdayId,
    provider: 'manual',
    surfaceKey: `manual:${meetingId}`,
    state: 'ended',
    observedAt: endedAt,
  })
  manualMeeting = getEvidenceStore().finishManualMeeting(meetingId, endedAt, isOfflineMode())
  if (usesSyntheticAudio) {
    handleChunk(
      'microphone',
      createQaAudioFixture(syntheticDurationMs),
      syntheticStartedAt,
      syntheticDurationMs,
      QA_SYNTHETIC_ACTIVE_LEVEL
    )
  }
  const captureProcesses = [microphoneAudioCaptureProcess, systemAudioCaptureProcess]
  stopMicrophoneEngine()
  stopSystemAudioEngine()
  emitState()
  const enginesStoppedAt = performance.now()
  await Promise.all(captureProcesses.map((child) => waitForCaptureProcess(child)))
  const captureClosedAt = performance.now()
  const transcriptionReady = queueAudioTranscriptionFlush(workdayId, endedAt)
  const stoppingMeeting = manualMeeting
  if (!stoppingMeeting || stoppingMeeting.id !== meetingId) return buildState()
  const processingMeeting = canContinueManualMeetingProcessing(stoppingMeeting)
    ? persistManualMeetingEpisode(stoppingMeeting)
    : stoppingMeeting
  if (isDisposed || manualMeeting?.id !== meetingId) return buildState()
  const canPublish = canContinueManualMeetingProcessing(processingMeeting)
  const publishedAt = performance.now()
  if (canPublish) publishManualMeetingConversation(processingMeeting)
  if (restorePauseAfterManualMeeting && status === 'recording') pauseRecorder()
  else reconcileSourceEngines()
  restorePauseAfterManualMeeting = false
  manualMeeting = null
  emitState()
  if (canPublish) queueManualMeetingProcessing(processingMeeting, transcriptionReady)
  console.info('[manual-meeting] stop timing', {
    syntheticAudio: usesSyntheticAudio,
    stopEnginesMs: Math.round(enginesStoppedAt - stopStartedAt),
    captureCloseMs: Math.round(captureClosedAt - enginesStoppedAt),
    publishMs: Math.round(performance.now() - publishedAt),
    totalMs: Math.round(performance.now() - stopStartedAt),
  })
  return buildState()
}

async function discardManualMeetingCapture(meetingId: string): Promise<DailyReviewState> {
  if (
    manualMeetingDiscarding ||
    !manualMeeting ||
    manualMeeting.id !== meetingId ||
    manualMeeting.status !== 'recording'
  ) {
    throw new Error('manual-meeting-not-active')
  }
  const discardStartedAt = performance.now()
  const meeting = manualMeeting
  const discardedAt = Date.now()
  const captureProcesses = [microphoneAudioCaptureProcess, systemAudioCaptureProcess]
  manualMeetingDiscarding = true
  try {
    sessionDeletionEpochs.set(meeting.workdayId, (sessionDeletionEpochs.get(meeting.workdayId) ?? 0) + 1)
    stopMicrophoneEngine()
    stopSystemAudioEngine()
    await Promise.all(captureProcesses.map((child) => waitForCaptureProcess(child, true)))
    // Flush the old stream before the next recording's decodes, without waiting for ASR.
    // Deleted moment identities fence both queued decodes and in-flight results.
    void queueAudioTranscriptionFlush(meeting.workdayId, discardedAt)

    const session = sessions.find((candidate) => candidate.id === meeting.workdayId)
    if (session) {
      removeConversationAudioSinceAt(
        dailyReviewDirectory(),
        session.id,
        session.moments,
        getEvidenceStore().listConversationEpisodes(session.id),
        meeting.startedAt
      )
    }
    getEvidenceStore().discardManualMeeting(meeting.id, discardedAt)
    const discardedMomentIds = new Set(
      session?.moments
        .filter((moment) => moment.startedAt < discardedAt && moment.startedAt + moment.durationMs > meeting.startedAt)
        .map((moment) => moment.id)
    )
    for (const id of discardedMomentIds) {
      const pendingFile = pendingAudioFiles.get(id)
      if (pendingFile?.sessionId === meeting.workdayId) removeTemporaryCaptureFile(pendingFile.path)
    }
    deferredSessionIds.delete(meeting.workdayId)
    updateSession(meeting.workdayId, (candidate) => ({
      ...candidate,
      moments: candidate.moments.filter(
        (moment) => moment.startedAt >= discardedAt || moment.startedAt + moment.durationMs <= meeting.startedAt
      ),
      memory: candidate.memory
        ? {
            ...candidate.memory,
            conversations: candidate.memory.conversations.filter(
              (conversation) => conversation.manualMeetingId !== meeting.id
            ),
          }
        : null,
    }))
    syncDerivedConversationEpisodes(meeting.workdayId, discardedAt)
    manualMeeting = null
    if (restorePauseAfterManualMeeting && status === 'recording') pauseRecorder()
    restorePauseAfterManualMeeting = false
  } finally {
    manualMeetingDiscarding = false
    reconcileSourceEngines()
    emitState()
  }
  console.info('[manual-meeting] discard timing', { totalMs: Math.round(performance.now() - discardStartedAt) })
  return buildState()
}

function resumeManualMeetingProcessing(meeting: ManualMeeting): void {
  queueManualMeetingProcessing(meeting)
}

export function registerDailyReviewIpc({
  onModelPrepared,
  canCapture,
}: {
  onModelPrepared?: () => void
  canCapture?: () => boolean
} = {}): void {
  initializeKnowledgeStore(app.getPath('userData'))
  captureAllowed = canCapture ?? (() => true)
  ipcMain.handle(CHANNELS.dailyReviewGetState, () => buildState())
  ipcMain.handle(CHANNELS.dailyReviewListSessions, () => projectedSessions())
  ipcMain.handle(CHANNELS.searchDays, async (event, query: unknown, locale: unknown) => {
    if (typeof query !== 'string' || query.length > 4096 || (locale !== 'en-US' && locale !== 'nl-NL')) {
      throw new Error('invalid-day-search')
    }
    const request = ++daySearchSequence
    const senderId = event.sender.id
    daySearchRequests.set(senderId, request)
    const store = getEvidenceStore()
    const deletionRevision = store.deletionRevision()
    const result: RememberSearchResults = { days: [], conversations: [], timeline: [] }
    try {
      if (!query.trim()) return result
      for (const day of sessions) {
        await yieldToMainLoop()
        if (
          isDisposed ||
          isDisposing ||
          event.sender.isDestroyed() ||
          daySearchRequests.get(senderId) !== request ||
          store.deletionRevision() !== deletionRevision
        ) {
          throw new Error('day-search-interrupted')
        }
        if (!day.memory) continue
        if (searchEvidenceRevision !== deletionRevision) {
          searchEvidenceDays = new Map()
          searchEvidenceRevision = deletionRevision
        }
        const cached = searchEvidenceDays.get(day.id)
        const source = cached?.source
        const unchanged =
          source?.memory === day.memory &&
          source?.moments === day.moments &&
          source?.contextMoments === day.contextMoments &&
          source?.appActivity === day.appActivity
        const searchDay =
          unchanged && cached
            ? cached.hydrated
            : { ...day, contextMoments: await store.readContextMomentsAsync(day.id) }
        if (!unchanged) searchEvidenceDays.set(day.id, { source: day, hydrated: searchDay })
        await prepareRememberSearch(searchDay, locale, async () => {
          await yieldToMainLoop()
          if (
            isDisposed ||
            isDisposing ||
            daySearchRequests.get(senderId) !== request ||
            store.deletionRevision() !== deletionRevision
          )
            throw new Error('day-search-interrupted')
        })
        if (daySearchRequests.get(senderId) !== request || store.deletionRevision() !== deletionRevision)
          throw new Error('day-search-interrupted')
        const found = searchRemember([searchDay], query, locale)
        result.days.push(...found.days)
        result.conversations.push(...found.conversations)
        result.timeline.push(...found.timeline)
      }
      if (store.deletionRevision() !== deletionRevision) throw new Error('day-search-interrupted')
      for (const key of ['days', 'conversations', 'timeline'] as const) {
        result[key].sort((a, b) => b.score - a.score || b.day.startedAt - a.day.startedAt)
        result[key].splice(8)
      }
      return result
    } finally {
      if (daySearchRequests.get(senderId) === request) daySearchRequests.delete(senderId)
    }
  })
  ipcMain.handle(CHANNELS.getDayRevision, () => {
    emitSessions()
    return daySnapshotPublisher.snapshot().revision
  })
  ipcMain.handle(CHANNELS.listDaySnapshot, () => {
    emitSessions()
    return daySnapshotPublisher.snapshot()
  })
  ipcMain.handle(CHANNELS.dailyReviewPrepare, async () => {
    await prepareModel()
    if (isModelDownloaded()) onModelPrepared?.()
    await startAutomaticCapture()
    return buildState()
  })
  ipcMain.handle(CHANNELS.dailyReviewPause, (_event, input?: number | null | CapturePauseInput) => {
    if (typeof input === 'object' && input != null) return configureManualPause(input)
    if (input == null) return pauseSession()
    if (!Number.isFinite(input) || input <= 0) return buildState()
    return pauseSession(Date.now() + input)
  })
  ipcMain.handle(CHANNELS.dailyReviewResume, () => resumeAllCapture())
  ipcMain.handle(CHANNELS.startManualMeeting, () => startManualMeetingCapture())
  ipcMain.handle(CHANNELS.updateManualMeetingDetails, (_event, id: unknown, title: unknown, notes: unknown) => {
    if (
      typeof id !== 'string' ||
      typeof title !== 'string' ||
      typeof notes !== 'string' ||
      manualMeeting?.id !== id ||
      manualMeetingDiscarding
    )
      throw new Error('invalid-meeting-details')
    manualMeeting = getEvidenceStore().updateManualMeetingDetails(id, title, notes)
    emitState()
    return buildState()
  })
  ipcMain.handle(CHANNELS.updateManualMeetingStart, (_event, meetingId: unknown, startedAt: unknown) => {
    if (typeof meetingId !== 'string' || typeof startedAt !== 'number') throw new Error('invalid-manual-meeting')
    return updateManualMeetingCaptureStart(meetingId, startedAt)
  })
  ipcMain.handle(CHANNELS.pauseManualMeeting, (_event, meetingId: unknown) => {
    if (typeof meetingId !== 'string') throw new Error('invalid-manual-meeting')
    return pauseManualMeetingCapture(meetingId)
  })
  ipcMain.handle(CHANNELS.resumeManualMeeting, (_event, meetingId: unknown) => {
    if (typeof meetingId !== 'string') throw new Error('invalid-manual-meeting')
    return resumeManualMeetingCapture(meetingId)
  })
  ipcMain.handle(CHANNELS.stopManualMeeting, (_event, meetingId: unknown, details: unknown) => {
    if (typeof meetingId !== 'string') throw new Error('invalid-manual-meeting')
    if (
      details !== undefined &&
      (details === null ||
        typeof details !== 'object' ||
        !('title' in details) ||
        typeof details.title !== 'string' ||
        !('notes' in details) ||
        typeof details.notes !== 'string')
    ) {
      throw new Error('invalid-meeting-details')
    }
    return stopManualMeetingCapture(meetingId, details as ManualMeetingDetails | undefined)
  })
  ipcMain.handle(CHANNELS.discardManualMeeting, (_event, meetingId: unknown) => {
    if (typeof meetingId !== 'string') throw new Error('invalid-manual-meeting')
    return discardManualMeetingCapture(meetingId)
  })
  ipcMain.handle(CHANNELS.clearRecentCapture, (_event, cutoff: number) => clearRecentCapture(cutoff))
  ipcMain.handle(CHANNELS.dailyReviewVerifySystemAudio, async () => {
    await verifySystemAudio()
    await startAutomaticCapture()
    return buildState()
  })
  ipcMain.handle(CHANNELS.dailyReviewOpenSystemAudioSettings, () => {
    systemAudioCheckStatus = 'unchecked'
    systemAudioCheckError = null
    emitState()
    return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture')
  })
  ipcMain.handle(CHANNELS.dailyReviewRequestMicrophonePermission, async () => {
    const before = microphonePermissionStatus()
    if (process.platform === 'darwin' && before === 'not-determined') {
      await systemPreferences.askForMediaAccess('microphone')
    }
    const after = microphonePermissionStatus()
    if (before !== 'granted' && after === 'granted') {
      restartRequired = true
      status = 'error'
      errorCode = 'permissions-restart-required'
    } else if (after !== 'granted') {
      status = 'error'
      errorCode = 'microphone-permission'
    }
    emitState()
    return buildState()
  })
  ipcMain.handle(CHANNELS.dailyReviewRefresh, (_event, sessionId: string) => {
    if (typeof sessionId !== 'string') throw new Error('invalid-session-id')
    return transcriptionQueue.then(() => refreshDay(sessionId, 'manual', getInterfaceLocale()))
  })
  ipcMain.handle(CHANNELS.updateTimelineItem, (_event, sessionId: string, itemId: string, input: unknown) => {
    if (
      typeof sessionId !== 'string' ||
      typeof itemId !== 'string' ||
      typeof input !== 'object' ||
      input === null ||
      !('title' in input) ||
      typeof input.title !== 'string' ||
      !input.title.trim() ||
      !('description' in input) ||
      typeof input.description !== 'string'
    ) {
      throw new Error('invalid-timeline-item')
    }
    const timelineUpdate = { title: input.title, description: input.description }
    const session = sessions.find((candidate) => candidate.id === sessionId)
    if (!session?.memory) throw new Error('day-memory-not-found')
    updateSession(sessionId, (candidate) =>
      candidate.memory
        ? {
            ...candidate,
            memory: updateTimelineMemoryItem(candidate.memory, itemId, timelineUpdate),
          }
        : candidate
    )
    const updated = sessions.find((candidate) => candidate.id === sessionId)
    if (!updated) throw new Error('day-not-found')
    return updated
  })
  ipcMain.handle(CHANNELS.hideTimelineItem, (_event, sessionId: string, itemId: string) => {
    if (typeof sessionId !== 'string' || typeof itemId !== 'string' || !itemId) {
      throw new Error('invalid-timeline-item')
    }
    const session = sessions.find((candidate) => candidate.id === sessionId)
    if (!session?.memory) throw new Error('day-memory-not-found')
    updateSession(sessionId, (candidate) =>
      candidate.memory ? { ...candidate, memory: hideTimelineMemoryItem(candidate.memory, itemId) } : candidate
    )
    const updated = sessions.find((candidate) => candidate.id === sessionId)
    if (!updated) throw new Error('day-not-found')
    return updated
  })
  ipcMain.handle(CHANNELS.showHiddenTimelineItems, (_event, sessionId: string) => {
    if (typeof sessionId !== 'string') throw new Error('invalid-session-id')
    const session = sessions.find((candidate) => candidate.id === sessionId)
    if (!session?.memory) throw new Error('day-memory-not-found')
    updateSession(sessionId, (candidate) =>
      candidate.memory ? { ...candidate, memory: showHiddenTimelineMemoryItems(candidate.memory) } : candidate
    )
    const updated = sessions.find((candidate) => candidate.id === sessionId)
    if (!updated) throw new Error('day-not-found')
    return updated
  })
  ipcMain.handle(CHANNELS.addTimelineItemToWiki, async (_event, sessionId: string, itemId: string) => {
    if (typeof sessionId !== 'string' || typeof itemId !== 'string' || !itemId) {
      throw new Error('invalid-timeline-item')
    }
    const session = sessions.find((candidate) => candidate.id === sessionId)
    if (!session?.memory) throw new Error('day-memory-not-found')
    const block = session.memory.timeline.find((candidate) => candidate.id === itemId)
    if (!block) throw new Error('timeline-item-not-found')

    const generated = await generateTimelineWikiUpdate(session, block, listKnowledgePages(), getInterfaceLocale())
    const [applied] = applyManagedKnowledgeUpdates(
      `daily-review://${sessionId}/timeline/${itemId}`,
      Date.now(),
      [generated],
      'Tijdlijn'
    )
    const result = applied ?? generated
    return { slug: result.slug, title: result.title, changeType: result.changeType }
  })
  ipcMain.handle(CHANNELS.listWorkItems, () => getEvidenceStore().listWorkItems())
  ipcMain.handle(CHANNELS.createWorkItem, (_event, input: unknown) => {
    if (
      typeof input !== 'object' ||
      input === null ||
      !('title' in input) ||
      typeof input.title !== 'string' ||
      !input.title.trim() ||
      input.title.trim().length > 120 ||
      !('description' in input) ||
      typeof input.description !== 'string' ||
      input.description.trim().length > 80_000
    ) {
      throw new Error('invalid-work-item')
    }
    return getEvidenceStore().createWorkItem(input.title, input.description)
  })
  ipcMain.handle(CHANNELS.updateWorkItem, (_event, itemId: string, input: unknown) => {
    if (
      typeof itemId !== 'string' ||
      !itemId ||
      typeof input !== 'object' ||
      input === null ||
      !('title' in input) ||
      typeof input.title !== 'string' ||
      !input.title.trim() ||
      input.title.trim().length > 120 ||
      !('description' in input) ||
      typeof input.description !== 'string' ||
      input.description.trim().length > 80_000
    ) {
      throw new Error('invalid-work-item')
    }
    const item = getEvidenceStore().updateWorkItem(itemId, input.title, input.description)
    return item
  })
  ipcMain.handle(CHANNELS.updateWorkItemMetadata, (_event, itemId: string, input: unknown) => {
    if (
      typeof itemId !== 'string' ||
      !itemId ||
      typeof input !== 'object' ||
      input === null ||
      !('status' in input) ||
      (input.status !== 'todo' && input.status !== 'in_progress') ||
      !('priority' in input) ||
      (input.priority !== 'none' &&
        input.priority !== 'low' &&
        input.priority !== 'medium' &&
        input.priority !== 'high' &&
        input.priority !== 'urgent') ||
      !('dueAt' in input) ||
      (input.dueAt !== null && (typeof input.dueAt !== 'number' || !Number.isFinite(input.dueAt) || input.dueAt < 0))
    ) {
      throw new Error('invalid-work-item-metadata')
    }
    const item = getEvidenceStore().updateWorkItemMetadata(itemId, {
      status: input.status,
      priority: input.priority,
      dueAt: input.dueAt,
    })
    return item
  })
  ipcMain.handle(CHANNELS.setWorkItemLifecycle, (_event, itemId: string, lifecycle: unknown) => {
    if (
      typeof itemId !== 'string' ||
      !itemId ||
      (lifecycle !== 'open' && lifecycle !== 'completed' && lifecycle !== 'abandoned' && lifecycle !== 'superseded')
    ) {
      throw new Error('invalid-work-item-lifecycle')
    }
    const item = getEvidenceStore().setWorkItemLifecycle(itemId, lifecycle)
    return item
  })
  ipcMain.handle(CHANNELS.recordWorkItemAgentSession, (_event, itemId: string, input: unknown) => {
    if (
      typeof itemId !== 'string' ||
      !itemId ||
      typeof input !== 'object' ||
      input === null ||
      !('sessionId' in input) ||
      typeof input.sessionId !== 'string' ||
      !input.sessionId ||
      !('provider' in input) ||
      (input.provider !== 'codex' && input.provider !== 'claude') ||
      !('prompt' in input) ||
      typeof input.prompt !== 'string' ||
      !('message' in input) ||
      typeof input.message !== 'string' ||
      !('response' in input) ||
      typeof input.response !== 'string' ||
      !('durationMs' in input) ||
      typeof input.durationMs !== 'number' ||
      !Number.isFinite(input.durationMs) ||
      !('startedAt' in input) ||
      typeof input.startedAt !== 'number' ||
      !Number.isFinite(input.startedAt) ||
      !('steps' in input) ||
      !Array.isArray(input.steps)
    ) {
      throw new Error('invalid-work-item-agent-session')
    }
    return getEvidenceStore().recordWorkItemAgentSession(itemId, {
      sessionId: input.sessionId,
      provider: input.provider,
      prompt: input.prompt,
      message: input.message,
      response: input.response,
      durationMs: input.durationMs,
      steps: input.steps,
      startedAt: input.startedAt,
    })
  })
  ipcMain.handle(CHANNELS.startWorkItemAgentSession, (_event, itemId: string, input: unknown) => {
    if (
      typeof itemId !== 'string' ||
      !itemId ||
      typeof input !== 'object' ||
      input === null ||
      !('sessionId' in input) ||
      typeof input.sessionId !== 'string' ||
      !input.sessionId ||
      !('provider' in input) ||
      (input.provider !== 'codex' && input.provider !== 'claude') ||
      !('prompt' in input) ||
      typeof input.prompt !== 'string' ||
      !input.prompt.trim() ||
      !('message' in input) ||
      typeof input.message !== 'string' ||
      !input.message.trim() ||
      !('startedAt' in input) ||
      typeof input.startedAt !== 'number' ||
      !Number.isFinite(input.startedAt)
    ) {
      throw new Error('invalid-work-item-agent-session')
    }
    return getEvidenceStore().startWorkItemAgentSession(itemId, {
      sessionId: input.sessionId,
      provider: input.provider,
      prompt: input.prompt,
      message: input.message,
      startedAt: input.startedAt,
    })
  })
  ipcMain.handle(CHANNELS.finishWorkItemAgentSession, (_event, itemId: string, sessionId: string, input: unknown) => {
    if (
      typeof itemId !== 'string' ||
      !itemId ||
      typeof sessionId !== 'string' ||
      !sessionId ||
      typeof input !== 'object' ||
      input === null ||
      !('response' in input) ||
      typeof input.response !== 'string' ||
      !input.response.trim() ||
      !('durationMs' in input) ||
      typeof input.durationMs !== 'number' ||
      !Number.isFinite(input.durationMs) ||
      !('steps' in input) ||
      !Array.isArray(input.steps)
    ) {
      throw new Error('invalid-work-item-agent-session-result')
    }
    return getEvidenceStore().finishWorkItemAgentSession(itemId, sessionId, {
      response: input.response,
      durationMs: input.durationMs,
      steps: input.steps,
    })
  })
  ipcMain.handle(CHANNELS.failWorkItemAgentSession, (_event, itemId: string, sessionId: string) => {
    if (typeof itemId !== 'string' || !itemId || typeof sessionId !== 'string' || !sessionId) {
      throw new Error('invalid-work-item-agent-session')
    }
    return getEvidenceStore().failWorkItemAgentSession(itemId, sessionId)
  })
  ipcMain.handle(CHANNELS.deleteConversation, (_event, sessionId: string, conversationReference: string) => {
    if (typeof sessionId !== 'string' || typeof conversationReference !== 'string' || !conversationReference) {
      throw new Error('invalid-conversation')
    }
    const session = sessions.find((candidate) => candidate.id === sessionId)
    if (!session?.memory) throw new Error('day-memory-not-found')
    const conversation = resolveConversationReference(session.memory.conversations, conversationReference)
    if (!conversation) throw new Error('conversation-not-found')
    sessionDeletionEpochs.set(sessionId, (sessionDeletionEpochs.get(sessionId) ?? 0) + 1)
    if (conversation.episodeId) {
      const episode = getEvidenceStore()
        .listConversationEpisodes(sessionId)
        .find((candidate) => candidate.id === conversation.episodeId)
      if (episode) removeConversationAudioForEpisodeAt(dailyReviewDirectory(), episode)
      getEvidenceStore().deleteConversationEpisode(conversation.episodeId)
    }
    updateSession(sessionId, (candidate) =>
      candidate.memory
        ? { ...candidate, memory: deleteDayMemoryConversation(candidate.memory, conversationReference) }
        : candidate
    )
    const updated = sessions.find((candidate) => candidate.id === sessionId)
    if (!updated) throw new Error('day-not-found')
    return updated
  })
  ipcMain.handle(CHANNELS.mergeConversations, (_event, sessionId: string, conversationReferences: string[]) =>
    mergeConversations(sessionId, conversationReferences)
  )
  ipcMain.handle(CHANNELS.recoverConversation, (_event, sessionId: string, episodeIds: string[]) =>
    recoverConversation(sessionId, episodeIds)
  )
  ipcMain.handle(CHANNELS.recoverAudio, (_event, sessionId: string, momentIds: string[]) =>
    recoverAudio(sessionId, momentIds)
  )
  ipcMain.handle(CHANNELS.dismissConversationCandidate, (_event, sessionId: string, episodeId: string) =>
    dismissConversationCandidate(sessionId, episodeId)
  )
  ipcMain.handle(
    CHANNELS.revinotePostProcessConversation,
    async (_event, sessionId: string, conversationReference: string) => {
      if (typeof sessionId !== 'string' || typeof conversationReference !== 'string' || !conversationReference) {
        throw new Error('invalid-conversation')
      }
      const session = sessions.find((candidate) => candidate.id === sessionId)
      const conversation = resolveConversationReference(session?.memory?.conversations ?? [], conversationReference)
      if (!conversation?.episodeId || conversation.source === 'revinote') {
        throw new Error('conversation-source-not-local')
      }
      const episode = getEvidenceStore()
        .listConversationEpisodes(sessionId)
        .find((candidate) => candidate.id === conversation.episodeId && candidate.deletedAt == null)
      const audioPath = resolveConversationAudioFile(sessionId, conversation.episodeId)
      if (!episode || !audioPath) throw new Error('conversation-audio-not-found')
      const durationSeconds = conversationAudioDurationSecondsAt(audioPath)
      if (durationSeconds == null) throw new Error('conversation-audio-not-found')
      const result = await postProcessConversationWithRevinote({
        episodeId: conversation.episodeId,
        audioPath,
        durationSeconds,
        recordedAt: new Date(episode.startedAt).toISOString(),
      })
      recordRevinoteMeetingIdentity(sessionId, conversation.episodeId, result.meetingId)
      return result
    }
  )
  ipcMain.handle(CHANNELS.getConversationAudioUrl, async (_event, sessionId: string, reference: string) => {
    const conversation = resolveAudioConversation(sessionId, reference)
    if (conversation?.source === 'revinote' && conversation.externalId) {
      try {
        // Pick one recording before playback, so seeks cannot mix remote and local encodings.
        const response = await fetchRevinoteConversationAudio(
          conversation.externalId,
          new Headers({ Range: 'bytes=0-0' })
        )
        await response?.body?.cancel()
        if (response?.ok && resolveAudioConversation(sessionId, reference)?.externalId === conversation.externalId) {
          const url = new URL('remember-audio://revinote')
          url.searchParams.set('dayId', sessionId)
          url.searchParams.set('conversation', conversationReference(conversation))
          return url.toString()
        }
      } catch {
        // A retained local recording remains playable offline or after remote retention expires.
      }
    }
    const episodeId = conversation?.episodeId ?? reference
    await manualMeetingAudioPreparations.get(episodeId)
    const file = resolveConversationAudioFile(sessionId, episodeId)
    if (!file) return null
    const url = new URL('remember-audio://conversation')
    url.searchParams.set('dayId', sessionId)
    url.searchParams.set('episodeId', episodeId)
    return url.toString()
  })
  ipcMain.handle(CHANNELS.saveConversationAudio, async (_event, sessionId: string, reference: string) => {
    await manualMeetingAudioPreparations.get(resolveAudioConversation(sessionId, reference)?.episodeId ?? reference)
    const conversation = resolveAudioConversation(sessionId, reference)
    const file = resolveConversationAudioFile(sessionId, conversation?.episodeId ?? reference)
    // Keep the original local recording available even when Revinote cannot process or serve it.
    const response =
      !file && conversation?.source === 'revinote' && conversation.externalId
        ? await fetchRevinoteConversationAudio(conversation.externalId, new Headers())
        : null
    if (!file && !response) throw new Error('conversation-audio-not-found')
    const dutch = getInterfaceLocale().startsWith('nl')
    return exportConversationAudio({
      source: file ? { file } : { response: response as Response },
      name: [
        sessionId.replace(/^day\//, ''),
        conversation?.startTime,
        conversation?.title || (dutch ? 'Gesprek' : 'Conversation'),
      ]
        .filter(Boolean)
        .join(' '),
      chooseDestination: async (fileName, extension) => {
        const options = {
          title: dutch ? 'Audio downloaden' : 'Download audio',
          defaultPath: fileName,
          filters: [{ name: 'Audio', extensions: [extension] }],
        }
        const window = getMainWindow()
        const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
        return result.canceled ? null : (result.filePath ?? null)
      },
    })
  })
  ipcMain.handle(CHANNELS.setConversationAudioPlayback, async (event, playbackId: unknown, active: unknown) => {
    if (typeof playbackId !== 'string' || !playbackId || playbackId.length > 256 || typeof active !== 'boolean') {
      throw new Error('invalid-conversation-audio-playback-state')
    }
    if (active && manualMeeting?.status === 'recording') throw new Error('manual-meeting-active')
    const senderId = event.sender.id
    if (active && !conversationAudioPlaybackSenderCleanupIds.has(senderId)) {
      conversationAudioPlaybackSenderCleanupIds.add(senderId)
      event.sender.once('destroyed', () => {
        conversationAudioPlaybackSenderCleanupIds.delete(senderId)
        void conversationAudioPlayback
          .releaseSender(senderId)
          .catch((error) => console.error('[daily-review] failed to release conversation playback', error))
      })
    }
    await conversationAudioPlayback.set(senderId, playbackId, active)
  })
  ipcMain.handle(CHANNELS.dailyReviewDeleteSession, (_event, sessionId: string) => {
    if (typeof sessionId !== 'string') throw new Error('invalid-session-id')
    return deleteSession(sessionId)
  })
  ipcMain.handle(CHANNELS.getWikiOverview, () => getWikiOverview(sessions))
  ipcMain.handle(CHANNELS.createLocalWikiSpace, (_event, input) => createLocalWikiSpace(input, sessions))
  ipcMain.handle(CHANNELS.removeLocalWikiSpace, (_event, input) => removeLocalWikiSpace(input, sessions))
  ipcMain.handle(CHANNELS.updateWikiSpace, (_event, input) => updateWikiSpace(input, sessions))
  ipcMain.handle(CHANNELS.reorderWikiSpaces, (_event, input) => reorderWikiSpaces(input, sessions))
  ipcMain.handle(CHANNELS.dailyReviewListWikiPages, (_event, spaceId) => listWikiPages(spaceId))
  ipcMain.handle(CHANNELS.createWikiPage, (_event, input) => createWikiPage(input))
  ipcMain.handle(CHANNELS.saveWikiPage, (_event, input) => saveWikiPage(input))
  ipcMain.handle(CHANNELS.deleteWikiPage, (_event, input) => deleteWikiPage(input))
  ipcMain.handle(CHANNELS.getWikiPageHistory, (_event, input) => getWikiPageHistoryForSpace(input))
  ipcMain.handle(CHANNELS.restoreWikiPageRevision, (_event, input) => restoreWikiPageRevision(input))
  ipcMain.handle(CHANNELS.undoWikiLearning, async (_event, input) => {
    const pages = await undoWikiLearning(input)
    emitMemoryChanged()
    return pages
  })
  ipcMain.handle(CHANNELS.moveWikiProject, (_event, input) => moveWikiProject(input, sessions))
  ipcMain.handle(CHANNELS.applyKnowledgeSuggestion, async (_event, input) => {
    const overview = await applyKnowledgeSuggestion(input, sessions)
    emitMemoryChanged()
    return overview
  })
  ipcMain.handle(CHANNELS.dismissKnowledgeSuggestion, (_event, input) => {
    const overview = dismissKnowledgeSuggestion(input, sessions)
    emitMemoryChanged()
    return overview
  })
  ipcMain.handle(CHANNELS.dailyReviewRequestContextPermissions, async () => {
    const previousAccessibility = accessibilityPermission
    const permissions = await readContextPermissions(true)
    accessibilityPermission = permissions.accessibility
    inputMonitoringPermission = permissions.inputMonitoring
    if (previousAccessibility !== 'granted' && accessibilityPermission === 'granted') {
      restartRequired = true
      errorCode = 'permissions-restart-required'
      status = 'error'
    } else if (accessibilityPermission !== 'granted') {
      errorCode = 'accessibility-permission'
      status = 'error'
    }
    emitState()
    return buildState()
  })
  ipcMain.handle(CHANNELS.dailyReviewOpenAccessibilitySettings, () =>
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
  )
  ipcMain.handle(CHANNELS.dailyReviewOpenInputMonitoringSettings, () =>
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent')
  )
  ipcMain.handle(CHANNELS.dailyReviewOpenMicrophoneSettings, () => {
    return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
  })
  ipcMain.handle(CHANNELS.dailyReviewRestartApp, async () => {
    await shutdownAgentProcesses()
    app.relaunch()
    app.exit(0)
  })
}

export function getDailyReviewState(): DailyReviewState {
  return buildState()
}

export function pauseDailyReviewSourcesFor(
  sources: CapturePauseSource[],
  durationMs: number
): Promise<DailyReviewState> {
  return configureManualPause({ sources, durationMs })
}

export function resumeDailyReview(): Promise<DailyReviewState> {
  return resumeAllCapture()
}

export async function refreshDailyReviewSetup(nextAgentSetup?: AgentSetup): Promise<void> {
  if (nextAgentSetup) agentSetup = nextAgentSetup
  else await refreshAgentStatus()
  if (
    !getSettings().audioCaptureEnabled &&
    status === 'error' &&
    (errorCode === 'microphone-permission' ||
      errorCode === 'system-audio-check-required' ||
      errorCode === 'model-required' ||
      errorCode === 'model-download-failed' ||
      errorCode === 'model-download-offline')
  ) {
    status = 'idle'
    errorCode = null
  }
  await reconcileCaptureSchedule()
  if (status === 'recording') reconcileSourceEngines()
  emitState()
}

export async function finalizeDailyReviewAudioCapture(): Promise<void> {
  const sessionId = activeSessionId
  const captureProcesses = [microphoneAudioCaptureProcess, systemAudioCaptureProcess]
  stopMicrophoneEngine()
  stopSystemAudioEngine()
  await Promise.all(captureProcesses.map((child) => waitForCaptureProcess(child)))
  await waitForTranscriptionsToSettle()
  if (sessionId) {
    await flushAudioTranscriptionStreams(sessionId)
    syncDerivedConversationEpisodes(sessionId, Date.now(), true, 'capture-paused')
  }
}

export function recordOfflineModeTransition(offlineMode: boolean, timestamp = Date.now()) {
  const store = getEvidenceStore()
  if (offlineMode) store.beginOfflinePeriod(timestamp)
  else store.endOfflinePeriod(timestamp)
  if (activeSessionId) syncDerivedConversationEpisodes(activeSessionId, timestamp)
}

export function onDailyReviewStateChange(listener: (state: DailyReviewState) => void) {
  stateListeners.add(listener)
  return () => stateListeners.delete(listener)
}

function restoreStoredManualMeetingConversations(session: DailyReviewSession): DailyReviewSession {
  const store = getEvidenceStore()
  const episodes = store.listConversationEpisodes(session.id)
  const meetings = store
    .listManualMeetings(session.id)
    .filter(
      (meeting) =>
        meeting.endedAt != null &&
        meeting.status !== 'recording' &&
        !episodes.some((episode) => episode.id === meeting.episodeId && episode.deletedAt != null)
    )
    .map((meeting) => {
      if (meeting.episodeId) return meeting
      const episode = manualMeetingEpisode(meeting, episodes, false, store.listSpeechSegments(session.id))
      try {
        store.upsertManualMeetingEpisode(episode)
        return store.setManualMeetingEpisode(meeting.id, episode.id)
      } catch (error) {
        console.warn('[manual-meeting] failed to restore a durable recording episode', {
          meetingId: meeting.id,
          episodeId: episode.id,
          error,
        })
        return meeting
      }
    })
  const existingConversations = applyManualMeetingMetadata(session.id, session.memory?.conversations ?? []).filter(
    (conversation) =>
      !session.memory?.deletedConversationWindows?.some((deleted) =>
        matchesDeletedConversation(session.startedAt, deleted, conversation)
      ) && !episodes.some((episode) => episode.id === conversation.episodeId && episode.deletedAt != null)
  )
  let restored: DailyReviewSession = session.memory
    ? { ...session, memory: { ...session.memory, conversations: existingConversations } }
    : session
  for (const meeting of meetings) {
    if (restored.memory?.conversations.some((conversation) => conversation.manualMeetingId === meeting.id)) continue
    const processingProvider =
      meeting.status === 'processing'
        ? selectManualMeetingProcessingProvider({
            automaticRevinoteProcessing: getSettings().automaticRevinoteProcessing,
            existing: undefined,
            offlineMode: isOfflineMode(),
            automaticRevinoteProcessingBlocked: meeting.automaticRevinoteProcessingBlocked,
          })
        : 'remember'
    const recordingSource = manualMeetingRecordingSource(
      meeting,
      store.listConversationEpisodes(session.id).find((episode) => episode.id === meeting.episodeId),
      store.listSpeechSegments(session.id)
    )
    const memory = memoryWithManualMeetingConversation(restored, meeting, processingProvider, recordingSource)
    restored = {
      ...restored,
      memory: meeting.status === 'completed' ? memoryWithFinishedManualMeetingConversation(memory, meeting.id) : memory,
    }
  }
  return restored
}

export function startDailyReview(mainWindowGetter: () => BrowserWindow | null): void {
  isDisposing = false
  isDisposed = false
  sessionDeletionEpochs.clear()
  getMainWindow = mainWindowGetter
  unsubscribeWikiContent?.()
  unsubscribeWikiContent = subscribeWikiContentChanges(emitMemoryChanged)
  removeModelPreparationListener = subscribeModelPreparation(() => {
    if (isDisposed || isDisposing) return
    emitState()
    if (isModelDownloaded()) {
      void startAutomaticCapture()
        .then(() => reconcileSourceEngines())
        .catch((error) => console.error('[daily-review] Could not resume after model preparation', error))
    }
  })
  microphonePermissionAtLaunch = microphonePermissionStatus()
  const startedAt = Date.now()
  if (isOfflineMode()) getEvidenceStore().beginOfflinePeriod(startedAt)
  else getEvidenceStore().endOfflinePeriod(startedAt)
  recoverInterruptedAgentTrace()
  const recoveredSessions = settleFailedRevinoteProcessing(recoverInterruptedSessions(readSessions()))
  const importedRevinoteMeetings = getImportedRevinoteMeetings()
  revinoteActionVersions.clear()
  for (const meeting of importedRevinoteMeetings) revinoteActionVersions.set(meeting.id, meeting.updatedAt)
  sessions = mergeRevinoteMeetings(
    recoveredSessions,
    importedRevinoteMeetings,
    revinotePostProcessSourceWindows(recoveredSessions)
  ).map(restoreStoredManualMeetingConversations)
  removeTranscriptionInterruptionListener?.()
  removeTranscriptionInterruptionListener = subscribeTranscriptionInterruptions(recoverInterruptedTranscription)
  synchronizeSessionConversationActionPoints(sessions, { createMissing: false })
  startProactiveContextWorker()
  const meetingsToResume: ManualMeeting[] = []
  const interruptedMeeting = getEvidenceStore().activeManualMeeting()
  if (interruptedMeeting) {
    const endedAt = Date.now()
    getEvidenceStore().appendCallSignal({
      id: `manual-meeting:${interruptedMeeting.id}:ended-after-restart`,
      workdayId: interruptedMeeting.workdayId,
      provider: 'manual',
      surfaceKey: `manual:${interruptedMeeting.id}`,
      state: 'ended',
      observedAt: endedAt,
    })
    meetingsToResume.push(getEvidenceStore().finishManualMeeting(interruptedMeeting.id, endedAt, isOfflineMode()))
  }
  meetingsToResume.push(
    ...getEvidenceStore()
      .processingManualMeetings()
      .filter((meeting) => meeting.id !== interruptedMeeting?.id)
  )
  manualMeeting = null
  writeSessions(sessions)
  clearTemporaryCapture()
  emitSessions()
  for (const session of sessions) regenerateMergedConversations(session.id)
  startDowntimeRefreshTimer()
  startContextCaptureHealthTimer()
  powerMonitor.on('suspend', handleSystemInactive)
  powerMonitor.on('lock-screen', handleSystemInactive)
  powerMonitor.on('resume', handleSystemResume)
  powerMonitor.on('unlock-screen', handleSystemResume)
  // Onboarding needs permission status even when automatic capture is disabled.
  // Publish it before capture/agent setup so a fresh or reset profile can open setup.
  void refreshPermissionStatuses()
    .then(() => {
      emitState()
      return startAutomaticCapture()
    })
    .finally(() => {
      emitState()
      for (const meeting of meetingsToResume) resumeManualMeetingProcessing(meeting)
      queueAutomaticRevinoteProcessing()
    })
}

export function resolveAudioConversation(sessionId: string, reference: string) {
  if (typeof sessionId !== 'string' || typeof reference !== 'string' || !sessionId || !reference) return null
  const conversations = sessions.find((candidate) => candidate.id === sessionId)?.memory?.conversations ?? []
  return (
    resolveConversationReference(conversations, reference) ??
    conversations.find((conversation) => conversation.episodeId === reference) ??
    null
  )
}

export function resolveConversationAudioFile(sessionId: string, episodeId: string) {
  if (typeof sessionId !== 'string' || typeof episodeId !== 'string' || !sessionId || !episodeId) return null
  const session = sessions.find((candidate) => candidate.id === sessionId)
  const recognized =
    session?.memory?.conversations.some((conversation) => conversation.episodeId === episodeId) ||
    getEvidenceStore()
      .listManualMeetings(sessionId)
      .some((meeting) => meeting.episodeId === episodeId)
  if (!recognized) return null
  const episode = getEvidenceStore()
    .listConversationEpisodes(sessionId)
    .find((candidate) => candidate.id === episodeId && candidate.deletedAt == null)
  if (!episode) return null
  const file = conversationAudioPathAt(dailyReviewDirectory(), episode)
  return existsSync(file) ? file : null
}

export function refreshImportedRevinoteMeetings(): void {
  if (isDisposed) return
  const previousById = new Map(sessions.map((session) => [session.id, session]))
  sessions = settleFailedRevinoteProcessing(sessions)
  const importedMeetings = getImportedRevinoteMeetings()
  const changedMeetingIds = changedRevinoteMeetingIds(revinoteActionVersions, importedMeetings)
  sessions = mergeRevinoteMeetings(sessions, importedMeetings, revinotePostProcessSourceWindows(sessions))
  const changedSessions = sessions.filter((session) => previousById.get(session.id) !== session)
  synchronizeSessionConversationActionPoints(changedSessions, { createMissing: false })
  for (const session of sessions) {
    const changedConversations = (session.memory?.conversations ?? []).filter(
      (conversation) =>
        conversation.source === 'revinote' &&
        conversation.externalId != null &&
        changedMeetingIds.has(conversation.externalId)
    )
    if (!changedConversations.length) continue
    getEvidenceStore().synchronizeConversationActionPoints({
      workdayId: session.id,
      conversations: changedConversations.filter((conversation) => {
        if (!getSettings().liveTaskUpdates || !conversation.episodeId) return true
        const episode = getEvidenceStore()
          .listConversationEpisodes(session.id)
          .find((entry) => entry.id === conversation.episodeId)
        return !episode?.segmentIds.length
      }),
      observedAt: session.memory?.refreshedAt ?? Date.now(),
    })
  }
  revinoteActionVersions.clear()
  for (const meeting of importedMeetings) revinoteActionVersions.set(meeting.id, meeting.updatedAt)
  for (const session of changedSessions) writeSession(session)
  if (changedSessions.length || previousById.size !== sessions.length) {
    emitSessions()
    emitMemoryChanged()
  }
  queueAutomaticRevinoteProcessing()
}

function synchronizeSessionConversationActionPoints(
  sourceSessions: DailyReviewSession[],
  options: { createMissing?: boolean } = {}
) {
  const store = getEvidenceStore()
  for (const session of sourceSessions) {
    const conversations = session.memory?.conversations ?? []
    if (!conversations.length) continue
    store.synchronizeConversationActionPoints({
      workdayId: session.id,
      conversations,
      observedAt: session.memory?.refreshedAt ?? Date.now(),
      createMissing: options.createMissing,
    })
  }
}

function revinotePostProcessSourceWindows(sourceSessions: DailyReviewSession[]) {
  const submissionByEpisodeId = new Map(
    getRevinotePostProcessSubmissions().map((submission) => [submission.episodeId, submission])
  )
  const windows = new Map<string, RevinoteSourceWindow>()
  const store = getEvidenceStore()

  for (const session of sourceSessions) {
    for (const episode of store.listConversationEpisodes(session.id)) {
      const submission = submissionByEpisodeId.get(episode.id)
      if (!submission) continue
      windows.set(submission.meetingId, {
        workdayId: session.id,
        episodeId: episode.id,
        startedAt: episode.startedAt,
        endedAt: episode.endedAt,
        settledAt: submission.settledAt,
      })
    }
  }
  return windows
}

function waitForCaptureProcess(
  child: ChildProcessWithoutNullStreams | MicrophoneCaptureHandle | null,
  rejectOnTimeout = false
) {
  if (child && 'kind' in child) return child.closed
  if (!child || (child.exitCode != null && child.stdout.readableEnded && child.stderr.readableEnded)) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    const onClose = () => {
      clearTimeout(timeout)
      resolve()
    }
    const timeout = setTimeout(() => {
      child.removeListener('close', onClose)
      if (rejectOnTimeout) reject(new Error('capture-helper-stop-timeout'))
      else resolve()
    }, 2_500)
    child.once('close', onClose)
  })
}

export async function disposeDailyReview(): Promise<void> {
  if (isDisposed) return
  isDisposing = true
  for (const notification of activeMeetingReminderNotifications) notification.close()
  activeMeetingReminderNotifications.clear()
  meetingReminderShownAt.clear()
  unsubscribeWikiContent?.()
  unsubscribeWikiContent = null
  unsubscribeAmbientSettings?.()
  unsubscribeAmbientDeletions?.()
  unsubscribeProactiveConversation?.()
  unsubscribeProactiveNotes?.()
  unsubscribeProactiveNotes = null
  unsubscribeProactiveConversation = null
  unsubscribeAmbientDeletions = null
  unsubscribeAmbientSettings = null
  await ambientTaskWorker?.stop()
  ambientTaskWorker = null
  removeModelPreparationListener?.()
  removeModelPreparationListener = null
  clearStopWatchdog()
  clearDayRolloverTimer()
  clearTimedResumeTimer()
  clearCaptureScheduleTimer()
  clearDowntimeRefreshTimer()
  clearContextCaptureHealthTimer()
  powerMonitor.removeListener('suspend', handleSystemInactive)
  powerMonitor.removeListener('lock-screen', handleSystemInactive)
  powerMonitor.removeListener('resume', handleSystemResume)
  powerMonitor.removeListener('unlock-screen', handleSystemResume)
  if (status === 'recording') accrueActiveDuration()
  if (manualMeeting?.status === 'recording') {
    const endedAt = Date.now()
    getEvidenceStore().appendCallSignal({
      id: `manual-meeting:${manualMeeting.id}:ended-on-quit`,
      workdayId: manualMeeting.workdayId,
      provider: 'manual',
      surfaceKey: `manual:${manualMeeting.id}`,
      state: 'ended',
      observedAt: endedAt,
    })
    getEvidenceStore().finishManualMeeting(manualMeeting.id, endedAt, isOfflineMode())
    manualMeeting = null
  }
  const captureProcesses = [microphoneAudioCaptureProcess, systemAudioCaptureProcess, contextCaptureProcess]
  stopMicrophoneEngine()
  stopSystemAudioEngine()
  stopContextEngine()
  await Promise.all(captureProcesses.map((child) => waitForCaptureProcess(child)))
  await waitForTranscriptionsToSettle()
  if (activeSessionId) await flushAudioTranscriptionStreams(activeSessionId)
  if (status === 'recording' || status === 'paused' || status === 'stopping') finalizeActiveSession()
  removeTranscriptionInterruptionListener?.()
  removeTranscriptionInterruptionListener = null
  isDisposed = true
  flushDeferredSessions()
  automaticCapturePromise = null
  pendingAutomaticDayRefresh = null
  conversationAudioPlayback.reset()
  conversationAudioPlaybackSenderCleanupIds.clear()
  stateListeners.clear()
  status = 'idle'
  clearTemporaryCapture()
  closeWikiHistoryStore()
  closeEvidenceStore()
}

export async function prepareDailyReviewForDataReset() {
  await disposeDailyReview()
  await dayRefreshQueue.drain()
  closeEvidenceStore()
  sessions = []
  daySnapshotPublisher.update([])
  speechActivityIntervals.clear()
  activeSessionId = null
  startedAt = null
  activeStartedAt = null
  activeDurationMs = 0
}
