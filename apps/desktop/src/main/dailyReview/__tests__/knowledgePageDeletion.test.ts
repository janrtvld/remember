import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'
import { getWikiPageHistory } from '../../wikiHistoryStore'
import {
  createKnowledgePageAt,
  deleteKnowledgePageAt,
  deleteKnowledgePageTreeAt,
  getKnowledgePageHistoryAt,
  initializeKnowledgeStore,
  listKnowledgePagesAt,
  saveKnowledgePageAt,
} from '../knowledgeStore'

function sourceFixture(t: TestContext, slug = 'meetings/meeting-1') {
  const userData = mkdtempSync(join(tmpdir(), 'remember-guarded-delete-'))
  t.after(() => rmSync(userData, { recursive: true, force: true }))
  initializeKnowledgeStore(userData)
  const directory = join(userData, 'daily-review', 'wiki')
  const pages = createKnowledgePageAt(directory, {
    spaceId: 'personal',
    category: slug.split('/')[0] ?? 'meetings',
    slug,
    title: 'Nieuw gesprek',
    content: '[Open opname en transcript](/conversations/pending/?meeting=meeting-1)',
  })
  const page = pages.find((candidate) => candidate.slug === slug)
  assert.ok(page?.revision)
  return { directory, page, guard: { expectedRevision: page.revision, onlyIfLeaf: true } }
}

test('guarded deletion removes an unchanged leaf and records its deletion', (t) => {
  const { directory, page, guard } = sourceFixture(t)
  const next = deleteKnowledgePageAt(directory, page.slug, undefined, guard)
  assert.equal(
    next.some((candidate) => candidate.slug === page.slug),
    false
  )
  assert.equal(existsSync(join(directory, `${page.slug}.md`)), false)
  assert.equal(getWikiPageHistory('personal', page.slug)?.revisions[0]?.operation, 'deleted')
})

test('an edit arriving after the renderer read preserves content and title', (t) => {
  const { directory, page, guard } = sourceFixture(t)
  const content = `${page.content}\n\nMijn eigen notities.`
  saveKnowledgePageAt(directory, {
    spaceId: 'personal',
    slug: page.slug,
    title: 'Eigen titel',
    content,
    expectedRevision: page.revision,
  })
  assert.throws(() => deleteKnowledgePageAt(directory, page.slug, undefined, guard), /wiki-page-conflict/)
  const preserved = listKnowledgePagesAt(directory).find((candidate) => candidate.slug === page.slug)
  assert.equal(preserved?.title, 'Eigen titel')
  assert.equal(preserved?.content, content)
  assert.notEqual(getKnowledgePageHistoryAt(directory, page.slug).revisions[0]?.operation, 'deleted')
})

test('guarded deletion detects external file changes before checking the revision', (t) => {
  const { directory, page, guard } = sourceFixture(t)
  writeFileSync(join(directory, `${page.slug}.md`), '# External title\n\nExternal notes.\n')
  assert.throws(() => deleteKnowledgePageAt(directory, page.slug, undefined, guard), /wiki-page-conflict/)
  assert.equal(
    listKnowledgePagesAt(directory).find((candidate) => candidate.slug === page.slug)?.content,
    'External notes.'
  )
})

test('a child created after the renderer read prevents leaf and tree deletion', (t) => {
  const { directory, page, guard } = sourceFixture(t, 'projects/meeting')
  createKnowledgePageAt(directory, {
    spaceId: 'personal',
    category: 'projects',
    parentSlug: page.slug,
    slug: `${page.slug}/notes`,
    title: 'Notes',
    content: 'Keep this child.',
  })
  assert.throws(() => deleteKnowledgePageAt(directory, page.slug, undefined, guard), /wiki-page-has-children/)
  assert.throws(() => deleteKnowledgePageTreeAt(directory, page.slug, undefined, guard), /wiki-page-has-children/)
  assert.equal(existsSync(join(directory, `${page.slug}.md`)), true)
  assert.equal(existsSync(join(directory, `${page.slug}/notes.md`)), true)

  const next = deleteKnowledgePageTreeAt(directory, page.slug)
  assert.equal(
    next.some((candidate) => candidate.slug.startsWith(page.slug)),
    false
  )
})
