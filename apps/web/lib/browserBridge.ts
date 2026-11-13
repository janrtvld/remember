import {
  type AgentProject,
  type AgentSetup,
  type AgentTurnStep,
  type AgentTurnUpdate,
  buildDayChanges,
  type CapturePauseSource,
  type CaptureState,
  conversationReference,
  type Day,
  type DayChanges,
  type DaySnapshot,
  DEFAULT_CAPTURE_SCHEDULE,
  DEFAULT_CODEX_ANALYSIS_MODEL,
  DEFAULT_DICTATION_PREFERENCES,
  DEFAULT_FREQUENT_DAY_REFRESH_INTERVAL_MINUTES,
  defaultPersonalWikiSpaceName,
  FALLBACK_CODEX_MODELS,
  hasCompletedOnboarding,
  type LocalSettings,
  localeFromLanguageTag,
  manualMeetingTitle,
  PERSONAL_WIKI_SPACE_ID,
  parseInboxResult,
  type RememberBridge,
  type RevinoteConnectionStatus,
  resolveConversationReference,
  resolveInterfaceLocale,
  searchRemember,
  type UpdateState,
  type WikiOverview,
  type WikiPage,
  type WikiPageHistory,
  type WorkItem,
} from '@remember/shared'
import { createBrowserAssistantBridge } from './browserAssistantBridge'

type Listener<T> = (value: T) => void

const noop = () => undefined
const resolved = () => Promise.resolve()
const delay = (durationMs: number) => new Promise<void>((resolve) => setTimeout(resolve, durationMs))

function startOfDay(dayOffset = 0) {
  const value = new Date()
  value.setHours(0, 0, 0, 0)
  value.setDate(value.getDate() + dayOffset)
  return value.getTime()
}

function at(dayOffset: number, hour: number, minute = 0) {
  const value = new Date(startOfDay(dayOffset))
  value.setHours(hour, minute, 0, 0)
  return value.getTime()
}

function dateId(dayOffset: number) {
  const value = new Date(startOfDay(dayOffset))
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `day/${year}-${month}-${day}`
}

let browserConversationAudioUrl: string | null = null

function conversationAudioFixtureUrl() {
  if (browserConversationAudioUrl) return browserConversationAudioUrl
  const sampleRate = 8_000
  const sampleCount = sampleRate * 3
  const bytes = new Uint8Array(44 + sampleCount * 2)
  const view = new DataView(bytes.buffer)
  const writeText = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index)
  }
  writeText(0, 'RIFF')
  view.setUint32(4, 36 + sampleCount * 2, true)
  writeText(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, sampleCount * 2, true)
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.round(Math.sin((index / sampleRate) * Math.PI * 2 * 220) * 1_200)
    view.setInt16(44 + index * 2, sample, true)
  }
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  browserConversationAudioUrl = `data:audio/wav;base64,${btoa(binary)}`
  return browserConversationAudioUrl
}

function createDay(dayOffset: number, current = false): Day {
  const id = dateId(dayOffset)
  const startedAt = at(dayOffset, 8, 45)
  const refreshedAt = at(dayOffset, current ? 14 : 17, current ? 22 : 5)
  const focus = current ? 'Browser-first visual testing' : 'Release reliability'

  return {
    id,
    startedAt,
    endedAt: current ? null : at(dayOffset, 17, 18),
    activeDurationMs: current ? 5.6 * 60 * 60 * 1_000 : 7.1 * 60 * 60 * 1_000,
    moments: [
      {
        id: `${id}:microphone`,
        sessionId: id,
        source: 'microphone',
        startedAt: at(dayOffset, 10, 2),
        durationMs: 14 * 60 * 1_000,
        status: 'ready',
        transcript:
          'We kunnen de echte renderer in de browser testen als de native bridge daar een lokale ontwikkelvariant krijgt.',
      },
      {
        id: `${id}:system`,
        sessionId: id,
        source: 'system',
        startedAt: at(dayOffset, 10, 2),
        durationMs: 14 * 60 * 1_000,
        status: 'ready',
        transcript: 'Keep browser QA and native integration verification as two explicit boundaries.',
      },
    ],
    appActivity: [
      {
        id: `${id}:code`,
        appName: 'Visual Studio Code',
        bundleId: 'com.microsoft.VSCode',
        startedAt: at(dayOffset, 8, 52),
        endedAt: at(dayOffset, 10, 0),
      },
      {
        id: `${id}:slack`,
        appName: 'Slack',
        bundleId: 'com.tinyspeck.slackmacgap',
        startedAt: at(dayOffset, 10, 0),
        endedAt: at(dayOffset, 10, 19),
      },
      {
        id: `${id}:chrome`,
        appName: 'Google Chrome',
        bundleId: 'com.google.Chrome',
        startedAt: at(dayOffset, 10, 19),
        endedAt: at(dayOffset, 12, 4),
      },
      {
        id: `${id}:codex`,
        appName: 'Codex',
        bundleId: 'com.openai.codex',
        startedAt: at(dayOffset, 12, 40),
        endedAt: current ? Date.now() : at(dayOffset, 17, 18),
      },
    ],
    contextMoments: [
      {
        id: `${id}:context-browser`,
        timestamp: at(dayOffset, 9, 12),
        appName: 'Visual Studio Code',
        bundleId: 'com.microsoft.VSCode',
        windowTitle: 'browserBridge.ts — remember',
        text: 'Development-only RememberBridge used by the real Next.js renderer.',
        textSource: 'accessibility',
        trigger: 'window-change',
        monitorName: 'Built-in Display',
        screenshotPath: '',
      },
      {
        id: `${id}:context-qa`,
        timestamp: at(dayOffset, 13, 20),
        appName: 'Google Chrome',
        bundleId: 'com.google.Chrome',
        windowTitle: 'Remember — localhost',
        text: 'Checked Workdays, Activity, Conversations, Wiki and Settings at narrow and desktop widths.',
        textSource: 'accessibility',
        trigger: 'interval',
        monitorName: 'Built-in Display',
        screenshotPath: '',
      },
    ],
    memory: {
      summary: current
        ? 'Made the Remember renderer directly testable in a browser and removed the brittle Electron session gate.'
        : 'Tightened release checks and separated renderer confidence from native integration confidence.',
      currentFocus: focus,
      outcomes: current
        ? ['The complete dashboard opens at localhost:3000', 'Routine UI QA no longer needs an Electron window']
        : ['Documented the native verification boundary', 'Kept release validation scoped'],
      decisions: [
        'Use the real renderer with a development-only bridge instead of maintaining a second preview interface.',
        'Keep native-only verification explicit and focused.',
      ],
      openLoops: [
        'Check the narrow layout before publishing',
        'Keep browser fixtures representative as the data model evolves',
      ],
      openTasks: [
        {
          id: `${id}:task-narrow`,
          title: 'Check the narrow browser layout',
          description: 'Verify navigation, scroll containers and dialogs at 640 px.',
          prompt: 'Inspect the Remember browser app at a narrow viewport and report visual regressions.',
          source: { kind: 'task', label: 'Visual QA', detail: 'Browser test workflow' },
        },
        {
          id: `${id}:task-native`,
          title: 'Verify native behavior only when it changes',
          description: 'Reserve desktop QA for IPC, capture, permissions, notifications, tray and updater work.',
          source: {
            kind: 'conversation',
            label: 'Browser testing workflow',
            detail: 'Explicit follow-up from the conversation.',
            conversationStartTime: '10:02',
          },
        },
      ],
      projectAttention: [
        { project: 'Remember', durationMinutes: current ? 248 : 332, description: focus },
        { project: 'Woub', durationMinutes: current ? 42 : 68, description: 'Reviewed mobile release context.' },
      ],
      conversations: [
        {
          episodeId: `${id}:episode-browser-testing`,
          startTime: '10:02',
          endTime: '10:16',
          title: 'Browser testing workflow',
          description: 'Separated routine renderer QA from native desktop integration checks.',
          summary: 'Agreed to make localhost the default interface test target and delete the Electron session guard.',
          actionPoints: ['Leg de Remember-richting vast'],
          otherParticipantName: 'Product review',
        },
      ],
      timeline: [
        {
          id: `${id}:timeline-bridge`,
          startTime: '08:52',
          endTime: '10:00',
          title: 'Browser bridge implementation',
          description: 'Connected realistic local fixtures to the production renderer boundary.',
          details: [
            { at: '09:12', text: 'Added a development-only bridge around the production renderer API.' },
            { at: '09:38', text: 'Verified that the dashboard loads realistic mutable fixture data.' },
          ],
          sourceRefs: [{ kind: 'context', id: `${id}:context-browser` }],
        },
        {
          id: `${id}:timeline-qa`,
          startTime: '13:10',
          endTime: '14:20',
          title: 'Renderer visual QA',
          description: 'Walked through the core pages and interaction states in the browser.',
          details: [
            { at: '13:20', text: 'Checked Workdays, Activity, Conversations, Wiki and Settings.' },
            { at: '14:02', text: 'Confirmed the narrow layout keeps the primary navigation usable.' },
          ],
          sourceRefs: [{ kind: 'context', id: `${id}:context-qa` }],
        },
      ],
      knowledgeSuggestions: [
        {
          slug: 'processes/browser-ui-testing',
          title: 'Browser UI testing',
          summary: 'Keep the browser-first UI testing workflow and its renderer QA boundary in project memory.',
          changeType: 'updated',
          suggestedSpaceId: PERSONAL_WIKI_SPACE_ID,
        },
        {
          slug: 'projects/remember',
          title: 'Remember',
          summary: 'Keep the current project context, reliability decisions and remaining release checks.',
          changeType: 'updated',
          suggestedSpaceId: PERSONAL_WIKI_SPACE_ID,
        },
      ],
      refreshedAt,
      coveredThrough: refreshedAt,
    },
    refresh: {
      status: 'idle',
      reason: null,
      targetThrough: null,
      error: null,
      progress: null,
      run: null,
    },
  }
}

const defaultSettings: LocalSettings = {
  interfaceLanguage: 'system',
  interfaceTheme: 'system',
  offlineMode: false,
  errorReportingEnabled: true,
  automaticUpdates: true,
  defaultAgentProvider: 'codex',
  agentComputer: { kind: 'local' },
  liveTaskUpdates: false,
  dayAnalysisProvider: 'codex',
  dayAnalysisOnboardingCompleted: true,
  privacyOnboardingCompleted: true,
  cloudAnalysisConsent: true,
  cloudConsentNoticeSeen: true,
  contextImportOnboardingCompleted: true,
  contextImportCompletedAt: Date.now() - 14 * 24 * 60 * 60 * 1_000,
  agentLearningEnabled: false,
  agentLearningEnabledAt: null,
  agentContextBindings: [],
  codexAnalysisModel: DEFAULT_CODEX_ANALYSIS_MODEL,
  codexAnalysisEffort: 'medium',
  claudeAnalysisModel: 'sonnet',
  claudeAnalysisEffort: 'medium',
  launchAtLogin: true,
  edgeWidgetEnabled: true,
  edgeWidgetHiddenUntil: null,
  edgeWidgetEdge: 'right',
  dictation: { ...DEFAULT_DICTATION_PREFERENCES },
  audioCaptureEnabled: false,
  audioCaptureOnboardingCompleted: true,
  automaticRevinoteProcessing: false,
  frequentDayRefresh: true,
  frequentDayRefreshIntervalMinutes: DEFAULT_FREQUENT_DAY_REFRESH_INTERVAL_MINUTES,
  capturePaused: false,
  capturePausedUntil: null,
  capturePauseSources: ['audio', 'capture'],
  captureSchedule: { ...DEFAULT_CAPTURE_SCHEDULE },
  excludePasswordManagers: true,
  excludePrivateBrowsing: true,
  appCaptureMode: 'exclude',
  excludedAppBundleIds: [],
  includedAppBundleIds: [],
  websiteCaptureMode: 'exclude',
  excludedWebsites: ['bank.example'],
  includedWebsites: [],
}

function resetBrowserSettings(): LocalSettings {
  return {
    ...defaultSettings,
    dayAnalysisProvider: null,
    dayAnalysisOnboardingCompleted: false,
    privacyOnboardingCompleted: false,
    cloudAnalysisConsent: false,
    cloudConsentNoticeSeen: false,
    contextImportOnboardingCompleted: false,
    contextImportCompletedAt: null,
    audioCaptureEnabled: false,
    audioCaptureOnboardingCompleted: false,
    excludedWebsites: [],
  }
}

const readyAgent: AgentSetup = {
  provider: 'codex',
  status: 'ready',
  executable: '/usr/local/bin/codex',
  detail: null,
}

function defaultCaptureState(): CaptureState {
  const activeStartedAt = Date.now() - 4 * 60 * 1_000
  return {
    status: 'recording',
    pauseReason: null,
    pausedSources: [],
    nextScheduleTransitionAt: null,
    activeSessionId: dateId(0),
    startedAt: at(0, 8, 45),
    activeStartedAt,
    activeDurationMs: 5.6 * 60 * 60 * 1_000,
    manualMeeting: null,
    modelDownloaded: true,
    modelDownloadProgress: null,
    modelPreparationPhase: null,
    systemAudioPermission: 'granted',
    microphonePermission: 'granted',
    microphoneName: 'MacBook Microphone',
    microphoneLastChunkAt: Date.now() - 600,
    systemAudioCheckStatus: 'ready',
    systemAudioCheckError: null,
    permissionsResolved: true,
    accessibilityPermission: 'granted',
    inputMonitoringPermission: 'granted',
    appActivityStatus: 'available',
    contextCaptureStatus: 'available',
    contextCaptureHealth: 'healthy',
    contextCaptureLastEventAt: Date.now() - 800,
    settingsHealth: {
      status: 'healthy',
      reason: 'none',
      lastKnownGoodAvailable: true,
      lastKnownGoodAt: Date.now() - 60_000,
    },
    restartRequired: false,
    agent: readyAgent,
    claudeCliAvailable: true,
    error: null,
  }
}

function resetBrowserCaptureState(): CaptureState {
  const state = defaultCaptureState()
  return {
    ...state,
    status: 'idle',
    activeSessionId: null,
    startedAt: null,
    activeStartedAt: null,
    activeDurationMs: 0,
    manualMeeting: null,
    modelDownloaded: false,
    microphoneName: null,
    microphoneLastChunkAt: null,
    contextCaptureLastEventAt: null,
    settingsHealth: {
      status: 'missing',
      reason: 'missing-current',
      lastKnownGoodAvailable: false,
      lastKnownGoodAt: null,
    },
  }
}

function defaultWikiPages(): Record<string, WikiPage[]> {
  const now = Date.now()
  return {
    [PERSONAL_WIKI_SPACE_ID]: [
      {
        slug: 'projects/remember',
        title: 'Remember',
        content:
          '# Remember\n\nA local-first context layer for the workday.\n\n## Current direction\n\nUse the real renderer in the browser for routine visual QA.',
        excerpt: 'A local-first context layer for the workday.',
        updatedAt: now - 22 * 60 * 1_000,
        sourceCount: 12,
      },
      {
        slug: 'processes/browser-ui-testing',
        title: 'Browser UI testing',
        content:
          '# Browser UI testing\n\nRun `pnpm dev`, open `http://localhost:3000`, and test the affected interface states.\n\nNative integration remains a separate focused check.',
        excerpt: 'Routine renderer QA without an Electron window.',
        updatedAt: now - 8 * 60 * 1_000,
        sourceCount: 3,
      },
      {
        slug: 'decisions/local-first-boundary',
        title: 'Local-first boundary',
        content: '# Local-first boundary\n\nPrivate work context stays on the device and remains permissioned.',
        excerpt: 'Private work context stays on the device.',
        updatedAt: now - 3 * 24 * 60 * 60 * 1_000,
        sourceCount: 5,
      },
    ],
    woub: [
      {
        slug: 'projects/mobile-release',
        title: 'Mobile release',
        content: '# Mobile release\n\nKeep the release scope narrow and verify the configured workflow.',
        excerpt: 'Local release context for Woub.',
        updatedAt: now - 2 * 60 * 60 * 1_000,
        sourceCount: 4,
      },
    ],
  }
}

function defaultWikiOverview(): WikiOverview {
  const browserLanguage =
    typeof navigator === 'undefined' ? undefined : (navigator.languages?.[0] ?? navigator.language)
  return {
    spaces: [
      {
        id: PERSONAL_WIKI_SPACE_ID,
        name: defaultPersonalWikiSpaceName(localeFromLanguageTag(browserLanguage)),
        description: '',
        icon: 'lock',
        color: 'slate',
        maintenanceMode: 'auto',
      },
    ],
    suggestions: [0, -1, -3].flatMap((dayOffset) => [
      {
        id: `${dateId(dayOffset)}:processes/browser-ui-testing`,
        dayId: dateId(dayOffset),
        dayStartedAt: startOfDay(dayOffset),
        slug: 'processes/browser-ui-testing',
        title: 'Browser UI testing',
        content: 'Keep the browser-first UI testing workflow and its renderer QA boundary in project memory.',
        summary: 'Keep the browser-first UI testing workflow and its renderer QA boundary in project memory.',
        evidence: [
          {
            sourceId: `browser-ui-source-${dayOffset}`,
            documentSourceId: 'browser-agent-session',
            kind: 'agent-session',
            provider: 'codex',
            project: 'Woub',
            role: 'user',
            observedAt: at(dayOffset, 10, 30),
            quote:
              'Routine UI checks run in the browser. We still need Electron checks for native capture and persistence.',
          },
        ],
        baseRevision: null,
        sourceId: `daily-review://${dateId(dayOffset)}`,
        suggestedSpaceId: PERSONAL_WIKI_SPACE_ID,
        status: 'pending' as const,
        destinationSpaceId: null,
        appliedAt: null,
      },
      {
        id: `${dateId(dayOffset)}:projects/remember`,
        dayId: dateId(dayOffset),
        dayStartedAt: startOfDay(dayOffset),
        slug: 'projects/remember',
        title: 'Remember',
        content: 'Keep the current project context, reliability decisions and remaining release checks.',
        summary: 'Keep the current project context, reliability decisions and remaining release checks.',
        evidence: [
          {
            sourceId: `browser-project-source-${dayOffset}`,
            documentSourceId: 'browser-agent-session',
            kind: 'agent-session',
            provider: 'claude',
            project: 'Remember',
            role: 'user',
            observedAt: at(dayOffset, 11, 20),
            quote: 'Keep the reasons behind our decisions in the project knowledge, so my agent can build on them.',
          },
        ],
        baseRevision: null,
        sourceId: `daily-review://${dateId(dayOffset)}`,
        suggestedSpaceId: PERSONAL_WIKI_SPACE_ID,
        status: 'pending' as const,
        destinationSpaceId: null,
        appliedAt: null,
      },
    ]),
    personalChanges: [
      {
        id: 'browser-personal-change-4',
        timestamp: at(0, 14, 22),
        sourceId: `daily-review://${dateId(0)}`,
        source: 'day',
        dayId: dateId(0),
        changes: [{ slug: 'projects/remember', title: 'Remember', type: 'updated' }],
      },
      {
        id: 'browser-personal-change-3',
        timestamp: at(0, 14, 16),
        sourceId: `daily-review://${dateId(0)}`,
        source: 'day',
        dayId: dateId(0),
        changes: [{ slug: 'processes/browser-ui-testing', title: 'Browser UI testing', type: 'updated' }],
      },
      {
        id: 'browser-personal-change-2',
        timestamp: at(0, 14, 2),
        sourceId: `daily-review://${dateId(0)}`,
        source: 'day',
        dayId: dateId(0),
        changes: [{ slug: 'projects/remember', title: 'Remember', type: 'updated' }],
      },
      {
        id: 'browser-personal-change-1',
        timestamp: at(0, 13, 48),
        sourceId: `daily-review://${dateId(0)}`,
        source: 'day',
        dayId: dateId(0),
        changes: [{ slug: 'projects/remember', title: 'Remember', type: 'updated' }],
      },
    ],
    projectAssignments: [],
  }
}

function resetBrowserWikiOverview(): WikiOverview {
  const overview = defaultWikiOverview()
  return {
    ...overview,
    spaces: overview.spaces.filter((space) => space.id === PERSONAL_WIKI_SPACE_ID),
    suggestions: [],
    personalChanges: [],
    projectAssignments: [],
  }
}

function clearRememberBrowserStorage(storage: Storage) {
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(
    (key): key is string => key?.startsWith('remember:') === true
  )
  for (const key of keys) storage.removeItem(key)
}

function disconnectedBrowserRevinoteStatus(): RevinoteConnectionStatus {
  return {
    state: 'disconnected',
    method: null,
    canPostProcess: false,
    lastSyncedAt: null,
    importedCount: 0,
    error: null,
  }
}

function uniqueSlug(pages: WikiPage[], category: string, title: string) {
  const normalizeSegment = (value: string) =>
    value
      .toLocaleLowerCase('en-US')
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
  const parent = category.split('/').map(normalizeSegment).filter(Boolean).join('/')
  const base = `${parent}/${normalizeSegment(title)}`.replace(/^\/+|\/+$/g, '')
  let slug = base || `${category}/untitled`
  let suffix = 2
  while (pages.some((page) => page.slug === slug)) {
    slug = `${base}-${suffix}`
    suffix += 1
  }
  return slug
}

function isWikiProjectPage(slug: string, projectSlug: string) {
  return slug === projectSlug || slug.startsWith(`${projectSlug}/`)
}

function browserWikiProjectMoveConflicts(
  projectSlug: string,
  sourcePages: WikiPage[],
  destinationPages: WikiPage[],
  requireEmptyNamespace: boolean
) {
  if (requireEmptyNamespace) return destinationPages.some((page) => isWikiProjectPage(page.slug, projectSlug))
  const sourceBySlug = new Map(sourcePages.map((page) => [page.slug, page]))
  return destinationPages.some((destination) => {
    if (!isWikiProjectPage(destination.slug, projectSlug)) return false
    const source = sourceBySlug.get(destination.slug)
    return !source || source.title !== destination.title || source.content !== destination.content
  })
}

export function createBrowserBridge(): RememberBridge {
  let state = defaultCaptureState()
  let settings = { ...defaultSettings }
  let claudeMcpConnected = false
  const browserFixture =
    typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search)
  if (browserFixture.has('always-on-audio')) settings.audioCaptureEnabled = true
  const resetAfterReload = browserFixture.has('reset-data')
  if (resetAfterReload && typeof window !== 'undefined') clearRememberBrowserStorage(window.localStorage)
  let days = [createDay(0, true), createDay(-1), createDay(-3)]
  const processingFixtureConversation =
    browserFixture.has('revinote-processing') || browserFixture.has('revinote-processing-failed')
      ? days[0]?.memory?.conversations[0]
      : undefined
  if (processingFixtureConversation) {
    days = days.map((day, index) =>
      index === 0 && day.memory
        ? {
            ...day,
            memory: {
              ...day.memory,
              conversations: day.memory.conversations.map((conversation, conversationIndex) =>
                conversationIndex === 0
                  ? {
                      ...conversation,
                      processing: browserFixture.has('revinote-processing-failed') ? undefined : 'processing',
                      processingProvider: 'revinote',
                      processingError: browserFixture.has('revinote-processing-failed') ? 'revinote' : undefined,
                      ...(browserFixture.has('conversation-notes-only')
                        ? {
                            notes: 'Besproken: de nieuwe gespreksflow en de planning voor volgende week.',
                            summary: 'Besproken: de nieuwe gespreksflow en de planning voor volgende week.',
                            description: 'Besproken: de nieuwe gespreksflow en de planning voor volgende week.',
                            actionPoints: [],
                          }
                        : {}),
                    }
                  : conversation
              ),
            },
          }
        : day
    )
  }
  let processingFixtureSyncs = 0
  if (browserFixture.has('conversation-merge')) {
    days = days.map((day, index) => {
      if (index !== 0 || !day.memory) return day
      return {
        ...day,
        memory: {
          ...day.memory,
          conversations: [
            ...day.memory.conversations,
            {
              episodeId: `${day.id}:episode-speaker-recognition`,
              startTime: '10:18',
              endTime: '10:36',
              title: 'Speaker recognition and chunking',
              description: 'Discussed speaker recognition embeddings and transcription boundaries.',
              summary: 'Compared speaker recognition approaches and capture chunking behavior.',
              actionPoints: [],
              otherParticipantName: 'Product review',
            },
            {
              episodeId: `${day.id}:episode-model-costs`,
              startTime: '10:51',
              endTime: '11:00',
              title: 'AI model costs and feedback',
              description: 'Discussed affordable AI models, privacy and product feedback.',
              summary: 'Reviewed model costs and the quality bar for a private memory product.',
              actionPoints: [],
              otherParticipantName: 'Product review',
            },
          ],
        },
      }
    })
  }
  if (browserFixture.has('conversation-recovery')) {
    days = days.map((day, index) => {
      if (index !== 0) return day
      const candidate = {
        episodeId: `${day.id}:candidate-woub`,
        startedAt: at(0, 9, 14),
        endedAt: at(0, 10, 22),
        provider: 'woub',
        confidence: 'medium' as const,
        title: 'Woub product review',
        description: 'Recording flow, processing and the remaining release checks.',
        preview: 'We moeten de verwerking en de nieuwe opnameflow nog samen testen.',
        expiresAt: Date.now() + 18 * 60 * 60_000,
      }
      const shortBlock = {
        episodeId: `${day.id}:candidate-short`,
        startedAt: at(0, 11, 4),
        endedAt: at(0, 11, 12),
        provider: null,
        source: 'microphone' as const,
        preview: 'Ja dat klopt, maar dan moeten we dit eerst afronden.',
        momentIds: [],
      }
      const activityBlocks = Array.from({ length: 28 }, (_, blockIndex) => ({
        episodeId: `${day.id}:activity-${blockIndex}`,
        startedAt: at(0, 10, 55 - blockIndex * 4),
        endedAt: at(0, 10, 58 - blockIndex * 4),
        provider: blockIndex % 5 === 0 ? 'google-meet' : null,
        source: blockIndex % 3 === 0 ? ('system' as const) : ('microphone' as const),
        momentIds: [],
        preview:
          blockIndex % 2 === 0
            ? 'De losse audio blijft beschikbaar zodat dit fragment later nog aan een gesprek kan worden toegevoegd.'
            : 'We lopen de resterende punten langs en besluiten wat er als één gesprek moet worden bewaard.',
      }))
      return {
        ...day,
        moments: [
          ...day.moments,
          ...activityBlocks.map((block, index) => ({
            id: `${day.id}:raw-${index}`,
            sessionId: day.id,
            source: block.source,
            startedAt: block.startedAt,
            durationMs: 60_000,
            status: 'ready' as const,
            transcript: block.preview,
          })),
          {
            id: `${day.id}:raw-processing`,
            sessionId: day.id,
            source: 'microphone' as const,
            startedAt: Date.now() - 60_000,
            durationMs: 60_000,
            status: 'transcribing' as const,
            transcript: '',
          },
        ],
        retainedAudioMomentIds: [
          ...day.moments.map((moment) => moment.id),
          ...activityBlocks.map((_, index) => `${day.id}:raw-${index}`),
        ],
        ongoingConversations: [
          {
            episodeId: `${day.id}:ongoing-woub`,
            startedAt: Date.now() - 18 * 60_000,
            lastSpeechAt: Date.now() - 12_000,
            provider: 'woub',
            surfaceKey: 'woub:product',
          },
        ],
        conversationCandidates: [candidate],
        recoverableConversationBlocks: [
          {
            episodeId: candidate.episodeId,
            startedAt: candidate.startedAt,
            endedAt: candidate.endedAt,
            provider: candidate.provider,
            source: 'mixed' as const,
            preview: candidate.preview,
            momentIds: [`${day.id}:microphone`, `${day.id}:system`],
          },
          shortBlock,
          ...activityBlocks,
        ],
      }
    })
  }
  if (browserFixture.has('conversation-combine')) {
    days = days.map((day, index) => {
      if (index !== 0) return day
      const candidates = [
        {
          episodeId: `${day.id}:candidate-tom-agents`,
          startedAt: at(0, 15, 7),
          endedAt: at(0, 15, 38),
          provider: 'discord',
          confidence: 'high' as const,
          title: 'AI agents met Tom',
          description: 'Besproken hoe agents context vasthouden en taken overnemen.',
          preview: 'Dan moet de agent wel weten welke context bij het vervolg hoort.',
          expiresAt: Date.now() + 18 * 60 * 60_000,
        },
        {
          episodeId: `${day.id}:candidate-tom-followup`,
          startedAt: at(0, 15, 39),
          endedAt: at(0, 16, 2),
          provider: 'discord',
          confidence: 'high' as const,
          title: 'Vervolg over agents met Tom',
          description: 'Hetzelfde gesprek ging verder over agentgedrag en productkeuzes.',
          preview: 'Ja precies, dat hoort nog bij hetzelfde gesprek.',
          expiresAt: Date.now() + 18 * 60 * 60_000,
        },
      ]
      return {
        ...day,
        conversationCandidates: candidates,
        recoverableConversationBlocks: candidates.map((candidate) => ({
          episodeId: candidate.episodeId,
          startedAt: candidate.startedAt,
          endedAt: candidate.endedAt,
          provider: candidate.provider,
          source: 'mixed' as const,
          preview: candidate.preview,
          momentIds: [`${day.id}:microphone`, `${day.id}:system`],
        })),
      }
    })
  }
  if (browserFixture.has('long-conversation-history')) {
    days = Array.from({ length: 120 }, (_, index) => createDay(-index, index === 0))
  }
  if (browserFixture.has('revinote-conversation')) {
    days = days.map((day, index) => {
      if (index !== 0 || !day.memory?.conversations[0]) return day
      const [conversation, ...rest] = day.memory.conversations
      return {
        ...day,
        moments: [
          {
            id: `${day.id}:revinote`,
            sessionId: day.id,
            source: 'revinote',
            startedAt: at(0, 10, 2),
            durationMs: 14 * 60 * 1_000,
            status: 'ready',
            transcript:
              '[Robin]: Laten we geimporteerde gesprekken hetzelfde tonen als lokale gesprekken.\n\n[Product review]: Haal de Revinote-bronregel en linkopmaak bij sprekers weg.',
          },
        ],
        memory: {
          ...day.memory,
          conversations: [
            {
              ...conversation,
              ...(browserFixture.has('revinote-remote-only') ? { episodeId: undefined } : {}),
              source: 'revinote',
              externalId: 'browser-revinote-meeting',
            },
            ...rest,
          ],
        },
      }
    })
  }
  if (browserFixture.has('empty-conversations') || browserFixture.has('space-meetings-empty')) {
    days = days.map((day) => ({
      ...day,
      moments: [],
      ongoingConversations: [],
      conversationCandidates: [],
      recoverableConversationBlocks: [],
      memory: day.memory ? { ...day.memory, conversations: [] } : null,
    }))
  }
  let workItems: WorkItem[] = [
    {
      id: 'browser-work-item-inbox',
      aiSuggestion: 'Want me to check the Inbox at desktop and narrow widths?',
      title: 'Controleer de smalle Inbox',
      description: 'Zorg dat de herkomst en de eerstvolgende nuttige stap direct zichtbaar zijn.',
      prompt: 'Werk de Inbox af en controleer de bron-, bewijs- en terugkeerpuntweergave op brede en smalle schermen.',
      context: 'De Origin-richting is gekozen. De productieweergave moet bestaande Inbox-interacties behouden.',
      returnPoint: {
        lastMove: 'De Origin-richting is gekozen en naar de productiecomponent overgezet.',
        unresolved: 'De smalle layout en alle interactieve states moeten nog visueel worden gecontroleerd.',
        nextMove: 'Test de Inbox op desktop en 520 px en herstel elke zichtbare regressie.',
      },
      lifecycle: 'open',
      status: 'in_progress',
      priority: 'high',
      dueAt: at(1, 17, 0),
      attention: 'idle',
      createdAt: at(0, 11, 42),
      updatedAt: Date.now() - 60_000,
      closedAt: null,
      userEditedTitle: false,
      userEditedDescription: false,
      sources: [
        {
          id: 'browser-work-item-inbox-source',
          kind: 'observed',
          label: 'Remember Inbox responsieve QA',
          detail: 'Smalle Inbox-QA bleef open.',
          workdayId: dateId(0),
          conversationStartTime: null,
          observedAt: at(0, 11, 42),
          confidence: 0.94,
        },
      ],
      facts: [
        {
          id: 'browser-work-item-inbox-created',
          type: 'created',
          actor: 'system',
          summary: 'Remember herkende dit als open werk.',
          at: at(0, 11, 42),
          agentSessionId: null,
        },
      ],
      observations: [
        {
          id: 'browser-work-item-inbox-progress',
          kind: 'progress',
          summary: 'De desktoplayout is gecontroleerd; de smalle layout staat nog open.',
          confidence: 0.9,
          workdayId: dateId(0),
          observedAt: Date.now() - 60_000,
          dismissedAt: null,
        },
      ],
      agentSessions: [],
    },
    {
      id: 'browser-work-item-meeting',
      aiSuggestion: 'Want me to write up the agreed Remember direction?',
      title: 'Leg de Remember-richting vast',
      description: 'Leg de gekozen productrichting vast als persoonlijke werkcontinuiteit, niet als automatisering.',
      prompt: 'Vat de gekozen positionering scherp samen en benoem de gevolgen voor de Inbox en het geheugenmodel.',
      context: 'In het gesprek is gekozen voor een persoonlijke plaat die werk terugbrengt met bron en bewijs.',
      returnPoint: {
        lastMove: 'De plaatmetafoor en Origin-weergave zijn als richting bevestigd.',
        unresolved: 'De precieze grens tussen nuttige observatie en een voorgestelde taak moet expliciet blijven.',
        nextMove: 'Schrijf de productregel op waarmee toekomstige Inbox-voorstellen kunnen worden beoordeeld.',
      },
      lifecycle: 'open',
      status: 'todo',
      priority: 'medium',
      dueAt: null,
      attention: 'idle',
      createdAt: at(0, 10, 2),
      updatedAt: Date.now() - 60 * 60_000,
      closedAt: null,
      userEditedTitle: false,
      userEditedDescription: false,
      sources: [
        {
          id: 'browser-work-item-meeting-source',
          kind: 'meeting',
          label: 'Productrichting voor Remember',
          detail: 'Vervolg afgesproken in Origin-gesprek.',
          workdayId: dateId(0),
          conversationReference: `episode:${dateId(0)}:episode-browser-testing`,
          conversationActionId: `episode:${dateId(0)}:episode-browser-testing:action:0`,
          conversationStartTime: '10:02',
          observedAt: at(0, 10, 2),
          confidence: 0.98,
        },
      ],
      facts: [
        {
          id: 'browser-work-item-meeting-created',
          type: 'created',
          actor: 'system',
          summary: 'Remember herkende een expliciet vervolg uit het gesprek.',
          at: at(0, 10, 31),
          agentSessionId: null,
        },
      ],
      observations: [],
      agentSessions: [],
    },
    {
      id: 'browser-work-item-manual',
      title: 'Denk de lege staat en het gedrag bij extreem lange titels zorgvuldig door',
      description: 'Controleer de randgevallen zonder extra dashboardstatus of drukte toe te voegen.',
      prompt: '',
      context: '',
      returnPoint: {
        lastMove: 'Door jou aan Inbox toegevoegd.',
        unresolved: 'Controleer de randgevallen zonder extra dashboardstatus of drukte toe te voegen.',
        nextMove: '',
      },
      lifecycle: 'open',
      status: 'todo',
      priority: 'none',
      dueAt: null,
      attention: 'idle',
      createdAt: Date.now() - 4 * 60 * 60_000,
      updatedAt: Date.now() - 4 * 60 * 60_000,
      closedAt: null,
      userEditedTitle: true,
      userEditedDescription: true,
      sources: [
        {
          id: 'browser-work-item-manual-source',
          kind: 'manual',
          label: 'Handmatig toegevoegd',
          detail: 'Door jou aan de Inbox toegevoegd.',
          workdayId: null,
          conversationStartTime: null,
          observedAt: Date.now() - 4 * 60 * 60_000,
          confidence: null,
        },
      ],
      facts: [
        {
          id: 'browser-work-item-manual-created',
          type: 'created',
          actor: 'user',
          summary: 'Handmatig als werkitem toegevoegd.',
          at: Date.now() - 4 * 60 * 60_000,
          agentSessionId: null,
        },
      ],
      observations: [],
      agentSessions: [],
    },
    {
      id: 'browser-work-item-completed',
      title: 'Kies de nieuwe Inbox-richting',
      description: 'Vergelijk de prototypes en kies de richting die het best bij Remember past.',
      prompt: '',
      context: 'Origin is gekozen.',
      returnPoint: { lastMove: 'Origin is gekozen.', unresolved: '', nextMove: '' },
      lifecycle: 'completed',
      status: 'todo',
      priority: 'none',
      dueAt: null,
      attention: 'idle',
      createdAt: at(-1, 16, 0),
      updatedAt: Date.now() - 24 * 60 * 60_000,
      closedAt: Date.now() - 24 * 60 * 60_000,
      userEditedTitle: false,
      userEditedDescription: false,
      sources: [
        {
          id: 'browser-work-item-completed-source',
          kind: 'observed',
          label: 'Inbox-prototypes',
          detail: 'De vergelijking eindigde met een expliciete keuze voor Origin.',
          workdayId: dateId(-1),
          conversationStartTime: null,
          observedAt: at(-1, 16, 0),
          confidence: 1,
        },
      ],
      facts: [
        {
          id: 'browser-work-item-completed-created',
          type: 'completed',
          actor: 'user',
          summary: 'Als afgerond gemarkeerd.',
          at: Date.now() - 24 * 60 * 60_000,
          agentSessionId: null,
        },
      ],
      observations: [],
      agentSessions: [],
    },
  ]
  if (browserFixture.has('revinote-conversation') && browserFixture.has('revinote-remote-only')) {
    const item = workItems.find((candidate) => candidate.id === 'browser-work-item-meeting')
    for (const source of item?.sources ?? []) {
      source.conversationReference = 'external:browser-revinote-meeting'
      source.conversationActionId = 'external:browser-revinote-meeting:action:0'
    }
  }
  if (browserFixture.has('inbox-original-source')) {
    const item = workItems[0]
    const latestSource = item.sources[0]
    days.push(createDay(-2))
    item.createdAt = at(-2, 11, 42)
    item.sources = [
      {
        ...latestSource,
        id: 'browser-work-item-original-source',
        workdayId: dateId(-2),
        observedAt: item.createdAt,
      },
      latestSource,
    ]
    item.facts[0].at = item.createdAt
  }
  if (browserFixture.has('inbox-ai-suggestions') && workItems[0] && workItems[1]) {
    workItems[0] = {
      ...workItems[0],
      title: 'Make a PDF of the answers',
      description: 'Keep the answers together in one document to take to the meeting.',
      aiSuggestion: 'Want me to make a PDF with the answers?',
      prompt: 'Compile the available answers into a PDF and return a link to the file.',
    }
    workItems[1] = {
      ...workItems[1],
      title: 'Swap suitcase with Tom',
      description: 'Swap your suitcase with Tom before the trip.',
      aiSuggestion: null,
      // An old brief must not make a physical task eligible for AI.
      prompt: 'Prepare the suitcase swap with Tom.',
    }
  }
  if (browserFixture.has('inbox-large')) {
    const completed = workItems.find((item) => item.lifecycle === 'completed')
    if (completed)
      workItems.push(
        ...Array.from({ length: 2_000 }, (_, index) => ({
          ...completed,
          id: `browser-completed-${index}`,
          title: `Completed task ${index + 1}`,
          updatedAt: completed.updatedAt - index * 60_000,
        }))
      )
  }
  if (browserFixture.has('empty-inbox')) workItems = []
  const agentProjects: AgentProject[] = [
    {
      id: '/Users/example/Projects/northstar-desktop',
      name: 'northstar-desktop',
      path: '/Users/example/Projects/northstar-desktop',
      providers: ['codex', 'claude'],
      lastUsedAt: Date.now() - 5 * 60_000,
    },
    {
      id: '/Users/example/Projects/northstar-api',
      name: 'northstar-api',
      path: '/Users/example/Projects/northstar-api',
      providers: ['codex'],
      lastUsedAt: Date.now() - 2 * 60 * 60_000,
    },
  ]
  const workItemAgentProjects = new Map<string, AgentProject | null>()
  let wikiPages = Object.fromEntries(
    Object.entries(defaultWikiPages()).map(([spaceId, pages]) => [
      spaceId,
      pages.map((page) => ({ ...page, revision: page.revision ?? `browser-revision-${page.updatedAt}` })),
    ])
  )
  let wikiOverview = defaultWikiOverview()
  wikiOverview.suggestions = wikiOverview.suggestions.map((suggestion) => ({
    ...suggestion,
    baseRevision:
      wikiPages[suggestion.suggestedSpaceId]?.find((page) => page.slug === suggestion.slug)?.revision ?? null,
  }))
  if (browserFixture.has('living-spaces')) {
    settings.interfaceLanguage = 'nl'
    settings.audioCaptureEnabled = false
    wikiOverview.spaces.push({
      id: 'woub',
      name: 'Woub',
      description: 'App, gesprekken en lopend onderzoek',
      icon: 'folder',
      color: 'slate',
      maintenanceMode: 'auto',
    })
    const now = Date.now()
    wikiPages.woub = [
      {
        slug: 'documents/pushonderzoek',
        title: 'Pushbericht komt niet aan',
        content:
          'Bron: https://woub.sentry.io/issues/123456789\n\n## Wat weten we?\n\nIn dit fictieve onderzoek ontbreekt een send record. Een providerfout is nog niet aangetoond.\n\n## Open vraag\n\nWordt de juiste ontvanger geselecteerd?\n\n## Volgende stap\n\nControleer de aanmaak en targeting voordat we een fix voorstellen.',
        excerpt: 'Controleer de aanmaak en targeting.',
        updatedAt: now,
        sourceCount: 1,
        revision: 'living-demo-1',
      },
      {
        slug: 'documents/release',
        title: 'Volgende release',
        content:
          '## Review\n\nKoppel hier de wijziging, review en verificatie. Een merge bewijst nog geen herstel in productie.',
        excerpt: 'Review en verificatie',
        updatedAt: now - 3600000,
        sourceCount: 0,
        revision: 'living-demo-2',
      },
      {
        slug: 'documents/release/checks',
        title: 'Verificatie op toestel',
        content: 'Leg het geteste toestel, scenario en resultaat vast.',
        excerpt: 'Toestelbewijs',
        updatedAt: now - 3600000,
        sourceCount: 0,
        revision: 'living-demo-3',
      },
    ]
    if (browserFixture.has('space-empty')) wikiPages.woub = []
    if (browserFixture.has('space-same-slug')) {
      wikiPages.personal = [
        ...wikiPages.personal,
        {
          slug: 'documents/pushonderzoek',
          title: 'Persoonlijke afweging',
          content: 'Dit document hoort alleen bij Personal.',
          excerpt: 'Apart document met hetzelfde pad.',
          updatedAt: now,
          sourceCount: 0,
          revision: 'living-personal-1',
        },
      ]
    }
  }

  const wikiHistories = new Map<string, WikiPageHistory>()

  const historyKey = (spaceId: string, slug: string) => `${spaceId}:${slug}`
  const ensureWikiHistory = (spaceId: string, page: WikiPage) => {
    const key = historyKey(spaceId, page.slug)
    const existing = wikiHistories.get(key)
    if (existing) return existing
    const earlierId = `browser-earlier-${page.updatedAt}`
    const headId = page.revision ?? `browser-revision-${page.updatedAt}`
    const history: WikiPageHistory = {
      pageId: `browser-page-${spaceId}-${page.slug}`,
      spaceId,
      slug: page.slug,
      headRevisionId: headId,
      revisions: [
        {
          id: headId,
          parentRevisionId: earlierId,
          createdAt: page.updatedAt,
          actor: 'remember',
          operation: 'updated',
          sourceId: 'daily-review://browser',
          summary: 'Remember werkte de huidige stand bij.',
          evidence: [
            {
              sourceId: 'browser-agent-user',
              documentSourceId: 'browser-agent-session',
              kind: 'agent-session',
              provider: 'codex',
              project: page.title,
              role: 'user',
              observedAt: page.updatedAt - 60_000,
              quote:
                'Bewaar de projectkennis met de reden achter onze keuzes, zodat mijn agent hier later op kan voortbouwen.',
            },
          ],
          title: page.title,
          content: page.content,
          contentHash: headId,
        },
        {
          id: earlierId,
          parentRevisionId: null,
          createdAt: page.updatedAt - 86_400_000,
          actor: 'user',
          operation: 'created',
          sourceId: 'editor',
          summary: null,
          title: page.title,
          content: `${page.content}\n\n_Eerdere versie._`,
          contentHash: earlierId,
        },
      ],
    }
    if (browserFixture.has('living-spaces') && spaceId === 'woub' && page.slug === 'documents/pushonderzoek') {
      history.revisions[0] = {
        ...history.revisions[0],
        actor: 'external',
        sourceId: 'client:claude',
        summary: 'Geen send record gevonden; aanmaak en targeting zijn de volgende controle. (Voorbeeld)',
        evidence: [],
      }
      history.revisions[1] = {
        ...history.revisions[1],
        actor: 'external',
        sourceId: 'client:codex',
        summary: 'Onderzoek gestart vanuit het foutbericht. (Voorbeeld)',
      }
    }
    wikiHistories.set(key, history)
    return history
  }
  const requireWikiSpace = (spaceId: string) => {
    const space = wikiOverview.spaces.find((candidate) => candidate.id === spaceId)
    if (!space) throw new Error('wiki-space-not-found')
    return space
  }
  let update: UpdateState = {
    status: 'unavailable',
    availability: 'development',
    currentVersion: '0.2.9-browser',
    version: null,
    downloadProgress: null,
    errorStage: null,
    revision: 0,
  }
  const stateListeners = new Set<Listener<CaptureState>>()
  const settingsListeners = new Set<Listener<LocalSettings>>()
  const dayListeners = new Set<Listener<DayChanges>>()
  let daySnapshot: DaySnapshot = { revision: 0, days }
  const memoryListeners = new Set<() => void>()
  const updateListeners = new Set<Listener<UpdateState>>()
  const cancelledAgentTurns = new Set<string>()
  const agentTurnUpdateListeners = new Set<Listener<AgentTurnUpdate>>()
  const revinoteStatusListeners = new Set<Listener<RevinoteConnectionStatus>>()
  const emit = <T>(listeners: Set<Listener<T>>, value: T) => {
    for (const listener of listeners) listener(value)
  }
  const emitState = () => emit(stateListeners, state)
  const emitDays = () => {
    const changes = buildDayChanges(daySnapshot, days)
    if (!changes) return
    daySnapshot = { revision: changes.revision, days }
    emit(dayListeners, changes)
  }
  const emitMemoryChanged = () => {
    for (const listener of memoryListeners) listener()
  }
  const emitUpdate = () => emit(updateListeners, update)
  const revinoteCanPostProcess = browserFixture.has('revinote-connected')
  const revinoteConnected = revinoteCanPostProcess || browserFixture.has('revinote-read-only')
  const revinoteOAuthError = browserFixture.has('revinote-oauth-error')
  let revinoteStatus: RevinoteConnectionStatus = {
    state: revinoteOAuthError ? 'error' : revinoteConnected ? 'connected' : 'disconnected',
    method: revinoteOAuthError || revinoteConnected ? 'oauth' : null,
    canPostProcess: revinoteCanPostProcess,
    lastSyncedAt: revinoteConnected ? Date.now() : null,
    importedCount: revinoteConnected ? 3 : 0,
    error: revinoteOAuthError ? 'revinote-oauth-registration-failed' : null,
  }
  const revinotePostProcessing = new Map<string, { meetingId: string; submittedAt: number }>()
  const resetMutableData = () => {
    state = resetBrowserCaptureState()
    settings = resetBrowserSettings()
    days = []
    workItems = []
    workItemAgentProjects.clear()
    wikiPages = { [PERSONAL_WIKI_SPACE_ID]: [] }
    wikiOverview = resetBrowserWikiOverview()
    wikiHistories.clear()
    revinoteStatus = disconnectedBrowserRevinoteStatus()
    revinotePostProcessing.clear()
  }
  if (resetAfterReload) resetMutableData()
  const emitRevinoteStatus = () => emit(revinoteStatusListeners, revinoteStatus)
  const subscribe = <T>(listeners: Set<Listener<T>>, listener: Listener<T>) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  const replaceDay = (dayId: string, transform: (day: Day) => Day) => {
    let result = days.find((day) => day.id === dayId)
    days = days.map((day) => {
      if (day.id !== dayId) return day
      result = transform(day)
      return result
    })
    if (!result) throw new Error(`Unknown browser fixture day: ${dayId}`)
    emitDays()
    return result
  }

  const bridge: RememberBridge = {
    platform: 'macos',
    reportRendererError: noop,
    getUserName: async () => 'Robin',
    getState: async () => state,
    onState: (listener) => subscribe(stateListeners, listener),
    listDays: async () => {
      if (browserFixture.has('space-meetings-loading')) await delay(2000)
      if (browserFixture.has('space-meetings-error')) throw new Error('browser-space-meetings-error')
      return days
    },
    searchDays: async (query, locale) => {
      if (browserFixture.has('search-loading')) await delay(2000)
      if (browserFixture.has('search-error')) throw new Error('browser-search-error')
      return searchRemember(days, query, locale)
    },
    getDayRevision: async () => daySnapshot.revision,
    listDaySnapshot: async () => {
      if (browserFixture.has('space-meetings-loading')) await delay(2000)
      if (browserFixture.has('space-meetings-error')) throw new Error('browser-space-meetings-error')
      emitDays()
      return daySnapshot
    },
    onDays: (listener) => subscribe(dayListeners, listener),
    onMemoryChanged: (listener) => {
      memoryListeners.add(listener)
      return () => memoryListeners.delete(listener)
    },
    listWorkItems: async () => workItems,
    createWorkItem: async (input) => {
      if (browserFixture.has('inbox-error')) throw new Error('browser-inbox-error')
      const now = Date.now()
      const item: WorkItem = {
        id: `browser-work-item-${now}`,
        title: input.title.trim(),
        description: input.description.trim(),
        prompt: '',
        context: '',
        returnPoint: {
          lastMove: 'Door jou aan Inbox toegevoegd.',
          unresolved: input.description.trim(),
          nextMove: '',
        },
        lifecycle: 'open',
        status: 'todo',
        priority: 'none',
        dueAt: null,
        attention: 'idle',
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        userEditedTitle: true,
        userEditedDescription: Boolean(input.description.trim()),
        sources: [
          {
            id: `browser-source-${now}`,
            kind: 'manual',
            label: 'Handmatig toegevoegd',
            detail: 'Door jou aan de Inbox toegevoegd.',
            workdayId: null,
            conversationStartTime: null,
            observedAt: now,
            confidence: null,
          },
        ],
        facts: [
          {
            id: `browser-fact-${now}`,
            type: 'created',
            actor: 'user',
            summary: 'Handmatig als werkitem toegevoegd.',
            at: now,
            agentSessionId: null,
          },
        ],
        observations: [],
        agentSessions: [],
      }
      workItems = [item, ...workItems]
      return item
    },
    updateWorkItem: async (itemId, input) => {
      if (browserFixture.has('inbox-error')) throw new Error('browser-inbox-error')
      const now = Date.now()
      let updated: WorkItem | null = null
      workItems = workItems.map((item) => {
        if (item.id !== itemId) return item
        updated = {
          ...item,
          title: input.title.trim(),
          description: input.description.trim(),
          returnPoint: {
            ...item.returnPoint,
            unresolved:
              item.sources[0]?.kind === 'manual' && item.returnPoint.unresolved === item.description
                ? input.description.trim()
                : item.returnPoint.unresolved,
          },
          updatedAt: now,
          userEditedTitle: true,
          userEditedDescription: true,
          facts: [
            ...item.facts,
            {
              id: `browser-fact-edit-${now}`,
              type: 'edited',
              actor: 'user',
              summary: 'Titel of beschrijving bijgewerkt.',
              at: now,
              agentSessionId: null,
            },
          ],
        }
        return updated
      })
      if (!updated) throw new Error('work-item-not-found')
      return updated
    },
    updateWorkItemMetadata: async (itemId, input) => {
      if (browserFixture.has('inbox-error')) throw new Error('browser-inbox-error')
      const now = Date.now()
      let updated: WorkItem | null = null
      workItems = workItems.map((item) => {
        if (item.id !== itemId) return item
        updated = {
          ...item,
          ...input,
          updatedAt: now,
          facts: [
            ...item.facts,
            {
              id: `browser-fact-metadata-${now}`,
              type: 'edited',
              actor: 'user',
              summary: 'Planning bijgewerkt.',
              at: now,
              agentSessionId: null,
            },
          ],
        }
        return updated
      })
      if (!updated) throw new Error('work-item-not-found')
      return updated
    },
    setWorkItemLifecycle: async (itemId, lifecycle) => {
      if (browserFixture.has('inbox-error')) throw new Error('browser-inbox-error')
      const now = Date.now()
      let updated: WorkItem | null = null
      workItems = workItems.map((item) => {
        if (item.id !== itemId) return item
        const type = lifecycle === 'open' ? 'reopened' : lifecycle
        updated = {
          ...item,
          lifecycle,
          attention: 'idle',
          updatedAt: now,
          closedAt: lifecycle === 'open' ? null : now,
          facts: [
            ...item.facts,
            {
              id: `browser-fact-lifecycle-${now}`,
              type,
              actor: 'user',
              summary:
                lifecycle === 'completed'
                  ? 'Werkitem afgerond.'
                  : lifecycle === 'open'
                    ? 'Werkitem opnieuw geopend.'
                    : 'Werkitem niet meer actief.',
              at: now,
              agentSessionId: null,
            },
          ],
        }
        return updated
      })
      if (!updated) throw new Error('work-item-not-found')
      return updated
    },
    recordWorkItemAgentSession: async (itemId, input) => {
      const completedAt = input.startedAt + input.durationMs
      let updated: WorkItem | null = null
      workItems = workItems.map((item) => {
        if (item.id !== itemId) return item
        updated = {
          ...item,
          attention: 'idle',
          updatedAt: completedAt,
          facts: [
            ...item.facts,
            {
              id: `${input.sessionId}:started`,
              type: 'agent_started',
              actor: 'user',
              summary: `${input.provider === 'claude' ? 'Claude' : 'Codex'} gestart.`,
              at: input.startedAt,
              agentSessionId: input.sessionId,
            },
            {
              id: `${input.sessionId}:completed`,
              type: 'agent_completed',
              actor: 'agent',
              summary: 'Agent heeft een update geleverd.',
              at: completedAt,
              agentSessionId: input.sessionId,
            },
          ],
          agentSessions: [
            ...item.agentSessions,
            {
              id: input.sessionId,
              provider: input.provider,
              status: 'completed',
              instruction: input.prompt,
              message: input.message,
              response: input.response,
              startedAt: input.startedAt,
              updatedAt: completedAt,
              completedAt,
              durationMs: input.durationMs,
              steps: input.steps,
            },
          ],
        }
        return updated
      })
      if (!updated) throw new Error('work-item-not-found')
      return updated
    },
    startWorkItemAgentSession: async (itemId, input) => {
      let updated: WorkItem | null = null
      workItems = workItems.map((item) => {
        if (item.id !== itemId) return item
        updated = {
          ...item,
          attention: 'agent_running',
          updatedAt: input.startedAt,
          facts: [
            ...item.facts,
            {
              id: `${input.sessionId}:started`,
              type: 'agent_started',
              actor: 'user',
              summary: `${input.provider === 'claude' ? 'Claude' : 'Codex'} gestart.`,
              at: input.startedAt,
              agentSessionId: input.sessionId,
            },
          ],
          agentSessions: [
            ...item.agentSessions,
            {
              id: input.sessionId,
              provider: input.provider,
              status: 'running',
              instruction: input.prompt,
              message: input.message,
              response: '',
              startedAt: input.startedAt,
              updatedAt: input.startedAt,
              completedAt: null,
              durationMs: null,
              steps: [],
            },
          ],
        }
        return updated
      })
      if (!updated) throw new Error('work-item-not-found')
      return updated
    },
    finishWorkItemAgentSession: async (itemId, sessionId, input) => {
      const now = Date.now()
      const result = parseInboxResult(input.response)
      let updated: WorkItem | null = null
      workItems = workItems.map((item) => {
        if (item.id !== itemId) return item
        updated = {
          ...item,
          attention: result.update?.needsUser ? 'waiting_on_user' : 'idle',
          returnPoint: result.update
            ? { lastMove: result.update.summary, unresolved: result.update.remaining, nextMove: result.update.nextStep }
            : item.returnPoint,
          updatedAt: now,
          facts: [
            ...item.facts,
            {
              id: `${sessionId}:completed`,
              type: 'agent_completed',
              actor: 'agent',
              summary: result.update?.summary ?? 'Agent heeft een update geleverd.',
              at: now,
              agentSessionId: sessionId,
            },
          ],
          agentSessions: item.agentSessions.map((session) =>
            session.id === sessionId
              ? {
                  ...session,
                  status: 'completed',
                  response: result.response,
                  updatedAt: now,
                  completedAt: now,
                  durationMs: input.durationMs,
                  steps: input.steps,
                }
              : session
          ),
        }
        return updated
      })
      if (!updated) throw new Error('work-item-not-found')
      return updated
    },
    failWorkItemAgentSession: async (itemId, sessionId) => {
      const now = Date.now()
      let updated: WorkItem | null = null
      workItems = workItems.map((item) => {
        if (item.id !== itemId) return item
        updated = {
          ...item,
          attention: 'idle',
          updatedAt: now,
          facts: [
            ...item.facts,
            {
              id: `${sessionId}:failed`,
              type: 'agent_failed',
              actor: 'agent',
              summary: 'Agent kon het werk niet afronden.',
              at: now,
              agentSessionId: sessionId,
            },
          ],
          agentSessions: item.agentSessions.map((session) =>
            session.id === sessionId ? { ...session, status: 'failed', updatedAt: now, completedAt: now } : session
          ),
        }
        return updated
      })
      if (!updated) throw new Error('work-item-not-found')
      return updated
    },
    prepareModel: async () => state,
    pauseCapture: async (input) => {
      const sources: CapturePauseSource[] =
        typeof input === 'object' && input != null ? Array.from(new Set(input.sources)) : ['audio', 'capture']
      const durationMs = typeof input === 'object' && input != null ? input.durationMs : input
      const allPaused = sources.includes('audio') && sources.includes('capture')
      const pausedUntil = durationMs ? Date.now() + durationMs : null
      state = {
        ...state,
        status: allPaused ? 'paused' : 'recording',
        pauseReason: allPaused ? 'manual' : null,
        pausedSources: sources,
        activeStartedAt: allPaused ? null : (state.activeStartedAt ?? Date.now()),
      }
      settings = {
        ...settings,
        capturePaused: sources.length > 0,
        capturePausedUntil: sources.length > 0 ? pausedUntil : null,
        capturePauseSources: sources,
      }
      emitState()
      return state
    },
    resumeCapture: async () => {
      state = { ...state, status: 'recording', pauseReason: null, pausedSources: [], activeStartedAt: Date.now() }
      settings = { ...settings, capturePaused: false, capturePausedUntil: null }
      emitState()
      return state
    },
    startManualMeeting: async () => {
      if (state.manualMeeting) return state
      if (browserFixture.has('conversation-start-loading')) await delay(2500)
      if (browserFixture.has('conversation-start-error')) throw new Error('manual-meeting-microphone-not-ready')
      const now = Date.now()
      const availableFromAt = browserFixture.has('conversation-recovery') ? now - 18 * 60_000 : now
      state = {
        ...state,
        manualMeeting: {
          id: `browser-meeting-${now}`,
          workdayId: state.activeSessionId ?? dateId(0),
          title: manualMeetingTitle(
            availableFromAt,
            resolveInterfaceLocale(settings.interfaceLanguage, navigator.language)
          ),
          notes: '',
          startedAt: availableFromAt,
          confirmedAt: now,
          availableFromAt,
          endedAt: null,
          pausedAt: null,
          pausedMs: 0,
          status: 'recording',
          automaticRevinoteProcessingBlocked: false,
          systemAudioAvailable: state.systemAudioCheckStatus === 'ready',
        },
      }
      emitState()
      return state
    },
    updateManualMeetingDetails: async (id, title, notes) => {
      if (browserFixture.has('conversation-save-error')) throw new Error('meeting-details-save-failed')
      if (state.manualMeeting?.id !== id || state.manualMeeting.status !== 'recording')
        throw new Error('manual-meeting-not-active')
      state = { ...state, manualMeeting: { ...state.manualMeeting, title: title.trim() || 'Nieuw gesprek', notes } }
      emitState()
      return state
    },
    updateManualMeetingStart: async (meetingId, startedAt) => {
      const meeting = state.manualMeeting
      if (meeting?.id !== meetingId || meeting.status !== 'recording') {
        throw new Error('manual-meeting-not-active')
      }
      const availableFromAt = meeting.availableFromAt ?? meeting.startedAt
      const confirmedAt = meeting.confirmedAt ?? meeting.startedAt
      if (startedAt < availableFromAt || startedAt > confirmedAt) throw new Error('manual-meeting-start-invalid')
      state = { ...state, manualMeeting: { ...meeting, startedAt } }
      emitState()
      return state
    },
    pauseManualMeeting: async (meetingId) => {
      if (state.manualMeeting?.id !== meetingId || state.manualMeeting.status !== 'recording') {
        throw new Error('manual-meeting-not-active')
      }
      if (state.manualMeeting.pausedAt != null) return state
      state = {
        ...state,
        manualMeeting: { ...state.manualMeeting, pausedAt: Date.now() },
      }
      emitState()
      return state
    },
    resumeManualMeeting: async (meetingId) => {
      const meeting = state.manualMeeting
      if (meeting?.id !== meetingId || meeting.status !== 'recording') {
        throw new Error('manual-meeting-not-active')
      }
      if (meeting.pausedAt == null) return state
      state = {
        ...state,
        manualMeeting: {
          ...meeting,
          pausedAt: null,
          pausedMs: meeting.pausedMs + Math.max(0, Date.now() - meeting.pausedAt),
        },
      }
      emitState()
      return state
    },
    stopManualMeeting: async (meetingId, details) => {
      if (state.manualMeeting?.id !== meetingId) throw new Error('manual-meeting-not-active')
      const meeting = details
        ? { ...state.manualMeeting, title: details.title.trim() || 'Nieuw gesprek', notes: details.notes }
        : state.manualMeeting
      const endedAt = Date.now()
      const episodeId = `${meeting.id}:episode`
      const automaticRevinoteProcessing =
        settings.automaticRevinoteProcessing && revinoteStatus.state === 'connected' && revinoteStatus.canPostProcess
      const dayIndex = Math.max(
        0,
        days.findIndex((day) => day.id === meeting.workdayId)
      )
      const day = days[dayIndex]
      if (day?.memory) {
        const startedAt = new Date(meeting.startedAt)
        const finishedAt = new Date(endedAt)
        const time = (date: Date) =>
          `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
        const conversation = {
          startTime: time(startedAt),
          endTime: time(finishedAt),
          title: meeting.title,
          description: meeting.notes,
          notes: meeting.notes,
          episodeId,
          manualMeetingId: meeting.id,
          processing: 'processing' as const,
          processingProvider: automaticRevinoteProcessing ? ('revinote' as const) : ('remember' as const),
        }
        days = days.map((candidate, index) =>
          index === dayIndex && candidate.memory
            ? {
                ...candidate,
                memory: {
                  ...candidate.memory,
                  conversations: [...candidate.memory.conversations, conversation],
                },
              }
            : candidate
        )
        emitDays()
      }
      state = { ...state, manualMeeting: null }
      emitState()
      if (automaticRevinoteProcessing) {
        revinotePostProcessing.set(episodeId, {
          meetingId: `revinote-${episodeId}`,
          submittedAt: Date.now(),
        })
      }
      setTimeout(() => {
        days = days.map((candidate) =>
          candidate.id === meeting.workdayId && candidate.memory
            ? {
                ...candidate,
                memory: {
                  ...candidate.memory,
                  conversations: candidate.memory.conversations.map((conversation) =>
                    conversation.manualMeetingId === meeting.id
                      ? automaticRevinoteProcessing
                        ? {
                            ...conversation,
                            title: 'Revinote meeting',
                            description: 'Processed automatically with Revinote.',
                            summary: 'Processed automatically with Revinote.',
                            source: 'revinote' as const,
                            externalId: `revinote-${episodeId}`,
                            processing: undefined,
                            processingProvider: undefined,
                          }
                        : {
                            ...conversation,
                            summary: 'Deze browseropname is klaar om te bekijken.',
                            processing: undefined,
                            processingProvider: undefined,
                          }
                      : conversation
                  ),
                },
              }
            : candidate
        )
        emitDays()
      }, 750)
      return state
    },
    discardManualMeeting: async (meetingId) => {
      if (state.manualMeeting?.id !== meetingId || state.manualMeeting.status !== 'recording') {
        throw new Error('manual-meeting-not-active')
      }
      state = { ...state, manualMeeting: null }
      emitState()
      return state
    },
    onMeetingReminder: () => noop,
    clearRecentCapture: async (cutoff) => {
      days = days.map((day) => ({
        ...day,
        moments: day.moments.filter((moment) => moment.startedAt < cutoff),
        appActivity: day.appActivity.filter((activity) => activity.startedAt < cutoff),
        contextMoments: day.contextMoments.filter((moment) => moment.timestamp < cutoff),
        contextEvidenceRemovals: (day.contextEvidenceRemovals ?? 0) + 1,
      }))
      emitDays()
      return days
    },
    verifySystemAudio: async () => state,
    requestMicrophonePermission: async () => state,
    requestAccessibilityPermission: async () => state,
    showAccessibilityPermissionGuide: resolved,
    getAccessibilityPermissionStatus: async () => true,
    startPermissionGuideDrag: noop,
    closePermissionGuide: noop,
    openSystemAudioSettings: resolved,
    openMicrophoneSettings: resolved,
    openAccessibilitySettings: resolved,
    restartApp: resolved,
    revealDataFolder: resolved,
    getSettings: async () => settings,
    onSettingsChanged: (listener) => subscribe(settingsListeners, listener),
    updateSettings: async (patch) => {
      settings = { ...settings, ...patch }
      emit(settingsListeners, settings)
      return settings
    },
    repairSettings: async () => settings,
    getRevinoteConnectionStatus: async () => revinoteStatus,
    connectRevinote: async () => {
      revinoteStatus = { ...revinoteStatus, state: 'connecting', method: 'oauth', error: null }
      emitRevinoteStatus()
      globalThis.setTimeout(() => {
        revinoteStatus = {
          state: 'connected',
          method: 'oauth',
          canPostProcess: true,
          lastSyncedAt: Date.now(),
          importedCount: 3,
          error: null,
        }
        emitRevinoteStatus()
      }, 400)
      return revinoteStatus
    },
    syncRevinote: async () => {
      if (
        processingFixtureConversation &&
        !browserFixture.has('revinote-processing-stalled') &&
        !browserFixture.has('revinote-processing-failed')
      ) {
        processingFixtureSyncs += 1
        if (processingFixtureSyncs === 1) throw new Error('temporary-revinote-sync-failure')
        if (processingFixtureSyncs === 3) {
          days = days.map((day, index) =>
            index === 0 && day.memory
              ? {
                  ...day,
                  memory: {
                    ...day.memory,
                    conversations: [processingFixtureConversation, ...day.memory.conversations.slice(1)],
                  },
                }
              : day
          )
          // Deliberately omit the notification: polling must discover the completed snapshot.
        }
      }
      revinoteStatus = { ...revinoteStatus, lastSyncedAt: Date.now(), error: null }
      emitRevinoteStatus()
      return { status: revinoteStatus, imported: 0, updated: 0 }
    },
    disconnectRevinote: async () => {
      revinoteStatus = {
        ...revinoteStatus,
        state: 'disconnected',
        method: null,
        canPostProcess: false,
        error: null,
      }
      emitRevinoteStatus()
      return revinoteStatus
    },
    onRevinoteConnectionStatus: (listener) => subscribe(revinoteStatusListeners, listener),
    getRevinotePostProcessStatus: async (episodeId) => {
      const submission = revinotePostProcessing.get(episodeId)
      return submission ? { state: 'queued', ...submission } : { state: 'idle', meetingId: null, submittedAt: null }
    },
    postProcessConversationWithRevinote: async (dayId, reference) => {
      if (browserFixture.has('revinote-post-process-error')) throw new Error('revinote-post-process-failed')
      const conversation = resolveConversationReference(
        days.find((day) => day.id === dayId)?.memory?.conversations ?? [],
        reference
      )
      if (!conversation?.episodeId || conversation.source === 'revinote')
        throw new Error('conversation-source-not-local')
      await delay(500)
      const result = { meetingId: `browser-revinote-${conversation.episodeId}`, submittedAt: Date.now() }
      revinotePostProcessing.set(conversation.episodeId, result)
      return result
    },
    resetPermissionsForDevelopment: async () => true,
    resetAllData: async () => {
      if (typeof window !== 'undefined') clearRememberBrowserStorage(window.localStorage)
      resetMutableData()
      emitState()
      emitDays()
      emitMemoryChanged()
      emitRevinoteStatus()
      if (typeof window !== 'undefined') {
        clearRememberBrowserStorage(window.localStorage)
        window.location.replace('/?preview-onboarding=1&reset-data=1')
      }
      return true
    },
    getCodexModels: async () => FALLBACK_CODEX_MODELS,
    checkAgent: async (provider = settings.defaultAgentProvider) => ({ ...readyAgent, provider }),
    openAgentLogin: resolved,
    logoutAgent: resolved,
    getContextImportPreview: async () => ({
      providers: [
        {
          provider: 'codex',
          available: true,
          projectCount: 4,
          sessionCount: 28,
          memoryCount: 12,
          latestAt: Date.now() - 60 * 60 * 1_000,
        },
      ],
    }),
    importAgentContext: async () => ({
      providers: ['codex'],
      sourceCount: 28,
      createdPages: [],
      updatedPages: ['projects/remember'],
    }),
    getAgentLearningStatus: async () => ({
      status: !settings.agentLearningEnabled ? 'disabled' : settings.offlineMode ? 'offline' : 'watching',
      lastCheckedAt: settings.agentLearningEnabled ? Date.now() : null,
      lastProcessedAt: null,
      pendingCount: 0,
      sourceCount: 0,
      error: null,
    }),
    checkAgentLearning: async () => ({
      status: !settings.agentLearningEnabled ? 'disabled' : settings.offlineMode ? 'offline' : 'watching',
      lastCheckedAt: settings.agentLearningEnabled ? Date.now() : null,
      lastProcessedAt: null,
      pendingCount: 0,
      sourceCount: 0,
      error: null,
    }),
    openAgentChat: async () => true,
    listAgentProjects: async () => agentProjects,
    chooseAgentProject: async () => agentProjects[0] ?? null,
    getWorkItemAgentContext: async (itemId) => ({ project: workItemAgentProjects.get(itemId) ?? null }),
    setWorkItemAgentProject: async (itemId, project) => {
      workItemAgentProjects.set(itemId, project)
      return { project }
    },
    ...createBrowserAssistantBridge(async () => {
      const projectSlug = 'projects/china'
      const documentSlug = `${projectSlug}/practical-info`
      await bridge.createWikiPage({
        spaceId: PERSONAL_WIKI_SPACE_ID,
        category: 'projects',
        slug: projectSlug,
        title: 'China',
        content:
          'Een reis naar Beijing, Shanghai en Shenzhen voorbereiden.\n\n## Eerste route\n\n| Plaats | Ideeën |\n| --- | --- |\n| Beijing | Verboden Stad, hutongs en een dag naar de Chinese Muur |\n| Shanghai | Architectuur, eten en een wandeling langs de Bund |\n| Shenzhen | Hardwaremarkten en makerspaces |\n\n## Nog bepalen\n\n- Reisdata en verblijfsduur.\n- Verdeling van de dagen per stad.\n- Budget en vertrekplaats.',
      })
      const pages = await bridge.createWikiPage({
        spaceId: PERSONAL_WIKI_SPACE_ID,
        category: 'projects',
        parentSlug: projectSlug,
        slug: documentSlug,
        title: 'Praktische voorbereiding',
        content:
          '## Voor vertrek\n\n- Controleer de actuele inreisvoorwaarden voor je paspoort en reisdata.\n- Zoek een passende reisverzekering.\n- Vergelijk treinverbindingen tussen de gekozen steden.\n\n## Onderweg\n\n- Bewaar hoteladressen ook in het Chinees.\n- Download offline kaarten en vertalingen.\n- Regel mobiel internet en een betaalmethode voor vertrek.\n\nDit is een eerste checklist; voorwaarden en beschikbaarheid moeten nog worden gecontroleerd.',
      })
      emitMemoryChanged()
      return [projectSlug, documentSlug].map((slug) => {
        const page = pages.find((entry) => entry.slug === slug)
        if (!page?.revision) throw new Error('browser-project-document-not-created')
        return {
          id: `browser-document-${slug}`,
          kind: 'saved-page',
          spaceId: PERSONAL_WIKI_SPACE_ID,
          slug,
          revision: page.revision,
          title: page.title,
        }
      })
    }),
    runAgentTurn: async (input) => {
      const startedAt = Date.now()
      let steps: AgentTurnStep[] = []
      const update = (type: AgentTurnUpdate['type'], id: string, text: string) => {
        if (cancelledAgentTurns.delete(input.turnId)) throw new Error('agent-cancelled')
        const event = { turnId: input.turnId, provider: input.provider, type, id, text, at: Date.now() }
        if (type !== 'response') {
          const step = { id, kind: type, text, at: event.at }
          const existing = steps.findIndex((candidate) => candidate.id === id)
          steps =
            existing >= 0
              ? steps.map((candidate, index) => (index === existing ? { ...step, at: candidate.at } : candidate))
              : [...steps, step]
        }
        emit(agentTurnUpdateListeners, event)
      }
      update('status', 'browser-started', 'Actiepunt begrijpen')
      await delay(350)
      const selectedProject = input.workItemId ? (workItemAgentProjects.get(input.workItemId) ?? null) : null
      update(
        'reasoning',
        'browser-context',
        selectedProject
          ? `Ik werk in ${selectedProject.name} en verbind de opdracht met de huidige taakstatus.`
          : 'Ik verbind je opdracht met de beschrijving en de huidige taakstatus.'
      )
      await delay(450)
      update('status', 'browser-writing', 'Antwoord schrijven')
      const start = 'Ik heb het actiepunt bekeken en de opdracht uitgewerkt.'
      update('response', 'browser-response', start)
      await delay(450)
      const response =
        input.workItemId === 'browser-work-item-meeting'
          ? `De voorbereiding voor het gesprek staat klaar: bepaal eerst welk probleem Remember voor de eerste gebruikers moet oplossen, en kies daarna wat je gaat toetsen.

## Agenda
1. Welke terugkerende vraag willen gebruikers sneller kunnen beantwoorden?
2. Welk bewijs hebben we al, en wat is nog een aanname?
3. Welke kleine proef helpt ons deze week een richting te kiezen?

## Waarom deze volgorde
Een gedeeld probleem maakt de keuze tussen oplossingen concreet. Bespreek eerst de behoefte en de onzekerheden; bespreek daarna de functies die daarbij passen.

## Onderbouwing
Dit is een voorbeeldbriefing op basis van het ontwikkelitem “Leg de Remember-richting vast”. Er zijn geen aanvullende bronnen opgehaald en er is niemand benaderd.

## Nog te bespreken
Wie doet mee aan de proef, en wanneer beoordelen jullie de uitkomst? Die keuzes blijven bij jou en je gesprekspartner.`
          : input.workItemId
            ? `De Inbox-aanpak is uitgewerkt: houd de opdracht, het werkgesprek en het resultaat bij elkaar, met een duidelijke volgende stap.

## Uitwerking
| Onderdeel | Doel | Wat je terugvindt |
| --- | --- | --- |
| **Taak** | Leg het beoogde resultaat vast voordat je begint. | Beschrijving, context en volgende stap. |
| **Worker** | Houd voortgang en vervolgvragen in hetzelfde gesprek. | Je berichten, werkstappen en antwoorden. |
| **Resultaat** | Maak de oplevering makkelijk terug te lezen. | Uitkomst, afwegingen en bewijs. |

## Waarom zo
Je kunt eerst bepalen of het werk de moeite waard is. Daarna lees je het resultaat zonder het hele werkgesprek te hoeven reconstrueren. Kleine taken houden een kort resultaat; grotere taken krijgen meer onderbouwing.

## Bewijs en beperkingen
Dit is een ontwikkelvoorbeeld${selectedProject ? ` voor ${selectedProject.name}` : ''}. De browserbridge simuleert een workerantwoord. Er zijn door deze run geen bestanden gewijzigd, tests uitgevoerd of externe bronnen gecontroleerd.

## Volgende stap
Beoordeel de taak met echte projectcontext en leg de uitgevoerde controles en eventuele schermafbeeldingen vast.`
            : `${start} Dit is een ontwikkelantwoord van de lokale browserbridge; de Electron-app gebruikt de echte gekoppelde agent.`
      update('response', 'browser-response', response)
      return { provider: input.provider, response, durationMs: Date.now() - startedAt, steps }
    },
    getAgentInteractions: async () => [],
    answerAgentInteraction: async () => {
      throw new Error('agent-request-expired')
    },
    onAgentInteractionsChanged: () => () => {},
    cancelAgentTurn: async (turnId) => {
      cancelledAgentTurns.add(turnId)
    },
    onAgentTurnUpdate: (listener) => subscribe(agentTurnUpdateListeners, listener),
    refreshDay: async (dayId) => {
      const day = replaceDay(dayId, (current) => ({
        ...current,
        memory: current.memory ? { ...current.memory, refreshedAt: Date.now(), coveredThrough: Date.now() } : null,
      }))
      emitMemoryChanged()
      return day
    },
    updateTimelineItem: async (dayId, itemId, input) =>
      replaceDay(dayId, (day) => ({
        ...day,
        memory: day.memory
          ? {
              ...day.memory,
              timeline: day.memory.timeline.map((item) => (item.id === itemId ? { ...item, ...input } : item)),
            }
          : null,
      })),
    hideTimelineItem: async (dayId, itemId) =>
      replaceDay(dayId, (day) => ({
        ...day,
        memory: day.memory
          ? {
              ...day.memory,
              hiddenTimelineItemIds: Array.from(new Set([...(day.memory.hiddenTimelineItemIds ?? []), itemId])),
            }
          : null,
      })),
    showHiddenTimelineItems: async (dayId) =>
      replaceDay(dayId, (day) => ({
        ...day,
        memory: day.memory ? { ...day.memory, hiddenTimelineItemIds: [] } : null,
      })),
    addTimelineItemToWiki: async (dayId, itemId) => {
      const block = days.find((day) => day.id === dayId)?.memory?.timeline.find((item) => item.id === itemId)
      if (!block) throw new Error('timeline-item-not-found')
      const pages = wikiPages[PERSONAL_WIKI_SPACE_ID] ?? []
      const title = block.title.trim() || 'Timeline note'
      const slug = uniqueSlug(pages, 'research', title)
      const description = block.description.trim()
      const updatedAt = Date.now()
      wikiPages = {
        ...wikiPages,
        [PERSONAL_WIKI_SPACE_ID]: [
          ...pages,
          {
            slug,
            title,
            content: `# ${title}${description ? `\n\n${description}` : ''}`,
            excerpt: description,
            updatedAt,
            sourceCount: block.sourceRefs?.length ?? 0,
            revision: `browser-revision-${updatedAt}`,
          },
        ],
      }
      return { slug, title, changeType: 'created' }
    },
    getConversationAudioUrl: async (dayId, reference) => {
      if (browserFixture.has('conversation-audio-loading')) await delay(3_000)
      if (browserFixture.has('conversation-audio-lookup-error')) throw new Error('conversation-audio-lookup-failed')
      if (browserFixture.has('conversation-audio-unavailable')) return null
      if (browserFixture.has('conversation-audio-error')) return 'data:audio/wav;base64,AA=='
      const conversations = days.find((day) => day.id === dayId)?.memory?.conversations ?? []
      const conversation =
        resolveConversationReference(conversations, reference) ??
        conversations.find((candidate) => candidate.episodeId === reference)
      const manualMeetingHasAudio =
        state.manualMeeting?.workdayId === dayId && state.manualMeeting.episodeId === reference
      return conversation || manualMeetingHasAudio ? conversationAudioFixtureUrl() : null
    },
    setConversationAudioPlayback: async () => undefined,
    saveConversationAudio: async (dayId, reference) => {
      if (browserFixture.has('conversation-download-loading')) await delay(3_000)
      if (browserFixture.has('conversation-download-error')) throw new Error('conversation-audio-export-failed')
      if (browserFixture.has('conversation-download-cancel')) return false
      const conversations = days.find((day) => day.id === dayId)?.memory?.conversations ?? []
      const conversation =
        resolveConversationReference(conversations, reference) ??
        conversations.find((candidate) => candidate.episodeId === reference)
      if (!conversation && state.manualMeeting?.episodeId !== reference) throw new Error('conversation-audio-not-found')
      const link = document.createElement('a')
      link.href = conversationAudioFixtureUrl()
      link.download = 'Conversation.wav'
      link.click()
      return true
    },
    deleteConversation: async (dayId, reference) =>
      replaceDay(dayId, (day) => {
        if (!day.memory) return day
        const conversation = resolveConversationReference(day.memory.conversations, reference)
        if (!conversation) throw new Error('conversation-not-found')
        const deletedConversationWindows = day.memory.deletedConversationWindows ?? []
        const deletedReference = {
          startTime: conversation.startTime,
          endTime: conversation.endTime,
          ...(conversation.episodeId ? { episodeId: conversation.episodeId } : {}),
          ...(conversation.externalId ? { externalId: conversation.externalId } : {}),
          ...(conversation.id ? { id: conversation.id } : {}),
        }
        const stableReference = conversationReference(conversation)
        return {
          ...day,
          memory: {
            ...day.memory,
            conversations: day.memory.conversations.filter((candidate) => candidate !== conversation),
            deletedConversationWindows: deletedConversationWindows.some((candidate) =>
              candidate.episodeId || candidate.externalId || candidate.id
                ? conversationReference(candidate) === stableReference
                : candidate.startTime === conversation.startTime && candidate.endTime === conversation.endTime
            )
              ? deletedConversationWindows
              : [...deletedConversationWindows, deletedReference],
          },
        }
      }),
    mergeConversations: async (dayId, references) => {
      const selectedReferences = [...new Set(references)]
      if (selectedReferences.length < 2) throw new Error('conversation-merge-needs-two-sources')
      const episodeId = `browser-merged-${Date.now()}`
      const result = replaceDay(dayId, (day) => {
        if (!day.memory) throw new Error('day-memory-not-found')
        const selected = selectedReferences
          .map((reference) => resolveConversationReference(day.memory?.conversations ?? [], reference))
          .filter((conversation) => conversation != null)
          .sort((first, second) => first.startTime.localeCompare(second.startTime))
        const first = selected[0]
        if (!first || selected.length !== selectedReferences.length) throw new Error('conversation-not-found')
        if (new Set(selected).size !== selected.length) throw new Error('conversation-merge-needs-two-sources')
        const selectedConversations = new Set(selected)
        return {
          ...day,
          memory: {
            ...day.memory,
            conversations: [
              ...day.memory.conversations.filter((conversation) => !selectedConversations.has(conversation)),
              {
                episodeId,
                startTime: first.startTime,
                endTime: selected.reduce(
                  (latest, conversation) => (conversation.endTime > latest ? conversation.endTime : latest),
                  first.endTime
                ),
                title: 'Gesprekken worden samengevoegd',
                description: 'Het samengevoegde gesprek wordt opnieuw verwerkt.',
                summary: selected.flatMap((conversation) => conversation.summary ?? []).join('\n\n'),
                actionPoints: [...new Set(selected.flatMap((conversation) => conversation.actionPoints ?? []))],
                processing: 'merging' as const,
              },
            ].sort((left, right) => left.startTime.localeCompare(right.startTime)),
          },
        }
      })
      globalThis.setTimeout(() => {
        replaceDay(dayId, (day) => {
          if (!day.memory) return day
          return {
            ...day,
            memory: {
              ...day.memory,
              conversations: day.memory.conversations.map((conversation) =>
                conversation.episodeId === episodeId
                  ? {
                      ...conversation,
                      title: 'Samengevoegd gesprek over productwerk',
                      description: 'De geselecteerde gesprekken zijn opnieuw als één geheel samengevat.',
                      processing: undefined,
                    }
                  : conversation
              ),
            },
          }
        })
      }, 1_200)
      return result
    },
    recoverAudio: async (dayId, momentIds) => {
      const day = days.find((candidate) => candidate.id === dayId)
      const requested = new Set(momentIds)
      const retained = new Set(day?.retainedAudioMomentIds ?? [])
      const moments = day?.moments.filter((moment) => requested.has(moment.id)) ?? []
      if (
        !day ||
        !requested.size ||
        moments.length !== requested.size ||
        moments.some(
          (moment) =>
            !retained.has(moment.id) ||
            moment.source === 'revinote' ||
            moment.status !== 'ready' ||
            !moment.transcript.trim()
        )
      ) {
        throw new Error('conversation-audio-unavailable')
      }
      const time = (timestamp: number) =>
        new Date(timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      return replaceDay(dayId, (candidate) => ({
        ...candidate,
        memory: {
          ...(candidate.memory ?? {
            summary: '',
            currentFocus: null,
            outcomes: [],
            decisions: [],
            openLoops: [],
            timeline: [],
            knowledgeSuggestions: [],
            refreshedAt: Date.now(),
            coveredThrough: day.startedAt,
          }),
          conversations: [
            ...(candidate.memory?.conversations ?? []),
            {
              episodeId: `browser-audio-${Date.now()}`,
              title: 'Gesprek uit audiofragmenten',
              description: moments.map((moment) => moment.transcript).join(' '),
              startTime: time(Math.min(...moments.map((moment) => moment.startedAt))),
              endTime: time(Math.max(...moments.map((moment) => moment.startedAt + moment.durationMs))),
            },
          ],
        },
      }))
    },
    recoverConversation: async (dayId, episodeIds) => {
      const requested = new Set(episodeIds)
      const day = days.find((candidate) => candidate.id === dayId)
      const blocks = day?.recoverableConversationBlocks?.filter((block) => requested.has(block.episodeId)) ?? []
      if (!day?.memory || blocks.length !== requested.size || blocks.length === 0) {
        throw new Error('conversation-recovery-unavailable')
      }
      const startedAt = Math.min(...blocks.map((block) => block.startedAt))
      const endedAt = Math.max(...blocks.map((block) => block.endedAt))
      const episodeId = blocks.length === 1 ? (blocks[0]?.episodeId as string) : `browser-recovered-${Date.now()}`
      const time = (timestamp: number) => {
        const date = new Date(timestamp)
        return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
      }
      const updated = replaceDay(dayId, (candidate) => ({
        ...candidate,
        conversationCandidates: candidate.conversationCandidates?.filter((item) => !requested.has(item.episodeId)),
        recoverableConversationBlocks: candidate.recoverableConversationBlocks?.filter(
          (item) => !requested.has(item.episodeId)
        ),
        memory: candidate.memory
          ? {
              ...candidate.memory,
              conversations: [
                ...candidate.memory.conversations,
                {
                  episodeId,
                  startTime: time(startedAt),
                  endTime: time(endedAt),
                  title: 'Gesprek',
                  description: '',
                  processing: 'processing' as const,
                  processingProvider: 'remember' as const,
                },
              ].sort((first, second) => first.startTime.localeCompare(second.startTime)),
            }
          : null,
      }))
      globalThis.setTimeout(() => {
        replaceDay(dayId, (candidate) => ({
          ...candidate,
          memory: candidate.memory
            ? {
                ...candidate.memory,
                conversations: candidate.memory.conversations.map((conversation) =>
                  conversation.episodeId === episodeId
                    ? {
                        ...conversation,
                        title: 'Hersteld gesprek',
                        description: 'Afspraken en vervolgwerk uit het herstelde gesprek.',
                        processing: undefined,
                        processingProvider: undefined,
                      }
                    : conversation
                ),
              }
            : null,
        }))
      }, 750)
      return updated
    },
    dismissConversationCandidate: async (dayId, episodeId) =>
      replaceDay(dayId, (day) => ({
        ...day,
        conversationCandidates: day.conversationCandidates?.filter((candidate) => candidate.episodeId !== episodeId),
      })),
    deleteDay: async (dayId) => {
      days = days.filter((day) => day.id !== dayId)
      emitDays()
      return days
    },
    getWikiOverview: async () => wikiOverview,
    createLocalWikiSpace: async (input) => {
      const id = crypto.randomUUID()
      wikiOverview = {
        ...wikiOverview,
        spaces: [
          ...wikiOverview.spaces,
          {
            id,
            name: input.name,
            description: input.description ?? '',
            icon: 'lock',
            color: 'slate',
            maintenanceMode: 'auto',
          },
        ],
      }
      wikiPages[id] = []
      return wikiOverview
    },
    removeLocalWikiSpace: async ({ spaceId }) => {
      if (spaceId === PERSONAL_WIKI_SPACE_ID) throw new Error('wiki-personal-space-required')
      requireWikiSpace(spaceId)
      wikiOverview = {
        ...wikiOverview,
        spaces: wikiOverview.spaces.filter((space) => space.id !== spaceId),
        suggestions: wikiOverview.suggestions.filter((suggestion) => suggestion.suggestedSpaceId !== spaceId),
        projectAssignments: wikiOverview.projectAssignments.filter((assignment) => assignment.spaceId !== spaceId),
      }
      delete wikiPages[spaceId]
      for (const [key, history] of wikiHistories) {
        if (history.spaceId === spaceId) wikiHistories.delete(key)
      }
      return wikiOverview
    },
    updateWikiSpace: async (input) => {
      requireWikiSpace(input.spaceId)
      wikiOverview = {
        ...wikiOverview,
        spaces: wikiOverview.spaces.map((space) => (space.id === input.spaceId ? { ...space, ...input } : space)),
      }
      return wikiOverview
    },
    reorderWikiSpaces: async (input) => {
      const spacesById = new Map(wikiOverview.spaces.map((space) => [space.id, space]))
      if (
        input.spaceIds.length !== wikiOverview.spaces.length ||
        new Set(input.spaceIds).size !== input.spaceIds.length ||
        input.spaceIds.some((spaceId) => !spacesById.has(spaceId))
      ) {
        throw new Error('invalid-wiki-space-order')
      }
      wikiOverview = {
        ...wikiOverview,
        spaces: input.spaceIds.flatMap((spaceId) => {
          const space = spacesById.get(spaceId)
          return space ? [space] : []
        }),
      }
      return wikiOverview
    },
    listWikiPages: async (spaceId) => {
      requireWikiSpace(spaceId)
      if (browserFixture.has('space-loading')) await delay(2000)
      requireWikiSpace(spaceId)
      if (browserFixture.has('space-error')) throw new Error('browser-space-error')
      return wikiPages[spaceId] ?? []
    },
    createWikiPage: async (input) => {
      requireWikiSpace(input.spaceId)
      if (browserFixture.has('space-create-error')) throw new Error('browser-space-create-error')
      const pages = wikiPages[input.spaceId] ?? []
      const slug = input.slug ?? uniqueSlug(pages, input.parentSlug ?? input.category, input.title)
      if (pages.some((page) => page.slug === slug)) return pages
      const updatedAt = Date.now()
      wikiPages = {
        ...wikiPages,
        [input.spaceId]: [
          ...pages,
          {
            slug,
            title: input.title,
            content: input.content ?? '',
            excerpt: '',
            updatedAt,
            sourceCount: 0,
            revision: `browser-revision-${updatedAt}`,
          },
        ],
      }
      return wikiPages[input.spaceId]
    },
    saveWikiPage: async (input) => {
      requireWikiSpace(input.spaceId)
      const previous = (wikiPages[input.spaceId] ?? []).find((page) => page.slug === input.slug)
      if (!previous) throw new Error('wiki-page-not-found')
      if (!input.expectedRevision) throw new Error('wiki-revision-required')
      if (previous.revision !== input.expectedRevision) throw new Error('wiki-page-conflict')
      const updatedAt = Date.now()
      wikiPages = {
        ...wikiPages,
        [input.spaceId]: (wikiPages[input.spaceId] ?? []).map((page) =>
          page.slug === input.slug
            ? {
                ...page,
                title: input.title,
                content: input.content,
                excerpt: input.content
                  .replace(/^#\s+.*$/m, '')
                  .trim()
                  .slice(0, 160),
                updatedAt,
                revision: `browser-revision-${updatedAt}`,
              }
            : page
        ),
      }
      const saved = (wikiPages[input.spaceId] ?? []).find((page) => page.slug === input.slug)
      if (previous && saved) {
        const history = ensureWikiHistory(input.spaceId, previous)
        const revisionId = saved.revision ?? `browser-revision-${saved.updatedAt}`
        wikiHistories.set(historyKey(input.spaceId, input.slug), {
          ...history,
          headRevisionId: revisionId,
          revisions: [
            {
              id: revisionId,
              parentRevisionId: history.headRevisionId,
              createdAt: saved.updatedAt,
              actor: 'user',
              operation: 'updated',
              sourceId: 'editor',
              summary: null,
              title: saved.title,
              content: saved.content,
              contentHash: revisionId,
            },
            ...history.revisions,
          ],
        })
      }
      return wikiPages[input.spaceId]
    },
    deleteWikiPage: async (input) => {
      requireWikiSpace(input.spaceId)
      const pages = wikiPages[input.spaceId] ?? []
      const page = pages.find((candidate) => candidate.slug === input.slug)
      if (!page) throw new Error('wiki-page-not-found')
      if (input.expectedRevision !== undefined && page.revision !== input.expectedRevision) {
        throw new Error('wiki-page-conflict')
      }
      if (input.onlyIfLeaf && pages.some((candidate) => candidate.slug.startsWith(`${input.slug}/`))) {
        throw new Error('wiki-page-has-children')
      }
      wikiPages = {
        ...wikiPages,
        [input.spaceId]: (wikiPages[input.spaceId] ?? []).filter(
          (page) => page.slug !== input.slug && !page.slug.startsWith(`${input.slug}/`)
        ),
      }
      return wikiPages[input.spaceId]
    },
    getWikiPageHistory: async (input) => {
      requireWikiSpace(input.spaceId)
      if (browserFixture.has('space-history-loading')) await new Promise((resolve) => setTimeout(resolve, 2000))
      if (browserFixture.has('space-history-error')) throw new Error('browser-history-unavailable')
      const page = (wikiPages[input.spaceId] ?? []).find((candidate) => candidate.slug === input.slug)
      if (!page) throw new Error('wiki-page-not-found')
      const history = ensureWikiHistory(input.spaceId, page)
      return browserFixture.has('space-history-empty') ? { ...history, headRevisionId: null, revisions: [] } : history
    },
    restoreWikiPageRevision: async (input) => {
      requireWikiSpace(input.spaceId)
      const page = (wikiPages[input.spaceId] ?? []).find((candidate) => candidate.slug === input.slug)
      if (!page) throw new Error('wiki-page-not-found')
      const history = ensureWikiHistory(input.spaceId, page)
      const revision = history.revisions.find((candidate) => candidate.id === input.revisionId)
      if (!revision) throw new Error('wiki-page-revision-not-found')
      if (!input.expectedRevision) throw new Error('wiki-revision-required')
      if (page.revision !== input.expectedRevision) throw new Error('wiki-page-conflict')
      const restoredAt = Date.now()
      const restoredRevisionId = `browser-restore-${restoredAt}`
      wikiPages = {
        ...wikiPages,
        [input.spaceId]: (wikiPages[input.spaceId] ?? []).map((candidate) =>
          candidate.slug === input.slug
            ? {
                ...candidate,
                title: revision.title,
                content: revision.content,
                excerpt: revision.content.slice(0, 160),
                updatedAt: restoredAt,
                revision: restoredRevisionId,
              }
            : candidate
        ),
      }
      wikiHistories.set(historyKey(input.spaceId, input.slug), {
        ...history,
        headRevisionId: restoredRevisionId,
        revisions: [
          {
            ...revision,
            id: restoredRevisionId,
            parentRevisionId: history.headRevisionId,
            createdAt: restoredAt,
            actor: 'user',
            operation: 'restored',
            sourceId: `restore://${revision.id}`,
            contentHash: restoredRevisionId,
          },
          ...history.revisions,
        ],
      })
      return wikiPages[input.spaceId] ?? []
    },
    undoWikiLearning: async (input) => {
      requireWikiSpace(input.spaceId)
      const page = (wikiPages[input.spaceId] ?? []).find((candidate) => candidate.slug === input.slug)
      if (!page) throw new Error('wiki-page-not-found')
      const history = ensureWikiHistory(input.spaceId, page)
      const learned = history.revisions.find((revision) => revision.id === input.revisionId)
      if (page.revision !== input.expectedRevision || history.headRevisionId !== input.revisionId)
        throw new Error('wiki-page-conflict')
      if (learned?.actor !== 'remember' || !learned.evidence?.length) throw new Error('wiki-learning-revision-required')
      const parent = history.revisions.find((revision) => revision.id === learned.parentRevisionId)
      if (!parent) {
        if ((wikiPages[input.spaceId] ?? []).some((candidate) => candidate.slug.startsWith(`${page.slug}/`)))
          throw new Error('wiki-learning-has-child-pages')
        wikiPages[input.spaceId] = (wikiPages[input.spaceId] ?? []).filter((candidate) => candidate.slug !== page.slug)
        return wikiPages[input.spaceId] ?? []
      }
      const restoredAt = Date.now()
      const revisionId = `browser-undo-${restoredAt}`
      wikiPages[input.spaceId] = (wikiPages[input.spaceId] ?? []).map((candidate) =>
        candidate.slug === page.slug
          ? {
              ...candidate,
              title: parent.title,
              content: parent.content,
              excerpt: parent.content.slice(0, 160),
              updatedAt: restoredAt,
              revision: revisionId,
            }
          : candidate
      )
      wikiHistories.set(historyKey(input.spaceId, input.slug), {
        ...history,
        headRevisionId: revisionId,
        revisions: [
          {
            ...parent,
            id: revisionId,
            parentRevisionId: learned.id,
            createdAt: restoredAt,
            actor: 'user',
            operation: 'restored',
            sourceId: `undo://${learned.id}`,
            contentHash: revisionId,
          },
          ...history.revisions,
        ],
      })
      return wikiPages[input.spaceId] ?? []
    },
    moveWikiProject: async (input) => {
      requireWikiSpace(input.sourceSpaceId)
      requireWikiSpace(input.destinationSpaceId)
      if (input.sourceSpaceId === input.destinationSpaceId) throw new Error('invalid-wiki-project-move')
      const destination = wikiOverview.spaces.find((space) => space.id === input.destinationSpaceId)
      if (!destination) throw new Error('wiki-space-not-found')
      const projectPages = (wikiPages[input.sourceSpaceId] ?? []).filter(
        (page) => page.slug === input.projectSlug || page.slug.startsWith(`${input.projectSlug}/`)
      )
      if (!projectPages.some((page) => page.slug === input.projectSlug)) throw new Error('wiki-project-not-found')
      const destinationPages = wikiPages[input.destinationSpaceId] ?? []
      if (browserWikiProjectMoveConflicts(input.projectSlug, projectPages, destinationPages, true)) {
        throw new Error('wiki-project-move-conflict')
      }
      const projectSlugs = new Set(projectPages.map((page) => page.slug))
      wikiPages = {
        ...wikiPages,
        [input.destinationSpaceId]: [
          ...destinationPages.filter((page) => !projectSlugs.has(page.slug)),
          ...projectPages,
        ],
        [input.sourceSpaceId]: (wikiPages[input.sourceSpaceId] ?? []).filter((page) => !projectSlugs.has(page.slug)),
      }
      const remainingAssignments = wikiOverview.projectAssignments.filter(
        (share) => share.projectSlug !== input.projectSlug
      )
      wikiOverview = {
        ...wikiOverview,
        projectAssignments:
          input.destinationSpaceId === PERSONAL_WIKI_SPACE_ID
            ? remainingAssignments
            : [
                ...remainingAssignments,
                {
                  projectSlug: input.projectSlug,
                  spaceId: input.destinationSpaceId,
                  createdAt: Date.now(),
                },
              ],
      }
      return wikiOverview
    },
    applyKnowledgeSuggestion: async (input) => {
      const proposal = wikiOverview.suggestions.find((suggestion) => suggestion.id === input.suggestionId)
      if (proposal?.status !== 'pending') throw new Error('knowledge-suggestion-not-found')
      const spaceId = input.destinationSpaceId ?? proposal.suggestedSpaceId
      requireWikiSpace(spaceId)
      const previous = (wikiPages[spaceId] ?? []).find((page) => page.slug === proposal.slug)
      if ((previous?.revision ?? null) !== proposal.baseRevision) throw new Error('knowledge-suggestion-stale')
      const updatedAt = Date.now()
      const revisionId = `browser-proposal-${updatedAt}`
      const saved: WikiPage & { revision: string } = {
        slug: proposal.slug,
        title: proposal.title,
        content: proposal.content,
        excerpt: proposal.content.slice(0, 160),
        updatedAt,
        sourceCount: proposal.evidence?.length ?? 0,
        revision: revisionId,
      }
      const history = previous ? ensureWikiHistory(spaceId, previous) : null
      wikiPages[spaceId] = [...(wikiPages[spaceId] ?? []).filter((page) => page.slug !== proposal.slug), saved]
      wikiHistories.set(historyKey(spaceId, proposal.slug), {
        pageId: history?.pageId ?? `browser-page-${spaceId}-${proposal.slug}`,
        spaceId,
        slug: proposal.slug,
        headRevisionId: revisionId,
        revisions: [
          {
            id: revisionId,
            parentRevisionId: history?.headRevisionId ?? null,
            createdAt: updatedAt,
            actor: 'remember',
            operation: previous ? 'updated' : 'created',
            sourceId: proposal.sourceId,
            summary: proposal.summary,
            evidence: proposal.evidence,
            title: proposal.title,
            content: proposal.content,
            contentHash: revisionId,
          },
          ...(history?.revisions ?? []),
        ],
      })
      wikiOverview = {
        ...wikiOverview,
        suggestions: wikiOverview.suggestions.map((suggestion) =>
          suggestion.id === input.suggestionId
            ? {
                ...suggestion,
                status: 'applied',
                destinationSpaceId: input.destinationSpaceId ?? suggestion.suggestedSpaceId,
                appliedAt: Date.now(),
              }
            : suggestion
        ),
      }
      emitMemoryChanged()
      return wikiOverview
    },
    dismissKnowledgeSuggestion: async (input) => {
      wikiOverview = {
        ...wikiOverview,
        suggestions: wikiOverview.suggestions.map((suggestion) =>
          suggestion.id === input.suggestionId ? { ...suggestion, status: 'dismissed' } : suggestion
        ),
      }
      emitMemoryChanged()
      return wikiOverview
    },
    getCliSetupStatus: async () => ({
      installed: true,
      upToDate: true,
      commandInstalled: true,
      codexSkillInstalled: true,
      claudeSkillInstalled: true,
      commandPath: '/usr/local/bin/remember',
      pathAvailable: true,
      error: null,
    }),
    installCliAccess: async () => ({
      installed: true,
      upToDate: true,
      commandInstalled: true,
      codexSkillInstalled: true,
      claudeSkillInstalled: true,
      commandPath: '/usr/local/bin/remember',
      pathAvailable: true,
      error: null,
    }),
    getClaudeMcpSetupStatus: async () => ({
      connected: claudeMcpConnected,
      conflict: false,
      commandPath: '/usr/local/bin/remember',
      error: null,
    }),
    installClaudeMcp: async () => {
      claudeMcpConnected = true
      return {
        connected: true,
        conflict: false,
        commandPath: '/usr/local/bin/remember',
        error: null,
      }
    },
    getAgentUsage: async () => ({
      firstRecordedAt: startOfDay(-3),
      providers: [
        {
          provider: 'codex',
          today: { inputTokens: 84320, outputTokens: 6280, cachedInputTokens: 61100 },
          week: { inputTokens: 382500, outputTokens: 24900, cachedInputTokens: 276000 },
        },
        {
          provider: 'claude',
          today: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
          week: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
        },
      ],
    }),
    getAgentAccountUsage: async (provider) => ({
      provider,
      checkedAt: Date.now(),
      windows:
        provider === 'codex'
          ? [
              { remainingPercent: 95, durationMinutes: 300, resetsAt: Date.now() + 2 * 60 * 60_000 },
              { remainingPercent: 82, durationMinutes: 10080, resetsAt: Date.now() + 4 * 24 * 60 * 60_000 },
            ]
          : [],
    }),
    listAgentTrace: async () => [],
    getAppIcons: async () => ({}),
    listInstalledApps: async () => [
      { name: 'Visual Studio Code', bundleId: 'com.microsoft.VSCode' },
      { name: 'Google Chrome', bundleId: 'com.google.Chrome' },
      { name: 'Slack', bundleId: 'com.tinyspeck.slackmacgap' },
      { name: 'Codex', bundleId: 'com.openai.codex' },
    ],
    getUpdateState: async () => update,
    onUpdateState: (listener) => subscribe(updateListeners, listener),
    checkForUpdate: async () => {
      update = { ...update, status: 'up-to-date', revision: update.revision + 1 }
      emitUpdate()
      return update
    },
    downloadUpdate: async () => update,
    restartToUpdate: resolved,
  }
  return bridge
}

export function createOnboardingPreviewBridge(baseBridge: RememberBridge): RememberBridge {
  const storageKey = 'remember:onboarding-preview:v1'
  let state: CaptureState | null = null
  let settings: LocalSettings | null = null
  const stateListeners = new Set<Listener<CaptureState>>()
  const settingsListeners = new Set<Listener<LocalSettings>>()
  const persist = () => window.sessionStorage.setItem(storageKey, JSON.stringify({ state, settings }))

  const initialize = async () => {
    if (state && settings) return
    const saved = window.sessionStorage.getItem(storageKey)
    if (saved) {
      try {
        const preview = JSON.parse(saved)
        if (preview.state && preview.settings) {
          state = { ...preview.state, modelDownloadProgress: null, modelPreparationPhase: null }
          settings = preview.settings
          return
        }
      } catch {
        window.sessionStorage.removeItem(storageKey)
      }
    }
    const [baseState, baseSettings] = await Promise.all([baseBridge.getState(), baseBridge.getSettings()])
    state = {
      ...baseState,
      status: 'idle',
      error: null,
      modelDownloaded: false,
      modelDownloadProgress: null,
      modelPreparationPhase: null,
      microphonePermission: 'not-determined',
      microphoneName: null,
      microphoneLastChunkAt: null,
      systemAudioPermission: 'not-determined',
      systemAudioCheckStatus: 'unchecked',
      systemAudioCheckError: null,
      accessibilityPermission: 'denied',
      restartRequired: false,
      permissionsResolved: true,
      agent: { ...readyAgent },
    }
    settings = {
      ...baseSettings,
      audioCaptureEnabled: false,
      privacyOnboardingCompleted: false,
      audioCaptureOnboardingCompleted: false,
      dayAnalysisProvider: null,
      dayAnalysisOnboardingCompleted: false,
      cloudAnalysisConsent: false,
      cloudConsentNoticeSeen: false,
      contextImportOnboardingCompleted: false,
      contextImportCompletedAt: null,
      appCaptureMode: 'exclude',
      websiteCaptureMode: 'exclude',
      excludedAppBundleIds: [],
      excludedWebsites: [],
      includedAppBundleIds: [],
      includedWebsites: [],
      excludePasswordManagers: true,
      excludePrivateBrowsing: true,
    }
  }

  const getState = async () => {
    await initialize()
    return state as CaptureState
  }
  const getSettings = async () => {
    await initialize()
    return settings as LocalSettings
  }
  const emitPreviewState = () => {
    if (!state) return
    persist()
    for (const listener of stateListeners) listener(state)
  }

  const overrides: Partial<RememberBridge> = {
    getState,
    getSettings,
    onSettingsChanged: (listener) => {
      settingsListeners.add(listener)
      return () => settingsListeners.delete(listener)
    },
    onState: (listener) => {
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    },
    requestAccessibilityPermission: async () => {
      state = { ...(await getState()), accessibilityPermission: 'granted' }
      emitPreviewState()
      return state
    },
    showAccessibilityPermissionGuide: resolved,
    requestMicrophonePermission: async () => {
      state = {
        ...(await getState()),
        microphonePermission: 'granted',
        restartRequired: true,
      }
      emitPreviewState()
      return state
    },
    restartApp: async () => {
      state = { ...(await getState()), restartRequired: false }
      emitPreviewState()
    },
    verifySystemAudio: async () => {
      state = { ...(await getState()), systemAudioCheckStatus: 'checking' }
      emitPreviewState()
      await delay(450)
      state = {
        ...(await getState()),
        systemAudioPermission: 'granted',
        systemAudioCheckStatus: 'ready',
      }
      emitPreviewState()
      return state
    },
    prepareModel: async () => {
      state = {
        ...(await getState()),
        modelDownloadProgress: 0.28,
        modelPreparationPhase: 'downloading',
      }
      emitPreviewState()
      await delay(550)
      state = {
        ...(await getState()),
        modelDownloaded: true,
        modelDownloadProgress: null,
        modelPreparationPhase: null,
      }
      emitPreviewState()
      return state
    },
    updateSettings: async (patch) => {
      settings = { ...(await getSettings()), ...patch }
      for (const listener of settingsListeners) listener(settings)
      persist()
      if (hasCompletedOnboarding(settings) && settings.contextImportOnboardingCompleted) {
        window.setTimeout(() => window.location.replace('/'), 150)
      }
      return settings
    },
    getCodexModels: async () => FALLBACK_CODEX_MODELS,
    checkAgent: async (provider) => ({
      ...(await getState()).agent,
      provider: provider ?? (await getSettings()).defaultAgentProvider,
    }),
    openAgentLogin: async () => {
      state = { ...(await getState()), agent: { ...readyAgent } }
      emitPreviewState()
    },
    getContextImportPreview: async () => ({
      providers:
        new URLSearchParams(window.location.search).get('onboarding-scenario') === 'empty-context'
          ? []
          : [
              {
                provider: 'codex',
                available: true,
                projectCount: 4,
                sessionCount: 28,
                memoryCount: 12,
                latestAt: Date.now() - 60 * 60_000,
              },
            ],
    }),
    importAgentContext: async () => {
      await delay(650)
      if (new URLSearchParams(window.location.search).get('onboarding-scenario') === 'import-error') {
        throw new Error('preview-context-import-failed')
      }
      return { providers: ['codex'], sourceCount: 28, createdPages: ['projects/remember'], updatedPages: [] }
    },
  }

  return { ...baseBridge, ...overrides } as RememberBridge
}
