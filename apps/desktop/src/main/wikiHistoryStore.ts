import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type {
  KnowledgeSuggestion,
  KnowledgeSuggestionStatus,
  WikiPageAnalysisEditContext,
  WikiPageHistory,
  WikiPageRevision,
  WikiPageUpdate,
  WikiRevisionActor,
  WikiRevisionOperation,
} from '@remember/shared'
import type { ContextSourceCheckpoint } from './contextImportChanges'
import { wikiProposalContentKey } from './dailyReview/wikiSuggestionPolicy'

type DatabaseRow = Record<string, SQLInputValue>

type RecordWikiRevisionInput = {
  spaceId: string
  slug: string
  title: string
  content: string
  actor: WikiRevisionActor
  operation: WikiRevisionOperation
  sourceId?: string | null
  summary?: string | null
  createdAt?: number
  evidence?: WikiPageUpdate['evidence']
}

let database: DatabaseSync | null = null

function requiredDatabase() {
  if (!database) throw new Error('wiki-history-store-not-initialized')
  return database
}

function text(value: SQLInputValue) {
  return typeof value === 'string' ? value : String(value ?? '')
}

function nullableText(value: SQLInputValue) {
  return value == null ? null : text(value)
}

function number(value: SQLInputValue) {
  return typeof value === 'number' ? value : Number(value)
}

function transaction<T>(operation: () => T) {
  const current = requiredDatabase()
  current.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    current.exec('COMMIT')
    return result
  } catch (error) {
    try {
      current.exec('ROLLBACK')
    } catch {
      // SQLite can roll back a failed transaction itself.
    }
    throw error
  }
}

function createSchema(current: DatabaseSync) {
  current.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS wiki_page (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      head_revision_id TEXT,
      deleted_at INTEGER,
      UNIQUE(space_id, slug)
    );

    CREATE TABLE IF NOT EXISTS wiki_page_revision (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL REFERENCES wiki_page(id) ON DELETE CASCADE,
      parent_revision_id TEXT REFERENCES wiki_page_revision(id),
      created_at INTEGER NOT NULL,
      actor TEXT NOT NULL CHECK(actor IN ('user', 'remember', 'external', 'system')),
      operation TEXT NOT NULL CHECK(operation IN ('created', 'updated', 'deleted', 'restored')),
      source_id TEXT,
      summary TEXT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'committed' CHECK(status IN ('pending', 'committed'))
    );

    CREATE INDEX IF NOT EXISTS wiki_page_revision_page_created
      ON wiki_page_revision(page_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS wiki_proposal (
      id TEXT PRIMARY KEY,
      day_id TEXT NOT NULL,
      day_started_at INTEGER NOT NULL,
      space_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      summary TEXT NOT NULL,
      base_revision TEXT,
      source_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'applied', 'dismissed', 'superseded')),
      applied_at INTEGER,
      evidence_json TEXT NOT NULL DEFAULT '[]'
    );

    CREATE INDEX IF NOT EXISTS wiki_proposal_space_slug_created
      ON wiki_proposal(space_id, slug, created_at DESC);

    CREATE TABLE IF NOT EXISTS wiki_evidence_rejection (
      revision_id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      summary TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      rejected_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS wiki_evidence_rejection_page
      ON wiki_evidence_rejection(space_id, slug, rejected_at DESC);

    CREATE TABLE IF NOT EXISTS wiki_context_source (
      source_key TEXT PRIMARY KEY,
      fingerprints_json TEXT NOT NULL,
      processed_through INTEGER NOT NULL
    );

  `)
  const revisionColumns = current.prepare('PRAGMA table_info(wiki_page_revision)').all() as DatabaseRow[]
  if (!revisionColumns.some((column) => text(column.name) === 'status')) {
    current.exec("ALTER TABLE wiki_page_revision ADD COLUMN status TEXT NOT NULL DEFAULT 'committed'")
  }
  if (!revisionColumns.some((column) => text(column.name) === 'evidence_json')) {
    current.exec("ALTER TABLE wiki_page_revision ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '[]'")
  }
  const proposalColumns = current.prepare('PRAGMA table_info(wiki_proposal)').all() as DatabaseRow[]
  if (!proposalColumns.some((column) => text(column.name) === 'evidence_json')) {
    current.exec("ALTER TABLE wiki_proposal ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '[]'")
  }
}

export function initializeWikiHistoryStore(userDataDirectory: string) {
  database?.close()
  const path = join(userDataDirectory, 'daily-review', 'wiki.sqlite')
  mkdirSync(dirname(path), { recursive: true })
  database = new DatabaseSync(path)
  createSchema(database)
}

export function closeWikiHistoryStore() {
  database?.close()
  database = null
}

export function wikiDocumentHash(title: string, content: string) {
  return createHash('sha256')
    .update(`# ${title}\n${content ? `\n${content.trim()}\n` : '\n'}`)
    .digest('hex')
}

function pageRow(spaceId: string, slug: string) {
  return requiredDatabase()
    .prepare('SELECT id, head_revision_id FROM wiki_page WHERE space_id = ? AND slug = ?')
    .get(spaceId, slug) as DatabaseRow | undefined
}

function revisionRow(revisionId: string | null) {
  if (!revisionId) return undefined
  return requiredDatabase().prepare('SELECT id, content_hash FROM wiki_page_revision WHERE id = ?').get(revisionId) as
    | DatabaseRow
    | undefined
}

export function beginWikiPageRevision(
  input: RecordWikiRevisionInput
): { revisionId: string; pending: true } | { revisionId: string | null; pending: false } {
  return transaction(() => {
    const current = requiredDatabase()
    const existingPage = pageRow(input.spaceId, input.slug)
    const pageId = existingPage ? text(existingPage.id) : randomUUID()
    if (!existingPage) {
      current
        .prepare(
          'INSERT INTO wiki_page (id, space_id, slug, head_revision_id, deleted_at) VALUES (?, ?, ?, NULL, NULL)'
        )
        .run(pageId, input.spaceId, input.slug)
    }

    const parentRevisionId = existingPage ? nullableText(existingPage.head_revision_id) : null
    const hash = wikiDocumentHash(input.title, input.content)
    const parent = revisionRow(parentRevisionId)
    if (input.operation !== 'restored' && input.operation !== 'deleted' && parent?.content_hash === hash) {
      return { revisionId: parentRevisionId, pending: false }
    }

    current.prepare("DELETE FROM wiki_page_revision WHERE page_id = ? AND status = 'pending'").run(pageId)
    const revisionId = randomUUID()
    current
      .prepare(`
        INSERT INTO wiki_page_revision (
          id, page_id, parent_revision_id, created_at, actor, operation,
          source_id, summary, title, content, content_hash, evidence_json, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
      `)
      .run(
        revisionId,
        pageId,
        parentRevisionId,
        input.createdAt ?? Date.now(),
        input.actor,
        input.operation,
        input.sourceId ?? null,
        input.summary ?? null,
        input.title,
        input.content,
        hash,
        JSON.stringify(input.evidence ?? [])
      )
    return { revisionId, pending: true }
  })
}

export function commitWikiPageRevision(revisionId: string) {
  return transaction(() => {
    const current = requiredDatabase()
    const row = current
      .prepare(
        `SELECT revision.id, revision.page_id, revision.operation, revision.created_at
         FROM wiki_page_revision revision
         WHERE revision.id = ? AND revision.status = 'pending'`
      )
      .get(revisionId) as DatabaseRow | undefined
    if (!row) return revisionId
    current.prepare("UPDATE wiki_page_revision SET status = 'committed' WHERE id = ?").run(revisionId)
    current
      .prepare('UPDATE wiki_page SET head_revision_id = ?, deleted_at = ? WHERE id = ?')
      .run(revisionId, text(row.operation) === 'deleted' ? number(row.created_at) : null, text(row.page_id))
    return revisionId
  })
}

export function abortWikiPageRevision(revisionId: string) {
  requiredDatabase().prepare("DELETE FROM wiki_page_revision WHERE id = ? AND status = 'pending'").run(revisionId)
}

export function reconcilePendingWikiPageRevision(spaceId: string, slug: string, title: string, content: string) {
  return transaction(() => {
    const current = requiredDatabase()
    const page = pageRow(spaceId, slug)
    if (!page) return false
    const hash = wikiDocumentHash(title, content)
    const pending = current
      .prepare(
        `SELECT revision.id
         FROM wiki_page_revision revision
         WHERE revision.page_id = ? AND revision.status = 'pending' AND revision.content_hash = ?
         ORDER BY revision.created_at DESC, revision.rowid DESC
         LIMIT 1`
      )
      .get(text(page.id), hash) as DatabaseRow | undefined
    current
      .prepare("DELETE FROM wiki_page_revision WHERE page_id = ? AND status = 'pending' AND content_hash != ?")
      .run(text(page.id), hash)
    if (!pending) return false
    const revisionId = text(pending.id)
    const revision = current
      .prepare('SELECT operation, created_at FROM wiki_page_revision WHERE id = ?')
      .get(revisionId) as DatabaseRow
    current.prepare("UPDATE wiki_page_revision SET status = 'committed' WHERE id = ?").run(revisionId)
    current
      .prepare('UPDATE wiki_page SET head_revision_id = ?, deleted_at = ? WHERE id = ?')
      .run(revisionId, text(revision.operation) === 'deleted' ? number(revision.created_at) : null, text(page.id))
    return true
  })
}

export function recordWikiPageRevision(input: RecordWikiRevisionInput) {
  const revision = beginWikiPageRevision(input)
  return revision.pending ? commitWikiPageRevision(revision.revisionId) : revision.revisionId
}

function presentRevision(row: DatabaseRow): WikiPageRevision {
  return {
    id: text(row.id),
    parentRevisionId: nullableText(row.parent_revision_id),
    createdAt: number(row.created_at),
    actor: text(row.actor) as WikiRevisionActor,
    operation: text(row.operation) as WikiRevisionOperation,
    sourceId: nullableText(row.source_id),
    summary: nullableText(row.summary),
    title: text(row.title),
    content: text(row.content),
    contentHash: text(row.content_hash),
    evidence: proposalEvidence(row.evidence_json),
  }
}

export function getWikiPageHistory(spaceId: string, slug: string): WikiPageHistory | null {
  const page = requiredDatabase()
    .prepare('SELECT id, head_revision_id FROM wiki_page WHERE space_id = ? AND slug = ?')
    .get(spaceId, slug) as DatabaseRow | undefined
  if (!page) return null
  const pageId = text(page.id)
  const revisions = requiredDatabase()
    .prepare(`
      SELECT id, parent_revision_id, created_at, actor, operation, source_id, summary, title, content, content_hash, evidence_json
      FROM wiki_page_revision
      WHERE page_id = ? AND status = 'committed'
      ORDER BY created_at DESC, rowid DESC
    `)
    .all(pageId) as DatabaseRow[]
  return {
    pageId,
    spaceId,
    slug,
    headRevisionId: nullableText(page.head_revision_id),
    revisions: revisions.map(presentRevision),
  }
}

export function getWikiPageRevision(spaceId: string, slug: string, revisionId: string) {
  const row = requiredDatabase()
    .prepare(`
      SELECT revision.id, revision.parent_revision_id, revision.created_at, revision.actor, revision.operation,
             revision.source_id, revision.summary, revision.title, revision.content, revision.content_hash, revision.evidence_json
      FROM wiki_page_revision revision
      JOIN wiki_page page ON page.id = revision.page_id
      WHERE page.space_id = ? AND page.slug = ? AND revision.id = ? AND revision.status = 'committed'
    `)
    .get(spaceId, slug, revisionId) as DatabaseRow | undefined
  return row ? presentRevision(row) : null
}

export function deleteWikiSpaceData(spaceId: string) {
  const current = requiredDatabase()
  current.exec('PRAGMA secure_delete = ON')
  transaction(() => {
    current
      .prepare(
        'UPDATE wiki_page_revision SET parent_revision_id = NULL WHERE page_id IN (SELECT id FROM wiki_page WHERE space_id = ?)'
      )
      .run(spaceId)
    current.prepare('DELETE FROM wiki_page WHERE space_id = ?').run(spaceId)
    current.prepare('DELETE FROM wiki_proposal WHERE space_id = ?').run(spaceId)
    current.prepare('DELETE FROM wiki_evidence_rejection WHERE space_id = ?').run(spaceId)
  })
  current.exec('PRAGMA wal_checkpoint(TRUNCATE)')
}

export function moveWikiPageHistories(
  sourceSpaceId: string,
  destinationSpaceId: string,
  slugs: string[],
  options: { replaceIdenticalDestination?: boolean } = {}
) {
  transaction(() => {
    const current = requiredDatabase()
    const destinationsToReplace = new Set<string>()
    for (const slug of slugs) {
      const source = current
        .prepare(
          `SELECT page.id, revision.content_hash
           FROM wiki_page page
           LEFT JOIN wiki_page_revision revision ON revision.id = page.head_revision_id
           WHERE page.space_id = ? AND page.slug = ?`
        )
        .get(sourceSpaceId, slug) as DatabaseRow | undefined
      const destination = current
        .prepare(
          `SELECT page.id, revision.content_hash
           FROM wiki_page page
           LEFT JOIN wiki_page_revision revision ON revision.id = page.head_revision_id
           WHERE page.space_id = ? AND page.slug = ?`
        )
        .get(destinationSpaceId, slug) as DatabaseRow | undefined
      if (!source || !destination) continue
      if (
        !options.replaceIdenticalDestination ||
        nullableText(source.content_hash) !== nullableText(destination.content_hash)
      ) {
        throw new Error('wiki-project-move-conflict')
      }
      destinationsToReplace.add(slug)
    }
    for (const slug of slugs) {
      if (destinationsToReplace.has(slug)) {
        current.prepare('DELETE FROM wiki_page WHERE space_id = ? AND slug = ?').run(destinationSpaceId, slug)
      }
      current
        .prepare('UPDATE wiki_page SET space_id = ? WHERE space_id = ? AND slug = ?')
        .run(destinationSpaceId, sourceSpaceId, slug)
      current
        .prepare('UPDATE wiki_evidence_rejection SET space_id = ? WHERE space_id = ? AND slug = ?')
        .run(destinationSpaceId, sourceSpaceId, slug)
    }
  })
}

export function getWikiPageAnalysisEditContext(spaceId: string, slug: string): WikiPageAnalysisEditContext | null {
  const history = getWikiPageHistory(spaceId, slug)
  const currentRevision = history?.revisions[0]
  if (!history || !currentRevision) return null

  const latestRememberIndex = history.revisions.findIndex((revision) => revision.actor === 'remember')
  const lastRememberRevision = latestRememberIndex >= 0 ? history.revisions[latestRememberIndex] : null
  const changesSinceRemember = history.revisions
    .slice(0, latestRememberIndex >= 0 ? latestRememberIndex : history.revisions.length)
    .filter((revision) => revision.actor === 'user' || revision.actor === 'external')
    .reverse()

  return {
    currentRevision: {
      id: currentRevision.id,
      createdAt: currentRevision.createdAt,
      actor: currentRevision.actor,
      sourceId: currentRevision.sourceId,
      summary: currentRevision.summary,
    },
    lastRememberRevision: lastRememberRevision
      ? {
          id: lastRememberRevision.id,
          createdAt: lastRememberRevision.createdAt,
          title: lastRememberRevision.title,
          content: lastRememberRevision.content,
        }
      : null,
    changesSinceRemember: changesSinceRemember.map(({ id, createdAt, actor, operation, sourceId, summary }) => ({
      id,
      createdAt,
      actor,
      operation,
      sourceId,
      summary,
    })),
  }
}

type CreateWikiProposalInput = {
  id?: string
  dayId: string
  dayStartedAt: number
  spaceId: string
  slug: string
  title: string
  content: string
  summary: string
  baseRevision: string | null
  sourceId: string
  createdAt?: number
  evidence?: WikiPageUpdate['evidence']
}

function proposalEvidence(value: SQLInputValue | undefined): NonNullable<WikiPageUpdate['evidence']> {
  if (typeof value !== 'string') return []
  try {
    const evidence: unknown = JSON.parse(value)
    if (!Array.isArray(evidence)) return []
    return evidence.filter(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        typeof entry.sourceId === 'string' &&
        typeof entry.quote === 'string' &&
        typeof entry.observedAt === 'number'
    )
  } catch {
    return []
  }
}

function repeatedEvidencePassage(
  evidence: NonNullable<WikiPageUpdate['evidence']>[number],
  previous: NonNullable<WikiPageUpdate['evidence']>
) {
  const passage = comparableEvidenceQuote(evidence.quote)
  return previous.some((entry) => {
    if (entry.sourceId !== evidence.sourceId) return false
    const prior = comparableEvidenceQuote(entry.quote)
    return passage === prior || (passage.length >= 24 && prior.includes(passage))
  })
}

function comparableEvidenceQuote(quote: string) {
  return quote.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

export function rejectWikiRevisionEvidence(spaceId: string, slug: string, revisionId: string) {
  const revision = getWikiPageRevision(spaceId, slug, revisionId)
  if (revision?.actor !== 'remember' || !revision.evidence?.length) {
    throw new Error('wiki-revision-has-no-learning-evidence')
  }
  requiredDatabase()
    .prepare(`
      INSERT OR IGNORE INTO wiki_evidence_rejection (
        revision_id, space_id, slug, title, content, summary, evidence_json, rejected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      revision.id,
      spaceId,
      slug,
      revision.title,
      revision.content,
      revision.summary ?? '',
      JSON.stringify(revision.evidence),
      Date.now()
    )
}

export function isWikiEvidenceRejected(
  spaceId: string,
  slug: string,
  update: Pick<WikiPageUpdate, 'content' | 'summary' | 'evidence'>
) {
  const rejections = requiredDatabase()
    .prepare('SELECT content, evidence_json, rejected_at FROM wiki_evidence_rejection WHERE space_id = ? AND slug = ?')
    .all(spaceId, slug) as DatabaseRow[]
  const evidence = update.evidence ?? []
  return rejections.some((rejection) => {
    const previous = proposalEvidence(rejection.evidence_json)
    if (evidence.length && evidence.every((entry) => repeatedEvidencePassage(entry, previous))) return true
    // A later original user statement can reinstate or narrow an earlier belief.
    // Old material or a new assistant paraphrase cannot undo explicit feedback.
    const hasNewUserEvidence = evidence.some(
      (entry) => entry.role === 'user' && entry.observedAt > number(rejection.rejected_at)
    )
    if (hasNewUserEvidence) return false
    if (wikiProposalContentKey(update.content ?? update.summary) === wikiProposalContentKey(text(rejection.content)))
      return true
    return (
      evidence.length > 0 &&
      evidence.every((entry) =>
        previous.some((prior) => comparableEvidenceQuote(prior.quote) === comparableEvidenceQuote(entry.quote))
      )
    )
  })
}

function presentProposal(row: DatabaseRow): KnowledgeSuggestion {
  return {
    id: text(row.id),
    dayId: text(row.day_id),
    dayStartedAt: number(row.day_started_at),
    slug: text(row.slug),
    title: text(row.title),
    content: text(row.content),
    summary: text(row.summary),
    baseRevision: nullableText(row.base_revision),
    sourceId: text(row.source_id),
    suggestedSpaceId: text(row.space_id),
    status: text(row.status) as KnowledgeSuggestionStatus,
    destinationSpaceId: text(row.status) === 'applied' ? text(row.space_id) : null,
    appliedAt: row.applied_at == null ? null : number(row.applied_at),
    evidence: proposalEvidence(row.evidence_json),
  }
}

export function createWikiProposal(input: CreateWikiProposalInput) {
  return transaction(() => {
    const current = requiredDatabase()
    const createdAt = input.createdAt ?? Date.now()
    const id = input.id ?? randomUUID()
    const existing = current.prepare('SELECT * FROM wiki_proposal WHERE id = ?').get(id) as DatabaseRow | undefined
    if (existing) return presentProposal(existing)
    const prior = current
      .prepare(`
      SELECT * FROM wiki_proposal WHERE space_id = ? AND slug = ? ORDER BY created_at DESC
    `)
      .all(input.spaceId, input.slug) as DatabaseRow[]
    const contentKey = wikiProposalContentKey(input.content)
    const evidence = input.evidence ?? []
    const duplicate = prior.find((row) => {
      const previousEvidence = proposalEvidence(row.evidence_json)
      const repeatedEvidence =
        evidence.length > 0 && evidence.every((entry) => repeatedEvidencePassage(entry, previousEvidence))
      const sameContent = wikiProposalContentKey(text(row.content)) === contentKey
      return (
        repeatedEvidence ||
        (sameContent &&
          ((text(row.status) === 'pending' && nullableText(row.base_revision) === input.baseRevision) ||
            evidence.length === 0 ||
            previousEvidence.length === 0))
      )
    })
    if (duplicate) return presentProposal(duplicate)
    current
      .prepare(`
        UPDATE wiki_proposal
        SET status = 'superseded'
        WHERE space_id = ? AND slug = ? AND status = 'pending'
      `)
      .run(input.spaceId, input.slug)
    current
      .prepare(`
        INSERT OR IGNORE INTO wiki_proposal (
          id, day_id, day_started_at, space_id, slug, title, content, summary,
          base_revision, source_id, created_at, status, applied_at, evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?)
      `)
      .run(
        id,
        input.dayId,
        input.dayStartedAt,
        input.spaceId,
        input.slug,
        input.title,
        input.content,
        input.summary,
        input.baseRevision,
        input.sourceId,
        createdAt,
        JSON.stringify(input.evidence ?? [])
      )
    const row = current.prepare('SELECT * FROM wiki_proposal WHERE id = ?').get(id) as DatabaseRow | undefined
    if (!row) throw new Error('knowledge-suggestion-not-created')
    return presentProposal(row)
  })
}

export function wikiProposalFeedback(targets: Array<{ spaceId: string; slug: string }>) {
  return targets.flatMap(({ spaceId, slug }) => {
    const rows = requiredDatabase()
      .prepare(`
      SELECT title, content, summary, status, evidence_json FROM wiki_proposal
      WHERE space_id = ? AND slug = ? ORDER BY created_at DESC LIMIT 12
    `)
      .all(spaceId, slug) as DatabaseRow[]
    const proposals = rows.map((row) => ({
      spaceId,
      slug,
      title: text(row.title),
      content: text(row.content),
      summary: text(row.summary),
      status: text(row.status),
      evidence: proposalEvidence(row.evidence_json),
    }))
    const rejections = requiredDatabase()
      .prepare(
        'SELECT title, content, summary, evidence_json, rejected_at FROM wiki_evidence_rejection WHERE space_id = ? AND slug = ? ORDER BY rejected_at DESC LIMIT 12'
      )
      .all(spaceId, slug) as DatabaseRow[]
    return [
      ...rejections.map((row) => ({
        spaceId,
        slug,
        title: text(row.title),
        content: text(row.content),
        summary: text(row.summary),
        status: 'dismissed',
        evidence: proposalEvidence(row.evidence_json),
        rejectedAt: number(row.rejected_at),
      })),
      ...proposals,
    ]
  })
}

export function readWikiContextCheckpoints(): ContextSourceCheckpoint[] {
  const rows = requiredDatabase().prepare('SELECT * FROM wiki_context_source').all() as DatabaseRow[]
  return rows.map((row) => ({
    sourceKey: text(row.source_key),
    fingerprints: JSON.parse(text(row.fingerprints_json)) as string[],
    through: number(row.processed_through),
  }))
}

export function recordWikiContextCheckpoints(checkpoints: ContextSourceCheckpoint[]) {
  transaction(() => {
    for (const checkpoint of checkpoints)
      requiredDatabase()
        .prepare(`
      INSERT INTO wiki_context_source (source_key, fingerprints_json, processed_through) VALUES (?, ?, ?)
      ON CONFLICT(source_key) DO UPDATE SET
        fingerprints_json = excluded.fingerprints_json, processed_through = excluded.processed_through
      WHERE excluded.processed_through > wiki_context_source.processed_through
    `)
        .run(checkpoint.sourceKey, JSON.stringify(checkpoint.fingerprints), checkpoint.through)
  })
}

export function listWikiProposals() {
  return (
    requiredDatabase()
      .prepare(`
      SELECT * FROM wiki_proposal
      WHERE status != 'superseded'
      ORDER BY created_at DESC, rowid DESC
    `)
      .all() as DatabaseRow[]
  ).map(presentProposal)
}

export function getWikiProposal(id: string) {
  const row = requiredDatabase().prepare('SELECT * FROM wiki_proposal WHERE id = ?').get(id) as DatabaseRow | undefined
  return row ? presentProposal(row) : null
}

export function setWikiProposalStatus(id: string, status: Extract<KnowledgeSuggestionStatus, 'applied' | 'dismissed'>) {
  return transaction(() => {
    const current = requiredDatabase()
    const appliedAt = status === 'applied' ? Date.now() : null
    current.prepare('UPDATE wiki_proposal SET status = ?, applied_at = ? WHERE id = ?').run(status, appliedAt, id)
    const row = current.prepare('SELECT * FROM wiki_proposal WHERE id = ?').get(id) as DatabaseRow | undefined
    if (!row) throw new Error('knowledge-suggestion-not-found')
    return presentProposal(row)
  })
}
