import { createHash } from 'node:crypto'
import path from 'node:path'
import type { AgentLearningStatus, AgentProvider } from '@remember/shared'
import { CHANNELS } from '@remember/shared'
import { app, BrowserWindow, powerMonitor } from 'electron'
import { type AgentActivityStore, createAgentActivityStore } from './agentActivityStore'
import { agentActivityPolicyToken, createAgentActivityTracking } from './agentActivityTracking'
import { createAgentLearningStatusTrace } from './agentLearningTrace'
import { recordAgentTrace } from './agentTraceRepository'
import { contextSourceKey } from './contextImportChanges'
import type { AgentContextDocument } from './contextImportSources'
import { agentErrorText } from './dailyReview/agentErrors'
import { generateAgentKnowledgeUpdates, generateKnowledgeOrganizationUpdates } from './dailyReview/analyzer'
import { getEvidenceStore } from './dailyReview/evidenceRepository'
import type { WikiSuggestionSource } from './dailyReview/wikiSuggestionPolicy'
import { createKnowledgeMaintenance } from './knowledgeMaintenance'
import { agentEvidencePermitted } from './residentAgentPrivacy'
import { residentWikiPagePermitted } from './residentWikiPrivacy'
import { getInterfaceLocale, getSettings, getSettingsHealth, subscribeSettingsChanges } from './settings'
import { resolveWikiEvidenceSource } from './wikiEvidenceSource'
import { listWikiProposals } from './wikiHistoryStore'
import {
  applyKnowledgeUpdatesByProject,
  getWikiOverview,
  getWikiPageHistoryForSpace,
  wikiPagesForAnalysis,
} from './wikiSpaceStore'

let store: AgentActivityStore | null = null
let worker: ReturnType<typeof createAgentActivityTracking> | null = null
let unsubscribeSettings: (() => void) | null = null
let maintenance: ReturnType<typeof createKnowledgeMaintenance> | null = null
let maintenanceTimer: ReturnType<typeof setInterval> | null = null

export async function knowledgeMaintenanceSnapshot() {
  const policy = learningPolicy()
  if (!policy.enabled || policy.paused || !policy.inferenceEnabled || !policy.enabledSince) return null
  const settings = getSettings()
  const space = getWikiOverview([]).spaces.find((entry) => entry.id === 'personal')
  if (!space) return null
  const pages = (await wikiPagesForAnalysis()).filter(
    (page) => (page.spaceId ?? 'personal') === 'personal' && !['index', 'log'].includes(page.slug)
  )
  const permittedPageSlugs: string[] = []
  const sources = new Map<string, WikiSuggestionSource>()
  for (const page of pages) {
    const history = getWikiPageHistoryForSpace({ spaceId: 'personal', slug: page.slug })
    if (
      residentWikiPagePermitted(
        history,
        (evidence) =>
          resolveWikiEvidenceSource(evidence, {
            agentEvent: readAgentLearningEvent,
            captured: (id) => getEvidenceStore().ambientTasks.resolveSource(id),
          }),
        settings
      )
    )
      permittedPageSlugs.push(page.slug)
    for (const revision of history.revisions) {
      for (const evidence of revision.evidence ?? []) {
        if (!evidence.kind || evidence.observedAt < policy.enabledSince) continue
        const original = resolveWikiEvidenceSource(evidence, {
          agentEvent: readAgentLearningEvent,
          captured: (id) => getEvidenceStore().ambientTasks.resolveSource(id),
        })
        if (!original?.text.includes(evidence.quote) || !agentEvidencePermitted(original, settings)) continue
        const { sourceId, quote: _quote, ...provenance } = evidence
        const id = evidence.eventId ? `agent-event://${evidence.provider}/${evidence.eventId}` : sourceId
        sources.set(id, {
          ...provenance,
          ...(evidence.eventId ? { partIndex: undefined, partCount: undefined } : {}),
          kind: evidence.kind,
          id,
          text: original.text,
        })
      }
    }
  }
  return {
    policyToken: JSON.stringify([
      agentActivityPolicyToken(policy),
      settings.defaultAgentProvider,
      space.maintenanceMode,
      settings.cloudAnalysisConsent,
      settings.offlineMode,
      settings.appCaptureMode,
      settings.excludedAppBundleIds,
      settings.includedAppBundleIds,
      settings.websiteCaptureMode,
      settings.excludedWebsites,
      settings.includedWebsites,
      settings.excludePasswordManagers,
      settings.excludePrivateBrowsing,
    ]),
    contextToken: JSON.stringify([
      permittedPageSlugs,
      listWikiProposals()
        .filter((proposal) => proposal.suggestedSpaceId === 'personal')
        .map(({ id, status, slug, content }) => [id, status, slug, content]),
    ]),
    permittedPageSlugs,
    enabledSince: policy.enabledSince,
    pages,
    sources: [...sources.values()],
  }
}

function reconcileKnowledgeOrganization() {
  return maintenance?.run().catch((error) => {
    console.error('[knowledge] person/profile reconciliation deferred', agentErrorText(error))
  })
}

function learningPolicy() {
  const settings = getSettings()
  const providers: Array<{ provider: AgentProvider; bundleId: string }> = [
    { provider: 'codex', bundleId: 'com.openai.codex' },
    { provider: 'claude', bundleId: 'com.anthropic.claudefordesktop' },
  ]
  return {
    enabled: settings.agentLearningEnabled && getSettingsHealth().status !== 'recovery-required',
    enabledSince: settings.agentLearningEnabledAt,
    paused:
      settings.capturePaused &&
      settings.capturePauseSources.includes('capture') &&
      (settings.capturePausedUntil === null || settings.capturePausedUntil > Date.now()),
    inferenceEnabled: !settings.offlineMode && settings.cloudAnalysisConsent,
    allowedProviders: providers
      .filter(({ bundleId }) =>
        settings.appCaptureMode === 'include'
          ? settings.includedAppBundleIds.includes(bundleId)
          : !settings.excludedAppBundleIds.includes(bundleId)
      )
      .map(({ provider }) => provider),
  }
}

async function processAgentKnowledge(documents: AgentContextDocument[]) {
  const groups = new Map<string, AgentContextDocument[]>()
  for (const document of documents) {
    const scope = `${document.provider}:${document.sourceId}`
    groups.set(scope, [...(groups.get(scope) ?? []), document])
  }
  const processedSourceKeys: string[] = []
  const deferredSourceKeys: string[] = []
  let failure: unknown
  for (const group of groups.values()) {
    try {
      const result = await processAgentKnowledgeGroup(group)
      processedSourceKeys.push(...result.processedSourceKeys)
      deferredSourceKeys.push(...result.deferredSourceKeys)
    } catch (error) {
      failure = error
      deferredSourceKeys.push(...group.map(contextSourceKey))
    }
  }
  if (failure && !processedSourceKeys.length) throw failure
  void reconcileKnowledgeOrganization()
  return { processedSourceKeys, deferredSourceKeys }
}

async function processAgentKnowledgeGroup(documents: AgentContextDocument[]) {
  const policy = learningPolicy()
  const settings = getSettings()
  if (!policy.enabled || policy.paused || !policy.inferenceEnabled) throw new Error('agent-learning-paused')
  const startedAt = Date.now()
  const batchId = createHash('sha256')
    .update(JSON.stringify(documents.map((document) => [contextSourceKey(document), document.content])))
    .digest('hex')
  const runId = `agent-learning:${batchId}:${startedAt}`
  const base = {
    id: runId,
    action: 'agent-learning' as const,
    provider: settings.defaultAgentProvider,
    startedAt,
    dayId: null,
    reason: null,
  }
  const logs = [{ timestamp: startedAt, message: 'Nieuwe agentgesprekken verwerken.' }]
  recordAgentTrace({ ...base, status: 'running', completedAt: null, error: null, logs })
  try {
    const pages = await wikiPagesForAnalysis()
    const spaces = getWikiOverview([]).spaces
    const result = await generateAgentKnowledgeUpdates(
      documents,
      pages,
      getInterfaceLocale(),
      settings.defaultAgentProvider,
      undefined,
      spaces
    )
    const current = learningPolicy()
    if (
      !current.enabled ||
      current.paused ||
      !current.inferenceEnabled ||
      current.enabledSince !== policy.enabledSince ||
      documents.some((document) => !current.allowedProviders.includes(document.provider))
    )
      throw new Error('agent-learning-paused')
    const applied = await applyKnowledgeUpdatesByProject(batchId, Date.now(), result.updates, {
      sourceId: `agent-learning://${batchId}`,
      expectedPages: pages,
      explicitDestinations: true,
    })
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(CHANNELS.memoryChanged)
    }
    recordAgentTrace({
      ...base,
      status: 'completed',
      completedAt: Date.now(),
      error: null,
      logs: [
        ...logs,
        {
          timestamp: Date.now(),
          message: `${applied.length} Wiki-wijzigingen opgeslagen; ${result.deferredSourceKeys.length} bronnen wachten op verwerking.`,
        },
        ...result.reviewNotes.map((message) => ({ timestamp: Date.now(), message })),
      ],
    })
    return result
  } catch (error) {
    const detail = agentErrorText(error) || 'agent-learning-failed'
    recordAgentTrace({
      ...base,
      status: 'failed',
      completedAt: Date.now(),
      error: detail,
      logs: [
        ...logs,
        {
          timestamp: Date.now(),
          message: 'Leren van agents wordt automatisch opnieuw geprobeerd. Je berichten blijven bewaard.',
        },
      ],
    })
    throw error
  }
}

export function startAgentLearning() {
  if (worker) return
  store = createAgentActivityStore(path.join(app.getPath('userData'), 'daily-review', 'agent-activity.sqlite'))
  const traceStatus = createAgentLearningStatusTrace(recordAgentTrace)
  worker = createAgentActivityTracking({
    store,
    homeDirectory: app.getPath('home'),
    codexDirectory: process.env.CODEX_HOME,
    claudeDirectory: process.env.CLAUDE_CONFIG_DIR,
    excludedDirectories: [app.getPath('userData')],
    getPolicy: learningPolicy,
    process: processAgentKnowledge,
    changed: (status) => {
      const policy = learningPolicy()
      const settings = getSettings()
      traceStatus(
        status,
        { ...policy, cloudAnalysisConsent: settings.cloudAnalysisConsent, offlineMode: settings.offlineMode },
        settings.defaultAgentProvider
      )
    },
  })
  worker.start()
  maintenance = createKnowledgeMaintenance({
    statePath: path.join(app.getPath('userData'), 'daily-review', 'knowledge-maintenance.json'),
    snapshot: knowledgeMaintenanceSnapshot,
    generate: (snapshot, signal) =>
      generateKnowledgeOrganizationUpdates(
        snapshot.pages,
        snapshot.sources,
        getInterfaceLocale(),
        getSettings().defaultAgentProvider,
        signal
      ),
    apply: async (updates, snapshot, isCurrent) => {
      if (!(await isCurrent())) throw new Error('knowledge-maintenance-context-changed')
      await applyKnowledgeUpdatesByProject('knowledge-organization-v1', Date.now(), updates, {
        sourceId: 'knowledge-maintenance://people-v1',
        expectedPages: snapshot.pages.map((page) => ({ ...page, spaceId: 'personal' })),
        explicitDestinations: true,
        assertCurrent: isCurrent,
      })
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(CHANNELS.memoryChanged)
      }
    },
  })
  void reconcileKnowledgeOrganization()
  maintenanceTimer = setInterval(() => void reconcileKnowledgeOrganization(), 10 * 60_000)
  maintenanceTimer.unref()
  unsubscribeSettings = subscribeSettingsChanges(() => worker?.policyChanged())
  powerMonitor.on('resume', resumeLearning)
}

function resumeLearning() {
  void worker?.tick()
}

export function getAgentLearningStatus(): AgentLearningStatus {
  const status = worker?.status()
  const policy = learningPolicy()
  return {
    status: !policy.enabled
      ? 'disabled'
      : policy.paused
        ? 'paused'
        : !getSettings().cloudAnalysisConsent
          ? 'needs-consent'
          : getSettings().offlineMode
            ? 'offline'
            : status?.state === 'processing'
              ? 'learning'
              : status?.state === 'error'
                ? 'failed'
                : 'watching',
    lastCheckedAt: status?.lastCheckedAt ?? null,
    lastProcessedAt: status?.lastProcessedAt ?? null,
    pendingCount: status?.pendingSpans ?? 0,
    sourceCount: status?.providers.reduce((total, provider) => total + provider.sourceCount, 0) ?? 0,
    error: policy.enabled && !policy.paused && policy.inferenceEnabled ? (status?.error ?? null) : null,
  }
}

export async function checkAgentLearning() {
  await worker?.tick()
  return getAgentLearningStatus()
}

export function readAgentLearningEvents(window: { after: number; through: number }) {
  const policy = learningPolicy()
  if (!policy.enabled || policy.paused) return []
  return store?.listEvents({ ...window, providers: policy.allowedProviders }) ?? []
}

export function readAgentLearningEvent(id: string) {
  const policy = learningPolicy()
  if (!policy.enabled || policy.paused || !policy.enabledSince) return null
  return (
    store?.readEvent(id, {
      after: policy.enabledSince - 1,
      providers: policy.allowedProviders,
    }) ?? null
  )
}

export function latestAgentLearningEventAt(window: { after: number; through: number }) {
  const policy = learningPolicy()
  if (!policy.enabled || policy.paused) return null
  return store?.latestRecordedAt({ ...window, providers: policy.allowedProviders }) ?? null
}

export function getAgentLearningPolicyToken() {
  return agentActivityPolicyToken(learningPolicy())
}

export async function stopAgentLearning() {
  if (maintenanceTimer) clearInterval(maintenanceTimer)
  maintenanceTimer = null
  const stoppingMaintenance = maintenance
  maintenance = null
  await stoppingMaintenance?.stop()
  unsubscribeSettings?.()
  unsubscribeSettings = null
  powerMonitor.removeListener('resume', resumeLearning)
  await worker?.stop()
  worker = null
  store?.close()
  store = null
}
