import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  wikiCategoryHref,
  wikiHomeHref,
  wikiMarkdownHref,
  wikiNewSpaceHref,
  wikiPageHref,
  wikiSpaceId,
  wikiSuggestionsHref,
} from './wikiRoutes'

describe('route-owned Wiki views', () => {
  it('keeps the selected space across home, suggestions, category, page, and creation routes', () => {
    assert.equal(wikiHomeHref('team / woub'), '/wiki/?space=team+%2F+woub')
    assert.equal(wikiSuggestionsHref('team / woub'), '/wiki/suggestions/?space=team+%2F+woub')
    assert.equal(
      wikiCategoryHref('team / woub', 'Project notes'),
      '/wiki/category/?space=team+%2F+woub&category=Project+notes'
    )
    assert.equal(
      wikiPageHref('team / woub', 'projects/remember routes'),
      '/wiki/page/?space=team+%2F+woub&slug=projects%2Fremember+routes'
    )
    assert.equal(wikiNewSpaceHref('team / woub'), '/wiki/new/?space=team+%2F+woub')
  })

  it('uses Personal only when no meaningful route space was supplied', () => {
    assert.equal(wikiSpaceId(undefined), 'personal')
    assert.equal(wikiSpaceId('  '), 'personal')
    assert.equal(wikiSpaceId(['woub', 'personal']), 'woub')
  })

  it('opens canonical Markdown page paths in the current Space, including copied Markdown filenames', () => {
    for (const href of ['people/tom', './people/tom', 'people/tom.md']) {
      assert.equal(wikiMarkdownHref('team / woub', href), wikiPageHref('team / woub', 'people/tom'))
    }
    assert.equal(wikiMarkdownHref('personal', 'projects/woub/mobile'), wikiPageHref('personal', 'projects/woub/mobile'))
  })

  it('preserves external, existing app, unrelated relative and traversal links', () => {
    for (const href of [
      'https://example.test/people/tom',
      '//example.test/people/tom',
      '/wiki/page/?space=other&slug=people%2Ftom',
      '#roles',
      'notes/tom',
      '../people/tom',
      'people/../projects/woub',
      'people/%2e%2e/projects/woub',
      'people/tom?space=other',
      'people/tom#private',
    ])
      assert.equal(wikiMarkdownHref('personal', href), href)
  })
})
