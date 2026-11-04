import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { WikiPageUpdate, WikiSuggestionEvidence } from '@remember/shared'
import { isPrivateSelfProfilePage } from './agentContextService'
import type { AnalysisWikiPage } from './dailyReview/wikiPromptSafety'
import type { WikiSuggestionSource } from './dailyReview/wikiSuggestionPolicy'

export const KNOWLEDGE_MAINTENANCE_VERSION = 1
const MAX_SOURCES_PER_RUN = 8
const MAX_SOURCE_CHARACTERS = 60_000

export type KnowledgeMaintenanceSnapshot = {
  policyToken: string
  contextToken?: string
  permittedPageSlugs?: string[]
  enabledSince: number
  pages: AnalysisWikiPage[]
  sources: WikiSuggestionSource[]
}

type KnowledgeMaintenanceDependencies = {
  statePath: string
  snapshot: () => Promise<KnowledgeMaintenanceSnapshot | null>
  generate: (snapshot: KnowledgeMaintenanceSnapshot, signal: AbortSignal) => Promise<WikiPageUpdate[]>
  apply: (
    updates: WikiPageUpdate[],
    snapshot: KnowledgeMaintenanceSnapshot,
    isCurrent: () => Promise<boolean>
  ) => Promise<void>
  now?: () => number
}

function eligibleSnapshot(snapshot: KnowledgeMaintenanceSnapshot | null) {
  if (!snapshot) return null
  if (!Number.isFinite(snapshot.enabledSince) || !snapshot.policyToken) return null
  if (snapshot.pages.some((page) => (page.spaceId ?? 'personal') !== 'personal')) {
    throw new Error('knowledge-maintenance-private-scope-required')
  }
  return {
    ...snapshot,
    sources: snapshot.sources.filter((source) => source.observedAt >= snapshot.enabledSince),
  }
}

function fingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function policyEpoch(snapshot: KnowledgeMaintenanceSnapshot) {
  return fingerprint([KNOWLEDGE_MAINTENANCE_VERSION, snapshot.policyToken, snapshot.enabledSince])
}

function sourceFingerprint(source: WikiSuggestionSource) {
  return fingerprint([
    source.id,
    source.observedAt,
    source.kind,
    source.role,
    source.provider,
    source.project,
    source.documentSourceId,
    source.eventId,
    source.partIndex,
    source.partCount,
    source.text,
  ])
}

function snapshotKey(snapshot: KnowledgeMaintenanceSnapshot) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: KNOWLEDGE_MAINTENANCE_VERSION,
        policyToken: snapshot.policyToken,
        enabledSince: snapshot.enabledSince,
        contextToken: snapshot.contextToken,
        permittedPageSlugs: snapshot.permittedPageSlugs ? [...snapshot.permittedPageSlugs].sort() : undefined,
        pages: snapshot.pages
          .map((page) => [page.slug, page.revision ?? '', page.title, page.content])
          .sort((first, second) => String(first[0]).localeCompare(String(second[0]))),
        sources: snapshot.sources
          .map((source) => [source.id, sourceFingerprint(source)])
          .sort((first, second) => String(first[0]).localeCompare(String(second[0]))),
      })
    )
    .digest('hex')
}

export function validateKnowledgeOrganizationTargets(updates: WikiPageUpdate[], pages: AnalysisWikiPage[]) {
  const existing = new Set(pages.map((page) => page.slug))
  const targets = new Set<string>()
  for (const update of updates) {
    if (
      !/^people\/[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/.test(update.slug) ||
      update.suggestedSpaceId !== 'personal' ||
      existing.has(update.slug) ||
      targets.has(update.slug) ||
      update.changeType !== 'created' ||
      !update.content?.trim() ||
      (isPrivateSelfProfilePage(update) && pages.some(isPrivateSelfProfilePage))
    ) {
      throw new Error('knowledge-maintenance-invalid-target')
    }
    targets.add(update.slug)
  }
}

export function knowledgeOrganizationEvidencePermitted(
  evidence: WikiSuggestionEvidence,
  sources: WikiSuggestionSource[]
) {
  const source = sources.find((candidate) => candidate.id === evidence.sourceId)
  return Boolean(
    source &&
      evidence.observedAt === source.observedAt &&
      evidence.kind === source.kind &&
      evidence.provider === source.provider &&
      evidence.project === source.project &&
      evidence.role === source.role &&
      evidence.documentSourceId === source.documentSourceId &&
      evidence.eventId === source.eventId &&
      evidence.partIndex === source.partIndex &&
      evidence.partCount === source.partCount &&
      evidence.quote.trim() &&
      source.text.includes(evidence.quote) &&
      (evidence.quote.trim().length >= 24 ||
        (evidence.quote.trim() === source.text.trim() && (source.partCount ?? 1) <= 1))
  )
}

export function knowledgeOrganizationFeedbackPermitted(
  proposal: { evidence?: WikiSuggestionEvidence[] },
  sources: WikiSuggestionSource[]
) {
  return Boolean(
    proposal.evidence?.length &&
      proposal.evidence.every((evidence) => knowledgeOrganizationEvidencePermitted(evidence, sources))
  )
}

export function validateKnowledgeOrganizationUpdates(
  updates: WikiPageUpdate[],
  snapshot: Pick<KnowledgeMaintenanceSnapshot, 'pages' | 'sources'>
) {
  validateKnowledgeOrganizationTargets(updates, snapshot.pages)
  for (const update of updates) {
    if (
      !update.evidence?.length ||
      update.evidence.some((evidence) => !knowledgeOrganizationEvidencePermitted(evidence, snapshot.sources))
    ) {
      throw new Error('knowledge-maintenance-original-evidence-required')
    }
  }
}

export function createKnowledgeMaintenance(dependencies: KnowledgeMaintenanceDependencies) {
  let pending: Promise<{ status: string; updateCount: number }> | null = null
  let stopped = false
  let cancellation: AbortController | null = null

  type SourceFailure = { attempts: number; retryAt: number }
  function readCoverage() {
    try {
      const state = JSON.parse(readFileSync(dependencies.statePath, 'utf8')) as {
        schemaVersion?: unknown
        version?: unknown
        coveredSources?: unknown
        failures?: unknown
      }
      if (
        (state.schemaVersion === 2 || state.schemaVersion === 3) &&
        state.version === KNOWLEDGE_MAINTENANCE_VERSION &&
        Array.isArray(state.coveredSources) &&
        state.coveredSources.every((key) => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key))
      ) {
        const failures = new Map<string, SourceFailure>()
        if (state.schemaVersion === 3 && state.failures && typeof state.failures === 'object') {
          for (const [key, value] of Object.entries(state.failures)) {
            if (!/^[a-f0-9]{64}$/.test(key) || !value || typeof value !== 'object') continue
            if (!('attempts' in value) || !('retryAt' in value)) continue
            if (!Number.isInteger(value.attempts) || (value.attempts as number) < 1 || !Number.isFinite(value.retryAt))
              continue
            failures.set(key, { attempts: value.attempts as number, retryAt: value.retryAt as number })
          }
        }
        return { covered: new Set<string>(state.coveredSources), failures }
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return { covered: new Set<string>(), failures: new Map<string, SourceFailure>() }
  }

  function writeCoverage(covered: Set<string>, failures: Map<string, SourceFailure>) {
    const temporary = `${dependencies.statePath}.${randomUUID()}.tmp`
    mkdirSync(dirname(dependencies.statePath), { recursive: true, mode: 0o700 })
    try {
      writeFileSync(
        temporary,
        JSON.stringify({
          schemaVersion: 3,
          version: KNOWLEDGE_MAINTENANCE_VERSION,
          coveredSources: [...covered].sort(),
          failures: Object.fromEntries(failures),
          completedAt: dependencies.now?.() ?? Date.now(),
        }),
        { encoding: 'utf8', mode: 0o600 }
      )
      renameSync(temporary, dependencies.statePath)
    } finally {
      rmSync(temporary, { force: true })
    }
  }

  async function run(signal: AbortSignal) {
    if (stopped) return { status: 'disabled', updateCount: 0 }
    const initial = eligibleSnapshot(await dependencies.snapshot())
    if (!initial || stopped) return { status: 'disabled', updateCount: 0 }
    if (!initial.sources.length) return { status: 'empty', updateCount: 0 }
    const epoch = policyEpoch(initial)
    const { covered, failures } = readCoverage()
    const uncovered = initial.sources
      .filter((source) => !covered.has(sourceFingerprint(source)))
      .sort((first, second) => first.observedAt - second.observedAt || first.id.localeCompare(second.id))
    if (!uncovered.length) return { status: 'covered', updateCount: 0 }
    const selected = uncovered
      .filter(
        (source) => (failures.get(sourceFingerprint(source))?.retryAt ?? 0) <= (dependencies.now?.() ?? Date.now())
      )
      .slice(0, MAX_SOURCES_PER_RUN)
    let updateCount = 0
    let firstError: unknown
    for (const source of selected) {
      const snapshot = eligibleSnapshot(await dependencies.snapshot())
      if (!snapshot || stopped || policyEpoch(snapshot) !== epoch) return { status: 'invalidated', updateCount }
      const sourceKey = sourceFingerprint(source)
      if (!snapshot.sources.some((candidate) => sourceFingerprint(candidate) === sourceKey)) continue
      const key = snapshotKey(snapshot)
      const isCurrent = async () => {
        if (stopped) return false
        const current = eligibleSnapshot(await dependencies.snapshot())
        return !stopped && current !== null && snapshotKey(current) === key
      }
      const batch = { ...snapshot, sources: [source] }
      try {
        if (source.text.length > MAX_SOURCE_CHARACTERS) throw new Error('knowledge-maintenance-source-too-large')
        // Withheld page bodies never reach generation; all identities remain
        // local for collision checks and the writer's revision protection.
        const generationBatch = {
          ...batch,
          pages: snapshot.permittedPageSlugs
            ? snapshot.pages.filter((page) => snapshot.permittedPageSlugs?.includes(page.slug))
            : snapshot.pages,
        }
        const updates = await dependencies.generate(generationBatch, signal)
        validateKnowledgeOrganizationUpdates(updates, batch)
        if (!(await isCurrent())) return { status: 'invalidated', updateCount }
        if (updates.length) await dependencies.apply(updates, batch, isCurrent)
        if (stopped) return { status: 'invalidated', updateCount }
        covered.add(sourceKey)
        failures.delete(sourceKey)
        writeCoverage(covered, failures)
        updateCount += updates.length
      } catch (error) {
        if (!(await isCurrent())) return { status: 'invalidated', updateCount }
        const attempts = (failures.get(sourceKey)?.attempts ?? 0) + 1
        failures.set(sourceKey, {
          attempts,
          retryAt:
            (dependencies.now?.() ?? Date.now()) + Math.min(24 * 60 * 60_000, 60_000 * 2 ** Math.min(attempts - 1, 11)),
        })
        writeCoverage(covered, failures)
        firstError ??= error
      }
    }
    if (firstError) throw firstError
    return { status: selected.length ? 'applied' : 'deferred', updateCount }
  }

  return {
    stop() {
      stopped = true
      cancellation?.abort()
    },
    run() {
      if (!pending) {
        cancellation = new AbortController()
        pending = run(cancellation.signal).finally(() => {
          pending = null
          cancellation = null
        })
      }
      return pending
    },
  }
}
