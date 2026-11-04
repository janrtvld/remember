import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeWikiDocuments } from '../wikiMerge'

test('keeps one-sided Wiki edits', () => {
  const base = { title: 'Remember', content: 'Intro\n\n## Editing\nOld text.' }

  assert.deepEqual(mergeWikiDocuments(base, { ...base, content: 'Intro changed.\n\n## Editing\nOld text.' }, base), {
    document: { title: 'Remember', content: 'Intro changed.\n\n## Editing\nOld text.' },
    conflicts: [],
  })
  assert.deepEqual(mergeWikiDocuments(base, base, { ...base, title: 'Remember Wiki' }), {
    document: { title: 'Remember Wiki', content: base.content },
    conflicts: [],
  })
})

test('automatically merges non-overlapping Markdown edits', () => {
  const result = mergeWikiDocuments(
    { title: 'Remember', content: '## Product\nLocal-first.\n\n## Sync\nDrive.' },
    { title: 'Remember', content: '## Product\nLocal-first and fast.\n\n## Sync\nDrive.' },
    { title: 'Remember', content: '## Product\nLocal-first.\n\n## Sync\nDrive with Markdown.' }
  )

  assert.deepEqual(result.conflicts, [])
  assert.equal(result.document.content, '## Product\nLocal-first and fast.\n\n## Sync\nDrive with Markdown.')
})

test('accepts the same change from both writers without a conflict', () => {
  const result = mergeWikiDocuments(
    { title: 'Remember', content: 'Old' },
    { title: 'Remember', content: 'Same new text' },
    { title: 'Remember', content: 'Same new text' }
  )

  assert.deepEqual(result, {
    document: { title: 'Remember', content: 'Same new text' },
    conflicts: [],
  })
})

test('keeps the local region and reports overlapping Markdown edits', () => {
  const result = mergeWikiDocuments(
    { title: 'Remember', content: 'Before\nShared sentence.\nAfter' },
    { title: 'Remember', content: 'Before\nEdited locally.\nAfter' },
    { title: 'Remember', content: 'Before\nEdited in Drive.\nAfter' }
  )

  assert.equal(result.document.content, 'Before\nEdited locally.\nAfter')
  assert.deepEqual(result.conflicts, [
    {
      field: 'content',
      base: 'Shared sentence.',
      local: 'Edited locally.',
      remote: 'Edited in Drive.',
    },
  ])
})

test('keeps the local title and reports two-sided title changes', () => {
  const result = mergeWikiDocuments(
    { title: 'Old title', content: '' },
    { title: 'Local title', content: '' },
    { title: 'Drive title', content: '' }
  )

  assert.equal(result.document.title, 'Local title')
  assert.deepEqual(result.conflicts, [
    {
      field: 'title',
      base: 'Old title',
      local: 'Local title',
      remote: 'Drive title',
    },
  ])
})
