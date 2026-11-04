import { randomUUID } from 'node:crypto'
import type { AgentTraceDiagnostic, ContextImportResult } from '@remember/shared'
import { app } from 'electron'
import { recordAgentTrace } from './agentTraceRepository'
import { contextSourceCheckpoints } from './contextImportChanges'
import { discoverAgentContextAt } from './contextImportSources'
import { agentErrorText } from './dailyReview/agentErrors'
import { generateContextWikiBootstrap } from './dailyReview/analyzer'
import { applyManagedKnowledgeUpdates, listKnowledgePages } from './dailyReview/knowledgeStore'
import { requireNetworkAccess } from './networkAccess'
import { getInterfaceLocale, getSettings } from './settings'
import { recordWikiContextCheckpoints } from './wikiHistoryStore'

let activeImport: Promise<ContextImportResult> | null = null

export function getContextImportPreview() {
  return discoverAgentContextAt(app.getPath('home')).preview
}

export function importAgentContext() {
  requireNetworkAccess()
  if (activeImport) return activeImport
  activeImport = runContextImport().finally(() => {
    activeImport = null
  })
  return activeImport
}

async function runContextImport(): Promise<ContextImportResult> {
  const startedAt = Date.now()
  const runId = randomUUID()
  const diagnostics: AgentTraceDiagnostic[] = []
  const discovery = discoverAgentContextAt(app.getPath('home'), startedAt)
  const providers = discovery.preview.providers
    .filter((provider) => provider.available)
    .map((provider) => provider.provider)

  recordAgentTrace({
    id: runId,
    action: 'context-import',
    provider: getSettings().defaultAgentProvider,
    status: 'running',
    startedAt,
    completedAt: null,
    dayId: null,
    reason: null,
    error: null,
    logs: [{ timestamp: startedAt, message: `${discovery.documents.length} lokale contextbronnen gevonden.` }],
  })

  try {
    const updates = await generateContextWikiBootstrap(
      discovery.documents,
      listKnowledgePages(),
      getInterfaceLocale() === 'nl' ? 'nl' : 'en',
      (diagnostic) => diagnostics.push(diagnostic)
    )
    const completedAt = Date.now()
    const applied = applyManagedKnowledgeUpdates(`agent-import://${runId}`, completedAt, updates, 'Agentimport')
    recordWikiContextCheckpoints(contextSourceCheckpoints(discovery.documents, startedAt))
    const result = {
      providers,
      sourceCount: discovery.documents.length,
      createdPages: applied.filter((update) => update.changeType === 'created').map((update) => update.slug),
      updatedPages: applied.filter((update) => update.changeType === 'updated').map((update) => update.slug),
    } satisfies ContextImportResult
    recordAgentTrace({
      id: runId,
      action: 'context-import',
      provider: getSettings().defaultAgentProvider,
      status: 'completed',
      startedAt,
      completedAt,
      dayId: null,
      reason: null,
      error: null,
      logs: [
        { timestamp: startedAt, message: `${discovery.documents.length} lokale contextbronnen gevonden.` },
        { timestamp: completedAt, message: `${applied.length} Wiki-pagina's verwerkt.` },
      ],
      diagnostics,
    })
    return result
  } catch (error) {
    const completedAt = Date.now()
    const detail = agentErrorText(error) || 'context-import-failed'
    recordAgentTrace({
      id: runId,
      action: 'context-import',
      provider: getSettings().defaultAgentProvider,
      status: 'failed',
      startedAt,
      completedAt,
      dayId: null,
      reason: null,
      error: detail,
      logs: [
        { timestamp: startedAt, message: `${discovery.documents.length} lokale contextbronnen gevonden.` },
        { timestamp: completedAt, message: detail },
      ],
      diagnostics,
    })
    throw error
  }
}
