import type { WikiPage } from '@remember/shared'

export type WikiCategory = { slug: string; label: string }

const DEFAULT_CATEGORIES: readonly WikiCategory[] = [
  { slug: 'projects', label: 'Projecten' },
  { slug: 'decisions', label: 'Besluiten' },
  { slug: 'research', label: 'Onderzoek' },
  { slug: 'people', label: 'Mensen' },
  { slug: 'processes', label: 'Processen' },
  { slug: 'concepts', label: 'Concepten' },
]

const COMPATIBILITY_LABELS = new Map([
  ['documents', 'Documenten'],
  ['meetings', 'Gesprekken'],
])

export function wikiCategories(pages: readonly Pick<WikiPage, 'slug'>[]): WikiCategory[] {
  const categories = [...DEFAULT_CATEGORIES]
  const knownSlugs = new Set(categories.map((category) => category.slug))
  for (const page of pages) {
    const slug = page.slug.split('/')[0]
    if (!slug || knownSlugs.has(slug)) continue
    knownSlugs.add(slug)
    categories.push({ slug, label: COMPATIBILITY_LABELS.get(slug) ?? slug })
  }
  return categories
}

export function categoryForSlug(slug: string, pages: readonly Pick<WikiPage, 'slug'>[]) {
  return wikiCategories(pages).find((category) => category.slug === slug.split('/')[0])
}
