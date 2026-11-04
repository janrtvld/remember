import assert from 'node:assert/strict'
import { test } from 'node:test'
import { removeWikiDrafts, wikiDraftStorageKey } from './wikiDrafts'

test('removing a Space only clears drafts belonging to that Space', (t) => {
  const localStorage: Record<string, unknown> = {}
  Object.defineProperty(localStorage, 'removeItem', {
    value: (key: string) => Reflect.deleteProperty(localStorage, key),
  })
  Object.assign(globalThis, { window: { localStorage } })
  t.after(() => Reflect.deleteProperty(globalThis, 'window'))
  const draft = wikiDraftStorageKey('research', 'projects/release')
  const personal = wikiDraftStorageKey('personal', 'projects/local')
  const similarlyNamed = wikiDraftStorageKey('research-2', 'projects/other')
  localStorage[draft] = 'unsaved research'
  localStorage[personal] = 'personal draft'
  localStorage[similarlyNamed] = 'other research'

  removeWikiDrafts(['research'])
  assert.equal(localStorage[draft], undefined)
  assert.equal(localStorage[personal], 'personal draft')
  assert.equal(localStorage[similarlyNamed], 'other research')
})
