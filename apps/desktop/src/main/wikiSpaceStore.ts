import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  CreateLocalWikiSpaceInput,
  CreateWikiPageInput,
  Day,
  DeleteWikiPageInput,
  KnowledgeSuggestionActionInput,
  MoveWikiProjectInput,
  RemoveLocalWikiSpaceInput,
  ReorderWikiSpacesInput,
  RestoreWikiPageRevisionInput,
  SaveWikiPageInput,
  UpdateWikiSpaceInput,
  WikiOverview,
  WikiPage,
  WikiPageForAnalysis,
  WikiPageHistoryInput,
  WikiPageUpdate,
  WikiProjectAssignment,
  WikiSpace,
} from '@remember/shared'
import { defaultPersonalWikiSpaceName, PERSONAL_WIKI_SPACE_ID } from '@remember/shared'
import { app } from 'electron'
import {
  applyManagedKnowledgeUpdatesAt,
  createKnowledgePageAt,
  deleteKnowledgePageAt,
  deleteKnowledgePageTreeAt,
  getKnowledgePageHistoryAt,
  listKnowledgePagesAt,
  listPersonalWikiChanges,
  moveKnowledgePageTreeAt,
  personalWikiDirectory,
  prepareManagedKnowledgeUpdatesAt,
  proposedKnowledgePageSlugAt,
  restoreKnowledgePageRevisionAt,
  saveKnowledgePageAt,
  writeKnowledgeIndex,
} from './dailyReview/knowledgeStore'
import { getInterfaceLocale } from './settings'
import { assertWikiAnalysisRevisions } from './wikiContextAccess'
import { emitWikiContentChanged, invalidateWikiContext } from './wikiContextEvents'
import { attributeAgentWikiSuggestionsToDays } from './wikiDayAttribution'
import {
  createWikiProposal,
  deleteWikiSpaceData,
  getWikiPageAnalysisEditContext,
  getWikiProposal,
  isWikiEvidenceRejected,
  listWikiProposals,
  rejectWikiRevisionEvidence,
  setWikiProposalStatus,
} from './wikiHistoryStore'
import {
  hasWikiProjectNamespaceConflict,
  isWikiProjectPage,
  routeWikiProjectUpdates,
  wikiProjectUpdateRoutingMatches,
} from './wikiProjectRouting'
import { applyWikiSpaceOrder, isCompleteWikiSpaceOrder } from './wikiSpaceOrder'
import {
  isWikiSpaceColor,
  isWikiSpaceIcon,
  isWikiSpaceId,
  normalizeWikiSpaceDescription,
  normalizeWikiSpaceName,
} from './wikiSpaceValidation'

type WikiSpaceMetadata = Omit<WikiSpace, 'id'>

function defaultPersonalSpace(): WikiSpaceMetadata {
  return {
    name: defaultPersonalWikiSpaceName(getInterfaceLocale()),
    description: '',
    icon: 'lock',
    color: 'slate',
    maintenanceMode: 'auto',
  }
}

function dailyReviewDirectory() {
  return join(app.getPath('userData'), 'daily-review')
}

function privateSpacesPath() {
  return join(dailyReviewDirectory(), 'private-wiki-spaces.json')
}

function personalSpacePath() {
  return join(dailyReviewDirectory(), 'personal-wiki-space.json')
}

function spaceOrderPath() {
  return join(dailyReviewDirectory(), 'wiki-space-order.json')
}

function projectAssignmentsPath() {
  return join(dailyReviewDirectory(), 'wiki-project-assignments.json')
}

function spaceDirectory(spaceId: string) {
  if (!isWikiSpaceId(spaceId)) throw new Error('wiki-space-not-found')
  return join(dailyReviewDirectory(), 'wiki-spaces', spaceId)
}

function spaceWikiDirectory(spaceId: string) {
  return join(spaceDirectory(spaceId), 'wiki')
}

function writeAtomic(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.tmp`
  writeFileSync(temporaryPath, content, { mode: 0o600 })
  renameSync(temporaryPath, path)
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return null
  }
}

function readPrivateSpaces() {
  const parsed = readJson(privateSpacesPath())
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((value): WikiSpace[] => {
    if (!value || typeof value !== 'object') return []
    const candidate = value as Partial<WikiSpace>
    const name = normalizeWikiSpaceName(candidate.name)
    if (!isWikiSpaceId(candidate.id) || candidate.id === PERSONAL_WIKI_SPACE_ID || !name) return []
    return [
      {
        id: candidate.id,
        name,
        description: normalizeWikiSpaceDescription(candidate.description ?? '') ?? '',
        icon: isWikiSpaceIcon(candidate.icon) ? candidate.icon : 'lock',
        color: isWikiSpaceColor(candidate.color) ? candidate.color : 'slate',
        maintenanceMode: candidate.maintenanceMode === 'suggest' ? 'suggest' : 'auto',
      },
    ]
  })
}

function writePrivateSpaces(spaces: WikiSpace[]) {
  writeAtomic(privateSpacesPath(), JSON.stringify(spaces, null, 2))
}

function readSpaceOrder() {
  const parsed = readJson(spaceOrderPath())
  if (!Array.isArray(parsed)) return []
  return parsed.filter((spaceId): spaceId is string => typeof spaceId === 'string')
}

function writeSpaceOrder(spaceIds: string[]) {
  writeAtomic(spaceOrderPath(), JSON.stringify(spaceIds, null, 2))
}

function readPersonalSpace(): WikiSpaceMetadata {
  const fallback = defaultPersonalSpace()
  const parsed = readJson(personalSpacePath())
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    writePersonalSpace(fallback)
    return fallback
  }
  const candidate = parsed as Partial<WikiSpaceMetadata>
  return {
    name: normalizeWikiSpaceName(candidate.name) ?? fallback.name,
    description: normalizeWikiSpaceDescription(candidate.description ?? '') ?? fallback.description,
    icon: isWikiSpaceIcon(candidate.icon) ? candidate.icon : fallback.icon,
    color: isWikiSpaceColor(candidate.color) ? candidate.color : fallback.color,
    maintenanceMode:
      candidate.maintenanceMode === 'auto' || candidate.maintenanceMode === 'suggest'
        ? candidate.maintenanceMode
        : fallback.maintenanceMode,
  }
}

function writePersonalSpace(space: WikiSpaceMetadata) {
  writeAtomic(personalSpacePath(), JSON.stringify(space, null, 2))
}

function validProjectSlug(value: string) {
  return /^projects\/[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/.test(value)
}

function recordProjectLocation(spaceId: string, slug: string) {
  if (!validProjectSlug(slug)) return
  const remaining = readWikiProjectAssignments().filter((assignment) => assignment.projectSlug !== slug)
  writeWikiProjectAssignments(
    spaceId === PERSONAL_WIKI_SPACE_ID
      ? remaining
      : [...remaining, { projectSlug: slug, spaceId, createdAt: Date.now() }]
  )
}

export function readWikiProjectAssignments(): WikiProjectAssignment[] {
  const parsed = readJson(projectAssignmentsPath())
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((value): WikiProjectAssignment[] => {
    if (!value || typeof value !== 'object') return []
    const candidate = value as Partial<WikiProjectAssignment>
    if (
      typeof candidate.projectSlug !== 'string' ||
      !validProjectSlug(candidate.projectSlug) ||
      !isWikiSpaceId(candidate.spaceId) ||
      candidate.spaceId === PERSONAL_WIKI_SPACE_ID ||
      typeof candidate.createdAt !== 'number' ||
      !Number.isFinite(candidate.createdAt)
    )
      return []
    return [{ projectSlug: candidate.projectSlug, spaceId: candidate.spaceId, createdAt: candidate.createdAt }]
  })
}

function writeWikiProjectAssignments(assignments: WikiProjectAssignment[]) {
  writeAtomic(projectAssignmentsPath(), JSON.stringify(assignments, null, 2))
}

export function getWikiAccess(): Pick<WikiOverview, 'spaces'> {
  return {
    spaces: applyWikiSpaceOrder(
      [{ id: PERSONAL_WIKI_SPACE_ID, ...readPersonalSpace() }, ...readPrivateSpaces()],
      readSpaceOrder()
    ),
  }
}

export function getWikiOverview(days: Day[]): WikiOverview {
  const access = getWikiAccess()
  const visibleSpaceIds = new Set(access.spaces.map((space) => space.id))
  return {
    ...access,
    suggestions: attributeAgentWikiSuggestionsToDays(listWikiProposals(), days).filter((suggestion) =>
      visibleSpaceIds.has(suggestion.suggestedSpaceId)
    ),
    personalChanges: listPersonalWikiChanges(days),
    projectAssignments: readWikiProjectAssignments().filter((assignment) => visibleSpaceIds.has(assignment.spaceId)),
  }
}

export function reorderWikiSpaces(input: ReorderWikiSpacesInput, days: Day[]) {
  const spaces = getWikiOverview(days).spaces
  if (!isCompleteWikiSpaceOrder(input?.spaceIds, spaces)) throw new Error('invalid-wiki-space-order')
  writeSpaceOrder(input.spaceIds)
  emitWikiContentChanged()
  return getWikiOverview(days)
}

export function createLocalWikiSpace(input: CreateLocalWikiSpaceInput, days: Day[]) {
  const name = normalizeWikiSpaceName(input?.name)
  const description = normalizeWikiSpaceDescription(input?.description)
  if (!name || description === null) throw new Error('invalid-wiki-space-metadata')
  const space: WikiSpace = {
    id: randomUUID(),
    name,
    description,
    icon: 'lock',
    color: 'slate',
    maintenanceMode: 'auto',
  }
  mkdirSync(spaceWikiDirectory(space.id), { recursive: true })
  writeKnowledgeIndex(spaceWikiDirectory(space.id))
  writePrivateSpaces([...readPrivateSpaces(), space])
  emitWikiContentChanged()
  return getWikiOverview(days)
}

export async function updateWikiSpace(input: UpdateWikiSpaceInput, days: Day[]) {
  if (!input || typeof input !== 'object' || typeof input.spaceId !== 'string') {
    throw new Error('invalid-wiki-space-metadata')
  }
  const hasUpdate =
    input.name !== undefined ||
    input.description !== undefined ||
    input.icon !== undefined ||
    input.color !== undefined ||
    input.maintenanceMode !== undefined
  const name = input.name === undefined ? undefined : normalizeWikiSpaceName(input.name)
  const description = input.description === undefined ? undefined : normalizeWikiSpaceDescription(input.description)
  if (
    !hasUpdate ||
    (input.name !== undefined && !name) ||
    (input.description !== undefined && description === null) ||
    (input.icon !== undefined && !isWikiSpaceIcon(input.icon)) ||
    (input.color !== undefined && !isWikiSpaceColor(input.color)) ||
    (input.maintenanceMode !== undefined && input.maintenanceMode !== 'auto' && input.maintenanceMode !== 'suggest')
  ) {
    throw new Error('invalid-wiki-space-metadata')
  }

  if (input.spaceId === PERSONAL_WIKI_SPACE_ID) {
    const current = readPersonalSpace()
    writePersonalSpace({
      name: name ?? current.name,
      description: description ?? current.description,
      icon: input.icon ?? current.icon,
      color: input.color ?? current.color,
      maintenanceMode: input.maintenanceMode ?? current.maintenanceMode,
    })
    emitWikiContentChanged()
    return getWikiOverview(days)
  }

  const privateSpace = readPrivateSpaces().find((space) => space.id === input.spaceId)
  if (privateSpace) {
    const next = {
      ...privateSpace,
      name: name ?? privateSpace.name,
      description: description ?? privateSpace.description,
      icon: input.icon ?? privateSpace.icon,
      color: input.color ?? privateSpace.color,
      maintenanceMode: input.maintenanceMode ?? privateSpace.maintenanceMode,
    }
    writePrivateSpaces(readPrivateSpaces().map((space) => (space.id === privateSpace.id ? next : space)))
    emitWikiContentChanged()
    return getWikiOverview(days)
  }
  throw new Error('wiki-space-not-found')
}

export function removeLocalWikiSpace(input: RemoveLocalWikiSpaceInput, days: Day[]) {
  if (!input || typeof input.spaceId !== 'string' || input.spaceId === PERSONAL_WIKI_SPACE_ID)
    throw new Error('invalid-wiki-space-removal')
  localSpaceDirectory(input.spaceId)
  rmSync(spaceDirectory(input.spaceId), { recursive: true, force: true })
  deleteWikiSpaceData(input.spaceId)
  writePrivateSpaces(readPrivateSpaces().filter((space) => space.id !== input.spaceId))
  writeWikiProjectAssignments(readWikiProjectAssignments().filter((assignment) => assignment.spaceId !== input.spaceId))
  writeSpaceOrder(readSpaceOrder().filter((id) => id !== input.spaceId))
  invalidateWikiContext()
  emitWikiContentChanged()
  return getWikiOverview(days)
}

function privateSpace(spaceId: string) {
  return readPrivateSpaces().find((candidate) => candidate.id === spaceId) ?? null
}

function localSpaceDirectory(spaceId: string) {
  if (spaceId === PERSONAL_WIKI_SPACE_ID) return personalWikiDirectory()
  if (!privateSpace(spaceId)) throw new Error('wiki-space-not-found')
  return spaceWikiDirectory(spaceId)
}

export async function moveWikiProject(input: MoveWikiProjectInput, days: Day[]) {
  if (
    !input ||
    typeof input !== 'object' ||
    !validProjectSlug(input.projectSlug) ||
    typeof input.sourceSpaceId !== 'string' ||
    typeof input.destinationSpaceId !== 'string' ||
    input.sourceSpaceId === input.destinationSpaceId
  )
    throw new Error('invalid-wiki-project-move')

  const source = localSpaceDirectory(input.sourceSpaceId)
  const destination = localSpaceDirectory(input.destinationSpaceId)
  const pages = listKnowledgePagesAt(source).filter((page) => isWikiProjectPage(page.slug, input.projectSlug))
  if (!pages.some((page) => page.slug === input.projectSlug)) throw new Error('wiki-project-not-found')
  if (
    hasWikiProjectNamespaceConflict(
      input.projectSlug,
      listKnowledgePagesAt(destination).map((page) => page.slug)
    )
  )
    throw new Error('wiki-project-move-conflict')

  moveKnowledgePageTreeAt(source, destination, input.projectSlug)
  recordProjectLocation(input.destinationSpaceId, input.projectSlug)
  invalidateWikiContext()
  emitWikiContentChanged()
  return getWikiOverview(days)
}

export async function wikiPagesForAnalysis() {
  return getWikiAccess().spaces.flatMap((space) =>
    listKnowledgePagesAt(localSpaceDirectory(space.id)).map((page) => ({
      ...page,
      spaceId: space.id,
      spaceName: space.name,
      maintenanceMode: space.maintenanceMode,
      editContext: getWikiPageAnalysisEditContext(space.id, page.slug),
      analysisReadOnlyReason: null,
    }))
  )
}

function knownWikiPageSpaceIdsBySlug() {
  const locations = new Map<string, string[]>()
  for (const space of getWikiAccess().spaces) {
    for (const page of listKnowledgePagesAt(localSpaceDirectory(space.id)))
      locations.set(page.slug, [...(locations.get(page.slug) ?? []), space.id])
  }
  return locations
}

export async function applyKnowledgeUpdatesByProject(
  sessionId: string,
  generatedAt: number,
  updates: WikiPageUpdate[],
  options?: {
    sourceId: string
    expectedPages: Pick<WikiPageForAnalysis, 'spaceId' | 'slug' | 'revision'>[]
    explicitDestinations?: boolean
    assertCurrent?: () => Promise<boolean>
  }
) {
  const sourceId = options?.sourceId ?? `daily-review://${sessionId}`
  const route = () =>
    routeWikiProjectUpdates(
      options?.explicitDestinations ? [] : readWikiProjectAssignments(),
      getWikiAccess().spaces,
      updates,
      options?.explicitDestinations ? new Map() : knownWikiPageSpaceIdsBySlug(),
      options
    )
  const initialRouting = route()
  if (options?.assertCurrent && !(await options.assertCurrent())) throw new Error('wiki-page-conflict')
  const routing = route()
  if (options && !wikiProjectUpdateRoutingMatches(initialRouting, routing)) throw new Error('wiki-page-conflict')
  const writeOptions = options ? { allowRetargeting: false } : undefined
  const pagesBySpace = new Map<string, WikiPage[]>()

  // Validate the entire batch after the last await, before any generated write.
  for (const groups of [routing.automaticBySpace, routing.proposalsBySpace]) {
    for (const [spaceId, candidates] of groups) {
      const accepted = candidates.filter((candidate) => !isWikiEvidenceRejected(spaceId, candidate.slug, candidate))
      groups.set(spaceId, accepted)
      if (!accepted.length) continue
      const directory = localSpaceDirectory(spaceId)
      const pages = listKnowledgePagesAt(directory)
      if (options) assertWikiAnalysisRevisions(spaceId, accepted, options.expectedPages, pages)
      prepareManagedKnowledgeUpdatesAt(directory, sourceId, accepted, writeOptions)
      pagesBySpace.set(spaceId, pages)
    }
  }

  const applied: WikiPageUpdate[] = []
  for (const [spaceId, candidates] of routing.automaticBySpace) {
    if (!candidates.length) continue
    applied.push(
      ...applyManagedKnowledgeUpdatesAt(
        localSpaceDirectory(spaceId),
        sourceId,
        generatedAt,
        candidates,
        'Remember',
        writeOptions
      )
    )
  }
  for (const [spaceId, candidates] of routing.proposalsBySpace) {
    if (!candidates.length) continue
    const pages = pagesBySpace.get(spaceId) ?? []
    const { prepared } = prepareManagedKnowledgeUpdatesAt(
      localSpaceDirectory(spaceId),
      sourceId,
      candidates,
      writeOptions
    )
    for (const { update } of prepared) {
      createWikiProposal({
        dayId: sessionId,
        dayStartedAt: generatedAt,
        spaceId,
        slug: update.slug,
        title: update.title,
        content: update.content?.trim() || update.summary,
        summary: update.summary,
        baseRevision: pages.find((page) => page.slug === update.slug)?.revision ?? null,
        sourceId,
        createdAt: generatedAt,
        evidence: update.evidence,
      })
    }
  }
  if (applied.length || routing.proposalsBySpace.size) emitWikiContentChanged()
  return applied
}

export async function listWikiPages(spaceId: string) {
  return listKnowledgePagesAt(localSpaceDirectory(spaceId))
}

export async function readWikiContextSnapshot(spaceId: string) {
  return { pages: listKnowledgePagesAt(localSpaceDirectory(spaceId)), checkedAt: Date.now(), state: 'fresh' as const }
}

export async function createWikiPage(input: CreateWikiPageInput) {
  const directory = localSpaceDirectory(input.spaceId)
  const previous = listKnowledgePagesAt(directory)
  const pages = createKnowledgePageAt(directory, input)
  const created = pages.find((page) => !previous.some((candidate) => candidate.slug === page.slug))
  if (created) recordProjectLocation(input.spaceId, created.slug)
  emitWikiContentChanged()
  return pages
}

export async function saveWikiPage(input: SaveWikiPageInput) {
  const pages = saveKnowledgePageAt(localSpaceDirectory(input.spaceId), input)
  emitWikiContentChanged()
  return pages
}

export async function proposeWikiPageChange(input: {
  spaceId: string
  slug?: string
  title: string
  content: string
  expectedRevision?: string
  category?: string
  parentSlug?: string
}) {
  const space = getWikiOverview([]).spaces.find((candidate) => candidate.id === input.spaceId)
  if (!space) throw new Error('wiki-space-not-found')
  if (space.maintenanceMode !== 'suggest') throw new Error('wiki-space-not-in-suggest-mode')
  const pages = await listWikiPages(input.spaceId)
  let slug: string
  let baseRevision: string | null
  if (input.slug) {
    const page = pages.find((candidate) => candidate.slug === input.slug)
    if (!page) throw new Error('wiki-page-not-found')
    if (!input.expectedRevision) throw new Error('wiki-revision-required')
    if (page.revision !== input.expectedRevision) throw new Error('wiki-page-conflict')
    slug = page.slug
    baseRevision = page.revision ?? null
  } else {
    const category = input.category ?? 'concepts'
    const directory = localSpaceDirectory(input.spaceId)
    slug = proposedKnowledgePageSlugAt(directory, {
      spaceId: input.spaceId,
      category,
      title: input.title,
      ...(input.parentSlug ? { parentSlug: input.parentSlug } : {}),
    })
    baseRevision = null
  }
  const createdAt = Date.now()
  const proposal = createWikiProposal({
    dayId: 'agent',
    dayStartedAt: createdAt,
    spaceId: input.spaceId,
    slug,
    title: input.title,
    content: input.content,
    summary: `Proposed ${pages.some((page) => page.slug === slug) ? 'an update to' : 'a new page for'} ${input.title}.`,
    baseRevision,
    sourceId: `agent://wiki-cli/${randomUUID()}`,
    createdAt,
  })
  emitWikiContentChanged()
  return proposal
}

export function getWikiPageHistoryForSpace(input: WikiPageHistoryInput) {
  if (!input || typeof input.spaceId !== 'string' || typeof input.slug !== 'string')
    throw new Error('invalid-wiki-page-history')
  return getKnowledgePageHistoryAt(localSpaceDirectory(input.spaceId), input.slug)
}

export function restoreWikiPageRevision(input: RestoreWikiPageRevisionInput) {
  if (
    !input ||
    typeof input.spaceId !== 'string' ||
    typeof input.slug !== 'string' ||
    typeof input.revisionId !== 'string' ||
    typeof input.expectedRevision !== 'string'
  )
    throw new Error('invalid-wiki-page-restore')
  const pages = restoreKnowledgePageRevisionAt(localSpaceDirectory(input.spaceId), input)
  emitWikiContentChanged()
  return pages
}

export async function undoWikiLearning(input: RestoreWikiPageRevisionInput) {
  if (
    !input ||
    typeof input.spaceId !== 'string' ||
    typeof input.slug !== 'string' ||
    typeof input.revisionId !== 'string' ||
    typeof input.expectedRevision !== 'string'
  )
    throw new Error('invalid-wiki-page-restore')
  const history = getWikiPageHistoryForSpace(input)
  const revision = history.revisions.find((candidate) => candidate.id === input.revisionId)
  if (history.headRevisionId !== input.expectedRevision || input.revisionId !== history.headRevisionId)
    throw new Error('wiki-page-conflict')
  if (revision?.actor !== 'remember' || !revision.evidence?.length)
    throw new Error('wiki-learning-evidence-unavailable')
  let pages: WikiPage[]
  if (revision.parentRevisionId) {
    pages = restoreWikiPageRevision({ ...input, revisionId: revision.parentRevisionId })
  } else {
    const current = await listWikiPages(input.spaceId)
    if (current.find((page) => page.slug === input.slug)?.revision !== input.expectedRevision)
      throw new Error('wiki-page-conflict')
    if (current.some((page) => page.slug.startsWith(`${input.slug}/`))) throw new Error('wiki-learning-has-child-pages')
    pages = await deleteWikiPage(input)
  }
  rejectWikiRevisionEvidence(input.spaceId, input.slug, revision.id)
  return pages
}

export async function deleteWikiPage(input: DeleteWikiPageInput) {
  const directory = localSpaceDirectory(input.spaceId)
  const next = validProjectSlug(input.slug)
    ? deleteKnowledgePageTreeAt(directory, input.slug, undefined, input)
    : deleteKnowledgePageAt(directory, input.slug, undefined, input)
  if (validProjectSlug(input.slug)) {
    writeWikiProjectAssignments(
      readWikiProjectAssignments().filter(
        (assignment) => assignment.spaceId !== input.spaceId || assignment.projectSlug !== input.slug
      )
    )
  }
  invalidateWikiContext()
  emitWikiContentChanged()
  return next
}

export async function applyKnowledgeSuggestion(input: KnowledgeSuggestionActionInput, days: Day[]) {
  const suggestion = getWikiProposal(input.suggestionId)
  if (!suggestion || !getWikiOverview(days).spaces.some((space) => space.id === suggestion.suggestedSpaceId))
    throw new Error('knowledge-suggestion-not-found')
  if (suggestion.status === 'applied') return getWikiOverview(days)
  if (suggestion.status !== 'pending') throw new Error('knowledge-suggestion-not-pending')
  if (input.destinationSpaceId && input.destinationSpaceId !== suggestion.suggestedSpaceId) {
    throw new Error('knowledge-suggestion-destination-mismatch')
  }

  const spaceId = suggestion.suggestedSpaceId
  if (isWikiEvidenceRejected(spaceId, suggestion.slug, suggestion)) throw new Error('knowledge-suggestion-dismissed')
  const prepareAt = (directory: string) => {
    const current = listKnowledgePagesAt(directory).find((page) => page.slug === suggestion.slug)
    if ((current?.revision ?? null) !== suggestion.baseRevision) throw new Error('knowledge-suggestion-stale')
    const update: WikiPageUpdate = {
      slug: suggestion.slug,
      title: suggestion.title,
      content: suggestion.content,
      summary: suggestion.summary,
      changeType: current ? 'updated' : 'created',
      suggestedSpaceId: null,
      evidence: suggestion.evidence,
    }
    const sourceId = suggestion.sourceId ?? suggestion.id
    const prepared = prepareManagedKnowledgeUpdatesAt(directory, sourceId, [update]).prepared
    if (prepared.some((candidate) => candidate.page.slug !== suggestion.slug)) {
      throw new Error('knowledge-suggestion-stale')
    }
    return { sourceId, update, page: prepared[0]?.page ?? null }
  }
  const applyAt = (directory: string, sourceId: string, update: WikiPageUpdate) => {
    applyManagedKnowledgeUpdatesAt(directory, sourceId, suggestion.dayStartedAt, [update], 'Remember')
    const page = listKnowledgePagesAt(directory).find((candidate) => candidate.slug === suggestion.slug)
    if (!page) throw new Error('wiki-page-not-created')
    return page
  }

  const directory = localSpaceDirectory(spaceId)
  const prepared = prepareAt(directory)
  if (prepared.page) applyAt(directory, prepared.sourceId, prepared.update)
  setWikiProposalStatus(suggestion.id, 'applied')
  emitWikiContentChanged()
  return getWikiOverview(days)
}

export function dismissKnowledgeSuggestion(input: KnowledgeSuggestionActionInput, days: Day[]) {
  const suggestion = getWikiProposal(input.suggestionId)
  if (!suggestion || !getWikiOverview(days).spaces.some((space) => space.id === suggestion.suggestedSpaceId))
    throw new Error('knowledge-suggestion-not-found')
  if (suggestion.status === 'pending') setWikiProposalStatus(suggestion.id, 'dismissed')
  emitWikiContentChanged()
  return getWikiOverview(days)
}
