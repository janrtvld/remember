import assert from 'node:assert/strict'
import test from 'node:test'
import { applyWikiSpaceOrder, isCompleteWikiSpaceOrder } from '../wikiSpaceOrder'

const spaces = [{ id: 'personal' }, { id: 'private' }, { id: 'drive' }]

test('applyWikiSpaceOrder follows stored IDs and appends new spaces', () => {
  assert.deepEqual(
    applyWikiSpaceOrder(spaces, ['drive', 'personal']).map((space) => space.id),
    ['drive', 'personal', 'private']
  )
})

test('applyWikiSpaceOrder ignores stale and duplicate IDs', () => {
  assert.deepEqual(
    applyWikiSpaceOrder(spaces, ['missing', 'private', 'private']).map((space) => space.id),
    ['private', 'personal', 'drive']
  )
})

test('isCompleteWikiSpaceOrder only accepts every current space exactly once', () => {
  assert.equal(isCompleteWikiSpaceOrder(['drive', 'personal', 'private'], spaces), true)
  assert.equal(isCompleteWikiSpaceOrder(['drive', 'personal'], spaces), false)
  assert.equal(isCompleteWikiSpaceOrder(['drive', 'personal', 'missing'], spaces), false)
  assert.equal(isCompleteWikiSpaceOrder(['drive', 'drive', 'personal'], spaces), false)
})
