import { createHash } from 'node:crypto'
import type { CreateWikiPageInput, SaveWikiPageInput, WikiPage, WikiPageHistory, WikiSpace } from '@remember/shared'
import type { AgentContextRequest } from './agentContextService'

const MAX_WIKI_CONTENT_LENGTH = 500_000

export type WikiCliRequest =
  | ({ id: string; action: 'agent.context' } & AgentContextRequest)
  | { id: string; action: 'agent.context.ack'; packetId: string }
  | { id: string; action: 'wiki.spaces' }
  | {
      id: string
      action: 'wiki.ensure' | 'wiki.find-source'
      spaceId: string
      source: string
      title: string
      content: string
      client: string
      summary: string
    }
  | { id: string; action: 'wiki.changes'; spaceId: string; cursor?: string }
  | {
      id: string
      action: 'wiki.patch'
      spaceId: string
      slug: string
      expectedRevision: string
      before: string
      after: string
      client: string
      summary: string
    }
  | { id: string; action: 'wiki.list'; spaceId: string }
  | { id: string; action: 'wiki.search'; spaceId: string; query: string; limit?: number }
  | { id: string; action: 'wiki.read'; spaceId: string; slug: string }
  | {
      id: string
      action: 'wiki.write'
      spaceId: string
      slug?: string
      title: string
      content: string
      expectedRevision?: string
      category?: string
      parentSlug?: string
    }

export type WikiCliResponse = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string }

export interface WikiCliDependencies {
  getHistory?: (spaceId: string, slug: string) => WikiPageHistory | Promise<WikiPageHistory>
  getSpaces: () => WikiSpace[] | Promise<WikiSpace[]>
  listPages: (spaceId: string) => Promise<WikiPage[]>
  createPage: (input: CreateWikiPageInput) => Promise<WikiPage[]>
  savePage: (input: SaveWikiPageInput) => Promise<WikiPage[]>
  deletePage: (spaceId: string, slug: string) => Promise<WikiPage[]>
  proposePage: (request: Extract<WikiCliRequest, { action: 'wiki.write' }>) => Promise<unknown>
}

function requiredString(value: unknown, error: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(error)
  return value.trim()
}

function optionalString(value: unknown, error: string) {
  if (value == null) return undefined
  return requiredString(value, error)
}

export function parseWikiCliRequest(value: unknown): WikiCliRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-request')
  const input = value as Record<string, unknown>
  const id = requiredString(input.id, 'invalid-request-id')
  const action = requiredString(input.action, 'invalid-request-action')

  if (action === 'agent.context.ack')
    return { id, action, packetId: requiredString(input.packetId, 'context-packet-required') }
  if (action === 'agent.context') {
    if (input.provider !== 'codex' && input.provider !== 'claude') throw new Error('invalid-agent-provider')
    if (input.event !== 'SessionStart' && input.event !== 'UserPromptSubmit') throw new Error('invalid-context-event')
    const cwd = requiredString(input.cwd, 'context-directory-required')
    if (!cwd.startsWith('/') || cwd.includes('\0')) throw new Error('invalid-context-directory')
    return {
      id,
      action,
      provider: input.provider,
      event: input.event,
      sessionId: requiredString(input.sessionId, 'context-session-required').slice(0, 200),
      cwd,
      prompt: typeof input.prompt === 'string' ? input.prompt.slice(0, 16_000) : '',
    }
  }
  if (action === 'wiki.spaces') return { id, action }
  const spaceId = requiredString(input.spaceId, 'wiki-space-required')
  if (action === 'wiki.changes') return { id, action, spaceId, cursor: optionalString(input.cursor, 'invalid-cursor') }
  if (action === 'wiki.ensure' || action === 'wiki.find-source') {
    const source = canonicalSource(requiredString(input.source, 'source-required'))
    return {
      id,
      action,
      spaceId,
      source,
      title: action === 'wiki.ensure' ? requiredString(input.title, 'wiki-title-required') : '',
      content: typeof input.content === 'string' ? input.content.slice(0, MAX_WIKI_CONTENT_LENGTH) : '',
      client: optionalString(input.client, 'invalid-client') ?? 'unknown',
      summary: optionalString(input.summary, 'invalid-summary') ?? 'Onderzoek gestart',
    }
  }
  if (action === 'wiki.patch')
    return {
      id,
      action,
      spaceId,
      slug: requiredString(input.slug, 'wiki-slug-required'),
      expectedRevision: requiredString(input.expectedRevision, 'wiki-revision-required'),
      before:
        typeof input.before === 'string' && input.before.length > 0
          ? input.before
          : requiredString(input.before, 'patch-before-required'),
      after: typeof input.after === 'string' ? input.after : '',
      client: requiredString(input.client, 'client-required'),
      summary: requiredString(input.summary, 'summary-required'),
    }
  if (action === 'wiki.list') return { id, action, spaceId }
  if (action === 'wiki.search') {
    const query = requiredString(input.query, 'wiki-query-required')
    const limit =
      typeof input.limit === 'number' && Number.isFinite(input.limit)
        ? Math.max(1, Math.min(200, input.limit))
        : undefined
    return { id, action, spaceId, query, ...(limit ? { limit } : {}) }
  }
  if (action === 'wiki.read') {
    return { id, action, spaceId, slug: requiredString(input.slug, 'wiki-slug-required') }
  }
  if (action === 'wiki.write') {
    const content = typeof input.content === 'string' ? input.content : ''
    if (content.length > MAX_WIKI_CONTENT_LENGTH) throw new Error('wiki-content-too-large')
    return {
      id,
      action,
      spaceId,
      slug: optionalString(input.slug, 'invalid-wiki-slug'),
      title: requiredString(input.title, 'wiki-title-required'),
      content,
      ...(optionalString(input.expectedRevision, 'invalid-wiki-revision')
        ? { expectedRevision: optionalString(input.expectedRevision, 'invalid-wiki-revision') }
        : {}),
      category: optionalString(input.category, 'invalid-wiki-category'),
      parentSlug: optionalString(input.parentSlug, 'invalid-wiki-parent'),
    }
  }
  throw new Error('unknown-request-action')
}

function findPage(pages: WikiPage[], slug: string) {
  const page = pages.find((candidate) => candidate.slug === slug)
  if (!page) throw new Error('wiki-page-not-found')
  return page
}

async function assertSpace(dependencies: WikiCliDependencies, spaceId: string) {
  const spaces = await dependencies.getSpaces()
  const space = spaces.find((candidate) => candidate.id === spaceId)
  if (!space) throw new Error('wiki-space-not-found')
  return space
}

async function writePage(
  dependencies: WikiCliDependencies,
  request: Extract<WikiCliRequest, { action: 'wiki.write' }>
) {
  const pages = await dependencies.listPages(request.spaceId)
  if (request.slug) {
    const current = findPage(pages, request.slug)
    if (current.revision !== request.expectedRevision) throw new Error('wiki-page-conflict')
    if (!request.expectedRevision) throw new Error('wiki-revision-required')
    const next = await dependencies.savePage({
      spaceId: request.spaceId,
      slug: request.slug,
      title: request.title,
      content: request.content,
      expectedRevision: request.expectedRevision,
      strictRevision: true,
    })
    return findPage(next, request.slug)
  }

  const category = request.category ?? 'documents'
  const createdPages = await dependencies.createPage({
    spaceId: request.spaceId,
    category,
    title: request.title,
    content: request.content,
    ...(request.parentSlug ? { parentSlug: request.parentSlug } : {}),
  })
  const created = createdPages.filter(
    (page) => !['index', 'log'].includes(page.slug) && !pages.some((candidate) => candidate.slug === page.slug)
  )
  if (created.length !== 1) throw new Error('wiki-page-creation-unverified')
  return created[0]
}

export function canonicalSource(value: string) {
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid-source-url')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function sourceSlug(source: string) {
  return `documents/source-${createHash('sha256').update(source).digest('hex')}`
}

export function createWikiCliRequestHandler(dependencies: WikiCliDependencies) {
  return async (value: unknown): Promise<WikiCliResponse> => {
    let id = 'unknown'
    try {
      const request = parseWikiCliRequest(value)
      id = request.id
      if (request.action === 'agent.context') {
        return {
          id,
          ok: true,
          result: { packetId: '', context: '', pages: [], removed: [], freshness: [], changed: false },
        }
      }
      if (request.action === 'agent.context.ack') {
        return {
          id,
          ok: true,
          result: { acknowledged: false },
        }
      }
      if (request.action === 'wiki.spaces') {
        return { id, ok: true, result: await dependencies.getSpaces() }
      }
      const space = await assertSpace(dependencies, request.spaceId)
      if (request.action === 'wiki.find-source' || request.action === 'wiki.ensure') {
        const slug = sourceSlug(request.source)
        const existing = (await dependencies.listPages(request.spaceId)).find((page) => page.slug === slug)
        if (existing || request.action === 'wiki.find-source') return { id, ok: true, result: existing ?? null }
        if (space.maintenanceMode === 'suggest') throw new Error('source-creation-requires-auto-mode')
        const pages = await dependencies.createPage({
          spaceId: request.spaceId,
          category: 'documents',
          slug,
          title: request.title,
          content: `Bron: ${request.source}\n\n${request.content}`,
          contribution: { client: request.client, summary: request.summary },
        })
        return { id, ok: true, result: findPage(pages, slug) }
      }
      if (request.action === 'wiki.changes') {
        const pages = (await dependencies.listPages(request.spaceId)).filter(
          (page) => page.slug !== 'index' && page.slug !== 'log'
        )
        let previous: Record<string, string> = {}
        if (request.cursor) {
          const decoded = JSON.parse(Buffer.from(request.cursor, 'base64url').toString())
          if (decoded.spaceId !== request.spaceId || !decoded.revisions || typeof decoded.revisions !== 'object')
            throw new Error('invalid-cursor')
          previous = decoded.revisions
        }
        const revisions = Object.fromEntries(pages.map((page) => [page.slug, page.revision ?? String(page.updatedAt)]))
        const contributions = await Promise.all(
          pages
            .filter((page) => previous[page.slug] !== revisions[page.slug])
            .map(async (page) => {
              const history = await dependencies.getHistory?.(request.spaceId, page.slug)
              const revisions = history?.revisions ?? []
              const since = revisions.findIndex((revision) => revision.id === previous[page.slug])
              return {
                slug: page.slug,
                revisions: (since < 0 ? revisions : revisions.slice(0, since)).map(
                  ({ id, parentRevisionId, createdAt, actor, sourceId, summary }) => ({
                    id,
                    parentRevisionId,
                    createdAt,
                    actor,
                    sourceId,
                    summary,
                  })
                ),
              }
            })
        )
        return {
          id,
          ok: true,
          result: {
            contributions,
            pages: pages.filter((page) => previous[page.slug] !== revisions[page.slug]),
            removed: Object.keys(previous).filter((slug) => !(slug in revisions)),
            cursor: Buffer.from(JSON.stringify({ spaceId: request.spaceId, revisions })).toString('base64url'),
          },
        }
      }
      if (request.action === 'wiki.patch') {
        const page = findPage(await dependencies.listPages(request.spaceId), request.slug)
        if (page.revision !== request.expectedRevision) throw new Error('wiki-page-conflict')
        if (!page.content.includes(request.before) || page.content.split(request.before).length !== 2)
          throw new Error('patch-target-not-unique')
        const content = page.content.replace(request.before, () => request.after)
        if (content.length > MAX_WIKI_CONTENT_LENGTH) throw new Error('wiki-content-too-large')
        if (space.maintenanceMode === 'suggest')
          return {
            id,
            ok: true,
            result: await dependencies.proposePage({
              id,
              action: 'wiki.write',
              spaceId: request.spaceId,
              slug: page.slug,
              title: page.title,
              content,
              expectedRevision: request.expectedRevision,
            }),
          }
        const pages = await dependencies.savePage({
          spaceId: request.spaceId,
          slug: page.slug,
          title: page.title,
          content,
          expectedRevision: request.expectedRevision,
          strictRevision: true,
          contribution: { client: request.client, summary: request.summary },
        })
        return { id, ok: true, result: findPage(pages, page.slug) }
      }
      if (request.action === 'wiki.list') {
        return { id, ok: true, result: await dependencies.listPages(request.spaceId) }
      }
      if (request.action === 'wiki.search') {
        const query = request.query.toLocaleLowerCase()
        const pages = (await dependencies.listPages(request.spaceId))
          .filter((page) => `${page.title}\n${page.content}`.toLocaleLowerCase().includes(query))
          .slice(0, request.limit ?? 20)
          .map(({ slug, title, excerpt, updatedAt }) => ({ slug, title, excerpt, updatedAt }))
        return { id, ok: true, result: pages }
      }
      if (request.action === 'wiki.read') {
        return { id, ok: true, result: findPage(await dependencies.listPages(request.spaceId), request.slug) }
      }
      if (request.action !== 'wiki.write') throw new Error('unknown-request-action')
      return {
        id,
        ok: true,
        result:
          space.maintenanceMode === 'suggest'
            ? await dependencies.proposePage(request)
            : await writePage(dependencies, request),
      }
    } catch (error) {
      return { id, ok: false, error: error instanceof Error ? error.message : 'wiki-request-failed' }
    }
  }
}
