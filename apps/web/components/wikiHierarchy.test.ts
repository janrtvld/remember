import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { WikiPage } from '@remember/shared'
import { wikiAncestors, wikiCategoryCount, wikiDirectChildren, wikiParentSlug, wikiRootPages } from './wikiHierarchy'

function page(slug: string, title: string, updatedAt: number) {
  return { slug, title, updatedAt, content: '', excerpt: '', sourceCount: 1 } satisfies WikiPage
}

describe('Wiki page hierarchy', () => {
  const pages = [
    page('projects/remember', 'Remember', 100),
    page('projects/remember/wiki', 'Wiki', 300),
    page('projects/remember/wiki/navigation', 'Navigation', 400),
    page('projects/neerpolderseweg-49', 'Neerpolderseweg 49', 150),
    page('decisions/company-price', 'Prijs', 250),
  ]

  it('counts and lists only direct category pages as roots', () => {
    assert.equal(wikiCategoryCount(pages, 'projects'), 2)
    assert.deepEqual(
      wikiRootPages(pages, 'projects').map((candidate) => candidate.slug),
      ['projects/neerpolderseweg-49', 'projects/remember']
    )
  })

  it('returns direct children without flattening deeper descendants', () => {
    assert.deepEqual(
      wikiDirectChildren(pages, 'projects/remember').map((candidate) => candidate.slug),
      ['projects/remember/wiki']
    )
    assert.equal(wikiParentSlug('projects/remember/wiki/navigation'), 'projects/remember/wiki')
  })

  it('builds the visible breadcrumb ancestry', () => {
    assert.deepEqual(
      wikiAncestors(pages[2] as WikiPage, pages).map((candidate) => candidate.title),
      ['Remember', 'Wiki']
    )
  })
})
