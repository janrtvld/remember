import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { agentComputerExecutionKey, redactSensitiveCaptureText, type WikiPage } from '@remember/shared'
import { app } from 'electron'
import { hashBriefingValue } from '../../../../experiments/always-on-agent/briefing-protocol.mjs'
import {
  briefingQaInstallationId,
  createBriefingNative,
  selectBriefingNativeResources,
  validateBriefingNativeManifest,
} from './briefingNativeCore'
import { connectBriefingTcp } from './briefingTcpConnector'
import type { EvidenceStore } from './dailyReview/evidenceStore'
import { listKnowledgePages } from './dailyReview/knowledgeStore'
import { isOfflineMode, subscribeNetworkAccessChanges } from './networkAccess'
import { selectAgentEvidence } from './residentAgentPrivacy'
import type { ResidentAgentStore } from './residentAgentStore'
import { residentWikiPagePermitted } from './residentWikiPrivacy'
import { getInterfaceLocale, getSettings, subscribeSettingsChanges } from './settings'
import { subscribeWikiContextInvalidation } from './wikiContextEvents'
import { getWikiOverview, getWikiPageHistoryForSpace, readWikiContextSnapshot } from './wikiSpaceStore'

export function createNativeBriefing(options: {
  resident: ResidentAgentStore
  evidence: EvidenceStore
  currentPolicyToken(): string | null
  attentionAvailable(): boolean
  changed(): void
  error?(error: unknown): void
}) {
  const resources = selectBriefingNativeResources({
    isPackaged: app.isPackaged,
    qaEnabled: process.env.REMEMBER_QA_BRIEFING_ENABLED === '1',
    qaManifestPath: process.env.REMEMBER_QA_BRIEFING_MANIFEST,
  })
  const bytes = readFileSync(resources.manifestPath)
  if (bytes.byteLength > 16000) throw new Error('briefing-manifest-invalid')
  const manifest = validateBriefingNativeManifest(JSON.parse(bytes.toString('utf8')))
  if (manifest.version !== resources.version) throw new Error('briefing-manifest-edition-mismatch')
  const profilePath = realpathSync(app.getPath('userData'))
  const installationId = briefingQaInstallationId(profilePath)
  if (manifest.profilePath !== profilePath || manifest.installationId !== installationId)
    throw new Error('briefing-profile-mismatch')
  const systemPrompt = readFileSync(path.join(app.getAppPath(), 'resources/briefing', resources.promptBasename), 'utf8')
  if (!systemPrompt.trim() || Buffer.byteLength(systemPrompt) > 10000) throw new Error('briefing-prompt-invalid')
  const context = () => {
    const settings = getSettings()
    const executionKey = agentComputerExecutionKey(settings.agentComputer)
    return {
      available:
        !isOfflineMode() &&
        settings.cloudAnalysisConsent &&
        settings.liveTaskUpdates &&
        settings.dayAnalysisProvider === 'codex' &&
        settings.agentComputer.kind === 'remote' &&
        executionKey === manifest.computerExecutionKey,
      fingerprint: hashBriefingValue({
        version: 1,
        profilePath,
        installationId,
        manifest,
        systemPrompt,
        computerExecutionKey: executionKey,
        cloudAnalysisConsent: settings.cloudAnalysisConsent,
        liveTaskUpdates: settings.liveTaskUpdates,
        dayAnalysisProvider: settings.dayAnalysisProvider,
        offline: isOfflineMode(),
        deletionRevision: options.evidence.deletionRevision(),
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
      }),
      policyToken: options.currentPolicyToken(),
      profilePath,
      installationId,
      computerExecutionKey: executionKey,
      locale: getInterfaceLocale(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }
  }
  const permitted = (page: WikiPage) =>
    page.slug === manifest.source.slug &&
    residentWikiPagePermitted(
      getWikiPageHistoryForSpace({ spaceId: 'personal', slug: page.slug }),
      (source) => options.evidence.ambientTasks.resolveSource(source.eventId ?? source.sourceId),
      getSettings()
    )
  const currentPage = () => {
    if (!getWikiOverview([]).spaces.some((space) => space.id === 'personal')) return null
    return listKnowledgePages().find((page) => permitted(page)) ?? null
  }
  const error = options.error ?? ((value: unknown) => console.error('[briefing] withheld; no automatic retry', value))
  const owner = createBriefingNative({
    ...options,
    manifest,
    context,
    currentPage,
    systemPrompt,
    error,
    readPersonal: async (signal) => {
      if (signal.aborted) throw new Error('briefing-operation-aborted')
      const snapshot = await readWikiContextSnapshot('personal')
      if (signal.aborted) throw new Error('briefing-operation-aborted')
      return { ...snapshot, pages: snapshot.pages.filter(permitted) }
    },
    projectEvidence: (source) => selectAgentEvidence([source], getSettings()).evidence[0] ?? null,
    projectPersonal: (page) => redactSensitiveCaptureText(page.content),
    connect: (endpoint) => connectBriefingTcp(endpoint),
  })
  let fingerprint = context().fingerprint
  let disposed = false
  const invalidate = () => {
    if (!disposed) void owner.invalidate().catch(error)
  }
  const synchronize = () => {
    const next = context().fingerprint
    if (next !== fingerprint) {
      fingerprint = next
      invalidate()
    }
  }
  const unsubscribe = [
    subscribeSettingsChanges(synchronize),
    subscribeNetworkAccessChanges(synchronize),
    options.evidence.subscribeEvidenceDeletion(invalidate),
    subscribeWikiContextInvalidation(invalidate),
  ]
  return {
    ...owner,
    async dispose() {
      if (disposed) return
      disposed = true
      for (const stop of unsubscribe) stop()
      await owner.dispose()
    },
  }
}
