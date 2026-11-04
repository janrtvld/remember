import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  type AgentProvider,
  type CaptureFilterMode,
  type CapturePauseSource,
  CLAUDE_ANALYSIS_EFFORTS,
  CLAUDE_ANALYSIS_MODELS,
  type CodexModel,
  compatibleCodexEffort,
  DEFAULT_CAPTURE_SCHEDULE,
  DEFAULT_DICTATION_PREFERENCES,
  DEFAULT_FREQUENT_DAY_REFRESH_INTERVAL_MINUTES,
  type InterfaceLanguage,
  type InterfaceTheme,
  isCodexEffort,
  isCodexModelId,
  type LocalSettings,
  normalizeAgentComputer,
  normalizeCaptureSchedule,
  normalizeDictationPreferences,
  normalizeFrequentDayRefreshIntervalMinutes,
} from '@remember/shared'
import { readCachedCodexModels } from './codexModelCatalog'

const SETTINGS_SCHEMA_VERSION = 1
const SETTINGS_FILE = 'settings.json'
const SETTINGS_BACKUP_FILE = 'settings.last-known-good.json'

export const DEFAULT_SETTINGS: LocalSettings = {
  dictation: DEFAULT_DICTATION_PREFERENCES,
  interfaceLanguage: 'system',
  interfaceTheme: 'system',
  offlineMode: false,
  automaticUpdates: true,
  defaultAgentProvider: 'codex',
  agentComputer: { kind: 'local' },
  dayAnalysisProvider: null,
  dayAnalysisOnboardingCompleted: false,
  privacyOnboardingCompleted: false,
  cloudAnalysisConsent: false,
  cloudConsentNoticeSeen: false,
  contextImportOnboardingCompleted: false,
  contextImportCompletedAt: null,
  agentLearningEnabled: false,
  agentLearningEnabledAt: null,
  agentContextBindings: [],
  codexAnalysisModel: 'gpt-5.6-terra',
  codexAnalysisEffort: 'medium',
  claudeAnalysisModel: 'sonnet',
  claudeAnalysisEffort: 'medium',
  launchAtLogin: true,
  edgeWidgetEnabled: true,
  edgeWidgetHiddenUntil: null,
  edgeWidgetEdge: 'right',
  audioCaptureEnabled: false,
  audioCaptureOnboardingCompleted: false,
  automaticRevinoteProcessing: false,
  liveTaskUpdates: false,
  frequentDayRefresh: true,
  frequentDayRefreshIntervalMinutes: DEFAULT_FREQUENT_DAY_REFRESH_INTERVAL_MINUTES,
  capturePaused: false,
  capturePausedUntil: null,
  capturePauseSources: ['audio', 'capture'],
  captureSchedule: DEFAULT_CAPTURE_SCHEDULE,
  excludePasswordManagers: true,
  excludePrivateBrowsing: true,
  appCaptureMode: 'exclude',
  excludedAppBundleIds: [],
  includedAppBundleIds: [],
  websiteCaptureMode: 'exclude',
  excludedWebsites: [],
  includedWebsites: [],
}

export type SettingsHealth = {
  status: 'healthy' | 'missing' | 'recovery-required'
  reason: 'none' | 'unreadable' | 'invalid' | 'unsupported-version' | 'missing-current'
  lastKnownGoodAvailable: boolean
  lastKnownGoodAt: number | null
}

type SettingsSnapshot = {
  settings: LocalSettings
  health: SettingsHealth
}

type StoredSettings = Omit<Partial<LocalSettings>, 'dayAnalysisProvider'> & {
  dayAnalysisProvider?: AgentProvider | 'local' | null
  airgapMode?: boolean
  settingsSchemaVersion?: number
  settingsGeneration?: number
  agent?: AgentProvider
  agentOnboardingCompleted?: boolean
  analysisConsent?: boolean
}

type ValidSettingsDocument = {
  settings: LocalSettings
  generation: number
}

type InvalidSettingsDocument = {
  error: SettingsHealth['reason']
}

const AGENT_PROVIDERS = ['codex', 'claude'] as const satisfies readonly AgentProvider[]
const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof LocalSettings)[]
const DEFAULTED_CURRENT_SETTINGS_KEYS = new Set<keyof LocalSettings>([
  'dictation',
  'edgeWidgetEnabled',
  'edgeWidgetHiddenUntil',
  'edgeWidgetEdge',
  'privacyOnboardingCompleted',
  'offlineMode',
  'automaticRevinoteProcessing',
  'agentLearningEnabled',
  'agentLearningEnabledAt',
  'agentContextBindings',
  'liveTaskUpdates',
  'agentComputer',
])
const LEGACY_REQUIRED_POLICY_KEYS = [
  'automaticUpdates',
  'dayAnalysisProvider',
  'dayAnalysisOnboardingCompleted',
  'launchAtLogin',
  'audioCaptureEnabled',
  'audioCaptureOnboardingCompleted',
  'frequentDayRefresh',
  'capturePaused',
  'capturePauseSources',
  'excludePasswordManagers',
  'excludePrivateBrowsing',
  'appCaptureMode',
  'excludedAppBundleIds',
  'includedAppBundleIds',
  'websiteCaptureMode',
  'excludedWebsites',
  'includedWebsites',
] as const satisfies readonly (keyof LocalSettings)[]

function interfaceLanguage(value: unknown, fallback: InterfaceLanguage): InterfaceLanguage {
  return value === 'system' || value === 'en' || value === 'nl' ? value : fallback
}

function interfaceTheme(value: unknown, fallback: InterfaceTheme): InterfaceTheme {
  return value === 'system' || value === 'light' || value === 'dark' ? value : fallback
}

function captureFilterMode(value: unknown, fallback: CaptureFilterMode): CaptureFilterMode {
  return value === 'include' || value === 'exclude' ? value : fallback
}

function capturePauseSources(value: unknown, fallback: CapturePauseSource[]): CapturePauseSource[] {
  if (!Array.isArray(value)) return fallback
  const sources = value.flatMap((source): CapturePauseSource[] => {
    if (source === 'audio' || source === 'capture') return [source]
    if (source === 'microphone') return ['audio']
    if (source === 'activity') return ['capture']
    return []
  })
  return Array.from(new Set(sources))
}

function choice<const Options extends readonly string[]>(value: unknown, options: Options, fallback: Options[number]) {
  return typeof value === 'string' && options.includes(value) ? (value as Options[number]) : fallback
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) return []
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ).slice(0, 200)
}

function normalizeStoredSettings(parsed: StoredSettings): LocalSettings {
  const codexAnalysisModel = isCodexModelId(parsed.codexAnalysisModel)
    ? parsed.codexAnalysisModel
    : DEFAULT_SETTINGS.codexAnalysisModel
  const codexAnalysisEffort = isCodexEffort(parsed.codexAnalysisEffort)
    ? parsed.codexAnalysisEffort
    : DEFAULT_SETTINGS.codexAnalysisEffort
  const defaultAgentProvider = choice(
    parsed.defaultAgentProvider ?? parsed.agent,
    AGENT_PROVIDERS,
    DEFAULT_SETTINGS.defaultAgentProvider
  )
  const migratedOnboardingCompleted = parsed.agentOnboardingCompleted === true
  return {
    dictation: normalizeDictationPreferences(parsed.dictation),
    interfaceLanguage: interfaceLanguage(parsed.interfaceLanguage, DEFAULT_SETTINGS.interfaceLanguage),
    interfaceTheme: interfaceTheme(parsed.interfaceTheme, DEFAULT_SETTINGS.interfaceTheme),
    offlineMode: parsed.offlineMode === true || parsed.airgapMode === true,
    automaticUpdates: parsed.automaticUpdates !== false,
    defaultAgentProvider,
    agentComputer: normalizeAgentComputer(parsed.agentComputer),
    dayAnalysisProvider:
      parsed.dayAnalysisProvider === 'local'
        ? null
        : parsed.dayAnalysisProvider != null || parsed.agent != null
          ? choice(parsed.dayAnalysisProvider ?? parsed.agent, AGENT_PROVIDERS, 'codex')
          : null,
    dayAnalysisOnboardingCompleted:
      parsed.dayAnalysisOnboardingCompleted === true ||
      (parsed.dayAnalysisOnboardingCompleted === undefined && migratedOnboardingCompleted),
    privacyOnboardingCompleted:
      parsed.privacyOnboardingCompleted === undefined
        ? parsed.audioCaptureOnboardingCompleted !== false &&
          (parsed.dayAnalysisOnboardingCompleted === true || migratedOnboardingCompleted) &&
          parsed.contextImportOnboardingCompleted === true
        : parsed.privacyOnboardingCompleted === true,
    cloudAnalysisConsent: parsed.cloudAnalysisConsent ?? parsed.analysisConsent === true,
    cloudConsentNoticeSeen: parsed.cloudConsentNoticeSeen === true,
    contextImportOnboardingCompleted: parsed.contextImportOnboardingCompleted === true,
    agentLearningEnabled: parsed.agentLearningEnabled === true,
    agentLearningEnabledAt:
      typeof parsed.agentLearningEnabledAt === 'number' && Number.isFinite(parsed.agentLearningEnabledAt)
        ? parsed.agentLearningEnabledAt
        : null,
    agentContextBindings: Array.isArray(parsed.agentContextBindings)
      ? parsed.agentContextBindings.filter(
          (binding) =>
            binding &&
            typeof binding.directory === 'string' &&
            binding.directory.startsWith('/') &&
            typeof binding.spaceId === 'string' &&
            binding.spaceId.length > 0 &&
            typeof binding.projectSlug === 'string' &&
            /^projects\/[^/]+$/.test(binding.projectSlug)
        )
      : [],
    contextImportCompletedAt:
      typeof parsed.contextImportCompletedAt === 'number' && Number.isFinite(parsed.contextImportCompletedAt)
        ? parsed.contextImportCompletedAt
        : null,
    codexAnalysisModel,
    codexAnalysisEffort,
    claudeAnalysisModel: choice(
      parsed.claudeAnalysisModel,
      CLAUDE_ANALYSIS_MODELS,
      DEFAULT_SETTINGS.claudeAnalysisModel
    ),
    claudeAnalysisEffort: choice(
      parsed.claudeAnalysisEffort,
      CLAUDE_ANALYSIS_EFFORTS,
      DEFAULT_SETTINGS.claudeAnalysisEffort
    ),
    launchAtLogin: parsed.launchAtLogin !== false,
    edgeWidgetEnabled: parsed.edgeWidgetEnabled !== false,
    edgeWidgetHiddenUntil:
      typeof parsed.edgeWidgetHiddenUntil === 'number' && Number.isFinite(parsed.edgeWidgetHiddenUntil)
        ? parsed.edgeWidgetHiddenUntil
        : null,
    edgeWidgetEdge: choice(
      parsed.edgeWidgetEdge,
      ['left', 'right', 'bottom'] as const,
      DEFAULT_SETTINGS.edgeWidgetEdge
    ),
    audioCaptureEnabled: parsed.audioCaptureEnabled === true,
    audioCaptureOnboardingCompleted: parsed.audioCaptureOnboardingCompleted !== false,
    automaticRevinoteProcessing: parsed.automaticRevinoteProcessing === true,
    liveTaskUpdates: parsed.liveTaskUpdates === true,
    frequentDayRefresh: parsed.frequentDayRefresh !== false,
    frequentDayRefreshIntervalMinutes: normalizeFrequentDayRefreshIntervalMinutes(
      parsed.frequentDayRefreshIntervalMinutes
    ),
    capturePaused: parsed.capturePaused === true,
    capturePausedUntil:
      typeof parsed.capturePausedUntil === 'number' && Number.isFinite(parsed.capturePausedUntil)
        ? parsed.capturePausedUntil
        : null,
    capturePauseSources: capturePauseSources(parsed.capturePauseSources, DEFAULT_SETTINGS.capturePauseSources),
    captureSchedule: normalizeCaptureSchedule(parsed.captureSchedule),
    excludePasswordManagers: parsed.excludePasswordManagers !== false,
    excludePrivateBrowsing: parsed.excludePrivateBrowsing !== false,
    appCaptureMode: captureFilterMode(parsed.appCaptureMode, DEFAULT_SETTINGS.appCaptureMode),
    excludedAppBundleIds: stringList(parsed.excludedAppBundleIds),
    includedAppBundleIds: stringList(parsed.includedAppBundleIds),
    websiteCaptureMode: captureFilterMode(parsed.websiteCaptureMode, DEFAULT_SETTINGS.websiteCaptureMode),
    excludedWebsites: stringList(parsed.excludedWebsites),
    includedWebsites: stringList(parsed.includedWebsites),
  }
}

function normalizeSettingsPatch(
  current: LocalSettings,
  patch: Partial<LocalSettings>,
  contextImportCompletedAt: number,
  models: CodexModel[]
): LocalSettings {
  const codexAnalysisModel =
    isCodexModelId(patch.codexAnalysisModel) && models.some((model) => model.model === patch.codexAnalysisModel)
      ? patch.codexAnalysisModel
      : current.codexAnalysisModel
  const codexAnalysisEffort = isCodexEffort(patch.codexAnalysisEffort)
    ? patch.codexAnalysisEffort
    : current.codexAnalysisEffort
  const contextImportOnboardingCompleted =
    patch.contextImportOnboardingCompleted ?? current.contextImportOnboardingCompleted

  return {
    dictation: normalizeDictationPreferences({ ...current.dictation, ...patch.dictation }),
    interfaceLanguage: interfaceLanguage(patch.interfaceLanguage, current.interfaceLanguage),
    interfaceTheme: interfaceTheme(patch.interfaceTheme, current.interfaceTheme),
    offlineMode: patch.offlineMode ?? current.offlineMode,
    automaticUpdates: patch.automaticUpdates ?? current.automaticUpdates,
    defaultAgentProvider: choice(patch.defaultAgentProvider, AGENT_PROVIDERS, current.defaultAgentProvider),
    agentComputer:
      patch.agentComputer === undefined ? current.agentComputer : normalizeAgentComputer(patch.agentComputer),
    dayAnalysisProvider:
      patch.dayAnalysisProvider === null
        ? null
        : choice(patch.dayAnalysisProvider, AGENT_PROVIDERS, current.dayAnalysisProvider ?? 'codex'),
    dayAnalysisOnboardingCompleted: patch.dayAnalysisOnboardingCompleted ?? current.dayAnalysisOnboardingCompleted,
    privacyOnboardingCompleted: patch.privacyOnboardingCompleted ?? current.privacyOnboardingCompleted,
    cloudAnalysisConsent: patch.cloudAnalysisConsent ?? current.cloudAnalysisConsent,
    cloudConsentNoticeSeen: patch.cloudConsentNoticeSeen ?? current.cloudConsentNoticeSeen,
    contextImportOnboardingCompleted,
    agentLearningEnabled: patch.agentLearningEnabled ?? current.agentLearningEnabled,
    agentLearningEnabledAt:
      patch.agentLearningEnabled === true && !current.agentLearningEnabled
        ? contextImportCompletedAt
        : current.agentLearningEnabledAt,
    agentContextBindings:
      patch.agentContextBindings === undefined
        ? current.agentContextBindings
        : normalizeStoredSettings({ ...current, agentContextBindings: patch.agentContextBindings })
            .agentContextBindings,
    contextImportCompletedAt:
      patch.contextImportCompletedAt === null
        ? null
        : typeof patch.contextImportCompletedAt === 'number' && Number.isFinite(patch.contextImportCompletedAt)
          ? patch.contextImportCompletedAt
          : !current.contextImportOnboardingCompleted && contextImportOnboardingCompleted
            ? contextImportCompletedAt
            : current.contextImportCompletedAt,
    codexAnalysisModel,
    codexAnalysisEffort: compatibleCodexEffort(
      models.find((model) => model.model === codexAnalysisModel),
      codexAnalysisEffort
    ),
    claudeAnalysisModel: choice(patch.claudeAnalysisModel, CLAUDE_ANALYSIS_MODELS, current.claudeAnalysisModel),
    claudeAnalysisEffort: choice(patch.claudeAnalysisEffort, CLAUDE_ANALYSIS_EFFORTS, current.claudeAnalysisEffort),
    launchAtLogin: patch.launchAtLogin ?? current.launchAtLogin,
    edgeWidgetEnabled: patch.edgeWidgetEnabled ?? current.edgeWidgetEnabled,
    edgeWidgetHiddenUntil:
      patch.edgeWidgetHiddenUntil === null ||
      (typeof patch.edgeWidgetHiddenUntil === 'number' && Number.isFinite(patch.edgeWidgetHiddenUntil))
        ? patch.edgeWidgetHiddenUntil
        : current.edgeWidgetHiddenUntil,
    edgeWidgetEdge: choice(patch.edgeWidgetEdge, ['left', 'right', 'bottom'] as const, current.edgeWidgetEdge),
    audioCaptureEnabled: patch.audioCaptureEnabled ?? current.audioCaptureEnabled,
    audioCaptureOnboardingCompleted: patch.audioCaptureOnboardingCompleted ?? current.audioCaptureOnboardingCompleted,
    automaticRevinoteProcessing: patch.automaticRevinoteProcessing ?? current.automaticRevinoteProcessing,
    liveTaskUpdates: typeof patch.liveTaskUpdates === 'boolean' ? patch.liveTaskUpdates : current.liveTaskUpdates,
    frequentDayRefresh: patch.frequentDayRefresh ?? current.frequentDayRefresh,
    frequentDayRefreshIntervalMinutes: normalizeFrequentDayRefreshIntervalMinutes(
      patch.frequentDayRefreshIntervalMinutes,
      current.frequentDayRefreshIntervalMinutes
    ),
    capturePaused: patch.capturePaused ?? current.capturePaused,
    capturePausedUntil:
      patch.capturePausedUntil === null ||
      (typeof patch.capturePausedUntil === 'number' && Number.isFinite(patch.capturePausedUntil))
        ? patch.capturePausedUntil
        : current.capturePausedUntil,
    capturePauseSources:
      patch.capturePauseSources === undefined
        ? current.capturePauseSources
        : capturePauseSources(patch.capturePauseSources, current.capturePauseSources),
    captureSchedule:
      patch.captureSchedule === undefined ? current.captureSchedule : normalizeCaptureSchedule(patch.captureSchedule),
    excludePasswordManagers:
      typeof patch.excludePasswordManagers === 'boolean'
        ? patch.excludePasswordManagers
        : current.excludePasswordManagers,
    excludePrivateBrowsing:
      typeof patch.excludePrivateBrowsing === 'boolean' ? patch.excludePrivateBrowsing : current.excludePrivateBrowsing,
    appCaptureMode: captureFilterMode(patch.appCaptureMode, current.appCaptureMode),
    excludedAppBundleIds:
      patch.excludedAppBundleIds === undefined ? current.excludedAppBundleIds : stringList(patch.excludedAppBundleIds),
    includedAppBundleIds:
      patch.includedAppBundleIds === undefined ? current.includedAppBundleIds : stringList(patch.includedAppBundleIds),
    websiteCaptureMode: captureFilterMode(patch.websiteCaptureMode, current.websiteCaptureMode),
    excludedWebsites:
      patch.excludedWebsites === undefined ? current.excludedWebsites : stringList(patch.excludedWebsites),
    includedWebsites:
      patch.includedWebsites === undefined ? current.includedWebsites : stringList(patch.includedWebsites),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseSettingsDocument(path: string): ValidSettingsDocument | InvalidSettingsDocument {
  let parsed: StoredSettings
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!isRecord(raw)) return { error: 'invalid' }
    parsed = raw as StoredSettings
  } catch {
    return { error: 'unreadable' }
  }

  if (parsed.settingsSchemaVersion !== undefined && parsed.settingsSchemaVersion !== SETTINGS_SCHEMA_VERSION) {
    return { error: 'unsupported-version' }
  }
  if (Object.hasOwn(parsed, 'airgapMode') && typeof parsed.airgapMode !== 'boolean') return { error: 'invalid' }
  if (
    Object.hasOwn(parsed, 'offlineMode') &&
    Object.hasOwn(parsed, 'airgapMode') &&
    parsed.offlineMode !== parsed.airgapMode
  ) {
    return { error: 'invalid' }
  }

  let normalized: LocalSettings
  try {
    normalized = normalizeStoredSettings(parsed)
  } catch {
    return { error: 'invalid' }
  }
  const isCurrent = parsed.settingsSchemaVersion === SETTINGS_SCHEMA_VERSION
  if (isCurrent) {
    if (!Number.isSafeInteger(parsed.settingsGeneration) || (parsed.settingsGeneration ?? 0) < 1) {
      return { error: 'invalid' }
    }
    if (!SETTINGS_KEYS.every((key) => Object.hasOwn(parsed, key) || DEFAULTED_CURRENT_SETTINGS_KEYS.has(key))) {
      return { error: 'invalid' }
    }
    if (!Object.hasOwn(parsed, 'offlineMode') && !Object.hasOwn(parsed, 'airgapMode')) return { error: 'invalid' }
    if (
      !SETTINGS_KEYS.every(
        (key) =>
          !Object.hasOwn(parsed, key) ||
          (key === 'dayAnalysisProvider' && parsed.dayAnalysisProvider === 'local') ||
          isDeepStrictEqual(parsed[key], normalized[key])
      )
    ) {
      return { error: 'invalid' }
    }
    return { settings: normalized, generation: parsed.settingsGeneration as number }
  }

  const recognizedKeys = SETTINGS_KEYS.filter((key) => Object.hasOwn(parsed, key))
  const hasLegacyPrivacyPolicy =
    LEGACY_REQUIRED_POLICY_KEYS.every((key) => Object.hasOwn(parsed, key)) &&
    (Object.hasOwn(parsed, 'offlineMode') || Object.hasOwn(parsed, 'airgapMode')) &&
    (Object.hasOwn(parsed, 'cloudAnalysisConsent') || Object.hasOwn(parsed, 'analysisConsent'))
  if (!hasLegacyPrivacyPolicy) return { error: 'invalid' }
  if (
    !recognizedKeys.every((key) => key === 'capturePauseSources' || isDeepStrictEqual(parsed[key], normalized[key]))
  ) {
    return { error: 'invalid' }
  }
  return { settings: normalized, generation: 0 }
}

function settingsDocument(settings: LocalSettings, generation: number) {
  return {
    settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
    settingsGeneration: generation,
    ...settings,
  }
}

function syncDirectory(directory: string) {
  let descriptor: number | null = null
  try {
    descriptor = openSync(directory, 'r')
    fsyncSync(descriptor)
  } finally {
    if (descriptor != null) closeSync(descriptor)
  }
}

function writeDocumentAtomically(path: string, document: ReturnType<typeof settingsDocument>) {
  const temporary = `${path}.tmp`
  let descriptor: number | null = null
  try {
    descriptor = openSync(temporary, 'w', 0o600)
    writeFileSync(descriptor, JSON.stringify(document, null, 2))
    fsyncSync(descriptor)
  } finally {
    if (descriptor != null) closeSync(descriptor)
  }
  renameSync(temporary, path)
  syncDirectory(dirname(path))
}

function safeSettings(base: LocalSettings): LocalSettings {
  return {
    ...base,
    dictation: { ...base.dictation, enabled: false },
    offlineMode: true,
    automaticUpdates: false,
    dayAnalysisProvider: null,
    agentComputer: { kind: 'local' },
    cloudAnalysisConsent: false,
    cloudConsentNoticeSeen: false,
    launchAtLogin: false,
    audioCaptureEnabled: false,
    automaticRevinoteProcessing: false,
    liveTaskUpdates: false,
    frequentDayRefresh: false,
    capturePaused: true,
    capturePausedUntil: null,
    capturePauseSources: ['audio', 'capture'],
    captureSchedule: { ...DEFAULT_CAPTURE_SCHEDULE },
    appCaptureMode: 'include',
    includedAppBundleIds: [],
    websiteCaptureMode: 'include',
    includedWebsites: [],
  }
}

function backupMetadata(path: string) {
  if (!existsSync(path)) return { available: false, updatedAt: null }
  const parsed = parseSettingsDocument(path)
  if (!('settings' in parsed)) return { available: false, updatedAt: null }
  return { available: true, updatedAt: statSync(path).mtimeMs }
}

export function readSettingsAt(directory: string): SettingsSnapshot {
  const target = join(directory, SETTINGS_FILE)
  const backup = join(directory, SETTINGS_BACKUP_FILE)
  const targetExists = existsSync(target)
  const backupExists = existsSync(backup)

  if (!targetExists && !backupExists) {
    return {
      settings: { ...DEFAULT_SETTINGS },
      health: { status: 'missing', reason: 'none', lastKnownGoodAvailable: false, lastKnownGoodAt: null },
    }
  }

  if (targetExists) {
    const current = parseSettingsDocument(target)
    if ('settings' in current) {
      mkdirSync(directory, { recursive: true })
      if (!backupExists) {
        try {
          writeDocumentAtomically(backup, settingsDocument(current.settings, Math.max(1, current.generation)))
        } catch {
          // A backup write must never make an otherwise valid policy unreadable.
        }
      }
      const metadata = backupMetadata(backup)
      return {
        settings: current.settings,
        health: {
          status: 'healthy',
          reason: 'none',
          lastKnownGoodAvailable: metadata.available,
          lastKnownGoodAt: metadata.updatedAt,
        },
      }
    }

    const recovered = backupExists ? parseSettingsDocument(backup) : null
    const metadata = backupMetadata(backup)
    return {
      settings: safeSettings(recovered && 'settings' in recovered ? recovered.settings : DEFAULT_SETTINGS),
      health: {
        status: 'recovery-required',
        reason: current.error,
        lastKnownGoodAvailable: metadata.available,
        lastKnownGoodAt: metadata.updatedAt,
      },
    }
  }

  const recovered = parseSettingsDocument(backup)
  const metadata = backupMetadata(backup)
  return {
    settings: safeSettings('settings' in recovered ? recovered.settings : DEFAULT_SETTINGS),
    health: {
      status: 'recovery-required',
      reason: 'missing-current',
      lastKnownGoodAvailable: metadata.available,
      lastKnownGoodAt: metadata.updatedAt,
    },
  }
}

export function writeSettingsAt(directory: string, settings: LocalSettings) {
  mkdirSync(directory, { recursive: true })
  const target = join(directory, SETTINGS_FILE)
  const backup = join(directory, SETTINGS_BACKUP_FILE)
  const snapshot = readSettingsAt(directory)
  if (snapshot.health.status === 'recovery-required') throw new Error('settings-recovery-required')

  let current: ValidSettingsDocument | null = null
  if (existsSync(target)) {
    const parsed = parseSettingsDocument(target)
    if ('settings' in parsed) current = parsed
  }
  const generation = (current?.generation ?? 0) + 1
  if (current) writeDocumentAtomically(backup, settingsDocument(current.settings, Math.max(1, current.generation)))
  writeDocumentAtomically(target, settingsDocument(settings, generation))
  if (!existsSync(backup)) writeDocumentAtomically(backup, settingsDocument(settings, generation))
  return settings
}

function quarantineCurrent(directory: string) {
  const target = join(directory, SETTINGS_FILE)
  if (!existsSync(target)) return null
  const quarantine = join(directory, `settings.invalid-${Date.now()}.json`)
  renameSync(target, quarantine)
  syncDirectory(directory)
  return quarantine
}

export function repairSettingsAt(directory: string, action: 'restore-last-known-good' | 'use-safe-settings') {
  const snapshot = readSettingsAt(directory)
  if (snapshot.health.status !== 'recovery-required') return snapshot.settings

  const backup = join(directory, SETTINGS_BACKUP_FILE)
  const recovered = existsSync(backup) ? parseSettingsDocument(backup) : null
  if (action === 'restore-last-known-good' && (!recovered || !('settings' in recovered))) {
    throw new Error('settings-last-known-good-unavailable')
  }

  mkdirSync(directory, { recursive: true })
  quarantineCurrent(directory)
  const selected =
    action === 'restore-last-known-good' && recovered && 'settings' in recovered
      ? recovered.settings
      : safeSettings(DEFAULT_SETTINGS)
  const generation = recovered && 'settings' in recovered ? recovered.generation + 1 : 1
  writeDocumentAtomically(join(directory, SETTINGS_FILE), settingsDocument(selected, Math.max(1, generation)))
  if (!existsSync(backup)) writeDocumentAtomically(backup, settingsDocument(selected, Math.max(1, generation)))
  return selected
}

export function createCachedSettingsStore() {
  let cachedDirectory: string | null = null
  let cachedSettings: LocalSettings | null = null

  function remember(directory: string, settings: LocalSettings) {
    cachedDirectory = directory
    cachedSettings = settings
    return settings
  }

  function refresh(directory: string) {
    const snapshot = readSettingsAt(directory)
    remember(directory, snapshot.settings)
    return snapshot
  }

  function get(directory: string) {
    if (cachedDirectory !== directory || cachedSettings === null) return refresh(directory).settings
    return cachedSettings
  }

  function update(directory: string, patch: Partial<LocalSettings>, contextImportCompletedAt: number) {
    const current = refresh(directory).settings
    const next = normalizeSettingsPatch(current, patch, contextImportCompletedAt, readCachedCodexModels(directory))
    writeSettingsAt(directory, next)
    return remember(directory, next)
  }

  function repair(directory: string, action: 'restore-last-known-good' | 'use-safe-settings') {
    return remember(directory, repairSettingsAt(directory, action))
  }

  return { get, refresh, repair, update }
}
