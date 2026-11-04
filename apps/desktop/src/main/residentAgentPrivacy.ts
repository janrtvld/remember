import {
  type ContextMoment,
  type Day,
  type DayAnalysisProvenance,
  isMacosSystemActivity,
  redactSensitiveCaptureText,
  type WorkItem,
} from '@remember/shared'
import type { EvidenceStore } from './dailyReview/evidenceStore'
import type { ProactiveSource } from './dailyReview/proactiveStore'
import { isExcludedContext } from './exclusions'

export type AgentEvidence = {
  kind: 'context' | 'speech' | 'note' | 'day'
  text: string
  appName?: string
  bundleId?: string
  windowTitle?: string
  url?: string
}

function authenticationSurface(entry: AgentEvidence) {
  if (
    /\b(?:sign[ -]?in|log[ -]?in|aanmelden|inloggen|password|wachtwoord|two.factor|multi.factor|verification code|verificatiecode)\b/i.test(
      entry.windowTitle ?? ''
    )
  )
    return true
  if (!entry.url) return false
  try {
    const url = new URL(entry.url)
    return (
      Boolean(url.username || url.password) ||
      /^(?:accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|appleid\.apple\.com|idmsa\.apple\.com)$/.test(
        url.hostname
      ) ||
      /^(?:auth|login|signin|sso)\./.test(url.hostname) ||
      /\/(?:login|signin|sign-in|auth|oauth|oauth2|sso|password|reset-password|mfa|2fa)(?:\/|$)/i.test(url.pathname) ||
      [...url.searchParams.keys()].some((name) =>
        /^(?:access_token|id_token|refresh_token|client_secret|password|code)$/i.test(name)
      )
    )
  } catch {
    return true
  }
}

export function agentEvidencePermitted(entry: AgentEvidence, settings: Parameters<typeof isExcludedContext>[1]) {
  return !(
    entry.kind === 'context' &&
    (isMacosSystemActivity({ appName: entry.appName ?? '', bundleId: entry.bundleId ?? '' }) ||
      authenticationSurface(entry) ||
      isExcludedContext(
        {
          ...entry,
          appName: entry.appName ?? '',
          bundleId: entry.bundleId ?? '',
          windowTitle: entry.windowTitle ?? '',
        },
        settings
      ))
  )
}

export function selectAgentEvidence<T extends AgentEvidence>(
  entries: readonly T[],
  settings: Parameters<typeof isExcludedContext>[1]
) {
  const evidence: T[] = []
  for (const entry of entries) {
    if (!agentEvidencePermitted(entry, settings)) continue
    let url = entry.url
    if (url) {
      try {
        const parsed = new URL(url)
        parsed.search = ''
        parsed.hash = ''
        url = parsed.toString()
      } catch {
        url = undefined
      }
    }
    evidence.push({
      ...entry,
      text: redactSensitiveCaptureText(entry.text),
      ...(entry.windowTitle ? { windowTitle: redactSensitiveCaptureText(entry.windowTitle) } : {}),
      ...(entry.url ? { url } : {}),
    })
  }
  return { evidence, omittedCount: entries.length - evidence.length }
}

export type AgentTaskProvenance = {
  hasTaskSources: (id: string) => boolean
  taskEvidence: (id: string) => AgentEvidence[]
  taskSourceIds: (id: string) => string[]
}

export function selectAgentTasks<T extends Pick<WorkItem, 'id' | 'sources'>>(
  tasks: readonly T[],
  options: {
    days?: Pick<Day, 'id' | 'contextMoments'>[]
    contextEvidence?: (workdayId: string, observedAt: number) => AgentEvidence[]
    settings: Parameters<typeof selectAgentEvidence>[1]
    provenance?: AgentTaskProvenance
  }
) {
  return tasks.filter((task) => {
    let covered = new Set<string>()
    if (options.provenance?.hasTaskSources(task.id)) {
      const evidence = options.provenance.taskEvidence(task.id)
      if (!evidence.length || !evidence.every((entry) => agentEvidencePermitted(entry, options.settings))) return false
      covered = new Set(options.provenance.taskSourceIds(task.id))
    }
    return (
      task.sources.length > 0 &&
      task.sources.every((source) => {
        if (covered.has(source.id)) return true
        if (source.kind === 'manual') return true
        if (source.kind !== 'observed' || !source.workdayId) return false
        const matching = options.contextEvidence
          ? options.contextEvidence(source.workdayId, source.observedAt)
          : (options.days?.find((entry) => entry.id === source.workdayId)?.contextMoments ?? [])
              .filter((entry) => entry.timestamp === source.observedAt)
              .filter((entry): entry is ContextMoment => 'text' in entry)
              .map((entry) => ({ ...entry, kind: 'context' as const }))
        return matching.length > 0 && matching.every((entry) => agentEvidencePermitted(entry, options.settings))
      })
    )
  })
}

/** A derived Day has aggregate lineage; one unavailable contributor withholds the whole snapshot. */
export function selectProactiveSources(
  sources: ProactiveSource[],
  store: Pick<EvidenceStore, 'proactive' | 'readTaskContextEvidence' | 'listWorkItems' | 'ambientTasks'>,
  settings: Parameters<typeof selectAgentEvidence>[1],
  options: {
    requireCurrent?: boolean
    summaryPermitted?: (provenance: DayAnalysisProvenance) => boolean
    permittedTaskIds?: () => ReadonlySet<string>
    evidencePermitted?: (evidence: readonly AgentEvidence[]) => boolean
    daySourcePermitted?: (source: Pick<ProactiveSource, 'kind' | 'sourceId'>) => boolean
  } = {}
) {
  let permittedTasks: ReadonlySet<string> | undefined
  const permitted = sources.filter((source) => {
    if (source.kind !== 'day') return true
    const provenance = store.proactive.daySourceProvenance(source)
    if (provenance && options.summaryPermitted?.(provenance) !== true) return false
    if (options.daySourcePermitted) {
      if (!options.daySourcePermitted(source)) return false
    } else {
      const evidence = store.proactive.daySourceEvidence(source)
      if (
        !evidence ||
        !(options.evidencePermitted?.(evidence) ?? selectAgentEvidence(evidence, settings).omittedCount === 0)
      )
        return false
    }
    permittedTasks ??=
      options.permittedTaskIds?.() ??
      new Set(
        selectAgentTasks(store.listWorkItems(), {
          contextEvidence: (workdayId, observedAt) => store.readTaskContextEvidence(workdayId, observedAt),
          settings,
          provenance: store.ambientTasks,
        }).map((item) => item.id)
      )
    return (
      store.proactive.daySourceTaskIds(source).every((id) => permittedTasks!.has(id)) &&
      (!options.requireCurrent || store.proactive.daySourceCurrent(source))
    )
  })
  const result = selectAgentEvidence(permitted, settings)
  return { evidence: result.evidence, omittedCount: sources.length - result.evidence.length }
}
