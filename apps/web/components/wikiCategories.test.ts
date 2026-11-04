import assert from 'node:assert/strict'
import test from 'node:test'
import { categoryForSlug, wikiCategories } from './wikiCategories'

test('new Spaces retain the original knowledge categories', () => {
  assert.deepEqual(
    wikiCategories([]).map((category) => category.slug),
    ['projects', 'decisions', 'research', 'people', 'processes', 'concepts']
  )
})

test('content created during the rework remains reachable through its category', () => {
  const pages = [
    { slug: 'documents/plan' },
    { slug: 'documents/plan/next-steps' },
    { slug: 'meetings/recording-1' },
    { slug: 'custom/context' },
  ]
  assert.deepEqual(wikiCategories(pages).slice(6), [
    { slug: 'documents', label: 'Documenten' },
    { slug: 'meetings', label: 'Gesprekken' },
    { slug: 'custom', label: 'custom' },
  ])
  assert.deepEqual(categoryForSlug('documents/plan/next-steps', pages), {
    slug: 'documents',
    label: 'Documenten',
  })
})
