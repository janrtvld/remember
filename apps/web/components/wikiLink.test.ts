import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MarkdownManager } from '@tiptap/markdown'
import { getSchema } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { createWikiLink } from './wikiLink'
import { wikiPageHref } from './wikiRoutes'

test('Wiki links render current-Space URLs while preserving canonical Markdown through the editor', () => {
  const source = 'Contact [Tom](people/tom) for [App](projects/app.md).'
  for (const spaceId of ['personal', 'team / woub']) {
    const extensions = [StarterKit.configure({ link: false }), createWikiLink(spaceId)]
    const markdown = new MarkdownManager({ extensions })
    assert.equal(markdown.serialize(markdown.parse(source)), source)
    const schema = getSchema(extensions)
    const mark = schema.marks.link.create({ href: 'people/tom' })
    const rendered = schema.marks.link.spec.toDOM?.(mark, false)
    assert.ok(Array.isArray(rendered))
    assert.equal((rendered[1] as { href: string }).href, wikiPageHref(spaceId, 'people/tom'))
    assert.equal(mark.attrs.href, 'people/tom')
    const unsafe = schema.marks.link.spec.toDOM?.(schema.marks.link.create({ href: 'javascript:alert(1)' }), false)
    assert.ok(Array.isArray(unsafe))
    assert.equal((unsafe[1] as { href: string }).href, '')
  }
})
