import type { KnowledgeSuggestion, WikiPageUpdate } from '@remember/shared'

export type WikiReconcileExistingPage = { slug: string; title: string; content: string }

export function wikiMaintenanceIdentityPages(
  pages: WikiReconcileExistingPage[],
  proposals: Pick<KnowledgeSuggestion, 'slug' | 'title' | 'content' | 'status'>[]
): WikiReconcileExistingPage[] {
  return [
    ...pages,
    ...proposals
      .filter((proposal) => proposal.status === 'pending')
      .map(({ slug, title, content }) => ({ slug, title, content })),
  ]
}

export type WikiReconcileNote =
  | { type: 'retargeted'; fromSlug: string; toSlug: string }
  | { type: 'merged'; keptSlug: string; droppedSlug: string }

type SubjectCandidate = { slug: string; title: string; content: string }

// Generated pages share instructed section vocabulary in both interface languages;
// without this list every managed page overlaps every other through its headings.
const STRUCTURAL_TOKENS = new Set([
  'direction',
  'decisions',
  'decision',
  'constraints',
  'constraint',
  'current',
  'state',
  'remaining',
  'work',
  'definition',
  'done',
  'richting',
  'beslissingen',
  'beslissing',
  'beperkingen',
  'beperking',
  'huidige',
  'stand',
  'staat',
  'resterend',
  'resterende',
  'werk',
  'definitie',
  'klaar',
])

const CONTENT_OVERLAP_THRESHOLD = 0.4

function normalized(value: string) {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

function tokenSet(value: string, minimumLength: number) {
  return new Set(
    normalized(value)
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= minimumLength)
  )
}

function slugParent(slug: string) {
  const separator = slug.lastIndexOf('/')
  return separator === -1 ? '' : slug.slice(0, separator)
}

function slugTailTokens(slug: string) {
  const tail = slug.split('/').at(-1) ?? slug
  return new Set(tail.split('-').filter(Boolean))
}

function isSubset(candidate: Set<string>, container: Set<string>) {
  if (candidate.size === 0) return false
  for (const token of candidate) if (!container.has(token)) return false
  return true
}

function nameRelated(first: SubjectCandidate, second: SubjectCandidate) {
  const firstTail = slugTailTokens(first.slug)
  const secondTail = slugTailTokens(second.slug)
  if (isSubset(firstTail, secondTail) || isSubset(secondTail, firstTail)) return true
  const firstTitle = tokenSet(first.title, 2)
  const secondTitle = tokenSet(second.title, 2)
  return isSubset(firstTitle, secondTitle) || isSubset(secondTitle, firstTitle)
}

const contentTokenCache = new WeakMap<SubjectCandidate, Set<string>>()

function contentTokens(candidate: SubjectCandidate) {
  const cached = contentTokenCache.get(candidate)
  if (cached) return cached
  const prose = candidate.content.replace(/<!--[\s\S]*?-->/g, ' ').replace(/^#{1,6} .*$/gm, ' ')
  const tokens = new Set([...tokenSet(prose, 4)].filter((token) => !STRUCTURAL_TOKENS.has(token)))
  contentTokenCache.set(candidate, tokens)
  return tokens
}

function contentOverlap(first: SubjectCandidate, second: SubjectCandidate) {
  const firstTokens = contentTokens(first)
  const secondTokens = contentTokens(second)
  if (firstTokens.size === 0 || secondTokens.size === 0) return 0
  const [small, large] =
    firstTokens.size <= secondTokens.size ? [firstTokens, secondTokens] : [secondTokens, firstTokens]
  let shared = 0
  for (const token of small) if (large.has(token)) shared += 1
  return shared / small.size
}

function sameSubject(first: SubjectCandidate, second: SubjectCandidate) {
  if (first.slug === second.slug) return true
  // Similar names and shared project vocabulary do not establish person identity.
  if (first.slug.startsWith('people/') || second.slug.startsWith('people/')) return false
  if (slugParent(first.slug) !== slugParent(second.slug)) return false
  if (!nameRelated(first, second)) return false
  return contentOverlap(first, second) >= CONTENT_OVERLAP_THRESHOLD
}

function asCandidate(update: WikiPageUpdate): SubjectCandidate {
  return { slug: update.slug, title: update.title, content: update.content ?? update.summary }
}

function richness(update: WikiPageUpdate) {
  return (update.content ?? update.summary).length
}

export function reconcileWikiPageUpdates(
  existingPages: WikiReconcileExistingPage[],
  updates: WikiPageUpdate[]
): { updates: WikiPageUpdate[]; notes: WikiReconcileNote[] } {
  const notes: WikiReconcileNote[] = []
  const existingSlugs = new Set(existingPages.map((page) => page.slug))
  const candidates = new Map<WikiPageUpdate, SubjectCandidate>()
  const candidateFor = (update: WikiPageUpdate) => {
    const cached = candidates.get(update)
    if (cached) return cached
    const candidate = asCandidate(update)
    candidates.set(update, candidate)
    return candidate
  }

  const retargeted = updates.map((update) => {
    if (existingSlugs.has(update.slug)) return update
    const match = existingPages.find((page) => sameSubject(page, candidateFor(update)))
    if (!match) return update
    notes.push({ type: 'retargeted', fromSlug: update.slug, toSlug: match.slug })
    return { ...update, slug: match.slug, changeType: 'updated' as const }
  })

  const kept: WikiPageUpdate[] = []
  for (const update of retargeted) {
    const duplicateIndex = kept.findIndex((candidate) => sameSubject(candidateFor(candidate), candidateFor(update)))
    if (duplicateIndex === -1) {
      kept.push(update)
      continue
    }
    const current = kept[duplicateIndex] as WikiPageUpdate
    const currentExists = existingSlugs.has(current.slug)
    const updateExists = existingSlugs.has(update.slug)
    const winner =
      currentExists !== updateExists
        ? currentExists
          ? current
          : update
        : richness(update) > richness(current)
          ? update
          : current
    const loser = winner === current ? update : current
    kept[duplicateIndex] = winner
    notes.push({ type: 'merged', keptSlug: winner.slug, droppedSlug: loser.slug })
  }

  return { updates: kept, notes }
}
