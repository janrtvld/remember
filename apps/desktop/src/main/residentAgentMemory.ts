import { createHash } from 'node:crypto'
import { redactSensitiveCaptureText, type WikiSpace } from '@remember/shared'
import {
  type AgentContextSnapshot,
  agentContextTerms,
  compactAgentContextPage,
  isPrivateSelfProfilePage,
  rankAgentContextPages,
} from './agentContextService'

const MAX_MEMORY_CHARACTERS = 10_000

export type ResidentMemorySource = {
  spaceId: string
  spaceName: string
  slug: string
  title: string
  revision: string
  url: string
  content: string
  checkedAt: number | null
  updatedAt?: number
  freshness: AgentContextSnapshot['state']
}

export type ResidentMemoryReference = Pick<ResidentMemorySource, 'spaceId' | 'slug' | 'revision'> & {
  explicit?: boolean
}

export function residentMemoryRevision(page: import('@remember/shared').WikiPage) {
  return page.revision ?? createHash('sha256').update(`${page.title}\n${page.content}`).digest('hex')
}

export function selectResidentMemorySpaces(spaces: WikiSpace[], query: string) {
  const words = new Set(agentContextTerms(query))
  return spaces
    .filter((space) => {
      if (space.id === 'personal') return true
      const names = [space.id, space.name].map(agentContextTerms).filter((parts) => parts.length > 0)
      return names.some((parts) => parts.every((part) => words.has(part)))
    })
    .sort((a, b) => Number(b.id === 'personal') - Number(a.id === 'personal'))
    .slice(0, 3)
}

export type ResidentMemoryValidation = 'valid' | 'invalidated' | 'unavailable'

export type ResidentMemoryDependencies = {
  spaces: () => WikiSpace[]
  read: (spaceId: string) => Promise<AgentContextSnapshot>
  pagePermitted: (spaceId: string, page: import('@remember/shared').WikiPage) => boolean
  assertAvailable: () => void
}

export async function validateResidentMemorySources(
  sources: ResidentMemoryReference[],
  dependencies: {
    spaces: () => WikiSpace[]
    read: (spaceId: string) => Promise<AgentContextSnapshot>
    pagePermitted: (spaceId: string, page: import('@remember/shared').WikiPage) => boolean
    assertAvailable: () => void
  }
): Promise<ResidentMemoryValidation> {
  dependencies.assertAvailable()
  let unavailable = false
  const snapshots = new Map<string, AgentContextSnapshot>()
  for (const spaceId of new Set(sources.map((source) => source.spaceId))) {
    dependencies.assertAvailable()
    const space = dependencies.spaces().find((entry) => entry.id === spaceId)
    if (!space) return 'invalidated'
    try {
      snapshots.set(spaceId, await dependencies.read(spaceId))
    } catch {
      unavailable = true
    }
  }
  dependencies.assertAvailable()
  const spaces = dependencies.spaces()
  for (const source of sources) {
    const space = spaces.find((entry) => entry.id === source.spaceId)
    if (!space) return 'invalidated'
    const snapshot = snapshots.get(source.spaceId)
    if (snapshot?.state !== 'fresh') {
      unavailable = true
      continue
    }
    const page = snapshot.pages.find((entry) => entry.slug === source.slug)
    if (
      !page ||
      residentMemoryRevision(page) !== source.revision ||
      (!source.explicit && !dependencies.pagePermitted(space.id, page))
    )
      return 'invalidated'
  }
  return unavailable ? 'unavailable' : 'valid'
}

export async function readResidentMemory(
  query: string,
  dependencies: ResidentMemoryDependencies,
  previous: ResidentMemoryReference[] = []
) {
  dependencies.assertAvailable()
  const spaces = selectResidentMemorySpaces(dependencies.spaces(), query)
  const validationSpaces = dependencies
    .spaces()
    .filter((space) => previous.some((source) => source.spaceId === space.id))
  const reading = [...new Map([...spaces, ...validationSpaces].map((space) => [space.id, space])).values()]
  const snapshots = await Promise.all(
    reading.map(async (space) => {
      try {
        return { space, ...(await dependencies.read(space.id)) }
      } catch {
        return { space, pages: [], checkedAt: null, state: 'error' as const }
      }
    })
  )
  dependencies.assertAvailable()
  const permitted = new Set(selectResidentMemorySpaces(dependencies.spaces(), query).map((space) => space.id))
  const currentSpaces = dependencies.spaces()
  const invalidated = previous.some((source) => {
    const space = currentSpaces.find((entry) => entry.id === source.spaceId)
    const snapshot = snapshots.find((entry) => entry.space.id === source.spaceId)
    if (!space || !snapshot || ['error', 'offline'].includes(snapshot.state)) return true
    const page = snapshot.pages.find((entry) => entry.slug === source.slug)
    return (
      !page ||
      residentMemoryRevision(page) !== source.revision ||
      (!source.explicit && !dependencies.pagePermitted(space.id, page))
    )
  })
  const terms = agentContextTerms(query)
  const candidates = snapshots
    .flatMap((snapshot) => {
      if (!permitted.has(snapshot.space.id) || snapshot.state === 'error' || snapshot.state === 'offline') return []
      const pages = snapshot.pages.filter(
        (page) => dependencies.pagePermitted(snapshot.space.id, page) && !['index', 'log'].includes(page.slug)
      )
      const profile =
        snapshot.space.id === 'personal' && snapshot.state === 'fresh'
          ? pages
              .filter((page) => isPrivateSelfProfilePage(page) && Boolean(page.revision?.trim()))
              .sort((first, second) => Number(second.slug === 'people/me') - Number(first.slug === 'people/me'))[0]
          : undefined
      const ranked = rankAgentContextPages(pages, terms).filter(({ page }) => page.slug !== profile?.slug)
      return [
        ...(profile ? [{ snapshot, page: profile, score: 300 }] : []),
        ...ranked.map(({ page, score }) => ({ snapshot, page, score })),
      ]
    })
    .sort((a, b) => b.score - a.score || b.page.updatedAt - a.page.updatedAt || a.page.slug.localeCompare(b.page.slug))
  const sources: ResidentMemorySource[] = []
  for (const { snapshot, page } of candidates) {
    const source: ResidentMemorySource = {
      spaceId: snapshot.space.id,
      spaceName: snapshot.space.name,
      slug: page.slug,
      title: redactSensitiveCaptureText(page.title),
      revision: residentMemoryRevision(page),
      url: `/wiki/page/?space=${encodeURIComponent(snapshot.space.id)}&slug=${encodeURIComponent(page.slug)}`,
      content: redactSensitiveCaptureText(compactAgentContextPage(page, terms, isPrivateSelfProfilePage(page))),
      checkedAt: snapshot.checkedAt,
      updatedAt: page.updatedAt,
      freshness: snapshot.state,
    }
    if (JSON.stringify([...sources, source]).length > MAX_MEMORY_CHARACTERS) continue
    sources.push(source)
    if (sources.length === 6) break
  }
  return {
    sources,
    invalidated:
      invalidated || new Set([...previous, ...sources].map((source) => `${source.spaceId}/${source.slug}`)).size > 32,
    freshness: snapshots.map(({ space, checkedAt, state }) => ({ spaceId: space.id, checkedAt, state })),
    limits: {
      maximumPages: 6,
      maximumCharacters: MAX_MEMORY_CHARACTERS,
      totalSpaceCount: dependencies.spaces().length,
      searchedSpaceCount: spaces.length,
    },
  }
}

/** The agent's standing identity context is private and bounded; related pages require a query. */
export function readResidentSelfProfile(
  dependencies: ResidentMemoryDependencies,
  previous: ResidentMemoryReference[] = []
) {
  return readResidentMemory('', dependencies, previous)
}
