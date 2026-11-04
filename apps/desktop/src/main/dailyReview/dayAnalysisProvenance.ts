import { createHash } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import type { DayAnalysisProvenance, DayMemory } from '@remember/shared'
import { readAgentLearningEvent, readAgentLearningEvents } from '../agentLearning'
import { agentEvidencePermitted, type selectAgentEvidence } from '../residentAgentPrivacy'
import { residentWikiPagePermitted } from '../residentWikiPrivacy'
import { getSettings } from '../settings'
import { resolveWikiEvidenceSource } from '../wikiEvidenceSource'
import { getWikiAccess, getWikiPageHistoryForSpace } from '../wikiSpaceStore'
import type { AnalysisEvidenceEntry } from './analysisContext'
import { selectDayAnalysisEvidence } from './analysisPrivacy'
import type { DayAnalysisValidation } from './dayAnalysisValidation'
import { withDayAnalysisValidation } from './dayAnalysisValidation'
import type { EvidenceStore } from './evidenceStore'
import type { AnalysisWikiPage } from './wikiPromptSafety'

const contentHash = (text: string) => createHash('sha256').update(text).digest('hex')
type Settings = Parameters<typeof selectAgentEvidence>[1]

export function createDayAnalysisValidationScope(store: EvidenceStore) {
  let active: { settings: ReturnType<typeof getSettings>; checks: DayAnalysisValidation } | null = null
  return function validate<T>(operation: (scope: NonNullable<typeof active>) => T): T {
    if (active) return operation(active)
    const settings = getSettings()
    return withDayAnalysisProvenanceValidation(store, settings, (checks) => {
      active = { settings, checks }
      try {
        return operation(active)
      } finally {
        active = null
      }
    })
  }
}

function wikiReference(
  page: Pick<AnalysisWikiPage, 'spaceId' | 'slug'>,
  store: EvidenceStore,
  settings: Settings,
  prior?: DayAnalysisProvenance['wikiPages'][number],
  overview = getWikiAccess()
) {
  const spaceId = page.spaceId ?? 'personal'
  const space = overview.spaces.find((entry) => entry.id === spaceId)
  if (!space) return null
  try {
    const history = getWikiPageHistoryForSpace({ spaceId, slug: page.slug })
    if (!history.headRevisionId || (prior && prior.pageId !== history.pageId)) return null
    const head = history.revisions.find((revision) => revision.id === history.headRevisionId)
    if (!head || head.operation === 'deleted') return null
    const revisionId = prior?.revisionId ?? history.headRevisionId
    if (!history.revisions.some((revision) => revision.id === revisionId)) return null
    if (
      !residentWikiPagePermitted(
        { ...history, headRevisionId: revisionId },
        (source) =>
          resolveWikiEvidenceSource(source, {
            agentEvent: readAgentLearningEvent,
            captured: (id) => store.ambientTasks.resolveSource(id),
          }),
        settings
      )
    )
      return null
    return { spaceId, slug: page.slug, pageId: history.pageId, revisionId }
  } catch {
    return null
  }
}

/** Check retained inputs and current access, without making normal source edits erase earlier Day history. */
export function dayAnalysisProvenancePermitted(
  provenance: DayAnalysisProvenance,
  store: EvidenceStore,
  settings: Settings = getSettings()
) {
  return withDayAnalysisProvenanceValidation(store, settings, ({ summaryPermitted }) => summaryPermitted(provenance))
}

export function withDayAnalysisProvenanceValidation<T>(
  store: EvidenceStore,
  settings: Settings,
  operation: Parameters<typeof withDayAnalysisValidation<T>>[3]
) {
  let overview: ReturnType<typeof getWikiAccess> | undefined
  return store.proactive.withDaySourceReads(() =>
    withDayAnalysisValidation(
      store,
      settings,
      {
        wikiPage: (page) => {
          overview ??= getWikiAccess()
          return Boolean(wikiReference(page, store, settings, page, overview))
        },
        agentMessages: (provenance) => {
          const current = new Map(
            readAgentLearningEvents({ after: provenance.startedAt - 1, through: provenance.coveredThrough }).map(
              (event) => [event.id, contentHash(event.text)]
            )
          )
          return provenance.agentMessages.every((event) => current.get(event.id) === event.contentHash)
        },
      },
      operation
    )
  )
}

export async function prepareDayAnalysisInputs(input: {
  workdayId: string
  startedAt: number
  coveredThrough: number
  previousMemory: DayMemory | null
  evidence: AnalysisEvidenceEntry[]
  wikiPages: AnalysisWikiPage[]
  store: EvidenceStore
}) {
  const settings = getSettings()
  const policy = JSON.stringify(settings)
  const deletionRevision = input.store.deletionRevision()
  const evidence: AnalysisEvidenceEntry[] = []
  for (let offset = 0; offset < input.evidence.length; offset += 64) {
    evidence.push(...selectDayAnalysisEvidence(input.evidence.slice(offset, offset + 64), settings))
    await setImmediate()
    if (input.store.deletionRevision() !== deletionRevision || JSON.stringify(getSettings()) !== policy) {
      throw new Error('analysis-inputs-invalidated')
    }
  }
  const rawEvidenceIds = evidence
    .filter((entry) => !entry.agentMessage && entry.evidenceId)
    .map((entry) => entry.evidenceId as string)
  await input.store.proactive.warmDayAnalysisSources(input.workdayId, rawEvidenceIds, policy, (entry) =>
    agentEvidencePermitted(entry, settings)
  )
  if (input.store.deletionRevision() !== deletionRevision || JSON.stringify(getSettings()) !== policy) {
    throw new Error('analysis-inputs-invalidated')
  }
  return withDayAnalysisProvenanceValidation(input.store, settings, (validation) => {
    const previousMemory =
      input.previousMemory?.analysisProvenance && validation.summaryPermitted(input.previousMemory.analysisProvenance)
        ? input.previousMemory
        : null
    const previous = previousMemory?.analysisProvenance
    const wikiAccess = input.wikiPages.length ? getWikiAccess() : undefined
    const wikiPairs = input.wikiPages.flatMap((page) => {
      const reference = wikiReference(page, input.store, settings, undefined, wikiAccess)
      return reference ? [{ page, reference }] : []
    })
    const tasks = validation.permittedTasks()
    const agentParts = new Map<string, AnalysisEvidenceEntry[]>()
    const admittedAgentIds = new Set(
      evidence.flatMap((entry) => (entry.agentMessage ? [entry.agentMessage.eventId] : []))
    )
    for (const entry of input.evidence) {
      if (!entry.agentMessage) continue
      if (!admittedAgentIds.has(entry.agentMessage.eventId)) continue
      const parts = agentParts.get(entry.agentMessage.eventId) ?? []
      parts.push(entry)
      agentParts.set(entry.agentMessage.eventId, parts)
    }
    const agents = [...agentParts].map(([id, parts]) => ({
      id,
      contentHash: contentHash(
        parts
          .sort((a, b) => (a.agentMessage?.partIndex ?? 0) - (b.agentMessage?.partIndex ?? 0))
          .map((entry) => entry.text)
          .join('')
      ),
    }))
    const rawSources = input.store.proactive.dayAnalysisSources(input.workdayId, rawEvidenceIds)
    if (rawSources.length !== new Set(rawEvidenceIds).size) throw new Error('day-analysis-source-unavailable')
    const unique = <T>(values: T[], key: (value: T) => string) => [
      ...new Map(values.map((value) => [key(value), value])).values(),
    ]
    const provenance: DayAnalysisProvenance = {
      version: 1,
      workdayId: input.workdayId,
      startedAt: input.startedAt,
      coveredThrough: input.coveredThrough,
      rawEvidenceIds: [...new Set([...(previous?.rawEvidenceIds ?? []), ...rawEvidenceIds])],
      rawSources: unique(
        [...(previous?.rawSources ?? []), ...rawSources],
        (source) => `${source.kind}:${source.sourceId}`
      ),
      taskIds: [...new Set([...(previous?.taskIds ?? []), ...tasks.map((task) => task.id)])],
      agentMessages: unique([...(previous?.agentMessages ?? []), ...agents], (source) => source.id),
      wikiPages: unique(
        [...(previous?.wikiPages ?? []), ...wikiPairs.map((entry) => entry.reference)],
        (source) => `${source.spaceId}:${source.pageId}:${source.revisionId}`
      ),
    }
    return { evidence, previousMemory, wikiPages: wikiPairs.map((entry) => entry.page), tasks: [...tasks], provenance }
  })
}
