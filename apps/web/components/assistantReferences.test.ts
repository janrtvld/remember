import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assistantReference, remarkAssistantReferences } from './assistantReferences'

test('only explicit internal task and scoped document routes become cards', () => {
  assert.deepEqual(assistantReference('/wiki/page/?slug=one%2Ftwo&space=personal'), {
    kind: 'document',
    spaceId: 'personal',
    slug: 'one/two',
    href: '/wiki/page/?space=personal&slug=one%2Ftwo',
  })
  assert.equal(assistantReference('/inbox/?item=abc')?.kind, 'task')
  for (const href of [
    '//evil.test/inbox/?item=x',
    '/\\evil.test/inbox/?item=x',
    'https://evil.test/inbox/?item=x',
    'javascript:alert(1)',
    '/inbox/',
    '/wiki/page/?slug=x',
    '/inbox/?item=x&item=y',
  ])
    assert.equal(assistantReference(href), null)
})

test('collects repeated references once, preserves prose, external links and code', () => {
  const text = { type: 'text', value: 'The task' }
  const link = { type: 'link', url: '/inbox/?item=abc', children: [text] }
  const external = { type: 'link', url: 'https://example.com', children: [text] }
  const code = { type: 'code', value: '[Task](/inbox/?item=abc)' }
  const tree = { type: 'root', children: [{ type: 'paragraph', children: [link, link, external] }, code] }
  remarkAssistantReferences()(tree)
  assert.equal(tree.children.length, 3)
  assert.deepEqual(tree.children[0] && 'children' in tree.children[0] ? tree.children[0].children : undefined, [
    text,
    text,
    external,
  ])
  assert.deepEqual(tree.children[1], code)
  assert.deepEqual(tree.children[2] && 'children' in tree.children[2] ? tree.children[2].children : undefined, [link])
})

test('saved result cards are not duplicated and reference-style links resolve', () => {
  const definition = { type: 'definition', identifier: 'task', url: '/inbox/?item=a' }
  const tree = {
    type: 'root',
    children: [
      definition,
      {
        type: 'paragraph',
        children: [{ type: 'linkReference', identifier: 'TASK', children: [{ type: 'text', value: 'Task' }] }],
      },
    ],
  }
  remarkAssistantReferences({ exclude: ['/inbox/?item=a'] })(tree)
  assert.equal(tree.children.length, 2)
  assert.deepEqual(tree.children[1] && 'children' in tree.children[1] ? tree.children[1].children : undefined, [
    { type: 'text', value: 'Task' },
  ])
})

test('groups distinct references into one inline row while respecting saved results', () => {
  const links = ['/inbox/?item=a', '/wiki/page/?space=personal&slug=guide', '/inbox/?item=b'].map((url) => ({
    type: 'link',
    url,
    children: [{ type: 'text', value: url }],
  }))
  const tree = { type: 'root', children: [{ type: 'paragraph', children: links }] }
  remarkAssistantReferences({ exclude: ['/inbox/?item=b'] })(tree)
  assert.equal(tree.children.length, 2)
  assert.deepEqual(tree.children[1].children, links.slice(0, 2))
})
