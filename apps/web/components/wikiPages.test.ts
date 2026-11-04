import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { WikiPage } from '@remember/shared'
import { editableWikiPages, findCreatedWikiPage } from './wikiPages'

function page(slug: string, title = slug): WikiPage {
  return { slug, title, content: '', excerpt: '', updatedAt: 0, sourceCount: 0 }
}

describe('editable wiki pages', () => {
  it('never exposes generated system files as editable pages', () => {
    assert.deepEqual(
      editableWikiPages([page('index'), page('log'), page('projects/remember')]).map((entry) => entry.slug),
      ['projects/remember']
    )
  })

  it('selects the newly created category page instead of the regenerated index', () => {
    const previousPages = [page('index'), page('projects/remember')]
    const nextPages = [page('index'), page('log'), page('projects/naamloze-pagina'), page('projects/remember')]

    assert.equal(
      findCreatedWikiPage(previousPages, nextPages, { category: 'projects' })?.slug,
      'projects/naamloze-pagina'
    )
  })

  it('selects a newly created direct subpage', () => {
    const previousPages = [page('projects/remember')]
    const nextPages = [page('projects/remember'), page('projects/remember/naamloze-pagina')]

    assert.equal(
      findCreatedWikiPage(previousPages, nextPages, {
        category: 'projects',
        parentSlug: 'projects/remember',
      })?.slug,
      'projects/remember/naamloze-pagina'
    )
  })
})
