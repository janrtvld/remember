import assert from 'node:assert/strict'
import { it } from 'node:test'
import { assertWikiAnalysisRevisions } from '../wikiContextAccess'

it('rejects analyzed pages that were edited, created, or deleted before saving', () => {
  const expected = [{ spaceId: 'personal', slug: 'projects/trip', revision: 'analyzed' }]
  const updates = [{ slug: 'projects/trip' }]
  assert.doesNotThrow(() => assertWikiAnalysisRevisions('personal', updates, expected, expected))
  for (const current of [[{ slug: 'projects/trip', revision: 'edited' }], []]) {
    assert.throws(() => assertWikiAnalysisRevisions('personal', updates, expected, current), /wiki-page-conflict/)
  }
  assert.throws(() => assertWikiAnalysisRevisions('personal', updates, [], expected), /wiki-page-conflict/)
  assert.doesNotThrow(() => assertWikiAnalysisRevisions('personal', updates, [], []))
})

it('checks the final revision again after asynchronous preparation', async () => {
  const analyzed = { spaceId: 'personal', slug: 'projects/trip', revision: 'analyzed' }
  const expected = [analyzed]
  const updates = [{ slug: 'projects/trip' }]
  let current = expected
  assertWikiAnalysisRevisions('personal', updates, expected, current)
  await Promise.resolve().then(() => {
    current = [{ ...analyzed, revision: 'user-edited-during-preparation' }]
  })
  let writes = 0
  assert.throws(() => {
    assertWikiAnalysisRevisions('personal', updates, expected, current)
    writes += 1
  }, /wiki-page-conflict/)
  assert.equal(writes, 0)
})

it('does not borrow the expected revision from another space or equate missing pages with unversioned pages', () => {
  const updates = [{ slug: 'projects/trip' }]
  const page = { slug: 'projects/trip', revision: 'same-revision' }
  const current = [page]
  const expected = [{ spaceId: 'private', ...page }]
  assert.throws(() => assertWikiAnalysisRevisions('team', updates, expected, current), /wiki-page-conflict/)
  assert.throws(() => assertWikiAnalysisRevisions('personal', updates, [], updates), /wiki-page-conflict/)
  assert.throws(
    () => assertWikiAnalysisRevisions('personal', updates, [{ spaceId: 'personal', slug: 'projects/trip' }], []),
    /wiki-page-conflict/
  )
})
