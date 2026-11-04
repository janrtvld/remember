import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import type {
  CreateWikiPageInput,
  DailyReviewWikiPage,
  DailyReviewWikiPageUpdate,
  Day,
  DeleteWikiPageInput,
  RestoreWikiPageRevisionInput,
  SaveWikiPageInput,
  WikiChangeLogEntry,
  WikiPageHistory,
  WikiRevisionActor,
  WikiRevisionOperation,
} from '@remember/shared'
import { wikiMutationDayId } from '../wikiDayAttribution'
import {
  abortWikiPageRevision,
  beginWikiPageRevision,
  commitWikiPageRevision,
  getWikiPageHistory,
  getWikiPageRevision,
  initializeWikiHistoryStore,
  moveWikiPageHistories,
  reconcilePendingWikiPageRevision,
  recordWikiPageRevision,
} from '../wikiHistoryStore'
import { mergeWikiDocuments } from '../wikiMerge'
import { orderWikiProjectPagesForDeletion } from '../wikiProjectRouting'
import { reconcileWikiPageUpdates, type WikiReconcileNote } from './wikiReconcile'
import { comparableWikiContent } from './wikiSuggestionPolicy'

let personalDirectory: string | null = null
let knowledgeUserDataDirectory: string | null = null

const REMEMBER_MANAGED_START = '<!-- remember-managed:start -->'
const REMEMBER_MANAGED_END = '<!-- remember-managed:end -->'
const REMEMBER_SOURCE_PATTERN = /<!-- remember-source:([^>\n]+) -->/g
const REMEMBER_RESERVED_PATTERN = /<!--[ \t]*remember-(?:managed:(?:start|end)|source:[^>\n]*)[ \t]*-->/g
const REMEMBER_METADATA_PATTERN = /<!--[ \t]*remember-(managed:(start|end)|source:[^>\n]*)[ \t]*-->/g
const LEGACY_GENERATED_SECTION_PATTERN =
  /(^|\n)(## \d{4}-\d{2}-\d{2} · (?:Remember|Daily Review|Dagreview)\n[\s\S]*?)(?=\n## |\s*$)/g

export function initializeKnowledgeStore(userDataDirectory: string) {
  knowledgeUserDataDirectory = userDataDirectory
  personalDirectory = join(userDataDirectory, 'daily-review', 'wiki')
  initializeWikiHistoryStore(userDataDirectory)
}

export function personalWikiDirectory() {
  if (!personalDirectory) throw new Error('knowledge-store-not-initialized')
  return personalDirectory
}

function writeAtomic(path: string, content: string) {
  const temporaryPath = `${path}.tmp`
  writeFileSync(temporaryPath, content)
  renameSync(temporaryPath, path)
}

function pagePath(directory: string, slug: string) {
  return join(directory, `${slug}.md`)
}

function historySpaceId(directory: string) {
  if (!knowledgeUserDataDirectory) throw new Error('knowledge-store-not-initialized')
  if (directory === personalWikiDirectory()) return 'personal'
  const spaceRoot = join(knowledgeUserDataDirectory, 'daily-review', 'wiki-spaces')
  const segments = relative(spaceRoot, directory).split(sep)
  if (segments.length === 2 && segments[0] && segments[1] === 'wiki' && !segments[0].startsWith('.')) {
    return segments[0]
  }
  return `directory-${createHash('sha256').update(directory).digest('hex').slice(0, 16)}`
}

type WikiMutation = {
  actor: WikiRevisionActor
  operation?: WikiRevisionOperation
  sourceId?: string | null
  summary?: string | null
  createdAt?: number
  evidence?: DailyReviewWikiPageUpdate['evidence']
}

type WikiDeleteGuard = Pick<DeleteWikiPageInput, 'expectedRevision' | 'onlyIfLeaf'>

function safeTitle(title: string) {
  const value = title.replace(/\s+/g, ' ').trim()
  if (!value || value.length > 120 || /[\r\n]/.test(title)) throw new Error('invalid-wiki-title')
  return value
}

function safeSlug(slug: string) {
  if (!/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?(?:\/[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?)*$/.test(slug)) {
    throw new Error('invalid-wiki-slug')
  }
  return slug
}

function slugFromTitle(title: string) {
  const slug = title
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('nl-NL')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug) throw new Error('invalid-wiki-title')
  return slug
}

function availablePageSlug(directory: string, category: string, title: string, parentSlug?: string) {
  const titleSlug = slugFromTitle(title)
  const baseSlug = parentSlug ? `${parentSlug}/${titleSlug}` : `${category}/${titleSlug}`
  let slug = baseSlug
  let suffix = 2
  while (existsSync(pagePath(directory, slug))) {
    slug = `${baseSlug}-${suffix}`
    suffix += 1
  }
  return safeSlug(slug)
}

function markdownFiles(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return markdownFiles(path)
    return entry.isFile() && entry.name.endsWith('.md') ? [path] : []
  })
}

function pageSlug(directory: string, path: string) {
  return relative(directory, path).split(sep).join('/').slice(0, -3)
}

function pageTitle(content: string, fallback: string) {
  return /^# (.+)$/m.exec(content)?.[1]?.trim() || fallback
}

function pageBody(content: string) {
  return content.replace(/^# .+\r?\n+/, '').trim()
}

function pageExcerpt(content: string) {
  const plainText = pageBody(content)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^_(?:Source|Bron):.*$/gm, '')
    .replace(/^## \d{4}-\d{2}-\d{2} · (?:Daily Review|Dagreview)$/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return plainText.length > 180 ? `${plainText.slice(0, 177).trimEnd()}…` : plainText
}

function recordCurrentPage(directory: string, slug: string, content: string) {
  if (slug === 'index' || slug === 'log') return
  const spaceId = historySpaceId(directory)
  const title = pageTitle(content, slug.split('/').at(-1) ?? slug)
  const body = pageBody(content)
  if (reconcilePendingWikiPageRevision(spaceId, slug, title, body)) return
  const history = getWikiPageHistory(spaceId, slug)
  recordWikiPageRevision({
    spaceId,
    slug,
    title,
    content: body,
    actor: history ? 'external' : 'system',
    operation: history ? 'updated' : 'created',
    sourceId: history ? 'recovery://unattributed-file-change' : 'migration://wiki-history',
    summary: history
      ? 'Recovered a file change whose writer could not be identified.'
      : 'Imported existing page history.',
  })
}

function writePageWithHistory(directory: string, slug: string, title: string, content: string, mutation: WikiMutation) {
  const path = pagePath(directory, slug)
  const existed = existsSync(path)
  if (existed) recordCurrentPage(directory, slug, readFileSync(path, 'utf8'))
  const normalized = content.replace(/\r\n/g, '\n').trim()
  const revision = beginWikiPageRevision({
    spaceId: historySpaceId(directory),
    slug,
    title,
    content: normalized,
    actor: mutation.actor,
    operation: mutation.operation ?? (existed ? 'updated' : 'created'),
    sourceId: mutation.sourceId,
    summary: mutation.summary,
    createdAt: mutation.createdAt,
    evidence: mutation.evidence,
  })
  try {
    writeAtomic(path, `# ${title}\n${normalized ? `\n${normalized}\n` : '\n'}`)
    if (revision.pending) commitWikiPageRevision(revision.revisionId)
  } catch (error) {
    if (revision.pending) abortWikiPageRevision(revision.revisionId)
    throw error
  }
}

function deletePageWithHistory(directory: string, slug: string, mutation: WikiMutation) {
  const path = pagePath(directory, slug)
  const current = readFileSync(path, 'utf8')
  recordCurrentPage(directory, slug, current)
  const revision = beginWikiPageRevision({
    spaceId: historySpaceId(directory),
    slug,
    title: pageTitle(current, slug.split('/').at(-1) ?? slug),
    content: pageBody(current),
    actor: mutation.actor,
    operation: 'deleted',
    sourceId: mutation.sourceId,
    summary: mutation.summary,
    createdAt: mutation.createdAt,
  })
  try {
    rmSync(path)
    if (revision.pending) commitWikiPageRevision(revision.revisionId)
  } catch (error) {
    if (revision.pending) abortWikiPageRevision(revision.revisionId)
    throw error
  }
}

export function listKnowledgePagesAt(directory: string): DailyReviewWikiPage[] {
  if (!existsSync(directory)) return []

  return markdownFiles(directory)
    .flatMap((path) => {
      try {
        const slug = pageSlug(directory, path)
        const content = readFileSync(path, 'utf8')
        recordCurrentPage(directory, slug, content)
        const history = getWikiPageHistory(historySpaceId(directory), slug)
        return [
          {
            slug,
            title: pageTitle(content, slug.split('/').at(-1) ?? slug),
            content: pageBody(content),
            excerpt: pageExcerpt(content),
            updatedAt: statSync(path).mtimeMs,
            sourceCount: rememberSourceIds(content).length,
            revision: history?.headRevisionId ?? undefined,
          },
        ]
      } catch (error) {
        console.warn(`[daily-review] Could not read wiki page ${path}`, error)
        return []
      }
    })
    .sort((first, second) => {
      const firstSpecial = first.slug === 'index' ? 0 : first.slug === 'log' ? 1 : 2
      const secondSpecial = second.slug === 'index' ? 0 : second.slug === 'log' ? 1 : 2
      return firstSpecial - secondSpecial || first.slug.localeCompare(second.slug)
    })
}

export function listKnowledgePages(): DailyReviewWikiPage[] {
  return listKnowledgePagesAt(personalWikiDirectory())
}

function wikiChangeSource(sourceId: string): WikiChangeLogEntry['source'] {
  if (/^daily-review:\/\/[^/]+\/timeline\//.test(sourceId)) return 'timeline'
  if (sourceId.startsWith('daily-review://')) return 'day'
  if (sourceId.startsWith('agent-import://')) return 'import'
  return 'other'
}

function fallbackPageTitle(slug: string) {
  const segment = slug.split('/').at(-1) ?? slug
  return segment.replace(/-/g, ' ').replace(/^./, (character) => character.toLocaleUpperCase('nl-NL'))
}

export function listPersonalWikiChanges(days: Pick<Day, 'id' | 'startedAt'>[] = []): WikiChangeLogEntry[] {
  const directory = personalWikiDirectory()
  const path = join(directory, 'log.md')
  if (!existsSync(path)) return []

  const pageTitles = new Map(listKnowledgePagesAt(directory).map((page) => [page.slug, page.title]))
  return readFileSync(path, 'utf8')
    .split(/(?=^## \[)/m)
    .flatMap((block, index) => {
      const header = /^## \[([^\]]+)] (?:verwerkt|verwijderd) \| [^\n]+/m.exec(block)
      const sourceId = /_Bron: ([^\n]+)_/.exec(block)?.[1]?.trim()
      const timestamp = header ? Date.parse(header[1]) : Number.NaN
      if (!header || !sourceId || !Number.isFinite(timestamp)) return []

      const changes = [...block.matchAll(/^- (aangemaakt|bijgewerkt|bron verwijderd uit): (.+)$/gm)].map((match) => {
        const slug = match[2].trim()
        return {
          slug,
          title: pageTitles.get(slug) ?? fallbackPageTitle(slug),
          type:
            match[1] === 'aangemaakt'
              ? ('created' as const)
              : match[1] === 'bijgewerkt'
                ? ('updated' as const)
                : ('removed' as const),
        }
      })
      if (changes.length === 0) return []

      return [
        {
          id: `${timestamp}:${sourceId}:${index}`,
          timestamp,
          sourceId,
          source: wikiChangeSource(sourceId),
          dayId: wikiMutationDayId(sourceId, timestamp, days),
          changes,
        },
      ]
    })
    .sort((first, second) => second.timestamp - first.timestamp)
}

export function createKnowledgePageAt(
  directory: string,
  input: CreateWikiPageInput,
  mutation: WikiMutation = { actor: 'user', sourceId: 'editor' }
) {
  const title = safeTitle(input.title)
  safeSlug(input.category)
  const parentSlug = input.parentSlug ? safeSlug(input.parentSlug) : undefined
  if (parentSlug) {
    if (!parentSlug.startsWith(`${input.category}/`)) throw new Error('invalid-wiki-parent')
    if (!existsSync(pagePath(directory, parentSlug))) throw new Error('wiki-parent-not-found')
  }
  const slug = input.slug ? safeSlug(input.slug) : availablePageSlug(directory, input.category, title, parentSlug)
  if (slug === 'index' || slug === 'log') throw new Error('protected-wiki-page')
  const path = pagePath(directory, slug)
  if (existsSync(path)) return listKnowledgePagesAt(directory)
  if (input.contribution)
    mutation = {
      actor: 'external',
      sourceId: `client:${input.contribution.client}`,
      summary: input.contribution.summary,
    }

  mkdirSync(dirname(path), { recursive: true })
  writePageWithHistory(directory, slug, title, input.content ?? '', { ...mutation, operation: 'created' })
  writeIndex(directory)
  return listKnowledgePagesAt(directory)
}

export function proposedKnowledgePageSlugAt(directory: string, input: CreateWikiPageInput) {
  const title = safeTitle(input.title)
  safeSlug(input.category)
  const parentSlug = input.parentSlug ? safeSlug(input.parentSlug) : undefined
  if (parentSlug) {
    if (!parentSlug.startsWith(`${input.category}/`)) throw new Error('invalid-wiki-parent')
    if (!existsSync(pagePath(directory, parentSlug))) throw new Error('wiki-parent-not-found')
  }
  return availablePageSlug(directory, input.category, title, parentSlug)
}

export function createKnowledgePage(input: CreateWikiPageInput) {
  return createKnowledgePageAt(personalWikiDirectory(), input)
}

export function saveKnowledgePageAt(
  directory: string,
  input: SaveWikiPageInput,
  mutation: WikiMutation = { actor: 'user', sourceId: 'editor' }
) {
  const slug = safeSlug(input.slug)
  if (slug === 'index' || slug === 'log') throw new Error('protected-wiki-page')
  const path = pagePath(directory, slug)
  if (!existsSync(path)) throw new Error('wiki-page-not-found')

  let title = safeTitle(input.title)
  const current = readFileSync(path, 'utf8')
  if (!input.expectedRevision) throw new Error('wiki-revision-required')
  recordCurrentPage(directory, slug, current)
  const history = getWikiPageHistory(historySpaceId(directory), slug)
  if (!history?.headRevisionId) throw new Error('wiki-page-history-not-found')
  let content = preserveManagedWikiMetadata(current, input.content)
  if (input.contribution)
    mutation = {
      actor: 'external',
      sourceId: `client:${input.contribution.client}`,
      summary: input.contribution.summary,
    }
  if (input.expectedRevision !== history.headRevisionId) {
    if (input.strictRevision) throw new Error('wiki-page-conflict')
    const base = getWikiPageRevision(historySpaceId(directory), slug, input.expectedRevision)
    if (!base) throw new Error('wiki-page-conflict')
    const merged = mergeWikiDocuments(
      { title: base.title, content: base.content },
      { title, content },
      {
        title: pageTitle(current, slug.split('/').at(-1) ?? slug),
        content: pageBody(current),
      }
    )
    if (merged.conflicts.length > 0) throw new Error('wiki-page-conflict')
    title = merged.document.title
    content = merged.document.content
  }
  writePageWithHistory(directory, slug, title, content, mutation)
  writeIndex(directory)
  return listKnowledgePagesAt(directory)
}

export function saveKnowledgePage(input: SaveWikiPageInput) {
  return saveKnowledgePageAt(personalWikiDirectory(), input)
}

export function upsertKnowledgePageAt(
  directory: string,
  input: Pick<SaveWikiPageInput, 'slug' | 'title' | 'content'>,
  mutation: WikiMutation = { actor: 'system', sourceId: 'wiki-write' }
) {
  const slug = safeSlug(input.slug)
  if (slug === 'index' || slug === 'log') throw new Error('protected-wiki-page')
  const title = safeTitle(input.title)
  const content = input.content.replace(/\r\n/g, '\n').trim()
  const path = pagePath(directory, slug)
  mkdirSync(dirname(path), { recursive: true })
  writePageWithHistory(directory, slug, title, content, mutation)
  return listKnowledgePagesAt(directory)
}

export function deleteKnowledgePageTree(slugValue: string, guard: WikiDeleteGuard = {}) {
  return deleteKnowledgePageTreeAt(personalWikiDirectory(), slugValue, undefined, guard)
}

export function deleteKnowledgePageTreeAt(
  directory: string,
  slugValue: string,
  mutation: WikiMutation = { actor: 'user', sourceId: 'editor' },
  guard: WikiDeleteGuard = {}
) {
  const slug = safeSlug(slugValue)
  if (slug === 'index' || slug === 'log') throw new Error('protected-wiki-page')
  assertKnowledgePageDeletion(directory, slug, guard)
  const paths = markdownFiles(directory).filter((path) => {
    const candidate = pageSlug(directory, path)
    return candidate === slug || candidate.startsWith(`${slug}/`)
  })
  if (!paths.length) throw new Error('wiki-page-not-found')
  const pages = paths.map((path) => ({ slug: pageSlug(directory, path) }))
  for (const page of orderWikiProjectPagesForDeletion(pages)) {
    deletePageWithHistory(directory, page.slug, mutation)
  }
  writeIndex(directory)
  return listKnowledgePagesAt(directory)
}

export function moveKnowledgePageTreeAt(
  sourceDirectory: string,
  destinationDirectory: string,
  slugValue: string,
  options: { replaceIdenticalDestination?: boolean } = {}
) {
  const slug = safeSlug(slugValue)
  const pages = listKnowledgePagesAt(sourceDirectory).filter(
    (page) => page.slug === slug || page.slug.startsWith(`${slug}/`)
  )
  if (!pages.some((page) => page.slug === slug)) throw new Error('wiki-project-not-found')
  const destinationPages = new Map(listKnowledgePagesAt(destinationDirectory).map((page) => [page.slug, page]))
  for (const page of pages) {
    const destination = destinationPages.get(page.slug)
    if (
      destination &&
      (!options.replaceIdenticalDestination || destination.title !== page.title || destination.content !== page.content)
    ) {
      throw new Error('wiki-project-move-conflict')
    }
  }

  const moved: Array<{ source: string; destination: string }> = []
  const replaced: Array<{ destination: string; backup: string }> = []
  try {
    for (const page of pages) {
      const source = pagePath(sourceDirectory, page.slug)
      const destination = pagePath(destinationDirectory, page.slug)
      mkdirSync(dirname(destination), { recursive: true })
      if (existsSync(destination)) {
        const backup = `${destination}.remember-move-${randomUUID()}`
        renameSync(destination, backup)
        replaced.push({ destination, backup })
      }
      renameSync(source, destination)
      moved.push({ source, destination })
    }
    moveWikiPageHistories(
      historySpaceId(sourceDirectory),
      historySpaceId(destinationDirectory),
      pages.map((page) => page.slug),
      options
    )
  } catch (error) {
    for (const page of moved.reverse()) {
      mkdirSync(dirname(page.source), { recursive: true })
      renameSync(page.destination, page.source)
    }
    for (const page of replaced.reverse()) renameSync(page.backup, page.destination)
    throw error
  }
  for (const page of replaced) rmSync(page.backup)
  writeIndex(sourceDirectory)
  writeIndex(destinationDirectory)
  return listKnowledgePagesAt(destinationDirectory)
}

function assertKnowledgePageDeletion(directory: string, slug: string, guard: WikiDeleteGuard) {
  if (guard.expectedRevision !== undefined) {
    const path = pagePath(directory, slug)
    if (!existsSync(path)) throw new Error('wiki-page-not-found')
    recordCurrentPage(directory, slug, readFileSync(path, 'utf8'))
    if (getWikiPageHistory(historySpaceId(directory), slug)?.headRevisionId !== guard.expectedRevision) {
      throw new Error('wiki-page-conflict')
    }
  }
  if (guard.onlyIfLeaf && markdownFiles(directory).some((path) => pageSlug(directory, path).startsWith(`${slug}/`))) {
    throw new Error('wiki-page-has-children')
  }
}

export function deleteKnowledgePageAt(
  directory: string,
  slugValue: string,
  mutation: WikiMutation = { actor: 'user', sourceId: 'editor' },
  guard: WikiDeleteGuard = {}
) {
  const slug = safeSlug(slugValue)
  if (slug === 'index' || slug === 'log') throw new Error('protected-wiki-page')
  const path = pagePath(directory, slug)
  if (!existsSync(path)) throw new Error('wiki-page-not-found')
  assertKnowledgePageDeletion(directory, slug, guard)

  deletePageWithHistory(directory, slug, mutation)
  writeIndex(directory)
  return listKnowledgePagesAt(directory)
}

export function deleteKnowledgePage(slugValue: string, guard: WikiDeleteGuard = {}) {
  return deleteKnowledgePageAt(personalWikiDirectory(), slugValue, undefined, guard)
}

function rememberSourceIds(content: string) {
  const sources = new Set<string>()
  for (const match of content.matchAll(REMEMBER_SOURCE_PATTERN)) {
    if (match[1]) sources.add(match[1].trim())
  }
  return [...sources]
}

function withoutLegacyGeneratedSections(content: string) {
  return content.replace(LEGACY_GENERATED_SECTION_PATTERN, (section, prefix: string, body: string) =>
    /<!-- remember-source:[^>\n]+ -->/.test(body) ? prefix : section
  )
}

function withoutRememberManagedRegions(content: string) {
  let cursor = 0
  let managedDepth = 0
  let result = ''
  let invalid = false

  for (const match of content.matchAll(REMEMBER_METADATA_PATTERN)) {
    const index = match.index ?? cursor
    if (managedDepth === 0) result += content.slice(cursor, index)
    if (match[2] === 'start') managedDepth += 1
    else if (match[2] === 'end') {
      if (managedDepth === 0) invalid = true
      else managedDepth -= 1
    }
    cursor = index + match[0].length
  }
  if (invalid || managedDepth !== 0) return content
  if (managedDepth === 0) result += content.slice(cursor)
  return result
}

function safeManagedContent(content: string) {
  return content
    .replace(REMEMBER_RESERVED_PATTERN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function cleanEditorContent(content: string) {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/(?:&nbsp;|\u00a0)/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Rich-text editors intentionally hide HTML comments. Reattach Remember's
 * ownership markers and source ids so a human edit cannot turn managed memory
 * into an unrelated manual page on the next refresh.
 */
export function preserveManagedWikiMetadata(current: string, editedContent: string) {
  const edited = cleanEditorContent(editedContent).replace(REMEMBER_RESERVED_PATTERN, '').trim()
  const managed = currentManagedContent(current)
  const sourceIds = rememberSourceIds(current)
  if (managed === null && sourceIds.length === 0) return edited

  const currentBody = pageBody(current)
  const managedRegion =
    /<!--[ \t]*remember-managed:start[ \t]*-->\n?([\s\S]*?)\n?<!--[ \t]*remember-managed:end[ \t]*-->/.exec(currentBody)
  if (!managedRegion) return edited

  const before = cleanEditorContent(currentBody.slice(0, managedRegion.index).replace(REMEMBER_RESERVED_PATTERN, ''))
  const after = cleanEditorContent(
    currentBody.slice(managedRegion.index + managedRegion[0].length).replace(REMEMBER_RESERVED_PATTERN, '')
  )
  let nextManaged = edited
  if (before && edited.startsWith(before)) nextManaged = edited.slice(before.length).trim()
  if (after && nextManaged.endsWith(after)) nextManaged = nextManaged.slice(0, -after.length).trim()

  return [
    before,
    `${REMEMBER_MANAGED_START}\n${nextManaged}\n${REMEMBER_MANAGED_END}`,
    after,
    ...sourceIds.map((sourceId) => `<!-- remember-source:${sourceId} -->`),
  ]
    .filter(Boolean)
    .join('\n\n')
}

function currentManagedContent(content: string) {
  const match = /<!-- remember-managed:start -->\n?([\s\S]*?)\n?<!-- remember-managed:end -->/.exec(content)
  return match?.[1]?.trim() ?? null
}

function humanAuthoredBody(content: string) {
  return withoutRememberManagedRegions(withoutLegacyGeneratedSections(pageBody(content)))
    .replace(REMEMBER_RESERVED_PATTERN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function renderManagedKnowledgePage(current: string, title: string, content: string, sourceIds: string[]) {
  const manualContent = humanAuthoredBody(current)
  const managedContent = safeManagedContent(content)
  return [
    `# ${safeTitle(title)}`,
    manualContent,
    `${REMEMBER_MANAGED_START}\n${managedContent}\n${REMEMBER_MANAGED_END}`,
    ...sourceIds.map((sourceId) => `<!-- remember-source:${sourceId} -->`),
    '',
  ]
    .filter((section, index) => index === 0 || section !== '')
    .join('\n\n')
}

export function writeKnowledgeIndex(directory: string) {
  writeIndex(directory)
}

function writeIndex(directory: string) {
  mkdirSync(directory, { recursive: true })
  const pages = markdownFiles(directory)
    .filter((path) => !['index', 'log'].includes(pageSlug(directory, path)))
    .map((path) => {
      const slug = pageSlug(directory, path)
      const content = readFileSync(path, 'utf8')
      const title = /^# (.+)$/m.exec(content)?.[1]?.trim() || slug.split('/').at(-1) || slug
      return { slug, title, excerpt: pageExcerpt(content) }
    })
    .sort((first, second) => first.slug.localeCompare(second.slug))
  const categories = pages.reduce((groups, page) => {
    const category = page.slug.split('/')[0] || 'uncategorized'
    groups.set(category, [...(groups.get(category) ?? []), page])
    return groups
  }, new Map<string, typeof pages>())
  const lines = ['# Remember Wiki', '']
  for (const [category, categoryPages] of categories) {
    lines.push(`## ${category.charAt(0).toUpperCase()}${category.slice(1)}`, '')
    const slugs = new Set(categoryPages.map((page) => page.slug))
    const children = new Map<string | null, typeof pages>()
    for (const page of categoryPages) {
      const segments = page.slug.split('/')
      const possibleParent = segments.length > 2 ? segments.slice(0, -1).join('/') : null
      const parent = possibleParent && slugs.has(possibleParent) ? possibleParent : null
      children.set(parent, [...(children.get(parent) ?? []), page])
    }
    const appendPage = (page: (typeof pages)[number], depth: number) => {
      const summary = page.excerpt ? ` — ${page.excerpt}` : ''
      lines.push(`${'  '.repeat(depth)}- [${page.title}](./${page.slug}.md)${summary}`)
      for (const child of children.get(page.slug) ?? []) appendPage(child, depth + 1)
    }
    for (const page of children.get(null) ?? []) appendPage(page, 0)
    lines.push('')
  }
  writeAtomic(join(directory, 'index.md'), lines.join('\n'))
}

function appendLog(
  directory: string,
  operation: 'ingest' | 'delete',
  sourceId: string,
  generatedAt: number,
  updates: string[],
  sourceLabel = 'Dagreview'
) {
  const path = join(directory, 'log.md')
  if (!existsSync(path)) writeFileSync(path, '# Wikilogboek\n\n')
  const date = new Date(generatedAt).toISOString()
  const details = updates.length > 0 ? updates.map((update) => `- ${update}`).join('\n') : '- Geen paginawijzigingen'
  const operationLabel = operation === 'ingest' ? 'verwerkt' : 'verwijderd'
  appendFileSync(path, `## [${date}] ${operationLabel} | ${sourceLabel}\n\n${details}\n\n_Bron: ${sourceId}_\n\n`)
}

function reconcileNoteLogLine(note: WikiReconcileNote) {
  return note.type === 'retargeted'
    ? `herleid naar bestaande pagina: ${note.fromSlug} → ${note.toSlug}`
    : `samengevoegd: ${note.droppedSlug} → ${note.keptSlug}`
}

export function prepareManagedKnowledgeUpdatesAt(
  directory: string,
  sourceId: string,
  updates: DailyReviewWikiPageUpdate[],
  options: { allowRetargeting?: boolean } = {}
) {
  const { updates: reconciled, notes } = reconcileWikiPageUpdates(
    listKnowledgePagesAt(directory)
      .filter((page) => page.slug !== 'index' && page.slug !== 'log')
      .map(({ slug, title, content }) => ({ slug, title, content })),
    updates
  )
  if (options.allowRetargeting === false && notes.some((note) => note.type === 'retargeted')) {
    throw new Error('wiki-page-conflict')
  }
  const prepared = reconciled.flatMap((update) => {
    const path = pagePath(directory, update.slug)
    const didExist = existsSync(path)
    const current = didExist ? readFileSync(path, 'utf8').trimEnd() : `# ${update.title}\n`
    const title = safeTitle(update.title)
    const nextManagedContent = safeManagedContent(update.content?.trim() || update.summary)
    if (didExist && pageTitle(current, update.slug.split('/').at(-1) ?? update.slug) === title) {
      if (comparableWikiContent(pageBody(current)) === comparableWikiContent(nextManagedContent)) return []
    }
    const sourceIds = new Set(rememberSourceIds(current))
    sourceIds.add(sourceId)
    return [
      {
        update: { ...update, changeType: didExist ? ('updated' as const) : ('created' as const) },
        page: {
          slug: update.slug,
          title,
          content: pageBody(renderManagedKnowledgePage(current, title, nextManagedContent, [...sourceIds])),
        },
      },
    ]
  })
  return { prepared, notes }
}

export function applyManagedKnowledgeUpdatesAt(
  directory: string,
  sourceId: string,
  generatedAt: number,
  updates: DailyReviewWikiPageUpdate[],
  sourceLabel = 'Remember',
  options: { allowRetargeting?: boolean } = {}
) {
  if (updates.length === 0) return updates
  mkdirSync(directory, { recursive: true })

  const { prepared, notes } = prepareManagedKnowledgeUpdatesAt(directory, sourceId, updates, options)
  for (const { page, update } of prepared) {
    mkdirSync(dirname(pagePath(directory, page.slug)), { recursive: true })
    writePageWithHistory(directory, page.slug, page.title, page.content, {
      actor: 'remember',
      sourceId,
      summary: update.summary,
      createdAt: generatedAt,
      evidence: update.evidence,
    })
  }
  const applied = prepared.map(({ update }) => update)
  if (applied.length === 0) return []
  writeIndex(directory)
  appendLog(
    directory,
    'ingest',
    sourceId,
    generatedAt,
    [
      ...applied.map((update) => `${update.changeType === 'created' ? 'aangemaakt' : 'bijgewerkt'}: ${update.slug}`),
      ...notes.map(reconcileNoteLogLine),
    ],
    sourceLabel
  )
  return applied
}

export function applyManagedKnowledgeUpdates(
  sourceId: string,
  generatedAt: number,
  updates: DailyReviewWikiPageUpdate[],
  sourceLabel = 'Remember'
) {
  return applyManagedKnowledgeUpdatesAt(personalWikiDirectory(), sourceId, generatedAt, updates, sourceLabel)
}

export function applyKnowledgeUpdates(sessionId: string, generatedAt: number, updates: DailyReviewWikiPageUpdate[]) {
  return applyManagedKnowledgeUpdates(`daily-review://${sessionId}`, generatedAt, updates, 'Dagreview')
}

function hasSessionSource(content: string, sessionId: string) {
  const sourcePrefix = `daily-review://${sessionId}`
  return rememberSourceIds(content).some(
    (sourceId) => sourceId === sourcePrefix || sourceId.startsWith(`${sourcePrefix}/`)
  )
}

export function removeKnowledgeForSession(sessionId: string, deletedAt = Date.now()) {
  const directory = personalWikiDirectory()
  if (!existsSync(directory)) return
  const changed: string[] = []

  for (const path of markdownFiles(directory)) {
    const slug = pageSlug(directory, path)
    if (slug === 'index' || slug === 'log') continue
    const content = readFileSync(path, 'utf8')
    if (!hasSessionSource(content, sessionId)) continue
    changed.push(slug)
    const manualContent = humanAuthoredBody(content)
    if (!manualContent) {
      deletePageWithHistory(directory, slug, {
        actor: 'system',
        sourceId: `delete-source://${sessionId}`,
        createdAt: deletedAt,
      })
      continue
    }
    writePageWithHistory(directory, slug, pageTitle(content, slug.split('/').at(-1) ?? slug), manualContent, {
      actor: 'system',
      sourceId: `delete-source://${sessionId}`,
      createdAt: deletedAt,
    })
  }

  writeIndex(directory)
  appendLog(
    directory,
    'delete',
    `daily-review://${sessionId}`,
    deletedAt,
    changed.map((slug) => `bron verwijderd uit: ${slug}`)
  )
}

export function getKnowledgePageHistoryAt(directory: string, slugValue: string): WikiPageHistory {
  const slug = safeSlug(slugValue)
  const path = pagePath(directory, slug)
  if (!existsSync(path)) throw new Error('wiki-page-not-found')
  recordCurrentPage(directory, slug, readFileSync(path, 'utf8'))
  const history = getWikiPageHistory(historySpaceId(directory), slug)
  if (!history) throw new Error('wiki-page-history-not-found')
  return history
}

export function restoreKnowledgePageRevisionAt(directory: string, input: RestoreWikiPageRevisionInput) {
  const slug = safeSlug(input.slug)
  const revision = getWikiPageRevision(historySpaceId(directory), slug, input.revisionId)
  if (!revision) throw new Error('wiki-page-revision-not-found')
  return saveKnowledgePageAt(
    directory,
    {
      spaceId: input.spaceId,
      slug,
      title: revision.title,
      content: revision.content,
      expectedRevision: input.expectedRevision,
    },
    { actor: 'user', operation: 'restored', sourceId: `restore://${revision.id}` }
  )
}
